'use strict';

// Общая обёртка и стиль для документов-PDF «Трапезы» (акт услуг, счёт, платёжка).
// Палитра бренда, официальный сдержанный вид, печать под А4.

const { formatMoney, formatRub, amountInWords } = require('./money');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** ISO yyyy-mm-dd → dd.mm.yyyy; иначе как есть */
function ru(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso);
}

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, "DejaVu Sans", sans-serif; color: #14171f; font-size: 12px; line-height: 1.4; }
  .doc { padding: 4px 2px; }
  h1 { font-size: 20px; color: #1f2760; margin: 0 0 2px; }
  h1.center, .center { text-align: center; }
  .muted { color: #5a6172; }
  .small { font-size: 10.5px; }
  .brand { font-size: 15px; font-weight: bold; color: #2e3a8c; }
  .rule { height: 2px; background: #2e3a8c; margin: 8px 0 12px; border: 0; }
  table { border-collapse: collapse; width: 100%; }
  .items { margin: 10px 0; font-size: 11.5px; }
  .items th { background: #2e3a8c; color: #fff; font-weight: bold; padding: 6px 7px; border: 1px solid #2e3a8c; text-align: center; }
  .items td { border: 1px solid #c3c9dc; padding: 6px 7px; vertical-align: top; }
  .items tbody tr:nth-child(even) td { background: #f4f6fc; }
  .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .c { text-align: center; }
  .b { font-weight: bold; }
  .total td { background: #e3e8f8; font-weight: bold; }
  .reqs { width: 100%; margin: 6px 0; }
  .reqs td { border: 1px solid #c3c9dc; padding: 6px 8px; vertical-align: top; }
  .reqs .k { background: #f4f6fc; font-weight: bold; width: 26%; }
  .two { display: flex; gap: 24px; justify-content: space-between; margin-top: 8px; }
  .two > div { flex: 1; }
  .sign { margin-top: 34px; display: flex; justify-content: space-between; gap: 30px; }
  .sign .line { border-top: 1px solid #333; margin-top: 26px; padding-top: 3px; font-size: 10.5px; }
  .note { font-size: 10.5px; color: #4a5162; margin-top: 10px; }
  .box { border: 1px solid #333; }
  /* Итог и платёжный QR стоят рядом: код не уводит подписи на второй лист. */
  .pay { display: flex; gap: 18px; align-items: flex-start; margin-top: 10px; }
  .pay__text { flex: 1; }
  .pay__text p:first-child { margin-top: 0; }
  .pay__qr { width: 150px; text-align: center; border: 1px solid #c3c9dc;
             border-radius: 4px; padding: 8px 8px 6px; background: #fff; }
  .pay__qr svg { display: block; width: 100%; height: auto; }
  .pay__cap { font-size: 10px; margin-top: 4px; font-weight: bold; line-height: 1.25; }
  .pay__cap .muted { font-weight: normal; }

  /* Факсимиле: подпись и печать над линией подписи.
     Блок нулевой высоты — картинки висят поверх и не двигают вёрстку.
     mix-blend-mode: multiply убирает белый фон снимка: подпись почти
     всегда сфотографирована с листа, вырезать фон в проекте нечем, а
     умножение делает белое невидимым и оставляет тёмные штрихи. */
  .fx-box { position: relative; display: block; height: 0; }
  .fx { position: absolute; mix-blend-mode: multiply; pointer-events: none; }
  .fx-sign { left: 10px; bottom: -10px; height: 54px; width: auto;
             filter: contrast(1.35) saturate(.85); }
  /* Печать — у правого конца линии подписи и большей частью ниже неё.
     Это единственное место, свободное во всех наших бланках: слева на
     линии стоит подпись, сверху название графы, снизу расшифровка — а
     правый конец линии пуст везде. 108px ≈ 28 мм, как печать ИП. */
  .fx-stamp { right: 12px; bottom: -62px; height: 108px; width: auto;
              opacity: .85; filter: contrast(1.1); }
  /* ТОРГ-12 и блок передачи УПД плотнее: там под линией сразу следующая
     графа, поэтому печать меньше и прижата ближе к линии. */
  .fx-stamp--tight { height: 78px; bottom: -46px; right: 8px; }
  @media print { .fx { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`;

/**
 * Разметка факсимиле над линией подписи. Живёт здесь, а не в facsimile.js,
 * чтобы шаблоны документов оставались чистыми: они получают готовые
 * картинки в org.fx и ничего не знают про базу.
 *
 * @param {{sign?:string, stamp?:string}} fx data-URI картинок
 * @param {{stamp?:boolean, tight?:boolean}} opts печать ставим один раз на
 *        документ — у подписи руководителя, а не в каждой строке подписей;
 *        tight — для бланков, где над линией подписи почти нет места
 */
function fxHtml(fx, opts = {}) {
  if (!fx || (!fx.sign && !fx.stamp)) return '';
  const parts = [];
  if (fx.sign) parts.push(`<img class="fx fx-sign" src="${fx.sign}" alt="">`);
  if (fx.stamp && opts.stamp) {
    const cls = `fx fx-stamp${opts.tight ? ' fx-stamp--tight' : ''}`;
    parts.push(`<img class="${cls}" src="${fx.stamp}" alt="">`);
  }
  return parts.length ? `<span class="fx-box">${parts.join('')}</span>` : '';
}

/**
 * Индивидуальный предприниматель это или организация.
 *
 * Определяем по длине ИНН: у физлица и ИП он двенадцатизначный, у
 * организации — десятизначный. Отдельного поля не заводим, потому что ИНН
 * есть всегда и подделать его длину случайно нельзя, а лишняя галочка в
 * анкете — это ещё один вопрос, на который человек ответит наугад.
 */
const isIp = (org) => String((org && org.inn) || '').replace(/\D/g, '').length === 12;

/**
 * Подписи под документом.
 *
 * У ИП нет ни руководителя, ни главного бухгалтера: он подписывает сам за
 * себя. Печатать «Руководитель И.Н. Сарычев» под счётом предпринимателя —
 * это должность, которой у него нет, и такой счёт бухгалтерия покупателя
 * законно возвращает на переделку. Организация подписывает двумя строками:
 * руководитель и бухгалтер.
 *
 * @param {object} org организация из базы (нужны inn и signer)
 * @param {Function} fx готовая разметка факсимиле — передаём снаружи, чтобы
 *        модуль не решал за шаблон, где ставить печать
 */
function signRows(org, fx = () => '') {
  const who = esc((org && org.signer) || '');
  if (isIp(org)) {
    // Одна подпись — и она же с печатью, если печать загружена.
    return [{ title: 'Индивидуальный предприниматель', html: `${fx({ stamp: true })}${who}` }];
  }
  return [
    { title: 'Руководитель', html: `${fx({ stamp: true })}${who}` },
    { title: 'Бухгалтер', html: `${fx()}${who}` },
  ];
}

/**
 * Оговорка «поставщик на УСН и НДС не платит».
 *
 * Печаталась в накладной и в УПД безусловно. Для плательщика НДС это
 * прямая неправда в документе, который уходит покупателю: его бухгалтерия
 * по такой строке не примет налог к вычету, а при проверке расхождение
 * документа с налоговым режимом объяснять придётся продавцу.
 *
 * @param {object} org организация (смотрим vat_rate)
 * @param {string} tail что дописать, если оговорка уместна
 */
function usnNote(org, tail = '') {
  const raw = org && org.vat_rate;
  const payer = !(raw === '' || raw == null) && Number.isFinite(Number(raw));
  if (payer) return '';
  return `<p class="note">Поставщик применяет упрощённую систему налогообложения и не является
     плательщиком НДС (гл. 26.2 НК РФ).${tail ? ` ${esc(tail)}` : ''}</p>`;
}

function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">`
    + `<title>${esc(title)}</title><style>${CSS}</style></head>`
    + `<body><div class="doc">${body}</div></body></html>`;
}

module.exports = {
  esc, ru, page, fxHtml, isIp, signRows, usnNote, formatMoney, formatRub, amountInWords,
};
