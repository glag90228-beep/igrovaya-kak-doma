'use strict';

/**
 * Авансовый счёт-фактура — на полученную предоплату.
 *
 * Зачем он нужен. Получив предоплату, продавец обязан исчислить НДС в тот же
 * день и выставить счёт-фактуру в течение пяти календарных дней (п. 1 ст. 167,
 * п. 3 ст. 168 НК). Не выставил — налог всё равно начислен, а покупатель без
 * этого документа не может принять его к вычету и приходит с претензией.
 *
 * Чем он отличается от обычного. Товара ещё нет, поэтому позиций нет тоже:
 * в графе 1 пишут не наименование поставки, а обобщённое название по договору.
 * Количество, цена и стоимость без налога не заполняются — в бланке на их
 * месте прочерки. Налог считается РАСЧЁТНОЙ ставкой из полученной суммы:
 * 22/122, 10/110, 7/107, 5/105 (п. 4 ст. 164 НК), а не начисляется сверху.
 * Ошибка здесь стоит ровно разницы: 100 000 по 22% сверху это 22 000 налога,
 * а из тех же 100 000 расчётной ставкой — 18 032,79.
 *
 * Что с ним происходит дальше. При отгрузке продавец начисляет налог заново,
 * уже с реализации, а этот вычитает обратно (п. 8 ст. 171, п. 6 ст. 172 НК).
 * Чтобы налоговая свела одно с другим, номер и дата этого документа попадают
 * в строку 5б отгрузочного счёта-фактуры — с 1 апреля 2026 года это
 * обязательный реквизит (постановление № 26 от 23.01.2026).
 */

const { esc, ru, page, fxHtml, signRows, formatMoney, amountInWords } = require('./doc-html');
const { round2 } = require('./money');

/**
 * Расчётная ставка: сколько налога сидит внутри полученной суммы.
 *
 * Именно деление, а не умножение. Ставка 22 означает 22/122 от суммы, и
 * привычное «сумма × 22%» здесь даёт завышение почти на пятую часть налога.
 *
 * @param {number} sum полученная предоплата (с налогом внутри)
 * @param {number} rate ставка в процентах
 * @returns {{sum:number, vat:number, net:number, label:string}}
 */
function advanceVat(sum, rate) {
  const total = round2(sum);
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    return { sum: total, vat: 0, net: total, label: 'Без НДС' };
  }
  const vat = round2((total * r) / (100 + r));
  return { sum: total, vat, net: round2(total - vat), label: `${r}/${100 + r}` };
}

/**
 * doc: { number, date, sum (полученная предоплата, с налогом),
 *        vatRate (22|20|10|7|5|null), subject (за что), payDoc (номер и дата
 *        платёжного поручения — реквизит обязательный, строка 5) }
 */
function buildAvansHtml({ org, cp, doc }) {
  const { sum, vat, label } = advanceVat(doc.sum, doc.vatRate);
  const rate = doc.vatRate == null ? null : Number(doc.vatRate);

  /*
   * Строка 5 у авансового счёта-фактуры — не формальность.
   *
   * Здесь она обязательна всегда: документ выставляется именно на полученные
   * деньги, и без ссылки на платёжку налоговая не свяжет его с поступлением.
   * У отгрузочного счёта-фактуры без предоплаты она, наоборот, пустует.
   */
  const payDoc = esc(doc.payDoc || '—');

  const body = `
    <h1 class="center">Счёт-фактура № ${esc(doc.number || '1')} от ${ru(doc.date)}</h1>
    <p class="center muted small">на полученную предоплату</p>
    <hr class="rule">

    <table class="reqs">
      <tr><td class="k">Продавец <span class="n">(2)</span></td>
          <td colspan="3">${esc(org.full_name || org.name)}</td></tr>
      <tr><td class="k">Адрес <span class="n">(2а)</span></td>
          <td colspan="3">${esc(org.address || '—')}</td></tr>
      <tr><td class="k">ИНН/КПП продавца <span class="n">(2б)</span></td>
          <td colspan="3">${esc(org.inn || '—')}${org.kpp ? ` / ${esc(org.kpp)}` : ' / —'}</td></tr>
      <tr><td class="k">К платёжно-расчётному документу <span class="n">(5)</span></td>
          <td colspan="3">${payDoc}</td></tr>
      <tr><td class="k">Покупатель <span class="n">(6)</span></td>
          <td colspan="3">${esc(cp.full_name || cp.name)}</td></tr>
      <tr><td class="k">Адрес <span class="n">(6а)</span></td>
          <td colspan="3">${esc(cp.address || '—')}</td></tr>
      <tr><td class="k">ИНН/КПП покупателя <span class="n">(6б)</span></td>
          <td colspan="3">${esc(cp.inn || '—')}${cp.kpp ? ` / ${esc(cp.kpp)}` : ' / —'}</td></tr>
      <tr><td class="k">Валюта: наименование, код <span class="n">(7)</span></td>
          <td colspan="3">Российский рубль, 643</td></tr>
    </table>

    <table class="items">
      <thead><tr>
        <th>Наименование товара (описание работ, услуг) <div class="gr">1</div></th>
        <th style="width:60px">Кол-во <div class="gr">3</div></th>
        <th style="width:70px">Цена <div class="gr">4</div></th>
        <th style="width:86px">Стоимость без налога <div class="gr">5</div></th>
        <th style="width:56px">Ставка <div class="gr">7</div></th>
        <th style="width:90px">Сумма налога <div class="gr">8</div></th>
        <th style="width:96px">Стоимость с налогом <div class="gr">9</div></th>
      </tr></thead>
      <tbody>
        <tr>
          <td>${esc(doc.subject || 'Предварительная оплата по договору')}</td>
          <td class="c">—</td>
          <td class="c">—</td>
          <td class="c">—</td>
          <td class="c">${rate == null ? 'Без НДС' : esc(label)}</td>
          <td class="r">${rate == null ? '—' : formatMoney(vat)}</td>
          <td class="r">${formatMoney(sum)}</td>
        </tr>
        <tr class="total">
          <td colspan="5" class="r b">Всего к оплате:</td>
          <td class="r b">${rate == null ? '—' : formatMoney(vat)}</td>
          <td class="r b">${formatMoney(sum)}</td>
        </tr>
      </tbody>
    </table>

    <p class="b">Получена предоплата: ${formatMoney(sum)} руб. (${amountInWords(sum)})${rate == null
    ? ', без НДС'
    : `, в том числе НДС по расчётной ставке ${esc(label)} — ${formatMoney(vat)} руб.`}.</p>

    <p class="note">Количество, цена и стоимость без налога не указываются: на дату
       получения предоплаты отгрузки ещё не было (постановление № 1137, правила
       заполнения счёта-фактуры).</p>

    ${signRows(org)}
    ${fxHtml(org)}
  `;
  return page(`Счёт-фактура на аванс № ${doc.number || '1'}`, body);
}

module.exports = { buildAvansHtml, advanceVat };
