'use strict';

/**
 * Акт за месяц: один акт услуг на все накладные и УПД клиента за месяц.
 *
 * Раньше жил внутри bot.js, и приложению пришлось бы копировать его целиком.
 * Здесь общая часть — что войдёт в акт, на какую сумму и как он выписывается;
 * бот и приложение сверху лишь по-своему показывают результат.
 *
 * Долг акт не создаёт — это главное правило, и держится оно не на удаче.
 * Сумма отгрузок уже лежит в журнале проводками накладных (или счётом, если
 * основание «по счёту»). Акт выписывается с noDebt: без проводки, с пометкой
 * no_debt, которую пересчёт `rebuildDebt` уважает, и сразу отмечается
 * оплаченным — иначе он висел бы в «Не оплачено» вторым долгом на ту же
 * сумму. Всё это проверено в bot-selftest («акт не добавил долг»).
 *
 * Только для клиентов на предоплате. Отметка «оплачен» верна там, где отгрузки
 * покрыты авансом. У клиента без предоплаты накладные висят долгом, и акт,
 * показанный «оплаченным», вводил бы в заблуждение: человек решил бы, что
 * деньги получены. Поэтому отказ живёт здесь, в общей функции, а не в кнопках:
 * бот и приложение прячут кнопку, но запрос можно прислать и мимо неё.
 */

const bdb = require('./bot-db');
const docService = require('./doc-service');
const { todayISO } = require('./period');

const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август',
  'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

const isYm = (ym) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym));

/** «2026-10» → «октябрь 2026». */
function monthTitle(ym) {
  return `${MONTHS_RU[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

/** Последние `n` месяцев, считая текущий: [{ym, title}], свежий первым. */
function lastMonths(n, today = todayISO()) {
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    out.push({ ym, title: monthTitle(ym) });
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

/** Отказ для клиента без предоплаты — общий для предпросмотра и выписки. */
function prepayRefusal(userId, cp) {
  if (bdb.prepayState(userId, cp.id)) return null;
  return {
    ok: false, reason: 'noprepay',
    message: `Акт за месяц выписывается клиентам на предоплате. У «${cp.name}» её нет: накладные идут долгом, `
      + 'а такой акт сразу помечается оплаченным — это было бы неправдой. Включите предоплату у клиента '
      + 'или закройте накладные оплатой.',
  };
}

/** Что войдёт в акт за месяц: отгрузки, ещё не попавшие ни в один акт. */
function preview(userId, cpId, ym) {
  const open = bdb.openShipmentsOfMonth(userId, cpId, ym);
  return {
    ym,
    title: monthTitle(ym),
    docs: open.docs.map((d) => ({
      id: d.id, type: d.type, number: d.number, date: d.date, total: d.total,
    })),
    sum: open.sum,
    // Акты за этот месяц уже есть; `done` — и ничего нового после них не появилось.
    acts: open.acts.map((a) => ({ id: a.id, number: a.number, date: a.date, total: a.total })),
    done: open.acts.length > 0 && open.docs.length === 0,
  };
}

/**
 * Выписать акт за месяц на отгрузки, которых в актах ещё нет.
 *
 * @returns {Promise<object>} как у issueDocument плюс `ym`, `month` («октябрь 2026»), `docs`;
 *   при отказе `{ok:false, reason, message}`, где reason — 'ym', 'cp', 'noprepay'
 *   (клиент не на предоплате), 'have' (всё уже вошло в акт, `act` — последний из
 *   них) или 'none' (отгрузок нет).
 */
async function issue(userId, cpId, ym) {
  // Будущий месяц акту не основание: выпустить акт «на вырост» значило бы
  // подписать то, чего ещё не было.
  if (!isYm(ym) || ym > todayISO().slice(0, 7)) {
    return { ok: false, reason: 'ym', message: 'Акт можно выписать за текущий или прошедший месяц.' };
  }
  const cp = bdb.getCp(userId, Number(cpId));
  if (!cp) return { ok: false, reason: 'cp', message: 'Такого клиента нет в вашем списке.' };
  const refuse = prepayRefusal(userId, cp);
  if (refuse) return refuse;
  const org = bdb.currentOrg(userId);
  if (!org) return { ok: false, reason: 'org', message: 'Сначала заполните реквизиты своей организации.' };

  const p = preview(userId, cp.id, ym);
  if (!p.docs.length) {
    const act = p.acts[p.acts.length - 1];
    return act
      ? {
        ok: false, reason: 'have', act,
        message: `Всё за ${p.title} уже вошло в акт № ${act.number} от ${act.date.split('-').reverse().join('.')}. Второй не делаю.`,
      }
      : { ok: false, reason: 'none', message: `За ${p.title} накладных и УПД нет — акту не на чем строиться.` };
  }

  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const last = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const today = todayISO();
  const date = last > today ? today : last;
  const nums = p.docs.map((d) => `№ ${d.number}`).join(', ');
  const v = bdb.vatOf(org);
  // Цена в акте — уже итог накладных (с налогом, если он там был), поэтому
  // «с налогом внутри»: иначе НДС лёг бы на него второй раз и сумма разошлась.
  const extra = { monthAct: ym, ...(v.rate != null ? { vatRate: v.rate, priceIncludesVat: true } : {}) };
  const res = await docService.issueDocument(userId, {
    type: 'usl', cpId: cp.id, date, extra, noDebt: true,
    items: [{ name: `Услуги за ${p.title} по накладным ${nums}`, qty: 1, unit: 'усл.', price: p.sum }],
  });
  if (!res.ok) return res;
  // Акт ничего не должен: отгрузки покрыты предоплатой или висят своими
  // накладными. Отметка нужна, чтобы он не торчал в «Не оплачено» вторым долгом.
  bdb.markPaid(userId, res.doc.id, date);
  return { ...res, ym, month: p.title, docs: p.docs, date };
}

module.exports = { MONTHS_RU, monthTitle, lastMonths, preview, prepayRefusal, issue };
