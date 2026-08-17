'use strict';

// Счёт на оплату (HTML → PDF). Классическая российская форма:
// «шапка-банк» получателя, реквизиты поставщика/покупателя, таблица позиций,
// «Без НДС», всего к оплате прописью, подписи (у ИП — одна, см. signRows).

const { esc, ru, page, fxHtml, signRows, formatMoney, amountInWords } = require('./doc-html');
const { round2, vatTotals, rateLabel } = require('./money');
const { payQrSvg } = require('./qr-pay');

/**
 * doc: { number, date, items:[{name,qty,unit,price}],
 *        vatRate (20|10|0|null — null значит «без НДС»),
 *        priceIncludesVat (цены уже с налогом) }
 */
function buildSchetHtml({ org, cp, doc }) {
  const items = doc.items || [];
  const rate = doc.vatRate == null ? null : Number(doc.vatRate);
  const gross = Boolean(doc.priceIncludesVat);
  // net — без налога, total — к оплате. При «НДС сверху» они различаются,
  // и в счёте платить надо именно total, иначе контрагент недоплатит.
  // «Итого» обязано совпадать с суммой колонки «Сумма», иначе бухгалтер
  // получателя первым делом спросит, почему столбец не сходится:
  //   цены с НДС → в колонке уже полная сумма, Итого = всего к оплате;
  //   НДС сверху → в колонке сумма без налога, Итого = без налога.
  const { net, vat, total } = vatTotals(items, rate, gross);
  const n = items.length;

  const rows = items.map((it, i) => {
    const sum = round2((Number(it.qty) || 0) * (Number(it.price) || 0));
    return `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name)}</td>
      <td class="c">${esc(it.qty ?? '')}</td>
      <td class="c">${esc(it.unit || 'шт.')}</td>
      <td class="r">${formatMoney(it.price)}</td>
      <td class="r">${formatMoney(sum)}</td>
    </tr>`;
  }).join('');

  // Платёжный QR: рисуем, только если реквизитов хватает на рабочую строку.
  const svg = doc.qr === false ? null : payQrSvg({
    org, sum: total, payer: cp.full_name || cp.name,
    purpose: `Оплата по счёту № ${doc.number || '1'} от ${ru(doc.date)}`
      + (rate == null ? ', без НДС' : `, в т.ч. НДС ${rate}% — ${formatMoney(vat)} руб.`),
  }, { size: 150 });
  const qrBlock = svg
    ? `<div class="pay__qr">${svg}<div class="pay__cap">Оплата по QR<br>
         <span class="muted">наведите камеру в приложении банка</span></div></div>`
    : '';

  // Шапка с банковскими реквизитами получателя (поставщика)
  const bankBox = `
    <table class="reqs" style="margin-bottom:2px">
      <tr>
        <td rowspan="2">Банк получателя<br><b>${esc(org.bank_name || '—')}</b></td>
        <td class="k" style="width:70px">БИК</td>
        <td style="width:190px">${esc(org.bik || '—')}</td>
      </tr>
      <tr>
        <td class="k">Сч. №</td>
        <td>${esc(org.corr_acc || '—')}</td>
      </tr>
      <tr>
        <td>ИНН ${esc(org.inn || '—')}${org.kpp ? ` &nbsp; КПП ${esc(org.kpp)}` : ''}</td>
        <td class="k">Сч. №</td>
        <td>${esc(org.acc || '—')}</td>
      </tr>
      <tr>
        <td colspan="3">Получатель<br><b>${esc(org.full_name || org.name)}</b></td>
      </tr>
    </table>`;

  const body = `
    ${bankBox}
    <h1 class="center" style="margin-top:10px">Счёт на оплату № ${esc(doc.number || '1')} от ${ru(doc.date)}</h1>
    <hr class="rule">

    <table class="reqs">
      <tr><td class="k">Поставщик<br>(Исполнитель)</td>
          <td>${esc(org.full_name || org.name)}${org.inn ? `, ИНН ${esc(org.inn)}` : ''}${org.address ? `, ${esc(org.address)}` : ''}</td></tr>
      <tr><td class="k">Покупатель<br>(Заказчик)</td>
          <td>${esc(cp.full_name || cp.name)}${cp.inn ? `, ИНН ${esc(cp.inn)}` : ''}${cp.kpp ? `, КПП ${esc(cp.kpp)}` : ''}${cp.address ? `, ${esc(cp.address)}` : ''}</td></tr>
    </table>

    <table class="items">
      <thead><tr>
        <th style="width:32px">№</th><th>Товары (работы, услуги)</th>
        <th style="width:60px">Кол-во</th><th style="width:52px">Ед.</th>
        <th style="width:90px">Цена, руб.</th><th style="width:100px">Сумма, руб.</th>
      </tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="6" class="c muted">— нет позиций —</td></tr>'}
        <tr class="total"><td colspan="5" class="r">Итого:</td>
            <td class="r">${formatMoney(gross ? total : net)}</td></tr>
        <tr><td colspan="5" class="r">${rate == null
    ? 'Без налога (НДС):'
    : `${gross ? 'В том числе НДС' : 'НДС'} (${rateLabel(rate)}):`}</td>
            <td class="r">${rate == null ? '—' : formatMoney(vat)}</td></tr>
        <tr class="total"><td colspan="5" class="r b">Всего к оплате:</td><td class="r b">${formatMoney(total)}</td></tr>
      </tbody>
    </table>

    <div class="pay">
      <div class="pay__text">
        <p class="b">Всего наименований ${n} на сумму ${formatMoney(total)} руб.</p>
        <p class="b">${amountInWords(total)}.</p>
        <p class="note">Оплата данного счёта означает согласие с условиями поставки товара
           (оказания услуг). Счёт действителен к оплате в течение 5 банковских дней.</p>
      </div>
      ${qrBlock}
    </div>

    <div class="sign">
      ${signRows(org, (o) => fxHtml(org.fx, o))
        // Ширину ограничиваем: у предпринимателя строка одна, и без предела
        // линия для подписи растягивалась во весь лист.
        .map((r) => `<div style="flex:1;max-width:46%">${esc(r.title)}`
          + `<div class="line">${r.html}</div></div>`)
        .join('')}
    </div>`;

  return page(`Счёт на оплату № ${doc.number || '1'}`, body);
}

module.exports = { buildSchetHtml };
