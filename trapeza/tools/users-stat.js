// Кто пользуется «Первичкой» — сводка по боевой базе.
//
// Читает только на чтение, ничего не меняет. Запускать на сервере:
//   node /opt/trapeza/tools/users-stat.js

const { DatabaseSync } = require('node:sqlite');

const FILE = process.env.TRAPEZA_DB || '/opt/trapeza/data/trapeza.db';
const db = new DatabaseSync(FILE, { readOnly: true });
const one = (sql, ...a) => Object.values(db.prepare(sql).get(...a) || {})[0] || 0;

// «Сегодня» по Москве: база живёт по этому календарю, и считать по UTC
// значило бы на границе суток получать не тот день.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
const ago = (days) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

const all = one('SELECT COUNT(*) FROM bot_users');
const paid = one('SELECT COUNT(*) FROM bot_users WHERE access_until >= ?', today);
const blocked = one("SELECT COUNT(*) FROM bot_users WHERE blocked_at <> ''");
const withOrg = one('SELECT COUNT(DISTINCT user_id) FROM orgs');
const withDoc = one('SELECT COUNT(DISTINCT user_id) FROM documents');
const docs = one('SELECT COUNT(*) FROM documents');

const newIn = (days) => one('SELECT COUNT(*) FROM bot_users WHERE substr(created_at,1,10) >= ?', ago(days));
const activeIn = (days) => one(
  'SELECT COUNT(DISTINCT user_id) FROM documents WHERE date >= ?', ago(days),
);

const line = (name, value, note = '') => console.log(`  ${name.padEnd(34)} ${String(value).padStart(5)}${note}`);

console.log(`\nБаза: ${FILE}\n`);
console.log('ЛЮДИ');
line('запускали бота', all);
line('заполнили реквизиты', withOrg, all ? `  ${Math.round((withOrg / all) * 100)}%` : '');
line('выписали хотя бы один документ', withDoc, all ? `  ${Math.round((withDoc / all) * 100)}%` : '');
line('с оплаченным доступом', paid);
line('заблокировали бота', blocked);

console.log('\nПРИШЛИ');
line('за последние 7 дней', newIn(7));
line('за последние 30 дней', newIn(30));

console.log('\nРАБОТАЮТ (выписывали документы)');
line('за последние 7 дней', activeIn(7));
line('за последние 30 дней', activeIn(30));

console.log('\nДОКУМЕНТЫ');
line('всего выписано', docs);
line('за последние 30 дней', one('SELECT COUNT(*) FROM documents WHERE date >= ?', ago(30)));

/*
 * Разница между «запускали» и «выписали хотя бы один» — самое полезное число
 * здесь. Первое считает всех, кто нажал «Начать» и ушёл; второе — тех, для
 * кого продукт что-то сделал. Судить по первому — обманывать себя.
 */
console.log('');
db.close();
