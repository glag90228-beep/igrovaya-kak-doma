'use strict';

/**
 * Прогон по следам адверсариального разбора.
 *
 *   node redteam-selftest.js
 *
 * Здесь собраны краевые случаи, которые ломали расчёты и документы. Каждый
 * тест писался на подтверждённой запуском дыре: сначала он падал, потом
 * чинился код. Держать их отдельно от остальных прогонов удобно тем, что
 * видно, какие именно атаки продукт уже переживает.
 *
 * Порядок — по тяжести последствий: сначала деньги, потом документ, потом
 * удобство.
 */

require('./selftest-db');   // своя база на прогон — до всего, что тянет db.js
const bdb = require('./lib/bot-db');
const period = require('./lib/period');
const { parseOp } = require('./bot');
const { round2, formatRub } = require('./lib/money');

let bad = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg + (cond || extra === undefined ? '' : ' → ' + extra));
  if (!cond) bad += 1;
};

let seq = 0;
function freshUser() {
  seq += 1;
  const u = bdb.getOrCreateUser(900000 + seq).id;
  const org = bdb.createOrg(u, { name: 'ИП Проверка', inn: '183209316119', signer: 'И. П.' });
  return { u, org };
}

// ---------- деньги ----------

console.log('\n=== Деньги ===');
{
  /*
   * Одна оплата — одна проводка.
   *
   * При основании «по счёту» долг создаёт счёт. Человек отмечает оплаченным
   * и счёт, и закрывающий его акт — обе суммы по 30 000, — и сальдо уходило
   * в минус: выходило, что это мы должны клиенту, который заплатил один раз.
   */
  const { u, org } = freshUser();
  bdb.updateOrg(u, org, { debt_basis: 'invoice' });
  const cp = bdb.createCp(u, { name: 'Клиент', kind: 'customer' });
  const sch = bdb.saveDoc(u, {
    orgId: org, cpId: cp, type: 'sch', number: '1', seq: 1, date: '2026-03-01', total: 30000, payload: {},
  });
  bdb.addOpForDoc(u, cp, { date: '2026-03-01', kind: 'Реализация', doc: 'Счёт 1', credit: 30000 }, sch);
  const usl = bdb.saveDoc(u, {
    orgId: org, cpId: cp, type: 'usl', number: '1', seq: 1, date: '2026-03-02', total: 30000, payload: {},
  });
  bdb.markPaid(u, sch, '2026-03-05');
  ok(bdb.balanceOf(u, cp).closing === 0, 'оплата счёта закрывает долг', bdb.balanceOf(u, cp).closing);
  bdb.markPaid(u, usl, '2026-04-05');
  ok(bdb.balanceOf(u, cp).closing === 0,
    'отметка акта не задваивает ту же оплату', bdb.balanceOf(u, cp).closing);
  ok(bdb.unpaidDocs(u).length === 0, 'при этом оба документа считаются оплаченными',
    bdb.unpaidDocs(u).length);
}

{
  // Разряды через пробел: «1 000» распадалось на «1» и «000», и в журнал
  // уходил один рубль вместо тысячи. Молча.
  ok(parseOp('15.06 приход 1 000').credit === 1000, 'разряды через пробел не теряются',
    parseOp('15.06 приход 1 000').credit);
  ok(parseOp('15.06 приход 1 000 000').credit === 1000000, 'и в миллионе тоже',
    parseOp('15.06 приход 1 000 000').credit);
  ok(parseOp('15.06 приход 12 345 678,90').credit === 12345678.9, 'вместе с копейками',
    parseOp('15.06 приход 12 345 678,90').credit);
  // Доли копейки в деньгах не существует, а заведомо невозможная сумма —
  // это опечатка, и лучше переспросить, чем занести.
  ok(parseOp('15.06 приход 12,345').credit === 12.35, 'копейки округляются',
    parseOp('15.06 приход 12,345').credit);
  ok(parseOp('15.06 приход 99999999999999999999') === null, 'невозможная сумма отвергнута');
}

{
  // Накопление ошибки округления: сто строк по копейке должны дать рубль.
  const { u } = freshUser();
  const cp = bdb.createCp(u, { name: 'Копейки', kind: 'customer' });
  for (let i = 0; i < 100; i += 1) {
    bdb.addOp(u, cp, { date: '2026-05-01', kind: 'Приход', doc: `${i}`, credit: 0.01 });
  }
  const b = bdb.balanceOf(u, cp);
  ok(b.closing === 1, 'сто копеек складываются ровно в рубль', b.closing);
  ok(round2(0.1 + 0.2) === 0.3, 'round2 гасит двоичную погрешность', round2(0.1 + 0.2));
}

// ---------- даты ----------

console.log('\n=== Даты ===');
{
  /*
   * Несуществующая дата — опечатка, а не «сегодня» и не 31 февраля.
   *
   * Раньше «31.02.2026 приход 94193» заносилось с датой 2026-02-31 и вело
   * себя дико: в карточке сумма есть, а в акт за февраль операция попадала
   * или нет в зависимости от сравнения строк. «45.99.2026» пропадало из
   * всех актов вовсе, оставаясь в сальдо карточки, — то есть карточка и
   * акт сверки показывали разные цифры.
   */
  ok(parseOp('31.02.2026 приход 94193') === null, '31 февраля не принимается');
  ok(parseOp('31.04.2026 приход 700') === null, '31 апреля тоже');
  ok(parseOp('45.99.2026 оплата 1000') === null, 'мусор вместо даты не принимается');
  ok(parseOp('29.02.2025 приход 500') === null, '29 февраля в невисокосный год');
  ok(parseOp('29.02.2024 приход 500').date === '2024-02-29', 'а в високосный — принимается',
    parseOp('29.02.2024 приход 500').date);
  ok(period.parseDay('31.02.2026') === null, 'разбор даты один на весь проект');
}

{
  // Перевёрнутый период не должен врать: если конец раньше начала, внутрь
  // не попадает ничего, и это честнее, чем молча поменять их местами.
  const { u } = freshUser();
  const cp = bdb.createCp(u, {
    name: 'Период', kind: 'customer', opening_balance: 10000, opening_date: '2026-01-01',
  });
  bdb.addOp(u, cp, { date: '2026-02-10', kind: 'Приход', doc: 'x', credit: 5000 });
  const back = bdb.periodBalance(u, cp, '2026-03-01', '2026-01-31');
  ok(back.ops.length === 0, 'в перевёрнутом периоде операций нет', back.ops.length);
  ok(back.opening === back.closing, 'и сальдо не меняется', `${back.opening} → ${back.closing}`);

  const one = bdb.periodBalance(u, cp, '2026-02-10', '2026-02-10');
  ok(one.ops.length === 1, 'период в один день включает операцию этого дня', one.ops.length);
}

// ---------- документы ----------

console.log('\n=== Документы ===');
{
  /*
   * Акты всем должникам отвечали 500 с самого своего появления: в функцию
   * передавали row.cpId, а debtors() отдаёт row.cp. Проверка живёт в
   * miniapp-selftest.js, здесь — сама причина: поле называется cp.
   */
  const { u } = freshUser();
  const cp = bdb.createCp(u, { name: 'Должник', kind: 'customer' });
  bdb.addOp(u, cp, { date: '2026-03-01', kind: 'Приход', doc: 'x', credit: 5000 });
  const rows = bdb.debtors(u);
  ok(rows.length === 1 && rows[0].cp && rows[0].cp.id === cp,
    'debtors отдаёт контрагента в поле cp, а не cpId',
    rows.length && JSON.stringify(Object.keys(rows[0])));
}

{
  // Пустой контрагент и пустой журнал не должны ронять расчёт.
  const { u } = freshUser();
  const cp = bdb.createCp(u, { name: 'Пустой', kind: 'customer' });
  const b = bdb.periodBalance(u, cp, '2026-01-01', '2026-01-31');
  ok(b && b.ops.length === 0 && b.closing === 0, 'пустой журнал считается нулём',
    b && b.closing);
  ok(bdb.periodBalance(u, 999999, '', '') === null, 'несуществующий контрагент — null, а не падение');
}

{
  // Спецсимволы в названии не должны попадать в документ как разметка.
  const { u } = freshUser();
  const evil = '<script>alert(1)</script> & «Ко»';
  const cp = bdb.createCp(u, { name: evil, kind: 'customer' });
  const saved = bdb.getCp(u, cp);
  ok(saved.name === evil, 'название хранится как есть, без порчи', saved.name.slice(0, 20));
  const { buildSchetHtml } = require('./lib/schet');
  const org = bdb.getDefaultOrg(u);
  const html = buildSchetHtml({
    org: { ...org, org_short: org.name, org_full: org.name, org_inn: org.inn },
    cp: saved,
    doc: { number: '1', date: '2026-05-01', items: [{ name: evil, qty: 1, price: 100 }] },
  });
  ok(!html.includes('<script>alert(1)</script>'), 'в документ разметка не подставляется');
  ok(html.includes('&lt;script&gt;'), 'она экранируется');
}

console.log(bad ? `\nне прошло: ${bad}` : '\nвсе атаки отражены ✅');
process.exit(bad ? 1 : 0);
