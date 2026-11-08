'use strict';

/**
 * Утренняя сводка «кто вам должен» и журнал напоминаний должникам.
 *
 * Зачем. Долги в боте видны, только если зайти и спросить. А деньги
 * теряются ровно тогда, когда про них забыли: клиент «тянет», ИП
 * стесняется напомнить, через месяц неудобно уже обоим. Сводка приходит
 * сама, в 9 утра по Москве, с кнопками «напомнить» и «оплатил» — одно
 * нажатие вместо поиска по меню. Так делают FreshBooks и Wave, и именно
 * этого не хватает в Эльбе: там напоминания про налоги, а не про клиентов.
 *
 * Чтобы не стать спамом:
 *   — не шлём, если никто не должен;
 *   — не шлём, если сумма не изменилась и с прошлой сводки не прошло трёх дней;
 *   — «🔕 Не присылать» прямо под сводкой, вернуть — в настройках;
 *   — отметка «отправлено сегодня» — в базе, перезапуск бота не дублирует.
 *
 * Сводка только для владельца. Клиентам бот ничего не пишет: напоминание
 * должнику уходит лишь по нажатию человека.
 */

const { db } = require('../db');
const bdb = require('./bot-db');
const cheques = require('./cheques');
const { todayISO } = require('./period');

function migrate() {
  const cols = db.prepare('PRAGMA table_info(bot_users)').all().map((c) => c.name);
  if (!cols.includes('digest_on')) db.exec('ALTER TABLE bot_users ADD COLUMN digest_on INTEGER NOT NULL DEFAULT 1');
  if (!cols.includes('digest_at')) db.exec("ALTER TABLE bot_users ADD COLUMN digest_at TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('digest_total')) db.exec('ALTER TABLE bot_users ADD COLUMN digest_total REAL NOT NULL DEFAULT -1');
  db.exec(`
    CREATE TABLE IF NOT EXISTS debt_reminders (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cp_id   INTEGER NOT NULL,
      tone    TEXT    NOT NULL DEFAULT '',
      via     TEXT    NOT NULL DEFAULT '',   -- text | mail
      at      TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_debt_rem ON debt_reminders(user_id, cp_id, at);
  `);
}
migrate();

const isOn = (userId) => {
  const u = db.prepare('SELECT digest_on FROM bot_users WHERE id = ?').get(userId);
  return u ? u.digest_on !== 0 : true;
};
const setOn = (userId, on) => {
  db.prepare('UPDATE bot_users SET digest_on = ? WHERE id = ?').run(on ? 1 : 0, userId);
  return Boolean(on);
};

function logReminder(userId, cpId, { tone = '', via = 'text' } = {}) {
  db.prepare('INSERT INTO debt_reminders(user_id, cp_id, tone, via, at) VALUES(?,?,?,?,?)')
    .run(userId, cpId, tone, via, new Date().toISOString());
}

/** Сколько дней назад напоминали этому клиенту, или null. */
function lastReminded(userId, cpId, now = new Date()) {
  const r = db.prepare('SELECT at FROM debt_reminders WHERE user_id = ? AND cp_id = ? ORDER BY id DESC LIMIT 1')
    .get(userId, cpId);
  if (!r) return null;
  return Math.max(0, Math.floor((now - new Date(r.at)) / 86400000));
}

const rub = (n) => `${Math.round(Number(n) || 0).toLocaleString('ru-RU')} ₽`;
const days = (n) => {
  const a = n % 100; const b = n % 10;
  const w = a > 10 && a < 20 ? 'дней' : b === 1 ? 'день' : b > 1 && b < 5 ? 'дня' : 'дней';
  return `${n} ${w}`;
};

/**
 * Сводка для человека или null, если сказать нечего.
 * @returns {{text:string, rows:Array, total:number}|null}
 */
function build(userId, { force = false, today = todayISO(), now = new Date() } = {}) {
  const owe = bdb.debtors(userId).filter((r) => r.theyOwe).sort((a, b) => b.amount - a.amount);
  // Непробитые чеки самозанятого: срок по закону жёсткий, и вспоминать про них
  // надо без повода — даже когда должников нет и сводка иначе промолчала бы.
  const chq = cheques.open(userId);
  if (!owe.length && !chq.length) return null;
  const total = Math.round(owe.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  if (!force) {
    const u = db.prepare('SELECT digest_at, digest_total FROM bot_users WHERE id = ?').get(userId) || {};
    if (u.digest_at === today) return null;
    const gap = u.digest_at ? Math.floor((new Date(today) - new Date(u.digest_at)) / 86400000) : 99;
    // Чеки в «ту же сумму» не входят: срок у них свой, и три дня молчания —
    // уже много, поэтому с непробитым чеком сводку по сумме не гасим.
    if (!chq.length && Math.abs((u.digest_total || 0) - total) < 0.01 && gap < 3) return null;
  }
  const lines = owe.length
    ? [`☀️ <b>Доброе утро!</b> Вам должны <b>${rub(total)}</b>`
      + ` — ${owe.length} ${owe.length === 1 ? 'клиент' : owe.length < 5 ? 'клиента' : 'клиентов'}.`, '']
    : ['☀️ <b>Доброе утро!</b>', ''];
  for (const r of owe.slice(0, 5)) {
    const quiet = r.days != null && r.days > 0 ? ` · без оплаты ${days(r.days)}` : '';
    const rem = lastReminded(userId, r.cp.id, now);
    const remTxt = rem == null ? '' : rem === 0 ? ' · напоминали сегодня' : ` · напоминали ${days(rem)} назад`;
    lines.push(`• <b>${esc(r.cp.name)}</b> — ${rub(r.amount)}${quiet}${remTxt}`);
  }
  if (owe.length > 5) lines.push(`• и ещё ${owe.length - 5}`);
  if (chq.length) {
    const soon = chq[0].due;
    lines.push('', `🧾 <b>Чеки не пробиты: ${chq.length}</b> на ${cheques.rub(chq.reduce((a, c) => a + c.amount, 0))}`
      + (soon ? ` — ближайший срок ${soon.split('-').reverse().join('.')}.` : '.'));
  }
  const yesterday = new Date(new Date(today).getTime() - 86400000).toISOString().slice(0, 10);
  const made = bdb.listDocs(userId, 50).filter((d) => d.date === yesterday);
  if (made.length) {
    lines.push('', `Вчера выписано: ${made.length} ${made.length === 1 ? 'документ' : made.length < 5 ? 'документа' : 'документов'}`
      + ` на ${rub(made.reduce((s, d) => s + (Number(d.total) || 0), 0))}.`);
  }
  const rows = owe.slice(0, 3).map((r) => ([
    { text: `✉️ Напомнить: ${r.cp.name}`.slice(0, 40), data: `rm.one:${r.cp.id}` },
    { text: '✅ Оплатил', data: `pay.cp:${r.cp.id}:${Math.round(r.amount * 100) / 100}:o:${require('node:crypto').randomBytes(4).toString('hex')}` },
  ]));
  if (chq.length) rows.push([{ text: '🧾 Чеки к пробитию', data: 'chq.list' }]);
  if (owe.length) rows.push([{ text: '📄 Акты сверки всем', data: 'debt.akts' }, { text: '🔕 Не присылать', data: 'dg.off' }]);
  else rows.push([{ text: '🔕 Не присылать', data: 'dg.off' }]);
  return { text: lines.join('\n'), rows, total };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function markSent(userId, total, today = todayISO()) {
  db.prepare('UPDATE bot_users SET digest_at = ?, digest_total = ? WHERE id = ?').run(today, total, userId);
}

/** Кому сегодня может уйти сводка: включена, бот не заблокирован, есть клиенты. */
function candidates(today = todayISO()) {
  return db.prepare(`
    SELECT u.id, u.tg_id FROM bot_users u
     WHERE u.digest_on = 1 AND u.blocked_at = '' AND u.digest_at <> ?
       AND EXISTS (SELECT 1 FROM counterparties c WHERE c.user_id = u.id)`).all(today);
}

/**
 * Разослать сводки. keyboard — из lib/tg; tg — клиент Telegram.
 * @returns {Promise<number>} сколько отправлено
 */
async function run(tg, keyboard, { today = todayISO() } = {}) {
  let sent = 0;
  for (const u of candidates(today)) {
    try {
      const d = build(u.id, { today });
      if (!d) continue;
      // eslint-disable-next-line no-await-in-loop
      await tg.sendMessage(u.tg_id, d.text, keyboard(d.rows));
      markSent(u.id, d.total, today);
      sent += 1;
    } catch (e) {
      // Заблокировал бота — дальше не пытаемся, остальным сводка уйдёт.
      if (e && e.blocked) bdb.markBlocked && bdb.markBlocked(u.id);
      console.error('утренняя сводка:', e && e.message);
    }
  }
  return sent;
}

/** 9 утра по Москве — пора ли? */
function isMorning(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).format(now));
  return h >= Number(process.env.DIGEST_HOUR || 9) && h < 21;
}

module.exports = { build, run, isOn, setOn, logReminder, lastReminded, markSent, candidates, isMorning };
