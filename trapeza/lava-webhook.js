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
const { parseWebhook, daysFor, secretOk } = require('./lib/lava');
const { Telegram } = require('./lib/tg');

const PORT = Number(process.env.LAVA_PORT || 8788);
const LOG = path.join(__dirname, 'data', 'lava-webhook.log');
const MAX_BODY = 256 * 1024;

const tg = process.env.BOT_TOKEN ? new Telegram(process.env.BOT_TOKEN) : null;

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
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
async function handlePayment(p) {
  /*
   * Срок считаем только состоявшейся оплате.
   *
   * Раньше days считался до проверки p.paid, и строка отклонённого платежа
   * или возврата ложилась в базу с полным сроком. Строка оставалась ничьей,
   * а отбор ничьих платежей по почте на статус не смотрел — человеку хватало
   * нажать «Я оплатил» и назвать почту с кассы, чтобы получить месяц за
   * непрошедшую карту. Возврат выходил ещё щедрее: к строке оплаты
   * добавлялась вторая с тем же сроком, и одно нажатие давало вдвое больше
   * дней, чем было куплено.
   *
   * Ноль здесь — и есть замок: отбор в billing.unclaimedByEmail берёт только
   * строки со сроком больше нуля.
   */
  const days = p.paid ? daysFor(p) : 0;
  let user = null;
  if (p.tgId) {
    try { user = bdb.getOrCreateUser(p.tgId); } catch (_) { user = null; }
  }

  const { duplicate, near, payment, id } = billing.recordPayment({
    externalId: p.externalId, provider: 'lava', userId: user ? user.id : 0,
    email: p.email, amount: p.amount, currency: p.currency, days,
    status: p.status, raw: p.raw,
  });
  if (duplicate) {
    /*
     * Похожий платёж записан, но дней не даёт. Сказать об этом обязаны: под
     * тот же признак попадает и настоящая вторая покупка — месяц себе и
     * месяц коллеге с одной кассовой почты подряд. Раньше она пропадала
     * молча, теперь строка есть и владелец о ней знает.
     */
    if (near) {
      // Тоже не ждём: ответ площадке важнее скорости нашего уведомления.
      notifyOwner(`⚠️ Похожий платёж ${p.amount} ${p.currency} с почты <b>${p.email || '—'}</b>.\n\n`
        + 'Записал, но доступ по нему не выдал — он похож на повторную доставку. '
        + 'Если это вторая настоящая покупка, выдайте доступ вручную.').catch(() => {});
    }
    return `повтор ${p.externalId} — записан, доступ не выдан`;
  }

  if (!p.paid) return `платёж ${p.externalId} со статусом «${p.status}» — записан, доступ не выдан`;

  if (!user) {
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
    notifyOwner(`💰 Оплата ${p.amount} ${p.currency} с почты <b>${p.email || '—'}</b> `
      + 'пришла без привязки к человеку.\n\nОн получит доступ, только если сам нажмёт '
      + '«Я оплатил» и введёт эту почту. Если не пишет — напишите ему первым.').catch(() => {});
    return `платёж ${p.externalId} без Telegram-id — ждёт, пока владелец почты ${p.email || '—'} заберёт его в боте`;
  }

  /*
   * Привязываем только то, что пришло ничьим.
   *
   * Когда Telegram-id известен, строка записана уже на этого человека — и
   * привязывать нечего. Если же она легла ничьей, привязка отвечает, не
   * забрал ли её кто-то секундой раньше по почте в боте: начислять срок
   * второй раз за один платёж было бы подарком за наш счёт.
   */
  if (!Number((payment || {}).user_id) && !billing.attachPayment(id || payment.id, user.id)) {
    return `платёж ${p.externalId} уже зачтён — срок не трогаем`;
  }
  const until = billing.grantDays(user.id, days);
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
    tg.sendMessage(user.tg_id,
      `✅ Оплата получена. Доступ продлён до <b>${until.split('-').reverse().join('.')}</b>.\n`
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
  if (url.pathname !== '/lava' && url.pathname !== '/webhook') return done(404, 'not found');

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

  const carrier = (req.headers['x-api-key'] && 'X-Api-Key')
    || (req.headers.authorization && 'Authorization')
    || (url.searchParams.get('secret') && 'параметр secret')
    || '';
  const given = req.headers['x-api-key']
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || url.searchParams.get('secret');
  if (!secretOk(given)) {
    log(`отказ: неверный секрет | от ${from} | путь ${url.pathname}`
      + ` | секрет ${carrier ? `в ${carrier}, длина ${String(given).length}` : 'не передан вовсе'}`);
    return done(401, 'bad secret');
  }
  log(`принят запрос от ${from} на ${url.pathname}`);

  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
  });
  req.on('end', async () => {
    if (tooBig) return done(413, 'too large');
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
        + `<code>${body2.slice(0, 600)}</code>`)
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
  server.listen(PORT, host, () => log(`Приёмник Lava слушает ${host}:${PORT}/lava`));
}

module.exports = { server, handlePayment };
