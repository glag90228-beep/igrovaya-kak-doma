'use strict';

// Telegram-бот «Первичка»: многопользовательский генератор
// актов сверки, актов услуг, счетов и платёжных поручений.
// Запуск: BOT_TOKEN=xxxxx node bot.js
// Логика роутинга экспортируется (handleUpdate) — тестируется без живого бота.

const { Telegram, keyboard } = require('./lib/tg');
const bdb = require('./lib/bot-db');
const { formatRub, amountInWords, round2, vatTotals } = require('./lib/money');
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
const dadata = require('./lib/dadata');
const { parseRequisites, looksLikeBlock } = require('./lib/reqs');
const docService = require('./lib/doc-service');
const facsimile = require('./lib/facsimile');
const mailer = require('./lib/mail');

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

/**
 * Адрес мини-приложения. Telegram открывает их только по https, поэтому
 * http-адрес молча игнорируем: лучше остаться без кнопки, чем показать
 * кнопку, которая у всех выдаёт ошибку.
 */
function webAppUrl() {
  const url = String(process.env.WEBAPP_URL || '').trim();
  return /^https:\/\/.+/i.test(url) ? url : '';
}

function mainMenu() {
  const app = webAppUrl();
  return keyboard([
    ...(app ? [[{ text: '📱 Открыть приложение', webApp: app }]] : []),
    [{ text: '🏢 Моя организация', data: 'org' }],
    [{ text: '👥 Контрагенты', data: 'cps' }],
    [{ text: '💸 Кто должен', data: 'debts' }],
    [{ text: '📁 Мои документы', data: 'docs' }],
    [{ text: '⭐ Подписка', data: 'billing' }],
    [{ text: '❓ Помощь', data: 'help' }, { text: '💬 Поддержка', data: 'support' }],
  ]);
}

const GREETING =
  '<b>Первичка</b> — счета, акты и платёжки за минуту.\n\n'
  + 'Реквизиты вводятся один раз, дальше документ собирается в пару нажатий:\n'
  + '• Счёт на оплату с QR — клиент платит, наведя камеру банка\n'
  + '• Акт об оказании услуг, УПД, накладная ТОРГ-12, договор\n'
  + '• Акт сверки в Excel и подсказка, кто сколько должен\n\n'
  + 'Первые 5 документов в месяц — бесплатно.\n\n'
  + 'С чего начнём?';

/**
 * Приветствие: правовая строка появляется, когда заданы адреса страниц,
 * а строка про приложение — когда оно поднято.
 */
function greeting() {
  const legal = legalLine();
  const app = webAppUrl()
    ? '\n\n<i>То же самое удобнее в приложении — кнопка ниже.</i>'
    : '';
  return GREETING + app + (legal ? `\n\n<i>${legal}</i>` : '');
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

// Шаги помечены: auto — по значению дозаполняет соседние поля из реестра;
// skipIfFilled — пропускается, если значение уже подставлено автозаполнением.
// Поэтому ИНН и БИК стоят первыми: с них подтягивается всё остальное.

const ORG_STEPS = [
  {
    key: 'inn', auto: 'party', opt: true,
    q: '<b>Проще всего — вставьте реквизиты одним текстом</b> (скопируйте из письма или 1С), '
      + 'я разберу их на поля.\n\nМожно и по ИНН — подставлю название и адрес из реестра.\n'
      + '<i>Или «-», чтобы заполнять вручную по одному полю.</i>',
  },
  { key: 'name', skipIfFilled: true, q: 'Краткое название (напр. «ИП Иванов И. И.» или «ООО Ромашка»):' },
  { key: 'full_name', skipIfFilled: true, opt: true, q: 'Полное наименование для документов (или «-»):' },
  { key: 'kpp', skipIfFilled: true, opt: true, q: 'КПП (для ООО; ИП отправьте «-»):' },
  { key: 'address', skipIfFilled: true, opt: true, q: 'Адрес (или «-»):' },
  { key: 'signer', skipIfFilled: true, opt: true, q: 'ФИО подписанта (напр. «И. И. Иванов»; или «-»):' },
  {
    key: 'bik', auto: 'bank', skipIfFilled: true, opt: true,
    q: 'БИК банка — подставлю название банка и корр. счёт (или «-»):',
  },
  { key: 'bank_name', skipIfFilled: true, opt: true, q: 'Банк — наименование (или «-»):' },
  { key: 'corr_acc', skipIfFilled: true, opt: true, q: 'Корр. счёт к/с (или «-»):' },
  { key: 'acc', skipIfFilled: true, opt: true, q: 'Расчётный счёт р/с — нужен для QR в счёте (или «-»):' },
];

const CP_STEPS = [
  {
    key: 'inn', auto: 'party', opt: true,
    q: '<b>Вставьте реквизиты контрагента одним текстом</b> — разберу на поля.\n\n'
      + 'Или ИНН — подставлю название и адрес.\n<i>Или «-», чтобы ввести вручную.</i>',
  },
  { key: 'name', skipIfFilled: true, q: 'Краткое имя контрагента (напр. «ООО Заря»):' },
  { key: 'full_name', skipIfFilled: true, opt: true, q: 'Полное наименование (или «-»):' },
  { key: 'kpp', skipIfFilled: true, opt: true, q: 'КПП (или «-»):' },
  { key: 'address', skipIfFilled: true, opt: true, q: 'Адрес контрагента (или «-»):' },
  {
    key: 'kind', q: 'Тип контрагента:',
    buttons: [{ text: 'Заказчик (платит нам)', val: 'customer' }, { text: 'Поставщик (платим ему)', val: 'supplier' }],
  },
  { key: 'contract', opt: true, q: 'Договор (напр. «Договор № 5 от 01.02.2026»; или «-»):' },
  { key: 'opening_balance', num: true, q: 'Начальное сальдо, руб. (0 — если с нуля):' },
  { key: 'opening_date', date: true, q: 'Дата начального сальдо (ДД.ММ.ГГГГ):' },
  { key: 'bik', auto: 'bank', skipIfFilled: true, opt: true, q: 'БИК банка контрагента — подставлю банк и корр. счёт (или «-»):' },
  { key: 'bank_name', skipIfFilled: true, opt: true, q: 'Банк контрагента (или «-»):' },
  { key: 'corr_acc', skipIfFilled: true, opt: true, q: 'Корр. счёт контрагента (или «-»):' },
  { key: 'acc', skipIfFilled: true, opt: true, q: 'Расчётный счёт контрагента (или «-»):' },
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
  await tg.sendMessage(chatId, step.q, opts);
}

/** Следующий незаполненный шаг: пропускаем то, что подставил справочник. */
async function advanceForm(tg, chatId, user, formName, values, from) {
  const form = FORMS[formName];
  let next = from;
  while (next < form.steps.length) {
    const s = form.steps[next];
    // Пропускаем заполненное; после вставки блока — и пустые поля-реквизиты,
    // кроме расчётного счёта: без него не будет QR, поэтому его переспросим.
    const skip = s.skipIfFilled
      && (values[s.key] || (values.__pasted && s.opt && s.key !== 'acc'));
    if (skip) { next += 1; continue; }
    break;
  }
  if (next < form.steps.length) {
    bdb.setState(user.id, `form:${formName}`, { i: next, values });
    await askStep(tg, chatId, formName, next);
  } else {
    bdb.clearState(user.id);
    await finishForm(tg, chatId, user, formName, values);
  }
}

const fill = (values, src, keys) => {
  let n = 0;
  for (const k of keys) if (src[k] && !values[k]) { values[k] = src[k]; n += 1; }
  return n;
};

/**
 * Автозаполнение шага. Три источника, по убыванию удобства:
 *  1) вставленный блок реквизитов — разбираем на поля сами;
 *  2) ИНН — тянем из реестра (DaData);
 *  3) БИК — банк и корр. счёт из реестра.
 * Возвращает { value, note, warn }: value — что записать в само поле шага.
 */
async function runAuto(kind, rawValue, values) {
  const raw = String(rawValue);

  // Вставили целый блок реквизитов (в шаг ИНН или БИК — не важно).
  if (looksLikeBlock(raw)) {
    const p = parseRequisites(raw);
    fill(values, p, ['name', 'full_name', 'inn', 'kpp', 'address', 'bank_name', 'bik', 'acc', 'corr_acc']);
    values.__pasted = true; // дальше пустые поля-реквизиты не переспрашиваем
    // Чего в тексте не было — дозапросим из реестра: по ИНН адрес и директора,
    // по БИК — точное название банка и корр. счёт.
    if (p.inn && dadata.dadataAvailable() && (!values.address || !values.signer)) {
      const r = await dadata.partyByInn(p.inn).catch(() => ({ ok: false }));
      if (r.ok) fill(values, r.fields, ['name', 'full_name', 'kpp', 'address', 'signer']);
    }
    if (values.bik && dadata.dadataAvailable()) {
      const rb = await dadata.bankByBik(values.bik).catch(() => ({ ok: false }));
      if (rb.ok) { values.bank_name = rb.fields.bank_name || values.bank_name; values.corr_acc = values.corr_acc || rb.fields.corr_acc; }
    }
    const got = [
      values.name && `<b>${esc(values.name)}</b>`,
      values.acc && `р/с …${esc(String(values.acc).slice(-4))}`,
      values.bik && `БИК ${esc(values.bik)}`,
    ].filter(Boolean).join(', ');
    return {
      value: kind === 'bank' ? (p.bik || '') : (p.inn || ''),
      note: `Разобрал реквизиты: ${got || 'поля заполнены'}.`,
      warn: (!values.acc && kind === 'party') ? 'Расчётный счёт в тексте не нашёл — впишите его, без него не будет QR.' : '',
    };
  }

  if (kind === 'party') {
    // Молчать нельзя: человек вводит ИНН, ничего не подставляется, и он
    // решает, что бот сломался. Говорим, что справочник просто не подключён.
    if (!dadata.dadataAvailable()) {
      return { note: '', warn: 'Справочник не подключён — заполним поля вручную.' };
    }
    const r = await dadata.partyByInn(raw);
    if (!r.ok) return { note: '', warn: r.error };
    fill(values, r.fields, ['name', 'full_name', 'kpp', 'address', 'signer']);
    return { note: `Нашёл: <b>${esc(r.fields.name)}</b>${r.fields.address ? `, ${esc(r.fields.address)}` : ''}.`, warn: r.warn };
  }

  if (kind === 'bank') {
    if (!dadata.dadataAvailable()) {
      return { note: '', warn: 'Справочник не подключён — название банка и к/с впишите сами.' };
    }
    const r = await dadata.bankByBik(raw);
    if (!r.ok) return { note: '', warn: r.error };
    fill(values, r.fields, ['bank_name', 'corr_acc']);
    return { note: `Банк: <b>${esc(r.fields.bank_name)}</b>.`, warn: '' };
  }
  return { note: '', warn: '' };
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

  // Автозаполнение: вставленный блок реквизитов разбираем всегда,
  // поиск по ИНН/БИК — если подключён справочник.
  if (step.auto && value) {
    await tg.sendChatAction(chatId, 'typing');
    let res = { value: null, note: '', warn: '' };
    try { res = await runAuto(step.auto, rawValue, values); } catch (e) { res = { value: null, note: '', warn: e.message }; }
    if (res.value != null && res.value !== '') values[step.key] = res.value; // в поле кладём разобранный ИНН/БИК
    if (res.note) await tg.sendMessage(chatId, `✅ ${res.note}`);
    if (res.warn) await tg.sendMessage(chatId, `⚠️ ${esc(res.warn)}`);
  }

  await advanceForm(tg, chatId, user, formName, values, i + 1);
}

async function finishForm(tg, chatId, user, formName, values) {
  if (formName === 'org') {
    if (!values.full_name) values.full_name = values.name;
    bdb.saveMyOrg(user.id, values); // заменяем организацию, а не плодим новые
    const hasBank = values.acc && values.bik && values.corr_acc;
    await tg.sendMessage(chatId,
      `✅ Организация <b>${esc(values.name)}</b> сохранена.`
      + (hasBank ? '\nВ счёте будет платёжный QR.' : '\n<i>Расчётный счёт/БИК не заполнены — QR в счёте не появится.</i>'),
      mainMenu());
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
  const file = await docService.renderFile(html, base);
  await tg.sendDocument(chatId, {
    filename: file.filename,
    buffer: file.buffer,
    caption: file.pdf
      ? caption
      : `${caption}\n\n(PDF недоступен — откройте файл в браузере и распечатайте / сохраните в PDF.)`,
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

/**
 * Проверка лимита перед выпуском нового документа. Если бесплатные
 * закончились и подписки нет — показываем экран подписки и не пускаем дальше.
 * Пересылку уже выписанного файла и просмотр журнала это не трогает.
 */
async function requireQuota(tg, chatId, user) {
  const q = bdb.quota(user.id);
  if (q.allowed) return true;
  await tg.sendMessage(chatId,
    `В этом месяце вы использовали все <b>${q.limit} бесплатных</b> документа.\n\n`
    + 'Оформите подписку — лимит снимется, всё остальное работает как прежде. '
    + 'Ранее выписанные документы по-прежнему можно переслать из «Мои документы».',
    keyboard([[{ text: '⭐ Оформить подписку', data: 'billing' }], [{ text: '⬅️ Меню', data: 'menu' }]]));
  return false;
}

async function genAktSverki(tg, chatId, user, cpId) {
  if (!(await requireQuota(tg, chatId, user))) return;
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
// Список общий с мини-приложением — лежит в lib/doc-service.js, чтобы форма
// документа правилась в одном месте, а не в двух расходящихся копиях.
const { ITEM_DOCS } = docService;

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
  if (!(await requireQuota(tg, chatId, user))) return;
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
  const extra = d.doc || {};
  // Итог считаем тем же кодом, что и сам документ: иначе сводка покажет
  // одно, а в PDF попадёт другое — на НДС «сверху» разница заметная.
  const sums = vatTotals(d.items, extra.vatRate == null ? null : Number(extra.vatRate),
    Boolean(extra.priceIncludesVat));
  const total = sums.total;
  const lines = d.items.map((it, i) =>
    `${i + 1}. ${esc(it.name)} — ${it.qty} × ${formatRub(it.price)} = <b>${formatRub(round2(it.qty * it.price))}</b>`);
  const head = extra.status
    ? ` · статус ${extra.status}${extra.status === 1
      ? `, НДС ${extra.vatRate == null ? 'не облагается' : `${extra.vatRate}%`}`
      + `${extra.vatRate == null ? '' : (extra.priceIncludesVat ? ', цены с НДС' : ', НДС сверху')}` : ''}`
    : '';
  await tg.sendMessage(chatId,
    `<b>${esc(ITEM_DOCS[type].title)} № ${esc(d.number)}</b> от ${ru(d.date)}${head}\n\n`
    + (lines.join('\n') || '— пусто —')
    + (sums.vat == null
      ? `\n\nИтого: <b>${formatRub(total)}</b> (без НДС)`
      : `\n\nБез налога: ${formatRub(sums.net)}`
        + `\nНДС ${extra.vatRate}%: ${formatRub(sums.vat)}`
        + `\n<b>Всего к оплате: ${formatRub(total)}</b>`),
    keyboard([
      [{ text: '📄 Сформировать документ', data: 'doc.make' }],
      [{ text: '✏️ Номер', data: 'doc.num' }, { text: '📅 Дата', data: 'doc.date' }],
      ...(type === 'sch' ? [[{ text: `🧾 НДС: ${sums.vat == null ? 'нет' : `${extra.vatRate}%`}`, data: 'doc.vat' }]] : []),
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
async function issueDoc(tg, chatId, user, { type, cpId, doc, extra = {} }) {
  // Сборка, факсимиле, нумерация и запись в журнал — в общем сервисе:
  // мини-приложение делает ровно то же самое, и расходиться им нельзя.
  await tg.sendChatAction(chatId, 'upload_document');
  const res = await docService.issueDocument(user.id, {
    type, cpId, items: doc.items, date: doc.date, number: doc.number, extra,
  });
  if (!res.ok) {
    const kb = res.reason === 'quota'
      ? keyboard([[{ text: '⭐ Оформить подписку', data: 'billing' }], [{ text: '⬅️ Меню', data: 'menu' }]])
      : mainMenu();
    await tg.sendMessage(chatId, esc(res.message), kb);
    return false;
  }

  const cp = bdb.getCp(user.id, cpId);
  const q = res.quota;
  const tail = q.paid ? '' : `\n<i>Выписано в этом месяце: ${q.used} из ${q.limit} бесплатных.</i>`;
  await tg.sendDocument(chatId, {
    filename: res.file.filename,
    buffer: res.file.buffer,
    caption: `${esc(res.title)} № ${esc(res.doc.number)}`
      + ` от ${ru(res.doc.date)} для <b>${esc(cp.name)}</b> на ${formatRub(res.total)}.`
      + (type === 'sch' ? '\nВ счёте есть QR — клиент платит, наведя камеру банка.' : '')
      + (res.file.pdf ? '' : '\n\n(PDF недоступен — откройте файл в браузере и распечатайте / сохраните в PDF.)')
      + tail,
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
  if (!(await requireQuota(tg, chatId, user))) return;
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
  if (mailer.mailAvailable() && d.type !== 'akt') {
    rows.push([{
      text: cp && cp.email ? `✉️ Отправить на ${cp.email}`.slice(0, 60) : '✉️ Отправить на почту',
      data: `doc.mail:${d.id}`,
    }]);
  }
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
  if (!(await requireQuota(tg, chatId, user))) return;
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
// ---------- отправка документа на почту ----------

/**
 * Текст письма. Нарочно короткий и деловой: длинные автоприветствия
 * в деловой переписке читаются как спам, а получателю нужно понять за
 * две секунды, что пришло и что с этим делать.
 */
function letterFor(doc, org, cp) {
  const kind = (doc.title || 'Документ').toLowerCase();
  const money = doc.total ? ` на сумму ${formatRub(doc.total)}` : '';
  const lines = [
    `Здравствуйте${cp.signer ? `, ${cp.signer}` : ''}!`,
    '',
    `Во вложении ${kind} № ${doc.number} от ${ru(doc.date)}${money}.`,
  ];
  if (doc.type === 'sch') {
    lines.push('', 'В счёте есть QR-код: оплатить можно, наведя камеру в приложении банка.');
  }
  lines.push('', 'С уважением,', org.name || org.full_name || '');
  return lines.join('\n');
}

/**
 * Отправляет ранее выписанный документ на почту контрагента.
 * Если почта не сохранена — спрашиваем её и запоминаем на будущее.
 */
async function mailDoc(tg, chatId, user, docId, emailOverride = null) {
  if (!mailer.mailAvailable()) {
    await tg.sendMessage(chatId,
      `Отправка почты не настроена.\n<i>${esc(mailer.mailHint())}</i>`, mainMenu());
    return;
  }
  const d = bdb.getDoc(user.id, docId);
  if (!d) { await tg.sendMessage(chatId, 'Документ не найден.', mainMenu()); return; }
  const cp = bdb.getCp(user.id, d.cp_id);
  if (!cp) { await tg.sendMessage(chatId, 'Контрагент не найден.', mainMenu()); return; }

  const to = String(emailOverride || cp.email || '').trim();
  if (!to) {
    bdb.setState(user.id, `mail:${docId}`);
    await tg.sendMessage(chatId,
      `На какую почту отправить <b>${esc(d.title)} № ${esc(d.number)}</b>?\n`
      + 'Напишите адрес — я запомню его для этого контрагента.',
      keyboard([[{ text: '✖️ Отмена', data: `doc:${docId}` }]]));
    return;
  }
  if (!mailer.validEmail(to)) {
    await tg.sendMessage(chatId, `«${esc(to)}» не похоже на адрес. Напишите ещё раз.`);
    return;
  }

  await tg.sendChatAction(chatId, 'typing');
  const built = await docService.rebuildDocument(user.id, docId);
  if (!built.ok) { await tg.sendMessage(chatId, esc(built.message), mainMenu()); return; }

  const org = bdb.getOrg(user.id, d.org_id) || bdb.getDefaultOrg(user.id) || {};
  const res = await mailer.sendMail({
    to,
    subject: `${d.title} № ${d.number} от ${ru(d.date)}`,
    text: letterFor(d, org, cp),
    attachments: [{
      filename: built.file.filename,
      content: built.file.buffer,
      contentType: built.file.mime,
    }],
  });

  bdb.clearState(user.id);
  if (!res.ok) {
    await tg.sendMessage(chatId,
      `Не отправилось: ${esc(res.error)}\n\nПопробуйте ещё раз или пришлите файл вручную.`,
      keyboard([[{ text: '↩️ К документу', data: `doc:${docId}` }], [{ text: '⬅️ Меню', data: 'menu' }]]));
    return;
  }

  if (to !== cp.email) bdb.updateCp(user.id, cp.id, { email: to });
  await tg.sendMessage(chatId,
    `✉️ Отправил <b>${esc(d.title)} № ${esc(d.number)}</b> на <b>${esc(to)}</b>.`
    + (to !== cp.email ? '\nАдрес запомнил — в следующий раз спрашивать не буду.' : ''),
    keyboard([[{ text: '↩️ К документу', data: `doc:${docId}` }], [{ text: '⬅️ Меню', data: 'menu' }]]));
}

// ---------- подпись и печать (факсимиле) ----------

const FX_NAMES = { sign: 'подпись', stamp: 'печать' };

/** Человеческое название режима НДС организации. */
function vatLabel(org) {
  const v = bdb.vatOf(org);
  if (v.rate == null) return 'без НДС';
  return `${v.rate}%${v.rate === 0 ? '' : (v.gross ? ', цены с НДС' : ', НДС сверху')}`;
}

/**
 * Экран выбора системы налогообложения. Спрашиваем один раз у организации,
 * а не у каждого счёта: бухгалтер выписывает их десятками, а режим меняется
 * раз в год. У конкретного документа его всё равно можно переопределить.
 */
async function showVat(tg, chatId, user) {
  const org = bdb.getDefaultOrg(user.id);
  if (!org) { await tg.sendMessage(chatId, 'Сначала заведите организацию.', mainMenu()); return; }
  await tg.sendMessage(chatId,
    `<b>НДС в счетах</b>\n\nСейчас: <b>${esc(vatLabel(org))}</b>\n\n`
    + 'На упрощёнке — «без НДС». Плательщикам НДС важно выбрать, как указаны '
    + 'ваши цены: «с НДС» значит налог уже внутри цены, «сверху» — что он '
    + 'прибавится к сумме счёта.',
    keyboard([
      [{ text: 'Без НДС (упрощёнка)', data: 'vat.set:none:0' }],
      [{ text: '20%, цены с НДС', data: 'vat.set:20:1' },
        { text: '20% сверху', data: 'vat.set:20:0' }],
      [{ text: '10%, цены с НДС', data: 'vat.set:10:1' },
        { text: '10% сверху', data: 'vat.set:10:0' }],
      [{ text: '0% (экспорт)', data: 'vat.set:0:0' }],
      [{ text: '⬅️ К организации', data: 'org' }],
    ]));
}

/** Экран «Подпись и печать»: что загружено, куда ставится, как поменять. */
async function showFacsimile(tg, chatId, user) {
  const sign = facsimile.get(user.id, 'sign');
  const stamp = facsimile.get(user.id, 'stamp');
  const scope = facsimile.scopeOf(user.id);
  const kb = (v) => Math.round(v / 1024);

  const txt = '<b>Подпись и печать</b>\n\n'
    + 'Загрузите снимок подписи и печати — они лягут на счета и акты, '
    + 'и документ можно будет сразу отправлять клиенту.\n\n'
    + `Подпись: ${sign ? `<b>загружена</b> (${kb(sign.bytes.length)} КБ)` : '—'}\n`
    + `Печать: ${stamp ? `<b>загружена</b> (${kb(stamp.bytes.length)} КБ)` : '—'}\n`
    + `Ставим: <b>${esc(facsimile.SCOPES[scope])}</b>\n\n`
    + '<i>Как снять: распишитесь на белом листе чёрной ручкой и сфотографируйте '
    + 'сверху при дневном свете. Фон убирать не нужно — бот сам сделает белое '
    + 'прозрачным. Факсимиле не ставится на платёжное поручение и договор: '
    + 'там нужна живая подпись.</i>';

  const rows = [
    [{ text: sign ? '🖊 Заменить подпись' : '🖊 Загрузить подпись', data: 'fx.add:sign' }],
    [{ text: stamp ? '⭕ Заменить печать' : '⭕ Загрузить печать', data: 'fx.add:stamp' }],
  ];
  if (sign) rows.push([{ text: '🗑 Убрать подпись', data: 'fx.del:sign' }]);
  if (stamp) rows.push([{ text: '🗑 Убрать печать', data: 'fx.del:stamp' }]);
  for (const [key, label] of Object.entries(facsimile.SCOPES)) {
    if (key !== scope) rows.push([{ text: `Ставить ${label}`, data: `fx.scope:${key}` }]);
  }
  rows.push([{ text: '⬅️ К организации', data: 'org' }]);
  await tg.sendMessage(chatId, txt, keyboard(rows));
}

/** Принимает присланный снимок подписи или печати. */
async function acceptFacsimile(tg, chatId, user, msg, kind) {
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
  try {
    buf = await tg.downloadFile(fileId, facsimile.MAX_BYTES);
  } catch (e) {
    await tg.sendMessage(chatId, `Не смог забрать файл: ${esc(e.message)}`);
    return;
  }

  const res = facsimile.save(user.id, kind, buf, mime);
  if (!res.ok) {
    await tg.sendMessage(chatId, `${esc(res.error)}\nПришлите другой файл.`);
    return;
  }
  bdb.clearState(user.id);
  await tg.sendMessage(chatId,
    `Сохранил ${FX_NAMES[kind]}. Проверьте на документе: выпишите счёт — `
    + 'если легло криво или бледно, пришлите снимок получше.');
  await showFacsimile(tg, chatId, user);
}

async function handlePhoto(tg, chatId, user, msg) {
  // Ждём снимок подписи или печати — тогда это не счёт для распознавания.
  const st = bdb.getState(user.id);
  if (st && /^fx:(sign|stamp)$/.test(st.state)) {
    return acceptFacsimile(tg, chatId, user, msg, st.state.split(':')[1]);
  }

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
  if (!(await requireQuota(tg, chatId, user))) return;
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
  if (!(await requireQuota(tg, chatId, user))) return;
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
  const fxSign = facsimile.get(user.id, 'sign');
  const fxStamp = facsimile.get(user.id, 'stamp');
  const fxLabel = fxSign || fxStamp
    ? `🖊 Подпись и печать · ${[fxSign && 'подпись', fxStamp && 'печать'].filter(Boolean).join(' и ')}`
    : '🖊 Подпись и печать';
  await tg.sendMessage(chatId, txt, keyboard([
    [{ text: '✏️ Изменить (ввести заново)', data: 'org.new' }],
    [{ text: fxLabel, data: 'fx' }],
    [{ text: `🧾 НДС: ${vatLabel(org)}`.slice(0, 60), data: 'vat' }],
    [{ text: '⬅️ Меню', data: 'menu' }],
  ]));
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
  if (state.state.startsWith('mail:')) {
    await mailDoc(tg, chatId, user, Number(state.state.split(':')[1]), text.trim());
    return;
  }
  if (state.state.startsWith('fx:')) {
    await tg.sendMessage(chatId,
      `Жду картинку: <b>${FX_NAMES[state.state.split(':')[1]] || 'изображение'}</b>. `
      + 'Пришлите фото или файл — или отмените.',
      keyboard([[{ text: '✖️ Отмена', data: 'fx' }]]));
    return;
  }
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
        + '   Введите ИНН — название, адрес и реквизиты подставятся сами; по БИК — банк.\n'
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
    if (data === 'doc.vat') {
      await tg.sendMessage(chatId, 'НДС для этого счёта:', keyboard([
        [{ text: 'Без НДС', data: 'doc.vat.set:none:0' }],
        [{ text: '20%, цены с НДС', data: 'doc.vat.set:20:1' },
          { text: '20% сверху', data: 'doc.vat.set:20:0' }],
        [{ text: '10%, цены с НДС', data: 'doc.vat.set:10:1' },
          { text: '10% сверху', data: 'doc.vat.set:10:0' }],
      ]));
      return;
    }
    if (data.startsWith('doc.vat.set:')) {
      const st2 = bdb.getState(user.id);
      if (!st2 || !st2.state.startsWith('items:')) return;
      const [rate, gross] = data.slice(12).split(':');
      const dd = st2.data;
      dd.doc = dd.doc || {};
      if (rate === 'none') { delete dd.doc.vatRate; delete dd.doc.priceIncludesVat; } else {
        dd.doc.vatRate = Number(rate);
        dd.doc.priceIncludesVat = gross === '1';
      }
      bdb.setState(user.id, st2.state, dd);
      await showPreview(tg, chatId, user, bdb.getState(user.id));
      return;
    }
    if (data === 'vat') { await showVat(tg, chatId, user); return; }
    if (data.startsWith('vat.set:')) {
      const [rate, gross] = data.slice(8).split(':');
      const org = bdb.getDefaultOrg(user.id);
      if (org) {
        bdb.updateOrg(user.id, org.id, {
          vat_rate: rate === 'none' ? '' : rate,
          vat_gross: gross === '1' ? 1 : 0,
        });
      }
      await showVat(tg, chatId, user);
      return;
    }
    if (data === 'fx') { await showFacsimile(tg, chatId, user); return; }
    if (data.startsWith('fx.add:')) {
      const kind = data.split(':')[1];
      bdb.setState(user.id, `fx:${kind}`);
      await tg.sendMessage(chatId,
        `Пришлите снимок: <b>${FX_NAMES[kind]}</b>.\n\n`
        + 'Фотографией или файлом — PNG, JPEG или WebP, до 1 МБ. '
        + 'Лучше всего: белый лист, дневной свет, снимок строго сверху.',
        keyboard([[{ text: '✖️ Отмена', data: 'fx' }]]));
      return;
    }
    if (data.startsWith('fx.del:')) {
      const kind = data.split(':')[1];
      facsimile.remove(user.id, kind);
      await tg.sendMessage(chatId, `Убрал ${FX_NAMES[kind]}.`);
      await showFacsimile(tg, chatId, user);
      return;
    }
    if (data.startsWith('fx.scope:')) {
      facsimile.setScope(user.id, data.split(':')[1]);
      await showFacsimile(tg, chatId, user);
      return;
    }
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
    if (data.startsWith('d.sch:')) {
      // Ставку не спрашиваем — берём режим организации; у документа его
      // можно поменять кнопкой в сводке перед выпуском.
      const org = bdb.getDefaultOrg(user.id);
      const v = org ? bdb.vatOf(org) : { rate: null, gross: false };
      await startItems(tg, chatId, user, 'sch', Number(data.slice(6)),
        v.rate == null ? {} : { vatRate: v.rate, priceIncludesVat: v.gross });
      return;
    }
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
    if (data.startsWith('doc.mail:')) { await mailDoc(tg, chatId, user, Number(data.slice(9))); return; }
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
  // Диагностика справочника — до обращения к Telegram: она про DaData,
  // и не должна падать из-за токена бота.
  if (process.argv.includes('--dadata')) {
    const value = process.argv[process.argv.indexOf('--dadata') + 1] || '';
    console.log(`Ключ DaData: ${process.env.DADATA_TOKEN
      ? `задан, ${process.env.DADATA_TOKEN.length} символов, начинается на ${process.env.DADATA_TOKEN.slice(0, 6)}…`
      : 'НЕ ЗАДАН — автозаполнение выключено, поля придётся вводить руками'}`);
    if (!value) {
      console.log('\nЧто проверить:  node bot.js --dadata 044525974   (БИК)');
      console.log('                node bot.js --dadata 7707083893  (ИНН)');
      return;
    }
    const digits = value.replace(/\D/g, '');
    const isBik = digits.length === 9;
    console.log(`Проверяю ${isBik ? 'БИК' : 'ИНН'} ${digits}…`);
    const r = isBik ? await dadata.bankByBik(digits) : await dadata.partyByInn(digits);
    if (r.ok) {
      console.log('✅ Справочник ответил:');
      for (const [k, v] of Object.entries(r.fields)) if (v) console.log(`   ${k}: ${v}`);
    } else {
      console.log(`❌ Не получилось: ${r.error}`);
      console.log('\nЧастые причины:');
      console.log('  • DADATA_TOKEN пуст или это «секретный ключ» вместо «API-ключа»');
      console.log('  • в кабинете dadata.ru стоит ограничение по IP — добавьте адрес сервера');
      console.log('  • закончился дневной лимит бесплатного тарифа');
      console.log('  • сервер не выпускает наружу https — проверьте: curl -sI https://dadata.ru');
    }
    return;
  }

  const tg = new Telegram(token);
  const me = await tg.call('getMe');

  if (process.argv.includes('--check')) {
    console.log(`Токен рабочий: @${me.username} (${me.first_name}), id ${me.id}`);
    const hook = await tg.call('getWebhookInfo').catch(() => null);
    if (hook && hook.url) {
      console.log(`⚠️  У бота настроен вебхук ${hook.url} — long polling работать не будет.`);
      console.log('   Снять: node bot.js --drop-webhook');
    } else {
      console.log('Вебхук не задан — long polling свободен.');
    }
    const cmds = await tg.call('getMyCommands').catch(() => []);
    console.log(`Команд в меню: ${cmds.length}`);
    return;
  }

  if (process.argv.includes('--drop-webhook')) {
    await tg.call('deleteWebhook', { drop_pending_updates: false });
    console.log('Вебхук снят, long polling свободен.');
    return;
  }

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
