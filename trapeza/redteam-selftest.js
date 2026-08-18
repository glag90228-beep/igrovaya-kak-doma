'use strict';

/**
 * Красная команда: проверки на дыры в актах сверки и в расчёте сумм.
 *
 * Здесь собраны только те случаи, которые я воспроизвёл запуском. Каждый
 * тест написан на ПРАВИЛЬНОЕ поведение, а не на текущее, поэтому на
 * сегодняшнем коде прогон падает — в этом его смысл. Рядом с каждым
 * тестом сказано, что именно ломается и чем это грозит владельцу бизнеса.
 *
 *   TRAPEZA_DB=/tmp/redteam.db node redteam-selftest.js
 */

require('./selftest-db');   // своя база на прогон — до всего, что тянет db.js

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '111:TEST-TOKEN';
process.env.MAIL_KEY = process.env.MAIL_KEY || 'redteam-mail-key';
process.env.FREE_DOCS = '1000';      // лимит поднимаем; отдельный блок его проверяет
process.env.ENFORCE_LIMIT = '0';

const ExcelJS = require('exceljs');

const bdb = require('./lib/bot-db');
const ds = require('./lib/doc-service');
const period = require('./lib/period');
const { buildAkt } = require('./lib/xlsx-akt');
const { round2, formatRub, amountInWords } = require('./lib/money');
const { parseOp, parseItemLine, handleUpdate } = require('./bot');
const { api, setTelegram } = require('./miniapp');

let bad = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg + (cond || extra === undefined ? '' : ' → ' + extra));
  if (!cond) bad += 1;
};

const ORG = { name: 'ИП Иванов', full_name: 'ИП Иванов Иван Иванович',
  inn: '183209316100', signer: 'И. И. Иванов' };
const orgForAkt = (o) => ({ brand: o.name, org_short: o.name, org_full: o.full_name || o.name,
  org_inn: o.inn, signer: o.signer });

/** Свежий пользователь на каждый блок — чтобы блоки не мешали друг другу. */
let seq = 0;
function freshUser() {
  seq += 1;
  const u = bdb.getOrCreateUser(990000 + seq, `Красная команда ${seq}`);
  bdb.saveMyOrg(u.id, ORG);
  return u;
}

/** Прочитать собранный акт обратно: нас интересуют формулы, а не картинка. */
async function readAkt(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buf));
  return { журнал: wb.getWorksheet('Журнал операций'), акт: wb.getWorksheet('Акт сверки') };
}
const formulaOf = (ws, addr) => {
  const v = ws.getCell(addr).value;
  return v && typeof v === 'object' && v.formula ? v.formula : null;
};
/** «SUM(D12:D11)» → {первая: 12, последняя: 11} — номера строк диапазона. */
function строкиДиапазона(formula) {
  const m = /\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)/.exec(String(formula || ''));
  return m ? { первая: Number(m[2]), последняя: Number(m[4]) } : null;
}

async function main() {
  setTelegram({ async sendDocument() { return {}; } });

  console.log('\n=== 1. Сальдо за период ===');
  {
    const u = freshUser();
    const cpId = bdb.createCp(u.id, { name: 'ООО Ромашка', kind: 'customer', opening_balance: 50000 });
    bdb.addOp(u.id, cpId, { date: '2026-02-15', kind: 'Приход', credit: 10000 });
    bdb.addOp(u.id, cpId, { date: '2026-05-15', kind: 'Оплата', debit: 4000 });
    const всего = bdb.balanceOf(u.id, cpId).closing;   // 56 000

    /*
     * Перевёрнутый период (from > to). periodBalance кладёт во «входящее
     * сальдо» всё, что раньше from, а всё, что позже to, молча выбрасывает:
     * оплата 4 000 исчезает из акта вместе с оборотами. В приложении две
     * свободные даты («С какой даты» / «По какую», app.js:1857) без всякой
     * проверки порядка, а GET /api/akt смотрит на них только регуляркой.
     * Перепутал даты местами — клиенту ушёл акт с долгом на 4 000 больше.
     */
    const назад = bdb.periodBalance(u.id, cpId, '2026-03-01', '2026-01-31');
    ok(назад === null || назад.closing === всего,
      'акт за перевёрнутый период (from > to) не выдумывает сальдо',
      назад && `в акте ${назад.closing}, на самом деле ${всего}`);

    /*
     * «За всё время» — это пустое from и to = сегодня (presetRange('all')).
     * То, что период кончается сегодня, сделано намеренно и объяснено в
     * lib/period.js: сверяют то, что уже случилось. Дыра не в этом.
     *
     * Операция с датой в будущем — обычная опечатка в годе, «15.06.27»
     * вместо «15.06.26» — оказывается позже to и не попадает ни в обороты,
     * ни во входящее сальдо, то есть исчезает бесследно. В карточке долг
     * 60 000, в акте «за всё время» 10 000, и бот подписывает файл
     * «исходящее сальдо 10 000,00 руб.» Два числа за один и тот же долг
     * в одном экране, и человеку нигде не сказано, почему они разные.
     */
    const cp2 = bdb.createCp(u.id, { name: 'ООО Опечатка', kind: 'customer' });
    bdb.addOp(u.id, cp2, { date: '2026-07-01', kind: 'Приход', credit: 10000 });
    bdb.addOp(u.id, cp2, { date: '2027-06-15', kind: 'Приход', credit: 50000 });
    const p = period.presetRange('all', period.todayDate());
    const всёВремя = bdb.periodBalance(u.id, cp2, p.from, p.to);
    ok(всёВремя.closing === bdb.balanceOf(u.id, cp2).closing,
      'акт «за всё время» сходится с сальдо карточки',
      `акт ${всёВремя.closing}, карточка ${bdb.balanceOf(u.id, cp2).closing}`);
  }

  console.log('\n=== 2. Даты операций ===');
  {
    /*
     * parseDate в bot.js (строка 49) не проверяет, что дата существует, —
     * в отличие от parseDay в lib/period.js, который «31.02.2026» отвергает
     * (об этом прямо написано в README). Значит через ввод операции в базу
     * попадает дата, которой не бывает.
     */
    const op = parseOp('31.02.2026 приход 94193');
    ok(op === null || датаСуществует(op.date),
      'операция с несуществующей датой 31.02.2026 не принимается',
      op && op.date);
    const дичь = parseOp('45.99.2026 оплата 1000');
    ok(дичь === null || датаСуществует(дичь.date),
      'операция с датой 45.99.2026 не принимается', дичь && дичь.date);

    /*
     * И вот чем это кончается. Дата «2026-02-31» больше конца февраля, но
     * меньше начала марта: в акт за февраль операция не попадает совсем, а
     * в сальдо карточки живёт. Акт за февраль показывает 1 000 вместо
     * 95 193 — почти сто тысяч долга исчезают из документа, который
     * подписывают обе стороны.
     */
    const u = freshUser();
    const cpId = bdb.createCp(u.id, { name: 'ООО Февраль', kind: 'customer' });
    bdb.addOp(u.id, cpId, { date: '2026-02-31', kind: 'Приход', doc: 'Акт 1', credit: 94193 });
    bdb.addOp(u.id, cpId, { date: '2026-02-10', kind: 'Приход', doc: 'Акт 2', credit: 1000 });
    const февраль = bdb.periodBalance(u.id, cpId, '2026-02-01', '2026-02-28');
    ok(февраль.closing === 95193,
      'операция 31.02 не выпадает из акта за февраль', `в акте ${февраль.closing} из 95193`);

    // 2026-99-45 не попадает вообще никуда: она больше любого «to».
    const cp2 = bdb.createCp(u.id, { name: 'ООО Никогда', kind: 'customer' });
    bdb.addOp(u.id, cp2, { date: '2026-99-45', kind: 'Приход', credit: 50000 });
    const годовой = bdb.periodBalance(u.id, cp2, '2026-01-01', '2026-12-31');
    ok(годовой.closing === bdb.balanceOf(u.id, cp2).closing,
      'операция с датой-мусором видна хоть в каком-нибудь акте',
      `акт ${годовой.closing}, карточка ${bdb.balanceOf(u.id, cp2).closing}`);
  }

  console.log('\n=== 3. Excel-акт: формулы ===');
  {
    const cp = { name: 'ООО Ромашка', full_name: 'ООО «Ромашка»', inn: '7701234567',
      kind: 'customer', contract: 'Договор 1', opening_balance: 77388,
      opening_date: '2026-07-01', period_end: '2026-07-31' };

    /*
     * Акт за период без движений — обычное дело: сверка за квартал, в
     * котором ничего не было. Строка «ИТОГО» тогда встаёт ровно туда, где
     * должна была быть первая операция, и диапазон суммы выходит
     * перевёрнутым: SUM(C12:C11). Excel читает его как C11:C12 — то есть
     * в сумму попадают и строка начального сальдо, и сама ячейка с
     * формулой. Клиент открывает акт и видит предупреждение о циклической
     * ссылке, а конечное сальдо удваивается.
     */
    const { акт, журнал } = await readAkt(await buildAkt({ org: orgForAkt(ORG), cp, ops: [] }));
    for (const [лист, ws, адрес] of [['акт', акт, 'C12'], ['акт', акт, 'D12'],
      ['журнал', журнал, 'E10'], ['журнал', журнал, 'F10']]) {
      const f = formulaOf(ws, адрес);
      const r = строкиДиапазона(f);
      const строка = Number(адрес.slice(1));
      const целый = r && r.первая <= r.последняя && !(строка >= r.первая && строка <= r.последняя);
      ok(целый, `пустой акт: «${лист}» ${адрес} — обороты не считают сами себя`, f);
    }

    /*
     * Правая половина акта — «по данным контрагента» — зеркало левой:
     * A..D это Дата/Документ/Дебет/Кредит, E..H то же самое. Слева
     * начальное сальдо стоит в «Кредите» (D11), справа его положили в
     * «Дебет» (G11), а формула конечного сальдо читает «Кредит» (H11) —
     * пустую ячейку. Контрагент получает свою половину, где начальное
     * сальдо в чужой колонке, а конечное пустое: сверить нечего.
     */
    const два = await readAkt(await buildAkt({ org: orgForAkt(ORG), cp, ops: [
      { date: '2026-07-05', kind: 'Приход', doc: 'Акт 1', debit: 0, credit: 10000 },
      { date: '2026-07-20', kind: 'Оплата', doc: 'п/п 5', debit: 4000, credit: 0 },
    ] }));
    ok(два.акт.getCell('H11').value != null,
      'справа начальное сальдо стоит в «Кредите» (H11), как и слева в D11',
      JSON.stringify(два.акт.getCell('H11').value));
    ok(два.акт.getCell('G11').value == null,
      'справа в «Дебете» (G11) начального сальдо быть не должно',
      JSON.stringify(два.акт.getCell('G11').value));

    /*
     * Подкопеечные суммы приложение принимает как есть: POST /api/op не
     * округляет. В акте строки печатаются округлёнными до копейки, а
     * «ИТОГО» посчитано по неокруглённым — и это живая формула SUM по тем
     * же строкам. Числа в одном документе не сходятся между собой.
     */
    const копейки = await readAkt(await buildAkt({ org: orgForAkt(ORG),
      cp: { ...cp, opening_balance: 0 },
      ops: [
        { date: '2026-07-01', kind: 'Приход', doc: 'а', debit: 0, credit: 0.125 },
        { date: '2026-07-02', kind: 'Приход', doc: 'б', debit: 0, credit: 0.125 },
      ] }));
    const строки = round2(копейки.журнал.getCell('F10').value + копейки.журнал.getCell('F11').value);
    const итого = копейки.журнал.getCell('F12').value.result;
    ok(строки === итого, 'сумма строк журнала равна «ИТОГО» в том же файле',
      `строки ${строки}, ИТОГО ${итого}`);

    /*
     * Организация без названия. Оба места, откуда акт уходит письмом
     * (bot.js: sendReminderMail, miniapp.js: POST /api/reminder/mail),
     * берут её как `getDefaultOrg(user.id) || {}`, без проверки. А
     * xlsx-akt.js вместо пустого названия подставляет «ИП Сарычева М. В.»
     * (строка 52) и такую же подпись (строка 367): клиент получает акт
     * сверки с чужими реквизитами в документе, который подписывают.
     */
    const ничей = await readAkt(await buildAkt({ org: {}, cp: { ...cp, opening_balance: 1000 }, ops: [] }));
    const весьТекст = JSON.stringify(ничей.акт.getSheetValues()) + JSON.stringify(ничей.журнал.getSheetValues());
    ok(!/Сарычев/.test(весьТекст),
      'в акте без названия организации нет чужого имени',
      (весьТекст.match(/[^"]*Сарычев[^"]*/) || [''])[0]);
  }

  console.log('\n=== 4. Документы и журнал ===');
  {
    /*
     * Основание долга «по счёту» (аренда): долг создаёт счёт, акт — нет.
     * Но markPaid (bot-db.js, строка 517) смотрит только на режим «вручную»
     * и проводит оплату по ЛЮБОМУ документу. Отметили оплату по счёту,
     * потом по акту за тот же месяц — в журнале две оплаты по 30 000 на
     * одну сделку, сальдо −30 000. Выходит, что арендодатель должен
     * арендатору 30 000, которых тот не платил.
     */
    const u = freshUser();
    bdb.updateOrg(u.id, bdb.getDefaultOrg(u.id).id, { debt_basis: 'invoice' });
    const cpId = bdb.createCp(u.id, { name: 'ООО Арендатор', kind: 'customer' });
    const счёт = await ds.issueDocument(u.id, { type: 'sch', cpId, date: '2026-03-01',
      items: [{ name: 'Аренда за март', qty: 1, price: 30000 }] });
    const акт = await ds.issueDocument(u.id, { type: 'usl', cpId, date: '2026-03-31',
      items: [{ name: 'Аренда за март', qty: 1, price: 30000 }] });
    bdb.markPaid(u.id, счёт.doc.id, '2026-03-05');
    bdb.markPaid(u.id, акт.doc.id, '2026-04-05');
    ok(bdb.balanceOf(u.id, cpId).closing === 0,
      'оплата одной сделки не проводится дважды при основании «по счёту»',
      `сальдо ${bdb.balanceOf(u.id, cpId).closing}`);

    /*
     * «Убрать последнюю операцию» (deleteLastOp, строка 333) сносит и
     * проводку, созданную документом. Документ остаётся с отметкой
     * «оплачен» и уходит из списка «Не оплачено», а в журнале оплаты нет:
     * долг воскресает, и клиенту уедет напоминание об уже оплаченном счёте.
     */
    const u2 = freshUser();
    const cp2 = bdb.createCp(u2.id, { name: 'ООО Клиент', kind: 'customer' });
    const усл = await ds.issueDocument(u2.id, { type: 'usl', cpId: cp2, date: '2026-06-01',
      items: [{ name: 'Услуга', qty: 1, price: 50000 }] });
    bdb.markPaid(u2.id, усл.doc.id, '2026-06-10');
    bdb.deleteLastOp(u2.id, cp2);
    const оплачен = Boolean(bdb.getDoc(u2.id, усл.doc.id).paid_at);
    const естьОплата = bdb.opsOfDoc(u2.id, усл.doc.id).some((o) => o.kind === 'Оплата');
    ok(оплачен === естьОплата,
      'документ «оплачен» ровно тогда, когда оплата есть в журнале',
      `paid_at=${оплачен}, оплата в журнале=${естьОплата}`);

    /*
     * nextSeq берёт MAX(seq)+1, поэтому после удаления последней накладной
     * следующая получает тот же номер. У покупателя на руках ТОРГ-12 № 2
     * на 200 руб., а в базе — другая ТОРГ-12 № 2 на 999 руб. Два разных
     * документа с одним номером за год находит первая же проверка.
     */
    const u3 = freshUser();
    const cp3 = bdb.createCp(u3.id, { name: 'ООО Покупатель', kind: 'customer' });
    const н1 = await ds.issueDocument(u3.id, { type: 'torg12', cpId: cp3, date: '2026-05-01',
      items: [{ name: 'Товар', qty: 1, price: 100 }] });
    const н2 = await ds.issueDocument(u3.id, { type: 'torg12', cpId: cp3, date: '2026-05-02',
      items: [{ name: 'Товар', qty: 1, price: 200 }] });
    bdb.deleteDoc(u3.id, н2.doc.id);
    const н3 = await ds.issueDocument(u3.id, { type: 'torg12', cpId: cp3, date: '2026-05-03',
      items: [{ name: 'Товар', qty: 1, price: 999 }] });
    ok(н3.doc.number !== н2.doc.number,
      'номер удалённого документа не достаётся следующему',
      `${н1.doc.number}, ${н2.doc.number} (удалили), затем снова ${н3.doc.number}`);
  }

  console.log('\n=== 5. Позиции документа ===');
  {
    /*
     * cleanItems (doc-service.js, строка 91) округляет количество до двух
     * знаков. Дробные количества у продуктов и материалов обычные: 0,004 т
     * молока превращается в 0 — и документ выходит на нулевую сумму,
     * а долг в журнал не попадает вовсе.
     */
    const молоко = ds.cleanItems([{ name: 'Молоко', qty: 0.004, price: 100000 }]);
    ok(молоко.length === 1 && молоко[0].qty > 0,
      'дробное количество 0,004 не обнуляет позицию', JSON.stringify(молоко));
    ok(ds.totalOf(молоко) > 0, 'документ на 0,004 × 100 000 не выходит нулевым',
      ds.totalOf(молоко));

    /*
     * Непонятое количество молча становится единицей: пустое поле в
     * приложении уходит как 0, и «0 шт.» превращается в «1 шт.». Сумма
     * документа меняется без единого слова человеку — такое надо
     * отвергать, а не угадывать.
     */
    ok(ds.cleanItems([{ name: 'Товар', qty: 0, price: 100 }]).length === 0,
      'позиция с нулевым количеством не подставляет «1»',
      JSON.stringify(ds.cleanItems([{ name: 'Товар', qty: 0, price: 100 }])));
    ok(ds.cleanItems([{ name: 'Товар', qty: -5, price: 100 }]).length === 0,
      'позиция с отрицательным количеством не подставляет «1»',
      JSON.stringify(ds.cleanItems([{ name: 'Товар', qty: -5, price: 100 }])));

    /*
     * Ввод позиций текстом в боте: readItemLine (строка 799) вырезает из
     * числа всё, кроме цифр и разделителя, — вместе с минусом. Строка
     * скидки «Скидка; 1; -5000» становится плюсом: счёт получается на
     * 10 000 больше задуманного.
     */
    const скидка = parseItemLine('Скидка; 1; -5000');
    ok(скидка === null || скидка.price < 0,
      'отрицательная цена в строке позиции не превращается в положительную',
      скидка && `price ${скидка.price}`);

    /*
     * Ввод операции текстом: parseOp разбивает строку по пробелам и берёт
     * первое же число. «15.06 приход 94 193» — так пишут суммы люди — даёт
     * приход на 94 рубля вместо 94 193. В журнале появляется долг в тысячу
     * раз меньше, и это уходит прямо в акт сверки.
     */
    const пробел = parseOp('15.06 приход 94 193');
    ok(пробел === null || пробел.credit === 94193,
      'сумма «94 193» с пробелом в разрядах читается целиком',
      пробел && `credit ${пробел.credit}`);
  }

  console.log('\n=== 6. Мини-приложение ===');
  {
    const u = freshUser();

    /*
     * POST /api/cp (miniapp.js, строка 265) читает начальное сальдо как
     * Number(строка.replace(',', '.')) — пробел в разрядах не убирается.
     * Приложение само печатает деньги как «12 000,50», человек так же и
     * вводит, а в базу уезжает 0. Долг, с которого начинались расчёты,
     * пропадает молча — акт сверки открывается с нуля.
     */
    const r = await api['POST /api/cp']({ user: u,
      body: { name: 'ООО Начальное', opening_balance: '12 000,50', opening_date: '2026-01-01' } });
    const сохранено = bdb.getCp(u.id, r.cp.id).opening_balance;
    ok(сохранено === 12000.5, 'начальное сальдо «12 000,50» сохраняется целиком', сохранено);

    /*
     * GET /api/akt/all («Акты сверки всем должникам», miniapp.js:585)
     * читает row.cpId, а debtors() такого поля не возвращает — у неё
     * вложенный объект cp. getCp получает undefined, node:sqlite не
     * биндит его, запрос падает пятисоткой. Кнопка не работала ни разу.
     */
    bdb.updateCp(u.id, r.cp.id, { opening_balance: 50000 });
    let ответ = null; let упало = null;
    try { ответ = await api['GET /api/akt/all']({ user: u }); } catch (e) { упало = e; }
    ok(!упало, 'акты сверки всем должникам не падают с ошибкой', упало && упало.message);
    ok(ответ && ответ.count === 1, 'акты сверки всем должникам собирают акт по должнику',
      JSON.stringify(ответ));
  }

  console.log('\n=== 7. Бесплатный лимит ===');
  {
    const u = freshUser();
    const cpId = bdb.createCp(u.id, { name: 'ООО Лимит', kind: 'customer' });
    const сегодня = period.todayISO();
    const выписать = (price) => ds.issueDocument(u.id, { type: 'sch', cpId, date: сегодня,
      items: [{ name: 'Услуга', qty: 1, price }] });

    process.env.FREE_DOCS = '2';
    process.env.ENFORCE_LIMIT = '1';
    try {
      const первый = await выписать(100);
      await выписать(200);
      /*
       * Лимит считает строки в documents. Файл человек уже получил, а
       * удаление возвращает бесплатный слот: выписал, забрал, удалил —
       * и так сколько угодно. Подписку можно не покупать никогда.
       */
      bdb.deleteDoc(u.id, первый.doc.id);
      const после = await выписать(300);
      ok(!после.ok && после.reason === 'quota',
        'удаление уже полученного документа не возвращает бесплатный лимит',
        после.ok ? `выписан ещё один, № ${после.doc.number}` : после.reason);

      /*
       * Тот же лимит считает документы по дате документа (bot-db.js,
       * строка 809), а дату задаёт человек. Документы прошлым месяцем
       * не попадают в счётчик текущего вовсе.
       */
      const u2 = freshUser();
      const cp2 = bdb.createCp(u2.id, { name: 'ООО Задним числом', kind: 'customer' });
      let прошло = 0;
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await ds.issueDocument(u2.id, { type: 'sch', cpId: cp2, date: '2026-01-15',
          items: [{ name: 'Услуга', qty: 1, price: 100 }] });
        if (res.ok) прошло += 1;
      }
      ok(прошло <= 2, 'документы задним числом тоже упираются в бесплатный лимит',
        `выписано ${прошло} при лимите 2`);
    } finally {
      process.env.FREE_DOCS = '1000';
      process.env.ENFORCE_LIMIT = '0';
    }
  }

  console.log('\n=== 8. Два акта сверки подряд ===');
  {
    /*
     * genAktSverki (bot.js, строка 592) берёт номер, ждёт отправки файла в
     * Telegram и только потом пишет документ в журнал. Между номером и
     * записью — сетевой запрос, и второе нажатие успевает взять тот же
     * номер. Уникальный индекс вторую запись не пропускает: файл ушёл, в
     * журнале его нет, а человек вместо подтверждения видит «что-то пошло
     * не так». issueDocument от этого защищён повтором, акт сверки — нет.
     */
    const файлы = [];
    const tg = {
      async sendMessage() { return { message_id: 1 }; },
      async sendDocument(chatId, { filename }) {
        файлы.push(filename);
        await new Promise((r) => setTimeout(r, 30));   // отправка занимает время
        return { message_id: 1 };
      },
      async sendChatAction() {}, async answerCallbackQuery() {},
      async editMessageText() {}, async call() { return {}; },
    };
    const USER = { id: 998877, first_name: 'Мария', username: 'redteam' };
    const CHAT = { id: 998877 };
    const tap = (data) => handleUpdate(tg,
      { callback_query: { id: 'cb', from: USER, data, message: { chat: CHAT } } });

    await handleUpdate(tg, { message: { chat: CHAT, from: USER, text: '/start' } });
    const u = bdb.getOrCreateUser(USER.id);
    bdb.saveMyOrg(u.id, ORG);
    const cpId = bdb.createCp(u.id, { name: 'ООО Двойное нажатие', kind: 'customer',
      opening_date: '2026-01-01' });
    bdb.addOp(u.id, cpId, { date: '2026-02-10', kind: 'Приход', credit: 10000 });

    await Promise.all([tap(`akt.p:${cpId}:all`), tap(`akt.p:${cpId}:all`)]);
    const записи = bdb.listDocs(u.id, 20).filter((d) => d.type === 'akt');
    ok(записи.length === файлы.length,
      'сколько актов сверки ушло человеку, столько и записано в журнал',
      `файлов ${файлы.length}, записей ${записи.length}`);
  }

  console.log('\n=== 9. Деньги ===');
  {
    /*
     * Мелочь, но настоящая: round2 прибавляет Number.EPSILON, и для
     * отрицательных это работает в другую сторону — 1,005 → 1,01, а
     * −1,005 → −1,00. Сальдо в нашу пользу и сальдо в пользу контрагента
     * округляются по разным правилам, а в итоговой строке акта цифры и
     * пропись расходятся: «0,00 руб. (Ноль рублей 01 копейка)».
     */
    ok(round2(-1.005) === -1.01, 'round2 округляет −1,005 так же, как 1,005', round2(-1.005));
    const строка = `${formatRub(-0.005)} (${amountInWords(-0.005)})`;
    ok(!/0,00\s*руб\.\s*\(Ноль рублей 01/.test(строка),
      'цифры и сумма прописью в акте не противоречат друг другу', строка);

    /*
     * Выше триллиона пропись теряет разряд: SCALES в money.js рассчитан на
     * пять триад, шестая берёт scale=undefined и слово «квадриллион» не
     * печатается вовсе. Суммы такие в жизни не встречаются, но цифрами и
     * прописью в одном документе получаются разные числа.
     */
    const квадриллион = amountInWords(1e15);
    ok(!/^Один рублей/.test(квадриллион),
      'сумма прописью не теряет разряды на больших числах', квадриллион);
  }

  await require('./lib/pdf').closePdf();
  console.log(bad ? `\nне прошло: ${bad}` : '\nдыр не нашлось ✅');
  process.exit(bad ? 1 : 0);
}

/** Есть ли такая дата в календаре: «2026-02-31» — нет. */
function датаСуществует(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

main().catch((e) => { console.error(e); process.exit(1); });
