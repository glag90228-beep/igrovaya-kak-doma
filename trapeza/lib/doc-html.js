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
  body { margin: 0; font-family: Arial, "DejaVu Sans", sans-serif; color: #1f1a14; font-size: 12px; line-height: 1.4; }
  .doc { padding: 4px 2px; }
  h1 { font-size: 20px; color: #5e3f27; margin: 0 0 2px; }
  h1.center, .center { text-align: center; }
  .muted { color: #6b5b4b; }
  .small { font-size: 10.5px; }
  .brand { font-size: 15px; font-weight: bold; color: #7a5230; }
  .rule { height: 2px; background: #7a5230; margin: 8px 0 12px; border: 0; }
  table { border-collapse: collapse; width: 100%; }
  .items { margin: 10px 0; font-size: 11.5px; }
  .items th { background: #7a5230; color: #fff; font-weight: bold; padding: 6px 7px; border: 1px solid #7a5230; text-align: center; }
  .items td { border: 1px solid #cbb9a5; padding: 6px 7px; vertical-align: top; }
  .items tbody tr:nth-child(even) td { background: #faf6f1; }
  .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .c { text-align: center; }
  .b { font-weight: bold; }
  .total td { background: #efe3d2; font-weight: bold; }
  .reqs { width: 100%; margin: 6px 0; }
  .reqs td { border: 1px solid #cbb9a5; padding: 6px 8px; vertical-align: top; }
  .reqs .k { background: #faf6f1; font-weight: bold; width: 26%; }
  .two { display: flex; gap: 24px; justify-content: space-between; margin-top: 8px; }
  .two > div { flex: 1; }
  .sign { margin-top: 34px; display: flex; justify-content: space-between; gap: 30px; }
  .sign .line { border-top: 1px solid #333; margin-top: 26px; padding-top: 3px; font-size: 10.5px; }
  .note { font-size: 10.5px; color: #4a3e31; margin-top: 10px; }
  .box { border: 1px solid #333; }
`;

function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">`
    + `<title>${esc(title)}</title><style>${CSS}</style></head>`
    + `<body><div class="doc">${body}</div></body></html>`;
}

module.exports = { esc, ru, page, formatMoney, formatRub, amountInWords };
