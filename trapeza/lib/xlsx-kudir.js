'use strict';

/**
 * Книга учёта доходов — Excel по форме ФНС.
 *
 * Форма утверждена приказом ФНС от 07.11.2023 № ЕА-7-3/816@: приложение 2 —
 * книга для УСН, приложение 3 — книга учёта доходов для патента. Формы
 * разные, и подменять одну другой нельзя: у патента четыре графы и одна
 * таблица, у УСН пять граф и отдельная таблица на каждый квартал.
 *
 * Нумерация в книге УСН — СКВОЗНАЯ через все четыре квартала, а не своя в
 * каждой таблице. Закончился первый квартал на 58-й операции — второй
 * начинается с 59-й. Это не косметика: доход считается нарастающим итогом, и
 * нумерация с начала в каждой таблице ломает сверку с декларацией.
 *
 * Итоги после кварталов тоже не одинаковые. После первого — «Итого за I
 * квартал», после второго — сначала свой квартал, потом «Итого за полугодие»
 * нарастающим, после третьего — «за 9 месяцев», после четвёртого — «за год».
 *
 * Отдельный лист «Не разнесено» появляется, когда в выписке остались
 * поступления, которые модуль не взялся классифицировать. Он намеренно
 * первым бросается в глаза: книга, выгруженная с молча пропущенными
 * строками, выглядит готовой и таковой не является.
 */

const ExcelJS = require('exceljs');
const { round2 } = require('./money');

const HEAD = 'FF2E3A8C';
const CREAM = 'FFF4F6FC';
const WARN = 'FFFDECE8';

const MONEY = '#,##0.00';

/** Названия кварталов так, как они напечатаны в форме. */
const QUARTERS = [
  { n: 1, label: 'I квартал', total: 'Итого за I квартал', cum: '' },
  { n: 2, label: 'II квартал', total: 'Итого за II квартал', cum: 'Итого за полугодие' },
  { n: 3, label: 'III квартал', total: 'Итого за III квартал', cum: 'Итого за 9 месяцев' },
  { n: 4, label: 'IV квартал', total: 'Итого за IV квартал', cum: 'Итого за год' },
];

const quarterOf = (iso) => {
  const m = Number(String(iso || '').slice(5, 7));
  return m ? Math.ceil(m / 3) : 0;
};

/** 12 цифр ИНН — предприниматель, 10 — организация (как в lib/doc-html.js). */
const isIp = (inn) => String(inn || '').replace(/\D/g, '').length === 12;

function title(ws, text) {
  const row = ws.addRow([text]);
  row.font = { bold: true, size: 12, color: { argb: HEAD } };
  row.height = 20;
  return row;
}

function field(ws, label, value) {
  const row = ws.addRow([label, value]);
  row.getCell(1).font = { size: 9, color: { argb: 'FF6B7280' } };
  row.getCell(2).font = { size: 11 };
  row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  return row;
}

/* ------------------------------------------------------------------ *
 * Титульный лист
 * ------------------------------------------------------------------ */

function addTitleSheet(wb, { org, year, mode, objectName }) {
  const ws = wb.addWorksheet('Титульный лист', {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [{ width: 34 }, { width: 62 }];

  title(ws, mode === 'psn'
    ? 'КНИГА УЧЁТА ДОХОДОВ индивидуального предпринимателя, применяющего патентную систему налогообложения'
    : 'КНИГА УЧЁТА ДОХОДОВ И РАСХОДОВ организаций и индивидуальных предпринимателей, применяющих упрощённую систему налогообложения');
  ws.getRow(1).alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(1).height = 46;
  ws.mergeCells('A1:B1');
  ws.addRow([]);

  field(ws, 'на', `${year} год`);
  field(ws, 'Налогоплательщик', org.full_name || org.name || '');
  field(ws, 'ИНН', org.inn || '');
  if (mode !== 'psn') field(ws, 'Объект налогообложения', objectName || 'доходы');
  field(ws, isIp(org.inn) ? 'Адрес места жительства' : 'Адрес места нахождения', org.address || '');

  /*
   * Счета и банки — обязательная часть титульного листа: в ней перечисляются
   * все расчётные счета, используемые в деятельности. Мы знаем один, из
   * карточки организации; если их больше, человек дописывает руками, и об
   * этом сказано прямо в файле, а не в справке где-то отдельно.
   */
  field(ws, 'Номер расчётного счёта', org.acc || '');
  field(ws, 'Банк', org.bank_name || '');
  field(ws, '', 'Если счетов больше одного — допишите остальные здесь же: на титульном листе перечисляются все счета, используемые в деятельности.');
  ws.lastRow.getCell(2).font = { size: 9, italic: true, color: { argb: 'FF8A6100' } };

  field(ws, 'Единица измерения', 'руб. (код по ОКЕИ — 383)');
  ws.addRow([]);

  const note = ws.addRow(['', 'Форма по приказу ФНС от 07.11.2023 № ЕА-7-3/816@']);
  note.getCell(2).font = { size: 9, color: { argb: 'FF6B7280' } };
  return ws;
}

/* ------------------------------------------------------------------ *
 * Раздел с доходами
 * ------------------------------------------------------------------ */

function headerRow(ws, mode) {
  const cells = mode === 'psn'
    ? ['№ п/п', 'Дата и номер первичного документа', 'Содержание операции', 'Доходы']
    : ['№ п/п', 'Дата и номер первичного документа', 'Содержание операции',
      'Доходы, учитываемые при исчислении налоговой базы',
      'Расходы, учитываемые при исчислении налоговой базы'];
  const row = ws.addRow(cells);
  row.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
  row.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
  row.height = 40;
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });
  // Номера граф под шапкой — они есть в бланке и на них ссылаются проверяющие.
  const nums = ws.addRow(mode === 'psn' ? ['1', '2', '3', '4'] : ['1', '2', '3', '4', '5']);
  nums.font = { size: 8, color: { argb: 'FF6B7280' } };
  nums.alignment = { horizontal: 'center' };
  return row;
}

function dataRow(ws, r, mode) {
  const cells = mode === 'psn'
    ? [r.n, r.basis, r.what, r.amount]
    : [r.n, r.basis, r.what, r.amount, null];
  const row = ws.addRow(cells);
  row.getCell(1).alignment = { horizontal: 'center' };
  row.getCell(4).numFmt = MONEY;
  if (mode !== 'psn') row.getCell(5).numFmt = MONEY;
  row.eachCell((c) => {
    c.font = { size: 10 };
    c.border = { top: { style: 'hair' }, bottom: { style: 'hair' }, left: { style: 'hair' }, right: { style: 'hair' } };
  });
  row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  return row;
}

function totalRow(ws, label, sum, mode, strong) {
  const width = mode === 'psn' ? 4 : 5;
  const cells = new Array(width).fill(null);
  cells[2] = label;
  cells[3] = round2(sum);
  const row = ws.addRow(cells);
  row.font = { bold: true, size: 10, color: { argb: strong ? HEAD : 'FF1A201C' } };
  row.getCell(4).numFmt = MONEY;
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
  });
  row.getCell(3).alignment = { horizontal: 'right' };
  return row;
}

function addIncomeSheet(wb, { rows, mode, year }) {
  const ws = wb.addWorksheet(mode === 'psn' ? 'Доходы' : 'Раздел I', {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = mode === 'psn'
    ? [{ width: 7 }, { width: 30 }, { width: 46 }, { width: 16 }]
    : [{ width: 7 }, { width: 30 }, { width: 42 }, { width: 18 }, { width: 18 }];

  title(ws, mode === 'psn'
    ? `Учёт доходов за ${year} год`
    : `I. Доходы и расходы за ${year} год`);

  /*
   * У патента — одна таблица. Разбивать её по кварталам нельзя: в форме
   * приложения 3 такого деления нет, а лишние итоги в налоговом регистре
   * это не «подробнее», а расхождение с бланком.
   */
  if (mode === 'psn') {
    headerRow(ws, mode);
    for (const r of rows) dataRow(ws, r, mode);
    totalRow(ws, 'Итого за налоговый период', rows.reduce((s, r) => round2(s + r.amount), 0), mode, true);
    return ws;
  }

  let cum = 0;
  for (const q of QUARTERS) {
    const part = rows.filter((r) => quarterOf(r.date) === q.n);
    ws.addRow([]);
    const cap = ws.addRow([q.label]);
    cap.font = { bold: true, size: 11 };

    headerRow(ws, mode);
    for (const r of part) dataRow(ws, r, mode);

    const sum = part.reduce((s, r) => round2(s + r.amount), 0);
    cum = round2(cum + sum);
    totalRow(ws, q.total, sum, mode, false);
    if (q.cum) totalRow(ws, q.cum, cum, mode, true);
  }
  return ws;
}

/* ------------------------------------------------------------------ *
 * Лист с неразнесёнными поступлениями
 * ------------------------------------------------------------------ */

function addAskSheet(wb, ask) {
  const ws = wb.addWorksheet('Не разнесено', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [{ width: 12 }, { width: 15 }, { width: 28 }, { width: 44 }, { width: 46 }];

  const t = title(ws, `Не разнесено: ${ask.length} ${ask.length === 1 ? 'поступление' : 'поступлений'}`);
  t.font = { bold: true, size: 12, color: { argb: 'FFA33322' } };

  const warn = ws.addRow(['Книга без этих строк не полна. Разберите каждую и добавьте в раздел вручную либо исключите — сумма налога зависит от этого решения.']);
  warn.getCell(1).font = { size: 10, color: { argb: 'FFA33322' } };
  ws.mergeCells(`A${warn.number}:E${warn.number}`);
  warn.height = 28;
  warn.alignment = { wrapText: true, vertical: 'middle' };
  ws.addRow([]);

  const head = ws.addRow(['Дата', 'Сумма', 'Контрагент', 'Назначение платежа', 'Почему не разнесено']);
  head.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA33322' } };
  });

  for (const a of ask) {
    const row = ws.addRow([a.date, round2(a.amount), a.name || '', a.purpose || '', a.reason]);
    row.getCell(2).numFmt = MONEY;
    row.alignment = { wrapText: true, vertical: 'top' };
    row.eachCell((c) => {
      c.font = { size: 10 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARN } };
    });
  }
  return ws;
}

/* ------------------------------------------------------------------ *
 * Сборка
 * ------------------------------------------------------------------ */

/**
 * @param {object} p
 * @param {object} p.org    карточка организации
 * @param {object} p.book   результат buildIncomeBook из lib/kudir.js
 * @param {number} p.year   год книги
 * @param {string} p.mode   'usn' | 'psn'
 * @returns {Promise<Buffer>}
 */
async function buildKudir({ org, book, year, mode = 'usn' }) {
  if (book && book.blocked) {
    throw new Error(book.blocked);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Первичка';
  wb.created = new Date();

  const rows = (book && book.rows) || [];
  const ask = (book && book.ask) || [];

  /*
   * Лист с вопросами идёт ПЕРВЫМ, когда вопросы есть. Человек открывает
   * файл и сразу видит, что книга не закончена, а не находит это через
   * месяц при сверке с декларацией.
   */
  if (ask.length) addAskSheet(wb, ask);

  addTitleSheet(wb, { org: org || {}, year, mode, objectName: 'доходы' });
  addIncomeSheet(wb, { rows, mode, year });

  /*
   * Строка про прошивку — та самая, которую пишут от руки на обороте
   * последнего листа. Печатаем заготовку: заверять книгу в налоговой с
   * 2013 года не нужно, а прошить и подписать — нужно, и про это забывают.
   */
  const last = wb.worksheets[wb.worksheets.length - 1];
  last.addRow([]);
  last.addRow([]);
  const bind = last.addRow(['', 'В книге пронумеровано и прошнуровано ______ страниц']);
  bind.getCell(2).font = { size: 10 };
  const sign = last.addRow(['', `${isIp(org && org.inn) ? 'Индивидуальный предприниматель' : 'Руководитель организации'}  ____________  ${(org && org.signer) || ''}`]);
  sign.getCell(2).font = { size: 10 };
  const dt = last.addRow(['', 'Дата  «____» ______________ 20___ г.']);
  dt.getCell(2).font = { size: 10 };

  return wb.xlsx.writeBuffer();
}

module.exports = { buildKudir, quarterOf, QUARTERS };
