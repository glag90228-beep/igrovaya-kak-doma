'use strict';

/**
 * УПД — универсальный передаточный документ (форма из письма ФНС ММВ-20-3/96@).
 *
 * Делаем **статус 2** — «передаточный документ (акт)», без счёта-фактуры.
 * Это осознанный выбор: наша аудитория — ИП и небольшие ООО на упрощёнке,
 * они не плательщики НДС и счёт-фактуру выставлять не должны. УПД со
 * статусом 1 требует полей счёта-фактуры (КПП грузоотправителя, код вида
 * товара, номер таможенной декларации) и ответственности за НДС — если
 * такой понадобится, это отдельная работа, а не галочка.
 *
 * Лист альбомный: у формы много колонок, в книжной ориентации они слипаются.
 */

const { esc, ru, page, formatMoney, amountInWords } = require('./doc-html');
const { round2 } = require('./money');

const LAND = `
  @page { size: A4 landscape; }
  .upd-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .upd-status { border: 2px solid #7a5230; padding: 6px 10px; text-align: center; min-width: 168px; }
  .upd-status b { display: block; font-size: 15px; color: #7a5230; }
  .upd-status .small { line-height: 1.25; }
  .items.upd th, .items.upd td { padding: 4px 5px; font-size: 10.5px; }
  .basis td { border: 1px solid #cbb9a5; padding: 5px 7px; }
  .basis .k { background: #faf6f1; font-weight: bold; width: 24%; }
  .transfer { display: flex; gap: 24px; margin-top: 12px; }
  .transfer > div { flex: 1; border: 1px solid #cbb9a5; padding: 8px 10px; }
  .transfer h3 { margin: 0 0 6px; font-size: 12px; color: #5e3f27; }
`;

/**
 * @param doc { number, date, items:[{name,qty,unit,price,code?}], basis?, transferDate?,
 *              shipper?, consignee?, note? }
 */
function buildUpdHtml({ org, cp, doc }) {
  const items = doc.items || [];
  const total = round2(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0));

  const rows = items.map((it, i) => {
    const sum = round2((Number(it.qty) || 0) * (Number(it.price) || 0));
    return `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name)}</td>
      <td class="c">${esc(it.code || '')}</td>
      <td class="c">${esc(it.unit || 'шт.')}</td>
      <td class="c">${esc(it.qty ?? '')}</td>
      <td class="r">${formatMoney(it.price)}</td>
      <td class="r">${formatMoney(sum)}</td>
      <td class="c">без НДС</td>
      <td class="c">—</td>
      <td class="r">${formatMoney(sum)}</td>
    </tr>`;
  }).join('');

  const partyLine = (p) => `${esc(p.full_name || p.name)}`
    + (p.address ? `, ${esc(p.address)}` : '')
    + (p.inn ? `, ИНН ${esc(p.inn)}` : '')
    + (p.kpp ? `, КПП ${esc(p.kpp)}` : '');

  const body = `
    <div class="upd-head">
      <div style="flex:1">
        <div class="brand">Универсальный передаточный документ</div>
        <h1 style="margin-top:4px">№ ${esc(doc.number || '1')} от ${ru(doc.date)}</h1>
      </div>
      <div class="upd-status">
        <b>Статус: 2</b>
        <span class="small">передаточный документ (акт)<br>без счёта-фактуры</span>
      </div>
    </div>
    <hr class="rule">

    <table class="basis">
      <tr><td class="k">Продавец</td><td colspan="3">${partyLine(org)}</td></tr>
      <tr><td class="k">Покупатель</td><td colspan="3">${partyLine(cp)}</td></tr>
      <tr>
        <td class="k">Грузоотправитель</td><td>${esc(doc.shipper || 'он же')}</td>
        <td class="k">Грузополучатель</td><td>${esc(doc.consignee || 'он же')}</td>
      </tr>
      <tr>
        <td class="k">Основание передачи</td>
        <td colspan="3">${esc(doc.basis || cp.contract || 'Без договора')}</td>
      </tr>
    </table>

    <table class="items upd">
      <thead><tr>
        <th style="width:28px">№</th>
        <th>Наименование товара (работ, услуг)</th>
        <th style="width:60px">Код</th>
        <th style="width:52px">Ед.</th>
        <th style="width:58px">Кол-во</th>
        <th style="width:82px">Цена, руб.</th>
        <th style="width:92px">Стоимость без налога</th>
        <th style="width:64px">Налоговая ставка</th>
        <th style="width:70px">Сумма налога</th>
        <th style="width:98px">Стоимость с налогом</th>
      </tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="10" class="c muted">— нет позиций —</td></tr>'}
        <tr class="total">
          <td colspan="6" class="r">Всего к оплате:</td>
          <td class="r">${formatMoney(total)}</td>
          <td class="c">—</td><td class="c">—</td>
          <td class="r">${formatMoney(total)}</td>
        </tr>
      </tbody>
    </table>

    <p class="b">Всего наименований ${items.length}, на сумму ${formatMoney(total)} руб.</p>
    <p class="b">${amountInWords(total)}.</p>
    <p class="note">Продавец применяет упрощённую систему налогообложения и не является
       плательщиком НДС (гл. 26.2 НК РФ). Счёт-фактура не выставляется.</p>
    ${doc.note ? `<p class="note">${esc(doc.note)}</p>` : ''}

    <div class="transfer">
      <div>
        <h3>Товар (работы, услуги) передал</h3>
        <div class="small muted">${esc(org.full_name || org.name)}</div>
        <div class="sign"><div style="flex:1"><div class="line">${esc(org.signer || '')}</div></div></div>
        <div class="small">Дата отгрузки, передачи: <b>${ru(doc.transferDate || doc.date)}</b></div>
      </div>
      <div>
        <h3>Товар (работы, услуги) получил</h3>
        <div class="small muted">${esc(cp.full_name || cp.name)}</div>
        <div class="sign"><div style="flex:1"><div class="line">подпись / расшифровка</div></div></div>
        <div class="small">Дата получения: <b>_______________</b></div>
      </div>
    </div>`;

  return page(`УПД № ${doc.number || '1'}`, body).replace('</style>', `${LAND}</style>`);
}

module.exports = { buildUpdHtml };
