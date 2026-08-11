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

const { db } = require('../db');

function migrate() {
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

const todayISO = () => new Date().toISOString().slice(0, 10);
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
};
