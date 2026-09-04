'use strict';

/**
 * УПД — универсальный передаточный документ (форма из письма ФНС ММВ-20-3/96@,
 * табличная часть — по постановлению Правительства № 1137).
 *
 * Поддерживаются оба статуса:
 *
 *   1 — счёт-фактура + передаточный документ. Полный набор граф счёта-фактуры,
 *       НДС по ставке, строки 1–8 шапки, блок подписей руководителя и бухгалтера.
 *       Продавец должен быть плательщиком НДС.
 *   2 — только передаточный документ (акт). Граф счёта-фактуры нет,
 *       налоговые колонки не заполняются.
 *
 * Графы прослеживаемости (12, 12а, 13) выводятся, но остаются пустыми, пока
 * в позиции нет соответствующих данных: это часть формы, и убирать их нельзя.
 *
 * ВАЖНО: состав граф счёта-фактуры законодатель меняет. Перед первым боевым
 * применением сверьтесь с действующей редакцией постановления № 1137.
 */

const { esc, ru, page, fxHtml, isIp, usnNote, formatMoney, amountInWords } = require('./doc-html');
const { round2, vatSplit, rateLabel } = require('./money');

/** Коды единиц измерения по ОКЕИ — самые ходовые. */
const OKEI = {
  'шт.': '796', шт: '796', 'усл.': '876', услуга: '876', 'компл.': '839', компл: '839',
  кг: '166', г: '163', т: '168', л: '112', 'м': '006', 'м2': '055', 'м3': '113',
  'упак.': '778', упак: '778', 'час': '356', 'сут.': '359', 'пар': '715',
};
const okei = (unit) => OKEI[String(unit || '').toLowerCase().trim()] || '';

const LAND = `
  @page { size: A4 landscape; margin: 8mm; }
  .upd-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .upd-status { border: 2px solid #2e3a8c; padding: 6px 10px; text-align: center; min-width: 174px; }
  .upd-status b { display: block; font-size: 15px; color: #2e3a8c; }
  .upd-status .small { line-height: 1.25; }
  .sf td { border: 1px solid #c3c9dc; padding: 4px 6px; vertical-align: top; font-size: 10.5px; }
  .sf .k { background: #f4f6fc; width: 22%; }
  .sf .n { color: #6b7285; font-size: 9px; }
  .items.upd th, .items.upd td { padding: 3px 4px; font-size: 9.5px; }
  .items.upd th { line-height: 1.15; }
  .items.upd .gr { background: #2e3a8c; font-size: 8.5px; font-weight: normal; }
  .transfer { display: flex; gap: 18px; margin-top: 10px; }
  .transfer > div { flex: 1; border: 1px solid #c3c9dc; padding: 7px 9px; }
  .transfer h3 { margin: 0 0 5px; font-size: 11.5px; color: #1f2760; }
  .transfer .fld { margin: 5px 0; font-size: 10px; }
  .transfer .fld i { color: #6b7285; font-style: normal; }
  .transfer .ln { border-bottom: 1px solid #333; display: inline-block; min-width: 150px; }
  .sfsign { display: flex; gap: 26px; margin-top: 10px; }
  .sfsign > div { flex: 1; font-size: 10.5px; }
  .sfsign .line { border-top: 1px solid #333; margin-top: 22px; padding-top: 2px; font-size: 9.5px; }
`;

// Расчёт НДС — общий с счётом (lib/money.js). Своя копия здесь уже была
// и разошлась бы при первой правке: налог в счёте и в УПД по одной сделке
// обязан совпадать до копейки.

/**
 * @param doc {
 *   number, date, status (1|2), vatRate (22|20|10|7|5|0|null), priceIncludesVat,
 *   items:[{name,qty,unit,price,code?,country?,countryCode?,gtd?}],
 *   basis?, transferDate?, shipper?, consignee?, payDoc?, contract?, note?
 * }
 */
function buildUpdHtml({ org, cp, doc }) {
  const status = Number(doc.status) === 1 ? 1 : 2;
  const rate = status === 1 ? (doc.vatRate == null ? null : Number(doc.vatRate)) : null;
  const gross = Boolean(doc.priceIncludesVat);
  const items = doc.items || [];

  const split = items.map((it) => vatSplit(it, rate, gross));
  const totalNet = round2(split.reduce((s, x) => s + x.net, 0));
  const totalVat = rate == null ? null : round2(split.reduce((s, x) => s + (x.vat || 0), 0));
  const totalAll = round2(split.reduce((s, x) => s + x.total, 0));

  const partyLine = (p) => `${esc(p.full_name || p.name)}`
    + (p.address ? `, ${esc(p.address)}` : '')
    + (p.inn ? `, ИНН ${esc(p.inn)}` : '')
    + (p.kpp ? `, КПП ${esc(p.kpp)}` : '');

  // ── табличная часть ──
  const head1 = status === 1
    ? `<tr>
        <th rowspan="2" style="width:24px">№<div class="gr">1</div></th>
        <th rowspan="2">Наименование товара (описание работ, услуг), имущественного права<div class="gr">1а</div></th>
        <th rowspan="2" style="width:42px">Код вида товара<div class="gr">1б</div></th>
        <th colspan="2" style="width:88px">Единица измерения</th>
        <th rowspan="2" style="width:46px">Кол-во (объём)<div class="gr">3</div></th>
        <th rowspan="2" style="width:60px">Цена за единицу<div class="gr">4</div></th>
        <th rowspan="2" style="width:74px">Стоимость без налога<div class="gr">5</div></th>
        <th rowspan="2" style="width:44px">В т. ч. акциз<div class="gr">6</div></th>
        <th rowspan="2" style="width:44px">Ставка<div class="gr">7</div></th>
        <th rowspan="2" style="width:66px">Сумма налога<div class="gr">8</div></th>
        <th rowspan="2" style="width:74px">Стоимость с налогом<div class="gr">9</div></th>
        <th colspan="2" style="width:96px">Страна происхождения</th>
        <th rowspan="2" style="width:70px">Рег. номер декларации / РНПТ<div class="gr">11</div></th>
        <th colspan="2" style="width:70px">Ед. изм. прослеж. товара</th>
        <th rowspan="2" style="width:44px">Кол-во прослеж.<div class="gr">13</div></th>
      </tr>
      <tr>
        <th style="width:36px">код<div class="gr">2</div></th>
        <th style="width:52px">обозн.<div class="gr">2а</div></th>
        <th style="width:40px">код<div class="gr">10</div></th>
        <th style="width:56px">краткое<div class="gr">10а</div></th>
        <th style="width:34px">код<div class="gr">12</div></th>
        <th style="width:36px">обозн.<div class="gr">12а</div></th>
      </tr>`
    : `<tr>
        <th style="width:28px">№</th>
        <th>Наименование товара (работ, услуг)</th>
        <th style="width:58px">Код</th>
        <th style="width:50px">Ед.</th>
        <th style="width:56px">Кол-во</th>
        <th style="width:80px">Цена, руб.</th>
        <th style="width:90px">Стоимость без налога</th>
        <th style="width:60px">Налоговая ставка</th>
        <th style="width:66px">Сумма налога</th>
        <th style="width:94px">Стоимость с налогом</th>
      </tr>`;

  const rows = items.map((it, i) => {
    const s = split[i];
    if (status === 1) {
      return `<tr>
        <td class="c">${i + 1}</td>
        <td>${esc(it.name)}</td>
        <td class="c">${esc(it.code || '')}</td>
        <td class="c">${esc(okei(it.unit))}</td>
        <td class="c">${esc(it.unit || 'шт.')}</td>
        <td class="c">${esc(it.qty ?? '')}</td>
        <td class="r">${formatMoney(s.unitNet)}</td>
        <td class="r">${formatMoney(s.net)}</td>
        <td class="c">без акциза</td>
        <td class="c">${esc(rateLabel(rate))}</td>
        <td class="r">${s.vat == null ? 'без НДС' : formatMoney(s.vat)}</td>
        <td class="r">${formatMoney(s.total)}</td>
        <td class="c">${esc(it.countryCode || '')}</td>
        <td class="c">${esc(it.country || '')}</td>
        <td class="c">${esc(it.gtd || '')}</td>
        <td class="c">—</td><td class="c">—</td><td class="c">—</td>
      </tr>`;
    }
    return `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name)}</td>
      <td class="c">${esc(it.code || '')}</td>
      <td class="c">${esc(it.unit || 'шт.')}</td>
      <td class="c">${esc(it.qty ?? '')}</td>
      <td class="r">${formatMoney(it.price)}</td>
      <td class="r">${formatMoney(s.net)}</td>
      <td class="c">без НДС</td>
      <td class="c">—</td>
      <td class="r">${formatMoney(s.total)}</td>
    </tr>`;
  }).join('');

  const totalRow = status === 1
    ? `<tr class="total">
        <td colspan="7" class="r">Всего к оплате:</td>
        <td class="r">${formatMoney(totalNet)}</td>
        <td class="c">—</td><td class="c">—</td>
        <td class="r">${totalVat == null ? 'без НДС' : formatMoney(totalVat)}</td>
        <td class="r">${formatMoney(totalAll)}</td>
        <td colspan="6"></td>
      </tr>`
    : `<tr class="total">
        <td colspan="6" class="r">Всего к оплате:</td>
        <td class="r">${formatMoney(totalNet)}</td>
        <td class="c">—</td><td class="c">—</td>
        <td class="r">${formatMoney(totalAll)}</td>
      </tr>`;

  const cols = status === 1 ? 18 : 10;

  // ── шапка счёта-фактуры (только статус 1) ──
  const sfHead = status === 1 ? `
    <table class="sf">
      <tr><td class="k">Продавец <span class="n">(2)</span></td><td colspan="3">${esc(org.full_name || org.name)}</td></tr>
      <tr><td class="k">Адрес <span class="n">(2а)</span></td><td colspan="3">${esc(org.address || '—')}</td></tr>
      <tr><td class="k">ИНН/КПП продавца <span class="n">(2б)</span></td>
          <td>${esc(org.inn || '—')}${org.kpp ? ` / ${esc(org.kpp)}` : ' / —'}</td>
          <td class="k">Валюта: наименование, код <span class="n">(7)</span></td>
          <td>Российский рубль, 643</td></tr>
      <tr><td class="k">Грузоотправитель и его адрес <span class="n">(3)</span></td>
          <td colspan="3">${esc(doc.shipper || 'он же')}</td></tr>
      <tr><td class="k">Грузополучатель и его адрес <span class="n">(4)</span></td>
          <td colspan="3">${esc(doc.consignee || 'он же')}</td></tr>
      <tr><td class="k">К платёжно-расчётному документу <span class="n">(5)</span></td>
          <td colspan="3">${esc(doc.payDoc || '—')}</td></tr>
      <tr><td class="k">Покупатель <span class="n">(6)</span></td><td colspan="3">${esc(cp.full_name || cp.name)}</td></tr>
      <tr><td class="k">Адрес <span class="n">(6а)</span></td><td colspan="3">${esc(cp.address || '—')}</td></tr>
      <tr><td class="k">ИНН/КПП покупателя <span class="n">(6б)</span></td>
          <td>${esc(cp.inn || '—')}${cp.kpp ? ` / ${esc(cp.kpp)}` : ' / —'}</td>
          <td class="k">Идентификатор госконтракта <span class="n">(8)</span></td>
          <td>${esc(doc.govContract || '—')}</td></tr>
      <tr><td class="k">Основание передачи <span class="n">[8]</span></td>
          <td colspan="3">${esc(doc.basis || cp.contract || 'Без договора')}</td></tr>
    </table>`
    : `
    <table class="sf">
      <tr><td class="k">Продавец</td><td colspan="3">${partyLine(org)}</td></tr>
      <tr><td class="k">Покупатель</td><td colspan="3">${partyLine(cp)}</td></tr>
      <tr><td class="k">Грузоотправитель</td><td>${esc(doc.shipper || 'он же')}</td>
          <td class="k">Грузополучатель</td><td>${esc(doc.consignee || 'он же')}</td></tr>
      <tr><td class="k">Основание передачи</td><td colspan="3">${esc(doc.basis || cp.contract || 'Без договора')}</td></tr>
    </table>`;

  // ── подписи счёта-фактуры (только статус 1) ──
  /*
   * Бланк счёта-фактуры по постановлению № 1137 содержит все три строки
   * подписи, но заполняется одна: организация подписывает у руководителя и
   * бухгалтера, предприниматель — у себя. Раньше имя и факсимиле ставились
   * на первые две строки всегда, и у ИП получалось «Руководитель
   * организации И.Н. Сарычев» — должность, которой у него нет.
   */
  const ip = isIp(org);
  const ipLine = esc(org.ogrnip ? `${org.signer || ''} · ОГРНИП ${org.ogrnip}` : (org.signer || ''));
  const sfSign = status === 1 ? `
    <div class="sfsign">
      <div>Руководитель организации или иное уполномоченное лицо
        <div class="line">${ip ? '' : `${fxHtml(org.fx, { stamp: true })}${esc(org.signer || '')}`}</div></div>
      <div>Главный бухгалтер или иное уполномоченное лицо
        <div class="line">${ip ? '' : fxHtml(org.fx) + esc(org.signer || '')}</div></div>
      <div>Индивидуальный предприниматель или иное уполномоченное лицо
        <div class="line">${ip ? `${fxHtml(org.fx, { stamp: true })}${ipLine}` : ''}</div></div>
    </div>` : '';

  const taxNote = status === 1
    ? (rate == null
      ? '<p class="note">Операция не облагается НДС. Основание указывается в графе 7.</p>'
      : `<p class="note">Сумма НДС по ставке ${esc(rateLabel(rate))} — ${formatMoney(totalVat)} руб.
         Цены в графе 4 указаны без налога${gross ? ' (пересчитаны из цен с налогом)' : ''}.</p>`)
    // Статус 2 — только передаточный документ. Оговорку про УСН печатаем,
    // лишь если продавец действительно не платит НДС: у плательщика она
    // была бы неправдой, а счёт-фактуру он выставляет отдельно.
    : usnNote(org, 'Счёт-фактура не выставляется.');

  const body = `
    <div class="upd-head">
      <div style="flex:1">
        <div class="brand">Универсальный передаточный документ</div>
        <h1 style="margin-top:4px">№ ${esc(doc.number || '1')} от ${ru(doc.date)}</h1>
        ${status === 1 ? `<div class="small muted">Счёт-фактура № ${esc(doc.number || '1')} от ${ru(doc.date)}
          <span class="n">(1)</span> · Исправление № — от — <span class="n">(1а)</span></div>` : ''}
      </div>
      <div class="upd-status">
        <b>Статус: ${status}</b>
        <span class="small">${status === 1
    ? 'счёт-фактура и передаточный<br>документ (акт)'
    : 'передаточный документ (акт)<br>без счёта-фактуры'}</span>
      </div>
    </div>
    <hr class="rule">

    ${sfHead}

    <table class="items upd">
      <thead>${head1}</thead>
      <tbody>
        ${rows || `<tr><td colspan="${cols}" class="c muted">— нет позиций —</td></tr>`}
        ${totalRow}
      </tbody>
    </table>

    <p class="b">Всего наименований ${items.length}, на сумму ${formatMoney(totalAll)} руб.</p>
    <p class="b">${amountInWords(totalAll)}.</p>
    ${taxNote}
    ${sfSign}
    ${doc.note ? `<p class="note">${esc(doc.note)}</p>` : ''}

    <p class="small muted">Строки в круглых скобках — счёта-фактуры (постановление № 1137),
       в квадратных — передаточного документа (письмо ФНС ММВ-20-3/96@).</p>

    <div class="transfer">
      <div>
        <h3>Товар (груз) передал / услуги, результаты работ сдал <span class="n">[10]</span></h3>
        <div class="small muted">${esc(org.full_name || org.name)}</div>
        <div class="sign"><div style="flex:1"><div class="line">${fxHtml(org.fx, { stamp: status !== 1, tight: true })}${esc(org.signer || '')}</div></div></div>
        <div class="fld">Дата отгрузки, передачи <i>[11]</i>: <b>${ru(doc.transferDate || doc.date)}</b></div>
        <div class="fld">Иные сведения <i>[12]</i>: <span class="ln"></span></div>
        <div class="fld">Ответственный за оформление <i>[13]</i>: ${esc(org.signer || '')}</div>
        <div class="fld">Составитель документа <i>[14]</i>: ${esc(org.full_name || org.name)}</div>
      </div>
      <div>
        <h3>Товар (груз) получил / услуги, результаты работ принял <span class="n">[15]</span></h3>
        <div class="small muted">${esc(cp.full_name || cp.name)}</div>
        <div class="sign"><div style="flex:1"><div class="line">должность, подпись, расшифровка</div></div></div>
        <div class="fld">Дата получения <i>[16]</i>: <span class="ln"></span></div>
        <div class="fld">Иные сведения <i>[17]</i>: <span class="ln"></span></div>
        <div class="fld">Ответственный за оформление <i>[18]</i>: <span class="ln"></span></div>
        <div class="fld">Составитель документа <i>[19]</i>: <span class="ln"></span></div>
      </div>
    </div>`;

  return page(`УПД № ${doc.number || '1'} (статус ${status})`, body)
    .replace('</style>', `${LAND}</style>`);
}

module.exports = { buildUpdHtml, vatSplit, okei };
