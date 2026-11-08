'use strict';

/**
 * Каким ключом зашифрованы пароли почтовых ящиков.
 *
 * Зачем это нужно. В .env может оказаться несколько строк MAIL_KEY —
 * дописанных при обновлениях, скопированных из подсказки, пустых из шаблона.
 * Читается последняя, а зашифровано могло быть любой из прежних, и тогда
 * бот честно говорит «пароль не читается», хотя ящик подключён.
 *
 * Скрипт перебирает все MAIL_KEY из .env (и запасной вариант — BOT_TOKEN)
 * и говорит, какой из них подходит. Пароли при этом никуда не выводятся:
 * печатается только длина расшифрованного значения.
 *
 *   cd /opt/trapeza && node tools/mail-key-check.js
 *
 * Ничего не меняет — только смотрит.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APP = path.join(__dirname, '..');
const ENV = path.join(APP, '.env');

/** Все значения переменной из .env, включая повторы, по порядку. */
function valuesOf(name) {
  if (!fs.existsSync(ENV)) return [];
  const out = [];
  for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = new RegExp(`^${name}=(.*)$`).exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** Та же схема, что в lib/crypto-box.js: scrypt по тому же материалу. */
const keyFrom = (material) => crypto.scryptSync(material, 'pervichka-mailbox', 32);

function open(sealed, k) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(parts[1], 'base64url'));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

const dbPath = valuesOf('TRAPEZA_DB').filter(Boolean).pop() || path.join(APP, 'data', 'trapeza.db');
if (!fs.existsSync(dbPath)) {
  console.log(`Базы нет по пути ${dbPath}. Проверьте TRAPEZA_DB в .env.`);
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
// Сначала только на чтение. У живой базы в режиме WAL такое открытие иногда
// не проходит — ей нужен доступ к служебному файлу -shm; тогда открываем
// обычным способом. Писать всё равно нечем: дальше только SELECT.
let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (_) {
  db = new DatabaseSync(dbPath);
}

let boxes = [];
try {
  boxes = db.prepare('SELECT user_id, login, pass_enc FROM mailboxes').all();
} catch (_) {
  console.log('Таблицы mailboxes нет — почтовые ящики ещё никто не подключал.');
  process.exit(0);
}
if (!boxes.length) {
  console.log('Подключённых ящиков нет — чистить .env можно свободно.');
  process.exit(0);
}

// Кандидаты: каждый MAIL_KEY из .env и запасной вариант из BOT_TOKEN.
const candidates = [];
valuesOf('MAIL_KEY').forEach((v, i) => {
  if (v) candidates.push({ label: `MAIL_KEY #${i + 1}: ${v.slice(0, 8)}…`, key: keyFrom(`k:${v}`), value: v });
});
const token = valuesOf('BOT_TOKEN').filter(Boolean).pop();
if (token) candidates.push({ label: 'запасной вариант из BOT_TOKEN', key: keyFrom(`t:${token}`), value: '' });

console.log(`Ящиков в базе: ${boxes.length}. Кандидатов в ключи: ${candidates.length}.\n`);

for (const box of boxes) {
  const hit = candidates.find((c) => open(box.pass_enc, c.key) != null);
  const who = `${box.login || '(без логина)'} (пользователь ${box.user_id})`;
  console.log(hit ? `  ✅ ${who} — подходит ${hit.label}` : `  ❌ ${who} — не подошёл ни один ключ`);
}

const working = candidates.filter((c) => boxes.some((b) => open(b.pass_enc, c.key) != null));
const lines = valuesOf('MAIL_KEY');
console.log('');

if (!working.length) {
  console.log('❌ Ни один ключ не подошёл: тот, которым шифровали, из .env уже пропал.');
  console.log('   Пароли придётся ввести заново — в боте «Почта» → подключить ящик.');
  process.exit(1);
}

/*
 * Главный вопрос — работает ли почта сейчас, а не «подходит ли хоть какой-то
 * ключ». Действующий ключ тот же, что возьмёт приложение: последняя непустая
 * строка MAIL_KEY, иначе запасной вариант из BOT_TOKEN.
 */
const effectiveValue = lines.filter(Boolean).pop() || '';
const effective = candidates.find((c) => c.value === effectiveValue);
const worksNow = effective && working.includes(effective);

if (!worksNow) {
  console.log('❌ Действующий ключ не тот: почта не работает прямо сейчас.');
  console.log('   Оставьте в .env одну строку — рабочую:');
  for (const w of working) console.log(`     MAIL_KEY=${w.value}`);
  process.exit(1);
}

// Советовать уже сделанное нельзя: инструмент, который так делает,
// перестают читать — и настоящую подсказку тоже пропустят.
if (lines.length > 1) {
  console.log(`Строк MAIL_KEY в .env: ${lines.length}, читается последняя, и она рабочая.`);
  console.log('Почта работает; лишние строки можно убрать для порядка, оставив:');
  console.log(`  MAIL_KEY=${effectiveValue}`);
} else if (!effectiveValue) {
  console.log('✅ Почта работает. Ключ отдельно не задан — он выведен из BOT_TOKEN.');
  console.log('   Учтите: при смене токена бота пароли ящиков перестанут читаться.');
  console.log('   Чтобы отвязаться, задайте свой MAIL_KEY и подключите ящик заново.');
} else {
  console.log('✅ Почта работает, в .env один MAIL_KEY — чистить нечего.');
}
