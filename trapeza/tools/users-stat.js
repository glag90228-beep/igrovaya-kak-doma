// Кто пользуется «Первичкой» — сводка по боевой базе.
//
// Читает только на чтение, ничего не меняет. Запускать на сервере:
//   node /opt/trapeza/tools/users-stat.js

const { DatabaseSync } = require('node:sqlite');

const FILE = process.env.TRAPEZA_DB || '/opt/trapeza/data/trapeza.db';

/*
 * Ошибки объясняем словами, а не трассировкой.
 *
 * Команду набирают на боевом сервере, часто впервые и по подсказке из чата.
 * Ошибиться тут проще всего тремя способами: не тот путь, не тот сервер и
 * запуск не от того пользователя. На каждый Node выдавал «ERR_SQLITE_ERROR,
 * errcode 14» и десять строк стека — по ним человек не поймёт ничего и решит,
 * что сломалась программа.
 *
 * Про права стоит сказать отдельно: readOnly не отменяет записи в КАТАЛОГ —
 * база живёт в режиме WAL, и SQLite всё равно открывает рядом файлы -wal и
 * -shm. Поэтому «нет прав» здесь означает права на папку, а не на сам файл.
 */
let db;
try {
  db = new DatabaseSync(FILE, { readOnly: true });
} catch (e) {
  const why = /unable to open/i.test(e.message)
    ? `не удалось открыть ${FILE}.\n\n`
      + 'Либо файла нет — проверьте путь (задать другой: TRAPEZA_DB=/путь/к.db),\n'
      + 'либо нет прав на его папку: база в режиме WAL, и SQLite пишет рядом\n'
      + 'служебные файлы даже при чтении. Запустите от того же пользователя,\n'
      + 'под которым работает бот.'
    : e.message;
  console.error(`\nНе получилось: ${why}\n`);
  process.exit(1);
}

const one = (sql, ...a) => {
  try {
    return Object.values(db.prepare(sql).get(...a) || {})[0] || 0;
  } catch (e) {
    // Таблиц нет — это не поломка, а пустая база: бот их заводит при первом
    // запуске. Считаем такую метрику нулём и идём дальше, а не падаем.
    if (/no such table/i.test(e.message)) return 0;
    throw e;
  }
};

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
