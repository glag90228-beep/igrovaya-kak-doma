'use strict';

// Платёжное поручение (HTML → PDF), форма 0401060.
// Плательщик = организация пользователя, Получатель = контрагент.

const { esc, ru, page, amountInWords } = require('./doc-html');
const { round2 } = require('./money');

/** сумма в формате поля «Сумма»: 26 496-42 */
function sumField(n) {
  const v = round2(Math.abs(n));
  const [i, d] = v.toFixed(2).split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}-${d}`;
}
const L = (t) => `<span class="lbl">${esc(t)}</span>`;

/** doc: { number, date, amount, purpose, vidOper?, ocher? } */
function buildPlatyozhkaHtml({ org, cp, doc }) {
  const amount = round2(doc.amount || 0);
  const p = org;   // плательщик
  const r = cp;    // получатель
  const ocher = doc.ocher || '5';
  const vidOper = doc.vidOper || '01';

  const css = `
    .pp { width:100%; border-collapse:collapse; font-size:11px; table-layout:fixed; }
    .pp td { border:1px solid #333; padding:4px 7px; vertical-align:top; word-wrap:break-word; }
    .pp .nob { border:0; }
    .lbl { font-size:9px; color:#555; }
    .big { font-size:13px; font-weight:bold; }
    .c { text-align:center; } .b { font-weight:bold; }
  `;

  const body = `
    <style>${css}</style>
    <table class="pp">
      <colgroup><col style="width:58%"><col style="width:14%"><col style="width:14%"><col style="width:14%"></colgroup>
      <tr>
        <td class="nob"></td>
        <td class="nob"></td>
        <td class="c">${ru(doc.date)}</td>
        <td class="c">0401060</td>
      </tr>
      <tr>
        <td class="nob big">ПЛАТЁЖНОЕ ПОРУЧЕНИЕ № ${esc(doc.number || '1')}</td>
        <td class="nob"></td>
        <td class="c">${L('Дата')}</td>
        <td class="c">${L('Вид платежа')}</td>
      </tr>
      <tr><td colspan="4">${L('Сумма прописью')}<br><b>${amountInWords(amount)}</b></td></tr>
      <tr>
        <td>${L('ИНН')} ${esc(p.inn || '')} &nbsp; ${L('КПП')} ${esc(p.kpp || '')}</td>
        <td>${L('Сумма')}</td>
        <td colspan="2" class="big">${sumField(amount)}</td>
      </tr>
      <tr>
        <td>${L('Плательщик')}<br><b>${esc(p.full_name || p.name)}</b></td>
        <td>${L('Сч. №')}</td>
        <td colspan="2">${esc(p.acc || '')}</td>
      </tr>
      <tr>
        <td>${L('Банк плательщика')}<br><b>${esc(p.bank_name || '')}</b></td>
        <td>${L('БИК')}</td>
        <td colspan="2">${esc(p.bik || '')}</td>
      </tr>
      <tr>
        <td></td>
        <td>${L('Сч. №')}</td>
        <td colspan="2">${esc(p.corr_acc || '')}</td>
      </tr>
      <tr>
        <td>${L('Банк получателя')}<br><b>${esc(r.bank_name || '')}</b></td>
        <td>${L('БИК')}</td>
        <td colspan="2">${esc(r.bik || '')}</td>
      </tr>
      <tr>
        <td></td>
        <td>${L('Сч. №')}</td>
        <td colspan="2">${esc(r.corr_acc || '')}</td>
      </tr>
      <tr>
        <td>${L('ИНН')} ${esc(r.inn || '')} &nbsp; ${L('КПП')} ${esc(r.kpp || '')}</td>
        <td>${L('Сч. №')}</td>
        <td colspan="2">${esc(r.acc || '')}</td>
      </tr>
      <tr>
        <td>${L('Получатель')}<br><b>${esc(r.full_name || r.name)}</b></td>
        <td>${L('Вид оп.')} ${esc(vidOper)}</td>
        <td>${L('Наз. пл.')}</td>
        <td>${L('Очер. плат.')} ${esc(ocher)}</td>
      </tr>
      <tr><td colspan="4">${L('Назначение платежа')}<br>${esc(doc.purpose || '')}</td></tr>
    </table>

    <div class="two" style="margin-top:26px">
      <div>Подписи<div class="line">${esc(p.signer || '')}</div></div>
      <div class="c" style="flex:0 0 90px">М.П.</div>
      <div>Отметки банка<div class="line">&nbsp;</div></div>
    </div>`;

  return page(`Платёжное поручение № ${doc.number || '1'}`, body);
}

module.exports = { buildPlatyozhkaHtml };
