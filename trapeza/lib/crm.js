'use strict';

/**
 * Минимум CRM в карточке клиента: история, заметки, «напомнить мне».
 *
 * Зачем. Из amoCRM и Битрикс24 ИП уходят с одной и той же жалобой:
 * «дорого и перегружено» — воронки, роли, телефония. А нужно им три вещи:
 * видеть всё по клиенту в одном месте, записать «договорились на пятницу»
 * и не забыть перезвонить. Документы и оплаты у нас уже есть — осталось
 * сложить их в одну ленту и добавить заметки с напоминаниями.
 *
 * Напоминание приходит самому человеку, не клиенту: бот по-прежнему никому
 * не пишет без нажатия.
 */

const { db } = require('../db');

db.exec(`
  CREATE TABLE IF NOT EXISTS cp_notes (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    cp_id   INTEGER NOT NULL,
    text    TEXT    NOT NULL,
    at      TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cp_notes ON cp_notes(user_id, cp_id);
  CREATE TABLE IF NOT EXISTS cp_followups (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    cp_id   INTEGER NOT NULL,
    due     TEXT    NOT NULL,             -- ГГГГ-ММ-ДД
    text    TEXT    NOT NULL,
    sent_at TEXT    NOT NULL DEFAULT '',
    done    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cp_fu_due ON cp_followups(done, due);
`);

function addNote(userId, cpId, text) {
  const t = String(text || '').trim().slice(0, 1000);
  if (!t) return 0;
  return Number(db.prepare('INSERT INTO cp_notes(user_id, cp_id, text, at) VALUES(?,?,?,?)')
    .run(userId, cpId, t, new Date().toISOString()).lastInsertRowid);
}

const plusDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n));
  return d.toISOString().slice(0, 10);
};

function addFollowup(userId, cpId, { today, days, text }) {
  const due = plusDays(today, Math.max(1, Math.min(365, Number(days) || 1)));
  const t = String(text || '').trim().slice(0, 300) || 'Связаться с клиентом';
  const id = Number(db.prepare('INSERT INTO cp_followups(user_id, cp_id, due, text) VALUES(?,?,?,?)')
    .run(userId, cpId, due, t).lastInsertRowid);
  return { id, due, text: t };
}

/** Напоминания, срок которых наступил и о которых ещё не писали. */
function dueFollowups(today) {
  return db.prepare(`
    SELECT f.*, u.tg_id, c.name AS cp_name FROM cp_followups f
      JOIN bot_users u ON u.id = f.user_id
      LEFT JOIN counterparties c ON c.id = f.cp_id AND c.user_id = f.user_id
     WHERE f.done = 0 AND f.sent_at = '' AND f.due <= ? AND u.blocked_at = ''`).all(today);
}

const markSent = (id) => db.prepare('UPDATE cp_followups SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), id);

function done(userId, id) {
  return db.prepare('UPDATE cp_followups SET done = 1 WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/** Отложить: новый срок, и напоминание снова в очереди. */
function snooze(userId, id, today, days = 3) {
  const f = db.prepare('SELECT due FROM cp_followups WHERE id = ? AND user_id = ? AND done = 0').get(id, userId);
  if (!f) return false;
  // От срока, если он ещё впереди: «через три дня» не должно оказаться раньше,
  // чем уже назначенное напоминание.
  const base = f.due > today ? f.due : today;
  return db.prepare("UPDATE cp_followups SET due = ?, sent_at = '' WHERE id = ? AND user_id = ? AND done = 0")
    .run(plusDays(base, days), id, userId).changes > 0;
}

function openFollowups(userId, cpId) {
  return db.prepare('SELECT * FROM cp_followups WHERE user_id = ? AND cp_id = ? AND done = 0 ORDER BY due')
    .all(userId, cpId);
}

/**
 * Лента клиента: документы, деньги, напоминания должнику, заметки — по
 * датам, свежие сверху.
 */
function timeline(userId, cpId, limit = 25) {
  const bdb = require('./bot-db');
  const items = [];
  for (const d of bdb.listDocs(userId, 200, cpId)) {
    items.push({ at: d.date, icon: d.paid_at ? '✅' : '📄',
      text: `${d.title} № ${d.number}${d.total ? ` — ${Math.round(d.total).toLocaleString('ru-RU')} ₽` : ''}${d.paid_at ? ' · оплачен' : ''}` });
  }
  const b = bdb.balanceOf(userId, cpId);
  for (const op of (b && b.ops) || []) {
    if (op.doc_id || op.docId) continue;   // проводка документа уже есть в ленте самим документом
    const sum = Number(op.debit || op.credit || 0);
    if (!sum) continue;
    items.push({ at: op.date, icon: '💰', text: `${op.kind || 'Операция'} — ${Math.round(sum).toLocaleString('ru-RU')} ₽` });
  }
  require('./digest');   // таблица напоминаний должникам заводится там
  for (const r of db.prepare('SELECT * FROM debt_reminders WHERE user_id = ? AND cp_id = ?').all(userId, cpId)) {
    items.push({ at: String(r.at).slice(0, 10), icon: '✉️', text: `Напоминание об оплате${r.via === 'mail' ? ' письмом' : ''}` });
  }
  for (const n of db.prepare('SELECT * FROM cp_notes WHERE user_id = ? AND cp_id = ?').all(userId, cpId)) {
    items.push({ at: String(n.at).slice(0, 10), icon: '📝', text: n.text });
  }
  items.sort((a, b2) => String(b2.at).localeCompare(String(a.at)));
  return items.slice(0, limit);
}

module.exports = { addNote, addFollowup, dueFollowups, markSent, done, snooze, openFollowups, timeline, plusDays };
