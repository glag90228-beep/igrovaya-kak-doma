'use strict';

// Счёт на оплату (HTML → PDF). Классическая российская форма:
// «шапка-банк» получателя, реквизиты поставщика/покупателя, таблица позиций,
// «Без НДС», всего к оплате прописью, подписи Руководитель / Бухгалтер.

const { esc, ru, page, formatMoney, amountInWords } = require('./doc-html');
const { round2 } = require('./money');

/** doc: { number, date, items:[{name,qty,unit,price}], vat? (false=без НДС) } */
function buildSchetHtml({ org, cp, doc }) {
  const items = doc.items || [];
  const total = round2(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0));
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
        <tr class="total"><td colspan="5" class="r">Итого:</td><td class="r">${formatMoney(total)}</td></tr>
        <tr><td colspan="5" class="r">${doc.vat ? 'В том числе НДС:' : 'Без налога (НДС):'}</td>
            <td class="r">${doc.vat ? formatMoney(round2(total - total / 1.2)) : '—'}</td></tr>
        <tr class="total"><td colspan="5" class="r b">Всего к оплате:</td><td class="r b">${formatMoney(total)}</td></tr>
      </tbody>
    </table>

    <p class="b">Всего наименований ${n} на сумму ${formatMoney(total)} руб.</p>
    <p class="b">${amountInWords(total)}.</p>
    <p class="note">Оплата данного счёта означает согласие с условиями поставки товара
       (оказания услуг). Счёт действителен к оплате в течение 5 банковских дней.</p>

    <div class="sign">
      <div style="flex:1">Руководитель<div class="line">${esc(org.signer || '')}</div></div>
      <div style="flex:1">Бухгалтер<div class="line">${esc(org.signer || '')}</div></div>
    </div>`;

  return page(`Счёт на оплату № ${doc.number || '1'}`, body);
}

module.exports = { buildSchetHtml };
