'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Путь к базе можно переопределить — удобно для тестов и для разных площадок.
const DB_FILE = process.env.TRAPEZA_DB
  ? path.resolve(process.env.TRAPEZA_DB)
  : path.join(__dirname, 'data', 'trapeza.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// В базу пишут два процесса сразу — бот и мини-приложение. WAL разводит
// чтение с записью, но две записи всё равно встречаются, и без таймаута
// вторая падает мгновенно: «database is locked», а человек видит потерянный
// документ. Пять секунд ожидания снимают это полностью — запись занимает
// миллисекунды.
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',   -- состав / описание (показывается по клику)
  unit        TEXT    NOT NULL DEFAULT '',
  price       REAL    NOT NULL DEFAULT 0,
  price_tbd INTEGER NOT NULL DEFAULT 0,   -- 1 = «цена уточняется», в итог не входит
  category  TEXT    NOT NULL DEFAULT '',
  menu_type TEXT    NOT NULL DEFAULT 'furshet',  -- furshet (фуршет) | banket (банкет)
  photo     TEXT    NOT NULL DEFAULT '',
  active    INTEGER NOT NULL DEFAULT 1,
  sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,     -- публичная ссылка /s/<code>
  number      INTEGER NOT NULL,            -- Смета №
  title       TEXT    NOT NULL DEFAULT 'Заказ',
  client_name TEXT    NOT NULL DEFAULT '',
  phone       TEXT    NOT NULL DEFAULT '',
  event_date  TEXT    NOT NULL DEFAULT '',
  place       TEXT    NOT NULL DEFAULT '',
  guests      INTEGER NOT NULL DEFAULT 0,
  comment     TEXT    NOT NULL DEFAULT '',
  transport   REAL    NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'новая',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name      TEXT    NOT NULL,
  unit      TEXT    NOT NULL DEFAULT '',
  qty       REAL    NOT NULL DEFAULT 0,
  price     REAL    NOT NULL DEFAULT 0,
  price_tbd INTEGER NOT NULL DEFAULT 0,
  photo     TEXT    NOT NULL DEFAULT '',
  sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS counterparties (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,          -- краткое: ИП Сарычев И. Н.
  full_name       TEXT    NOT NULL DEFAULT '',
  inn             TEXT    NOT NULL DEFAULT '',
  kpp             TEXT    NOT NULL DEFAULT '',
  extra           TEXT    NOT NULL DEFAULT '',
  kind            TEXT    NOT NULL DEFAULT 'customer', -- customer | supplier
  contract        TEXT    NOT NULL DEFAULT '',
  opening_balance REAL    NOT NULL DEFAULT 0,
  opening_date    TEXT    NOT NULL DEFAULT '',
  period_end      TEXT    NOT NULL DEFAULT '',
  signer          TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS operations (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  cp_id  INTEGER NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  date   TEXT    NOT NULL,                  -- ISO yyyy-mm-dd (сортировка)
  kind   TEXT    NOT NULL DEFAULT '',       -- Приход / Оплата / Поставка / Принято
  doc    TEXT    NOT NULL DEFAULT '',
  debit  REAL    NOT NULL DEFAULT 0,
  credit REAL    NOT NULL DEFAULT 0,
  note   TEXT    NOT NULL DEFAULT '',
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ops_cp ON operations(cp_id, date, sort);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id, sort);
`);

// Миграции для ранее созданных баз.
const menuCols = () => db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name);
if (!menuCols().includes('description')) {
  db.exec("ALTER TABLE menu_items ADD COLUMN description TEXT NOT NULL DEFAULT ''");
}
if (!menuCols().includes('menu_type')) {
  db.exec("ALTER TABLE menu_items ADD COLUMN menu_type TEXT NOT NULL DEFAULT 'furshet'");
}

// ---------- settings ----------
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}
function allSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

// ---------- меню ----------
function listMenu(onlyActive = true) {
  const sql = `SELECT * FROM menu_items ${onlyActive ? 'WHERE active = 1' : ''}
               ORDER BY sort, id`;
  return db.prepare(sql).all();
}

// ---------- сверки: расчёт сальдо ----------
/**
 * Сальдо нарастающим итогом. Логика одинакова для обоих типов:
 *   сальдо = начальное + Кредит − Дебет
 * Для заказчика  — это долг контрагента нам, для поставщика — наш долг ему.
 */
function computeBalance(cp, ops) {
  let running = Number(cp.opening_balance) || 0;
  const rows = ops.map((op) => {
    running += (Number(op.credit) || 0) - (Number(op.debit) || 0);
    return { ...op, balance: running };
  });
  const totalDebit = ops.reduce((s, o) => s + (Number(o.debit) || 0), 0);
  const totalCredit = ops.reduce((s, o) => s + (Number(o.credit) || 0), 0);
  return { rows, totalDebit, totalCredit, closing: running };
}

module.exports = {
  db, getSetting, setSetting, allSettings, listMenu, computeBalance,
  DB_FILE, DATA_DIR: path.dirname(DB_FILE),
};
