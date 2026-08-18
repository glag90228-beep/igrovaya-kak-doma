'use strict';

/**
 * Доступ по подписке.
 *
 * Платежи принимает внешняя площадка (Lava Top), мы только выдаём доступ.
 * Поэтому здесь два входа: вебхук об оплате и ручная выдача владельцем.
 *
 * Каждый платёж записывается: без этого повторная доставка вебхука
 * (а площадки повторяют, если не получили 200) продлит подписку дважды.
 */

const crypto = require('node:crypto');

const { db } = require('../db');
require('./bot-db');       // таблицу bot_users создаёт он, порядок важен

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code       TEXT    PRIMARY KEY,        -- нормализованный, без дефисов
      pretty     TEXT    NOT NULL,           -- как показываем и диктуем
      days       INTEGER NOT NULL,
      max_uses   INTEGER NOT NULL DEFAULT 1,
      uses       INTEGER NOT NULL DEFAULT 0,
      note       TEXT    NOT NULL DEFAULT '',
      expires_at TEXT    NOT NULL DEFAULT '', -- ГГГГ-ММ-ДД, пусто = бессрочно
      created_at TEXT    NOT NULL,
      revoked_at TEXT    NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS promo_uses (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      code    TEXT    NOT NULL,
      user_id INTEGER NOT NULL,
      days    INTEGER NOT NULL,
      used_at TEXT    NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_use ON promo_uses(code, user_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT    NOT NULL,            -- идентификатор платежа у площадки
      provider    TEXT    NOT NULL DEFAULT 'lava',
      user_id     INTEGER NOT NULL DEFAULT 0,  -- 0 = пока не привязан к пользователю
      email       TEXT    NOT NULL DEFAULT '',
      amount      REAL    NOT NULL DEFAULT 0,
      currency    TEXT    NOT NULL DEFAULT 'RUB',
      days        INTEGER NOT NULL DEFAULT 0,
      status      TEXT    NOT NULL DEFAULT '',
      raw         TEXT    NOT NULL DEFAULT '',
      created_at  TEXT    NOT NULL,
      claimed_at  TEXT    NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_ext ON payments(provider, external_id);
    CREATE INDEX IF NOT EXISTS idx_pay_email ON payments(email);
  `);
}
migrate();

// «Сегодня» — по Москве, общая реализация в lib/period.js: по UTC доступ
// заканчивался на день раньше, чем показывали пользователю.
const { todayISO } = require('./period');
const norm = (s) => String(s || '').trim().toLowerCase();

/** Текущий доступ пользователя. */
function accessInfo(userId) {
  const u = db.prepare('SELECT access_until FROM bot_users WHERE id = ?').get(userId) || {};
  const until = u.access_until || '';
  const active = Boolean(until && until >= todayISO());
  const left = active
    ? Math.ceil((new Date(until) - new Date(todayISO())) / 86400000)
    : 0;
  return { until, active, left };
}

/**
 * Продлевает доступ. Считаем от большей из двух дат — сегодня и текущего
 * окончания: если человек продлил заранее, оплаченные дни не должны сгореть.
 */
function grantDays(userId, days) {
  const n = Math.max(1, Math.round(Number(days) || 0));
  const { until } = accessInfo(userId);
  const from = until && until > todayISO() ? new Date(until) : new Date(todayISO());
  from.setDate(from.getDate() + n);
  const next = from.toISOString().slice(0, 10);
  db.prepare('UPDATE bot_users SET access_until = ? WHERE id = ?').run(next, userId);
  return next;
}

function revokeAccess(userId) {
  db.prepare("UPDATE bot_users SET access_until = '' WHERE id = ?").run(userId);
}

/** Кто сейчас с оплаченным доступом — для команды владельца. */
function paidUsers() {
  return db.prepare(
    'SELECT * FROM bot_users WHERE access_until >= ? ORDER BY access_until',
  ).all(todayISO());
}

// ---------- коды доступа ----------

/**
 * Код доступа — способ дать подписку без оплаты: тестировщику, первым
 * клиентам, за отзыв, взамен сорвавшегося платежа.
 *
 * Почему код, а не «выдать по имени»: выдать вручную можно только тому, кто
 * уже запустил бота и чей номер вы знаете. Код же просто отдаётся человеку —
 * в переписке, на визитке, в объявлении — и работает сам.
 *
 * Алфавит без похожих букв: ноль и «O», единица и «I» неразличимы в чужом
 * шрифте, а код часто диктуют голосом или переписывают с экрана. Разбор
 * наоборот терпимый — регистр, пробелы и любые дефисы приводим к одному виду,
 * так что «prv a3kd 9mqx» тоже сработает.
 */
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
const PREFIX = 'PRV';

const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function randomCode() {
  let body = '';
  for (let i = 0; i < 8; i += 1) body += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/**
 * Создаёт коды.
 * @param {{days?:number, count?:number, maxUses?:number, note?:string, expiresInDays?:number}} o
 * @returns {Array<object>} строки созданных кодов
 */
function createCodes({ days = 30, count = 1, maxUses = 1, note = '', expiresInDays = 0 } = {}) {
  const d = Math.max(1, Math.min(3650, Math.round(Number(days) || 30)));
  const n = Math.max(1, Math.min(50, Math.round(Number(count) || 1)));
  const uses = Math.max(1, Math.min(10000, Math.round(Number(maxUses) || 1)));
  let expires = '';
  if (Number(expiresInDays) > 0) {
    const e = new Date();
    e.setDate(e.getDate() + Number(expiresInDays));
    expires = e.toISOString().slice(0, 10);
  }
  const out = [];
  for (let i = 0; i < n; i += 1) {
    let pretty = randomCode();
    // Совпадение почти невероятно, но «почти» на живой базе случается.
    while (db.prepare('SELECT 1 FROM promo_codes WHERE code = ?').get(normCode(pretty))) {
      pretty = randomCode();
    }
    db.prepare(`
      INSERT INTO promo_codes(code, pretty, days, max_uses, note, expires_at, created_at)
      VALUES(?,?,?,?,?,?,?)`).run(normCode(pretty), pretty, d, uses,
      String(note || '').slice(0, 200), expires, new Date().toISOString());
    out.push(getCode(pretty));
  }
  return out;
}

function getCode(raw) {
  return db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(normCode(raw)) || null;
}

/** Почему код не сработает — либо '' , если сработает. */
function codeProblem(c) {
  if (!c) return 'Такого кода нет. Проверьте, не потерялся ли символ.';
  if (c.revoked_at) return 'Этот код отключён.';
  if (c.expires_at && c.expires_at < todayISO()) return 'Срок действия кода истёк.';
  if (c.uses >= c.max_uses) return 'Код уже использован.';
  return '';
}

/**
 * Активация кода.
 *
 * Порядок важен. Сначала отмечаем использование — уникальный индекс не даст
 * одному человеку активировать код дважды, даже если он нажмёт кнопку два
 * раза подряд. Потом считаем расход условным UPDATE: если код разобрали
 * параллельно, changes окажется нулём, и мы честно откатим отметку, а не
 * подарим лишний месяц.
 *
 * @returns {{ok:true, until:string, days:number}|{ok:false, error:string}}
 */
function redeemCode(userId, raw) {
  const c = getCode(raw);
  if (!c) return { ok: false, error: codeProblem(c) };

  // Свою же активацию проверяем раньше остальных причин: у одноразового
  // кода она выглядит как «код использован», и человек решает, что код увели.
  const mine = db.prepare('SELECT * FROM promo_uses WHERE code = ? AND user_id = ?')
    .get(c.code, userId);
  if (mine) {
    const a = accessInfo(userId);
    return { ok: false, error: `Вы уже активировали этот код${a.active ? `, доступ действует до ${a.until.split('-').reverse().join('.')}` : ''}.` };
  }

  const problem = codeProblem(c);
  if (problem) return { ok: false, error: problem };

  let useId;
  try {
    useId = Number(db.prepare(
      'INSERT INTO promo_uses(code, user_id, days, used_at) VALUES(?,?,?,?)',
    ).run(c.code, userId, c.days, new Date().toISOString()).lastInsertRowid);
  } catch (_) {
    return { ok: false, error: 'Вы уже активировали этот код.' };
  }

  const spent = db.prepare(
    "UPDATE promo_codes SET uses = uses + 1 WHERE code = ? AND uses < max_uses AND revoked_at = ''",
  ).run(c.code).changes;
  if (!spent) {
    db.prepare('DELETE FROM promo_uses WHERE id = ?').run(useId);
    return { ok: false, error: 'Код только что закончился.' };
  }

  return { ok: true, until: grantDays(userId, c.days), days: c.days };
}

function revokeCode(raw) {
  return db.prepare("UPDATE promo_codes SET revoked_at = ? WHERE code = ? AND revoked_at = ''")
    .run(new Date().toISOString(), normCode(raw)).changes > 0;
}

/** Коды для владельца: сначала живые, внутри — свежие сверху. */
function listCodes(limit = 30) {
  return db.prepare(`
    SELECT * FROM promo_codes
    ORDER BY (revoked_at = '' AND uses < max_uses) DESC, created_at DESC
    LIMIT ?`).all(limit)
    .map((c) => ({ ...c, live: !codeProblem(c) }));
}

/** Кто активировал код — видно в списке владельца. */
function codeUsers(code) {
  return db.prepare(`
    SELECT p.used_at, p.days, u.tg_id, u.name, u.username
    FROM promo_uses p LEFT JOIN bot_users u ON u.id = p.user_id
    WHERE p.code = ? ORDER BY p.id`).all(normCode(code));
}

/** Активировал ли человек хоть какой-нибудь код — чтобы отличать тест от оплаты. */
function usedCodes(userId) {
  return db.prepare('SELECT * FROM promo_uses WHERE user_id = ? ORDER BY id DESC').all(userId);
}

// ---------- платежи ----------

function findPayment(provider, externalId) {
  return db.prepare('SELECT * FROM payments WHERE provider = ? AND external_id = ?')
    .get(provider, String(externalId));
}

/**
 * Записывает платёж. Повторный вебхук с тем же идентификатором ничего
 * не меняет и возвращает duplicate — площадки повторяют доставку,
 * и второе продление подписки было бы подарком за чужой счёт.
 */
function recordPayment(p) {
  const exists = findPayment(p.provider || 'lava', p.externalId);
  if (exists) return { duplicate: true, payment: exists };
  const info = db.prepare(`
    INSERT INTO payments(external_id, provider, user_id, email, amount, currency, days, status, raw, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    String(p.externalId), p.provider || 'lava', p.userId || 0, norm(p.email),
    Number(p.amount) || 0, p.currency || 'RUB', Number(p.days) || 0,
    p.status || '', p.raw ? JSON.stringify(p.raw).slice(0, 4000) : '', new Date().toISOString(),
  );
  return { duplicate: false, payment: findPayment(p.provider || 'lava', p.externalId), id: Number(info.lastInsertRowid) };
}

function attachPayment(paymentId, userId) {
  db.prepare('UPDATE payments SET user_id = ?, claimed_at = ? WHERE id = ?')
    .run(userId, new Date().toISOString(), paymentId);
}

/**
 * Оплаты, которые пришли без привязки к пользователю. По ним человек
 * потом нажимает «Я оплатил» и вводит почту, указанную на кассе.
 */
function unclaimedByEmail(email) {
  return db.prepare("SELECT * FROM payments WHERE user_id = 0 AND email = ? ORDER BY id")
    .all(norm(email));
}

function paymentsOf(userId, limit = 10) {
  return db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
}

module.exports = {
  accessInfo, grantDays, revokeAccess, paidUsers,
  recordPayment, findPayment, attachPayment, unclaimedByEmail, paymentsOf,
  createCodes, getCode, redeemCode, revokeCode, listCodes, codeUsers, usedCodes,
  normCode, looksLikeCode: (s) => new RegExp(`^${PREFIX}[-\\s]?[A-Z0-9]`, 'i').test(String(s || '').trim()),
};
