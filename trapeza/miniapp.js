'use strict';

/**
 * Мини-приложение Telegram: сервер.
 *
 *   BOT_TOKEN=… node miniapp.js
 *
 * Отдаёт статику из public/app и JSON-API под /api. Каждый запрос к API
 * обязан принести initData от Telegram — она подписана токеном бота, и по
 * ней мы узнаём, кто пришёл. Никаким tg_id из тела запроса не верим: его
 * подделать может кто угодно, а подпись — нет.
 *
 * Готовый документ уходит двумя путями сразу: файлом в чат с ботом (там он
 * останется навсегда и его удобно переслать клиенту) и ссылкой на скачивание
 * в самом приложении. Это осознанно: в чате файл переживёт закрытие
 * приложения, а из приложения его можно сохранить, не переключая экран.
 *
 * Наружу — только по HTTPS (nginx перед этим портом): Telegram открывает
 * мини-приложения исключительно по https.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const bdb = require('./lib/bot-db');
const billing = require('./lib/billing');
const docService = require('./lib/doc-service');
const docLink = require('./lib/doc-link');
const npd = require('./lib/npd');
const dadata = require('./lib/dadata');
const facsimile = require('./lib/facsimile');
const mailer = require('./lib/mail');
const mailbox = require('./lib/mailbox');
const { parseRequisites, looksLikeBlock } = require('./lib/reqs');
const { buildAkt } = require('./lib/xlsx-akt');
const { buildRegistry } = require('./lib/xlsx-registry');
const { fetchNew } = require('./lib/imap');
const { visionAvailable, visionHint, readInvoice } = require('./lib/vision');
const speech = require('./lib/speech');
const ai = require('./lib/ai-agent');
const { forwardToSupport } = require('./lib/bot-support');
const { formatRub } = require('./lib/money');
const mime = require('./lib/mime');
const bank = require('./lib/bank-statement');
const recurring = require('./lib/recurring');
const bizTypes = require('./lib/biz-types');
const reqCheck = require('./lib/requisites-check');
const { round2 } = require('./lib/money');
const { verifyInitData, initDataFrom } = require('./lib/webapp-auth');
const { payLink, priceText, yearSaving, planTitle, plans: lavaPlans } = require('./lib/lava');
const { currentYear } = require('./lib/period');
const { Telegram } = require('./lib/tg');

const PORT = Number(process.env.MINIAPP_PORT || 8790);
// Слушаем только петлю: снаружи приложение отдаёт nginx по HTTPS, а открытый
// порт 8790 — это то же приложение по обычному HTTP, где initData (ключ от
// аккаунта на сутки) идёт открытым текстом мимо шифрования. Для запуска без
// nginx есть MINIAPP_HOST=0.0.0.0.
const HOST = process.env.MINIAPP_HOST || '127.0.0.1';
const ROOT = path.join(__dirname, 'public', 'app');
// Тело до 2 МБ: картинка факсимиле весит до 1 МБ, а в base64 распухает на
// треть — при меньшем пороге загрузка обрывалась бы без внятной причины.
const MAX_BODY = 2 * 1024 * 1024;

let tg = process.env.BOT_TOKEN ? new Telegram(process.env.BOT_TOKEN) : null;

/** Подменить клиента Telegram — нужно тестам, чтобы не ходить в сеть. */
function setTelegram(client) { tg = client; }

// ---------- мелочи ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Простое ограничение частоты на пользователя: мини-апп не должен уметь
 * положить сервер, даже если в нём заклинит кнопку. Окно — минута.
 */
/**
 * Ответ на нерабочую ссылку — человеческий, а не «404 Not Found».
 *
 * Открывает её обычно не наш пользователь, а его клиент: он получил адрес в
 * переписке и понятия не имеет, что такое «Первичка». Поэтому объясняем
 * простыми словами, у кого спрашивать новый, и ничего не рассказываем о
 * самом документе — ни номера, ни суммы, ни владельца.
 */
function sendLinkPage(res, code, text) {
  const body = '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>Документ недоступен</title><style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
    + 'color:#14171f;background:#f4f6fc;padding:24px}'
    + '.b{max-width:420px;text-align:center;background:#fff;border-radius:16px;padding:32px 28px;'
    + 'box-shadow:0 2px 18px rgba(20,23,31,.08)}'
    + 'h1{font-size:20px;margin:0 0 10px;color:#1f2760}p{margin:0;color:#5a6172}'
    + '</style></head><body><div class="b"><h1>Документ недоступен</h1>'
    + `<p>${text}</p><p style="margin-top:10px">Попросите отправителя прислать новую.</p>`
    + '</div></body></html>';
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  return res.end(body);
}

const hits = new Map();
/**
 * Забыть счётчики. Нужно самопроверке: она делает за секунды столько
 * запросов, сколько человек не сделает и за час, и упирается в предел там,
 * где проверяет совсем другое. В работе не вызывается.
 */
function forgetRate() { hits.clear(); }
function tooOften(userId, limit = 120) {
  const now = Date.now();
  const rec = hits.get(userId);
  if (!rec || now - rec.since > 60000) { hits.set(userId, { since: now, n: 1 }); return false; }
  rec.n += 1;
  if (hits.size > 5000) hits.clear(); // не растём бесконечно
  return rec.n > limit;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;            // дочитываем и выбрасываем, но не копим
      body += chunk;
      if (body.length > MAX_BODY) { over = true; body = ''; }
    });
    // Рвать соединение нельзя: браузер покажет «сетевая ошибка» вместо
    // объяснения. Дочитываем до конца и отвечаем понятным отказом.
    req.on('end', () => {
      if (over) { const e = new Error('слишком большое тело'); e.tooBig = true; reject(e); } else resolve(body);
    });
    req.on('error', reject);
  });
}

const str = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
const ruDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '')
  ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : (iso || ''));

// ---------- сборка данных для экранов ----------

/** Всё, что нужно главному экрану, одним запросом — меньше походов по сети. */
function stateFor(user) {
  const org = bdb.getDefaultOrg(user.id);
  const quota = bdb.quota(user.id);
  const access = billing.accessInfo(user.id);
  const debts = bdb.debtors(user.id);
  const owedToUs = round2(debts.filter((d) => d.theyOwe).reduce((s, d) => s + d.amount, 0));
  const owedByUs = round2(debts.filter((d) => !d.theyOwe).reduce((s, d) => s + d.amount, 0));
  // Одно число на всё приложение: плитка, список и напоминание раньше
  // считали каждый по-своему и расходились между собой.
  const awaiting = bdb.unpaidSummary(user.id);
  const unpaidDocs = awaiting.docs;
  return {
    user: { id: user.id, tgId: user.tg_id, name: user.name },
    org: org || null,
    orgReady: Boolean(org && org.name && org.inn && org.acc && org.bik),
    quota,
    access,
    counts: { cps: bdb.listCps(user.id).length, debtors: debts.length },
    debts: { owedToUs, owedByUs },
    unpaid: { count: awaiting.count, sum: awaiting.sum },
    docs: bdb.listDocs(user.id, 5).map(docBrief),
    payUrl: payLink(user.tg_id),
    /*
     * Тарифы отдаём списком, а не одной фразой. Фраза «390 ₽ в месяц или
     * 2990 ₽ в год» на узком экране рвалась посередине числа: «2990» на
     * одной строке, «₽ в год» на другой. Из списка приложение рисует
     * строки, где число и знак рубля не разлучить.
     */
    price: {
      text: priceText(),
      saving: yearSaving(),
      plans: lavaPlans().map((p) => ({ amount: p.amount, days: p.days, title: planTitle(p.days) })),
    },
    facsimile: fxState(user.id),
    debtBasis: bdb.basisOf(org || {}),
    // Расхождение между тем, как человек работает, и тем, как считается
    // долг: счета выписаны и не оплачены, а «должны вам» — ноль. Молчать
    // об этом нельзя, человек решит, что цифра сломана.
    basisMismatch: (() => {
      if (owedToUs > 0 || !unpaidDocs.length) return null;
      // В ручном режиме молчим: человек сам сказал, что журнал ведёт он, и
      // подсказка «долг считается по актам» была бы неправдой, а кнопка
      // рядом с ней молча начала бы делать проводки за него.
      const basis = bdb.basisOf(org || {});
      if (basis === 'manual') return null;
      const types = bdb.DEBT_DOCS[basis];
      const mute = unpaidDocs.filter((d) => !types.includes(d.type));
      if (!mute.length) return null;
      /*
       * Куда переключать — выводим из самих документов, а не подставляем
       * «по счёту» всегда. Иначе выходил замкнутый круг: у человека уже
       * стоит «по счёту», висит неоплаченный акт, экран советует включить
       * то, что включено, кнопка ничего не меняет и рапортует «Готово».
       */
      const to = mute.every((d) => bdb.DEBT_DOCS.invoice.includes(d.type)) ? 'invoice'
        : (mute.every((d) => bdb.DEBT_DOCS.closing.includes(d.type)) ? 'closing' : null);
      if (!to || to === basis) return null;
      return {
        to,
        count: mute.length,
        sum: round2(mute.reduce((a2, d) => a2 + (Number(d.total) || 0), 0)),
      };
    })(),
    bizType: (org && org.biz_type) || '',
    bizTypes: bizTypes.list(),
    recurring: recurring.list(user.id).length,
    features: { dadata: dadata.dadataAvailable(), pdf: true, mail: mailbox.resolve(user.id).ok },
    mailbox: mailbox.info(user.id),
  };
}

/**
 * Что показать на экране реквизитов: загружены ли картинки и куда ставим.
 * Сами картинки наружу отдаём предпросмотром — они маленькие, а видеть,
 * что именно загружено, важнее лишней экономии трафика.
 */
function fxState(userId) {
  const sign = facsimile.get(userId, 'sign');
  const stamp = facsimile.get(userId, 'stamp');
  return {
    scope: facsimile.scopeOf(userId),
    scopes: facsimile.SCOPES,
    sign: sign ? { preview: facsimile.dataUri(sign), size: sign.bytes.length } : null,
    stamp: stamp ? { preview: facsimile.dataUri(stamp), size: stamp.bytes.length } : null,
  };
}

function docBrief(d) {
  return {
    id: d.id, type: d.type, title: d.title, number: d.number, date: d.date,
    total: d.total, cpId: d.cp_id, paidAt: d.paid_at || '',
    // Долг по документу отменён руками — приложению это надо показать и дать
    // обратный ход, иначе отмена выходит дорогой в один конец.
    noDebt: Boolean(d.no_debt),
    items: (d.payload && d.payload.items) || [],
  };
}

/**
 * Какие штампы просит приложение. Пришло из браузера — значит, ничему тут
 * верить нельзя: приводим к двум булевым и отдаём дальше, а можно ли на
 * самом деле поставить «Оплачено», решает doc-service по базе.
 */
function wantStamp(body) {
  const s = body && body.stamp;
  if (!s || typeof s !== 'object') return null;
  return { paid: Boolean(s.paid), copy: Boolean(s.copy) };
}

function cpBrief(userId, cp) {
  const b = bdb.balanceOf(userId, cp.id);
  return {
    id: cp.id, name: cp.name, full_name: cp.full_name, inn: cp.inn, kpp: cp.kpp,
    kind: cp.kind, address: cp.address, bank_name: cp.bank_name, bik: cp.bik,
    acc: cp.acc, corr_acc: cp.corr_acc, contract: cp.contract, email: cp.email,
    opening_balance: round2(Number(cp.opening_balance) || 0),
    opening_date: cp.opening_date || '',
    balance: b ? round2(b.closing) : 0,
  };
}

/**
 * Акт сверки: собрать, записать в журнал и отправить файлом в чат.
 *
 * Общий для одиночного акта и для «всем должникам», и намеренно повторяет
 * то, что делает бот. Раньше приложение собирало акт мимо журнала: документ
 * не появлялся в «Моих документах», не попадал в счётчик бесплатных и его
 * нельзя было переслать заново. Один и тот же акт через две двери давал
 * разный результат, а бесплатный лимит обходился открытием приложения.
 */
async function makeAkt(user, org, p, caption) {
  const buf = await buildAkt({
    org: {
      brand: org.name, org_short: org.name, org_full: org.full_name || org.name,
      org_inn: org.inn, signer: org.signer,
    },
    cp: p.view,
    ops: p.ops,
  });
  const file = {
    filename: `Акт_сверки_${docService.safeName(p.cp.name)}.xlsx`,
    buffer: Buffer.from(buf),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const seq = bdb.nextSeq(user.id, 'akt', currentYear());
  bdb.saveDoc(user.id, {
    orgId: org.id, cpId: p.cp.id, type: 'akt', number: String(seq), seq,
    date: docService.todayISO(), total: Math.abs(p.closing),
    payload: { ops: p.ops.length, from: p.from, to: p.to },
  });
  // В чат — обязательно: внутри Telegram скачивание по ссылке блокируется,
  // и файл в переписке остаётся единственным надёжным способом его забрать.
  await sendFileToChat(user, file, caption);
  return file;
}

// ---------- обработчики API ----------

const api = {
  async 'GET /api/state'({ user }) { return stateFor(user); },

  async 'GET /api/cps'({ user }) {
    return { cps: bdb.listCps(user.id).map((cp) => cpBrief(user.id, cp)) };
  },

  async 'POST /api/cp'({ user, body }) {
    const name = str(body.name, 200);
    if (!name) return { error: 'Без названия контрагента не обойтись.' };
    const fields = {
      name,
      full_name: str(body.full_name, 400),
      inn: str(body.inn, 12),
      kpp: str(body.kpp, 9),
      kind: body.kind === 'supplier' ? 'supplier' : 'customer',
      address: str(body.address, 400),
      bank_name: str(body.bank_name, 300),
      bik: str(body.bik, 9),
      acc: str(body.acc, 20),
      corr_acc: str(body.corr_acc, 20),
      contract: str(body.contract, 200),
      email: str(body.email, 254),
    };
    /*
     * Начальное сальдо: сколько числилось за клиентом на день, с которого
     * мы начали вести расчёты. Без него акт сверки открывается нулём — а он
     * должен открываться тем, что было, иначе клиент его не подпишет.
     * В боте это спрашивалось, в приложении полей не было вовсе.
     */
    if (body.opening_balance !== undefined) {
      /*
       * Пробелы внутри числа — это разделитель разрядов, а не мусор.
       * «12 000,50» превращалось в ноль: Number() не понимает пробел, || 0
       * это прятал, и человек получал пустое сальдо вместо двенадцати тысяч.
       * Молча — сообщения об ошибке не было.
       */
      const raw = String(body.opening_balance).replace(/[\s\u00A0]/g, '').replace(',', '.');
      const num = Number(raw);
      fields.opening_balance = Number.isFinite(num) && Math.abs(num) < 1e12
        ? Math.round(num * 100) / 100 : 0;
    }
    if (body.opening_date !== undefined) {
      const d = str(body.opening_date, 10);
      fields.opening_date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
    }
    const wrong = reqCheck.checkRequisites(body);
    if (wrong.length) return { error: wrong[0].error, field: wrong[0].field };
    const id = Number(body.id) || 0;
    if (id) {
      if (!bdb.getCp(user.id, id)) return { error: 'Контрагент не найден.' };
      bdb.updateCp(user.id, id, fields);
      return { cp: cpBrief(user.id, bdb.getCp(user.id, id)) };
    }
    // Дата начала расчётов — сегодня только если её не назвали. Раньше она
    // ставилась всегда, поверх присланной: клиент с долгом с прошлого года
    // всё равно заводился «с сегодня», и акт открывался нулём.
    const newId = bdb.createCp(user.id, {
      ...fields,
      opening_date: fields.opening_date || docService.todayISO(),
    });
    return { cp: cpBrief(user.id, bdb.getCp(user.id, newId)) };
  },

  async 'POST /api/org'({ user, body }) {
    const name = str(body.name, 200);
    if (!name) return { error: 'Укажите название организации.' };
    // Контрольные суммы: счёт с опечаткой в реквизитах бесполезен, а
    // проверяется это арифметикой за миллисекунду.
    const bad = reqCheck.checkRequisites(body);
    if (bad.length) return { error: bad[0].error, field: bad[0].field };
    bdb.saveMyOrg(user.id, {
      name,
      full_name: str(body.full_name, 400),
      inn: str(body.inn, 12),
      kpp: str(body.kpp, 9),
      // ОГРНИП печатается в УПД. Через приложение он не сохранялся вовсе:
      // поле в форме появилось, а до базы не доезжало.
      ogrnip: str(body.ogrnip, 15),
      signer: str(body.signer, 200),
      address: str(body.address, 400),
      bank_name: str(body.bank_name, 300),
      bik: str(body.bik, 9),
      acc: str(body.acc, 20),
      corr_acc: str(body.corr_acc, 20),
    });
    return { org: bdb.getDefaultOrg(user.id) };
  },

  /**
   * Подсказки по ИНН и БИК: заполняем реквизиты из реестров, а не руками.
   * Справочник отвечает обёрткой {ok, fields, error} — наружу отдаём сами
   * поля, а причину неудачи показываем человеку как есть: «не нашлось»
   * и «справочник не подключён» лечатся по-разному.
   */
  async 'POST /api/lookup'({ body }) {
    const inn = str(body.inn, 12);
    const bik = str(body.bik, 9);
    if (!inn && !bik) return { error: 'Укажите ИНН или БИК.' };

    const out = {};
    const problems = [];
    const ask = async (fn, value, into) => {
      const r = await fn(value).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok) { out[into] = r.fields; if (r.warn) out.warn = r.warn; } else {
        problems.push((r && r.error) || 'справочник не ответил');
      }
    };
    if (inn) await ask(dadata.partyByInn, inn, 'party');
    if (bik) await ask(dadata.bankByBik, bik, 'bank');

    if (!out.party && !out.bank) {
      return { error: `${problems.join('; ')} — заполните вручную.` };
    }
    return out;
  },

  /** Разбор вставленного блока реквизитов: человек копирует — мы раскладываем. */
  async 'POST /api/parse'({ body }) {
    const text = str(body.text, 4000);
    if (!text) return { error: 'Пустой текст.' };
    if (!looksLikeBlock(text)) return { error: 'Не похоже на блок реквизитов.' };
    return { fields: parseRequisites(text) };
  },

  /**
   * Загрузка подписи или печати. Из браузера картинка приходит как
   * data-URI, но верить его заголовку нельзя — тип определяется по самим
   * байтам внутри facsimile.save().
   */
  async 'POST /api/facsimile'({ user, body }) {
    const kind = str(body.kind, 10);
    if (!facsimile.KINDS.includes(kind)) return { error: 'Неизвестный вид изображения.' };
    const m = /^data:([^;,]*);base64,(.+)$/s.exec(String(body.dataUrl || ''));
    if (!m) return { error: 'Не разобрал картинку — пришлите PNG, JPEG или WebP.' };
    // Base64 раздувает данные на треть: считаем до раскодирования, чтобы
    // не собирать в памяти буфер, который всё равно не примем.
    if (m[2].length > (facsimile.MAX_BYTES * 4) / 3 + 64) {
      return { error: `Файл больше ${Math.round(facsimile.MAX_BYTES / 1024)} КБ.` };
    }
    const res = facsimile.save(user.id, kind, Buffer.from(m[2], 'base64'), m[1]);
    if (!res.ok) return { error: res.error };
    return { facsimile: fxState(user.id) };
  },

  async 'POST /api/facsimile/delete'({ user, body }) {
    const kind = str(body.kind, 10);
    if (!facsimile.KINDS.includes(kind)) return { error: 'Неизвестный вид изображения.' };
    facsimile.remove(user.id, kind);
    return { facsimile: fxState(user.id) };
  },

  async 'POST /api/facsimile/scope'({ user, body }) {
    if (!facsimile.setScope(user.id, str(body.scope, 10))) return { error: 'Неизвестный режим.' };
    return { facsimile: fxState(user.id) };
  },

  /**
   * Активация кода доступа. Та же проверка, что и в боте: код может быть
   * отключён, просрочен, разобран другими или уже использован этим же
   * человеком — причину показываем словами, а не «неверный код».
   */
  async 'POST /api/promo'({ user, body }) {
    const code = str(body.code, 40);
    if (!code) return { error: 'Введите код.' };
    const res = billing.redeemCode(user.id, code);
    if (!res.ok) return { error: res.error };
    return { days: res.days, quota: bdb.quota(user.id), access: billing.accessInfo(user.id) };
  },

  async 'GET /api/docs'({ user, url }) {
    const cpId = Number(url.searchParams.get('cp')) || null;
    const rows = bdb.listDocs(user.id, 30, cpId);
    // Долг по документу — чтобы карточка могла честно сказать, изменится
    // ли сальдо при удалении. Одним запросом на весь список, не по одному.
    const debt = bdb.debtByDoc(user.id, rows.map((d) => d.id));
    return { docs: rows.map((d) => ({ ...docBrief(d), debt: (debt.get(d.id) || {}).delta || 0 })) };
  },

  /**
   * Отправляет ранее выписанный документ на почту контрагента.
   * Адрес запоминается: со второго раза спрашивать уже нечего.
   */
  async 'POST /api/doc/mail'({ user, body }) {
    // Письмо уходит из ящика пользователя: с общего адреса оно попадало бы
    // в спам, и отправителем чужих документов оказывались бы мы.
    const box = mailbox.resolve(user.id);
    if (!box.ok) return { error: box.reason };

    const doc = bdb.getDoc(user.id, Number(body.id));
    if (!doc) return { error: 'Документ не найден.' };
    const cp = bdb.getCp(user.id, doc.cp_id);
    if (!cp) return { error: 'Контрагент не найден.' };

    const to = str(body.email, 254) || cp.email;
    if (!mailer.validEmail(to)) return { error: 'Укажите правильный адрес почты.' };

    const built = await docService.rebuildDocument(user.id, doc.id, { stamp: wantStamp(body) });
    if (!built.ok) return { error: built.message };

    const org = bdb.getOrg(user.id, doc.org_id) || bdb.getDefaultOrg(user.id) || {};
    const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2 }).format(doc.total || 0);
    const res = await mailer.sendMail({
      to,
      subject: `${doc.title} № ${doc.number} от ${ruDate(doc.date)}`,
      text: [
        'Здравствуйте!', '',
        `Во вложении ${String(doc.title).toLowerCase()} № ${doc.number}`
          + ` от ${ruDate(doc.date)}${doc.total ? ` на сумму ${money} руб.` : ''}.`,
        ...(doc.type === 'sch'
          ? ['', 'В счёте есть QR-код: оплатить можно, наведя камеру в приложении банка.'] : []),
        // Акт сверки отправляют не чтобы его получили, а чтобы с ним
        // согласились или возразили. Без прямой просьбы его кладут в папку,
        // и расхождение всплывает через полгода.
        ...(doc.type === 'akt'
          ? ['', 'Просьба сверить данные со своей стороны. Если расхождений нет — '
            + 'подпишите и пришлите скан в ответ. Если что-то не сходится, напишите, '
            + 'по какой строке, и я проверю у себя.'] : []),
        '', 'С уважением,', org.name || org.full_name || '',
      ].join('\n'),
      attachments: [{
        filename: built.file.filename, content: built.file.buffer, contentType: built.file.mime,
      }],
    }, box.options);
    if (!res.ok) return { error: `Не отправилось: ${res.error}` };

    if (to !== cp.email) bdb.updateCp(user.id, cp.id, { email: to });
    return { sent: to, remembered: to !== cp.email };
  },

  /**
   * Ссылка на документ: показать, что уже роздано.
   *
   * Отдельным запросом, а не в списке документов: ссылка есть у единиц, а
   * запрос к базе шёл бы на каждую строку журнала.
   */
  async 'GET /api/doc/link'({ user, url }) {
    const id = Number(url.searchParams.get('id'));
    if (!bdb.getDoc(user.id, id)) return { error: 'Документ не найден.' };
    return { links: docLink.listFor(user.id, id), available: docLink.available(), days: docLink.DAYS() };
  },

  /** Сделать ссылку (или вернуть уже сделанную — их не плодим). */
  async 'POST /api/doc/link'({ user, body }) {
    const id = Number(body.id);
    const doc = bdb.getDoc(user.id, id);
    if (!doc) return { error: 'Документ не найден.' };
    if (!docLink.available()) {
      return { error: 'Ссылки пока не работают: у приложения нет своего адреса в интернете.' };
    }
    // Штампы те же, что и у файла: ссылка — это тот же документ, только
    // собираемый в момент открытия.
    const link = docLink.create(user.id, id, { stamp: docService.stampFor(doc, wantStamp(body)) });
    if (!link) return { error: 'Не получилось сделать ссылку.' };
    return { link };
  },

  /** Закрыть доступ по всем ссылкам на документ. */
  async 'POST /api/doc/link/revoke'({ user, body }) {
    const id = Number(body.id);
    if (!bdb.getDoc(user.id, id)) return { error: 'Документ не найден.' };
    return { revoked: docLink.revoke(user.id, id) };
  },

  /** Отметить документ оплаченным или снять отметку. */
  async 'POST /api/doc/paid'({ user, body }) {
    const id = Number(body.id);
    const doc = bdb.getDoc(user.id, id);
    if (!doc) return { error: 'Документ не найден.' };
    if (body.paid === false) {
      bdb.unmarkPaid(user.id, id);
      return { doc: docBrief(bdb.getDoc(user.id, id)) };
    }
    const when = bdb.markPaid(user.id, id, str(body.date, 10));
    // Самозанятому в этот момент надо выдать чек: счёт и акт доход не
    // закрывают, его закрывает чек «Моего налога» (lib/npd.js).
    const cp = doc.cp_id ? bdb.getCp(user.id, doc.cp_id) : null;
    return {
      paidAt: when,
      doc: docBrief(bdb.getDoc(user.id, id)),
      npd: npd.chequeReminder(bdb.getDefaultOrg(user.id), {
        paidAt: when, cpName: cp && cp.name,
      }),
    };
  },

  /** Признак «применяю НПД». Нужен ровно для напоминания про чек. */
  async 'POST /api/npd'({ user, body }) {
    const org = bdb.getDefaultOrg(user.id);
    if (!org) return { error: 'Сначала заполните реквизиты организации.' };
    bdb.updateOrg(user.id, org.id, { npd: body.on ? 1 : 0 });
    return { npd: Boolean(body.on), lkUrl: npd.LK_URL };
  },

  /*
   * НДС организации. В боте это было, в приложении — нет, и счета из
   * приложения молча уходили без налога у тех, кто на общей системе.
   */
  async 'POST /api/vat'({ user, body }) {
    const org = bdb.getDefaultOrg(user.id);
    if (!org) return { error: 'Сначала заполните реквизиты организации.' };
    const raw = body.rate;
    const rate = raw === null || raw === '' || raw === undefined ? '' : String(Number(raw));
    if (!['', '0', '10', '20'].includes(rate)) return { error: 'Ставка бывает 0, 10 или 20 процентов.' };
    bdb.updateOrg(user.id, org.id, { vat_rate: rate, vat_gross: body.gross ? 1 : 0 });
    return { vat: bdb.vatOf(bdb.getDefaultOrg(user.id)) };
  },

  /** Проверочное письмо самому себе: убедиться, что пароль принят. */
  async 'POST /api/mailbox/test'({ user }) {
    const box = mailbox.resolve(user.id);
    if (!box.ok) return { error: box.reason };
    const res = await mailer.sendMail({
      to: box.options.from,
      subject: 'Проверка почты — Первичка',
      text: 'Это проверочное письмо от «Первички». Если вы его видите, '
        + 'отправка документов клиентам настроена верно.',
    }, box.options);
    if (!res.ok) return { error: res.error };
    mailbox.markChecked(user.id);
    return { sent: box.options.from, mailbox: mailbox.info(user.id) };
  },

  /**
   * Входящие письма с документами. Возвращаем разбор, а не сами файлы:
   * вложения бывают на мегабайты, а на экране нужны отправитель, тема и
   * вид документа.
   */
  async 'GET /api/inbox'({ user }) {
    const conf = mailbox.resolveImap(user.id);
    if (!conf.ok) return { error: conf.reason };
    const res = await fetchNew(conf.config, { limit: 15, unseenOnly: false, sinceDays: 14 });
    if (!res.ok) return { error: res.error };

    const cps = bdb.listCps(user.id);
    const letters = [];
    for (const m of res.messages) {
      const parsed = mime.parseMessage(m.raw);
      const docs = parsed.attachments.filter(mime.looksLikeDocument);
      if (!docs.length) continue;
      const guess = cps.find((c) => c.email && c.email.toLowerCase() === parsed.from)
        || cps.find((c) => parsed.fromName && c.name
          && parsed.fromName.toLowerCase().includes(c.name.toLowerCase().slice(0, 8)));
      letters.push({
        uid: m.uid,
        from: parsed.from,
        fromName: parsed.fromName || '',
        subject: parsed.subject || '',
        cp: guess ? { id: guess.id, name: guess.name } : null,
        files: docs.map((d) => ({
          name: d.filename,
          size: d.size,
          kind: mime.documentKind(d.filename, parsed.subject),
        })),
      });
    }
    return { letters, looked: res.messages.length };
  },

  /** Операция в журнал контрагента: приход или оплата. */
  async 'POST /api/op'({ user, body }) {
    const cp = bdb.getCp(user.id, Number(body.cpId));
    if (!cp) return { error: 'Контрагент не найден.' };
    // До копейки на самой границе: полукопейки внутри базы разводят
    // колонку сальдо и её разбор — считают-то они по-разному.
    const amount = round2(Math.abs(Number(body.amount) || 0));
    if (!amount) return { error: 'Укажите сумму.' };
    const paid = body.kind === 'payment';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : docService.todayISO();
    bdb.addOp(user.id, cp.id, {
      date,
      kind: paid ? 'Оплата' : 'Приход',
      doc: str(body.doc, 120) || (paid ? 'Оплата' : 'Приход'),
      debit: paid ? amount : 0,
      credit: paid ? 0 : amount,
    });
    return { cp: cpBrief(user.id, bdb.getCp(user.id, cp.id)) };
  },

  /** Акт сверки в Excel — по журналу операций контрагента. */
  async 'GET /api/akt'({ user, url }) {
    const org = bdb.getDefaultOrg(user.id);
    if (!org) return { error: 'Сначала заполните реквизиты организации.' };
    const iso0 = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
    const p = bdb.cpForPeriod(user.id, Number(url.searchParams.get('cp')),
      iso0(url.searchParams.get('from')), iso0(url.searchParams.get('to')));
    if (!p) return { error: 'Контрагент не найден.' };
    const cp = p.cp;
    // Лимит бесплатных: в боте акт его тратил, здесь — нет, и лимит
    // обходился простым переходом в приложение.
    const q = bdb.quota(user.id);
    if (!q.allowed) {
      return { error: `Бесплатные документы на этот месяц закончились (${q.limit}).`, reason: 'quota', quota: q };
    }
    const file = await makeAkt(user, org, p,
      `Акт сверки с <b>${cp.name}</b> за период ${ruDate(p.from)}—${ruDate(p.to)}.`);
    return {
      file: { url: `/api/file/${keepFile(user.id, file)}`, name: file.filename },
      from: p.from, to: p.to, opening: p.opening, closing: p.closing, ops: p.ops.length,
    };
  },

  /**
   * Акты сверки сразу всем, кто должен.
   *
   * В боте это одна кнопка, в приложении её не было — приходилось заходить
   * в каждого клиента отдельно. Файлы уходят в чат: внутри Telegram скачать
   * несколько файлов по ссылкам нельзя, а в переписке они остаются.
   */
  async 'GET /api/akt/all'({ user }) {
    const org = bdb.getDefaultOrg(user.id);
    if (!org) return { error: 'Сначала заполните реквизиты организации.' };
    const rows = bdb.debtors(user.id).filter((d) => d.theyOwe);
    if (!rows.length) return { error: 'Должников нет — сверять не с кем.' };

    const made = [];
    let stopped = 0;
    for (const row of rows.slice(0, 20)) {
      // Лимит проверяем перед каждым: пачка не должна пробивать его скопом.
      const q = bdb.quota(user.id);
      if (!q.allowed) { stopped = rows.length - made.length; break; }
      // row.cp, а не row.cpId: debtors() возвращает самого контрагента.
      // С несуществующим полем сюда уходил undefined, SQLite отказывался
      // его принимать, и «акты всем должникам» отвечали 500 — с самого дня,
      // как их сделали. Ни один тест этот адрес не дёргал.
      const p = bdb.cpForPeriod(user.id, row.cp.id);
      if (!p) continue;
      // eslint-disable-next-line no-await-in-loop
      await makeAkt(user, org, p, `Акт сверки с <b>${p.cp.name}</b> — долг ${formatRub(row.amount)}.`);
      made.push({ cp: p.cp.name, amount: row.amount });
    }
    if (!made.length) {
      const q = bdb.quota(user.id);
      return { error: `Бесплатные документы на этот месяц закончились (${q.limit}).`, reason: 'quota', quota: q };
    }
    return { count: made.length, items: made, stopped };
  },

  /**
   * «Я оплатил»: найти платёж по почте, указанной при оплате.
   *
   * Раньше приложение отправляло человека обратно в чат — оплатив, он
   * упирался в текст «вернитесь в бота». Платёж мог не привязаться к
   * аккаунту сам: в Telegram платят из браузера, и связь между оплатой и
   * пользователем восстанавливается по почте.
   */
  async 'POST /api/pay/claim'({ user, body }) {
    const email = str(body.email, 254).toLowerCase();
    if (!mailer.validEmail(email)) return { error: 'Это не похоже на почту.' };
    const found = billing.unclaimedByEmail(email);
    if (!found.length) {
      return {
        error: 'Оплату по этой почте не вижу. Деньги могли ещё не дойти — попробуйте через '
          + 'пару минут. Если прошло больше получаса, напишите в поддержку.',
      };
    }
    let until = '';
    for (const p of found) {
      billing.attachPayment(p.id, user.id);
      until = billing.grantDays(user.id, p.days || 30);
    }
    return { found: found.length, until };
  },

  /** Реестр всех документов за период — тоже Excel. */
  async 'GET /api/registry'({ user, url }) {
    const org = bdb.getDefaultOrg(user.id);
    if (!org) return { error: 'Сначала заполните реквизиты организации.' };
    const iso = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : fallback);
    const now = new Date();
    const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const from = iso(url.searchParams.get('from'), first);
    const to = iso(url.searchParams.get('to'), docService.todayISO());
    const docs = bdb.docsBetween(user.id, from, to);
    const buf = await buildRegistry({ org, docs, from, to });
    const file = {
      filename: `Реестр_${from}_${to}.xlsx`,
      buffer: Buffer.from(buf),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    await sendFileToChat(user, file,
      `Реестр документов за ${ruDate(from)}—${ruDate(to)}: ${docs.length} шт.`);
    return {
      count: docs.length,
      total: round2(docs.reduce((a, d) => a + (Number(d.total) || 0), 0)),
      file: { url: `/api/file/${keepFile(user.id, file)}`, name: file.filename },
    };
  },

  /*
   * Платёжка и договор. Они набираются не позициями, а парой полей, поэтому
   * общий обработчик /api/doc им не подходит — у него на входе список
   * позиций. В боте они были с самого начала, в приложении их не было.
   */
  async 'POST /api/doc/other'({ user, body }) {
    const type = str(body.type, 10);
    const kind = docService.OTHER_DOCS[type];
    if (!kind) return { error: 'Такой документ выписать нельзя.' };

    const org = bdb.getDefaultOrg(user.id);
    if (!org) return { error: 'Сначала заполните реквизиты организации.' };
    const cp = bdb.getCp(user.id, Number(body.cpId));
    if (!cp) return { error: 'Контрагент не найден.' };

    const quota = bdb.quota(user.id);
    if (!quota.allowed) {
      return { error: `Бесплатные документы на этот месяц закончились (${quota.limit}).`, reason: 'quota', quota };
    }

    const when = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : docService.todayISO();
    const year = Number(when.slice(0, 4));
    const amount = Math.abs(Number(body.amount) || 0);
    const seq = bdb.nextSeq(user.id, type, year);
    const number = str(body.number, 40) || String(seq);

    const doc = type === 'pp'
      ? { number, date: when, amount, purpose: str(body.purpose, 400) }
      : { number, date: when, subject: str(body.subject, 500), price: amount, term: str(body.term, 60) };
    if (type === 'pp' && !amount) return { error: 'Укажите сумму платежа.' };
    if (type === 'pp' && !doc.purpose) return { error: 'Укажите назначение платежа.' };
    if (type === 'dog' && !doc.subject) return { error: 'Укажите предмет договора.' };

    const file = await docService.renderFile(
      kind.build({ org, cp, doc }),
      `${kind.file}_${docService.safeName(number)}_${docService.safeName(cp.name)}`,
    );
    const id = bdb.saveDoc(user.id, {
      orgId: org.id, cpId: cp.id, type, number, seq, date: when, total: amount, payload: doc,
    });

    const res = {
      ok: true, total: amount, title: kind.title, file,
      doc: { ...docBrief(bdb.getDoc(user.id, id)), cp: { name: cp.name } },
    };
    const token = keepFile(user.id, file);
    await sendToChat(user, res).catch(() => {});
    return {
      total: amount,
      doc: docBrief(bdb.getDoc(user.id, id)),
      file: { url: `/api/file/${token}`, name: file.filename, pdf: file.pdf },
      quota: bdb.quota(user.id),
    };
  },

  /**
   * Готовый текст напоминания должникам.
   *
   * Писать контрагентам сами мы не можем и не должны: их согласия на это
   * никто не давал, а адресов у нас нет. Поэтому отдаём текст — человек
   * отправит его сам, от своего имени.
   */
  async 'GET /api/reminders'({ user }) {
    const org = bdb.getDefaultOrg(user.id) || {};
    const rows = bdb.debtors(user.id).filter((r) => r.theyOwe);
    const bank = org.acc
      ? `\n\nРеквизиты для оплаты:\n${org.bank_name || ''}\nБИК ${org.bik || '—'}\nР/с ${org.acc}`
      : '';
    return {
      canMail: mailbox.resolve(user.id).ok,
      reminders: rows.slice(0, 20).map((r) => ({
        cpId: r.cp.id,
        name: r.cp.name,
        amount: r.amount,
        email: r.cp.email || '',
        text: 'Здравствуйте!\n\n'
          + `По нашим данным на ${ruDate(docService.todayISO())} за вами числится задолженность `
          + `${formatRub(r.amount).replace(/\sруб\.$/, ' руб')}`
          + `${r.cp.contract ? ` по ${r.cp.contract}` : ''}.\n\n`
          + 'Направляем акт сверки. Просим подтвердить сумму и сообщить срок оплаты. '
          + 'Если платёж уже прошёл — пришлите, пожалуйста, платёжное поручение.'
          + `${bank}\n\nС уважением,\n${org.full_name || org.name || ''}`,
      })),
    };
  },

  /**
   * Отправить напоминание должнику письмом.
   *
   * Раньше здесь был только готовый текст «скопируйте и отправьте сами», и
   * это не сходилось с остальным: счёт тому же клиенту уходит с вашего
   * ящика по кнопке. Разницы между ними нет — в обоих случаях письмо
   * отправляет человек, увидев текст.
   *
   * Чего по-прежнему не бывает: писем без нажатия. Сигнал о просрочке
   * приходит владельцу, а не клиенту, и отправку он подтверждает сам.
   *
   * Текст принимаем от приложения: там его можно поправить перед отправкой,
   * и навязывать свою редакцию поверх правки человека было бы грубо.
   */
  async 'POST /api/reminder/mail'({ user, body }) {
    const box = mailbox.resolve(user.id);
    if (!box.ok) return { error: box.reason };

    const cp = bdb.getCp(user.id, Number(body.cpId));
    if (!cp) return { error: 'Контрагент не найден.' };
    const to = str(body.email, 254) || cp.email;
    if (!mailer.validEmail(to)) return { error: 'Укажите почту клиента — куда отправлять.' };

    const text = str(body.text, 4000);
    if (text.length < 20) return { error: 'Текст напоминания пустой.' };

    const org = bdb.getDefaultOrg(user.id) || {};
    const b = bdb.balanceOf(user.id, cp.id);

    /*
     * Акт сверки прикладываем: в тексте напоминания прямо написано
     * «направляем акт сверки», и письмо без вложения этому противоречит.
     * Если акт не собрался, отправляем письмо без него, а не молчим.
     */
    const attachments = [];
    try {
      const p = bdb.cpForPeriod(user.id, cp.id);
      const buf = await buildAkt({
        org: { brand: org.name, org_short: org.name, org_full: org.full_name || org.name,
          org_inn: org.inn, signer: org.signer },
        cp: p.view,
        ops: p.ops,
      });
      attachments.push({
        filename: `Акт_сверки_${docService.safeName(cp.name)}.xlsx`,
        content: Buffer.from(buf),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    } catch (e) {
      console.error('акт сверки к напоминанию:', e.message);
    }

    const res = await mailer.sendMail({
      to,
      subject: `Задолженность по расчётам${org.name ? ` — ${org.name}` : ''}`,
      text,
      attachments,
    }, box.options);
    if (!res.ok) return { error: `Не отправилось: ${res.error}` };

    if (to !== cp.email) bdb.updateCp(user.id, cp.id, { email: to });
    return {
      sent: to,
      withAkt: attachments.length > 0,
      amount: b ? round2(Math.abs(b.closing)) : 0,
    };
  },

  /** Обращение в поддержку прямо из приложения. */
  async 'POST /api/support'({ user, body }) {
    const text = str(body.text, 2000);
    if (text.length < 5) return { error: 'Опишите, что случилось, — пары слов мало.' };
    const sent = await forwardToSupport(tg, { user, chatId: user.tg_id, text }).catch(() => false);
    return { sent: Boolean(sent) };
  },

  /**
   * Распознавание снимка счёта. Отвечает честно, когда сервис не подключён:
   * молчаливый отказ выглядел бы как поломка.
   */
  async 'POST /api/scan'({ user, body }) {
    if (!visionAvailable()) return { error: `Распознавание не подключено. ${visionHint()}` };
    const m = /^data:([^;,]*);base64,(.+)$/s.exec(String(body.dataUrl || ''));
    if (!m) return { error: 'Не разобрал картинку — пришлите фото или скан.' };
    // Предел тот же, что у тела запроса: проверка на 6 МБ была недостижима —
    // readBody отказывал раньше, и сообщение про 6 МБ никто никогда не видел.
    if (m[2].length > (MAX_BODY * 4) / 3) {
      return { error: `Снимок больше ${Math.round(MAX_BODY / 1024 / 1024)} МБ — сфотографируйте ближе.` };
    }
    const res = await readInvoice(Buffer.from(m[2], 'base64'), m[1]);
    if (!res.ok) return { error: res.error };
    const f = res.fields || {};
    // Ищем, кому это относится: по ИНН из снимка, иначе по названию.
    const cps = bdb.listCps(user.id);
    const guess = (f.inn && cps.find((c) => c.inn === f.inn))
      || (f.name && cps.find((c) => c.name.toLowerCase().includes(String(f.name).toLowerCase().slice(0, 8))));
    return { fields: f, cp: guess ? { id: guess.id, name: guess.name } : null };
  },

  /**
   * Разбор банковской выписки.
   *
   * Ничего не заносим: только показываем, что нашли и кому это, по нашему
   * мнению, относится. Решение остаётся за человеком — ошибочно закрытый
   * долг всплывёт через месяц, когда клиент не заплатит.
   */
  async 'POST /api/bank/parse'({ user, body }) {
    const m = /^data:([^;,]*);base64,(.+)$/s.exec(String(body.dataUrl || ''));
    const raw = m ? m[2] : String(body.base64 || '');
    if (!raw) return { error: 'Пришлите файл выписки: CSV, TXT из Клиент-Банка или OFX.' };

    const org = bdb.getDefaultOrg(user.id);
    const { format, rows } = bank.parseStatement(Buffer.from(raw, 'base64'), {
      ownAccounts: [org && org.acc].filter(Boolean),
    });
    if (!rows.length) {
      return {
        error: 'В файле не нашлось операций. Подойдёт выгрузка «1С Клиент-Банк», '
          + 'OFX или CSV, где есть колонки с датой и суммой.',
      };
    }

    // Сальдо считаем по разу на контрагента: сведение сравнивает каждую
    // строку с каждым, и пересчёт журнала внутри этого цикла означал бы
    // тысячи лишних проходов по операциям.
    const cps = bdb.listCps(user.id);
    const debt = new Map();
    for (const cp of cps) {
      const b = bdb.balanceOf(user.id, cp.id);
      debt.set(cp.id, b ? b.closing : 0);
    }
    const matched = bank.matchToCounterparties(rows, cps, (id) => debt.get(id) || 0);
    const known = bdb.knownBankKeys(user.id, matched.map((t) => t.key));

    return {
      format,
      total: rows.length,
      outgoing: rows.filter((t) => !t.incoming).length,
      rows: matched.map((t) => ({
        key: t.key,
        date: t.date,
        amount: t.amount,
        name: t.name,
        inn: t.inn,
        purpose: t.purpose,
        doc: t.doc,
        cp: t.cp,
        confidence: t.confidence,
        known: known.has(t.key),      // уже заносили — по умолчанию не отмечаем
      })),
    };
  },

  /** Занести подтверждённые строки выписки как оплаты. */
  async 'POST /api/bank/import'({ user, body }) {
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
    if (!rows.length) return { error: 'Не выбрано ни одной строки.' };
    const res = bdb.importBankRows(user.id, rows.map((r) => ({
      key: str(r.key, 200),
      cpId: Number(r.cpId),
      amount: Number(r.amount),
      date: str(r.date, 10),
      doc: str(r.doc, 120),
    })));
    /*
     * Заодно смотрим, какие счета эти деньги закрывают. Только предлагаем:
     * решает человек следующим нажатием — как и в боте.
     */
    const { deals, leftovers } = bdb.matchPaymentsToDocs(user.id, res.addedRows);
    return { ...res, deals, leftovers, unpaid: bdb.debtors(user.id).length };
  },

  /** Отметить закрытыми счета, которые человек подтвердил после выписки. */
  async 'POST /api/bank/close'({ user, body }) {
    const deals = Array.isArray(body.deals) ? body.deals.slice(0, 200) : [];
    if (!deals.length) return { error: 'Не выбрано ни одной сделки.' };
    const done = bdb.closeDocsFromBank(user.id, deals.map((d) => ({
      opId: Number(d.opId) || 0,
      cpId: Number(d.cpId),
      leadId: Number(d.leadId),
      twinId: Number(d.twinId) || 0,
      total: Number(d.total),
      date: str(d.date, 10),
      doc: str(d.doc, 120),
    })));
    const left = bdb.unpaidSummary(user.id);
    return { ...done, count: left.count, sum: left.sum };
  },

  /**
   * Удаление документа из журнала.
   *
   * Вместе с ним уходят его проводки: иначе долг остаётся висеть у
   * контрагента, а отменить его больше неоткуда — карточки-то нет.
   */
  async 'POST /api/doc/delete'({ user, body }) {
    const id = Number(body.id);
    const d = bdb.getDoc(user.id, id);
    if (!d) return { error: 'Документ не найден.' };
    // Считаем изменение сальдо до удаления и возвращаем его: иначе человек
    // видит «удалено», смотрит на неизменившийся долг и справедливо решает,
    // что удаление не работает. Долг создаёт не всякий документ.
    const before = d.cp_id ? bdb.balanceOf(user.id, d.cp_id) : null;
    bdb.deleteDoc(user.id, id);
    const after = d.cp_id ? bdb.balanceOf(user.id, d.cp_id) : null;
    const delta = before && after ? round2(before.closing - after.closing) : 0;
    return { deleted: true, title: `${d.title} № ${d.number}`, delta, balance: after ? after.closing : 0 };
  },

  /** Вернуть документ в долг после отмены проводки руками. */
  async 'POST /api/doc/debt'({ user, body }) {
    const d = bdb.getDoc(user.id, Number(body.id));
    if (!d) return { error: 'Документ не найден.' };
    bdb.restoreDebt(user.id, d.id);
    const b = d.cp_id ? bdb.balanceOf(user.id, d.cp_id) : null;
    return { ok: true, balance: b ? round2(b.closing) : 0 };
  },

  /** Из чего возникает долг: по акту, по счёту или вручную. */
  async 'POST /api/basis'({ user, body }) {
    const basis = str(body.basis, 10);
    if (!bdb.DEBT_DOCS[basis]) return { error: 'Неизвестное основание.' };
    const org = bdb.getDefaultOrg(user.id);
    if (!org) return { error: 'Сначала заполните реквизиты организации.' };
    bdb.updateOrg(user.id, org.id, { debt_basis: basis });
    // Пересобираем журнал под новое правило: иначе переключение меняет
    // строчку в настройках, а долг по уже выписанным документам остаётся
    // прежним — то есть человек не видит вообще никакой разницы.
    const fixed = bdb.rebuildDebt(user.id);
    return { basis, fixed };
  },

  /**
   * Вид деятельности. Спрашиваем его вместо основания долга: на вопрос
   * «чем занимаетесь» человек отвечает не задумываясь, а правило учёта
   * выводится само.
   */
  async 'POST /api/biztype'({ user, body }) {
    const key = str(body.key, 20);
    const t = bizTypes.get(key);
    if (!t) return { error: 'Неизвестный вид деятельности.' };
    const org = bdb.getDefaultOrg(user.id);
    if (!org) return { error: 'Сначала заполните реквизиты организации.' };
    bdb.updateOrg(user.id, org.id, { biz_type: key, debt_basis: t.basis });
    // Пересчёт нужен ровно так же, как в /api/basis: это вторая дверь к тому
    // же правилу, и заходит в неё как раз тот, кто в основаниях не
    // разбирается. Без пересчёта он выбирает «Аренда», читает «долг будет
    // считаться по счёту» — и цифра на главной не двигается.
    const fixed = bdb.rebuildDebt(user.id);
    return { key, basis: t.basis, why: t.why, fixed };
  },

  /** Что повторяется каждый месяц. */
  async 'GET /api/recurring'({ user }) {
    return {
      items: recurring.list(user.id).map((r) => ({
        id: r.id,
        cpId: r.cp_id,
        cpName: r.cp_name,
        type: r.type,
        // У операции журнала название не из справочника документов: там её
        // нет и быть не может. Показываем, что именно повторяется.
        title: recurring.isOp(r)
          ? `${r.op.kind} · ${r.op.note || 'операция журнала'}`
          : (docService.ITEM_DOCS[r.type] || {}).title || r.type,
        isOp: recurring.isOp(r),
        op: recurring.isOp(r) ? r.op : null,
        day: r.day,
        dayText: r.dayText,
        offerDay: r.offerDay,
        payDay: r.pay_day,
        leadDays: r.lead_days,
        total: recurring.isOp(r)
          ? r.op.amount
          : round2(r.items.reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.price) || 0), 0)),
      })),
    };
  },

  /**
   * Повторять уже выписанный документ каждый месяц.
   *
   * Берём готовый документ, а не отдельно набранные позиции: они уже
   * проверены человеком, а НДС и статус УПД поедут вместе с ними.
   */
  async 'POST /api/recurring'({ user, body }) {
    const src = bdb.getDoc(user.id, Number(body.docId));
    if (!src || !docService.ITEM_DOCS[src.type]) return { error: 'Такой документ повторять нельзя.' };
    const { items = [], ...extra } = src.payload || {};
    if (!items.length) return { error: 'В документе нет позиций.' };
    // payDay задан — это цикл аренды: платят к числу договора, счёт уходит
    // заранее, а на следующий день после срока приходит сигнал о просрочке.
    const when = Number(body.payDay)
      ? { payDay: Number(body.payDay), leadDays: Number(body.leadDays) || 0 }
      : { day: Number(body.day) };
    const id = recurring.add(user.id, { cpId: src.cp_id, type: src.type, items, extra, ...when });
    const rec = recurring.get(user.id, id);
    return {
      id, day: rec.day, dayText: rec.dayText, offerDay: rec.offerDay, payDay: rec.pay_day,
    };
  },

  /** Перестать напоминать. */
  async 'POST /api/recurring/off'({ user, body }) {
    if (!recurring.get(user.id, Number(body.id))) return { error: 'Повторение не найдено.' };
    recurring.off(user.id, Number(body.id));
    return { off: true };
  },

  /** Подключить свой ящик. Пароль сразу проверяется письмом самому себе. */
  async 'POST /api/mailbox'({ user, body }) {
    const email = str(body.email, 254).toLowerCase();
    if (!mailer.validEmail(email)) return { error: 'Адрес почты выглядит неправильно.' };
    const preset = mailbox.PRESETS[str(body.preset, 12)] ? str(body.preset, 12) : mailbox.guessPreset(email);
    const saved = mailbox.save(user.id, {
      preset,
      login: email,
      from: email,
      pass: String(body.pass || ''),
      fromName: str(body.fromName, 120),
      host: str(body.host, 200),
      port: Number(body.port) || 0,
      secure: body.secure == null ? null : Boolean(body.secure),
      // Для своего домена сервер входящей почты знает только клиент.
      // У известных сервисов подставится из готовых настроек.
      imapHost: str(body.imapHost, 200),
    });
    if (!saved.ok) return { error: saved.error };

    // Проверяем сразу: иначе о неверном пароле человек узнает в тот момент,
    // когда счёт не уйдёт клиенту.
    const box = mailbox.resolve(user.id);
    const res = await mailer.sendMail({
      to: email,
      subject: 'Проверка почты — Первичка',
      text: 'Это проверочное письмо. Если вы его видите, отправка документов настроена верно.',
    }, box.options);
    if (!res.ok) {
      return {
        error: `Пароль не принят: ${res.error}. У Яндекса и Mail.ru нужен «пароль приложения», а не обычный.`,
        saved: true,
      };
    }
    mailbox.markChecked(user.id);
    // Возвращаем адрес: экран говорит «письмо ушло на …», и это должно быть
    // правдой, а не общей фразой «почта подключена».
    return { sent: email, mailbox: mailbox.info(user.id) };
  },

  async 'POST /api/mailbox/delete'({ user }) {
    mailbox.remove(user.id);
    return { mailbox: null };
  },

  /*
   * Список отдаём целиком, но сумму и счётчик считаем здесь же — сделками.
   * Пока экран складывал список сам, он показывал вдвое больше плитки на
   * главной: счёт и закрывающий его акт на одну сделку шли как два долга.
   */
  async 'GET /api/unpaid'({ user }) {
    const s = bdb.unpaidSummary(user.id);
    return {
      docs: s.docs.map((d) => ({ ...docBrief(d), pair: Boolean(d.pair) })),
      count: s.count,
      sum: s.sum,
    };
  },

  async 'GET /api/debtors'({ user }) {
    return {
      debtors: bdb.debtors(user.id).map((d) => ({
        cpId: d.cp.id, name: d.cp.name, amount: d.amount,
        theyOwe: d.theyOwe, days: d.days, lastOp: d.lastOp,
      })),
    };
  },

  /**
   * Переписка с агентом. Разбирает фразу и говорит, куда пойти, — но сам
   * ничего не выписывает: документ забирает номер в сквозном ряду, и лишний
   * счёт нельзя тихо удалить. Приложение по ответу открывает нужный экран,
   * кнопку жмёт человек.
   */
  async 'POST /api/ask'({ user, body }) {
    const text = str(body.text, 1000);
    if (!text) return { error: 'Напишите или скажите, что нужно.' };
    const intent = await ai.understand(text, user.id);
    return { ...intent, heard: text, budget: ai.budget(user.id) };
  },

  /** То же самое, но голосом: расшифровали и сразу разобрали. */
  async 'POST /api/ask/voice'({ user, body }) {
    if (!speech.speechAvailable()) return { error: speech.speechHint() };
    const raw = String(body.audio || '');
    if (!raw) return { error: 'Пустая запись.' };
    // Запись приходит base64 из MediaRecorder. Потолок тот же, что у
    // Telegram: 20 МБ, дальше это уже не голосовое сообщение.
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > 20 * 1024 * 1024) return { error: 'Запись слишком длинная.' };
    const got = await speech.transcribe(buf, Number(body.seconds) || 0);
    if (!got.ok) return { error: got.error };
    const intent = await ai.understand(got.text, user.id);
    return { ...intent, heard: got.text, budget: ai.budget(user.id) };
  },

  /** Журнал операций одного контрагента: что именно держит его сальдо. */
  async 'GET /api/ops'({ user, url }) {
    const cpId = Number(url.searchParams.get('cp'));
    const b = bdb.balanceOf(user.id, cpId);
    if (!b) return { error: 'Контрагент не найден.' };
    return {
      cp: { id: b.cp.id, name: b.cp.name, kind: b.cp.kind },
      opening: round2(Number(b.cp.opening_balance) || 0),
      openingDate: b.cp.opening_date || '',
      closing: round2(b.closing),
      ops: b.rows.map((o) => ({
        id: o.id,
        date: o.date,
        kind: o.kind || '',
        doc: o.doc || '',
        // Знак с точки зрения долга: плюс — долг вырос, минус — закрыт.
        delta: round2((Number(o.credit) || 0) - (Number(o.debit) || 0)),
        balance: round2(o.balance),
        fromDoc: Boolean(o.doc_id),
      })),
    };
  },

  /** Убрать одну строку журнала. */
  async 'POST /api/op/delete'({ user, body }) {
    const before = Number(body.cpId) ? bdb.balanceOf(user.id, Number(body.cpId)) : null;
    if (!bdb.deleteOp(user.id, Number(body.id))) return { error: 'Операция не найдена.' };
    const after = Number(body.cpId) ? bdb.balanceOf(user.id, Number(body.cpId)) : null;
    return {
      deleted: true,
      balance: after ? round2(after.closing) : 0,
      delta: before && after ? round2(before.closing - after.closing) : 0,
    };
  },

  /** Из чего складывается крупная цифра на главной. */
  async 'GET /api/debts/why'({ user }) {
    return bdb.debtBreakdown(user.id);
  },

  async 'GET /api/templates'({ user }) {
    return { templates: bdb.listTemplates(user.id, 20) };
  },

  /** Выпуск документа: файл в чат + ссылка на скачивание в приложении. */
  async 'POST /api/doc'({ user, body }) {
    const res = await docService.issueDocument(user.id, {
      type: str(body.type, 10),
      cpId: Number(body.cpId),
      items: body.items,
      date: str(body.date, 10),
      number: str(body.number, 40),
    });
    if (!res.ok) return { error: res.message, reason: res.reason, quota: res.quota };

    const token = keepFile(user.id, res.file);
    await sendToChat(user, res).catch(() => {});
    return {
      doc: docBrief({ ...res.doc, cp_id: res.doc.cp.id, payload: { items: [] } }),
      total: res.total,
      quota: res.quota,
      file: { url: `/api/file/${token}`, name: res.file.filename, pdf: res.file.pdf },
      sentToChat: Boolean(tg),
    };
  },

  /** Прислать копию ранее выписанного. */
  async 'POST /api/doc/resend'({ user, body }) {
    const res = await docService.rebuildDocument(user.id, Number(body.id), { stamp: wantStamp(body) });
    if (!res.ok) return { error: res.message };
    const token = keepFile(user.id, res.file);
    if (tg) {
      await tg.sendDocument(user.tg_id, {
        filename: res.file.filename,
        buffer: res.file.buffer,
        caption: `${res.title} № ${res.doc.number} — копия.`,
      }).catch(() => {});
    }
    return {
      file: { url: `/api/file/${token}`, name: res.file.filename, pdf: res.file.pdf },
      stamp: res.stamp || null,
    };
  },
};

/**
 * Свежесобранный файл держим в памяти пару минут под одноразовым билетом.
 * На диск не кладём: документ содержит реквизиты и суммы, и оставлять его
 * в файловой системе сервера незачем — приложение забирает файл сразу.
 */
const files = new Map();
const crypto = require('node:crypto');
function keepFile(userId, file) {
  const token = crypto.randomBytes(18).toString('base64url');
  files.set(token, { userId, file, until: Date.now() + 5 * 60 * 1000 });
  for (const [k, v] of files) if (v.until < Date.now()) files.delete(k);
  return token;
}

/** Любой файл — в чат с ботом. Там он останется и его удобно переслать. */
async function sendFileToChat(user, file, caption) {
  if (!tg) return;
  try {
    await tg.sendDocument(user.tg_id, { filename: file.filename, buffer: file.buffer, caption });
  } catch (e) {
    if (e && e.blocked) bdb.markBlocked(user.id);
  }
}

async function sendToChat(user, res) {
  if (!tg) return;
  const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2 }).format(res.total);
  try {
    await tg.sendDocument(user.tg_id, {
      filename: res.file.filename,
      buffer: res.file.buffer,
      caption: `${res.title} № ${res.doc.number} для <b>${res.doc.cp.name}</b> на ${money} ₽.`
        + (res.doc.type === 'sch' ? '\nВ счёте есть QR — клиент платит, наведя камеру банка.' : ''),
    });
  } catch (e) {
    if (e && e.blocked) bdb.markBlocked(user.id);
    throw e;
  }
}

// ---------- статика ----------

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(ROOT, rel);
  // За пределы папки приложения не выпускаем даже при «../» в адресе.
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('нельзя'); return; }
  fs.readFile(full, (err, data) => {
    if (err) {
      // Одностраничное приложение: неизвестный путь — это его внутренний
      // экран, отдаём index.html и пусть разбирается сам.
      if (rel !== 'index.html') return serveStatic(req, res, '/');
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('мини-приложение не собрано');
    }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      // Статику приложения кэшировать нельзя надолго: обновление должно
      // доезжать до людей сразу, файлы крошечные.
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(data);
  });
}

// ---------- маршрутизация ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname === '/health') { res.writeHead(200); return res.end('ok'); }

  // Выдача готового файла по одноразовому билету.
  if (req.method === 'GET' && pathname.startsWith('/api/file/')) {
    const rec = files.get(pathname.slice('/api/file/'.length));
    if (!rec || rec.until < Date.now()) return sendJson(res, 404, { error: 'Файл уже недоступен, выпустите заново.' });
    files.delete(pathname.slice('/api/file/'.length));
    res.writeHead(200, {
      'Content-Type': rec.file.mime,
      'Content-Length': rec.file.buffer.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rec.file.filename)}`,
      'Cache-Control': 'no-store',
    });
    return res.end(rec.file.buffer);
  }

  /*
   * Документ по временной ссылке — единственный адрес, который открывается
   * без подписи Telegram. Подпись здесь и не нужна: ссылку отправляют
   * клиенту, у которого нашего бота нет и не будет. Секрет — сам токен.
   *
   * Что важно на этом адресе:
   *   • не пускать поисковики (noindex) — иначе счета клиентов окажутся
   *     в выдаче, и об этом узнают последними;
   *   • не кэшировать: документ собирается заново на каждое открытие, и
   *     исправленный счёт должен приходить исправленным;
   *   • ограничить частоту по токену — на случай, если ссылку положат
   *     туда, откуда её начнут дёргать без остановки;
   *   • на любую беду отвечать одинаково: «ссылка больше не работает».
   *     Различать «истекла» и «такой не было» незачем.
   */
  if (pathname.startsWith('/d/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('only GET'); }
    const token = decodeURIComponent(pathname.slice(3));
    if (tooOften(`d:${token}`, 60)) return sendLinkPage(res, 429, 'Слишком часто. Подождите минуту и обновите страницу.');
    const link = docLink.resolve(token);
    if (!link) return sendLinkPage(res, 404, 'Ссылка больше не работает.');
    let built;
    try {
      // forView: по ссылке документ смотрят, а не считают. Для акта сверки
      // это разные файлы — печатная форма против таблицы.
      built = await docService.rebuildDocument(link.userId, link.docId,
        { stamp: link.stamp, forView: true });
    } catch (e) {
      console.error('miniapp: ссылка на документ', e.message);
      return sendLinkPage(res, 500, 'Не получилось собрать документ. Попробуйте позже.');
    }
    if (!built.ok) return sendLinkPage(res, 404, 'Ссылка больше не работает.');
    docLink.touch(link.id);
    res.writeHead(200, {
      'Content-Type': built.file.mime,
      'Content-Length': built.file.buffer.length,
      // inline, а не attachment: человек открыл ссылку на телефоне и хочет
      // увидеть документ, а не найти его потом в «Загрузках».
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(built.file.filename)}`,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(req.method === 'HEAD' ? undefined : built.file.buffer);
  }

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET') { res.writeHead(405); return res.end('only GET'); }
    return serveStatic(req, res, pathname);
  }

  // --- дальше только API, и только со своей подписью ---
  const check = verifyInitData(initDataFrom(req));
  if (!check.ok) return sendJson(res, 401, { error: `Не удалось вас опознать: ${check.reason}` });

  const user = bdb.getOrCreateUser(
    check.user.id,
    [check.user.first_name, check.user.last_name].filter(Boolean).join(' '),
    check.user.username,
  );
  if (tooOften(user.id)) return sendJson(res, 429, { error: 'Слишком много запросов, подождите минуту.' });
  bdb.markActive(user.id);

  let body = {};
  if (req.method === 'POST') {
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return e && e.tooBig
        ? sendJson(res, 413, { error: 'Слишком большой запрос — уменьшите картинку.' })
        : sendJson(res, 400, { error: 'Тело запроса не разобралось.' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'Ожидался объект.' });
    }
  }

  const handler = api[`${req.method} ${pathname}`];
  if (!handler) return sendJson(res, 404, { error: 'Нет такого метода.' });

  try {
    const out = await handler({ user, body, url, req });
    return sendJson(res, out && out.error ? 400 : 200, out || {});
  } catch (e) {
    console.error('miniapp:', pathname, e.message);
    return sendJson(res, 500, { error: 'На сервере что-то пошло не так. Попробуйте ещё раз.' });
  }
});

if (require.main === module) {
  if (!process.env.BOT_TOKEN) {
    console.error('Не задан BOT_TOKEN — без него подпись Telegram не проверить.');
    process.exit(1);
  }
  server.listen(PORT, HOST, () => console.log(`Мини-приложение слушает ${HOST}:${PORT}`));
}

module.exports = { server, api, stateFor, setTelegram, forgetRate };
