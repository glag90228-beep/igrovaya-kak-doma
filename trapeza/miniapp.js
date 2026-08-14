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
const dadata = require('./lib/dadata');
const { parseRequisites, looksLikeBlock } = require('./lib/reqs');
const { round2 } = require('./lib/money');
const { verifyInitData, initDataFrom } = require('./lib/webapp-auth');
const { payLink } = require('./lib/lava');
const { Telegram } = require('./lib/tg');

const PORT = Number(process.env.MINIAPP_PORT || 8790);
const ROOT = path.join(__dirname, 'public', 'app');
const MAX_BODY = 512 * 1024;

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
const hits = new Map();
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
    let stop = false;
    req.on('data', (chunk) => {
      if (stop) return;
      body += chunk;
      if (body.length > MAX_BODY) { stop = true; req.destroy(); reject(new Error('слишком большое тело')); }
    });
    req.on('end', () => { if (!stop) resolve(body); });
    req.on('error', reject);
  });
}

const str = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);

// ---------- сборка данных для экранов ----------

/** Всё, что нужно главному экрану, одним запросом — меньше походов по сети. */
function stateFor(user) {
  const org = bdb.getDefaultOrg(user.id);
  const quota = bdb.quota(user.id);
  const access = billing.accessInfo(user.id);
  const debts = bdb.debtors(user.id);
  const owedToUs = round2(debts.filter((d) => d.theyOwe).reduce((s, d) => s + d.amount, 0));
  const owedByUs = round2(debts.filter((d) => !d.theyOwe).reduce((s, d) => s + d.amount, 0));
  return {
    user: { id: user.id, tgId: user.tg_id, name: user.name },
    org: org || null,
    orgReady: Boolean(org && org.name && org.inn && org.acc && org.bik),
    quota,
    access,
    counts: { cps: bdb.listCps(user.id).length, debtors: debts.length },
    debts: { owedToUs, owedByUs },
    docs: bdb.listDocs(user.id, 5).map(docBrief),
    payUrl: payLink(user.tg_id),
    features: { dadata: dadata.dadataAvailable(), pdf: true },
  };
}

function docBrief(d) {
  return {
    id: d.id, type: d.type, title: d.title, number: d.number, date: d.date,
    total: d.total, cpId: d.cp_id,
    items: (d.payload && d.payload.items) || [],
  };
}

function cpBrief(userId, cp) {
  const b = bdb.balanceOf(userId, cp.id);
  return {
    id: cp.id, name: cp.name, full_name: cp.full_name, inn: cp.inn, kpp: cp.kpp,
    kind: cp.kind, address: cp.address, bank_name: cp.bank_name, bik: cp.bik,
    acc: cp.acc, corr_acc: cp.corr_acc, contract: cp.contract,
    balance: b ? round2(b.closing) : 0,
  };
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
    };
    const id = Number(body.id) || 0;
    if (id) {
      if (!bdb.getCp(user.id, id)) return { error: 'Контрагент не найден.' };
      bdb.updateCp(user.id, id, fields);
      return { cp: cpBrief(user.id, bdb.getCp(user.id, id)) };
    }
    const newId = bdb.createCp(user.id, { ...fields, opening_date: docService.todayISO() });
    return { cp: cpBrief(user.id, bdb.getCp(user.id, newId)) };
  },

  async 'POST /api/org'({ user, body }) {
    const name = str(body.name, 200);
    if (!name) return { error: 'Укажите название организации.' };
    bdb.saveMyOrg(user.id, {
      name,
      full_name: str(body.full_name, 400),
      inn: str(body.inn, 12),
      kpp: str(body.kpp, 9),
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

  async 'GET /api/docs'({ user, url }) {
    const cpId = Number(url.searchParams.get('cp')) || null;
    return { docs: bdb.listDocs(user.id, 30, cpId).map(docBrief) };
  },

  async 'GET /api/debtors'({ user }) {
    return {
      debtors: bdb.debtors(user.id).map((d) => ({
        cpId: d.cp.id, name: d.cp.name, amount: d.amount,
        theyOwe: d.theyOwe, days: d.days, lastOp: d.lastOp,
      })),
    };
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
    const res = await docService.rebuildDocument(user.id, Number(body.id));
    if (!res.ok) return { error: res.message };
    const token = keepFile(user.id, res.file);
    if (tg) {
      await tg.sendDocument(user.tg_id, {
        filename: res.file.filename,
        buffer: res.file.buffer,
        caption: `${res.title} № ${res.doc.number} — копия.`,
      }).catch(() => {});
    }
    return { file: { url: `/api/file/${token}`, name: res.file.filename, pdf: res.file.pdf } };
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
    } catch (_) { return sendJson(res, 400, { error: 'Тело запроса не разобралось.' }); }
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
  server.listen(PORT, () => console.log(`Мини-приложение слушает :${PORT}`));
}

module.exports = { server, api, stateFor, setTelegram };
