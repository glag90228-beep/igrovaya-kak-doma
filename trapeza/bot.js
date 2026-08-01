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
const { pdfAvailable, htmlToPdf } = require('./lib/pdf');

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
    [{ text: '❓ Помощь', data: 'help' }],
  ]);
}

const GREETING =
  '<b>Трапеза Документы</b> — бот для актов и платёжек.\n\n'
  + 'Заведите свою организацию и контрагентов, вносите операции — '
  + 'и получайте готовые документы файлом:\n'
  + '• Акт сверки\n• Акт об оказании услуг\n• Счёт на оплату\n• Платёжное поручение\n\n'
  + 'С чего начнём?';

function cpMenu(userId, cp) {
  const b = bdb.balanceOf(userId, cp.id);
  const closing = b ? round2(b.closing) : 0;
  const favour = cp.kind === 'supplier' ? 'наш долг ему' : 'в нашу пользу';
  const info = `<b>${esc(cp.name)}</b>${cp.inn ? ` · ИНН ${esc(cp.inn)}` : ''}\n`
    + `Тип: ${cp.kind === 'supplier' ? 'поставщик' : 'заказчик'} · операций: ${b ? b.ops.length : 0}\n`
    + `Текущее сальдо: <b>${formatRub(Math.abs(closing))}</b> (${favour})`;
  const kb = keyboard([
    [{ text: '➕ Внести операцию', data: `op:${cp.id}` }],
    [{ text: '📄 Акт сверки', data: `d.akt:${cp.id}` }, { text: '🧾 Акт услуг', data: `d.usl:${cp.id}` }],
    [{ text: '💰 Счёт на оплату', data: `d.sch:${cp.id}` }, { text: '🏦 Платёжка', data: `d.pp:${cp.id}` }],
    [{ text: '↩️ Удалить последнюю операцию', data: `op.del:${cp.id}` }],
    [{ text: '⬅️ К контрагентам', data: 'cps' }],
  ]);
  return { info, kb };
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
const safeName = (s) => String(s).replace(/[«»"]/g, '').replace(/[^\wА-Яа-яЁё]+/g, '_').replace(/^_|_$/g, '');

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
  await sendGenerated(tg, chatId, {
    xlsxBuffer: Buffer.from(buf), base: `Акт_сверки_${safeName(cp.name)}`,
    caption: `Акт сверки с <b>${esc(cp.name)}</b> за период ${ru(cp.opening_date)}—${ru(cp.period_end)}.`,
  });
}

// ---------- сбор позиций (для акта услуг и счёта) ----------

async function startItems(tg, chatId, user, type, cpId) {
  bdb.setState(user.id, `items:${type}:${cpId}`, { number: '1', date: todayISO(), items: [] });
  const what = type === 'usl' ? 'акта об оказании услуг' : 'счёта';
  await tg.sendMessage(chatId,
    `Составляем ${esc(what)}. Отправляйте позиции по одной в формате:\n`
    + '<code>Наименование; количество; цена</code>\n'
    + 'Например: <code>Кофе-брейк на 20 чел.; 20; 650</code>\n\nКогда закончите — нажмите «Готово».',
    keyboard([[{ text: '✅ Готово', data: 'items.done' }]]));
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

async function finishItems(tg, chatId, user, state) {
  const [, type, cpIdStr] = state.state.split(':');
  const cpId = Number(cpIdStr);
  const org = await requireOrg(tg, chatId, user); if (!org) { bdb.clearState(user.id); return; }
  const cp = bdb.getCp(user.id, cpId); if (!cp) { bdb.clearState(user.id); return; }
  const doc = { number: state.data.number, date: state.data.date, items: state.data.items };
  bdb.clearState(user.id);
  if (!doc.items.length) { await tg.sendMessage(chatId, 'Позиций нет — отменил.', mainMenu()); return; }

  if (type === 'usl') {
    const html = buildAktUslugHtml({ org, cp, doc });
    await sendGenerated(tg, chatId, { html, base: `Акт_услуг_${safeName(cp.name)}`, caption: `Акт об оказании услуг для <b>${esc(cp.name)}</b>.` });
  } else {
    const html = buildSchetHtml({ org, cp, doc });
    await sendGenerated(tg, chatId, { html, base: `Счет_${safeName(cp.name)}`, caption: `Счёт на оплату для <b>${esc(cp.name)}</b>.` });
  }
  const { info, kb } = cpMenu(user.id, cp);
  await tg.sendMessage(chatId, info, kb);
}

// ---------- платёжка (сумма + назначение) ----------

async function startPp(tg, chatId, user, cpId) {
  const org = await requireOrg(tg, chatId, user); if (!org) return;
  bdb.setState(user.id, `pp:${cpId}`, { step: 'amount', number: '1', date: todayISO() });
  await tg.sendMessage(chatId, 'Платёжное поручение. Введите <b>сумму</b>, руб.:');
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
  await sendGenerated(tg, chatId, { html, base: `Платежка_${safeName(cp.name)}`, caption: `Платёжное поручение получателю <b>${esc(cp.name)}</b> на ${formatRub(doc.amount)}.` });
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
  if (update.callback_query) return handleCallback(tg, update.callback_query);
  if (update.message && update.message.text) return handleMessage(tg, update.message);
}

async function handleMessage(tg, msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const user = bdb.getOrCreateUser(from.id, [from.first_name, from.last_name].filter(Boolean).join(' '), from.username || '');
  const text = msg.text.trim();

  if (text === '/start') { bdb.clearState(user.id); await tg.sendMessage(chatId, GREETING, mainMenu()); return; }
  if (text === '/menu' || text === '/cancel') { bdb.clearState(user.id); await tg.sendMessage(chatId, 'Главное меню:', mainMenu()); return; }

  const state = bdb.getState(user.id);
  if (state.state.startsWith('form:')) { await applyFormValue(tg, chatId, user, state, text); return; }
  if (state.state.startsWith('items:')) {
    const item = parseItemLine(text);
    if (!item) { await tg.sendMessage(chatId, 'Не разобрал. Формат: <code>Наименование; кол-во; цена</code>'); return; }
    state.data.items.push(item);
    bdb.setState(user.id, state.state, state.data);
    await tg.sendMessage(chatId, `Добавлено: ${esc(item.name)} — ${item.qty}×${item.price}. Ещё позицию или «Готово».`,
      keyboard([[{ text: '✅ Готово', data: 'items.done' }]]));
    return;
  }
  if (state.state.startsWith('pp:')) { await handlePpText(tg, chatId, user, state, text); return; }
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
  const data = cq.data || '';
  await tg.answerCallbackQuery(cq.id);

  try {
    if (data === 'menu') { bdb.clearState(user.id); await tg.sendMessage(chatId, 'Главное меню:', mainMenu()); return; }
    if (data === 'help') {
      await tg.sendMessage(chatId,
        'Как пользоваться:\n1) Заведите «Мою организацию».\n2) Добавьте контрагента.\n3) Вносите операции текстом: <code>15.06 приход 94193</code>.\n4) Жмите нужный документ — бот пришлёт файл.\n\n/menu — вернуться в меню.', mainMenu());
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
    if (data.startsWith('d.pp:')) { await startPp(tg, chatId, user, Number(data.slice(5))); return; }
    if (data === 'items.done') {
      const state = bdb.getState(user.id);
      if (state.state.startsWith('items:')) await finishItems(tg, chatId, user, state);
      return;
    }
  } catch (e) {
    await tg.sendMessage(chatId, `⚠️ Ошибка: ${esc(e.message)}`, mainMenu());
  }
}

// ---------- запуск (long polling) ----------

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) { console.error('Не задан BOT_TOKEN. Запуск: BOT_TOKEN=xxxxx node bot.js'); process.exit(1); }
  const tg = new Telegram(token);
  const me = await tg.call('getMe');
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
