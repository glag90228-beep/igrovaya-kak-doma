'use strict';

/**
 * Резервная копия базы.
 *
 *   node backup.js            — снять копию и убрать старые
 *   node backup.js --list     — что уже есть
 *
 * Почему не «скопировать файл». База живая: бот в этот момент может писать,
 * и обычный cp даст файл, порванный посередине транзакции — такую копию
 * замечаешь только когда она понадобилась. Здесь используется VACUUM INTO:
 * SQLite сам делает согласованный снимок, не останавливая работу, и заодно
 * сжимает базу, выбрасывая пустые страницы.
 *
 * Копия ещё и пакуется gzip: база это текст и повторяющиеся структуры,
 * сжимается в несколько раз, а места на маленьком сервере мало.
 *
 * Отдельно можно включить отправку копии в Telegram владельцу
 * (BACKUP_TO_TELEGRAM=1) — тогда файл уезжает с сервера, и авария диска
 * перестаёт быть потерей данных. По умолчанию выключено: в копии лежат
 * данные клиентов, и решение отправлять их куда-либо принимает владелец.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const { db, DB_FILE } = require('./db');

const DIR = process.env.BACKUP_DIR || '/var/backups/trapeza';
const KEEP_DAYS = Number(process.env.BACKUP_KEEP || 14);
const NAME = /^trapeza-\d{4}-\d{2}-\d{2}-\d{4}\.db\.gz$/;

const human = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`);

function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Список копий, свежие сверху.
 *
 * Поля переписываем руками, а не через «...fs.statSync(full)»: у объекта
 * fs.Stats время это вычисляемое свойство прототипа, и при раскладывании
 * оно теряется — остаются только size и mtimeMs. Один раз уже наступили.
 */
function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter((f) => NAME.test(f))
    .map((f) => {
      const full = path.join(DIR, f);
      const st = fs.statSync(full);
      return { name: f, full, size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Снимает копию. @returns {Promise<{file:string, size:number}>}
 *
 * Два правила, которых раньше не было.
 *
 * Права — только владельцу. В копии вся база: клиенты, документы, почтовые
 * ящики. Файлы создавались по umask, то есть обычно 0644, и читать их мог
 * любой пользователь сервера. Теперь каталог 0700, файлы 0600.
 *
 * Готовое имя — только готовой копии. Архив писался сразу под итоговым
 * именем, и оборванная запись (кончилось место, процесс убили) выглядела
 * полноценной копией: попадала в «последние три», которые prune не трогает,
 * и вытесняла хорошую. Теперь пишем во временный файл и переименовываем,
 * когда он дописан и сброшен на диск.
 */
async function makeBackup() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DIR, 0o700);        // каталог мог существовать с прежними правами
  const raw = path.join(DIR, `.tmp-${process.pid}.db`);
  const part = path.join(DIR, `.tmp-${process.pid}.db.gz`);
  const file = path.join(DIR, `trapeza-${stamp()}.db.gz`);
  for (const f of [raw, part]) if (fs.existsSync(f)) fs.unlinkSync(f);

  // VACUUM INTO создаёт файл сам, по umask процесса, — сужаем её на время.
  const umask = process.umask(0o077);
  try {
    // Согласованный снимок живой базы. Кавычки удваиваем: путь идёт в SQL.
    db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
    await pipeline(
      fs.createReadStream(raw),
      zlib.createGzip({ level: 9 }),
      fs.createWriteStream(part, { mode: 0o600 }),
    );
    const fd = fs.openSync(part, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(part, file);
  } finally {
    process.umask(umask);
    for (const f of [raw, part]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  return { file, size: fs.statSync(file).size };
}

/** Убирает копии старше KEEP_DAYS, но последние три не трогает никогда. */
function prune() {
  const all = list();
  const edge = Date.now() - KEEP_DAYS * 86400000;
  const removed = [];
  // Последние три оставляем при любых настройках: если бот молчал месяц,
  // «старые» копии — единственное, что есть, и удалять их нельзя.
  for (const f of all.slice(3)) {
    if (f.mtimeMs < edge) { fs.unlinkSync(f.full); removed.push(f.name); }
  }
  return removed;
}

/** Отправка копии владельцу в Telegram — если включено и есть кому. */
async function sendToOwner(file) {
  if (String(process.env.BACKUP_TO_TELEGRAM || '') !== '1') return '';
  const chat = process.env.SUPPORT_CHAT_ID;
  if (!chat || !process.env.BOT_TOKEN) return 'не задан SUPPORT_CHAT_ID или BOT_TOKEN';
  const { Telegram } = require('./lib/tg');
  const tg = new Telegram(process.env.BOT_TOKEN);
  const buffer = fs.readFileSync(file);
  if (buffer.length > 45 * 1024 * 1024) return 'копия крупнее 45 МБ — Telegram её не примет';
  try {
    await tg.sendDocument(chat, {
      filename: path.basename(file),
      buffer,
      caption: `Резервная копия базы «Первичка» от ${new Date().toLocaleString('ru-RU')}.`,
    });
    return 'отправлена в Telegram';
  } catch (e) {
    return `не отправилась: ${e.message}`;
  }
}

/** Строка списка: «имя  размер  когда снята». */
function listLine(f) {
  const when = f.mtime instanceof Date ? f.mtime.toLocaleString('ru-RU') : '';
  return `  ${f.name}  ${human(f.size).padStart(8)}  ${when}`;
}

function showList() {
  const all = list();
  if (!all.length) { console.log(`Копий нет (${DIR}).`); return; }
  console.log(`Копии в ${DIR}:`);
  for (const f of all) console.log(listLine(f));
  console.log(`\nВсего: ${all.length}, места занято ${human(all.reduce((s, f) => s + f.size, 0))}`);
}

async function main() {
  // Сообщение об ошибке должно называть то, что не получилось: «копия не
  // снялась» при простом просмотре списка отправляет искать поломку не там.
  if (process.argv.includes('--list')) {
    try { showList(); } catch (e) {
      console.error('Список копий не читается:', e.message);
      process.exitCode = 1;
    }
    return;
  }

  const src = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0;
  const { file, size } = await makeBackup();
  console.log(`Копия: ${file}`);
  console.log(`База ${human(src)} → архив ${human(size)}`);

  const removed = prune();
  if (removed.length) console.log(`Убрал старых копий: ${removed.length} (храним ${KEEP_DAYS} дней)`);

  const sent = await sendToOwner(file);
  if (sent) console.log(`Отправка владельцу: ${sent}`);

  console.log(`Всего копий: ${list().length}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('Копия не снялась:', e.message); process.exit(1); });
}

module.exports = { makeBackup, prune, list, listLine, DIR };
