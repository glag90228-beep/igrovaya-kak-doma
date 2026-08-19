'use strict';

/**
 * Всё ли на месте в базе после обновления.
 *
 * Зачем. Таблицы и колонки создаются миграцией при первом запуске бота.
 * Если служба поднялась, но миграция не прошла, узнать об этом можно только
 * по жалобе клиента: экран открывается, а кнопка отвечает ошибкой. Один раз
 * так и вышло — колонку orgs.biz_type дописывали скриптом поверх файлов,
 * скрипт молча ничего не сделал, и понять это было неоткуда.
 *
 *   cd /opt/trapeza && node tools/schema-check.js
 *
 * Ничего не меняет — только смотрит. Возвращает код 1, если чего-то нет.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const APP = path.join(__dirname, '..');

function envValue(name) {
  const file = path.join(APP, '.env');
  if (!fs.existsSync(file)) return '';
  const found = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => new RegExp(`^${name}=(.*)$`).exec(l.trim()))
    .filter(Boolean)
    .map((m) => m[1].trim());
  return found.pop() || '';                 // повторы: читается последний
}

const dbPath = process.env.TRAPEZA_DB || envValue('TRAPEZA_DB') || path.join(APP, 'data', 'trapeza.db');
if (!fs.existsSync(dbPath)) {
  console.log(`❌ Базы нет: ${dbPath}`);
  process.exit(1);
}

// На чтение, а при неудаче обычным способом: у живой базы в режиме WAL
// открытие только на чтение проходит не всегда.
let db;
try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (_) { db = new DatabaseSync(dbPath); }

/*
 * Что должно быть. Список ведётся руками намеренно: он описывает не то, что
 * создаёт код прямо сейчас, а то, без чего продукт не работает, — и поэтому
 * ловит как раз пропавшую миграцию, а не повторяет её.
 */
const TABLES = {
  bot_users: ['blocked_at', 'access_until', 'state', 'state_data'],
  orgs: ['debt_basis', 'vat_rate', 'vat_gross', 'ogrnip', 'biz_type'],
  counterparties: ['user_id', 'email', 'bank_name', 'bik', 'acc', 'corr_acc'],
  operations: ['doc_id'],
  documents: ['paid_at', 'seq', 'year', 'payload'],
  item_templates: [],
  bank_imports: ['key', 'op_id'],
  recurring: ['cp_id', 'type', 'day', 'items', 'extra', 'last_offer', 'active'],
};

// Эти таблицы заводят свои модули при первом обращении: почта, оплаты,
// свободный ввод. Их отсутствие — не поломка, просто ими ещё не пользовались.
const LAZY = { mailboxes: 'почта', promo_codes: 'коды доступа', ai_usage: 'свободный ввод' };

const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
let bad = 0;

console.log(`База: ${dbPath}\n`);
for (const [table, columns] of Object.entries(TABLES)) {
  if (!have.has(table)) {
    console.log(`  ❌ нет таблицы ${table}`);
    bad += 1;
    continue;
  }
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const missing = columns.filter((c) => !cols.has(c));
  if (missing.length) {
    console.log(`  ❌ ${table}: нет колонок — ${missing.join(', ')}`);
    bad += 1;
  } else {
    console.log(`  ✅ ${table}`);
  }
}

console.log('');
for (const [table, what] of Object.entries(LAZY)) {
  console.log(`  ${have.has(table) ? '·' : '○'} ${table} — ${what}${have.has(table) ? '' : ' (ещё не заводили)'}`);
}

const rows = (t) => (have.has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0);
console.log(`\nПользователей: ${rows('bot_users')} · документов: ${rows('documents')}`
  + ` · контрагентов: ${rows('counterparties')} · повторений: ${rows('recurring')}`);

/*
 * Проводки, чей документ уже удалён.
 *
 * Схема при этом целая, а долг у контрагента держится вечно: убрать такую
 * проводку из приложения нельзя — карточки документа нет. Оставляли старые
 * версии бота, удалявшие документ без его проводок. Проверяем здесь, чтобы
 * это всплывало на обычной проверке после обновления, а не через месяц
 * жалобой «сумма висит, а документов нет».
 */
if (have.has('operations') && have.has('documents')) {
  const lost = db.prepare(`
    SELECT COUNT(*) AS n, ROUND(SUM(COALESCE(credit,0) - COALESCE(debit,0)), 2) AS sum
      FROM operations o
     WHERE o.doc_id IS NOT NULL AND o.doc_id > 0
       AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = o.doc_id)`).get();
  if (lost.n) {
    console.log(`\n⚠ Проводок без документа: ${lost.n} на ${lost.sum} ₽.`);
    console.log('  Они держат долг, которого уже нет. Разбор и починка:');
    console.log('    node tools/debt-audit.js          # показать, откуда сумма');
    console.log('    node backup.js && node tools/debt-audit.js --fix');
  } else {
    console.log('\n✅ Проводки без документов не найдены.');
  }
}

console.log(bad ? `\n❌ Не хватает: ${bad}. Миграция не прошла — смотрите лог бота.`
  : '\n✅ Схема в порядке.');
process.exit(bad ? 1 : 0);
