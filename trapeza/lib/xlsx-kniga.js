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
 *   • корректировочные счета-фактуры на УВЕЛИЧЕНИЕ стоимости — тоже код 01:
 *     код 18 в перечне ФНС означает уменьшение, и у продавца такая запись идёт
 *     в книгу покупок, а не сюда.
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

/**
 * Номер колонки → буква Excel (1 → A, 27 → AA).
 *
 * Нужна потому, что число граф книги плавает: под каждую встретившуюся за
 * период ставку заводится своя пара колонок. Все объединения и формулы итога
 * считают правый край через неё, иначе шапка обрежется на десятой колонке, а
 * итоги не накроют графы последней ставки.
 */
const letterOf = (i) => (i <= 26
  ? String.fromCharCode(64 + i)
  : String.fromCharCode(64 + Math.floor((i - 1) / 26)) + String.fromCharCode(65 + ((i - 1) % 26)));

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
    /*
     * Код 01, а не 18.
     *
     * 18 в перечне ФНС (приказ от 14.03.2016 № ММВ-7-3/136@) — это
     * корректировка в сторону УМЕНЬШЕНИЯ, и у продавца такая запись идёт в
     * книгу ПОКУПОК. Корректировочный на увеличение продавец регистрирует в
     * книге продаж с кодом 01 — тем же, что и обычную отгрузку.
     *
     * Ошибка здесь не косметическая: код уходит в раздел 9 декларации, а
     * покупатель по тому же документу поставит 01. АСК НДС-2 сводит пары по
     * коду — пара не сойдётся, и требование пояснений придёт обеим сторонам.
     */
    /*
     * Номер и дата корректировочного идут в графу 5, а не в графу 3.
     *
     * В приложении 5 к постановлению № 1137 это разные графы: 3 — номер и
     * дата счёта-фактуры продавца, 5 — корректировочного. Мы же писали номер
     * любого документа в графу 3, и корректировочный ложился туда, где
     * инспекция ждёт обычный счёт-фактуру. АСК НДС-2 сводит пары по этим
     * графам: у покупателя корректировочный стоит в своей, у продавца — в
     * чужой, пара не сходится, и требование пояснений приходит обеим
     * сторонам. В графу 3 при этом идёт исходный счёт-фактура — тот, что
     * корректируем: он в payload как base.
     */
    const base = p.base || {};
    return {
      code: '01',
      net: up.net,
      vat: up.vat,
      total: up.total,
      rate,
      sfNo: base.number ? `${base.number} от ${ru(base.date)}` : '',
      ksfNo: `${doc.number} от ${ru(doc.date)}`,
    };
  }

  // Отгрузка. Счётом-фактурой у нас работает только УПД со статусом 1.
  if (doc.type === 'upd' && Number(p.status) === 1 && rate != null) {
    const t = vatTotals(p.items || [], rate, Boolean(p.priceIncludesVat));
    /*
     * Графа 4 — номер и дата ИСПРАВЛЕНИЯ счёта-фактуры. Исправление не
     * заводит новый документ: номер и дата остаются прежними, к ним лишь
     * добавляется своё (п. 7 приложения 1 к № 1137), — поэтому оно и живёт
     * отдельной графой рядом с исходной, а не вместо неё.
     */
    return {
      code: '01',
      net: t.net,
      vat: t.vat,
      total: t.total,
      rate,
      fixNo: p.fix && p.fix.no ? `${p.fix.no} от ${ru(p.fix.date)}` : '',
    };
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

  /*
   * Раскладка сумм по ставкам, а не одной колонкой.
   *
   * В книге продаж нет графы «ставка»: ставка выражается тем, в КАКУЮ графу
   * попала сумма. Отдельные графы заведены под 22%, под 20/18%, под 10%, под
   * 5% и 7% (для УСН) и под 0%. Прежняя редакция клала любую ставку в графы
   * 22-й — то есть выручку упрощенца по 5% отправляла в графу для 22%. Файл
   * при этом приглашал сверяться по номерам граф, так что бухгалтер перенёс
   * бы это в декларацию как есть.
   */
  const RATE_COL = {
    22: { net: 'Стоимость продаж без НДС, 22%', vat: 'Сумма НДС, 22%', netNo: '14', vatNo: '17' },
    20: { net: 'Стоимость продаж без НДС, 20%', vat: 'Сумма НДС, 20%', netNo: '14а', vatNo: '17а' },
    10: { net: 'Стоимость продаж без НДС, 10%', vat: 'Сумма НДС, 10%', netNo: '15', vatNo: '18' },
    7: { net: 'Стоимость продаж без НДС, 7%', vat: 'Сумма НДС, 7%', netNo: '15б', vatNo: '18б' },
    5: { net: 'Стоимость продаж без НДС, 5%', vat: 'Сумма НДС, 5%', netNo: '15а', vatNo: '18а' },
    0: { net: 'Стоимость продаж, 0%', vat: '', netNo: '16', vatNo: '' },
  };
  // Какие ставки реально встретились за период — под них и заводим графы,
  // иначе лист расползается на два десятка пустых колонок.
  const seen = [...new Set(docs.map(bookRow).filter(Boolean).map((x) => x.rate))]
    .filter((x) => RATE_COL[x]).sort((a2, b2) => b2 - a2);

  const cols = [
    ['№ п/п', 6, '1'],
    ['Код вида операции', 10, '2'],
    ['Номер и дата счёта-фактуры', 22, '3'],
    ['Номер и дата исправления', 20, '4'],
    ['Номер и дата корректировочного', 22, '5'],
    // Строка 5б отгрузочного счёта-фактуры переносится сюда: это машинная
    // пара к графе 7а книги покупок покупателя, ради неё всё и затевалось.
    ['Номер и дата СФ на аванс', 20, '11а'],
    ['Наименование покупателя', 30, '7'],
    ['ИНН/КПП покупателя', 18, '8'],
    ['Номер и дата документа об оплате', 20, '11'],
    ['Валюта', 10, '12'],
    ['Стоимость продаж с НДС', 18, '13б'],
  ];
  /*
   * Колонки ставок идут после постоянных, и начало этого блока считаем, а не
   * пишем числом. Раньше здесь стояло «10», и первая же новая графа в
   * постоянной части увела бы суммы на соседнюю колонку — молча, потому что
   * в Excel любое число ляжет в любую ячейку.
   */
  const FIXED = cols.length;
  cols.push(...seen.flatMap((rt) => (RATE_COL[rt].vat
    ? [[RATE_COL[rt].net, 20, RATE_COL[rt].netNo], [RATE_COL[rt].vat, 16, RATE_COL[rt].vatNo]]
    : [[RATE_COL[rt].net, 20, RATE_COL[rt].netNo]])));
  // Шапку объединяем уже зная, сколько колонок получилось: при двух ставках
  // их четырнадцать, и заголовок, обрезанный по J, оставлял хвост непокрытым.
  const last = letterOf(cols.length);

  ws.mergeCells(`A1:${last}1`);
  const title = ws.getCell('A1');
  title.value = `Книга продаж: ${org.full_name || org.name}, ИНН ${org.inn || '—'}`;
  title.font = { bold: true, size: 13, color: { argb: HEAD } };

  ws.mergeCells(`A2:${last}2`);
  ws.getCell('A2').value = `Период: ${ru(from)} — ${ru(to)}`;
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF666666' } };

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
  // бухгалтер сверяется с приложением 5 к постановлению № 1137. Берём их из
  // того же списка колонок, чтобы номер и колонка не разъехались.
  const nums = ws.getRow(5);
  cols.map(([, , no]) => no).forEach((n, i) => {
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
    const p2 = doc.payload || {};
    line.getCell(1).value = n;
    line.getCell(2).value = row.code;
    // Графа 3 — обычный счёт-фактура; у корректировочного здесь исходный,
    // а сам он уходит в графу 5. Графа 4 — исправление, если оно было.
    line.getCell(3).value = row.ksfNo ? row.sfNo : `${doc.number} от ${ru(doc.date)}`;
    line.getCell(4).value = row.fixNo || '';        // 4 — исправление СФ
    line.getCell(5).value = row.ksfNo || '';        // 5 — корректировочный СФ
    line.getCell(6).value = p2.advDoc || '';        // 11а — ссылка на аванс
    line.getCell(7).value = doc.cpName || '—';
    line.getCell(8).value = doc.cpInn || '—';
    line.getCell(9).value = p2.payDoc || '';        // 11 — документ об оплате
    line.getCell(10).value = 'руб.';
    line.getCell(11).value = row.total;
    line.getCell(11).numFmt = MONEY;
    // Суммы — строго в графы своей ставки: остальные остаются пустыми.
    const at = FIXED + 1 + seen.indexOf(row.rate) * 2;
    if (row.net != null) { line.getCell(at).value = row.net; line.getCell(at).numFmt = MONEY; }
    if (RATE_COL[row.rate] && RATE_COL[row.rate].vat) {
      line.getCell(at + 1).value = row.vat;
      line.getCell(at + 1).numFmt = MONEY;
    }
    for (let i = 1; i <= cols.length; i += 1) {
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
    ws.mergeCells(`A${r}:${last}${r}`);
    ws.getCell(`A${r}`).value = 'За период не выписано ни одного счёта-фактуры.';
    ws.getCell(`A${r}`).font = { italic: true, color: { argb: 'FF888888' } };
    r += 1;
  } else {
    // Формулы, а не готовые числа: бухгалтер удалит лишнюю строку — итог
    // пересчитается сам, и не придётся искать, почему он не сходится.
    const tot = ws.getRow(r);
    tot.getCell(1).value = 'Всего';
    tot.getCell(1).font = { bold: true };
    // Колонки берём по факту: их число зависит от того, сколько разных ставок
    // встретилось за период.
    for (let i = 9; i <= cols.length; i += 1) {
      const c = tot.getCell(i);
      c.value = { formula: `SUM(${letterOf(i)}6:${letterOf(i)}${r - 1})` };
      c.numFmt = MONEY;
      c.font = { bold: true };
    }
    for (let i = 1; i <= cols.length; i += 1) box(tot.getCell(i));
    r += 1;
  }

  r += 1;
  ws.mergeCells(`A${r}:${last}${r + 2}`);
  const note = ws.getCell(`A${r}`);
  note.value = 'Коды: 01 — отгрузка и корректировка на увеличение, 02 — полученная предоплата.\n'
    + 'Корректировки на уменьшение сюда не входят: у продавца это вычет, он отражается\n'
    + 'в книге покупок с кодом 18 (п. 13 ст. 171, п. 10 ст. 172 НК).\n'
    + 'Выгрузка для сверки: книга ведётся нарастающим итогом за квартал и подписывается.';
  note.font = { size: 9, color: { argb: 'FF666666' } };
  note.alignment = { wrapText: true, vertical: 'top' };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildKnigaProdazh, bookRow };
