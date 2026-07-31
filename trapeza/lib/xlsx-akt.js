'use strict';

// Акт сверки в Excel — повторяет рабочий формат «Трапезы»:
// лист «Журнал операций» (ввод данных, автосальдо) и лист «Акт сверки»
// (печатная форма с подписями и суммой прописью, тянет данные из журнала).

const ExcelJS = require('exceljs');
const { formatRub, amountInWords, round2 } = require('./money');

const BROWN = 'FF7A5230';
const DARK = 'FF5E3F27';
const CREAM = 'FFFAF6F1';
const SAND = 'FFEFE3D2';
const MONEY_FMT = '#,##0.00';

/** ISO yyyy-mm-dd → dd.mm.yyyy */
function ru(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso);
}
/** ISO yyyy-mm-dd → dd.mm.yy */
function ruShort(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : String(iso);
}

function fill(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}
function box(cell) {
  cell.border = {
    top: { style: 'thin', color: { argb: 'FFBBAB99' } },
    left: { style: 'thin', color: { argb: 'FFBBAB99' } },
    bottom: { style: 'thin', color: { argb: 'FFBBAB99' } },
    right: { style: 'thin', color: { argb: 'FFBBAB99' } },
  };
}

/** Полное имя контрагента с ИНН/КПП для шапок акта */
function cpTitle(cp) {
  const bits = [];
  if (cp.inn) bits.push(`ИНН ${cp.inn}`);
  if (cp.kpp) bits.push(`КПП ${cp.kpp}`);
  if (cp.extra) bits.push(cp.extra);
  return bits.length ? `${cp.full_name || cp.name} (${bits.join(', ')})` : (cp.full_name || cp.name);
}

async function buildAkt({ org, cp, ops }) {
  const isSupplier = cp.kind === 'supplier';
  const orgShort = org.org_short || 'ИП Сарычева М. В.';
  const orgFull = org.org_full || orgShort;
  const orgInn = org.org_inn || '';
  const wb = new ExcelJS.Workbook();
  wb.creator = org.brand || 'Трапеза';
  wb.created = new Date();

  // ======================================================= лист 1: журнал
  const j = wb.addWorksheet('Журнал операций', {
    pageSetup: {
      paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  j.columns = [
    { width: 5 }, { width: 11 }, { width: 12 }, { width: 34 },
    { width: 17 }, { width: 17 }, { width: 19 }, { width: 24 }, { width: 14 },
  ];

  j.mergeCells('A1:H1');
  const jt = j.getCell('A1');
  jt.value = isSupplier
    ? `УЧЁТ РАСЧЁТОВ С ПОСТАВЩИКОМ (по данным ${orgShort})`
    : `УЧЁТ ВЗАИМОРАСЧЁТОВ (по данным ${orgShort})`;
  jt.font = { bold: true, size: 13, color: { argb: DARK } };
  jt.alignment = { horizontal: 'left', vertical: 'middle' };
  j.getRow(1).height = 22;

  const head = [
    ['Наша сторона:', `${orgShort} — ${orgFull}  (ИНН ${orgInn})`],
    [isSupplier ? 'Поставщик:' : 'Контрагент:', cpTitle(cp)],
    ['Договор / период:', `${cp.contract};  период ${ru(cp.opening_date)} - ${ru(cp.period_end)}`],
  ];
  head.forEach(([label, value], i) => {
    const r = 3 + i;
    j.getCell(`A${r}`).value = label;
    j.getCell(`A${r}`).font = { bold: true, size: 10 };
    j.mergeCells(`D${r}:H${r}`);
    j.getCell(`D${r}`).value = value;
    j.getCell(`D${r}`).font = { size: 10 };
  });

  const HEADERS = isSupplier
    ? ['№', 'Дата', 'Тип', 'Документ (наименование, №)', 'Наши оплаты\nпоставщику (Дебет), ₽',
      'Поставки товара\n(Кредит), ₽', 'Сальдо (наш долг\nпоставщику), ₽', 'Примечание']
    : ['№', 'Дата', 'Тип', 'Документ (наименование, №)', 'Оплаты от контр-та\n(Дебет), ₽',
      'Услуги провели\n(Кредит), ₽', `Сальдо в пользу\n${orgShort}, ₽`, 'Примечание'];
  const hRow = j.getRow(8);
  HEADERS.forEach((h, i) => {
    const c = hRow.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    fill(c, BROWN);
    box(c);
  });
  hRow.height = 34;

  // Строка начального сальдо
  j.mergeCells('A9:C9');
  j.getCell('D9').value = `Сальдо на ${ru(cp.opening_date)} `
    + (isSupplier ? '(наш долг поставщику)' : `(в пользу ${orgShort})`);
  j.getCell('D9').font = { bold: true, size: 10 };
  const openCell = j.getCell('G9');
  openCell.value = round2(cp.opening_balance);
  openCell.numFmt = MONEY_FMT;
  openCell.font = { bold: true };
  fill(openCell, SAND);
  ['A9', 'B9', 'C9', 'D9', 'E9', 'F9', 'G9', 'H9'].forEach((a) => box(j.getCell(a)));
  // Служебная колонка I — сальдо нарастающим итогом
  j.getCell('I9').value = { formula: 'N(G9)', result: round2(cp.opening_balance) };
  j.getCell('I9').numFmt = MONEY_FMT;

  // Считаем те же значения в JS и кладём их как кэш формул, чтобы числа
  // были видны сразу при открытии, ещё до пересчёта.
  let running = round2(cp.opening_balance);
  const runningAt = ops.map((op) => {
    running = round2(running + (Number(op.credit) || 0) - (Number(op.debit) || 0));
    return running;
  });
  const totalDebit = round2(ops.reduce((s, o) => s + (Number(o.debit) || 0), 0));
  const totalCredit = round2(ops.reduce((s, o) => s + (Number(o.credit) || 0), 0));
  const closingVal = round2(cp.opening_balance + totalCredit - totalDebit);

  const FIRST = 10;
  ops.forEach((op, i) => {
    const r = FIRST + i;
    const row = j.getRow(r);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = ruShort(op.date);
    row.getCell(3).value = op.kind || '';
    row.getCell(4).value = op.doc || '';
    if (op.debit) { row.getCell(5).value = round2(op.debit); row.getCell(5).numFmt = MONEY_FMT; }
    if (op.credit) { row.getCell(6).value = round2(op.credit); row.getCell(6).numFmt = MONEY_FMT; }
    row.getCell(7).value = {
      formula: `IF(AND(E${r}="",F${r}=""),"",I${r})`, result: runningAt[i],
    };
    row.getCell(7).numFmt = MONEY_FMT;
    row.getCell(8).value = op.note || '';
    row.getCell(9).value = {
      formula: `I${r - 1}+N(F${r})-N(E${r})`, result: runningAt[i],
    };
    row.getCell(9).numFmt = MONEY_FMT;
    for (let c = 1; c <= 8; c++) {
      const cell = row.getCell(c);
      box(cell);
      cell.font = { size: 10 };
      if (i % 2 === 1) fill(cell, CREAM);
      if (c === 1 || c === 2) cell.alignment = { horizontal: 'center' };
    }
  });

  const last = FIRST + ops.length - 1;
  const totalRow = last + 1;
  j.getCell(`D${totalRow}`).value = 'ИТОГО обороты за период:';
  j.getCell(`D${totalRow}`).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  j.getCell(`D${totalRow}`).alignment = { horizontal: 'right' };
  j.getCell(`E${totalRow}`).value = { formula: `SUM(E${FIRST}:E${last})`, result: totalDebit };
  j.getCell(`F${totalRow}`).value = { formula: `SUM(F${FIRST}:F${last})`, result: totalCredit };
  j.getCell(`I${totalRow}`).value = { formula: `I${last}`, result: closingVal };
  j.getCell(`I${totalRow}`).numFmt = MONEY_FMT;
  ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach((c) => {
    const cell = j.getCell(`${c}${totalRow}`);
    fill(cell, DARK);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    if (c === 'E' || c === 'F') cell.numFmt = MONEY_FMT;
    box(cell);
  });

  const closeRow = totalRow + 1;
  j.mergeCells(`D${closeRow}:F${closeRow}`);
  j.getCell(`D${closeRow}`).value = `Сальдо на ${ru(cp.period_end)} `
    + (isSupplier ? '(наш долг поставщику):' : `(в пользу ${orgShort}):`);
  j.getCell(`D${closeRow}`).font = { bold: true, size: 11 };
  j.getCell(`D${closeRow}`).alignment = { horizontal: 'right' };
  const closeCell = j.getCell(`G${closeRow}`);
  closeCell.value = { formula: `G9+F${totalRow}-E${totalRow}`, result: closingVal };
  closeCell.numFmt = MONEY_FMT;
  closeCell.font = { bold: true, size: 11, color: { argb: DARK } };
  fill(closeCell, SAND);
  box(closeCell);

  const noteRow = closeRow + 2;
  j.mergeCells(`A${noteRow}:H${noteRow}`);
  j.getCell(`A${noteRow}`).value = isSupplier
    ? `«Кредит» — поставки товара от ${cp.name} (наш долг растёт). «Дебет» — наши оплаты поставщику, `
      + 'уменьшают долг. Сальдо = сколько мы должны поставщику = нач. + Кредит − Дебет.'
    : `«Кредит» — услуги, которые мы (${orgShort}) оказали контрагенту. «Дебет» — оплаты, `
      + 'полученные от контрагента. Сальдо в нашу пользу = нач. + Кредит − Дебет.';
  j.getCell(`A${noteRow}`).font = { italic: true, size: 9, color: { argb: 'FF6B5B4B' } };
  j.getCell(`A${noteRow}`).alignment = { wrapText: true };
  j.getColumn(9).hidden = true;

  // ======================================================= лист 2: акт сверки
  const a = wb.addWorksheet('Акт сверки', {
    pageSetup: {
      paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  a.columns = [
    { width: 11 }, { width: 30 }, { width: 13 }, { width: 13 },
    { width: 11 }, { width: 30 }, { width: 13 }, { width: 13 },
  ];

  const title = (row, text, opts = {}) => {
    a.mergeCells(`A${row}:H${row}`);
    const c = a.getCell(`A${row}`);
    c.value = text;
    c.alignment = { horizontal: opts.left ? 'left' : 'center', wrapText: true, vertical: 'middle' };
    c.font = { bold: Boolean(opts.bold), size: opts.size || 10, color: { argb: opts.color || 'FF000000' } };
    return c;
  };

  title(1, 'Акт сверки', { bold: true, size: 16, color: DARK });
  title(2, `взаимных расчетов за период: ${ru(cp.opening_date)} - ${ru(cp.period_end)}`);
  title(3, `между ${orgFull} (ИНН ${orgInn})`);
  title(4, `и ${cpTitle(cp)}`);
  title(5, `по договору${isSupplier ? ':' : ''} ${cp.contract}`);
  a.getRow(7).height = 28;
  title(7, `Мы, нижеподписавшиеся, ${orgShort}, с одной стороны, и ${cp.name}, с другой стороны, `
    + 'составили настоящий акт сверки в том, что состояние взаимных расчетов по данным учета следующее:',
  { left: true, size: 9 });

  a.mergeCells('A9:D9');
  a.mergeCells('E9:H9');
  const side1 = a.getCell('A9');
  side1.value = `По данным ${orgShort} (ИНН ${orgInn}), руб.`;
  const side2 = a.getCell('E9');
  side2.value = `По данным ${cp.name}${cp.inn ? ` (ИНН ${cp.inn})` : ''}, руб.`;
  [side1, side2].forEach((c) => {
    c.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center', wrapText: true };
    fill(c, BROWN);
    box(c);
  });

  const cols = ['Дата', 'Документ', 'Дебет', 'Кредит', 'Дата', 'Документ', 'Дебет', 'Кредит'];
  const ch = a.getRow(10);
  cols.forEach((t, i) => {
    const c = ch.getCell(i + 1);
    c.value = t;
    c.font = { bold: true, size: 9 };
    c.alignment = { horizontal: 'center' };
    fill(c, SAND);
    box(c);
  });

  // Начальное сальдо (правая сторона остаётся для заполнения контрагентом)
  a.getCell('B11').value = `Сальдо начальное на ${ru(cp.opening_date)}`;
  a.getCell('B11').font = { bold: true, size: 9 };
  a.getCell('D11').value = { formula: `'Журнал операций'!G9`, result: round2(cp.opening_balance) };
  a.getCell('D11').numFmt = MONEY_FMT;
  a.getCell('F11').value = `Сальдо начальное на ${ru(cp.opening_date)}`;
  a.getCell('F11').font = { bold: true, size: 9 };
  a.getCell('G11').value = { formula: `'Журнал операций'!G9`, result: round2(cp.opening_balance) };
  a.getCell('G11').numFmt = MONEY_FMT;
  for (let c = 1; c <= 8; c++) box(a.getRow(11).getCell(c));

  const AFIRST = 12;
  ops.forEach((op, i) => {
    const r = AFIRST + i;
    const src = FIRST + i;
    const row = a.getRow(r);
    row.getCell(1).value = {
      formula: `IF(AND('Журнал операций'!E${src}="",'Журнал операций'!F${src}=""),"",'Журнал операций'!B${src})`,
      result: ruShort(op.date),
    };
    row.getCell(2).value = {
      formula: `IF(AND('Журнал операций'!E${src}="",'Журнал операций'!F${src}=""),"",'Журнал операций'!D${src})`,
      result: op.doc || '',
    };
    row.getCell(3).value = {
      formula: `IF('Журнал операций'!E${src}="","",'Журнал операций'!E${src})`,
      result: op.debit ? round2(op.debit) : '',
    };
    row.getCell(4).value = {
      formula: `IF('Журнал операций'!F${src}="","",'Журнал операций'!F${src})`,
      result: op.credit ? round2(op.credit) : '',
    };
    row.getCell(3).numFmt = MONEY_FMT;
    row.getCell(4).numFmt = MONEY_FMT;
    row.getCell(7).numFmt = MONEY_FMT;
    row.getCell(8).numFmt = MONEY_FMT;
    for (let c = 1; c <= 8; c++) {
      const cell = row.getCell(c);
      box(cell);
      cell.font = { size: 9 };
      if (i % 2 === 1) fill(cell, CREAM);
      if (c === 1 || c === 5) cell.alignment = { horizontal: 'center' };
    }
  });

  const aLast = AFIRST + ops.length - 1;
  const aTot = aLast + 1;
  a.getCell(`B${aTot}`).value = 'Обороты за период';
  a.getCell(`F${aTot}`).value = 'Обороты за период';
  a.getCell(`C${aTot}`).value = { formula: `SUM(C${AFIRST}:C${aLast})`, result: totalDebit };
  a.getCell(`D${aTot}`).value = { formula: `SUM(D${AFIRST}:D${aLast})`, result: totalCredit };
  a.getCell(`G${aTot}`).value = { formula: `SUM(G${AFIRST}:G${aLast})`, result: 0 };
  a.getCell(`H${aTot}`).value = { formula: `SUM(H${AFIRST}:H${aLast})`, result: 0 };
  for (let c = 1; c <= 8; c++) {
    const cell = a.getRow(aTot).getCell(c);
    fill(cell, SAND);
    cell.font = { bold: true, size: 9 };
    cell.numFmt = MONEY_FMT;
    box(cell);
  }

  const aClose = aTot + 1;
  a.getCell(`B${aClose}`).value = `Сальдо конечное на ${ru(cp.period_end)}`;
  a.getCell(`F${aClose}`).value = `Сальдо конечное на ${ru(cp.period_end)}`;
  a.getCell(`D${aClose}`).value = { formula: `D11+D${aTot}-C${aTot}`, result: closingVal };
  a.getCell(`G${aClose}`).value = { formula: `H11+H${aTot}-G${aTot}`, result: 0 };
  for (let c = 1; c <= 8; c++) {
    const cell = a.getRow(aClose).getCell(c);
    fill(cell, DARK);
    cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    cell.numFmt = MONEY_FMT;
    box(cell);
  }

  // Итоговая формулировка: в чью пользу задолженность
  const closing = closingVal;
  const ourFavour = isSupplier ? closing < 0 : closing >= 0;
  const favourName = ourFavour ? orgFull : (cp.full_name || cp.name);
  const amount = Math.abs(closing);

  const rSide = aClose + 2;
  a.mergeCells(`A${rSide}:D${rSide}`);
  a.mergeCells(`E${rSide}:H${rSide}`);
  a.getCell(`A${rSide}`).value = `По данным ${orgShort}`;
  a.getCell(`E${rSide}`).value = `По данным ${cp.name}`;
  [a.getCell(`A${rSide}`), a.getCell(`E${rSide}`)].forEach((c) => {
    c.font = { bold: true, size: 9 };
    c.alignment = { horizontal: 'center' };
  });

  const rText = rSide + 1;
  a.getRow(rText).height = 30;
  title(rText, `на ${ru(cp.period_end)} задолженность в пользу ${favourName} `
    + `${formatRub(amount)} (${amountInWords(amount)}).`, { left: true, size: 10, bold: true });

  const rFrom = rText + 2;
  a.mergeCells(`A${rFrom}:D${rFrom}`);
  a.mergeCells(`E${rFrom}:H${rFrom}`);
  a.getCell(`A${rFrom}`).value = `От ${orgShort}`;
  a.getCell(`E${rFrom}`).value = `От ${cp.name}`;
  [a.getCell(`A${rFrom}`), a.getCell(`E${rFrom}`)].forEach((c) => {
    c.font = { bold: true, size: 9 };
  });

  const rSign = rFrom + 2;
  a.mergeCells(`A${rSign}:D${rSign}`);
  a.mergeCells(`E${rSign}:H${rSign}`);
  a.getCell(`A${rSign}`).value = `_______________ / ${org.signer || 'М. В. Сарычева'} /`;
  a.getCell(`E${rSign}`).value = `_______________ / ${cp.signer || '______________'} /`;
  [a.getCell(`A${rSign}`), a.getCell(`E${rSign}`)].forEach((c) => { c.font = { size: 9 }; });

  return wb.xlsx.writeBuffer();
}

module.exports = { buildAkt, ru, ruShort };
