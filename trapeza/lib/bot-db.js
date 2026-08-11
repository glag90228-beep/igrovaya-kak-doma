'use strict';

// Многопользовательский слой для бота: пользователи Telegram, их организации,
// контрагенты и операции. Всё строго изолировано по user_id — пользователь
// никогда не видит чужие данные. Надстройка над существующей базой (db.js).

const { db, computeBalance } = require('../db');

// ---------- миграции (не ломают существующие таблицы) ----------

function columns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function addColumn(table, name, def) {
  if (!columns(table).includes(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id      INTEGER NOT NULL UNIQUE,
      name       TEXT    NOT NULL DEFAULT '',
      username   TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL,
      state      TEXT    NOT NULL DEFAULT '',
      state_data TEXT    NOT NULL DEFAULT '',
      access_until TEXT  NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS orgs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL DEFAULT '',
      full_name  TEXT    NOT NULL DEFAULT '',
      inn        TEXT    NOT NULL DEFAULT '',
      kpp        TEXT    NOT NULL DEFAULT '',
      signer     TEXT    NOT NULL DEFAULT '',
      address    TEXT    NOT NULL DEFAULT '',
      bank_name  TEXT    NOT NULL DEFAULT '',
      bik        TEXT    NOT NULL DEFAULT '',
      acc        TEXT    NOT NULL DEFAULT '',
      corr_acc   TEXT    NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orgs_user ON orgs(user_id);
  `);

  db.exec(`
    -- Выписанные документы. Храним не файл, а данные: файл пересобирается
    -- по требованию, зато «повторить прошлый счёт» получается бесплатно.
    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
      org_id     INTEGER NOT NULL DEFAULT 0,
      cp_id      INTEGER NOT NULL DEFAULT 0,
      type       TEXT    NOT NULL,              -- sch | usl | pp | akt | upd | torg12 | dog
      number     TEXT    NOT NULL DEFAULT '',
      seq        INTEGER NOT NULL DEFAULT 0,    -- порядковый номер внутри года
      year       INTEGER NOT NULL DEFAULT 0,
      date       TEXT    NOT NULL DEFAULT '',
      total      REAL    NOT NULL DEFAULT 0,
      payload    TEXT    NOT NULL DEFAULT '',   -- JSON: позиции, сумма, назначение
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_doc_user ON documents(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_doc_seq  ON documents(user_id, type, year);

    -- Часто повторяющиеся позиции: у малого бизнеса счёт — почти всегда
    -- копия предыдущего, набирать «Канапе ассорти; 20; 650» каждый раз незачем.
    CREATE TABLE IF NOT EXISTS item_templates (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id  INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
      name     TEXT    NOT NULL,
      unit     TEXT    NOT NULL DEFAULT 'шт.',
      price    REAL    NOT NULL DEFAULT 0,
      uses     INTEGER NOT NULL DEFAULT 1,
      used_at  TEXT    NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tpl_uniq ON item_templates(user_id, name);
  `);

  // расширяем контрагентов: владелец + банковские реквизиты (для счёта/платёжки)
  addColumn('counterparties', 'user_id', 'INTEGER');
  addColumn('counterparties', 'address', "TEXT NOT NULL DEFAULT ''");
  addColumn('counterparties', 'bank_name', "TEXT NOT NULL DEFAULT ''");
  addColumn('counterparties', 'bik', "TEXT NOT NULL DEFAULT ''");
  addColumn('counterparties', 'acc', "TEXT NOT NULL DEFAULT ''");
  addColumn('counterparties', 'corr_acc', "TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_cp_user ON counterparties(user_id)');
}

migrate();

// ---------- пользователи и состояние диалога ----------

function getOrCreateUser(tgId, name = '', username = '') {
  let u = db.prepare('SELECT * FROM bot_users WHERE tg_id = ?').get(tgId);
  if (!u) {
    db.prepare('INSERT INTO bot_users(tg_id, name, username, created_at) VALUES(?,?,?,?)')
      .run(tgId, name, username, new Date().toISOString());
    u = db.prepare('SELECT * FROM bot_users WHERE tg_id = ?').get(tgId);
  } else if ((name && name !== u.name) || (username && username !== u.username)) {
    db.prepare('UPDATE bot_users SET name = ?, username = ? WHERE id = ?').run(name, username, u.id);
  }
  return u;
}

function setState(userId, state, data = null) {
  db.prepare('UPDATE bot_users SET state = ?, state_data = ? WHERE id = ?')
    .run(state || '', data == null ? '' : JSON.stringify(data), userId);
}
function getState(userId) {
  const u = db.prepare('SELECT state, state_data FROM bot_users WHERE id = ?').get(userId);
  if (!u) return { state: '', data: {} };
  let data = {};
  try { data = u.state_data ? JSON.parse(u.state_data) : {}; } catch (_) { data = {}; }
  return { state: u.state || '', data };
}
function clearState(userId) { setState(userId, '', null); }

// ---------- организации пользователя ----------

function createOrg(userId, fields) {
  const cols = ['name', 'full_name', 'inn', 'kpp', 'signer', 'address',
    'bank_name', 'bik', 'acc', 'corr_acc'];
  const vals = cols.map((c) => fields[c] || '');
  const anyDefault = db.prepare('SELECT COUNT(*) AS n FROM orgs WHERE user_id = ?').get(userId).n;
  const info = db.prepare(`
    INSERT INTO orgs(user_id, ${cols.join(',')}, is_default, created_at)
    VALUES(?, ${cols.map(() => '?').join(',')}, ?, ?)`)
    .run(userId, ...vals, anyDefault === 0 ? 1 : 0, new Date().toISOString());
  return Number(info.lastInsertRowid);
}
function updateOrg(userId, id, fields) {
  const allowed = ['name', 'full_name', 'inn', 'kpp', 'signer', 'address',
    'bank_name', 'bik', 'acc', 'corr_acc'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  if (!sets.length) return;
  vals.push(id, userId);
  db.prepare(`UPDATE orgs SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
}
function listOrgs(userId) {
  return db.prepare('SELECT * FROM orgs WHERE user_id = ? ORDER BY is_default DESC, id').all(userId);
}
function getOrg(userId, id) {
  return db.prepare('SELECT * FROM orgs WHERE id = ? AND user_id = ?').get(id, userId);
}
function getDefaultOrg(userId) {
  return db.prepare('SELECT * FROM orgs WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1').get(userId);
}
function setDefaultOrg(userId, id) {
  db.prepare('UPDATE orgs SET is_default = 0 WHERE user_id = ?').run(userId);
  db.prepare('UPDATE orgs SET is_default = 1 WHERE id = ? AND user_id = ?').run(id, userId);
}

// ---------- контрагенты пользователя ----------

function createCp(userId, fields) {
  const cols = ['name', 'full_name', 'inn', 'kpp', 'extra', 'kind', 'contract',
    'opening_balance', 'opening_date', 'period_end', 'signer',
    'address', 'bank_name', 'bik', 'acc', 'corr_acc'];
  const vals = cols.map((c) => (c === 'opening_balance' ? (Number(fields[c]) || 0) : (fields[c] || '')));
  const info = db.prepare(`
    INSERT INTO counterparties(user_id, ${cols.join(',')})
    VALUES(?, ${cols.map(() => '?').join(',')})`).run(userId, ...vals);
  return Number(info.lastInsertRowid);
}
function updateCp(userId, id, fields) {
  const allowed = ['name', 'full_name', 'inn', 'kpp', 'extra', 'kind', 'contract',
    'opening_balance', 'opening_date', 'period_end', 'signer',
    'address', 'bank_name', 'bik', 'acc', 'corr_acc'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  if (!sets.length) return;
  vals.push(id, userId);
  db.prepare(`UPDATE counterparties SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
}
function listCps(userId) {
  return db.prepare('SELECT * FROM counterparties WHERE user_id = ? ORDER BY id').all(userId);
}
function getCp(userId, id) {
  return db.prepare('SELECT * FROM counterparties WHERE id = ? AND user_id = ?').get(id, userId);
}

// ---------- операции контрагента (с проверкой владельца) ----------

function addOp(userId, cpId, op) {
  const cp = getCp(userId, cpId);
  if (!cp) throw new Error('Контрагент не найден');
  const sort = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS s FROM operations WHERE cp_id = ?').get(cpId).s;
  db.prepare(`INSERT INTO operations(cp_id, date, kind, doc, debit, credit, note, sort)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(cpId, op.date, op.kind || '', op.doc || '', Number(op.debit) || 0, Number(op.credit) || 0,
      op.note || '', sort);
}
function listOps(userId, cpId) {
  const cp = getCp(userId, cpId);
  if (!cp) return [];
  return db.prepare('SELECT * FROM operations WHERE cp_id = ? ORDER BY date, sort, id').all(cpId);
}
function deleteLastOp(userId, cpId) {
  const cp = getCp(userId, cpId);
  if (!cp) return false;
  const row = db.prepare('SELECT id FROM operations WHERE cp_id = ? ORDER BY date DESC, sort DESC, id DESC LIMIT 1').get(cpId);
  if (!row) return false;
  db.prepare('DELETE FROM operations WHERE id = ?').run(row.id);
  return true;
}

/** Сальдо по контрагенту (переиспользует computeBalance из db.js) */
function balanceOf(userId, cpId) {
  const cp = getCp(userId, cpId);
  if (!cp) return null;
  const ops = listOps(userId, cpId);
  return { cp, ops, ...computeBalance(cp, ops) };
}

// ---------- выписанные документы и сквозная нумерация ----------

const DOC_TITLES = {
  sch: 'Счёт на оплату', usl: 'Акт об оказании услуг', pp: 'Платёжное поручение',
  akt: 'Акт сверки', upd: 'УПД', torg12: 'Товарная накладная ТОРГ-12',
  dog: 'Договор',
};

/**
 * Следующий номер документа этого типа в этом году.
 * Нумерация у каждого пользователя своя и не зависит от контрагента —
 * так требует практика: сквозной ряд по журналу, а не по клиентам.
 */
function nextSeq(userId, type, year) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS n FROM documents WHERE user_id = ? AND type = ? AND year = ?',
  ).get(userId, type, year);
  return row.n + 1;
}

/** Документ сохраняется данными; файл всегда пересобирается заново. */
function saveDoc(userId, { orgId, cpId, type, number, seq, date, total, payload }) {
  const year = Number(String(date).slice(0, 4)) || new Date().getFullYear();
  const info = db.prepare(`
    INSERT INTO documents(user_id, org_id, cp_id, type, number, seq, year, date, total, payload, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    userId, orgId || 0, cpId || 0, type, String(number), Number(seq) || 0, year,
    date || '', Number(total) || 0, payload ? JSON.stringify(payload) : '', new Date().toISOString(),
  );
  return Number(info.lastInsertRowid);
}

function listDocs(userId, limit = 10, cpId = null) {
  const sql = cpId
    ? 'SELECT * FROM documents WHERE user_id = ? AND cp_id = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM documents WHERE user_id = ? ORDER BY id DESC LIMIT ?';
  const rows = cpId
    ? db.prepare(sql).all(userId, cpId, limit)
    : db.prepare(sql).all(userId, limit);
  return rows.map(withPayload);
}

function getDoc(userId, id) {
  const row = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(id, userId);
  return row ? withPayload(row) : null;
}

function withPayload(row) {
  let payload = {};
  try { payload = row.payload ? JSON.parse(row.payload) : {}; } catch (_) { payload = {}; }
  return { ...row, payload, title: DOC_TITLES[row.type] || row.type };
}

function deleteDoc(userId, id) {
  const info = db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

// ---------- шаблоны позиций ----------

/** Запоминаем позицию: в следующий раз её можно поставить кнопкой. */
function rememberItems(userId, items) {
  const now = new Date().toISOString();
  for (const it of items || []) {
    const name = String(it.name || '').trim();
    if (!name) continue;
    const exists = db.prepare('SELECT id FROM item_templates WHERE user_id = ? AND name = ?')
      .get(userId, name);
    if (exists) {
      db.prepare('UPDATE item_templates SET price = ?, unit = ?, uses = uses + 1, used_at = ? WHERE id = ?')
        .run(Number(it.price) || 0, it.unit || 'шт.', now, exists.id);
    } else {
      db.prepare('INSERT INTO item_templates(user_id, name, unit, price, uses, used_at) VALUES(?,?,?,?,1,?)')
        .run(userId, name, it.unit || 'шт.', Number(it.price) || 0, now);
    }
  }
}

function listTemplates(userId, limit = 8) {
  return db.prepare(
    'SELECT * FROM item_templates WHERE user_id = ? ORDER BY uses DESC, used_at DESC LIMIT ?',
  ).all(userId, limit);
}

function getTemplate(userId, id) {
  return db.prepare('SELECT * FROM item_templates WHERE id = ? AND user_id = ?').get(id, userId);
}

function forgetTemplate(userId, id) {
  db.prepare('DELETE FROM item_templates WHERE id = ? AND user_id = ?').run(id, userId);
}

// ---------- доступ (место под подписку) ----------

// Пока не берём денег: считаем документы и показываем остаток, но не
// перекрываем. Включение — одним флагом, когда наберётся аудитория.
const FREE_PER_MONTH = 20;
const ENFORCE_LIMIT = false;

function docsThisMonth(userId) {
  const from = new Date().toISOString().slice(0, 7); // ГГГГ-ММ
  return db.prepare(
    "SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND substr(created_at,1,7) = ?",
  ).get(userId, from).n;
}

/** @returns {{allowed:boolean, used:number, left:number, limit:number, paid:boolean}} */
function quota(userId) {
  const u = db.prepare('SELECT access_until FROM bot_users WHERE id = ?').get(userId) || {};
  const paid = Boolean(u.access_until && u.access_until >= new Date().toISOString().slice(0, 10));
  const used = docsThisMonth(userId);
  const left = Math.max(0, FREE_PER_MONTH - used);
  return {
    allowed: paid || !ENFORCE_LIMIT || left > 0,
    used, left, limit: FREE_PER_MONTH, paid,
  };
}

module.exports = {
  migrate,
  getOrCreateUser, setState, getState, clearState,
  createOrg, updateOrg, listOrgs, getOrg, getDefaultOrg, setDefaultOrg,
  createCp, updateCp, listCps, getCp,
  addOp, listOps, deleteLastOp, balanceOf,
  nextSeq, saveDoc, listDocs, getDoc, deleteDoc, DOC_TITLES,
  rememberItems, listTemplates, getTemplate, forgetTemplate,
  quota, docsThisMonth, FREE_PER_MONTH,
};
