'use strict';

/**
 * Акт сверки — печатная форма для просмотра.
 *
 * Зачем отдельно от xlsx-akt.js. Акт сверки у нас таблица Excel, и это
 * правильно: его дополняют, пересчитывают и правят у себя, а живые формулы
 * в нём — половина смысла. Но по временной ссылке (lib/doc-link.js) таблицу
 * открыть нельзя: браузер её не показывает, а предлагает скачать файл — и
 * контрагент видит окно «Загрузить файл?» от незнакомого сайта вместо
 * документа. Половина людей на этом закроет вкладку.
 *
 * Поэтому у акта два вида. Таблица уходит файлом в чат и почтой — тому, кто
 * будет считать. Эта форма открывается по ссылке — тому, кому надо
 * посмотреть и согласиться. Содержание одно и то же, и это важнее вёрстки:
 * если два вида разойдутся, спорить стороны будут по разным бумагам.
 *
 * Правая половина таблицы пустая намеренно — она для данных контрагента.
 * Так устроен любой акт сверки: каждая сторона заполняет свою половину, и
 * расхождение видно построчно.
 */

const {
  esc, ru, page, formatMoney, formatRub, amountInWords,
} = require('./doc-html');

/** ISO yyyy-mm-dd → dd.mm.yy — в таблице год занимает место зря. */
function ruShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : String(iso || '');
}

/** «ООО «Заря» (ИНН 7712345678, КПП 771201001)» */
function cpTitle(cp) {
  const bits = [];
  if (cp.inn) bits.push(`ИНН ${cp.inn}`);
  if (cp.kpp) bits.push(`КПП ${cp.kpp}`);
  if (cp.extra) bits.push(cp.extra);
  const name = cp.full_name || cp.name || '';
  return bits.length ? `${name} (${bits.join(', ')})` : name;
}

const CSS = `
  .akt { width: 100%; font-size: 10px; margin-top: 6px; }
  .akt th { background: #2e3a8c; color: #fff; font-weight: bold; padding: 4px 5px;
            border: 1px solid #2e3a8c; text-align: center; font-size: 9.5px; }
  .akt td { border: 1px solid #c3c9dc; padding: 3px 5px; }
  .akt .side { background: #f4f6fc; font-weight: bold; text-align: center;
               font-size: 10px; padding: 5px; }
  .akt tbody tr:nth-child(even) td { background: #fbfcfe; }
  /* Итоговые строки: обороты светлее, сальдо — тёмное, как в таблице Excel.
     Человек, видевший оба вида, должен узнавать документ.

     Селектор нарочно длиннее, чем кажется нужным: правило чередования выше
     весит больше короткого «.akt .close td», и сальдо конечное, попав на
     чётную строку, оказывалось белым текстом на белом фоне. Строка с
     итоговой суммой просто исчезала — а ради неё акт и составляют. */
  .akt tbody tr.turn td { background: #e3e8f8; font-weight: bold; }
  .akt tbody tr.close td { background: #2e3a8c; color: #fff; font-weight: bold; }
  .akt .gap { border: 0; width: 10px; background: #fff !important; }
  .verdict { margin-top: 14px; font-weight: bold; font-size: 12px; }
  .sides { display: flex; gap: 30px; margin-top: 26px; }
  .sides > div { flex: 1; }
  .sides .who { font-weight: bold; font-size: 10.5px; }
  .sides .line { margin-top: 30px; font-size: 10.5px; }
`;

/**
 * @param {object} p.org   наша организация (org_full, org_short, org_inn, signer)
 * @param {object} p.cp    контрагент «как на период»: с opening_balance,
 *                         opening_date и period_end (см. bot-db.cpForPeriod)
 * @param {Array}  p.ops   операции периода: {date, doc, debit, credit}
 */
function buildAktHtml({ org, cp, ops = [] }) {
  const isSupplier = cp.kind === 'supplier';
  const orgShort = org.org_short || org.name || '';
  const orgFull = org.org_full || orgShort;
  const orgInn = org.org_inn || org.inn || '';

  const num = (v) => (Number(v) || 0);
  const totalDebit = ops.reduce((s, o) => s + num(o.debit), 0);
  const totalCredit = ops.reduce((s, o) => s + num(o.credit), 0);
  const opening = num(cp.opening_balance);
  const closing = opening + totalCredit - totalDebit;

  // Пустая ячейка вместо нуля: ноль в графе «дебет» читается как операция
  // на нулевую сумму, которой не было.
  const money = (v) => (num(v) ? formatMoney(num(v)) : '');
  const empty = '<td></td><td></td><td class="r"></td><td class="r"></td>';

  const rows = ops.map((op) => `<tr>
      <td class="c">${esc(ruShort(op.date))}</td>
      <td>${esc(op.doc || '')}</td>
      <td class="r">${money(op.debit)}</td>
      <td class="r">${money(op.credit)}</td>
      <td class="gap"></td>
      ${empty}
    </tr>`).join('');

  /*
   * В чью пользу долг. У поставщика знак обратный: там наш плюс означает,
   * что должны мы. Ошибиться здесь нельзя — это единственная фраза, ради
   * которой акт и подписывают.
   */
  const ourFavour = isSupplier ? closing < 0 : closing >= 0;
  const favourName = ourFavour ? orgFull : (cp.full_name || cp.name);
  const amount = Math.abs(closing);

  const body = `
    <h1 class="center">Акт сверки</h1>
    <p class="center small" style="margin:2px 0">взаимных расчётов за период:
       ${ru(cp.opening_date)} — ${ru(cp.period_end)}</p>
    <p class="center small" style="margin:2px 0">между ${esc(orgFull)}${orgInn ? ` (ИНН ${esc(orgInn)})` : ''}</p>
    <p class="center small" style="margin:2px 0">и ${esc(cpTitle(cp))}</p>
    ${cp.contract ? `<p class="center small" style="margin:2px 0">по договору ${esc(cp.contract)}</p>` : ''}
    <hr class="rule">

    <p class="small">Мы, нижеподписавшиеся, ${esc(orgShort)}, с одной стороны, и
       ${esc(cp.name)}, с другой стороны, составили настоящий акт сверки в том, что
       состояние взаимных расчётов по данным учёта следующее:</p>

    <table class="akt">
      <thead>
        <tr>
          <td class="side" colspan="4">По данным ${esc(orgShort)}${orgInn ? ` (ИНН ${esc(orgInn)})` : ''}, руб.</td>
          <td class="gap"></td>
          <td class="side" colspan="4">По данным ${esc(cp.name)}${cp.inn ? ` (ИНН ${esc(cp.inn)})` : ''}, руб.</td>
        </tr>
        <tr>
          <th style="width:52px">Дата</th><th>Документ</th>
          <th style="width:74px">Дебет</th><th style="width:74px">Кредит</th>
          <th class="gap"></th>
          <th style="width:52px">Дата</th><th>Документ</th>
          <th style="width:74px">Дебет</th><th style="width:74px">Кредит</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td></td><td>Сальдо начальное на ${ru(cp.opening_date)}</td>
          <td class="r"></td><td class="r">${money(opening)}</td>
          <td class="gap"></td>
          <td></td><td>Сальдо начальное на ${ru(cp.opening_date)}</td>
          <td class="r"></td><td class="r"></td>
        </tr>
        ${rows}
        <tr class="turn">
          <td></td><td>Обороты за период</td>
          <td class="r">${formatMoney(totalDebit)}</td>
          <td class="r">${formatMoney(totalCredit)}</td>
          <td class="gap"></td>
          <td></td><td>Обороты за период</td>
          <td class="r"></td><td class="r"></td>
        </tr>
        <tr class="close">
          <td></td><td>Сальдо конечное на ${ru(cp.period_end)}</td>
          <td class="r"></td><td class="r">${formatMoney(closing)}</td>
          <td class="gap"></td>
          <td></td><td>Сальдо конечное на ${ru(cp.period_end)}</td>
          <td class="r"></td><td class="r"></td>
        </tr>
      </tbody>
    </table>

    <p class="verdict">На ${ru(cp.period_end)} задолженность в пользу
       ${esc(favourName)} ${formatRub(amount)} (${esc(amountInWords(amount))}).</p>

    <div class="sides">
      <div>
        <div class="who">От ${esc(orgShort)}</div>
        <div class="line">_______________ / ${esc(org.signer || '')} /</div>
      </div>
      <div>
        <div class="who">От ${esc(cp.name)}</div>
        <div class="line">_______________ / ${esc(cp.signer || '______________')} /</div>
      </div>
    </div>

    <p class="note">Правая половина заполняется контрагентом. Если расхождений нет —
       подпишите и пришлите скан в ответ; если что-то не сходится, укажите строку.</p>`;

  return page(`Акт сверки ${ru(cp.opening_date)} — ${ru(cp.period_end)}`, body)
    .replace('</style>', `${CSS}</style>`);
}

module.exports = { buildAktHtml, cpTitle, ruShort };
