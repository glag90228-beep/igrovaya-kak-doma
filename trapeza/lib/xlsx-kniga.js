'use strict';

/**
 * Книга продаж за период — Excel.
 *
 * Зачем она нужна отдельно от реестра документов. Реестр — это «что я
 * выписал», удобный список для себя. Книга продаж — налоговый регистр
 * (постановление № 1137, раздел II приложения 5): в неё попадают только
 * документы с НДС, в строго определённом порядке граф, и именно её данные
 * уходят в декларацию и сверяются АСК НДС-2 с книгой покупок контрагента.
 * Расхождение здесь — требование из налоговой обеим сторонам сделки.
 *
 * Что сюда попадает:
 *   • отгрузочные счета-фактуры (у нас это УПД со статусом 1) — код 01;
 *   • авансовые счета-фактуры на полученную предоплату — код 02;
 *   • корректировочные счета-фактуры на УВЕЛИЧЕНИЕ стоимости — код 18.
 *
 * Чего сюда НЕ попадает и почему:
 *   • корректировочные на УМЕНЬШЕНИЕ — они идут в книгу ПОКУПОК, потому что
 *     это вычет у продавца (п. 13 ст. 171 НК), а не начисление;
 *   • счета на оплату, акты, накладные и договоры — это не счета-фактуры,
 *     налог по ним не начисляется;
 *   • документы без НДС — им в книге продаж места нет.
 *
 * Оговорка, которую надо знать. Это выгрузка для сверки и для бухгалтера, а
 * не готовая книга продаж для сдачи: нумерация граф соблюдена, но книга
 * ведётся нарастающим итогом за квартал и подписывается, а часть граф
 * (например, посреднические) наш продукт не заполняет, потому что таких
 * операций у него нет. Сдавать по ней декларацию нельзя — сверять можно.
 */

const ExcelJS = require('exceljs');
const { round2, vatTotals } = require('./money');
const { advanceVat } = require('./avans');
const { correctionRow, correctionTotals } = require('./ksf');

const HEAD = 'FF2E3A8C';
const CREAM = 'FFF4F6FC';
const MONEY = '#,##0.00';

const ru = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
};

function box(cell) {
  cell.border = {
    top: { style: 'thin', color: { argb: 'FFC3C9DC' } },
    left: { style: 'thin', color: { argb: 'FFC3C9DC' } },
    bottom: { style: 'thin', color: { argb: 'FFC3C9DC' } },
    right: { style: 'thin', color: { argb: 'FFC3C9DC' } },
  };
}

/**
 * Приводит выписанный документ к строке книги продаж — или отказывается.
 *
 * Возвращает null для всего, что в книгу не идёт. Решение принимается здесь
 * одно на всех, а не в трёх местах вызова: попадёт лишнее — разойдётся с
 * контрагентом, не попадёт нужное — занижена база.
 *
 * @returns {{code:string, net:number, vat:number, total:number, rate:number|null}|null}
 */
function bookRow(doc) {
  const p = doc.payload || {};
  const rate = p.vatRate == null ? null : Number(p.vatRate);

  if (doc.type === 'avans') {
    if (rate == null) return null;
    const a = advanceVat(p.sum, rate);
    // Код 02 — предоплата. Стоимость без налога в книге продаж по авансу не
    // заполняется: её ещё нет, отгрузки не было.
    return { code: '02', net: null, vat: a.vat, total: a.sum, rate };
  }

  if (doc.type === 'ksf') {
    if (rate == null) return null;
    const rows = (p.lines || []).map((l) => correctionRow(
      l.before || { qty: 0, price: 0 }, l.after || { qty: 0, price: 0 },
      rate, Boolean(p.priceIncludesVat),
    ));
    const { up } = correctionTotals(rows);
    // Только увеличение: уменьшение — это вычет, ему место в книге покупок.
    if (!up.total) return null;
    return { code: '18', net: up.net, vat: up.vat, total: up.total, rate };
  }

  // Отгрузка. Счётом-фактурой у нас работает только УПД со статусом 1.
  if (doc.type === 'upd' && Number(p.status) === 1 && rate != null) {
    const t = vatTotals(p.items || [], rate, Boolean(p.priceIncludesVat));
    return { code: '01', net: t.net, vat: t.vat, total: t.total, rate };
  }

  return null;
}

/**
 * @param {object} p
 * @param {object} p.org организация-продавец
 * @param {Array}  p.docs выписанные документы за период (с payload и cpName)
 * @param {string} p.from начало периода, ГГГГ-ММ-ДД
 * @param {string} p.to конец периода
 */
async function buildKnigaProdazh({ org, docs, from, to }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Первичка';
  const ws = wb.addWorksheet('Книга продаж');

  ws.mergeCells('A1:J1');
  const title = ws.getCell('A1');
  title.value = `Книга продаж: ${org.full_name || org.name}, ИНН ${org.inn || '—'}`;
  title.font = { bold: true, size: 13, color: { argb: HEAD } };

  ws.mergeCells('A2:J2');
  ws.getCell('A2').value = `Период: ${ru(from)} — ${ru(to)}`;
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF666666' } };

  const cols = [
    ['№ п/п', 6],
    ['Код вида операции', 10],
    ['Номер и дата счёта-фактуры', 22],
    ['Наименование покупателя', 30],
    ['ИНН/КПП покупателя', 18],
    ['Валюта', 10],
    ['Стоимость продаж с НДС', 18],
    ['Ставка', 8],
    ['Стоимость продаж без НДС', 20],
    ['Сумма НДС', 14],
  ];
  const head = ws.getRow(4);
  cols.forEach(([name, width], i) => {
    const c = head.getCell(i + 1);
    c.value = name;
    c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
    c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    ws.getColumn(i + 1).width = width;
    box(c);
  });
  head.height = 34;

  // Номера граф официальной формы — отдельной строкой, как в бланке: по ним
  // бухгалтер сверяется с приложением 5 к постановлению № 1137.
  const nums = ws.getRow(5);
  ['1', '2', '3', '7', '8', '11', '13б', '14а', '14', '17'].forEach((n, i) => {
    const c = nums.getCell(i + 1);
    c.value = n;
    c.font = { size: 8, italic: true, color: { argb: 'FF888888' } };
    c.alignment = { horizontal: 'center' };
    box(c);
  });

  let r = 6;
  let n = 0;
  const totals = { total: 0, net: 0, vat: 0 };
  for (const doc of docs) {
    const row = bookRow(doc);
    if (!row) continue;
    n += 1;
    const line = ws.getRow(r);
    line.getCell(1).value = n;
    line.getCell(2).value = row.code;
    line.getCell(3).value = `${doc.number} от ${ru(doc.date)}`;
    line.getCell(4).value = doc.cpName || '—';
    line.getCell(5).value = doc.cpInn || '—';
    line.getCell(6).value = 'руб.';
    line.getCell(7).value = row.total;
    line.getCell(8).value = `${row.rate}%`;
    line.getCell(9).value = row.net;      // у аванса пусто — стоимости ещё нет
    line.getCell(10).value = row.vat;
    for (const i of [7, 9, 10]) line.getCell(i).numFmt = MONEY;
    for (let i = 1; i <= 10; i += 1) {
      box(line.getCell(i));
      if (n % 2 === 0) {
        line.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
      }
    }
    totals.total = round2(totals.total + row.total);
    totals.net = round2(totals.net + (row.net || 0));
    totals.vat = round2(totals.vat + row.vat);
    r += 1;
  }

  if (!n) {
    ws.mergeCells(`A${r}:J${r}`);
    ws.getCell(`A${r}`).value = 'За период не выписано ни одного счёта-фактуры.';
    ws.getCell(`A${r}`).font = { italic: true, color: { argb: 'FF888888' } };
    r += 1;
  } else {
    // Формулы, а не готовые числа: бухгалтер удалит лишнюю строку — итог
    // пересчитается сам, и не придётся искать, почему он не сходится.
    const tot = ws.getRow(r);
    tot.getCell(1).value = 'Всего';
    tot.getCell(1).font = { bold: true };
    for (const [col, letter] of [[7, 'G'], [9, 'I'], [10, 'J']]) {
      const c = tot.getCell(col);
      c.value = { formula: `SUM(${letter}6:${letter}${r - 1})` };
      c.numFmt = MONEY;
      c.font = { bold: true };
    }
    for (let i = 1; i <= 10; i += 1) box(tot.getCell(i));
    r += 1;
  }

  r += 1;
  ws.mergeCells(`A${r}:J${r + 2}`);
  const note = ws.getCell(`A${r}`);
  note.value = 'Коды: 01 — отгрузка, 02 — полученная предоплата, 18 — корректировка на увеличение.\n'
    + 'Корректировки на уменьшение сюда не входят: они отражаются в книге покупок (п. 13 ст. 171 НК).\n'
    + 'Выгрузка для сверки: книга ведётся нарастающим итогом за квартал и подписывается.';
  note.font = { size: 9, color: { argb: 'FF666666' } };
  note.alignment = { wrapText: true, vertical: 'top' };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildKnigaProdazh, bookRow };
