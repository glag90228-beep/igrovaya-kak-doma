'use strict';

/**
 * Откуда взялась сумма долга — по слагаемым.
 *
 *   cd /opt/trapeza && node tools/debt-audit.js            — только показать
 *   cd /opt/trapeza && node tools/debt-audit.js --fix      — убрать осиротевшие проводки
 *
 * Зачем. Жалоба с боевого сервера: «документы удалил, а сумма на главной
 * висит прежняя». Сумма складывается из трёх источников, и по экрану не
 * видно, какой именно её держит:
 *
 *   1) начальное сальдо в карточке контрагента — живёт само по себе и
 *      никакими документами не убирается;
 *   2) проводки, привязанные к документам (doc_id) — уходят вместе с ними;
 *   3) проводки, внесённые руками или из выписки — документа за ними нет
 *      и быть не должно.
 *
 * Бывает и четвёртое: проводка привязана к документу, а документа уже нет.
 * Такое оставляли старые версии бота, удалявшие документ без его проводок.
 * Убрать её из приложения нельзя — карточки-то нет, — и она держит долг
 * вечно. Ровно это и чинит --fix.
 *
 * Без --fix не меняет ничего. Перед --fix сделайте резервную копию:
 *   node backup.js
 */

const path = require('node:path');

const APP = path.join(__dirname, '..');
const { db } = require(path.join(APP, 'db'));
const bdb = require(path.join(APP, 'lib/bot-db'));
const { round2 } = require(path.join(APP, 'lib/money'));

const FIX = process.argv.includes('--fix');
const money = (n) => `${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('ru-RU')} ₽`;

/** Проводки, чей документ уже удалён. */
function orphans() {
  return db.prepare(`
    SELECT o.id, o.cp_id, o.date, o.kind, o.doc, o.debit, o.credit, o.doc_id,
           c.name AS cp_name, c.user_id AS user_id
      FROM operations o
      JOIN counterparties c ON c.id = o.cp_id
     WHERE o.doc_id IS NOT NULL AND o.doc_id > 0
       AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = o.doc_id)
     ORDER BY c.user_id, o.cp_id, o.date`).all();
}

const users = db.prepare('SELECT id, tg_id, name FROM bot_users ORDER BY id').all();
let totalOrphans = 0;

for (const u of users) {
  const cps = bdb.listCps(u.id);
  if (!cps.length) continue;
  console.log(`\n=== ${u.name || 'без имени'} (tg ${u.tg_id}) ===`);

  for (const cp of cps) {
    const b = bdb.balanceOf(u.id, cp.id);
    if (!b) continue;
    const ops = b.ops;
    const opening = round2(Number(cp.opening_balance) || 0);
    if (!ops.length && !opening) continue;

    const has = (id) => db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id);
    const linked = ops.filter((o) => o.doc_id && has(o.doc_id));
    const lost = ops.filter((o) => o.doc_id && !has(o.doc_id));
    const manual = ops.filter((o) => !o.doc_id);
    const sum = (list) => round2(list.reduce((s, o) => s + (Number(o.credit) || 0) - (Number(o.debit) || 0), 0));

    console.log(`\n  ${cp.name} — сальдо ${money(b.closing)}`);
    console.log(`    начальное сальдо из карточки : ${money(opening)}`);
    console.log(`    проводки живых документов    : ${money(sum(linked))}  (${linked.length} шт.)`);
    console.log(`    внесено руками и из выписки  : ${money(sum(manual))}  (${manual.length} шт.)`);
    if (lost.length) {
      console.log(`    ⚠ проводки удалённых документов: ${money(sum(lost))}  (${lost.length} шт.)`);
      for (const o of lost) {
        console.log(`        ${o.date}  ${o.kind}  ${o.doc}  ${money((o.credit || 0) - (o.debit || 0))}`);
      }
      totalOrphans += lost.length;
    }
  }
}

const lostAll = orphans();
console.log(`\n${'='.repeat(58)}`);
if (!lostAll.length) {
  console.log('Осиротевших проводок нет: каждая привязанная проводка имеет свой документ.');
  process.exit(0);
}

const lostSum = round2(lostAll.reduce((s, o) => s + (Number(o.credit) || 0) - (Number(o.debit) || 0), 0));
console.log(`Осиротевших проводок: ${lostAll.length}, они держат ${money(lostSum)}.`);

if (!FIX) {
  console.log('\nНичего не менял. Чтобы убрать их:');
  console.log('  node backup.js            # сначала копия базы');
  console.log('  node tools/debt-audit.js --fix');
  process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
try {
  const del = db.prepare('DELETE FROM operations WHERE id = ?');
  for (const o of lostAll) del.run(o.id);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.log('Не смог убрать, база не тронута:', e.message);
  process.exit(1);
}
console.log(`\n✅ Убрано проводок: ${lostAll.length}. Долг уменьшился на ${money(lostSum)}.`);
console.log('Перезапускать службы не нужно — они читают ту же базу.');
