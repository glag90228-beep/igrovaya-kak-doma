'use strict';

/**
 * Свой договор человека: хранение, заполнение и вёрстка.
 *
 * Зачем. Типовой договор годится, чтобы начать, но у работающего бизнеса
 * свой договор — выверенный, показанный юристу, привычный клиентам. Кейтеринг
 * годами шлёт один и тот же текст, меняя клиента, дату и место банкета.
 * Заставлять его переходить на наш бланк — значит, он к нам не перейдёт.
 *
 * Как устроено. Шаблон — текст договора с метками {{ключ}} и список полей,
 * которые меняются (их находит lib/contract-ai.js). Привязка: cp_id = 0 —
 * для всех клиентов, иначе — для одного. При выписке берётся шаблон клиента,
 * за ним общий, за ним — типовой бланк.
 *
 * Текст шаблона копируется в сам выписанный договор (payload). Человек
 * может завтра заменить шаблон — а договор, выписанный вчера, обязан
 * пересобраться ровно тем текстом, который подписали.
 *
 * Факсимиле на договор не ставим, как и на типовой: по ст. 160 ГК подпись-
 * картинка годится, только если стороны заранее об этом письменно
 * договорились (см. lib/facsimile.js). Строки для живой подписи есть.
 */

const { db } = require('../db');
const { esc, page, amountInWords } = require('./doc-html');
const { AUTO } = require('./contract-ai');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_contracts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      cp_id      INTEGER NOT NULL DEFAULT 0,   -- 0 — для всех клиентов
      title      TEXT    NOT NULL DEFAULT '',
      us_role    TEXT    NOT NULL DEFAULT '',
      them_role  TEXT    NOT NULL DEFAULT '',
      body       TEXT    NOT NULL,
      fields     TEXT    NOT NULL DEFAULT '[]',
      orig_name  TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL,
      UNIQUE (user_id, cp_id)
    );
    CREATE TABLE IF NOT EXISTS contract_reviews (
      user_id    INTEGER PRIMARY KEY,
      title      TEXT    NOT NULL DEFAULT '',
      text       TEXT    NOT NULL DEFAULT '',
      review     TEXT    NOT NULL DEFAULT '{}',
      at         TEXT    NOT NULL
    );
  `);
}
migrate();

const rowToTpl = (r) => (r ? {
  id: r.id,
  cpId: r.cp_id,
  title: r.title,
  usRole: r.us_role || 'Исполнитель',
  themRole: r.them_role || 'Заказчик',
  body: r.body,
  fields: (() => { try { return JSON.parse(r.fields || '[]'); } catch (_) { return []; } })(),
  origName: r.orig_name,
  createdAt: r.created_at,
} : null);

/** Сохранить (или заменить) шаблон: для всех (cpId 0) или для одного клиента. */
function saveTemplate(userId, cpId, tpl) {
  const body = String(tpl.body || '').slice(0, 200000);
  if (!body.trim()) throw new Error('пустой шаблон');
  db.prepare(`
    INSERT INTO user_contracts (user_id, cp_id, title, us_role, them_role, body, fields, orig_name, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, cp_id) DO UPDATE SET
      title = excluded.title, us_role = excluded.us_role, them_role = excluded.them_role,
      body = excluded.body, fields = excluded.fields, orig_name = excluded.orig_name,
      created_at = excluded.created_at`).run(
    userId, Number(cpId) || 0, String(tpl.title || 'Мой договор').slice(0, 120),
    String(tpl.usRole || '').slice(0, 40), String(tpl.themRole || '').slice(0, 40), body,
    JSON.stringify((tpl.fields || []).slice(0, 25)), String(tpl.origName || '').slice(0, 120),
    new Date().toISOString(),
  );
  return getOwn(userId, cpId);
}

/** Шаблон ровно этой привязки (без подстановки общего). */
function getOwn(userId, cpId) {
  return rowToTpl(db.prepare('SELECT * FROM user_contracts WHERE user_id = ? AND cp_id = ?')
    .get(userId, Number(cpId) || 0));
}

/** Какой шаблон действует для клиента: его собственный, иначе общий, иначе null. */
function getTemplate(userId, cpId) {
  return (cpId ? getOwn(userId, cpId) : null) || getOwn(userId, 0);
}

function getTemplateById(userId, id) {
  return rowToTpl(db.prepare('SELECT * FROM user_contracts WHERE user_id = ? AND id = ?').get(userId, Number(id)));
}

function listTemplates(userId) {
  return db.prepare('SELECT * FROM user_contracts WHERE user_id = ? ORDER BY cp_id').all(userId).map(rowToTpl);
}

function removeTemplate(userId, cpId) {
  return db.prepare('DELETE FROM user_contracts WHERE user_id = ? AND cp_id = ?')
    .run(userId, Number(cpId) || 0).changes > 0;
}

/** Поля, которые спрашиваем у человека: всё, что не подставляется само. */
function askFields(tpl) {
  return (tpl && tpl.fields ? tpl.fields : []).filter((f) => !AUTO.has(f.key));
}

// ── разобранный чужой договор (последний) ──

function saveReview(userId, { title, text, review }) {
  db.prepare(`INSERT INTO contract_reviews (user_id, title, text, review, at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET title = excluded.title, text = excluded.text,
      review = excluded.review, at = excluded.at`)
    .run(userId, String(title || '').slice(0, 120), String(text || '').slice(0, 120000),
      JSON.stringify(review || {}), new Date().toISOString());
}

/** Разбор одной строкой на поле — для консультанта и для озвучки. */
function reviewToText(r) {
  if (!r) return '';
  return [
    r.summary,
    r.parties && r.parties.length ? `Стороны: ${r.parties.map((p) => `${p.role} — ${p.name}${p.inn ? ` (ИНН ${p.inn})` : ''}`).join('; ')}.` : '',
    r.subject ? `Предмет: ${r.subject}.` : '',
    r.amount ? `Сумма: ${r.amount}.` : '',
    r.payment ? `Оплата: ${r.payment}.` : '',
    r.dates ? `Сроки: ${r.dates}.` : '',
    r.penalties ? `Штрафы: ${r.penalties}.` : '',
    r.termination ? `Расторжение: ${r.termination}.` : '',
    r.risks && r.risks.length ? `Риски: ${r.risks.map((x) => `${x.text}${x.fix ? ` (поправить: ${x.fix})` : ''}`).join('; ')}.` : '',
  ].filter(Boolean).join('\n');
}

/** Последний присланный договор — помощник отвечает на вопросы по нему. */
function getLastContract(userId) {
  const r = db.prepare('SELECT * FROM contract_reviews WHERE user_id = ?').get(userId);
  if (!r) return null;
  let review = {};
  try { review = JSON.parse(r.review || '{}'); } catch (_) { /* битая запись — без разбора */ }
  return { title: r.title, text: r.text || reviewToText(review), review, at: r.at };
}

// ── вёрстка ──

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
  'сентября', 'октября', 'ноября', 'декабря'];
const longDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]} г.` : String(iso || '');
};
const nameOf = (p) => (p && (p.full_name || p.name)) || '';
const cityOf = (org) => {
  const m = /г\.\s*([А-ЯЁ][А-Яа-яё-]+)/u.exec(String((org && org.address) || ''));
  return m ? `г. ${m[1]}` : '';
};
function requisites(p) {
  return [
    nameOf(p),
    p.inn ? `ИНН ${p.inn}${p.kpp ? ` / КПП ${p.kpp}` : ''}` : '',
    p.ogrn ? `ОГРН ${p.ogrn}` : '',
    p.address ? `Адрес: ${p.address}` : '',
    p.acc ? `Р/с ${p.acc}` : '',
    p.bank_name ? `Банк: ${p.bank_name}` : '',
    p.bik ? `БИК ${p.bik}${p.corr_acc ? `, К/с ${p.corr_acc}` : ''}` : '',
  ].filter(Boolean).join('\n');
}

const money = (n) => Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Значения всех меток: служебные — из реквизитов, остальные — что ввёл человек. */
function valuesFor({ org, cp, doc }) {
  const v = { ...(doc.values || {}) };
  if (v.price != null && v.price !== '') {
    const n = Number(String(v.price).replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(n)) { v.price_words = amountInWords(n); v.price = money(n); }
  }
  return {
    ...v,
    number: doc.number,
    contract_date: longDate(doc.date),
    city: cityOf(org) || v.city || '',
    us: nameOf(org),
    us_requisites: requisites(org || {}),
    us_signer: (org && org.signer) || '',
    them: nameOf(cp),
    them_requisites: requisites(cp || {}),
    them_signer: (cp && (cp.signer || cp.director)) || '',
  };
}

const BLANK = '____________';

/** Строка текста → HTML с подставленными значениями. */
function fillLine(line, vals) {
  return esc(line).replace(/\{\{([a-z][a-z0-9_]{0,30})\}\}/g, (_, k) => {
    const val = vals[k];
    return val == null || String(val).trim() === '' ? BLANK : esc(String(val)).replace(/\n/g, '<br>');
  });
}

const CSS = `
  .mc h1 { font-size: 15px; text-align: center; margin: 0 0 4px; }
  .mc .place { display: flex; justify-content: space-between; margin: 8px 0 14px; }
  .mc h2 { font-size: 12.5px; color: #1f2760; margin: 14px 0 5px; }
  .mc p { margin: 4px 0; text-align: justify; }
  .mc table.t { border-collapse: collapse; width: 100%; margin: 6px 0; }
  .mc table.t td { border: 1px solid #999; padding: 3px 6px; vertical-align: top; font-size: 11px; }
  .mc .parties { display: flex; gap: 28px; margin-top: 26px; }
  .mc .parties > div { flex: 1; }
  .mc .req { font-size: 10.5px; line-height: 1.45; }
  .mc .line { border-top: 1px solid #333; margin-top: 30px; padding-top: 3px; font-size: 10px; }
`;

const HEADING = /^(?:\d{1,2}\.\s+)?[А-ЯЁA-Z][^.!?;:]{2,70}$/u;

/** Договор по шаблону — HTML для печати в PDF. */
function buildHtml({ org, cp, doc }) {
  const vals = valuesFor({ org, cp, doc });
  const lines = String(doc.body || '').split('\n');
  const out = [];
  let table = null;
  let titled = false;
  const flush = () => { if (table) { out.push(`<table class="t">${table.join('')}</table>`); table = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); continue; }
    if (line.includes('\t')) {
      table = table || [];
      table.push(`<tr>${line.split('\t').map((c) => `<td>${fillLine(c, vals)}</td>`).join('')}</tr>`);
      continue;
    }
    flush();
    const t = line.trim();
    if (!titled) { out.push(`<h1>${fillLine(t, vals)}</h1>`); titled = true; continue; }
    // Короткая строка без точки на конце — заголовок раздела: «1. Предмет договора».
    if (HEADING.test(t) && t.length <= 72 && !/\{\{/.test(t)) out.push(`<h2>${fillLine(t, vals)}</h2>`);
    else out.push(`<p>${fillLine(t, vals)}</p>`);
  }
  flush();
  const body = String(doc.body || '');
  // Блока реквизитов в шаблоне нет — добавляем свой, со строками подписей.
  const hasReq = /\{\{(us|them)_requisites\}\}/.test(body);
  const parties = hasReq ? '' : `
    <h2>Реквизиты и подписи сторон</h2>
    <div class="parties">
      <div><div class="b">${esc(doc.usRole || 'Исполнитель')}</div>
        <div class="req">${esc(vals.us_requisites).replace(/\n/g, '<br>')}</div>
        <div class="line">${esc(vals.us_signer || 'подпись / расшифровка')}</div></div>
      <div><div class="b">${esc(doc.themRole || 'Заказчик')}</div>
        <div class="req">${esc(vals.them_requisites).replace(/\n/g, '<br>')}</div>
        <div class="line">${esc(vals.them_signer || 'подпись / расшифровка')}</div></div>
    </div>`;
  return page(`${doc.title || 'Договор'} № ${doc.number}`,
    `<style>${CSS}</style><div class="mc">${out.join('\n')}${parties}</div>`);
}

module.exports = {
  saveTemplate, getTemplate, getOwn, getTemplateById, listTemplates, removeTemplate, askFields,
  saveReview, getLastContract, reviewToText, buildHtml, valuesFor, longDate,
};
