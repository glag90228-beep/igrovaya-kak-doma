'use strict';

/**
 * Корректировочный счёт-фактура и исправление — два РАЗНЫХ документа.
 *
 * Их постоянно путают, а разница принципиальная и стоит денег.
 *
 * Корректировочный (КСФ) — когда стоимость изменилась ПО СОГЛАСИЮ сторон
 * после отгрузки: скидка, пересорт, вернули часть товара, договорились о
 * другой цене. Исходный счёт-фактура при этом остаётся верным — он правильно
 * описывал то, что было на его дату. КСФ показывает «было / стало» и разницу,
 * и выставляется в течение пяти дней с даты согласия (п. 3 ст. 168 НК).
 * Основание — договор, соглашение или иной первичный документ, поэтому его
 * реквизиты в бланке обязательны.
 *
 * Исправление (ИСФ) — когда в счёте-фактуре ОШИБКА: опечатка в ИНН, не та
 * ставка, не то наименование. Ничего не менялось, документ просто был неверен
 * с самого начала. Тогда выставляется новый экземпляр ТОГО ЖЕ счёта-фактуры с
 * тем же номером и той же датой, но с пометкой «ИСПРАВЛЕНИЕ № N от …».
 * Номер у исправления свой и сквозной по этому счёту-фактуре.
 *
 * Почему нельзя «просто удалить и выписать заново», как было до сих пор.
 * Удаление стирает след: у покупателя экземпляр остался, он его уже отразил, и
 * при сверке АСК НДС-2 у сторон разойдутся данные. Правильный путь — оставить
 * исходный и выставить поверх него КСФ или исправление, чтобы цепочка была
 * видна обеим сторонам и налоговой.
 */

const { esc, ru, page, fxHtml, signRows, formatMoney, amountInWords } = require('./doc-html');
const { round2, vatSplit, rateLabel } = require('./money');

/**
 * Считает строку корректировки: что было, что стало, куда сдвинулось.
 *
 * Обе стороны считаются одним и тем же vatSplit, что и обычный документ, —
 * иначе «было» и «стало» разъедутся с исходным счётом-фактурой на копейки
 * округления, и корректировка перестанет сходиться с тем, что исправляет.
 */
function correctionRow(before, after, rate, gross) {
  const b = vatSplit(before, rate, gross);
  const a = vatSplit(after, rate, gross);
  const d = (x, y) => round2(y - x);
  return {
    before: b,
    after: a,
    diff: { net: d(b.net, a.net), vat: d(b.vat || 0, a.vat || 0), total: d(b.total, a.total) },
  };
}

/** Итоги корректировки по всем строкам: увеличение и уменьшение раздельно. */
function correctionTotals(rows) {
  let up = { net: 0, vat: 0, total: 0 };
  let down = { net: 0, vat: 0, total: 0 };
  for (const r of rows) {
    // Увеличение и уменьшение в бланке живут в разных строках итога: это не
    // прихоть формы, а разные записи в книге продаж и книге покупок.
    const box = r.diff.total >= 0 ? up : down;
    box.net = round2(box.net + Math.abs(r.diff.net));
    box.vat = round2(box.vat + Math.abs(r.diff.vat));
    box.total = round2(box.total + Math.abs(r.diff.total));
  }
  return { up, down };
}

/**
 * doc: { number, date, base:{number, date}, reason (договор/соглашение),
 *        vatRate, priceIncludesVat,
 *        lines: [{ name, unit, before:{qty,price}, after:{qty,price} }] }
 */
function buildKsfHtml({ org, cp, doc }) {
  const rate = doc.vatRate == null ? null : Number(doc.vatRate);
  const gross = Boolean(doc.priceIncludesVat);
  const lines = (doc.lines || []).map((l) => ({
    ...l,
    calc: correctionRow(l.before || { qty: 0, price: 0 }, l.after || { qty: 0, price: 0 }, rate, gross),
  }));
  const { up, down } = correctionTotals(lines.map((l) => l.calc));

  const money = (v) => (v == null ? '—' : formatMoney(v));
  const rows = lines.map((l) => {
    const c = l.calc;
    const cell = (which, side) => `
      <tr>
        <td>${which === 'before' ? esc(l.name) : ''}</td>
        <td class="c small">${which === 'before' ? 'до изменения' : 'после изменения'}</td>
        <td class="c">${side.qty == null ? '—' : esc(String(side.qty))}</td>
        <td class="r">${money(side.unitNet)}</td>
        <td class="r">${money(side.net)}</td>
        <td class="c">${rate == null ? 'Без НДС' : esc(rateLabel(rate))}</td>
        <td class="r">${rate == null ? '—' : money(side.vat)}</td>
        <td class="r">${money(side.total)}</td>
      </tr>`;
    return cell('before', { ...c.before, qty: (l.before || {}).qty })
      + cell('after', { ...c.after, qty: (l.after || {}).qty });
  }).join('');

  const body = `
    <h1 class="center">Корректировочный счёт-фактура № ${esc(doc.number || '1')} от ${ru(doc.date)}</h1>
    <p class="center muted small">к счёту-фактуре № ${esc((doc.base || {}).number || '—')}
       от ${ru((doc.base || {}).date)}</p>
    <hr class="rule">

    <table class="reqs">
      <tr><td class="k">Продавец</td><td colspan="3">${esc(org.full_name || org.name)}</td></tr>
      <tr><td class="k">ИНН/КПП продавца</td>
          <td colspan="3">${esc(org.inn || '—')}${org.kpp ? ` / ${esc(org.kpp)}` : ' / —'}</td></tr>
      <tr><td class="k">Покупатель</td><td colspan="3">${esc(cp.full_name || cp.name)}</td></tr>
      <tr><td class="k">ИНН/КПП покупателя</td>
          <td colspan="3">${esc(cp.inn || '—')}${cp.kpp ? ` / ${esc(cp.kpp)}` : ' / —'}</td></tr>
      <tr><td class="k">Основание изменения</td>
          <td colspan="3">${esc(doc.reason || '—')}</td></tr>
      <tr><td class="k">Валюта: наименование, код</td><td colspan="3">Российский рубль, 643</td></tr>
    </table>

    <table class="items">
      <thead><tr>
        <th>Наименование</th><th style="width:88px">Показатель</th>
        <th style="width:52px">Кол-во</th><th style="width:72px">Цена</th>
        <th style="width:84px">Без налога</th><th style="width:52px">Ставка</th>
        <th style="width:84px">Налог</th><th style="width:92px">С налогом</th>
      </tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="8" class="c muted">— нет строк —</td></tr>'}
        <tr class="total"><td colspan="4" class="r b">Всего увеличение (доплата):</td>
            <td class="r b">${formatMoney(up.net)}</td><td></td>
            <td class="r b">${rate == null ? '—' : formatMoney(up.vat)}</td>
            <td class="r b">${formatMoney(up.total)}</td></tr>
        <tr class="total"><td colspan="4" class="r b">Всего уменьшение:</td>
            <td class="r b">${formatMoney(down.net)}</td><td></td>
            <td class="r b">${rate == null ? '—' : formatMoney(down.vat)}</td>
            <td class="r b">${formatMoney(down.total)}</td></tr>
      </tbody>
    </table>

    <p class="note">Увеличение стоимости продавец отражает в книге продаж, уменьшение —
       в книге покупок (п. 13 ст. 171, п. 10 ст. 172 НК). Исходный счёт-фактура
       остаётся действующим: он верно описывал то, что было на его дату.</p>

    ${signRows(org)}
    ${fxHtml(org)}
  `;
  return page(`Корректировочный счёт-фактура № ${doc.number || '1'}`, body);
}

/**
 * Пометка исправления для обычного счёта-фактуры (УПД статуса 1).
 *
 * Исправление НЕ меняет номер и дату документа — только добавляет к ним свой
 * номер и дату. Поэтому это не отдельная форма, а строка в шапке того же
 * бланка: `doc.fix = { no: 1, date: '2026-09-05' }`.
 */
function fixNote(fix) {
  if (!fix || !fix.no) return '';
  return `ИСПРАВЛЕНИЕ № ${esc(String(fix.no))} от ${ru(fix.date)}`;
}

module.exports = { buildKsfHtml, correctionRow, correctionTotals, fixNote };
