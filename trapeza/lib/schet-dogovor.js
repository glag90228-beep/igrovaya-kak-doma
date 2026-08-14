'use strict';

/**
 * Счёт-договор (счёт-оферта) — самый ходовой документ микробизнеса.
 *
 * Заменяет пару «договор + счёт»: одна страница, где сверху обычный счёт с
 * реквизитами и QR, а ниже короткие условия сделки. Договор подписывать не
 * нужно — оплата счёта считается акцептом оферты (п. 3 ст. 438 ГК РФ), то
 * есть заключением договора на этих условиях.
 *
 * Почему это отдельный шаблон, а не «счёт с примечанием»:
 *
 *   • у него своя нумерация — счёт-договор № 5 и счёт № 5 это разные
 *     документы, и путать их ряды нельзя;
 *   • обязательна фраза об акцепте: без неё оплата договором не станет,
 *     и весь смысл документа теряется;
 *   • нужны подписи обеих сторон в конце — счёт подписывает только
 *     поставщик, а здесь место для заказчика тоже.
 *
 * Факсимиле ставится только на нашу подпись: за заказчика расписываться
 * нельзя ни при каких обстоятельствах.
 */

const { esc, ru, page, fxHtml, formatMoney, amountInWords } = require('./doc-html');
const { round2, vatTotals, rateLabel } = require('./money');
const { payQrSvg } = require('./qr-pay');

const EXTRA_CSS = `
  .terms { margin-top: 12px; font-size: 10.5px; line-height: 1.45; }
  .terms h2 { font-size: 12px; color: #5e3f27; margin: 10px 0 3px; }
  .terms p { margin: 3px 0; }
  .accept { border: 1.5px solid #7a5230; background: #faf6f1; border-radius: 4px;
            padding: 8px 10px; margin: 10px 0 4px; font-size: 11px; }
`;

/**
 * doc: { number, date, items, vatRate, priceIncludesVat,
 *        subject?, prepay?, days?, term? }
 */
function buildSchetDogovorHtml({ org, cp, doc }) {
  const items = doc.items || [];
  const rate = doc.vatRate == null ? null : Number(doc.vatRate);
  const gross = Boolean(doc.priceIncludesVat);
  const { net, vat, total } = vatTotals(items, rate, gross);
  const days = Number(doc.days) > 0 ? Number(doc.days) : 5;

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

  const svg = doc.qr === false ? null : payQrSvg({
    org, sum: total, payer: cp.full_name || cp.name,
    purpose: `Оплата по счёту-договору № ${doc.number || '1'} от ${ru(doc.date)}`
      + (rate == null ? ', без НДС' : `, в т.ч. НДС ${rate}% — ${formatMoney(vat)} руб.`),
  }, { size: 140 });
  const qrBlock = svg
    ? `<div class="pay__qr">${svg}<div class="pay__cap">Оплата по QR<br>
         <span class="muted">наведите камеру в приложении банка</span></div></div>`
    : '';

  const prepay = Number(doc.prepay) > 0
    ? `Заказчик вносит предоплату ${esc(String(doc.prepay))}% стоимости, остаток — `
      + 'в течение 3 рабочих дней после оказания услуг.'
    : `Оплата производится в течение ${days} банковских дней с даты выставления настоящего счёта-договора.`;

  const body = `
    <table class="reqs" style="margin-bottom:2px">
      <tr>
        <td rowspan="2">Банк получателя<br><b>${esc(org.bank_name || '—')}</b></td>
        <td class="k" style="width:70px">БИК</td>
        <td style="width:190px">${esc(org.bik || '—')}</td>
      </tr>
      <tr><td class="k">Сч. №</td><td>${esc(org.corr_acc || '—')}</td></tr>
      <tr>
        <td>ИНН ${esc(org.inn || '—')}${org.kpp ? ` &nbsp; КПП ${esc(org.kpp)}` : ''}</td>
        <td class="k">Сч. №</td><td>${esc(org.acc || '—')}</td>
      </tr>
      <tr><td colspan="3">Получатель<br><b>${esc(org.full_name || org.name)}</b></td></tr>
    </table>

    <h1 class="center" style="margin-top:10px">Счёт-договор № ${esc(doc.number || '1')} от ${ru(doc.date)}</h1>
    <hr class="rule">

    <table class="reqs">
      <tr><td class="k">Исполнитель<br>(Поставщик)</td>
          <td>${esc(org.full_name || org.name)}${org.inn ? `, ИНН ${esc(org.inn)}` : ''}${org.address ? `, ${esc(org.address)}` : ''}</td></tr>
      <tr><td class="k">Заказчик<br>(Покупатель)</td>
          <td>${esc(cp.full_name || cp.name)}${cp.inn ? `, ИНН ${esc(cp.inn)}` : ''}${cp.kpp ? `, КПП ${esc(cp.kpp)}` : ''}${cp.address ? `, ${esc(cp.address)}` : ''}</td></tr>
    </table>

    <table class="items">
      <thead><tr>
        <th style="width:32px">№</th><th>Наименование работ, услуг, товаров</th>
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
        <tr class="total"><td colspan="5" class="r b">Всего к оплате:</td>
            <td class="r b">${formatMoney(total)}</td></tr>
      </tbody>
    </table>

    <div class="pay">
      <div class="pay__text">
        <p class="b">Всего наименований ${items.length} на сумму ${formatMoney(total)} руб.</p>
        <p class="b">${amountInWords(total)}.</p>
        <div class="accept">
          <b>Оплата настоящего счёта-договора означает акцепт оферты</b> и заключение
          договора на условиях, изложенных ниже (п. 3 ст. 438 ГК РФ). Подписание
          отдельного договора не требуется.
        </div>
      </div>
      ${qrBlock}
    </div>

    <div class="terms">
      <h2>1. Предмет</h2>
      <p>1.1. Исполнитель обязуется передать товары либо оказать услуги,
         перечисленные в таблице выше, а Заказчик — принять и оплатить их.</p>
      ${doc.subject ? `<p>1.2. Дополнительно: ${esc(doc.subject)}.</p>` : ''}

      <h2>2. Цена и оплата</h2>
      <p>2.1. Стоимость составляет ${formatMoney(total)} руб.
         (${amountInWords(total)})${rate == null ? ', НДС не облагается' : `, в том числе НДС ${rateLabel(rate)} — ${formatMoney(vat)} руб.`}.</p>
      <p>2.2. ${prepay}</p>
      <p>2.3. Обязательство по оплате считается исполненным с момента зачисления
         денежных средств на расчётный счёт Исполнителя.</p>

      <h2>3. Передача и приёмка</h2>
      <p>3.1. По факту исполнения Исполнитель передаёт Заказчику акт либо накладную.</p>
      <p>3.2. Заказчик подписывает документ или направляет мотивированный отказ
         в течение 5 рабочих дней. Иначе работы считаются принятыми без замечаний.</p>

      <h2>4. Ответственность и срок</h2>
      <p>4.1. За нарушение срока оплаты Заказчик уплачивает пеню 0,1% от просроченной
         суммы за каждый день, но не более 10% от суммы счёта-договора.</p>
      <p>4.2. Стороны освобождаются от ответственности при обстоятельствах
         непреодолимой силы.</p>
      <p>4.3. Настоящий счёт-договор действителен к акцепту в течение
         ${days} банковских дней с даты выставления.</p>

      <h2>5. Прочее</h2>
      <p>5.1. Документы, переданные по электронной почте или в мессенджерах с адресов
         и номеров сторон, признаются имеющими силу оригиналов.</p>
      <p>5.2. Споры разрешаются переговорами, при недостижении согласия — в
         арбитражном суде по месту нахождения Исполнителя.</p>
    </div>

    <div class="sign">
      <div style="flex:1">Исполнитель
        <div class="line">${fxHtml(org.fx, { stamp: true })}${esc(org.signer || '')}</div></div>
      <div style="flex:1">Заказчик
        <div class="line">${esc(cp.signer || 'подпись / расшифровка')}</div></div>
    </div>`;

  return page(`Счёт-договор № ${doc.number || '1'}`, body)
    .replace('</style>', `${EXTRA_CSS}</style>`);
}

module.exports = { buildSchetDogovorHtml };
