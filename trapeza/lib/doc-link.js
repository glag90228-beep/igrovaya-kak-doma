'use strict';

/**
 * Временная ссылка на документ.
 *
 * Зачем. Счёт клиенту чаще всего отправляют не почтой, а в переписке — в
 * Telegram, в WhatsApp, в рабочий чат. Файл там живёт плохо: на телефоне он
 * открывается через раз, в групповом чате теряется среди прочих, а если
 * документ переделали, у получателя остаётся старый. Ссылка решает всё
 * это разом: она короткая, открывается в браузере на любом телефоне, и
 * бумага по ней собирается заново в момент открытия.
 *
 * Почему временная. Ссылка без пароля — это и есть пароль: кто её получил,
 * тот и видит документ с реквизитами и суммами. Пересланная в третьи руки,
 * она не должна работать вечно, а брошенная в общем чате — не должна лежать
 * там годами. Поэтому у каждой свой срок, по умолчанию неделя: столько
 * живёт разговор об одном счёте.
 *
 * Чего здесь нет и не будет. Ссылка не даёт ничего, кроме одного документа:
 * ни списка, ни соседних, ни имени владельца сверх того, что и так стоит в
 * бланке. Токен случайный и длинный — подобрать перебором нельзя, а искать
 * по номеру документа нечего: номер в адресе не участвует.
 */

const crypto = require('node:crypto');
const { db } = require('../db');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_links (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      doc_id     INTEGER NOT NULL,
      token      TEXT    NOT NULL UNIQUE,
      stamp      TEXT    NOT NULL DEFAULT '',   -- JSON штампов, с которыми собирать
      expires_at TEXT    NOT NULL,              -- ISO, время истечения
      opens      INTEGER NOT NULL DEFAULT 0,
      last_open  TEXT    NOT NULL DEFAULT '',
      revoked    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_doclink_doc ON doc_links(user_id, doc_id);
  `);
}
migrate();

const nowISO = () => new Date().toISOString();

/** Сколько дней живёт ссылка. Меньше суток и больше двух месяцев не бывает. */
const DAYS = () => {
  const n = Number(process.env.DOC_LINK_DAYS || 7);
  return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.round(n) : 7;
};

/**
 * Адрес сайта, на котором живут ссылки.
 *
 * Берём из PUBLIC_URL, а если его нет — из адреса мини-приложения: оно и так
 * обязано быть на https и на том же домене. Если нет ни того, ни другого,
 * ссылку не делаем вовсе: показать человеку «http://localhost:8790/d/…» и
 * предложить отправить это клиенту было бы издевательством.
 */
function baseUrl() {
  const direct = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/.+/i.test(direct)) return direct;
  const app = String(process.env.WEBAPP_URL || '').trim();
  if (!/^https:\/\/.+/i.test(app)) return '';
  try { return new URL(app).origin; } catch (_) { return ''; }
}

const available = () => Boolean(baseUrl());
const urlFor = (token) => (baseUrl() ? `${baseUrl()}/d/${token}` : '');

/** Штампы храним строкой: сравнивать проще, а вариантов всего четыре. */
const stampKey = (s) => (s && (s.paid || s.copy)
  ? JSON.stringify({ paid: Boolean(s.paid), copy: Boolean(s.copy) }) : '');

function parseStamp(raw) {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && (s.paid || s.copy) ? { paid: Boolean(s.paid), copy: Boolean(s.copy) } : null;
  } catch (_) { return null; }
}

const view = (row) => (row ? {
  id: row.id,
  userId: row.user_id,
  docId: row.doc_id,
  token: row.token,
  url: urlFor(row.token),
  stamp: parseStamp(row.stamp),
  expiresAt: row.expires_at,
  opens: row.opens,
  lastOpen: row.last_open,
} : null);

/**
 * Живая ссылка на этот документ с такими же штампами — или null.
 *
 * Ищем прежде чем делать новую: иначе каждое нажатие кнопки плодило бы ещё
 * один действующий адрес, и отозвать документ стало бы нельзя — пришлось бы
 * помнить все розданные.
 */
function activeFor(userId, docId, stamp = null) {
  const row = db.prepare(
    `SELECT * FROM doc_links
      WHERE user_id = ? AND doc_id = ? AND stamp = ? AND revoked = 0 AND expires_at > ?
      ORDER BY id DESC LIMIT 1`,
  ).get(userId, docId, stampKey(stamp), nowISO());
  return view(row);
}

/** Все действующие ссылки на документ — чтобы показать, что раздано. */
function listFor(userId, docId) {
  return db.prepare(
    `SELECT * FROM doc_links
      WHERE user_id = ? AND doc_id = ? AND revoked = 0 AND expires_at > ?
      ORDER BY id DESC`,
  ).all(userId, docId, nowISO()).map(view);
}

/**
 * Сделать ссылку (или вернуть уже сделанную).
 *
 * @param {number} userId
 * @param {number} docId
 * @param {{days?:number, stamp?:object}} [opts]
 */
function create(userId, docId, opts = {}) {
  if (!available()) return null;
  const stamp = opts.stamp && (opts.stamp.paid || opts.stamp.copy) ? opts.stamp : null;
  const already = activeFor(userId, docId, stamp);
  if (already) return already;

  const days = Number.isFinite(Number(opts.days)) && Number(opts.days) >= 1
    ? Math.min(60, Math.round(Number(opts.days))) : DAYS();
  // 24 случайных байта — 192 бита. Перебирать нечего.
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare(
    `INSERT INTO doc_links (user_id, doc_id, token, stamp, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, docId, token, stampKey(stamp), expires, nowISO());
  purge();
  return view(db.prepare('SELECT * FROM doc_links WHERE token = ?').get(token));
}

/**
 * Кому принадлежит токен — или null, если ссылка не та, отозвана или истекла.
 * Причину наружу не называем: «истекла» и «не существует» для чужого
 * одинаково неинтересны, а вместе они подсказывают, что такой токен был.
 */
function resolve(token) {
  const t = String(token || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) return null;
  const row = db.prepare('SELECT * FROM doc_links WHERE token = ?').get(t);
  if (!row || row.revoked || row.expires_at <= nowISO()) return null;
  return view(row);
}

/** Отметить открытие: владельцу полезно знать, дошёл ли документ. */
function touch(id) {
  db.prepare('UPDATE doc_links SET opens = opens + 1, last_open = ? WHERE id = ?')
    .run(nowISO(), id);
}

/** Закрыть доступ. Отзывать умеет только тот, кто ссылку сделал. */
function revoke(userId, docId) {
  return db.prepare('UPDATE doc_links SET revoked = 1 WHERE user_id = ? AND doc_id = ? AND revoked = 0')
    .run(userId, docId).changes;
}

/**
 * Уборка. Истёкшие строки держим ещё месяц: по ним видно, что ссылку
 * открывали, и владелец успевает это заметить. Дальше они никому не нужны.
 */
function purge(days = 30) {
  const edge = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare('DELETE FROM doc_links WHERE expires_at < ?').run(edge).changes;
}

module.exports = {
  available, baseUrl, urlFor, create, resolve, touch, revoke, activeFor, listFor, purge, DAYS,
};
