'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { db, getSetting, setSetting, allSettings, listMenu, computeBalance } = require('./db');
const seed = require('./seed');
const { buildAkt } = require('./lib/xlsx-akt');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PHOTOS_DIR = path.join(__dirname, 'photos');

seed.run();

// ---------------------------------------------------------------- утилиты

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function json(res, data, status = 200) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}
function fail(res, status, message) {
  json(res, { error: message }, status);
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

const nowIso = () => new Date().toISOString();

function makeCode() {
  return crypto.randomBytes(5).toString('hex');
}

// ---------------------------------------------------------------- авторизация админки

const sessions = new Set();

function isAdmin(req) {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)trapeza_admin=([^;]+)/.exec(cookie);
  return Boolean(m && sessions.has(m[1]));
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  fail(res, 401, 'Требуется вход');
  return false;
}

// ---------------------------------------------------------------- нормализация данных

/** Публичные настройки — без пароля админки. */
function publicSettings() {
  const s = allSettings();
  delete s.admin_password;
  return s;
}

function loadOrderByCode(code) {
  const order = db.prepare('SELECT * FROM orders WHERE code = ?').get(code);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id')
    .all(order.id);
  return order;
}

/** Сумма по позициям, без позиций с «ценой по запросу». */
function orderTotals(order) {
  const menuTotal = order.items.reduce(
    (s, it) => s + (it.price_tbd ? 0 : (Number(it.qty) || 0) * (Number(it.price) || 0)), 0);
  const transport = Number(order.transport) || 0;
  return { menuTotal, transport, grandTotal: menuTotal + transport };
}

function saveOrderItems(orderId, items) {
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
  const ins = db.prepare(`INSERT INTO order_items(order_id, name, unit, qty, price, price_tbd, photo, sort)
                          VALUES(?,?,?,?,?,?,?,?)`);
  (items || []).forEach((it, i) => {
    ins.run(orderId, String(it.name || ''), String(it.unit || ''),
      Number(it.qty) || 0, Number(it.price) || 0, it.price_tbd ? 1 : 0,
      String(it.photo || ''), i);
  });
}

function nextOrderNumber() {
  const row = db.prepare('SELECT MAX(number) AS n FROM orders').get();
  return (row && row.n ? Number(row.n) : 0) + 1;
}

// ---------------------------------------------------------------- статика

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return fail(res, 404, 'Не найдено');
    const ext = path.extname(filePath).toLowerCase();
    const isAsset = ext !== '.html';
    send(res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=3600' : 'no-store',
    });
  });
}

/** Защита от выхода за пределы каталога. */
function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  return p.startsWith(base) ? p : null;
}

// ---------------------------------------------------------------- маршруты API

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // --- публичное ---

  if (pathname === '/api/bootstrap' && method === 'GET') {
    return json(res, { settings: publicSettings(), menu: listMenu(true) });
  }

  if (pathname === '/api/orders' && method === 'POST') {
    const body = await readJson(req);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return fail(res, 400, 'Не выбрано ни одной позиции');
    }
    const code = makeCode();
    const number = nextOrderNumber();
    const ts = nowIso();
    const transport = body.transport === undefined || body.transport === null
      ? Number(getSetting('transport_default', 0)) : Number(body.transport) || 0;
    const info = db.prepare(`
      INSERT INTO orders(code, number, title, client_name, phone, event_date, place, guests,
                         comment, transport, status, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      code, number, String(body.title || 'Кофе-брейк'), String(body.client_name || ''),
      String(body.phone || ''), String(body.event_date || ''), String(body.place || ''),
      Number(body.guests) || 0, String(body.comment || ''), transport, 'новая', ts, ts);
    saveOrderItems(Number(info.lastInsertRowid), body.items);
    return json(res, { code, number }, 201);
  }

  let m = /^\/api\/orders\/([a-z0-9]+)$/.exec(pathname);
  if (m) {
    const order = loadOrderByCode(m[1]);
    if (!order) return fail(res, 404, 'Смета не найдена');

    if (method === 'GET') {
      return json(res, { order, totals: orderTotals(order), settings: publicSettings() });
    }
    // Клиент может поправить свой заказ по ссылке, пока смета не согласована.
    if (method === 'PUT') {
      if (order.status === 'согласована' || order.status === 'отменена') {
        return fail(res, 409, 'Смета уже согласована — изменения вносит менеджер');
      }
      const body = await readJson(req);
      db.prepare(`UPDATE orders SET client_name=?, phone=?, event_date=?, place=?, guests=?,
                  comment=?, updated_at=? WHERE id=?`).run(
        String(body.client_name ?? order.client_name), String(body.phone ?? order.phone),
        String(body.event_date ?? order.event_date), String(body.place ?? order.place),
        Number(body.guests) || order.guests, String(body.comment ?? order.comment),
        nowIso(), order.id);
      if (Array.isArray(body.items)) saveOrderItems(order.id, body.items);
      const updated = loadOrderByCode(m[1]);
      return json(res, { order: updated, totals: orderTotals(updated) });
    }
  }

  // --- вход в админку (POST /api/login обрабатывается раньше, там доступен Set-Cookie) ---

  if (pathname === '/api/login' && method === 'GET') {
    return json(res, { authorized: isAdmin(req) });
  }

  // --- админка ---

  if (pathname.startsWith('/api/admin/')) {
    if (!requireAdmin(req, res)) return;

    if (pathname === '/api/admin/orders' && method === 'GET') {
      const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
      for (const o of orders) {
        o.items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sort, id').all(o.id);
        o.totals = orderTotals(o);
      }
      return json(res, { orders });
    }

    m = /^\/api\/admin\/orders\/(\d+)$/.exec(pathname);
    if (m) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const body = await readJson(req);
        const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
        if (!cur) return fail(res, 404, 'Заявка не найдена');
        db.prepare(`UPDATE orders SET title=?, client_name=?, phone=?, event_date=?, place=?,
                    guests=?, comment=?, transport=?, status=?, updated_at=? WHERE id=?`).run(
          String(body.title ?? cur.title), String(body.client_name ?? cur.client_name),
          String(body.phone ?? cur.phone), String(body.event_date ?? cur.event_date),
          String(body.place ?? cur.place), Number(body.guests) || 0,
          String(body.comment ?? cur.comment), Number(body.transport) || 0,
          String(body.status ?? cur.status), nowIso(), id);
        if (Array.isArray(body.items)) saveOrderItems(id, body.items);
        return json(res, { ok: true });
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM orders WHERE id=?').run(id);
        return json(res, { ok: true });
      }
    }

    if (pathname === '/api/admin/menu' && method === 'GET') {
      return json(res, { menu: listMenu(false) });
    }
    if (pathname === '/api/admin/menu' && method === 'POST') {
      const b = await readJson(req);
      const maxSort = db.prepare('SELECT MAX(sort) AS s FROM menu_items').get().s || 0;
      const info = db.prepare(`INSERT INTO menu_items(name, unit, price, price_tbd, category, photo, active, sort)
                               VALUES(?,?,?,?,?,?,1,?)`).run(
        String(b.name || ''), String(b.unit || ''), Number(b.price) || 0,
        b.price_tbd ? 1 : 0, String(b.category || ''), String(b.photo || ''), maxSort + 1);
      return json(res, { id: Number(info.lastInsertRowid) }, 201);
    }
    m = /^\/api\/admin\/menu\/(\d+)$/.exec(pathname);
    if (m) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const b = await readJson(req);
        const cur = db.prepare('SELECT * FROM menu_items WHERE id=?').get(id);
        if (!cur) return fail(res, 404, 'Позиция не найдена');
        db.prepare(`UPDATE menu_items SET name=?, unit=?, price=?, price_tbd=?, category=?,
                    photo=?, active=?, sort=? WHERE id=?`).run(
          String(b.name ?? cur.name), String(b.unit ?? cur.unit),
          b.price === undefined ? cur.price : Number(b.price) || 0,
          b.price_tbd === undefined ? cur.price_tbd : (b.price_tbd ? 1 : 0),
          String(b.category ?? cur.category), String(b.photo ?? cur.photo),
          b.active === undefined ? cur.active : (b.active ? 1 : 0),
          b.sort === undefined ? cur.sort : Number(b.sort) || 0, id);
        return json(res, { ok: true });
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM menu_items WHERE id=?').run(id);
        return json(res, { ok: true });
      }
    }

    // Загрузка фото блюда: сырые байты, имя и тип — в заголовках.
    if (pathname === '/api/admin/photo' && method === 'POST') {
      let name = String(req.headers['x-filename'] || '');
      try { name = decodeURIComponent(name); } catch { /* оставляем как есть */ }
      const ext = path.extname(name).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        return fail(res, 400, 'Допустимы только PNG, JPG и WEBP');
      }
      const buf = await readBody(req);
      if (!buf.length) return fail(res, 400, 'Пустой файл');
      const slug = crypto.randomBytes(4).toString('hex') + ext;
      fs.writeFileSync(path.join(PHOTOS_DIR, slug), buf);
      return json(res, { photo: slug }, 201);
    }

    if (pathname === '/api/admin/settings' && method === 'GET') {
      return json(res, { settings: allSettings() });
    }
    if (pathname === '/api/admin/settings' && method === 'PUT') {
      const b = await readJson(req);
      for (const [k, v] of Object.entries(b)) setSetting(k, v);
      return json(res, { ok: true });
    }

    // --- сверки ---

    if (pathname === '/api/admin/counterparties' && method === 'GET') {
      const list = db.prepare('SELECT * FROM counterparties ORDER BY name').all();
      for (const cp of list) {
        const ops = db.prepare('SELECT * FROM operations WHERE cp_id=? ORDER BY date, sort, id').all(cp.id);
        cp.closing = computeBalance(cp, ops).closing;
        cp.ops_count = ops.length;
      }
      return json(res, { counterparties: list });
    }
    if (pathname === '/api/admin/counterparties' && method === 'POST') {
      const b = await readJson(req);
      const info = db.prepare(`
        INSERT INTO counterparties(name, full_name, inn, kpp, extra, kind, contract,
                                   opening_balance, opening_date, period_end, signer)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        String(b.name || ''), String(b.full_name || ''), String(b.inn || ''), String(b.kpp || ''),
        String(b.extra || ''), b.kind === 'supplier' ? 'supplier' : 'customer',
        String(b.contract || ''), Number(b.opening_balance) || 0, String(b.opening_date || ''),
        String(b.period_end || ''), String(b.signer || ''));
      return json(res, { id: Number(info.lastInsertRowid) }, 201);
    }

    m = /^\/api\/admin\/counterparties\/(\d+)$/.exec(pathname);
    if (m) {
      const id = Number(m[1]);
      if (method === 'GET') {
        const cp = db.prepare('SELECT * FROM counterparties WHERE id=?').get(id);
        if (!cp) return fail(res, 404, 'Контрагент не найден');
        const ops = db.prepare('SELECT * FROM operations WHERE cp_id=? ORDER BY date, sort, id').all(id);
        return json(res, { counterparty: cp, ...computeBalance(cp, ops) });
      }
      if (method === 'PUT') {
        const b = await readJson(req);
        const cur = db.prepare('SELECT * FROM counterparties WHERE id=?').get(id);
        if (!cur) return fail(res, 404, 'Контрагент не найден');
        db.prepare(`UPDATE counterparties SET name=?, full_name=?, inn=?, kpp=?, extra=?, kind=?,
                    contract=?, opening_balance=?, opening_date=?, period_end=?, signer=? WHERE id=?`).run(
          String(b.name ?? cur.name), String(b.full_name ?? cur.full_name),
          String(b.inn ?? cur.inn), String(b.kpp ?? cur.kpp), String(b.extra ?? cur.extra),
          b.kind === 'supplier' ? 'supplier' : 'customer', String(b.contract ?? cur.contract),
          b.opening_balance === undefined ? cur.opening_balance : Number(b.opening_balance) || 0,
          String(b.opening_date ?? cur.opening_date), String(b.period_end ?? cur.period_end),
          String(b.signer ?? cur.signer), id);
        return json(res, { ok: true });
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM counterparties WHERE id=?').run(id);
        return json(res, { ok: true });
      }
    }

    if (pathname === '/api/admin/operations' && method === 'POST') {
      const b = await readJson(req);
      const maxSort = db.prepare('SELECT MAX(sort) AS s FROM operations WHERE cp_id=?')
        .get(Number(b.cp_id)).s || 0;
      const info = db.prepare(`INSERT INTO operations(cp_id, date, kind, doc, debit, credit, note, sort)
                               VALUES(?,?,?,?,?,?,?,?)`).run(
        Number(b.cp_id), String(b.date || ''), String(b.kind || ''), String(b.doc || ''),
        Number(b.debit) || 0, Number(b.credit) || 0, String(b.note || ''), maxSort + 1);
      return json(res, { id: Number(info.lastInsertRowid) }, 201);
    }

    m = /^\/api\/admin\/operations\/(\d+)$/.exec(pathname);
    if (m) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const b = await readJson(req);
        const cur = db.prepare('SELECT * FROM operations WHERE id=?').get(id);
        if (!cur) return fail(res, 404, 'Операция не найдена');
        db.prepare(`UPDATE operations SET date=?, kind=?, doc=?, debit=?, credit=?, note=? WHERE id=?`).run(
          String(b.date ?? cur.date), String(b.kind ?? cur.kind), String(b.doc ?? cur.doc),
          b.debit === undefined ? cur.debit : Number(b.debit) || 0,
          b.credit === undefined ? cur.credit : Number(b.credit) || 0,
          String(b.note ?? cur.note), id);
        return json(res, { ok: true });
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM operations WHERE id=?').run(id);
        return json(res, { ok: true });
      }
    }

    // Выгрузка акта сверки в Excel
    m = /^\/api\/admin\/akt\/(\d+)\.xlsx$/.exec(pathname);
    if (m && method === 'GET') {
      const cp = db.prepare('SELECT * FROM counterparties WHERE id=?').get(Number(m[1]));
      if (!cp) return fail(res, 404, 'Контрагент не найден');
      const ops = db.prepare('SELECT * FROM operations WHERE cp_id=? ORDER BY date, sort, id').all(cp.id);
      const buf = await buildAkt({ org: allSettings(), cp, ops });
      const fname = `Акт_сверки_${cp.name.replace(/[^\wА-Яа-яЁё]+/g, '_')}.xlsx`;
      return send(res, 200, buf, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
      });
    }
  }

  return fail(res, 404, 'Неизвестный метод API');
}

// ---------------------------------------------------------------- сервер

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname.startsWith('/api/')) {
      // Токен админки ставим здесь, чтобы иметь доступ к res
      if (pathname === '/api/login' && req.method === 'POST') {
        const buf = await readBody(req);
        const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
        if (String(body.password || '') !== getSetting('admin_password', '')) {
          return fail(res, 403, 'Неверный пароль');
        }
        const token = crypto.randomBytes(24).toString('hex');
        sessions.add(token);
        return send(res, 200, JSON.stringify({ ok: true }), {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `trapeza_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
        });
      }
      return await handleApi(req, res, url);
    }

    // Фото блюд
    if (pathname.startsWith('/photos/')) {
      const p = safeJoin(PHOTOS_DIR, decodeURIComponent(pathname.slice('/photos/'.length)));
      if (!p) return fail(res, 400, 'Некорректный путь');
      return serveFile(res, p);
    }

    // Смета по публичной ссылке
    if (/^\/s\/[a-z0-9]+$/.test(pathname)) {
      return serveFile(res, path.join(PUBLIC_DIR, 'smeta.html'));
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    }

    if (pathname === '/') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));

    const p = safeJoin(PUBLIC_DIR, decodeURIComponent(pathname));
    if (!p) return fail(res, 400, 'Некорректный путь');
    return serveFile(res, p);
  } catch (err) {
    console.error('Ошибка запроса:', err);
    if (!res.headersSent) fail(res, 500, err.message || 'Внутренняя ошибка');
  }
});

server.listen(PORT, () => {
  console.log(`«Трапеза» запущена: http://localhost:${PORT}`);
  console.log(`  клиенту  →  http://localhost:${PORT}/`);
  console.log(`  админка  →  http://localhost:${PORT}/admin`);
});

module.exports = server;
