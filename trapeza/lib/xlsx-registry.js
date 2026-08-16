'use strict';

/**
 * Реестр выписанных документов за период — Excel.
 *
 * Это то, чем бухгалтер закрывает месяц: список всего выписанного с
 * суммами, налогом и отметкой оплаты, чтобы сверить с клиентом и с банком.
 * Формат намеренно плоский — одна таблица, которую можно отсортировать и
 * отфильтровать в самом Excel, а не «красивая» вёрстка, которую сразу
 * ломает первая же сортировка.
 *
 * Суммы записаны числами, а не строками: иначе они не складываются и
 * файл бесполезен. Внизу — живая формула СУММ, чтобы после удаления
 * лишних строк итог пересчитался сам.
 */

const ExcelJS = require('exceljs');
const { round2, vatTotals } = require('./money');

const BROWN = 'FF2E3A8C';
const CREAM = 'FFF4F6FC';
const SAND = 'FFE3E8F8';
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
 * @param {object} p
 * @param {object} p.org организация
 * @param {Array}  p.docs документы (как отдаёт listDocs) с полем cpName
 * @param {string} p.from начало периода, ISO
 * @param {string} p.to   конец периода, ISO
 * @returns {Promise<Buffer>}
 */
async function buildRegistry({ org, docs, from, to }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Первичка';
  const s = wb.addWorksheet('Реестр', {
    views: [{ state: 'frozen', ySplit: 6 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  s.columns = [
    { key: 'date', width: 12 },
    { key: 'type', width: 26 },
    { key: 'num', width: 14 },
    { key: 'cp', width: 34 },
    { key: 'net', width: 14 },
    { key: 'vat', width: 13 },
    { key: 'total', width: 15 },
    { key: 'paid', width: 12 },
    { key: 'paidAt', width: 13 },
  ];

  s.mergeCells('A1:I1');
  const title = s.getCell('A1');
  title.value = `Реестр документов за период ${ru(from)} — ${ru(to)}`;
  title.font = { bold: true, size: 14, color: { argb: 'FF1F2760' } };

  s.mergeCells('A2:I2');
  s.getCell('A2').value = org.full_name || org.name || '';
  s.getCell('A2').font = { size: 11 };

  s.mergeCells('A3:I3');
  s.getCell('A3').value = `Всего документов: ${docs.length}`;
  s.getCell('A3').font = { size: 10, color: { argb: 'FF5A6172' } };

  const HEAD = ['Дата', 'Документ', 'Номер', 'Контрагент',
    'Без НДС', 'НДС', 'Всего', 'Оплата', 'Дата оплаты'];
  const headRow = s.getRow(5);
  HEAD.forEach((h, i) => {
    const c = headRow.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BROWN } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    box(c);
  });
  headRow.height = 26;

  let r = 6;
  for (const d of docs) {
    const payload = d.payload || {};
    const rate = payload.vatRate == null ? null : Number(payload.vatRate);
    const sums = vatTotals(payload.items || [], rate, Boolean(payload.priceIncludesVat));
    const row = s.getRow(r);
    row.getCell(1).value = ru(d.date);
    row.getCell(2).value = d.title || d.type;
    row.getCell(3).value = String(d.number || '');
    row.getCell(4).value = d.cpName || '';
    row.getCell(5).value = round2(sums.net || d.total || 0);
    row.getCell(6).value = sums.vat == null ? '—' : round2(sums.vat);
    row.getCell(7).value = round2(d.total || 0);
    row.getCell(8).value = d.paid_at ? 'оплачен' : 'не оплачен';
    row.getCell(9).value = d.paid_at ? ru(d.paid_at) : '';
    for (let c = 1; c <= 9; c += 1) {
      const cell = row.getCell(c);
      cell.font = { size: 10 };
      box(cell);
      if (c >= 5 && c <= 7 && typeof cell.value === 'number') {
        cell.numFmt = MONEY;
        cell.alignment = { horizontal: 'right' };
      }
      if (c === 1 || c === 3 || c === 8 || c === 9) cell.alignment = { horizontal: 'center' };
    }
    if (r % 2 === 0) {
      for (let c = 1; c <= 9; c += 1) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
      }
    }
    // Неоплаченное видно сразу — за этим и открывают реестр.
    if (!d.paid_at) {
      row.getCell(8).font = { size: 10, bold: true, color: { argb: 'FFB3261E' } };
    }
    r += 1;
  }

  if (!docs.length) {
    s.mergeCells(`A6:I6`);
    s.getCell('A6').value = 'За этот период документов нет';
    s.getCell('A6').alignment = { horizontal: 'center' };
    s.getCell('A6').font = { italic: true, color: { argb: 'FF5A6172' } };
    r = 7;
  }

  const totalRow = s.getRow(docs.length ? r : r + 0);
  totalRow.getCell(4).value = 'ИТОГО';
  for (const [col, letter] of [[5, 'E'], [6, 'F'], [7, 'G']]) {
    if (!docs.length) break;
    // Живая формула, а не число: после фильтрации и удаления строк
    // итог должен пересчитаться сам, иначе реестром нельзя пользоваться.
    totalRow.getCell(col).value = { formula: `SUM(${letter}6:${letter}${r - 1})` };
    totalRow.getCell(col).numFmt = MONEY;
  }
  for (let c = 1; c <= 9; c += 1) {
    const cell = totalRow.getCell(c);
    cell.font = { bold: true, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
    box(cell);
  }

  // Автофильтр по шапке: сортировка и отбор — обычная работа с реестром.
  if (docs.length) s.autoFilter = { from: 'A5', to: `I${r - 1}` };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildRegistry };
