'use strict';

// Telegram-бот «Трапеза Документы»: многопользовательский генератор
// актов сверки, актов услуг, счетов и платёжных поручений.
// Запуск: BOT_TOKEN=xxxxx node bot.js
// Логика роутинга экспортируется (handleUpdate) — тестируется без живого бота.

const { Telegram, keyboard } = require('./lib/tg');
const bdb = require('./lib/bot-db');
const { formatRub, amountInWords, round2 } = require('./lib/money');
const { buildAkt } = require('./lib/xlsx-akt');
const { buildAktUslugHtml } = require('./lib/akt-uslug');
const { buildSchetHtml } = require('./lib/schet');
const { buildPlatyozhkaHtml } = require('./lib/platyozhka');
const { buildUpdHtml } = require('./lib/upd');
const { buildTorg12Html } = require('./lib/torg12');
const { buildDogovorHtml } = require('./lib/dogovor');
const { pdfAvailable, htmlToPdf } = require('./lib/pdf');
const { visionAvailable, visionHint, readInvoice } = require('./lib/vision');
const { applySetup } = require('./lib/bot-setup');
const { supportScreen, forwardToSupport, legalLine } = require('./lib/bot-support');
const billing = require('./lib/billing');
const { payLink, daysFor } = require('./lib/lava');

// ---------- утилиты дат/чисел ----------

function todayISO() { return new Date().toISOString().slice(0, 10); }

/** «15.06.2026» / «15.06.26» / «15.06» → ISO; иначе null */
function parseDate(s) {
  const m = /^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/.exec(String(s).trim());
  if (!m) return null;
  const d = m[1].padStart(2, '0');
  const mo = m[2].padStart(2, '0');
  let y = m[3] || String(new Date().getFullYear());
  if (y.length === 2) y = '20' + y;
  return `${y}-${mo}-${d}`;
}
function parseAmount(s) {
  const v = Number(String(s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}
const clean = (s) => (String(s).trim() === '-' ? '' : String(s).trim());

// ---------- меню ----------

function mainMenu() {
  return keyboard([
    [{ text: '🏢 Моя организация', data: 'org' }],
    [{ text: '👥 Контрагенты', data: 'cps' }],
    [{ text: '💸 Кто должен', data: 'debts' }],
    [{ text: '📁 Мои документы', data: 'docs' }],
    [{ text: '⭐ Подписка', data: 'billing' }],
    [{ text: '❓ Помощь', data: 'help' }, { text: '💬 Поддержка', data: 'support' }],
  ]);
}

const GREETING =
  '<b>Трапеза Документы</b> — бот для актов и платёжек.\n\n'
  + 'Заведите свою организацию и контрагентов, вносите операции — '
  + 'и получайте готовые документы файлом:\n'
  + '• Акт сверки\n• Акт об оказании услуг\n• Счёт на оплату\n• Платёжное поручение\n\n'
  + 'С чего начнём?';

/** Приветствие с правовой строкой — она появляется, когда заданы адреса страниц. */
function greeting() {
  const legal = legalLine();
  return GREETING + (legal ? `\n\n<i>${legal}</i>` : '');
}

function cpMenu(userId, cp) {
  const b = bdb.balanceOf(userId, cp.id);
  const closing = b ? round2(b.closing) : 0;
  const favour = cp.kind === 'supplier' ? 'наш долг ему' : 'в нашу пользу';
  const info = `<b>${esc(cp.name)}</b>${cp.inn ? ` · ИНН ${esc(cp.inn)}` : ''}\n`
    + `Тип: ${cp.kind === 'supplier' ? 'поставщик' : 'заказчик'} · операций: ${b ? b.ops.length : 0}\n`
    + `Текущее сальдо: <b>${formatRub(Math.abs(closing))}</b> (${favour})`;
  const rows = [
    [{ text: '➕ Внести операцию', data: `op:${cp.id}` }],
    [{ text: '📄 Акт сверки', data: `d.akt:${cp.id}` }, { text: '🧾 Акт услуг', data: `d.usl:${cp.id}` }],
    [{ text: '💰 Счёт на оплату', data: `d.sch:${cp.id}` }, { text: '🏦 Платёжка', data: `d.pp:${cp.id}` }],
    [{ text: '📦 УПД', data: `d.upd:${cp.id}` }, { text: '🚚 ТОРГ-12', data: `d.torg12:${cp.id}` }],
    [{ text: '📝 Договор', data: `d.dog:${cp.id}` }],
  ];
  const lastSch = bdb.listDocs(userId, 1, cp.id).find((d) => ITEM_DOCS[d.type]);
  if (lastSch) {
    rows.push([{ text: `🔁 Повторить: ${lastSch.title.toLowerCase()} № ${lastSch.number}`, data: `d.rep:${lastSch.id}` }]);
  }
  rows.push([{ text: '📁 Документы по контрагенту', data: `docs.cp:${cp.id}` }]);
  rows.push([{ text: '↩️ Удалить последнюю операцию', data: `op.del:${cp.id}` }]);
  rows.push([{ text: '⬅️ К контрагентам', data: 'cps' }]);
  return { info, kb: keyboard(rows) };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ---------- пошаговые формы (организация, контрагент) ----------

const ORG_STEPS = [
  { key: 'name', q: 'Краткое название организации (напр. «ИП Иванов И. И.» или «ООО Ромашка»):' },
  { key: 'full_name', q: 'Полное наименование для документов (или «-» = как краткое):', opt: true },
  { key: 'inn', q: 'ИНН:' },
  { key: 'kpp', q: 'КПП (для ООО; ИП отправьте «-»):', opt: true },
  { key: 'signer', q: 'ФИО подписанта (напр. «И. И. Иванов»; или «-»):', opt: true },
  { key: 'address', q: 'Адрес (или «-»):', opt: true },
  { key: 'bank_name', q: 'Банк — наименование (или «-»):', opt: true },
  { key: 'bik', q: 'БИК (или «-»):', opt: true },
  { key: 'acc', q: 'Расчётный счёт р/с (или «-»):', opt: true },
  { key: 'corr_acc', q: 'Корр. счёт к/с (или «-»):', opt: true },
];

const CP_STEPS = [
  { key: 'name', q: 'Краткое имя контрагента (напр. «ООО Заря»):' },
  { key: 'full_name', q: 'Полное наименование (или «-»):', opt: true },
  { key: 'inn', q: 'ИНН контрагента (или «-»):', opt: true },
  { key: 'kpp', q: 'КПП (или «-»):', opt: true },
  {
    key: 'kind', q: 'Тип контрагента:',
    buttons: [{ text: 'Заказчик (платит нам)', val: 'customer' }, { text: 'Поставщик (платим ему)', val: 'supplier' }],
  },
  { key: 'contract', q: 'Договор (напр. «Договор № 5 от 01.02.2026»; или «-»):', opt: true },
  { key: 'opening_balance', q: 'Начальное сальдо, руб. (0 — если с нуля):', num: true },
  { key: 'opening_date', q: 'Дата начального сальдо (ДД.ММ.ГГГГ):', date: true },
  { key: 'bank_name', q: 'Банк контрагента (или «-»):', opt: true },
  { key: 'bik', q: 'БИК контрагента (или «-»):', opt: true },
  { key: 'acc', q: 'Расчётный счёт контрагента (или «-»):', opt: true },
  { key: 'corr_acc', q: 'Корр. счёт контрагента (или «-»):', opt: true },
  { key: 'address', q: 'Адрес контрагента (или «-»):', opt: true },
];

const FORMS = {
  org: { steps: ORG_STEPS, title: 'организации' },
  cp: { steps: CP_STEPS, title: 'контрагента' },
};

async function startForm(tg, chatId, user, formName) {
  bdb.setState(user.id, `form:${formName}`, { i: 0, values: {} });
  await askStep(tg, chatId, formName, 0);
}
async function askStep(tg, chatId, formName, i) {
  const step = FORMS[formName].steps[i];
  const opts = step.buttons
    ? keyboard([step.buttons.map((b) => ({ text: b.text, data: `fb:${b.val}` }))])
    : {};
  await tg.sendMessage(chatId, esc(step.q), opts);
}

async function applyFormValue(tg, chatId, user, state, rawValue) {
  const formName = state.state.slice(5);
  const form = FORMS[formName];
  const { i, values } = state.data;
  const step = form.steps[i];

  let value = rawValue;
  if (step.date) {
    const iso = parseDate(rawValue);
    if (!iso) { await tg.sendMessage(chatId, 'Не понял дату. Формат ДД.ММ.ГГГГ, напр. 01.05.2026:'); return; }
    value = iso;
  } else if (step.num) {
    const n = parseAmount(rawValue);
    if (n == null) { await tg.sendMessage(chatId, 'Нужно число, напр. 118309 или 0:'); return; }
    value = n;
  } else {
    value = step.opt ? clean(rawValue) : String(rawValue).trim();
    if (!step.opt && !value) { await tg.sendMessage(chatId, 'Поле обязательно, попробуйте ещё раз:'); return; }
  }

  values[step.key] = value;
  const next = i + 1;
  if (next < form.steps.length) {
    bdb.setState(user.id, `form:${formName}`, { i: next, values });
    await askStep(tg, chatId, formName, next);
  } else {
    bdb.clearState(user.id);
    await finishForm(tg, chatId, user, formName, values);
  }
}

async function finishForm(tg, chatId, user, formName, values) {
  if (formName === 'org') {
    if (!values.full_name) values.full_name = values.name;
    bdb.createOrg(user.id, values);
    await tg.sendMessage(chatId, `✅ Организация <b>${esc(values.name)}</b> сохранена.`, mainMenu());
  } else if (formName === 'cp') {
    if (!values.full_name) values.full_name = values.name;
    if (!values.period_end) values.period_end = todayISO();
    const id = bdb.createCp(user.id, values);
    const { info, kb } = cpMenu(user.id, bdb.getCp(user.id, id));
    await tg.sendMessage(chatId, `✅ Контрагент добавлен.\n\n${info}`, kb);
  }
}

// ---------- умный ввод операции ----------

const KIND_CREDIT = ['приход', 'поставка', 'отгрузка', 'услуга', 'услуги', 'реализация'];
const KIND_DEBIT = ['оплата', 'оплатил', 'принято', 'платеж', 'платёж', 'предоплата'];

/** «15.06 приход 94193 №15» → {date,kind,doc,debit,credit} | null */
function parseOp(text) {
  const tokens = String(text).trim().split(/\s+/);
  let date = null, kind = null, amount = null, docNo = '';
  for (const t of tokens) {
    const low = t.toLowerCase().replace(/[.,;:]$/, '');
    if (!date) { const d = parseDate(t); if (d) { date = d; continue; } }
    if (!kind && KIND_CREDIT.includes(low)) { kind = 'credit'; continue; }
    if (!kind && KIND_DEBIT.includes(low)) { kind = 'debit'; continue; }
    if (/^№/.test(t)) { docNo = t.replace(/^№/, ''); continue; }
    if (amount == null) { const a = parseAmount(t); if (a != null && a > 0) { amount = a; continue; } }
  }
  if (kind == null || amount == null) return null;
  if (!date) date = todayISO();
  const human = kind === 'credit'
    ? (KIND_CREDIT.includes('поставка') ? 'Приход' : 'Приход') : 'Оплата';
  const doc = `${human}${docNo ? ` (${docNo})` : ''} (${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)})`;
  return {
    date, kind: kind === 'credit' ? 'Приход' : 'Оплата', doc,
    debit: kind === 'debit' ? amount : 0, credit: kind === 'credit' ? amount : 0,
  };
}

// ---------- отправка документа ----------

const orgForAkt = (o) => ({
  brand: o.name, org_short: o.name, org_full: o.full_name || o.name,
  org_inn: o.inn, signer: o.signer,
});
// Имя файла: дефис оставляем — номера вида «СЧ-2026/007» читаются лучше,
// а слеш обязателен к замене, иначе получится подпапка.
const safeName = (s) => String(s).replace(/[«»"]/g, '').replace(/[^\wА-Яа-яЁё-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');

async function sendGenerated(tg, chatId, { html, xlsxBuffer, base, caption }) {
  await tg.sendChatAction(chatId, 'upload_document');
  if (xlsxBuffer) {
    await tg.sendDocument(chatId, { filename: `${base}.xlsx`, buffer: xlsxBuffer, caption });
    return;
  }
  if (pdfAvailable()) {
    try {
      const pdf = await htmlToPdf(html);
      await tg.sendDocument(chatId, { filename: `${base}.pdf`, buffer: pdf, caption });
      return;
    } catch (e) { /* упадём на HTML ниже */ }
  }
  await tg.sendDocument(chatId, {
    filename: `${base}.html`, buffer: Buffer.from(html, 'utf8'),
    caption: `${caption}\n\n(PDF недоступен — откройте файл в браузере и распечатайте / сохраните в PDF.)`,
  });
}

async function requireOrg(tg, chatId, user) {
  const org = bdb.getDefaultOrg(user.id);
  if (!org) {
    await tg.sendMessage(chatId, 'Сначала заведите свою организацию.', mainMenu());
    return null;
  }
  return org;
}

async function genAktSverki(tg, chatId, user, cpId) {
  const org = await requireOrg(tg, chatId, user); if (!org) return;
  const cp = bdb.getCp(user.id, cpId); if (!cp) return;
  if (!cp.period_end) { bdb.updateCp(user.id, cpId, { period_end: todayISO() }); cp.period_end = todayISO(); }
  const ops = bdb.listOps(user.id, cpId);
  const buf = await buildAkt({ org: orgForAkt(org), cp, ops });
  const seq = bdb.nextSeq(user.id, 'akt', new Date().getFullYear());
  await sendGenerated(tg, chatId, {
    xlsxBuffer: Buffer.from(buf), base: `Акт_сверки_${safeName(cp.name)}`,
    caption: `Акт сверки с <b>${esc(cp.name)}</b> за период ${ru(cp.opening_date)}—${ru(cp.period_end)}.`,
  });
  const b = bdb.balanceOf(user.id, cpId);
  bdb.saveDoc(user.id, {
    orgId: org.id, cpId, type: 'akt', number: String(seq), seq, date: todayISO(),
    total: b ? Math.abs(round2(b.closing)) : 0, payload: { ops: ops.length },
  });
}

// ---------- сбор позиций (для акта услуг и счёта) ----------

// Документы, которые набираются позициями: заголовок, сборщик и имя файла.
const ITEM_DOCS = {
  sch:    { title: 'Счёт на оплату',            build: buildSchetHtml,   file: 'Счет' },
  usl:    { title: 'Акт об оказании услуг',     build: buildAktUslugHtml, file: 'Акт_услуг' },
  upd:    { title: 'УПД',                       build: buildUpdHtml,     file: 'УПД' },
  torg12: { title: 'Товарная накладная ТОРГ-12', build: buildTorg12Html, file: 'ТОРГ-12' },
};

/** Клавиатура набора позиций: частые позиции кнопками + управление. */
function itemsKb(user, data) {
  const rows = bdb.listTemplates(user.id, 6).map((t) => ([{
    text: `➕ ${t.name} · ${formatRub(t.price)}`.slice(0, 60), data: `tpl:${t.id}`,
  }]));
  if (data.items.length) rows.push([{ text: '↩️ Убрать последнюю', data: 'items.undo' }]);
  rows.push([{ text: '✅ Готово', data: 'items.done' }]);
  rows.push([{ text: '✖️ Отмена', data: 'menu' }]);
  return keyboard(rows);
}

async function startItems(tg, chatId, user, type, cpId, extra = {}) {
  const year = new Date().getFullYear();
  const seq = bdb.nextSeq(user.id, type, year);
  const data = { seq, number: String(seq), date: todayISO(), items: [], ask: '', doc: extra };
  bdb.setState(user.id, `items:${type}:${cpId}`, data);
  const tpl = bdb.listTemplates(user.id, 6).length
    ? '\n\nЧастые позиции — кнопками ниже, количество спрошу.' : '';
  await tg.sendMessage(chatId,
    `Составляем <b>${esc(ITEM_DOCS[type].title)} № ${esc(data.number)}</b> от ${ru(data.date)}.\n`
    + 'Отправляйте позиции по одной:\n'
    + '<code>Наименование; количество; цена</code>\n'
    + 'Например: <code>Канапе ассорти; 20; 650</code>' + tpl,
    itemsKb(user, data));
}

/** Сводка перед выпуском: номер и дату можно поправить. */
async function showPreview(tg, chatId, user, state) {
  const [, type] = state.state.split(':');
  const d = state.data;
  const total = round2(d.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0));
  const lines = d.items.map((it, i) =>
    `${i + 1}. ${esc(it.name)} — ${it.qty} × ${formatRub(it.price)} = <b>${formatRub(round2(it.qty * it.price))}</b>`);
  const extra = d.doc || {};
  const head = extra.status
    ? ` · статус ${extra.status}${extra.status === 1
      ? `, НДС ${extra.vatRate == null ? 'не облагается' : `${extra.vatRate}%`}`
      + `${extra.vatRate == null ? '' : (extra.priceIncludesVat ? ', цены с НДС' : ', НДС сверху')}` : ''}`
    : '';
  await tg.sendMessage(chatId,
    `<b>${esc(ITEM_DOCS[type].title)} № ${esc(d.number)}</b> от ${ru(d.date)}${head}\n\n`
    + (lines.join('\n') || '— пусто —')
    + `\n\nИтого: <b>${formatRub(total)}</b>`,
    keyboard([
      [{ text: '📄 Сформировать документ', data: 'doc.make' }],
      [{ text: '✏️ Номер', data: 'doc.num' }, { text: '📅 Дата', data: 'doc.date' }],
      [{ text: '➕ Ещё позиция', data: 'items.more' }],
      [{ text: '✖️ Отмена', data: 'menu' }],
    ]));
}

function parseItemLine(text) {
  const parts = String(text).split(/[;|]/).map((s) => s.trim());
  if (parts.length >= 3) {
    const qty = parseAmount(parts[1]); const price = parseAmount(parts[parts.length - 1]);
    if (qty != null && price != null) return { name: parts[0], qty, unit: 'шт.', price };
  }
  // фолбэк: «Название 20 650»
  const m = /^(.+?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)$/.exec(text.trim());
  if (m) return { name: m[1].trim(), qty: parseAmount(m[2]), unit: 'шт.', price: parseAmount(m[3]) };
  return null;
}

/**
 * Выпускает счёт или акт услуг: собирает файл, запоминает позиции
 * как шаблоны и кладёт документ в журнал — чтобы потом «повторить».
 */
async function issueDoc(tg, chatId, user, { type, cpId, doc, seq, extra = {} }) {
  const org = await requireOrg(tg, chatId, user); if (!org) return false;
  const cp = bdb.getCp(user.id, cpId); if (!cp) return false;
  if (!doc.items.length) { await tg.sendMessage(chatId, 'Позиций нет — отменил.', mainMenu()); return false; }

  const total = round2(doc.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0));
  const kind = ITEM_DOCS[type];
  const q = bdb.quota(user.id);
  const tail = q.paid ? '' : `\n<i>Выписано в этом месяце: ${q.used + 1} из ${q.limit} бесплатных.</i>`;
  await sendGenerated(tg, chatId, {
    html: kind.build({ org, cp, doc }),
    base: `${kind.file}_${safeName(doc.number)}_${safeName(cp.name)}`,
    caption: `${esc(kind.title)} № ${esc(doc.number)}`
      + ` от ${ru(doc.date)} для <b>${esc(cp.name)}</b> на ${formatRub(total)}.`
      + (type === 'sch' ? '\nВ счёте есть QR — клиент платит, наведя камеру банка.' : '') + tail,
  });

  bdb.rememberItems(user.id, doc.items);
  bdb.saveDoc(user.id, {
    orgId: org.id, cpId, type, number: doc.number, seq, date: doc.date, total,
    payload: { items: doc.items, ...extra },
  });
  return true;
}

async function finishItems(tg, chatId, user, state) {
  const [, type, cpIdStr] = state.state.split(':');
  const cpId = Number(cpIdStr);
  const d = state.data;
  const doc = { number: d.number, date: d.date, items: d.items, ...(d.doc || {}) };
  bdb.clearState(user.id);
  const done = await issueDoc(tg, chatId, user, { type, cpId, doc, seq: d.seq, extra: d.doc || {} });
  if (!done) return;
  const cp = bdb.getCp(user.id, cpId);
  const { info, kb } = cpMenu(user.id, cp);
  await tg.sendMessage(chatId, info, kb);
}

/** Повтор ранее выписанного документа: те же позиции, новый номер и дата. */
async function repeatDoc(tg, chatId, user, docId) {
  const src = bdb.getDoc(user.id, docId);
  if (!src || !ITEM_DOCS[src.type]) {
    await tg.sendMessage(chatId, 'Такой документ повторить нельзя.', mainMenu());
    return;
  }
  const { items = [], ...extra } = src.payload || {};
  const year = new Date().getFullYear();
  const seq = bdb.nextSeq(user.id, src.type, year);
  const data = { seq, number: String(seq), date: todayISO(), items, ask: '', doc: extra };
  bdb.setState(user.id, `items:${src.type}:${src.cp_id}`, data);
  await tg.sendMessage(chatId,
    `Повторяю <b>${esc(src.title.toLowerCase())} № ${esc(src.number)}</b>: ${items.length} поз., `
    + `${formatRub(src.total)}.\nНовый номер — ${esc(data.number)}, дата — ${ru(data.date)}.`);
  await showPreview(tg, chatId, user, bdb.getState(user.id));
}

/** Журнал выписанного. */
async function showDocs(tg, chatId, user, cpId = null) {
  const docs = bdb.listDocs(user.id, 10, cpId);
  if (!docs.length) {
    await tg.sendMessage(chatId, 'Пока ничего не выписано.', mainMenu());
    return;
  }
  const q = bdb.quota(user.id);
  const rows = docs.map((d) => {
    const cp = d.cp_id ? bdb.getCp(user.id, d.cp_id) : null;
    const money = d.total ? ` · ${formatRub(d.total)}` : '';
    return [{
      text: `${d.title} № ${d.number} от ${ru(d.date)}${cp ? ` · ${cp.name}` : ''}${money}`.slice(0, 60),
      data: `doc:${d.id}`,
    }];
  });
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  await tg.sendMessage(chatId,
    `Последние документы (в этом месяце ${q.used}${q.paid ? '' : ` из ${q.limit} бесплатных`}):`,
    keyboard(rows));
}

/** Карточка документа: выслать файл заново или повторить новым номером. */
async function showDoc(tg, chatId, user, docId) {
  const d = bdb.getDoc(user.id, docId);
  if (!d) { await tg.sendMessage(chatId, 'Документ не найден.', mainMenu()); return; }
  const cp = d.cp_id ? bdb.getCp(user.id, d.cp_id) : null;
  const items = (d.payload.items || [])
    .map((it, i) => `${i + 1}. ${esc(it.name)} — ${it.qty} × ${formatRub(it.price)}`).join('\n');
  const rows = [];
  if (d.type !== 'akt') rows.push([{ text: '📄 Прислать файл заново', data: `doc.get:${d.id}` }]);
  if (ITEM_DOCS[d.type]) rows.push([{ text: '🔁 Повторить новым номером', data: `d.rep:${d.id}` }]);
  if (cp) rows.push([{ text: `👤 ${cp.name}`, data: `cp:${cp.id}` }]);
  rows.push([{ text: '🗑 Убрать из журнала', data: `doc.del:${d.id}` }]);
  rows.push([{ text: '⬅️ К документам', data: 'docs' }]);
  await tg.sendMessage(chatId,
    `<b>${esc(d.title)} № ${esc(d.number)}</b> от ${ru(d.date)}\n`
    + (cp ? `Контрагент: ${esc(cp.name)}\n` : '')
    + (d.total ? `Сумма: <b>${formatRub(d.total)}</b>\n` : '')
    + (items ? `\n${items}` : ''),
    keyboard(rows));
}

/** Повторная отправка файла по сохранённым данным. */
async function resendDoc(tg, chatId, user, docId) {
  const d = bdb.getDoc(user.id, docId);
  if (!d) { await tg.sendMessage(chatId, 'Документ не найден.', mainMenu()); return; }
  const org = bdb.getOrg(user.id, d.org_id) || bdb.getDefaultOrg(user.id);
  const cp = bdb.getCp(user.id, d.cp_id);
  if (!org || !cp) { await tg.sendMessage(chatId, 'Не хватает данных для сборки.', mainMenu()); return; }
  const doc = { number: d.number, date: d.date, ...d.payload };
  const kind = ITEM_DOCS[d.type]
    || (d.type === 'pp' ? { build: buildPlatyozhkaHtml, file: 'Платежка' } : null)
    || (d.type === 'dog' ? { build: buildDogovorHtml, file: 'Договор' } : null);
  const build = kind && kind.build; const base = kind && kind.file;
  if (!build) { await tg.sendMessage(chatId, 'Этот документ пересобрать нельзя.', mainMenu()); return; }
  await sendGenerated(tg, chatId, {
    html: build({ org, cp, doc }),
    base: `${base}_${safeName(d.number)}_${safeName(cp.name)}`,
    caption: `${esc(d.title)} № ${esc(d.number)} от ${ru(d.date)} — копия.`,
  });
}

// ---------- платёжка (сумма + назначение) ----------

// ---------- подписка ----------

const isOwner = (chatId) => Boolean(process.env.SUPPORT_CHAT_ID)
  && String(chatId) === String(process.env.SUPPORT_CHAT_ID);

async function showBilling(tg, chatId, user) {
  bdb.clearState(user.id);
  const a = billing.accessInfo(user.id);
  const q = bdb.quota(user.id);
  const link = payLink(user.tg_id);

  const lines = ['<b>Подписка</b>', ''];
  if (a.active) {
    lines.push(`Доступ оплачен до <b>${ru(a.until)}</b> — осталось ${a.left} ${plural(a.left, 'день', 'дня', 'дней')}.`);
  } else {
    lines.push(`Сейчас бесплатно: выписано ${q.used} из ${q.limit} документов в этом месяце.`);
    lines.push('');
    lines.push('Подписка снимает лимит и оставляет всё остальное как есть.');
  }
  if (!link) {
    lines.push('');
    lines.push('<i>Оплата пока не подключена. Напишите в поддержку — выдадим доступ вручную.</i>');
  }

  const rows = [];
  if (link) rows.push([{ text: a.active ? '⭐ Продлить' : '⭐ Оформить подписку', url: link }]);
  if (link) rows.push([{ text: '✅ Я оплатил', data: 'pay.claim' }]);
  const history = billing.paymentsOf(user.id, 3);
  if (history.length) {
    lines.push('');
    lines.push('Последние оплаты: ' + history
      .map((h) => `${formatRub(h.amount)} · ${ru(String(h.created_at).slice(0, 10))}`).join(', '));
  }
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  await tg.sendMessage(chatId, lines.join('\n'), keyboard(rows));
}

/**
 * «Я оплатил»: площадка не всегда возвращает наш параметр, и тогда платёж
 * приходит ничей. Ищем его по почте, которую человек указал на кассе.
 */
async function claimByEmail(tg, chatId, user, email) {
  bdb.clearState(user.id);
  const clean = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    await tg.sendMessage(chatId, 'Это не похоже на почту. Пришлите адрес, который указывали при оплате.',
      keyboard([[{ text: '⬅️ Подписка', data: 'billing' }]]));
    return;
  }
  const found = billing.unclaimedByEmail(clean);
  if (!found.length) {
    await tg.sendMessage(chatId,
      'Оплату по этой почте не вижу. Деньги могли ещё не дойти — попробуйте через пару минут. '
      + 'Если прошло больше получаса, напишите в поддержку, разберёмся вручную.',
      keyboard([[{ text: '💬 Поддержка', data: 'support' }], [{ text: '⬅️ Подписка', data: 'billing' }]]));
    return;
  }
  let until = '';
  for (const p of found) {
    billing.attachPayment(p.id, user.id);
    until = billing.grantDays(user.id, p.days || 30);
  }
  await tg.sendMessage(chatId,
    `✅ Нашёл ${found.length} ${plural(found.length, 'оплату', 'оплаты', 'оплат')}. `
    + `Доступ до <b>${ru(until)}</b>.`, mainMenu());
}

/** Команды владельца: выдать доступ руками и посмотреть, у кого он есть. */
async function ownerCommand(tg, chatId, text) {
  const grant = /^\/grant\s+(\S+)\s+(\d+)/.exec(text);
  if (grant) {
    const who = grant[1].replace(/^@/, '');
    const days = Number(grant[2]);
    const target = /^\d+$/.test(who)
      ? bdb.getOrCreateUser(Number(who))
      : bdb.reachableUsers().find((u) => String(u.username).toLowerCase() === who.toLowerCase());
    if (!target) { await tg.sendMessage(chatId, `Не нашёл пользователя ${esc(who)}.`); return true; }
    const until = billing.grantDays(target.id, days);
    await tg.sendMessage(chatId, `Выдал ${days} дн. пользователю ${esc(target.name || who)} — до ${ru(until)}.`);
    try {
      await tg.sendMessage(target.tg_id, `✅ Доступ продлён до <b>${ru(until)}</b>.`);
    } catch (e) { if (e && e.blocked) bdb.markBlocked(target.id); }
    return true;
  }
  if (text === '/who') {
    const list = billing.paidUsers();
    await tg.sendMessage(chatId, list.length
      ? '<b>С оплаченным доступом:</b>\n' + list.map((u) =>
        `• ${esc(u.name || u.tg_id)}${u.username ? ` @${esc(u.username)}` : ''} — до ${ru(u.access_until)}`).join('\n')
      : 'Оплаченных доступов нет.');
    return true;
  }
  return false;
}

// ---------- поддержка ----------

async function showSupport(tg, chatId, user) {
  bdb.clearState(user.id);
  const { text, rows } = supportScreen();
  await tg.sendMessage(chatId, text, keyboard(rows));
}

async function handleSupportText(tg, chatId, user, text) {
  bdb.clearState(user.id);
  let sentOk = false;
  try {
    sentOk = await forwardToSupport(tg, { user, chatId, text });
  } catch (e) {
    sentOk = false;
  }
  await tg.sendMessage(chatId, sentOk
    ? '✅ Отправил. Ответим сюда же, в этот чат.'
    : 'Не получилось отправить обращение. Напишите нам напрямую — контакт в разделе «Поддержка».',
  mainMenu());
}

// ---------- УПД: статус и НДС ----------

/**
 * У УПД два режима, и разница принципиальная: статус 1 — это счёт-фактура,
 * его выставляет только плательщик НДС. Молча выбрать за пользователя нельзя,
 * поэтому спрашиваем — и сразу подписываем, кому какой нужен.
 */
async function askUpdStatus(tg, chatId, user, cpId) {
  const org = await requireOrg(tg, chatId, user); if (!org) return;
  await tg.sendMessage(chatId,
    'Какой УПД нужен?\n\n'
    + '<b>Статус 2</b> — только передаточный документ (акт). Для тех, кто на упрощёнке '
    + 'и НДС не платит.\n'
    + '<b>Статус 1</b> — счёт-фактура и акт в одном документе. Выставляют плательщики НДС; '
    + 'спрошу ставку и посчитаю налог.',
    keyboard([
      [{ text: '📄 Статус 2 — без счёта-фактуры', data: `upd.s2:${cpId}` }],
      [{ text: '🧾 Статус 1 — со счётом-фактурой', data: `upd.s1:${cpId}` }],
      [{ text: '✖️ Отмена', data: `cp:${cpId}` }],
    ]));
}

async function askUpdRate(tg, chatId, user, cpId) {
  await tg.sendMessage(chatId, 'Ставка НДС:',
    keyboard([
      [{ text: '20%', data: `upd.r:${cpId}:20` }, { text: '10%', data: `upd.r:${cpId}:10` }],
      [{ text: '0%', data: `upd.r:${cpId}:0` }],
      [{ text: 'Без НДС (освобождение)', data: `upd.r:${cpId}:none` }],
      [{ text: '✖️ Отмена', data: `cp:${cpId}` }],
    ]));
}

async function askUpdGross(tg, chatId, user, cpId, rate) {
  if (rate === 'none') {
    await startItems(tg, chatId, user, 'upd', cpId, { status: 1, vatRate: null });
    return;
  }
  await tg.sendMessage(chatId,
    `Ставка ${rate}%. Цены, которые будете вводить, — с налогом или без?\n`
    + '<i>От этого зависит, что попадёт в графу 4 и в сумму налога.</i>',
    keyboard([
      [{ text: 'Цены с НДС (выделить из суммы)', data: `upd.g:${cpId}:${rate}:1` }],
      [{ text: 'Цены без НДС (начислить сверху)', data: `upd.g:${cpId}:${rate}:0` }],
      [{ text: '✖️ Отмена', data: `cp:${cpId}` }],
    ]));
}

// ---------- фотография счёта → операция ----------

/**
 * Присланное фото распознаём и предлагаем занести операцией.
 * Ничего не сохраняем молча: пользователь видит, что прочиталось,
 * и подтверждает. Ошибиться в сумме тут стоит дороже, чем переспросить.
 */
async function handlePhoto(tg, chatId, user, msg) {
  if (!visionAvailable()) {
    await tg.sendMessage(chatId,
      'Распознавание фото пока не подключено — нужен внешний сервис.\n'
      + `<i>${esc(visionHint())}</i>\n\n`
      + 'Пока внесите операцию текстом: <code>15.06 приход 94193</code>', mainMenu());
    return;
  }

  // самое крупное превью или картинка-документом
  let fileId = null; let mime = 'image/jpeg';
  if (msg.photo && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document && /^image\//.test(msg.document.mime_type || '')) {
    fileId = msg.document.file_id;
    mime = msg.document.mime_type;
  }
  if (!fileId) return;

  await tg.sendChatAction(chatId, 'typing');
  let buf;
  try { buf = await tg.downloadFile(fileId); } catch (e) {
    await tg.sendMessage(chatId, `Не смог забрать файл: ${esc(e.message)}`, mainMenu());
    return;
  }

  const res = await readInvoice(buf, mime);
  if (!res.ok) {
    await tg.sendMessage(chatId,
      `Распознать не вышло: ${esc(res.error)}\nВнесите операцию текстом.`, mainMenu());
    return;
  }
  const f = res.fields || {};
  if (!f.amount) {
    await tg.sendMessage(chatId,
      'Сумму на снимке разобрать не удалось — бывает при бликах и мятой бумаге.\n'
      + 'Пришлите фото поровнее или внесите операцию текстом.', mainMenu());
    return;
  }

  // если ИНН совпал с известным контрагентом — предложим его первым
  const cps = bdb.listCps(user.id);
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const matched = f.inn ? cps.find((c) => digits(c.inn) && digits(c.inn) === digits(f.inn)) : null;

  bdb.setState(user.id, 'photo', { fields: f });

  const rows = [];
  if (matched) rows.push([{ text: `✅ ${matched.name}`, data: `ph.cp:${matched.id}` }]);
  for (const c of cps) {
    if (matched && c.id === matched.id) continue;
    rows.push([{ text: `${c.kind === 'supplier' ? '📦' : '🧑‍💼'} ${c.name}`, data: `ph.cp:${c.id}` }]);
  }
  rows.push([{ text: '✖️ Отмена', data: 'menu' }]);

  await tg.sendMessage(chatId,
    'Со снимка прочитал:\n'
    + `Сумма: <b>${formatRub(f.amount)}</b>\n`
    + `Дата: ${f.date ? ru(f.date) : '<i>не видно, поставлю сегодняшнюю</i>'}\n`
    + (f.docNo ? `Документ: № ${esc(f.docNo)}\n` : '')
    + (f.name ? `Контрагент: ${esc(f.name)}\n` : '')
    + (f.inn ? `ИНН: ${esc(f.inn)}${matched ? ' — узнал' : ' — такого контрагента нет'}\n` : '')
    + '\nК кому отнести операцию?',
    keyboard(rows));
}

async function photoPickKind(tg, chatId, user, cpId) {
  const state = bdb.getState(user.id);
  if (state.state !== 'photo') return;
  const cp = bdb.getCp(user.id, cpId);
  if (!cp) { await tg.sendMessage(chatId, 'Контрагент не найден.', mainMenu()); return; }
  bdb.setState(user.id, 'photo', { ...state.data, cpId });
  await tg.sendMessage(chatId,
    `<b>${esc(cp.name)}</b> · ${formatRub(state.data.fields.amount)}\nЧто это за операция?`,
    keyboard([
      [{ text: '📈 Приход — мы оказали, нам должны', data: 'ph.k:credit' }],
      [{ text: '📉 Оплата — нам заплатили', data: 'ph.k:debit' }],
      [{ text: '✖️ Отмена', data: 'menu' }],
    ]));
}

async function photoSaveOp(tg, chatId, user, kind) {
  const state = bdb.getState(user.id);
  if (state.state !== 'photo' || !state.data.cpId) return;
  const f = state.data.fields;
  const date = f.date || todayISO();
  const human = kind === 'credit' ? 'Приход' : 'Оплата';
  const op = {
    date, kind: human,
    doc: `${human}${f.docNo ? ` (${f.docNo})` : ''} (${ru(date)})`,
    debit: kind === 'debit' ? f.amount : 0,
    credit: kind === 'credit' ? f.amount : 0,
    note: 'с фотографии',
  };
  const cpId = state.data.cpId;
  bdb.clearState(user.id);
  bdb.addOp(user.id, cpId, op);
  const b = bdb.balanceOf(user.id, cpId);
  const cp = bdb.getCp(user.id, cpId);
  await tg.sendMessage(chatId,
    `✅ ${human}: ${formatRub(f.amount)} (${ru(date)}) — занёс со снимка.\n`
    + `Текущее сальдо: <b>${formatRub(Math.abs(round2(b.closing)))}</b>.`);
  const { info, kb } = cpMenu(user.id, cp);
  await tg.sendMessage(chatId, info, kb);
}

// ---------- дебиторка ----------

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

async function showDebts(tg, chatId, user) {
  const rows = bdb.debtors(user.id);
  if (!rows.length) {
    await tg.sendMessage(chatId, 'Все рассчитались — незакрытых сальдо нет. 👌', mainMenu());
    return;
  }
  const theyOwe = rows.filter((r) => r.theyOwe);
  const weOwe = rows.filter((r) => !r.theyOwe);
  const sum = (list) => round2(list.reduce((s, r) => s + r.amount, 0));

  const line = (r) => {
    const quiet = r.days == null ? '' : ` · без движения ${r.days} ${plural(r.days, 'день', 'дня', 'дней')}`;
    const flag = r.days != null && r.days > 60 ? ' ⚠️' : '';
    return `• <b>${esc(r.cp.name)}</b> — ${formatRub(r.amount)}${quiet}${flag}`;
  };

  let text = '';
  if (theyOwe.length) {
    text += `<b>Нам должны — ${formatRub(sum(theyOwe))}</b>\n${theyOwe.map(line).join('\n')}\n\n`;
  }
  if (weOwe.length) {
    text += `<b>Мы должны — ${formatRub(sum(weOwe))}</b>\n${weOwe.map(line).join('\n')}\n\n`;
  }
  text += '⚠️ — больше двух месяцев без единой операции.';

  const kb = [];
  if (theyOwe.length) {
    kb.push([{ text: `📄 Акты сверки всем должникам (${theyOwe.length})`, data: 'debt.akts' }]);
    kb.push([{ text: '✉️ Текст напоминания', data: 'debt.remind' }]);
  }
  for (const r of rows.slice(0, 6)) {
    kb.push([{ text: `${r.theyOwe ? '🧑‍💼' : '📦'} ${r.cp.name} · ${formatRub(r.amount)}`.slice(0, 60), data: `cp:${r.cp.id}` }]);
  }
  kb.push([{ text: '⬅️ Меню', data: 'menu' }]);
  await tg.sendMessage(chatId, text, keyboard(kb));
}

/** Акты сверки по всем, кто нам должен, — одним нажатием. */
async function sendDebtAkts(tg, chatId, user) {
  const org = await requireOrg(tg, chatId, user); if (!org) return;
  const rows = bdb.debtors(user.id).filter((r) => r.theyOwe);
  if (!rows.length) { await tg.sendMessage(chatId, 'Должников нет.', mainMenu()); return; }
  await tg.sendMessage(chatId,
    `Собираю ${rows.length} ${plural(rows.length, 'акт', 'акта', 'актов')} сверки — по одному на должника.`);
  for (const r of rows) {
    await genAktSverki(tg, chatId, user, r.cp.id);
  }
  await tg.sendMessage(chatId,
    'Готово. Файлы перешлите должникам — бот не пишет вашим контрагентам сам, '
    + 'у него нет их контактов.', mainMenu());
}

/** Готовый текст, который остаётся переслать должнику. */
async function debtReminder(tg, chatId, user) {
  const org = bdb.getDefaultOrg(user.id);
  const rows = bdb.debtors(user.id).filter((r) => r.theyOwe);
  if (!rows.length) { await tg.sendMessage(chatId, 'Должников нет.', mainMenu()); return; }
  await tg.sendMessage(chatId, 'Тексты ниже — скопируйте и отправьте каждому. Один должник — одно сообщение:');
  for (const r of rows.slice(0, 10)) {
    const bank = org && org.acc
      ? `\n\nРеквизиты для оплаты:\n${org.bank_name || ''}\nБИК ${org.bik || '—'}\nР/с ${org.acc}`
      : '';
    await tg.sendMessage(chatId,
      `<code>Здравствуйте!\n\n`
      + `По нашим данным на ${ru(todayISO())} за вами числится задолженность `
      + `${formatRub(r.amount).replace(/ /g, ' ')}`
      + `${r.cp.contract ? ` по ${r.cp.contract}` : ''}.\n\n`
      + `Направляем акт сверки. Просим подтвердить сумму и сообщить срок оплаты. `
      + `Если платёж уже прошёл — пришлите, пожалуйста, платёжное поручение.`
      + `${bank}\n\nС уважением,\n${(org && (org.full_name || org.name)) || ''}</code>`);
  }
}

// ---------- договор (три вопроса, остальное из реквизитов) ----------

const DOG_STEPS = [
  { key: 'subject', q: 'Предмет договора — что оказываем? Напр.: «услуги по организации фуршетного обслуживания»:' },
  { key: 'price', q: 'Фиксированная сумма договора, руб. Если платим по счетам — отправьте <code>0</code>:', num: true },
  { key: 'term', q: 'До какой даты действует? Напр. «31.12.2026» или «-» = до конца года:', opt: true },
];

async function startDogovor(tg, chatId, user, cpId) {
  const org = await requireOrg(tg, chatId, user); if (!org) return;
  const cp = bdb.getCp(user.id, cpId); if (!cp) return;
  const seq = bdb.nextSeq(user.id, 'dog', new Date().getFullYear());
  bdb.setState(user.id, `dog:${cpId}`, { i: 0, seq, number: String(seq), date: todayISO(), values: {} });
  await tg.sendMessage(chatId,
    `Договор № ${seq} с <b>${esc(cp.name)}</b>. Реквизиты обеих сторон подставлю сам — `
    + 'нужно три ответа.');
  await tg.sendMessage(chatId, esc(DOG_STEPS[0].q));
}

async function handleDogText(tg, chatId, user, state, text) {
  const cpId = Number(state.state.split(':')[1]);
  const d = state.data;
  const step = DOG_STEPS[d.i];

  if (step.num) {
    const n = parseAmount(text);
    if (n == null || n < 0) { await tg.sendMessage(chatId, 'Нужно число, напр. 150000 или 0:'); return; }
    d.values[step.key] = n;
  } else {
    d.values[step.key] = clean(text);
  }

  d.i += 1;
  if (d.i < DOG_STEPS.length) {
    bdb.setState(user.id, state.state, d);
    await tg.sendMessage(chatId, esc(DOG_STEPS[d.i].q));
    return;
  }

  const org = bdb.getDefaultOrg(user.id);
  const cp = bdb.getCp(user.id, cpId);
  bdb.clearState(user.id);
  if (!org || !cp) { await tg.sendMessage(chatId, 'Не хватает данных.', mainMenu()); return; }

  const doc = {
    number: d.number, date: d.date, subject: d.values.subject,
    price: d.values.price, term: d.values.term,
  };
  await sendGenerated(tg, chatId, {
    html: buildDogovorHtml({ org, cp, doc }),
    base: `Договор_${safeName(doc.number)}_${safeName(cp.name)}`,
    caption: `Договор № ${esc(doc.number)} от ${ru(doc.date)} с <b>${esc(cp.name)}</b>.`
      + '\nШаблон общего назначения — под конкретную сделку покажите юристу.',
  });
  bdb.saveDoc(user.id, {
    orgId: org.id, cpId, type: 'dog', number: doc.number, seq: d.seq, date: doc.date,
    total: Number(doc.price) || 0, payload: { subject: doc.subject, price: doc.price, term: doc.term },
  });
  const { info, kb } = cpMenu(user.id, cp);
  await tg.sendMessage(chatId, info, kb);
}

async function startPp(tg, chatId, user, cpId) {
  const org = await requireOrg(tg, chatId, user); if (!org) return;
  const seq = bdb.nextSeq(user.id, 'pp', new Date().getFullYear());
  bdb.setState(user.id, `pp:${cpId}`, { step: 'amount', seq, number: String(seq), date: todayISO() });
  await tg.sendMessage(chatId, `Платёжное поручение № ${seq}. Введите <b>сумму</b>, руб.:`);
}
async function handlePpText(tg, chatId, user, state, text) {
  const cpId = Number(state.state.split(':')[1]);
  if (state.data.step === 'amount') {
    const a = parseAmount(text);
    if (a == null || a <= 0) { await tg.sendMessage(chatId, 'Нужна сумма числом, напр. 26496.42:'); return; }
    bdb.setState(user.id, `pp:${cpId}`, { ...state.data, step: 'purpose', amount: a });
    await tg.sendMessage(chatId, 'Назначение платежа (напр. «Оплата по договору № 5 от 01.02.2026»):');
    return;
  }
  // purpose
  const org = await requireOrg(tg, chatId, user); if (!org) { bdb.clearState(user.id); return; }
  const cp = bdb.getCp(user.id, cpId); if (!cp) { bdb.clearState(user.id); return; }
  const doc = { number: state.data.number, date: state.data.date, amount: state.data.amount, purpose: String(text).trim() };
  bdb.clearState(user.id);
  const html = buildPlatyozhkaHtml({ org, cp, doc });
  await sendGenerated(tg, chatId, {
    html, base: `Платежка_${safeName(doc.number)}_${safeName(cp.name)}`,
    caption: `Платёжное поручение № ${esc(doc.number)} получателю <b>${esc(cp.name)}</b> на ${formatRub(doc.amount)}.`,
  });
  bdb.saveDoc(user.id, {
    orgId: org.id, cpId, type: 'pp', number: doc.number, seq: state.data.seq,
    date: doc.date, total: doc.amount, payload: { amount: doc.amount, purpose: doc.purpose },
  });
  const { info, kb } = cpMenu(user.id, cp);
  await tg.sendMessage(chatId, info, kb);
}

const ru = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso || '');

// ---------- контрагенты: список и вход ----------

async function showCps(tg, chatId, user) {
  const cps = bdb.listCps(user.id);
  if (!cps.length) {
    await tg.sendMessage(chatId, 'Контрагентов пока нет.', keyboard([[{ text: '➕ Добавить контрагента', data: 'cp.new' }], [{ text: '⬅️ Меню', data: 'menu' }]]));
    return;
  }
  const rows = cps.map((c) => [{ text: `${c.kind === 'supplier' ? '📦' : '🧑‍💼'} ${c.name}`, data: `cp:${c.id}` }]);
  rows.push([{ text: '➕ Добавить контрагента', data: 'cp.new' }]);
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  await tg.sendMessage(chatId, 'Ваши контрагенты:', keyboard(rows));
}

async function showOrg(tg, chatId, user) {
  const org = bdb.getDefaultOrg(user.id);
  if (!org) {
    await tg.sendMessage(chatId, 'Организация ещё не заведена.', keyboard([[{ text: '➕ Завести организацию', data: 'org.new' }], [{ text: '⬅️ Меню', data: 'menu' }]]));
    return;
  }
  const txt = `<b>${esc(org.name)}</b>\n`
    + `${esc(org.full_name || '')}\n`
    + `ИНН ${esc(org.inn || '—')}${org.kpp ? ` · КПП ${esc(org.kpp)}` : ''}\n`
    + `Подписант: ${esc(org.signer || '—')}\n`
    + `Банк: ${esc(org.bank_name || '—')}${org.bik ? ` · БИК ${esc(org.bik)}` : ''}\n`
    + `Р/с: ${esc(org.acc || '—')}`;
  await tg.sendMessage(chatId, txt, keyboard([[{ text: '✏️ Изменить (ввести заново)', data: 'org.new' }], [{ text: '⬅️ Меню', data: 'menu' }]]));
}

// ---------- главный обработчик апдейта ----------

async function handleUpdate(tg, update) {
  try {
    return await route(tg, update);
  } catch (e) {
    // Пользователь заблокировал бота или удалил чат: писать ему больше некуда.
    // Помечаем и молчим — иначе каждая попытка будет ошибкой в логе.
    if (e && e.blocked) {
      const from = (update.callback_query || update.message || {}).from || {};
      if (from.id) {
        const u = bdb.getOrCreateUser(from.id);
        bdb.markBlocked(u.id);
        console.log(`Пользователь ${from.id} заблокировал бота — помечен`);
      }
      return undefined;
    }
    throw e;
  }
}

async function route(tg, update) {
  if (update.callback_query) return handleCallback(tg, update.callback_query);
  const msg = update.message;
  if (!msg) return undefined;
  if (msg.photo || (msg.document && /^image\//.test(msg.document.mime_type || ''))) {
    const from = msg.from || {};
    const user = bdb.getOrCreateUser(from.id, [from.first_name, from.last_name].filter(Boolean).join(' '), from.username || '');
    bdb.markActive(user.id);
    return handlePhoto(tg, msg.chat.id, user, msg);
  }
  if (msg.text) return handleMessage(tg, msg);
  return undefined;
}

async function handleMessage(tg, msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const user = bdb.getOrCreateUser(from.id, [from.first_name, from.last_name].filter(Boolean).join(' '), from.username || '');
  bdb.markActive(user.id); // писал — значит не заблокирован
  const text = msg.text.trim();

  if (isOwner(chatId) && await ownerCommand(tg, chatId, text)) return;

  if (text === '/start') { bdb.clearState(user.id); await tg.sendMessage(chatId, greeting(), mainMenu()); return; }
  if (text === '/menu' || text === '/cancel') { bdb.clearState(user.id); await tg.sendMessage(chatId, 'Главное меню:', mainMenu()); return; }
  // Команды из меню Telegram — те же экраны, что и кнопки. Если человек
  // выбрал команду в середине формы, шаг сбрасываем: он передумал.
  const SLASH = { '/org': 'org', '/cps': 'cps', '/debts': 'debts', '/docs': 'docs',
    '/help': 'help', '/support': 'support', '/subscription': 'billing' };
  if (SLASH[text]) {
    bdb.clearState(user.id);
    await handleCallback(tg, {
      id: 'cmd', from: msg.from, data: SLASH[text], message: { chat: { id: chatId } },
    });
    return;
  }

  const state = bdb.getState(user.id);
  if (state.state.startsWith('form:')) { await applyFormValue(tg, chatId, user, state, text); return; }
  if (state.state.startsWith('items:')) {
    const d = state.data;

    // ждём номер, дату или количество для позиции из шаблона
    if (d.ask === 'number') {
      d.number = text.slice(0, 20); d.ask = '';
      bdb.setState(user.id, state.state, d);
      await showPreview(tg, chatId, user, bdb.getState(user.id));
      return;
    }
    if (d.ask === 'date') {
      const iso = parseDate(text);
      if (!iso) { await tg.sendMessage(chatId, 'Не понял дату. Формат ДД.ММ.ГГГГ:'); return; }
      d.date = iso; d.ask = '';
      bdb.setState(user.id, state.state, d);
      await showPreview(tg, chatId, user, bdb.getState(user.id));
      return;
    }
    if (d.ask === 'qty') {
      const qty = parseAmount(text);
      if (qty == null || qty <= 0) { await tg.sendMessage(chatId, 'Нужно количество числом, напр. 20:'); return; }
      const t = bdb.getTemplate(user.id, d.tplId);
      d.ask = ''; d.tplId = 0;
      if (t) d.items.push({ name: t.name, qty, unit: t.unit || 'шт.', price: t.price });
      bdb.setState(user.id, state.state, d);
      await tg.sendMessage(chatId,
        t ? `Добавлено: ${esc(t.name)} — ${qty} × ${formatRub(t.price)}.` : 'Шаблон не найден.',
        itemsKb(user, d));
      return;
    }

    const item = parseItemLine(text);
    if (!item) { await tg.sendMessage(chatId, 'Не разобрал. Формат: <code>Наименование; кол-во; цена</code>'); return; }
    d.items.push(item);
    bdb.setState(user.id, state.state, d);
    await tg.sendMessage(chatId,
      `Добавлено: ${esc(item.name)} — ${item.qty} × ${formatRub(item.price)}. Ещё позицию или «Готово».`,
      itemsKb(user, d));
    return;
  }
  if (state.state.startsWith('pp:')) { await handlePpText(tg, chatId, user, state, text); return; }
  if (state.state.startsWith('dog:')) { await handleDogText(tg, chatId, user, state, text); return; }
  if (state.state === 'support') { await handleSupportText(tg, chatId, user, text); return; }
  if (state.state === 'claim') { await claimByEmail(tg, chatId, user, text); return; }
  if (state.state.startsWith('op:')) {
    const cpId = Number(state.state.split(':')[1]);
    const op = parseOp(text);
    if (!op) { await tg.sendMessage(chatId, 'Не разобрал операцию. Пример: <code>15.06 приход 94193</code> или <code>02.07 оплата 50000</code>'); return; }
    bdb.addOp(user.id, cpId, op);
    const b = bdb.balanceOf(user.id, cpId);
    await tg.sendMessage(chatId,
      `✅ ${op.kind}: ${formatRub(op.debit || op.credit)} (${ru(op.date)}).\nТекущее сальдо: <b>${formatRub(Math.abs(round2(b.closing)))}</b>.\n\nЕщё операция или /menu.`);
    return;
  }

  // нет активного шага — показать меню
  await tg.sendMessage(chatId, 'Выберите действие:', mainMenu());
}

async function handleCallback(tg, cq) {
  const chatId = cq.message.chat.id;
  const from = cq.from || {};
  const user = bdb.getOrCreateUser(from.id, [from.first_name, from.last_name].filter(Boolean).join(' '), from.username || '');
  bdb.markActive(user.id);
  const data = cq.data || '';
  await tg.answerCallbackQuery(cq.id).catch(() => {});

  try {
    if (data === 'menu') { bdb.clearState(user.id); await tg.sendMessage(chatId, 'Главное меню:', mainMenu()); return; }
    if (data === 'help') {
      const q = bdb.quota(user.id);
      await tg.sendMessage(chatId,
        'Как пользоваться:\n'
        + '1) Заведите «Мою организацию» — с банком, иначе в счёте не будет QR.\n'
        + '2) Добавьте контрагента.\n'
        + '3) Вносите операции текстом: <code>15.06 приход 94193</code>.\n'
        + '4) Жмите нужный документ — бот пришлёт файл.\n\n'
        + 'Номера документов бот ведёт сам, сквозным рядом по годам; перед выпуском '
        + 'номер и дату можно поправить.\n'
        + 'Позиции запоминаются: в следующий раз ставятся кнопкой.\n'
        + '«Мои документы» — журнал: выслать файл заново или повторить новым номером.\n\n'
        + `В этом месяце выписано: ${q.used}${q.paid ? '' : ` из ${q.limit} бесплатных`}.\n\n`
        + '/menu — вернуться в меню.', mainMenu());
      return;
    }
    if (data === 'org') { await showOrg(tg, chatId, user); return; }
    if (data === 'org.new') { await startForm(tg, chatId, user, 'org'); return; }
    if (data === 'cps') { await showCps(tg, chatId, user); return; }
    if (data === 'cp.new') { await startForm(tg, chatId, user, 'cp'); return; }
    if (data.startsWith('fb:')) {
      const state = bdb.getState(user.id);
      if (state.state.startsWith('form:')) { await applyFormValue(tg, chatId, user, state, data.slice(3)); }
      return;
    }
    if (data.startsWith('cp:')) {
      const cp = bdb.getCp(user.id, Number(data.slice(3)));
      if (!cp) { await tg.sendMessage(chatId, 'Контрагент не найден.', mainMenu()); return; }
      const { info, kb } = cpMenu(user.id, cp);
      await tg.sendMessage(chatId, info, kb);
      return;
    }
    if (data.startsWith('op:')) {
      const cpId = Number(data.slice(3));
      bdb.setState(user.id, `op:${cpId}`, {});
      await tg.sendMessage(chatId, 'Введите операцию текстом, напр.:\n<code>15.06 приход 94193</code>\n<code>02.07 оплата 50000 №79000</code>\n\nТипы: приход/поставка (нам должны больше) · оплата/принято (нам заплатили).');
      return;
    }
    if (data.startsWith('op.del:')) {
      const cpId = Number(data.slice(7));
      const ok = bdb.deleteLastOp(user.id, cpId);
      const cp = bdb.getCp(user.id, cpId);
      const { info, kb } = cpMenu(user.id, cp);
      await tg.sendMessage(chatId, (ok ? '↩️ Последняя операция удалена.\n\n' : 'Операций нет.\n\n') + info, kb);
      return;
    }
    if (data.startsWith('d.akt:')) { await genAktSverki(tg, chatId, user, Number(data.slice(6))); return; }
    if (data.startsWith('d.usl:')) { await startItems(tg, chatId, user, 'usl', Number(data.slice(6))); return; }
    if (data.startsWith('d.sch:')) { await startItems(tg, chatId, user, 'sch', Number(data.slice(6))); return; }
    if (data.startsWith('d.upd:')) { await askUpdStatus(tg, chatId, user, Number(data.slice(6))); return; }
    if (data.startsWith('upd.s2:')) { await startItems(tg, chatId, user, 'upd', Number(data.slice(7)), { status: 2 }); return; }
    if (data.startsWith('upd.s1:')) { await askUpdRate(tg, chatId, user, Number(data.slice(7))); return; }
    if (data.startsWith('upd.r:')) {
      const [cpIdStr, rate] = data.slice(6).split(':');
      await askUpdGross(tg, chatId, user, Number(cpIdStr), rate);
      return;
    }
    if (data.startsWith('upd.g:')) {
      const [cpIdStr, rate, gross] = data.slice(6).split(':');
      await startItems(tg, chatId, user, 'upd', Number(cpIdStr),
        { status: 1, vatRate: Number(rate), priceIncludesVat: gross === '1' });
      return;
    }
    if (data.startsWith('d.torg12:')) { await startItems(tg, chatId, user, 'torg12', Number(data.slice(9))); return; }
    if (data.startsWith('d.dog:')) { await startDogovor(tg, chatId, user, Number(data.slice(6))); return; }
    if (data.startsWith('d.pp:')) { await startPp(tg, chatId, user, Number(data.slice(5))); return; }
    if (data === 'items.done') {
      const state = bdb.getState(user.id);
      if (!state.state.startsWith('items:')) return;
      if (!state.data.items.length) {
        await tg.sendMessage(chatId, 'Пока ни одной позиции — добавьте хотя бы одну.', itemsKb(user, state.data));
        return;
      }
      await showPreview(tg, chatId, user, state);
      return;
    }
    if (data === 'items.more' || data === 'items.undo') {
      const state = bdb.getState(user.id);
      if (!state.state.startsWith('items:')) return;
      const d = state.data;
      let note = 'Отправьте ещё позицию:';
      if (data === 'items.undo' && d.items.length) {
        const gone = d.items.pop();
        note = `Убрал: ${esc(gone.name)}.`;
        bdb.setState(user.id, state.state, d);
      }
      await tg.sendMessage(chatId, note, itemsKb(user, d));
      return;
    }
    if (data === 'doc.make') {
      const state = bdb.getState(user.id);
      if (state.state.startsWith('items:')) await finishItems(tg, chatId, user, state);
      return;
    }
    if (data === 'doc.num' || data === 'doc.date') {
      const state = bdb.getState(user.id);
      if (!state.state.startsWith('items:')) return;
      state.data.ask = data === 'doc.num' ? 'number' : 'date';
      bdb.setState(user.id, state.state, state.data);
      await tg.sendMessage(chatId, data === 'doc.num'
        ? `Введите номер документа (сейчас ${esc(state.data.number)}):`
        : `Введите дату ДД.ММ.ГГГГ (сейчас ${ru(state.data.date)}):`);
      return;
    }
    if (data.startsWith('tpl:')) {
      const state = bdb.getState(user.id);
      if (!state.state.startsWith('items:')) return;
      const t = bdb.getTemplate(user.id, Number(data.slice(4)));
      if (!t) { await tg.sendMessage(chatId, 'Шаблон не найден.'); return; }
      state.data.ask = 'qty'; state.data.tplId = t.id;
      bdb.setState(user.id, state.state, state.data);
      await tg.sendMessage(chatId, `<b>${esc(t.name)}</b> по ${formatRub(t.price)} за ${esc(t.unit)}.\nСколько?`);
      return;
    }
    if (data.startsWith('ph.cp:')) { await photoPickKind(tg, chatId, user, Number(data.slice(6))); return; }
    if (data.startsWith('ph.k:')) { await photoSaveOp(tg, chatId, user, data.slice(5)); return; }
    if (data === 'billing') { await showBilling(tg, chatId, user); return; }
    if (data === 'pay.claim') {
      bdb.setState(user.id, 'claim', {});
      await tg.sendMessage(chatId, 'Пришлите почту, которую указывали при оплате:',
        keyboard([[{ text: '✖️ Отмена', data: 'billing' }]]));
      return;
    }
    if (data === 'support') { await showSupport(tg, chatId, user); return; }
    if (data === 'sup.write') {
      bdb.setState(user.id, 'support', {});
      await tg.sendMessage(chatId, 'Опишите, что случилось. Одним сообщением — я передам целиком.',
        keyboard([[{ text: '✖️ Отмена', data: 'menu' }]]));
      return;
    }
    if (data === 'debts') { await showDebts(tg, chatId, user); return; }
    if (data === 'debt.akts') { await sendDebtAkts(tg, chatId, user); return; }
    if (data === 'debt.remind') { await debtReminder(tg, chatId, user); return; }
    if (data === 'docs') { await showDocs(tg, chatId, user); return; }
    if (data.startsWith('docs.cp:')) { await showDocs(tg, chatId, user, Number(data.slice(8))); return; }
    if (data.startsWith('doc.get:')) { await resendDoc(tg, chatId, user, Number(data.slice(8))); return; }
    if (data.startsWith('doc.del:')) {
      bdb.deleteDoc(user.id, Number(data.slice(8)));
      await tg.sendMessage(chatId, 'Убрал из журнала. Сам файл у вас остаётся в переписке.');
      await showDocs(tg, chatId, user);
      return;
    }
    if (data.startsWith('doc:')) { await showDoc(tg, chatId, user, Number(data.slice(4))); return; }
    if (data.startsWith('d.rep:')) { await repeatDoc(tg, chatId, user, Number(data.slice(6))); return; }
  } catch (e) {
    if (e && e.blocked) throw e; // разберётся handleUpdate
    console.error('Ошибка обработки:', e.message);
    await tg.sendMessage(chatId,
      '⚠️ Что-то пошло не так на этом шаге. Попробуйте ещё раз, а если повторится — '
      + 'напишите в поддержку, я посмотрю.', mainMenu());
  }
}

// ---------- запуск (long polling) ----------

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) { console.error('Не задан BOT_TOKEN. Запуск: BOT_TOKEN=xxxxx node bot.js'); process.exit(1); }
  const tg = new Telegram(token);
  const me = await tg.call('getMe');

  if (process.argv.includes('--setup')) {
    console.log(`Оформляю @${me.username}:`);
    await applySetup(tg);
    return;
  }

  console.log(`Бот запущен: @${me.username}`);
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let updates = [];
    try { updates = await tg.getUpdates(offset, 30); } catch (e) { console.error('getUpdates:', e.message); await new Promise((r) => setTimeout(r, 3000)); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      try { await handleUpdate(tg, u); } catch (e) { console.error('handleUpdate:', e.message); }
    }
  }
}

if (require.main === module) main();

module.exports = { handleUpdate, parseOp, parseDate, parseItemLine, parseAmount };
