'use strict';

const { db } = require('../db');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS office_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT    NOT NULL,
      where_at   TEXT    NOT NULL DEFAULT '',
      text       TEXT    NOT NULL DEFAULT '',
      error      TEXT    NOT NULL DEFAULT '',
      user_id    INTEGER NOT NULL DEFAULT 0,
      sent       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_office_kind ON office_events(kind, created_at);
  `);
}
migrate();

const nowISO = () => new Date().toISOString();
const OFFICE = () => String(process.env.OFFICE_CHAT_ID || process.env.SUPPORT_CHAT_ID || '').trim();
const HOUR = 3600 * 1000;

let sendFn = null;
function attach(fn) { sendFn = typeof fn === 'function' ? fn : null; }

function recentCount(kind, ms = HOUR) {
  const since = new Date(Date.now() - ms).toISOString();
  return db.prepare(
    'SELECT COUNT(*) AS n FROM office_events WHERE kind = ? AND created_at >= ?',
  ).get(kind, since).n;
}

function seenSame(kind, text, ms = HOUR) {
  const since = new Date(Date.now() - ms).toISOString();
  return Boolean(db.prepare(
    'SELECT 1 FROM office_events WHERE kind = ? AND text = ? AND created_at >= ?',
  ).get(kind, text, since));
}

function formatEvent({ kind, where, text, error, userId }) {
  const lines = [`<b>Офис · ${kind}</b>`];
  if (where) lines.push(`где: <code>${esc(where)}</code>`);
  if (userId) lines.push(`user: <code>${userId}</code>`);
  if (text) lines.push('', esc(String(text).slice(0, 400)));
  if (error) lines.push('', `<code>${esc(String(error).slice(0, 400))}</code>`);
  return lines.join('\n');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function record({ kind, where = '', text = '', error = '', userId = 0 } = {}) {
  const k = String(kind || 'note').slice(0, 40);
  const t = String(text || '').slice(0, 500);
  const e = String(error || '').slice(0, 500);
  const w = String(where || '').slice(0, 80);
  const uid = Number(userId) || 0;
  db.prepare(`
    INSERT INTO office_events(kind, where_at, text, error, user_id, sent, created_at)
    VALUES(?,?,?,?,?,0,?)`).run(k, w, t, e, uid, nowISO());
  const id = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);

  const chat = OFFICE();
  const dup = t && seenSame(k, t) && recentCount(k) > 1;
  const flooded = recentCount(k) > 20;
  if (!chat || !sendFn || dup || flooded) return { id, sent: false, skipped: !chat ? 'no-chat' : (dup ? 'dup' : (flooded ? 'flood' : 'no-send')) };

  try {
    await sendFn(chat, formatEvent({ kind: k, where: w, text: t, error: e, userId: uid }));
    db.prepare('UPDATE office_events SET sent = 1 WHERE id = ?').run(id);
    return { id, sent: true };
  } catch (err) {
    return { id, sent: false, skipped: err.message };
  }
}

function list(kind, limit = 30) {
  if (kind) {
    return db.prepare(
      'SELECT * FROM office_events WHERE kind = ? ORDER BY id DESC LIMIT ?',
    ).all(kind, limit);
  }
  return db.prepare('SELECT * FROM office_events ORDER BY id DESC LIMIT ?').all(limit);
}

function unknownPhrases(limit = 50) {
  return db.prepare(`
    SELECT text, COUNT(*) AS n, MAX(created_at) AS last
      FROM office_events WHERE kind = 'unknown' AND text <> ''
     GROUP BY text ORDER BY n DESC, last DESC LIMIT ?`).all(limit);
}

module.exports = { attach, record, list, unknownPhrases, formatEvent, OFFICE };
