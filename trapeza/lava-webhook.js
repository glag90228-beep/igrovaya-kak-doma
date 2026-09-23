'use strict';

/**
 * Приёмник вебхуков Lava Top.
 *
 *   LAVA_WEBHOOK_SECRET=… BOT_TOKEN=… node lava-webhook.js
 *
 * Слушает POST на /lava и /webhook. Lava Top шлёт вебхук с заголовком
 * X-Api-Key, равным вашему API-ключу, — его и сверяем (secretOk). Тело
 * плоское: eventType, contractId, buyer.email, amount, currency, product.
 * Покупатель опознаётся по email (Telegram-id Lava не передаёт), поэтому
 * рабочий путь привязки — «Я оплатил» в боте с вводом почты с кассы.
 *
 * Наружу выставлять только по HTTPS (nginx перед этим портом).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const bdb = require('./lib/bot-db');
const billing = require('./lib/billing');
const { parseWebhook, daysFor, secretOk, hmacOk } = require('./lib/lava');
const platega = require('./lib/platega');
const { Telegram } = require('./lib/tg');

const PORT = Number(process.env.LAVA_PORT || 8788);
const LOG = path.join(__dirname, 'data', 'lava-webhook.log');
const MAX_BODY = 256 * 1024;

const tg = process.env.BOT_TOKEN ? new Telegram(process.env.BOT_TOKEN) : null;

/** Чужой текст в сообщении владельцу: Telegram разбирает его как HTML. */
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/*
 * Журнал с потолком.
 *
 * Путь /lava открыт наружу, ограничения частоты на нём нет, а строка
 * пишется на КАЖДЫЙ запрос, включая отказы. Поток мусора забивал бы диск —
 * тот самый, на котором лежит база с документами. Поэтому при переполнении
 * старое уезжает в .1, а новый файл начинается с чистого листа: две
 * последние порции всегда под рукой, и больше двух потолков журнал не
 * занимает никогда.
 */
const LOG_MAX = Number(process.env.LAVA_LOG_MAX || 5 * 1024 * 1024);

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    let size = 0;
    try { size = fs.statSync(LOG).size; } catch (_) { size = 0; }
    if (size + line.length > LOG_MAX) {
      try { fs.renameSync(LOG, `${LOG}.1`); } catch (_) { /* некуда — просто пишем дальше */ }
    }
    fs.appendFileSync(LOG, line + '\n');
  } catch (_) { /* лог не критичен */ }
}

/**
 * Сообщить владельцу о том, что требует его вмешательства.
 *
 * Молча падаем при любой беде: приём вебхука не должен зависеть от того,
 * доступен ли Telegram. Деньги уже записаны, а уведомление — удобство.
 */
async function notifyOwner(text) {
  const chat = process.env.SUPPORT_CHAT_ID || '';
  if (!tg || !chat) return;
  try { await tg.sendMessage(chat, text); } catch (e) { log('владельцу не дошло:', e.message); }
}

/**
 * Обрабатывает разобранный платёж: записывает, привязывает к пользователю
 * и продлевает доступ. Возвращает текст для лога.
 */
async function handlePayment(p, provider = 'lava') {
  const days = p.paid
    ? (provider === 'platega' ? platega.daysFor(p) : daysFor(p))
    : 0;
  let user = null;
  if (p.userId) {
    try { user = bdb.getUser(p.userId); } catch (_) { user = null; }
  }
  if (!user && p.tgId) {
    try { user = bdb.getOrCreateUser(p.tgId); } catch (_) { user = null; }
  }

  /*
   * Вся работа с базой — одной транзакцией, уведомления — после неё.
   *
   * Раньше платёж записывался, а срок продлевался следующей командой. Если
   * она падала, приёмник отвечал 500, площадка присылала уведомление снова —
   * и видела «уже записан»: срок не продлевался уже никогда. Теперь сбой
   * откатывает и запись, и повтор проходит заново с нуля.
   *
   * Уведомления вынесены наружу намеренно: сообщение в Telegram нельзя
   * откатить, и отправлять его до фиксации значило бы обещать то, что ещё
   * может не записаться.
   */
  const out = billing.inTx(() => {
    const rec = billing.recordPayment({
      externalId: p.externalId, provider, userId: user ? user.id : 0,
      email: p.email, amount: p.amount, currency: p.currency, days,
      status: p.status, raw: p.raw,
    });
    if (rec.duplicate) return { kind: 'dup', rec };
    if (!p.paid) return { kind: 'unpaid', rec };
    if (!user) return { kind: 'nouser', rec };
    const pay = rec.payment || {};
    // Привязываем только то, что пришло ничьим (см. attachPayment).
    if (!Number(pay.user_id) && !billing.attachPayment(rec.id || pay.id, user.id)) {
      return { kind: 'taken', rec };
    }
    return { kind: 'granted', rec, until: billing.grantDays(user.id, days) };
  });
  const { near, reversed } = out.rec;

  if (out.kind === 'dup' && reversed) {
    notifyOwner(`⚠️ По оплаченному платежу ${escHtml(p.externalId)} пришёл статус `
      + `«${escHtml(reversed.to)}» (был «${escHtml(reversed.from)}») — похоже на возврат или отмену.\n\n`
      + 'Доступ сам не отозван: проверьте в кабинете площадки и снимите вручную, если деньги вернулись.')
      .catch(() => {});
    return `платёж ${p.externalId}: статус сменился на «${reversed.to}» — владелец предупреждён`;
  }
  if (out.kind === 'dup') {
    /*
     * Похожий платёж записан, но дней не даёт. Сказать об этом обязаны: под
     * тот же признак попадает и настоящая вторая покупка — месяц себе и
     * месяц коллеге с одной кассовой почты подряд. Раньше она пропадала
     * молча, теперь строка есть и владелец о ней знает.
     */
    if (near) {
      // Тоже не ждём: ответ площадке важнее скорости нашего уведомления.
      notifyOwner(`⚠️ Похожий платёж ${p.amount} ${p.currency} с почты <b>${escHtml(p.email) || '—'}</b>.\n\n`
        + 'Записал, но доступ по нему не выдал — он похож на повторную доставку. '
        + 'Если это вторая настоящая покупка, выдайте доступ вручную.').catch(() => {});
    }
    return `повтор ${p.externalId} — записан, доступ не выдан`;
  }

  if (out.kind === 'unpaid') return `платёж ${p.externalId} со статусом «${p.status}» — записан, доступ не выдан`;

  if (out.kind === 'nouser') {
    /*
     * Про такие оплаты обязаны узнать вы, а не только журнал.
     *
     * Lava не возвращает Telegram-id (см. шапку файла), поэтому сюда попадает
     * КАЖДЫЙ боевой платёж, а не редкий случай. Раньше всё заканчивалось
     * строкой в лог: человек платил, возвращался в бота и не находил ничего —
     * доступа нет, лимит на месте, и догадаться, что надо нажать «Я оплатил»
     * и вспомнить почту с кассы, он не мог. Деньги у нас, доступа у него нет,
     * и никто об этом не знает. Именно так выглядело обращение в поддержку.
     */
    notifyOwner(`💰 Оплата ${p.amount} ${p.currency} с почты <b>${escHtml(p.email) || '—'}</b> `
      + 'пришла без привязки к человеку.\n\nОн получит доступ, только если сам нажмёт '
      + '«Я оплатил» и введёт эту почту. Если не пишет — напишите ему первым.').catch(() => {});
    return `платёж ${p.externalId} без Telegram-id — ждёт, пока владелец почты ${p.email || '—'} заберёт его в боте`;
  }

  /*
   * «Уже зачтён» — строку секундой раньше забрали по почте в боте.
   * Начислять срок второй раз за один платёж было бы подарком за наш счёт.
   */
  if (out.kind === 'taken') return `платёж ${p.externalId} уже зачтён — срок не трогаем`;
  const { until } = out;
  /*
   * Уведомление не задерживает ответ площадке.
   *
   * Доступ уже продлён — это запись в базу, она мгновенная. А вот отправка в
   * Telegram с появлением повторов стала стоить до трёх заходов с паузами, и
   * всё это время Lava ждала бы наш HTTP-ответ. Не дождавшись, она сочла бы
   * доставку неудачной и прислала вебхук заново: денег это не задвоит
   * (attachPayment выше не даст), но владелец получил бы кашу из повторных
   * уведомлений ровно тогда, когда в журнале надо разбираться.
   *
   * Поэтому письмо счастья уходит следом за ответом, а не перед ним.
   */
  if (tg) {
    const channelName = provider === 'platega' ? 'СБП / Platega' : 'Lava Top';
    tg.sendMessage(user.tg_id,
      `✅ Оплата получена (${channelName}). Доступ продлён до <b>${until.split('-').reverse().join('.')}</b>.\n`
      + 'Спасибо! Если что-то не так — напишите в поддержку.')
      .catch((e) => {
        if (e && e.blocked) bdb.markBlocked(user.id);
        log('не смог уведомить', user.tg_id, e.message);
      });
  }
  return `платёж ${p.externalId}: ${p.amount} ${p.currency} → ${days} дн., доступ до ${until}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const done = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };

  if (req.method === 'GET' && url.pathname === '/health') return done(200, 'ok');
  if (req.method !== 'POST') return done(405, 'only POST');
  if (url.pathname !== '/lava' && url.pathname !== '/webhook' && url.pathname !== '/platega') return done(404, 'not found');

  /*
   * Кто стучался — записываем обязательно.
   *
   * Раньше отказ выглядел как «отказ: неверный секрет» и больше ничего. По
   * такой строке нельзя отличить площадку от собственной проверки: мы сами
   * шлём заведомо неверный секрет, когда проверяем, открыт ли путь. В
   * журнале лежали отказы недельной давности, и понять, Lava это или наши
   * же тесты, было невозможно — а от ответа зависело, где искать поломку.
   *
   * Адрес берём из заголовка от nginx (сам он ходит с петли, и без этого
   * все обращения выглядели бы как 127.0.0.1). Секрет не пишем никогда:
   * длины и способа передачи хватает, чтобы отличить «пусто» от «не тот» и
   * от «обрезался», а в журнал он попадать не должен.
   */
  const from = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim() || req.socket.remoteAddress || 'неизвестно';

  /*
   * Тело читаем ДО проверки, а не после.
   *
   * Раньше сверка шла по заголовку сразу, и это закрывало второй способ
   * подтверждения, которым площадки пользуются наравне с первым: подписать
   * тело секретом и прислать подпись. Такая подпись — шестнадцатеричная
   * строка, с ключом она не совпадает никогда, и в журнале это выглядело как
   * «неверный секрет» — то есть ровно как чужой запрос. Отличить одно от
   * другого было нельзя, а искать при этом надо в разных местах.
   *
   * Подпись считается по сырому телу, поэтому его нужно иметь на руках до
   * решения. Ограничение размера при этом никуда не делось.
   */
  /*
   * Тело копим байтами и раскодируем один раз в конце.
   *
   * Было `body += chunk`: каждый кусок превращался в строку отдельно, и буква,
   * которую nginx разрезал между двумя TCP-кусками, становилась «�». Подпись
   * HMAC считается по байтам тела — по испорченной строке она не сходилась,
   * и оплата с кириллицей в названии товара отвергалась как «неверный секрет»
   * на каждом повторе. Заодно лимит теперь в байтах, как и написано.
   */
  const parts = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { tooBig = true; req.destroy(); return; }
    parts.push(chunk);
  });
  req.on('end', async () => {
    if (tooBig) return done(413, 'too large');
    const body = Buffer.concat(parts).toString('utf8');

    /*
     * Кто стучался — записываем обязательно.
     *
     * Раньше отказ выглядел как «отказ: неверный секрет» и больше ничего. По
     * такой строке нельзя отличить площадку от собственной проверки: мы сами
     * шлём заведомо неверный секрет, когда проверяем, открыт ли путь. В
     * журнале лежали отказы недельной давности, и понять, Lava это или наши
     * же тесты, было невозможно — а от ответа зависело, где искать поломку.
     *
     * Адрес берём из заголовка от nginx (сам он ходит с петли, и без этого
     * все обращения выглядели бы как 127.0.0.1). Секрет не пишем никогда:
     * длины и способа передачи хватает, чтобы отличить «пусто» от «не тот» и
     * от «обрезался», а в журнал он попадать не должен.
     */
    /*
     * Секрет в строке адреса — по умолчанию больше не принимается.
     *
     * Адреса оседают в access-логе nginx, который читают и ротируют как
     * обычный лог: секрет, дающий выдачу подписок, лежал бы там открытым
     * текстом. Lava присылает ключ заголовком X-Api-Key, так что рабочему
     * пути это не мешает. Кому нужен старый способ — LAVA_ALLOW_URL_SECRET=1,
     * но лучше перенести секрет в заголовок.
     */
    const urlSecret = () => (process.env.LAVA_ALLOW_URL_SECRET === '1'
      ? (url.searchParams.get('secret') || url.searchParams.get('token') || '')
      : '');

    // Platega.io: СБП и банковские карты
    const plategaMerchant = req.headers['x-merchantid'] || req.headers['x-merchant-id'] || '';
    const plategaSecret = req.headers['x-secret'] || '';
    const isPlatega = Boolean(plategaMerchant) || Boolean(plategaSecret) || url.pathname === '/platega';

    if (isPlatega) {
      if (!platega.secretOk(plategaMerchant, plategaSecret)) {
        log(`отказ Platega: неверный секрет | от ${from} | путь ${url.pathname}`
          + ` | merchant: ${plategaMerchant ? 'передан' : 'нет'}, secret: ${plategaSecret ? 'передан' : 'нет'}`);
        return done(401, 'bad secret');
      }
      log(`принят запрос Platega от ${from} на ${url.pathname}`);
      let json;
      try { json = JSON.parse(body || '{}'); } catch (_) {
        log('Platega не JSON:', body.slice(0, 500));
        return done(400, 'bad json');
      }
      const parsed = platega.parseWebhook(json);
      if (!parsed.ok) {
        const body2 = JSON.stringify(json);
        log('НЕ РАЗОБРАЛ вебхук Platega:', parsed.reason, '| тело:', body2);
        notifyOwner('⚠️ Пришёл платёж Platega, который я не смог разобрать: '
          + `<b>${parsed.reason}</b>.\n\n`
          + `<code>${escHtml(body2.slice(0, 600))}</code>`)
          .catch(() => {});
        return done(200, 'stored');
      }
      try {
        log(await handlePayment(parsed.payment, 'platega'));
      } catch (e) {
        log('ошибка обработки Platega:', e.message);
        return done(500, 'error');
      }
      return done(200, 'ok');
    }

    const carrier = (req.headers['x-api-key'] && 'X-Api-Key')
      || (req.headers['x-signature'] && 'X-Signature')
      || (req.headers['x-hook-signature'] && 'X-Hook-Signature')
      || (req.headers.authorization && 'Authorization')
      || (urlSecret() && 'параметр в адресе')
      || '';
    const given = req.headers['x-api-key']
      || req.headers['x-signature']
      || req.headers['x-hook-signature']
      || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      || urlSecret();

    // Ключ открытым текстом или подпись тела — принимаем оба способа.
    const byKey = secretOk(given);
    const bySig = !byKey && hmacOk(given, body);
    if (!byKey && !bySig) {
      log(`отказ: неверный секрет | от ${from} | путь ${url.pathname}`
        + ` | секрет ${carrier ? `в ${carrier}, длина ${String(given).length}` : 'не передан вовсе'}`
        + ' | ни как ключ, ни как подпись тела не подошёл');
      return done(401, 'bad secret');
    }
    log(`принят запрос от ${from} на ${url.pathname} (${bySig ? 'подпись тела' : 'ключ'})`);

    let json;
    try { json = JSON.parse(body || '{}'); } catch (_) {
      log('не JSON:', body.slice(0, 500));
      return done(400, 'bad json');
    }

    const parsed = parseWebhook(json);
    if (!parsed.ok) {
      /*
       * Не угадали формат — отвечаем 200, чтобы площадка не долбилась
       * повторами, пока мы правим разбор. Но 200 для неё значит
       * «доставлено»: событие снимается с очереди и второй раз не придёт.
       *
       * Значит эта ветка — единственная, где платёж теряется целиком, и
       * молчать в ней нельзя. Раньше здесь была только строка в журнал, и
       * получалось ровно то, от чего мы уже уходили в соседних ветках:
       * человек заплатил, доступа нет, вернулся в бота — пусто, а про кнопку
       * «Я оплатил» он не знает. Теперь владелец узнаёт сразу и может выдать
       * доступ руками, пока мы разбираемся с разбором.
       *
       * Тело кладём в журнал целиком, без обрезки: по обрезанному нельзя
       * ни восстановить платёж, ни починить разбор — а это единственный
       * след, который от него остаётся.
       */
      const body2 = JSON.stringify(json);
      log('НЕ РАЗОБРАЛ вебхук:', parsed.reason, '| тело:', body2);
      notifyOwner('⚠️ Пришёл платёж, который я не смог разобрать: '
        + `<b>${parsed.reason}</b>.\n\nПлощадка считает его доставленным и второй раз не пришлёт. `
        + 'Деньги у вас, а доступ по нему никому не выдан — посмотрите оплату в кассе '
        + 'и выдайте доступ вручную: <code>/grant номер 30</code>.\n\n'
        // Экранируем: тело идёт в <code> при parse_mode HTML, и один «<»
        // в нём заставил бы Telegram отклонить сообщение целиком. А это
        // единственная ветка, где платёж теряется навсегда, — уведомление
        // отвалилось бы ровно тогда, когда оно и нужно.
        + `<code>${escHtml(body2.slice(0, 600))}</code>`)
        .catch(() => {});
      return done(200, 'stored');
    }

    try {
      log(await handlePayment(parsed.payment));
    } catch (e) {
      log('ошибка обработки:', e.message);
      return done(500, 'error');
    }
    return done(200, 'ok');
  });
  return undefined;
});

if (require.main === module) {
  if (!process.env.LAVA_WEBHOOK_SECRET) {
    console.error('Не задан LAVA_WEBHOOK_SECRET — без него приёмник откажет всем.');
    process.exit(1);
  }
  // Только петля: наружу вебхуки принимает nginx по HTTPS.
  const host = process.env.LAVA_HOST || '127.0.0.1';
  // Причину, по которой не поднялись, говорим словами: без этого в журнале
  // остаётся стек Node, а служба молча уходит в перезапуск по кругу.
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`Порт ${host}:${PORT} занят — приёмник не поднялся. Кто держит: ss -ltnp | grep ${PORT}`);
    } else {
      log(`Приёмник не смог занять ${host}:${PORT}: ${e.message}`);
    }
    process.exit(1);
  });
  server.listen(PORT, host, () => log(`Приёмник Lava слушает ${host}:${PORT}/lava`));
}

module.exports = { server, handlePayment };
