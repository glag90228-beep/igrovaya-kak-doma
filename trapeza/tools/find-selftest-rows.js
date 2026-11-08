'use strict';

/**
 * Следы самотеста в базе. Только читает, ничего не меняет.
 *
 *   node tools/find-selftest-rows.js
 *   TRAPEZA_DB=/путь/к/базе node tools/find-selftest-rows.js
 *
 * Зачем это понадобилось. Путь к базе лежит в .env рядом с ключами, и
 * достаточно один раз выполнить `set -a && . ./.env`, чтобы TRAPEZA_DB
 * остался в оболочке. Запущенный следом `npm test` тогда идёт по живой базе
 * клиентов и заводит там своих пользователей, организации и документы.
 * Заслонка в selftest-db.js теперь это ловит, но базам, которые успели
 * пострадать раньше, нужна сверка — и она здесь.
 *
 * Улика — номер в Telegram: у прогонов они заданы константами, и живых
 * людей с такими не бывает.
 */

const { DatabaseSync } = require('node:sqlite');
const DB = process.env.TRAPEZA_DB || '/opt/trapeza/data/trapeza.db';
const db = new DatabaseSync(DB, { readOnly: true });
const q = (s, ...a) => db.prepare(s).all(...a);

const TEST_TG = [500101, 500202, 500303, 500404, 500505, 515151,
  777001, 777002, 777045, 778001, 779042, 779043, 779050, 779060, 779070,
  779080, 779081, 779082, 880101, 880202, 880303, 909090, 979001,
  999001, 999002, 999003, 999004, 999005, 999006, 999007];

const hit = q(`SELECT id, tg_id, name, created_at FROM bot_users
               WHERE tg_id IN (${TEST_TG.join(',')})`);

console.log('=== ГЛАВНОЕ ===');
if (!hit.length) {
  console.log('Тестовых пользователей в базе НЕТ — прогон в неё не писал. ✅');
} else {
  console.log(`НАЙДЕНО ${hit.length} тестовых пользователей — прогон писал в базу:`);
  for (const u of hit) {
    const docs = q('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?', u.id)[0].n;
    const orgs = q('SELECT COUNT(*) AS n FROM orgs WHERE user_id = ?', u.id)[0].n;
    console.log(`  id=${u.id}  tg=${u.tg_id}  «${u.name}»  ${u.created_at}`
      + `  организаций ${orgs}  документов ${docs}`);
  }
}

console.log('\n=== кто заведён за сутки ===');
const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const fresh = q('SELECT tg_id, name, created_at FROM bot_users WHERE created_at >= ? ORDER BY id', day);
console.log(`всего ${fresh.length}`);
for (const u of fresh) console.log(`  ${u.tg_id}  ${u.created_at}  ${u.name || '(без имени)'}`);

console.log('\n=== документы за сутки ===');
for (const d of q(`SELECT id, user_id, type, number, created_at FROM documents
                   WHERE created_at >= ? ORDER BY id`, day)) {
  console.log(`  ${d.id}  user=${d.user_id}  ${d.type}  № ${d.number}  ${d.created_at}`);
}

console.log('\n=== контрагенты, похожие на тестовые ===');
const cps = q(`SELECT id, name FROM counterparties
  WHERE name LIKE '%Заря%' OR name LIKE '%Ромашк%' OR name LIKE '%Тюльпан%'
     OR name LIKE '%Клиент%' OR name LIKE '%Лимит%'`);
console.log(cps.length ? cps.map((c) => `  ${c.id}  ${c.name}`).join('\n') : '  нет');

console.log('\n=== всего в базе ===');
for (const t of ['bot_users', 'orgs', 'documents', 'counterparties', 'operations']) {
  console.log(`  ${t.padEnd(15)} ${q(`SELECT COUNT(*) AS n FROM ${t}`)[0].n}`);
}
