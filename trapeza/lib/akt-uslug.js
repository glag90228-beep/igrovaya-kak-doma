'use strict';

// Акт об оказании услуг (HTML → PDF). Формат «Трапезы»:
// Заказчик слева, Исполнитель справа, наименование ИП прописью CAPS, без М.П.,
// таблица услуг, сумма прописью, при необходимости — признание задолженности.

const { esc, ru, page, fxHtml, formatMoney, amountInWords } = require('./doc-html');
const { round2, vatTotals, rateLabel } = require('./money');

function party(org) {
  const bits = [];
  if (org.inn) bits.push(`ИНН ${esc(org.inn)}`);
  if (org.kpp) bits.push(`КПП ${esc(org.kpp)}`);
  const line2 = bits.join(', ');
  return { title: esc(org.full_name || org.name), sub: line2, addr: esc(org.address || '') };
}

/** doc: { number, date, subtitle?, items:[{name,qty,unit,price}], recognizeDebt?, note? } */
function buildAktUslugHtml({ org, cp, doc }) {
  const items = doc.items || [];
  /*
   * Итог считаем через vatTotals, а не сложением произведений.
   *
   * Своя арифметика здесь молча расходилась с журналом: doc-service считает
   * тот же документ с учётом ставки, а бланк печатал сумму без налога. При
   * НДС 20% сверху контрагент подписывал акт на 100 000, а в учёте и в
   * подписи к файлу стояло 120 000 — и долг был на 120 000. Ставка
   * попадает сюда через extra счёта, от которого заведён ежемесячный акт.
   */
  /*
   * «Итого» обязано сходиться со столбцом «Сумма» — то же правило, что в счёте.
   *
   * Раньше строки печатали qty × price, а ИТОГО брало total с налогом: при
   * ставке 22% сверху столбец давал 1 000,00, а ИТОГО — 1 220,00, и лишние
   * 220 рублей появлялись из ниоткуда. Слова «НДС» в акте при этом не было
   * вовсе, так что объяснить расхождение было нечем — а подписывает документ
   * живой человек, и первым делом он складывает столбец.
   *
   * Раскладка та же, что в lib/schet.js:
   *   цены с НДС  → в столбце уже полная сумма, Итого = всего;
   *   НДС сверху  → в столбце сумма без налога, Итого = без налога,
   *                 и налог добавляется отдельной строкой.
   */
  const rate = doc.vatRate == null ? null : Number(doc.vatRate);
  const gross = Boolean(doc.priceIncludesVat);
  const { net, vat, total } = vatTotals(items, rate, gross);
  // Строка «Итого» под столбцом: при налоге сверху столбец — это net.
  const column = rate == null || gross ? total : net;
  const ispoln = party({ ...org, full_name: (org.full_name || org.name || '').toUpperCase() });
  const zakaz = party(cp);

  const rows = items.map((it, i) => {
    const sum = round2((Number(it.qty) || 0) * (Number(it.price) || 0));
    return `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name)}</td>
      <td class="c">${esc(it.qty ?? '')}</td>
      <td class="c">${esc(it.unit || 'усл.')}</td>
      <td class="r">${formatMoney(it.price)}</td>
      <td class="r">${formatMoney(sum)}</td>
    </tr>`;
  }).join('');

  const debt = doc.recognizeDebt
    ? `<p class="note b">Стороны подтверждают, что на дату подписания настоящего акта
        задолженность Заказчика перед Исполнителем составляет
        ${formatMoney(total)} руб. (${amountInWords(total)}).</p>`
    : '';

  const body = `
    <h1 class="center">АКТ № ${esc(doc.number || '1')}</h1>
    <p class="center">${esc(doc.subtitle || 'об оказании услуг')}</p>
    <p class="center muted small">г. ${esc(org.city || 'Ижевск')} · ${ru(doc.date)}</p>
    <hr class="rule">

    <table class="reqs">
      <tr>
        <td class="k">Заказчик</td>
        <td>${zakaz.title}${zakaz.sub ? `<br><span class="small muted">${zakaz.sub}</span>` : ''}${zakaz.addr ? `<br><span class="small muted">${zakaz.addr}</span>` : ''}</td>
        <td class="k">Исполнитель</td>
        <td>${ispoln.title}${ispoln.sub ? `<br><span class="small muted">${ispoln.sub}</span>` : ''}${ispoln.addr ? `<br><span class="small muted">${ispoln.addr}</span>` : ''}</td>
      </tr>
    </table>

    <table class="items">
      <thead><tr>
        <th style="width:32px">№</th><th>Наименование работ, услуг</th>
        <th style="width:60px">Кол-во</th><th style="width:52px">Ед.</th>
        <th style="width:90px">Цена, руб.</th><th style="width:100px">Сумма, руб.</th>
      </tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="6" class="c muted">— нет позиций —</td></tr>'}
        <tr class="total"><td colspan="5" class="r">ИТОГО:</td><td class="r">${formatMoney(column)}</td></tr>
        ${rate == null ? `
        <tr class="total"><td colspan="5" class="r">Без налога (НДС):</td><td class="r">—</td></tr>` : `
        <tr class="total"><td colspan="5" class="r">${gross ? 'В том числе НДС' : 'НДС'} (${esc(rateLabel(rate))}):</td><td class="r">${formatMoney(vat)}</td></tr>
        <tr class="total"><td colspan="5" class="r b">Всего:</td><td class="r b">${formatMoney(total)}</td></tr>`}
      </tbody>
    </table>

    <p class="b">Всего оказано услуг на сумму: ${formatMoney(total)} руб. (${amountInWords(total)})${rate == null ? ', без НДС' : `, в т.ч. НДС ${esc(rateLabel(rate))} — ${formatMoney(vat)} руб.`}.</p>
    <p class="note">Вышеперечисленные услуги выполнены полностью и в срок. Заказчик претензий
       по объёму, качеству и срокам оказания услуг не имеет.</p>
    ${doc.note ? `<p class="note">${esc(doc.note)}</p>` : ''}
    ${debt}

    <div class="two">
      <div>
        <div class="b">Заказчик</div>
        <div class="small muted">${zakaz.title}</div>
        <div class="sign"><div style="flex:1"><div class="line">подпись / расшифровка</div></div></div>
      </div>
      <div>
        <div class="b">Исполнитель</div>
        <div class="small muted">${ispoln.title}</div>
        <div class="sign"><div style="flex:1"><div class="line">${fxHtml(org.fx, { stamp: true })}${esc(org.signer || '')} </div></div></div>
      </div>
    </div>`;

  return page(`Акт № ${doc.number || '1'} об оказании услуг`, body);
}

module.exports = { buildAktUslugHtml };
