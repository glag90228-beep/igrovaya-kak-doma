'use strict';

/**
 * Убрать из базы следы самотеста.
 *
 *   node tools/clean-selftest.js            — показать, что будет удалено
 *   node tools/clean-selftest.js --delete   — удалить
 *
 * Перед удалением снимите копию: `node backup.js`. Обычный cp живую базу
 * рвёт посередине транзакции, а backup.js делает согласованный снимок.
 *
 * Трогает ровно тех пользователей, чей tg_id принадлежит прогонам. Живых
 * людей с такими номерами не бывает: они заданы в самотестах константами.
 *
 * Порядок удаления не произвольный. Операции и сальдо привязаны не к
 * пользователю, а к контрагенту и организации: удалив пользователя первым,
 * мы оставили бы их висеть без хозяина. Поэтому сначала собираем, какие
 * организации и контрагенты ему принадлежат, и только потом идём сверху вниз.
 */

const DB = process.env.TRAPEZA_DB || '/opt/trapeza/data/trapeza.db';
const DO = process.argv.includes('--delete');

const TEST_TG = [500101, 500202, 500303, 500404, 500505, 515151,
  777001, 777002, 777045, 778001, 779042, 779043, 779050, 779060, 779070,
  779080, 779081, 779082, 880101, 880202, 880303, 909090, 979001,
  999001, 999002, 999003, 999004, 999005, 999006, 999007];

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 5000');

const users = db.prepare(
  `SELECT id, tg_id, name FROM bot_users WHERE tg_id IN (${TEST_TG.join(',')})`,
).all();

if (!users.length) {
  console.log('Следов прогона нет — убирать нечего.');
  process.exit(0);
}

const uids = users.map((u) => u.id);
const inU = uids.join(',');
const orgIds = db.prepare(`SELECT id FROM orgs WHERE user_id IN (${inU})`).all().map((r) => r.id);
const cpIds = db.prepare(`SELECT id FROM counterparties WHERE user_id IN (${inU})`).all().map((r) => r.id);
const inO = orgIds.length ? orgIds.join(',') : '-1';
const inC = cpIds.length ? cpIds.join(',') : '-1';

console.log('Пользователи прогона:');
for (const u of users) console.log(`  id=${u.id}  tg=${u.tg_id}  «${u.name}»`);
console.log(`Их организаций: ${orgIds.length}, контрагентов: ${cpIds.length}\n`);

/*
 * Сверху вниз: сначала то, что ссылается, потом то, на что ссылаются.
 * operations и cp_openings идут по организации и контрагенту — у них своего
 * user_id нет.
 */
const STEPS = [
  ['doc_links', `DELETE FROM doc_links WHERE user_id IN (${inU})`],
  ['operations', `DELETE FROM operations WHERE org_id IN (${inO}) OR cp_id IN (${inC})`],
  ['cp_openings', `DELETE FROM cp_openings WHERE org_id IN (${inO}) OR cp_id IN (${inC})`],
  ['bank_imports', `DELETE FROM bank_imports WHERE user_id IN (${inU})`],
  ['documents', `DELETE FROM documents WHERE user_id IN (${inU})`],
  ['recurring', `DELETE FROM recurring WHERE user_id IN (${inU})`],
  ['item_templates', `DELETE FROM item_templates WHERE user_id IN (${inU})`],
  ['ai_messages', `DELETE FROM ai_messages WHERE user_id IN (${inU})`],
  ['ai_usage', `DELETE FROM ai_usage WHERE user_id IN (${inU})`],
  ['office_events', `DELETE FROM office_events WHERE user_id IN (${inU})`],
  ['facsimile', `DELETE FROM facsimile WHERE user_id IN (${inU})`],
  ['mailboxes', `DELETE FROM mailboxes WHERE user_id IN (${inU})`],
  ['pay_claims', `DELETE FROM pay_claims WHERE user_id IN (${inU})`],
  ['payments', `DELETE FROM payments WHERE user_id IN (${inU})`],
  ['promo_uses', `DELETE FROM promo_uses WHERE user_id IN (${inU})`],
  ['counterparties', `DELETE FROM counterparties WHERE user_id IN (${inU})`],
  ['orgs', `DELETE FROM orgs WHERE user_id IN (${inU})`],
  ['bot_users', `DELETE FROM bot_users WHERE id IN (${inU})`],
];

// Сколько строк заденет каждый шаг: то же условие, но SELECT COUNT(*).
const countOf = (sql) => {
  const m = /^DELETE FROM (\w+)(?: WHERE (.+))?$/s.exec(sql);
  const where = m[2] ? ` WHERE ${m[2]}` : '';
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${m[1]}${where}`).get().n; }
  catch (e) { return `таблицы нет (${e.code || 'ошибка'})`; }
};

let total = 0;
console.log(DO ? 'Удаляю:' : 'Будет удалено (это только показ, ничего не меняется):');
if (DO) db.exec('BEGIN');
try {
  for (const [name, sql] of STEPS) {
    const before = countOf(sql);
    if (typeof before !== 'number') { console.log(`  ${name.padEnd(16)} ${before}`); continue; }
    if (DO && before > 0) db.prepare(sql).run();
    if (before > 0) console.log(`  ${name.padEnd(16)} ${before}`);
    if (typeof before === 'number') total += before;
  }
  if (DO) db.exec('COMMIT');
} catch (e) {
  if (DO) db.exec('ROLLBACK');
  console.error('\n⛔ Не получилось, база не изменена:', e.message);
  process.exit(1);
}

console.log(`\nВсего строк: ${total}`);
if (!DO) console.log('Чтобы удалить: node tools/clean-selftest.js --delete');
else console.log('Готово. Сверка: node tools/find-selftest-rows.js');
