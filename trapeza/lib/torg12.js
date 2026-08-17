'use strict';

/**
 * Товарная накладная ТОРГ-12 (унифицированная форма, постановление
 * Госкомстата № 132). Нужна тем, кто передаёт товар, а не услугу:
 * акт услуг такому покупателю не подойдёт.
 *
 * Форма альбомная и с длинной таблицей — вёрстка под ландшафтный А4.
 * Отпуск разрешил / отпустил / груз принял оформлены как в бланке.
 */

const { esc, ru, page, fxHtml, usnNote, formatMoney, amountInWords } = require('./doc-html');
const { round2, vatSplit, vatTotals, rateLabel } = require('./money');

const LAND = `
  @page { size: A4 landscape; }
  .t12 th, .t12 td { padding: 4px 5px; font-size: 10.5px; }
  .t12 .nm { min-width: 190px; }
  .who td { border: 1px solid #c3c9dc; padding: 5px 7px; vertical-align: top; }
  .who .k { background: #f4f6fc; font-weight: bold; width: 22%; }
  .foot { display: flex; gap: 22px; margin-top: 14px; }
  .foot > div { flex: 1; }
  .foot .row { margin-bottom: 14px; }
  .foot .line { border-top: 1px solid #333; margin-top: 22px; padding-top: 3px; font-size: 10px; }
`;

/** Плюрализация «мест»/«листов» — в бланке эти строки заполняются словами. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** @param doc { number, date, items:[{name,qty,unit,price,code?,weight?}], basis?, note? } */
function buildTorg12Html({ org, cp, doc }) {
  const items = doc.items || [];
  /*
   * НДС в накладной раньше не считался вовсе: в графе стояло «без НДС», а
   * итог печатался дважды одинаковым числом. Для плательщика НДС такая
   * накладная неверна — покупателю нечего принять к вычету. Ставку берём
   * ту же, что у остальных документов.
   */
  const rate = doc.vatRate == null ? null : Number(doc.vatRate);
  const gross = Boolean(doc.priceIncludesVat);
  const sums = vatTotals(items, rate, gross);
  const total = sums.total;
  const places = items.reduce((s, it) => s + (Number(it.qty) || 0), 0);

  const rows = items.map((it, i) => {
    const s1 = vatSplit(it, rate, gross);
    return `<tr>
      <td class="c">${i + 1}</td>
      <td class="nm">${esc(it.name)}</td>
      <td class="c">${esc(it.code || '')}</td>
      <td class="c">${esc(it.unit || 'шт.')}</td>
      <td class="c">${esc(it.qty ?? '')}</td>
      <td class="r">${formatMoney(s1.unitNet)}</td>
      <td class="r">${formatMoney(s1.net)}</td>
      <td class="c">${rate == null ? 'без НДС' : formatMoney(s1.vat)}</td>
      <td class="r">${formatMoney(s1.total)}</td>
    </tr>`;
  }).join('');

  const partyLine = (p) => `${esc(p.full_name || p.name)}`
    + (p.address ? `, ${esc(p.address)}` : '')
    + (p.inn ? `, ИНН ${esc(p.inn)}` : '')
    + (p.kpp ? `, КПП ${esc(p.kpp)}` : '')
    + (p.bank_name ? `<br><span class="small muted">${esc(p.bank_name)}`
      + `${p.bik ? `, БИК ${esc(p.bik)}` : ''}${p.acc ? `, р/с ${esc(p.acc)}` : ''}</span>` : '');

  const body = `
    <div class="brand">Унифицированная форма № ТОРГ-12</div>
    <h1 class="center" style="margin-top:6px">ТОВАРНАЯ НАКЛАДНАЯ № ${esc(doc.number || '1')} от ${ru(doc.date)}</h1>
    <hr class="rule">

    <table class="who">
      <tr><td class="k">Грузоотправитель</td><td colspan="3">${partyLine(org)}</td></tr>
      <tr><td class="k">Грузополучатель</td><td colspan="3">${partyLine(cp)}</td></tr>
      <tr><td class="k">Поставщик</td><td>${esc(org.full_name || org.name)}</td>
          <td class="k">Плательщик</td><td>${esc(cp.full_name || cp.name)}</td></tr>
      <tr><td class="k">Основание</td><td colspan="3">${esc(doc.basis || cp.contract || 'Без договора')}</td></tr>
    </table>

    <table class="items t12">
      <thead><tr>
        <th style="width:28px">№</th>
        <th class="nm">Товар (наименование, характеристика, сорт, артикул)</th>
        <th style="width:58px">Код</th>
        <th style="width:50px">Ед.</th>
        <th style="width:58px">Кол-во</th>
        <th style="width:86px">Цена, руб. коп.</th>
        <th style="width:96px">Сумма без учёта НДС</th>
        <th style="width:62px">НДС</th>
        <th style="width:100px">Сумма с учётом НДС</th>
      </tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="9" class="c muted">— нет позиций —</td></tr>'}
        <tr class="total"><td colspan="6" class="r">Всего по накладной:</td>
            <td class="r">${formatMoney(sums.net)}</td>
            <td class="c">${sums.vat == null ? '—' : formatMoney(sums.vat)}</td>
            <td class="r">${formatMoney(sums.total)}</td></tr>
      </tbody>
    </table>

    <p class="b">Всего наименований ${items.length},
       на сумму ${formatMoney(total)} руб.</p>
    <p class="b">${amountInWords(total)}.</p>
    <p class="small">Всего мест: ${places} ${plural(places, 'место', 'места', 'мест')}.
       Отпущено ${items.length} ${plural(items.length, 'наименование', 'наименования', 'наименований')}.</p>
    ${rate == null ? usnNote(org)
      : `<p class="note">Сумма НДС по ставке ${esc(rateLabel(rate))} —
         ${formatMoney(sums.vat)} руб.${gross ? ' Цены пересчитаны из цен с налогом.' : ''}</p>`}
    ${doc.note ? `<p class="note">${esc(doc.note)}</p>` : ''}

    <div class="foot">
      <div>
        <div class="row"><b>Отпуск груза разрешил</b>
          <div class="line">${fxHtml(org.fx, { stamp: true, tight: true })}${esc(org.signer || '')}</div></div>
        <div class="row"><b>Отпуск груза произвёл</b>
          <div class="line">должность, подпись, расшифровка</div></div>
        <div class="small">Дата отпуска: <b>${ru(doc.date)}</b></div>
      </div>
      <div>
        <div class="row"><b>Груз принял</b>
          <div class="line">должность, подпись, расшифровка</div></div>
        <div class="row"><b>Груз получил грузополучатель</b>
          <div class="line">${esc(cp.signer || 'должность, подпись, расшифровка')}</div></div>
        <div class="small">Дата получения: <b>_______________</b></div>
      </div>
    </div>`;

  return page(`Товарная накладная № ${doc.number || '1'}`, body).replace('</style>', `${LAND}</style>`);
}

module.exports = { buildTorg12Html };
