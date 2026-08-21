'use strict';

// Telegram-бот «Первичка»: многопользовательский генератор
// актов сверки, актов услуг, счетов и платёжных поручений.
// Запуск: BOT_TOKEN=xxxxx node bot.js
// Логика роутинга экспортируется (handleUpdate) — тестируется без живого бота.

const { Telegram, keyboard } = require('./lib/tg');
const bdb = require('./lib/bot-db');
const { formatRub, amountInWords, round2, vatTotals } = require('./lib/money');
const { buildAkt } = require('./lib/xlsx-akt');
const { buildRegistry } = require('./lib/xlsx-registry');
const { buildAktUslugHtml } = require('./lib/akt-uslug');
const { buildSchetHtml } = require('./lib/schet');
const { buildPlatyozhkaHtml } = require('./lib/platyozhka');
const { buildUpdHtml } = require('./lib/upd');
const { buildTorg12Html } = require('./lib/torg12');
const { buildDogovorHtml } = require('./lib/dogovor');
const { pdfAvailable, htmlToPdf } = require('./lib/pdf');
const { visionAvailable, visionHint, readInvoice } = require('./lib/vision');
const speech = require('./lib/speech');
const { applySetup } = require('./lib/bot-setup');
const { acquire: acquireLock } = require('./lib/lock');
const { supportScreen, forwardToSupport, legalLine } = require('./lib/bot-support');
const billing = require('./lib/billing');
const { payLink, daysFor, priceText, yearSaving } = require('./lib/lava');
const dadata = require('./lib/dadata');
const { parseRequisites, looksLikeBlock } = require('./lib/reqs');
const reqCheck = require('./lib/requisites-check');
const docService = require('./lib/doc-service');
const facsimile = require('./lib/facsimile');
const mailer = require('./lib/mail');
const mailbox = require('./lib/mailbox');
const { fetchNew } = require('./lib/imap');
const mime = require('./lib/mime');
const bank = require('./lib/bank-statement');
const recurring = require('./lib/recurring');
const period = require('./lib/period');
const bizTypes = require('./lib/biz-types');
const ai = require('./lib/ai-agent');

// ---------- утилиты дат/чисел ----------

// «Сегодня» и текущий год — по Москве, а не по часовому поясу сервера:
// иначе документ, выписанный ночью, получал вчерашнюю дату, а в
// новогоднюю ночь — ещё и номер из прошлого года. Подробности в lib/period.js.
const { todayISO, currentYear } = period;

/**
 * «15.06.2026» / «15.06.26» / «15.06» → ISO; иначе null.
 *
 * Разбор один на весь проект — period.parseDay. Своя копия здесь не
 * проверяла, существует ли дата: «31.02.2026 приход 94193» заносилось как
 * 2026-02-31 и вело себя дико — в карточке сумма есть, а в акт за февраль
 * операция то попадает, то нет, смотря как сравнились строки. «45.99.2026»
 * пропадало из всех актов вовсе, оставаясь в сальдо карточки.
 */
const parseDate = (s) => period.parseDay(s);

/**
 * Сумма из текста. Пробелы внутри числа убираем: их ставят как разделитель
 * разрядов. Копейки округляем — доли копейки в деньгах не существует.
 * Заведомо невозможные величины отвергаем: это опечатка, а не платёж.
 */
function parseAmount(s) {
  const v = Number(String(s).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(v) || Math.abs(v) >= 1e12) return null;
  return Math.round(v * 100) / 100;
}
const clean = (s) => (String(s).trim() === '-' ? '' : String(s).trim());

/**
 * Какие кнопки принадлежат какому незаконченному сценарию.
 *
 * Нажатие всего остального — уход в другой раздел, и недописанное надо
 * отменить: иначе состояние диалога живёт, пока его кто-нибудь не
 * перезапишет, и следующее слово в чате попадает в брошенный сценарий.
 *
 * Таблица, а не список исключений: список пришлось бы выводить из того,
 * кто читает состояние, — а читают его функции внутри обработчиков, и
 * пропустить одну ничего не стоит (так и вышло с разбором фотографии).
 * Здесь же видно каждый сценарий и его кнопки рядом.
 *
 * Сценарии, которых тут нет (claim, promo, support, op:, rm:, aktp:, mail:),
 * ждут только текста, и любая кнопка для них — выход.
 */
const FLOW_BUTTONS = {
  'items:': ['items.', 'tpl:', 'doc.make', 'doc.num', 'doc.date', 'doc.vat'],
  'form:': ['fb:', 'form.skip'],
  photo: ['ph.'],
  bank: ['bank:'],
  'pp:': ['pp.'],
  'dog:': ['dog.'],
  'fx:': ['fx.'],
  'mb:': ['mb.'],
};

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

/**
 * Главное меню.
 *
 * Здесь был параметр user, от которого зависела кнопка почты, — и ни один
 * из вызовов его не передавал, так что почта в меню не появлялась никогда
 * ни у кого. Поэтому пункт теперь безусловный: он ведёт на экран почты,
 * а тот уже сам показывает входящие, если ящик подключён. Меню не должно
 * зависеть от того, вспомнил ли вызывающий передать аргумент.
 */
function mainMenu() {
  const app = webAppUrl();
  return keyboard([
    ...(app ? [[{ text: '📱 Открыть приложение', webApp: app }]] : []),
    // Первой строкой — то, зачем человек пришёл. Без неё меню предлагает
    // восемь разделов и ни одного действия: новичок не понимает, что
    // документы живут внутри карточки контрагента, и уходит.
    [{ text: '🧾 Выписать счёт', data: 'go.sch' }],
    [{ text: '📄 Другой документ', data: 'go.any' }],
    [{ text: '🏢 Моя организация', data: 'org' }],
    // «Контрагенты» — слово из 1С. Кто в ней не работал, его не знает.
    [{ text: '👥 Клиенты и поставщики', data: 'cps' }],
    [{ text: '💸 Кто должен', data: 'debts' }, { text: '⏳ Не оплачено', data: 'unpaid' }],
    // Почта — ежедневная работа, а не настройка: пока она пряталась внутри
    // реквизитов организации, её просто не находили.
    [{ text: '📁 Мои документы', data: 'docs' }, { text: '✉️ Почта', data: 'mb' }],
    [{ text: '⭐ Подписка', data: 'billing' }],
    [{ text: '❓ Помощь', data: 'help' }, { text: '💬 Поддержка', data: 'support' }],
  ]);
}

const GREETING =
  '<b>Первичка</b> — счета, акты и платёжки за минуту.\n\n'
  + 'Нажмите <b>«Выписать счёт»</b> — я задам пару вопросов и пришлю готовый '
  + 'файл, который можно сразу отправить клиенту.\n\n'
  + '<i>Ещё умею: акт, УПД, накладную, договор, акт сверки в Excel, '
  + 'счёт с QR для оплаты камерой, отправку с вашей почты и учёт долгов. '
  + 'Первые 5 документов в месяц — бесплатно.</i>';

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
    [{ text: '🤝 Счёт-договор', data: `d.schdog:${cp.id}` }],
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
/** Двенадцать цифр в ИНН — предприниматель; у него нет КПП. */
const isIpInn = (inn) => String(inn || '').replace(/\D/g, '').length === 12;

// skipIfFilled — пропускается, если значение уже подставлено автозаполнением.
// skipIf — вопрос вообще неприменим (например, КПП у предпринимателя).
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
  // У предпринимателя КПП не бывает: если ИНН двенадцатизначный, вопрос
  // не задаём вовсе — незачем спрашивать то, чего у человека нет.
  { key: 'kpp', skipIfFilled: true, opt: true, skipIf: (v) => isIpInn(v.inn),
    q: 'КПП (для ООО; ИП отправьте «-»):' },
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
  { key: 'kpp', skipIfFilled: true, opt: true, skipIf: (v) => isIpInn(v.inn),
    q: 'КПП (или «-»):' },
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

/*
 * Короткие анкеты для проводника.
 *
 * Полные анкеты нужны — в них есть всё, что печатается в документах. Но
 * показывать новому человеку десять вопросов подряд нельзя: он видит «Шаг 1
 * из 13» и закрывает бота, ещё ничего не получив. Поэтому у проводника свой
 * набор — только то, без чего документ не выписать: как называетесь, ИНН и
 * куда платить. Остальное дозаполняется в разделе организации, когда человек
 * уже увидел результат и понял, зачем всё это.
 */
const ORG_QUICK = [
  {
    key: 'name',
    q: '<b>Как называется ваша фирма или ИП?</b>\n\n'
      + '<i>Так, как должно печататься в счёте: «ИП Иванов И. И.» или «ООО Ромашка».</i>',
  },
  {
    key: 'inn', auto: 'party', opt: true,
    q: '<b>Ваш ИНН</b> — подставлю остальные реквизиты из реестра.\n\n'
      + '<i>Можно вставить блок реквизитов целиком или пропустить.</i>',
  },
  {
    key: 'bik', auto: 'bank', skipIfFilled: true, opt: true,
    q: '<b>БИК вашего банка</b> — по нему подставлю название банка и корр. счёт.\n\n'
      + '<i>Он есть в реквизитах счёта в банковском приложении.</i>',
  },
  {
    key: 'acc', skipIfFilled: true, opt: true,
    q: '<b>Ваш расчётный счёт</b> — 20 цифр.\n\n'
      + '<i>Без него в счёте не будет QR-кода, и клиенту придётся вбивать реквизиты руками.</i>',
  },
];

const CP_QUICK = [
  {
    key: 'inn', auto: 'party', opt: true,
    q: '<b>ИНН клиента</b> — подставлю название и адрес из реестра.\n\n'
      + '<i>Можно вставить его реквизиты текстом или пропустить и написать название сами.</i>',
  },
  { key: 'name', skipIfFilled: true, q: '<b>Как называется клиент?</b>' },
  {
    key: 'kind', q: 'Он вам платит или вы ему?',
    buttons: [{ text: 'Платит нам', val: 'customer' }, { text: 'Платим ему', val: 'supplier' }],
  },
];

const FORMS = {
  org: { steps: ORG_STEPS, title: 'организации' },
  cp: { steps: CP_STEPS, title: 'контрагента' },
  orgq: { steps: ORG_QUICK, title: 'организации', saveAs: 'org' },
  cpq: { steps: CP_QUICK, title: 'клиента', saveAs: 'cp' },
};

async function startForm(tg, chatId, user, formName) {
  bdb.setState(user.id, `form:${formName}`, { i: 0, values: {} });
  await askStep(tg, chatId, formName, 0);
}
/**
 * Вопрос очередного шага.
 *
 * Три вещи, без которых человек уходит из формы: он не знает, сколько ещё
 * терпеть, он не знает, как пропустить лишнее (ответ «-» боту в голову не
 * приходит), и он не знает, как выйти. Поэтому у каждого шага есть номер,
 * кнопка «пропустить» на необязательных полях и кнопка отмены.
 */
async function askStep(tg, chatId, formName, i) {
  const form = FORMS[formName];
  const step = form.steps[i];
  const rows = [];
  if (step.buttons) rows.push(step.buttons.map((b) => ({ text: b.text, data: `fb:${b.val}` })));
  const tail = [];
  // Номер шага в кнопке обязателен: сообщения в чате остаются, и кнопка из
  // прошлого вопроса живёт вечно. Без сверки нажатие на неё пропустило бы
  // текущее поле — в том числе обязательное.
  if (step.opt && !step.buttons) tail.push({ text: '⏭ Пропустить', data: `form.skip:${i}` });
  tail.push({ text: '✖️ Отмена', data: 'menu' });
  rows.push(tail);
  const head = `<i>Шаг ${i + 1} из ${form.steps.length}</i>\n`;
  await tg.sendMessage(chatId, head + step.q, keyboard(rows));
}

/** Следующий незаполненный шаг: пропускаем то, что подставил справочник. */
async function advanceForm(tg, chatId, user, formName, values, from) {
  const form = FORMS[formName];
  let next = from;
  while (next < form.steps.length) {
    const s = form.steps[next];
    // Пропускаем заполненное; после вставки блока — и пустые поля-реквизиты,
    // кроме расчётного счёта: без него не будет QR, поэтому его переспросим.
    const skip = (s.skipIfFilled
      && (values[s.key] || (values.__pasted && s.opt && s.key !== 'acc')))
      // skipIf — вопрос неприменим к этому человеку, а не «уже отвечен».
      // Спрашивать у предпринимателя КПП значит просить у него то, чего у
      // него не бывает: он гадает, что вписать, и вписывает что-нибудь.
      || (typeof s.skipIf === 'function' && s.skipIf(values));
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
      if (r.ok) fill(values, r.fields, ['name', 'full_name', 'kpp', 'address', 'signer', 'ogrnip']);
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
    fill(values, r.fields, ['name', 'full_name', 'kpp', 'address', 'signer', 'ogrnip']);
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

  /*
   * Контрольные суммы реквизитов — на шаге ввода, но уже после разбора:
   * на шаге ИНН человек часто вставляет весь блок реквизитов целиком, и
   * проверять надо разобранное значение, а не вставленный текст.
   *
   * Проверка тут не ради строгости. Опечатка в расчётном счёте — это
   * платёж, который не пройдёт, а опечатка в ИНН — документ, который
   * вернёт бухгалтер контрагента. И то и другое ловится арифметикой, но
   * только пока человек ещё смотрит на это поле: через неделю в выписанном
   * счёте он ошибку не найдёт.
   */
  const checked = values[step.key];
  if (checked && ['inn', 'kpp', 'bik', 'acc', 'corr_acc'].includes(step.key)) {
    const bik = step.key === 'bik' ? checked : values.bik;
    const r = step.key === 'inn' ? reqCheck.checkInn(checked)
      : step.key === 'kpp' ? reqCheck.checkKpp(checked)
        : step.key === 'bik' ? reqCheck.checkBik(checked)
          : reqCheck.checkAccount(checked, bik, step.key === 'corr_acc');
    if (!r.ok) {
      values[step.key] = '';
      bdb.setState(user.id, `form:${formName}`, { i, values });
      await tg.sendMessage(chatId,
        `⚠️ ${esc(r.error)}\n\nПришлите ещё раз${step.opt ? ' или «-», если поля нет' : ''}:`);
      return;
    }
  }

  await advanceForm(tg, chatId, user, formName, values, i + 1);
}

async function finishForm(tg, chatId, user, rawForm, values) {
  const formName = (FORMS[rawForm] || {}).saveAs || rawForm;
  // Форму могли открыть по дороге к документу: тогда после сохранения не
  // высаживаем человека в меню, а возвращаем к тому, что он начал.
  const then = values.__then;
  if (formName === 'org') {
    if (!values.full_name) values.full_name = values.name;
    bdb.saveMyOrg(user.id, values); // заменяем организацию, а не плодим новые
    const hasBank = values.acc && values.bik && values.corr_acc;
    await tg.sendMessage(chatId,
      `✅ Организация <b>${esc(values.name)}</b> сохранена.`
      + (hasBank ? '\nВ счёте будет платёжный QR.' : '\n<i>Расчётный счёт/БИК не заполнены — QR в счёте не появится.</i>'),
      then ? undefined : mainMenu());
    if (then) { await startDoc(tg, chatId, user, then); return; }
  } else if (formName === 'cp') {
    if (!values.full_name) values.full_name = values.name;
    if (!values.period_end) values.period_end = todayISO();
    const id = bdb.createCp(user.id, values);
    if (then && ITEM_DOCS[then]) {
      await tg.sendMessage(chatId, `✅ ${esc(values.name)} добавлен.`);
      await startItems(tg, chatId, user, then, id);
      return;
    }
    const { info, kb } = cpMenu(user.id, bdb.getCp(user.id, id));
    await tg.sendMessage(chatId, `✅ Контрагент добавлен.\n\n${info}`, kb);
  }
}

// ---------- умный ввод операции ----------

const KIND_CREDIT = ['приход', 'поставка', 'отгрузка', 'услуга', 'услуги', 'реализация'];
const KIND_DEBIT = ['оплата', 'оплатил', 'принято', 'платеж', 'платёж', 'предоплата'];

/** «15.06 приход 94193 №15» → {date,kind,doc,debit,credit} | null */
function parseOp(text) {
  /*
   * Разряды через пробел склеиваем до разбиения на слова. Иначе «приход
   * 1 000» распадалось на «1» и «000», первым числом оказывалась единица —
   * и в журнал молча уходил один рубль вместо тысячи.
   */
  let glued = String(text).trim();
  for (let i = 0; i < 4; i += 1) {                 // «1 000 000» — две склейки
    const next = glued.replace(/(\d)\s+(\d{3})(?!\d)/g, '$1$2');
    if (next === glued) break;
    glued = next;
  }
  /*
   * Дата, написанная явно, но несуществующая — это опечатка, а не «сегодня».
   * Молча подставлять текущий день нельзя: человек увидит в журнале не ту
   * дату, которую вводил, и заметит это в лучшем случае при сверке.
   */
  const looksLikeDate = /^\d{1,2}[.\-/]\d{1,2}(?:[.\-/]\d{2,4})?$/;
  for (const t of glued.split(/\s+/)) {
    if (looksLikeDate.test(t) && !parseDate(t)) return null;
  }
  const tokens = glued.split(/\s+/);
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

/**
 * Акт сверки за период.
 *
 * Период задаётся снаружи; по умолчанию — от начала отношений до сегодня.
 * Раньше конец периода запоминался в карточке при первом акте и больше не
 * менялся: второй акт печатал в шапке прошлогоднюю дату, а в таблицу
 * складывал операции по сегодняшний день. Теперь карточку не трогаем —
 * в ней opening_date значит начало отношений, а не начало выбранного
 * периода, и подменять одно другим нельзя.
 */
async function genAktSverki(tg, chatId, user, cpId, from, to) {
  if (!(await requireQuota(tg, chatId, user))) return;
  const org = await requireOrg(tg, chatId, user); if (!org) return;
  const p = bdb.cpForPeriod(user.id, cpId, from, to);
  if (!p) return;
  const buf = await buildAkt({ org: orgForAkt(org), cp: p.view, ops: p.ops });
  const seq = bdb.nextSeq(user.id, 'akt', currentYear());
  await sendGenerated(tg, chatId, {
    xlsxBuffer: Buffer.from(buf), base: `Акт_сверки_${safeName(p.cp.name)}`,
    caption: `Акт сверки с <b>${esc(p.cp.name)}</b> за период ${ru(p.from)}—${ru(p.to)}.\n`
      + `Входящее сальдо ${formatRub(Math.abs(p.opening))}, исходящее ${formatRub(Math.abs(p.closing))}.`,
  });
  bdb.saveDoc(user.id, {
    orgId: org.id, cpId, type: 'akt', number: String(seq), seq, date: todayISO(),
    total: Math.abs(p.closing), payload: { ops: p.ops.length, from: p.from, to: p.to },
  });
}

/**
 * Спросить период перед актом сверки.
 *
 * Бот раньше молча брал весь срок отношений, а сверяются обычно за месяц
 * или квартал — и в мини-приложении выбор периода уже был. Кнопки закрывают
 * частые случаи, «свой период» — всё остальное.
 */
async function askAktPeriod(tg, chatId, user, cpId) {
  const cp = bdb.getCp(user.id, cpId);
  if (!cp) { await tg.sendMessage(chatId, 'Клиент не найден.', mainMenu()); return; }
  const rows = [];
  for (let i = 0; i < period.PRESETS.length; i += 2) {
    rows.push(period.PRESETS.slice(i, i + 2)
      .map((p) => ({ text: p.text, data: `akt.p:${cpId}:${p.code}` })));
  }
  rows.push([{ text: '📅 Свой период', data: `akt.own:${cpId}` }]);
  rows.push([{ text: '⬅️ Назад', data: `cp:${cpId}` }]);
  await tg.sendMessage(chatId,
    `Акт сверки с <b>${esc(cp.name)}</b>. За какой период?\n\n`
    + '<i>«За всё время» — от начала расчётов, с начальным сальдо из карточки.</i>',
    keyboard(rows));
}

/** Свой период текстом: «01.01.2026 - 31.03.2026», «март», «2 квартал». */
async function handleAktPeriodText(tg, chatId, user, cpId, text) {
  const r = period.parsePeriodText(text);
  if (!r) {
    await tg.sendMessage(chatId,
      'Не понял период. Напишите одним из способов:\n'
      + '<code>01.01.2026 - 31.03.2026</code>\n'
      + '<code>март</code>  ·  <code>апрель 2025</code>\n'
      + '<code>2 квартал</code>  ·  <code>2025</code>');
    return;
  }
  bdb.clearState(user.id);
  await genAktSverki(tg, chatId, user, cpId, r.from, r.to);
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
  const year = currentYear();
  const seq = bdb.nextSeq(user.id, type, year);
  const data = { seq, number: String(seq), date: todayISO(), items: [], ask: '', doc: extra };
  bdb.setState(user.id, `items:${type}:${cpId}`, data);
  const tpl = bdb.listTemplates(user.id, 6).length
    ? '\n\nЧастые позиции — кнопками ниже, количество спрошу.' : '';
  await tg.sendMessage(chatId,
    `Составляем <b>${esc(ITEM_DOCS[type].title)} № ${esc(data.number)}</b> от ${ru(data.date)}.\n`
    + 'Отправляйте позиции по одной — как удобно:\n'
    + '<code>Аренда помещения 1 30000</code>\n'
    + '<code>Канапе ассорти 20 650</code>\n'
    + '<code>Бумага 10 пачек по 300</code>\n\n'
    + '<i>Если чего-то не хватит — спрошу.</i>' + tpl,
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
      ...(['sch', 'schdog'].includes(type)
        ? [[{ text: `🧾 НДС: ${sums.vat == null ? 'нет' : `${extra.vatRate}%`}`, data: 'doc.vat' }]] : []),
      [{ text: '➕ Ещё позиция', data: 'items.more' }],
      [{ text: '✖️ Отмена', data: 'menu' }],
    ]));
}

/**
 * Единицы измерения, которые встречаются в счетах. Ключ — как пишут люди,
 * значение — как печатаем в документе.
 *
 * Нужны они не для красоты: в строке «Аренда 30 м²» число 30 относится к
 * названию, а не к количеству, и отличить это можно только по единице,
 * стоящей сразу за числом.
 */
const UNITS = {
  шт: 'шт.', штук: 'шт.', штука: 'шт.', штуки: 'шт.',
  уп: 'уп.', упак: 'уп.', упаковка: 'уп.', упаковок: 'уп.', пачка: 'уп.', пачек: 'уп.',
  компл: 'компл.', комплект: 'компл.', комплектов: 'компл.', набор: 'набор', наборов: 'набор',
  кг: 'кг', г: 'г', грамм: 'г', т: 'т', тонн: 'т', л: 'л', литр: 'л', литров: 'л',
  м: 'м', метр: 'м', метров: 'м', км: 'км', см: 'см',
  'м2': 'м²', 'м²': 'м²', кв: 'м²', квм: 'м²', 'кв.м': 'м²', 'м3': 'м³', 'м³': 'м³',
  ч: 'ч', час: 'ч', часа: 'ч', часов: 'ч', мин: 'мин',
  сут: 'сут.', сутки: 'сут.', суток: 'сут.', день: 'дн.', дня: 'дн.', дней: 'дн.', дн: 'дн.',
  мес: 'мес.', месяц: 'мес.', месяца: 'мес.', месяцев: 'мес.', год: 'год', лет: 'год',
  усл: 'усл.', услуга: 'усл.', услуг: 'усл.', раз: 'раз', рейс: 'рейс', смена: 'смена', смен: 'смена',
  квт: 'кВт', 'квт·ч': 'кВт·ч', квтч: 'кВт·ч',
};

const unitOf = (word) => UNITS[String(word || '').toLowerCase().replace(/\.$/, '')] || null;

/**
 * Числа из строки — вместе с тем, где они стояли.
 *
 * mergeThousands включает склейку разрядов через пробел: «30 000» это одно
 * число. Она нужна, но она же и опасна — «30 450» с тем же успехом читается
 * как «30 штук по 450». Поэтому разбор идёт в два прохода, а решает
 * readItemLine.
 *
 * Точка перед ровно тремя цифрами это всегда разряды, а не копейки: копеек
 * ровно две, и «30.000» человек пишет, имея в виду тридцать тысяч.
 */
function numbersIn(text, mergeThousands = false) {
  // Хвостовой (?!\d) обязателен: без него «Фуршет 10 1500» читается как
  // «10 150» плюс «0» — разряды съедают пробел между количеством и ценой.
  const re = mergeThousands
    ? /\d{1,3}(?:[\s\u00a0]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d+)?/g
    : /\d+(?:[.,]\d+)?/g;
  const out = [];
  let m = re.exec(text);
  while (m) {
    const raw = m[0];
    const value = /^\d+\.\d{3}$/.test(raw)
      ? Number(raw.replace('.', ''))
      : Number(raw.replace(/[\s\u00a0]/g, '').replace(',', '.'));
    if (Number.isFinite(value)) out.push({ value, start: m.index, end: m.index + raw.length });
    m = re.exec(text);
  }
  return out;
}

/** Слово сразу после числа — если это единица измерения, вернём её. */
function unitAfter(text, pos) {
  const rest = text.slice(pos).replace(/^[\s.,]+/, '');
  return unitOf((/^[a-zA-Zа-яА-ЯёЁ²³.]+/.exec(rest) || [''])[0]);
}

/**
 * Разбор строки позиции.
 *
 * Формат «Наименование; количество; цена» остаётся, но требовать его нельзя:
 * предприниматель пишет так, как говорит — «Аренда 30 м² 1 30.000»,
 * «Услуги питания 30 по 450», «Консультация 5000».
 *
 * Главная сложность — пробел. В «30 000» он разделяет разряды, в «30 450»
 * (услуги питания, тридцать порций по 450) он разделяет количество и цену.
 * Одним выражением это не различить, поэтому пробуем сначала без склейки
 * разрядов: если так выходит осмысленная пара «количество × цена» — берём
 * её, потому что это и есть основной формат. И только если не вышло
 * (цена оказалась нулём или число всего одно), пробуем со склейкой.
 *
 * @returns {{name,qty,unit,price}|{name,partial:true}|null}
 *   partial — поняли только название; количество и цену спросим отдельно.
 */
function readItemLine(text) {
  const line = String(text || '').replace(/\u00a0/g, ' ').trim();
  if (!line) return null;

  const parts = line.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const qty = parseAmount(parts[1].replace(/[^\d.,]/g, ''));
    const price = parseAmount(parts[parts.length - 1].replace(/[^\d.,]/g, ''));
    if (qty != null && price != null) {
      return { name: parts[0], qty, unit: unitOf(parts[1].replace(/[\d\s.,]/g, '')) || 'шт.', price };
    }
  }

  // «х», «*» и «по» между числами — разделители, а не часть названия. Меняем
  // их на «;», а не на пробел: пробел склеил бы «30 по 450» в 30 450.
  const plain = line.replace(/\s*[x×хX*]\s*(?=\d)/g, ';').replace(/\s+по\s+(?=\d)/gi, ';');
  // Хвостовые слова вроде «руб.» отбрасываем, чтобы они не липли к названию.
  const tail = (from) => plain.slice(from).replace(/^[\s.,]*(?:руб\.?|р\.|₽|рублей)?[\s.,]*$/i, '');

  const pick = (nums) => {
    if (nums.length < 2) return null;
    const [q, p] = nums.slice(-2);
    if (tail(p.end) !== '') return null;
    const name = plain.slice(0, q.start).replace(/[\s.,;:—-]+$/, '').trim();
    if (!name || !(p.value > 0) || !(q.value > 0)) return null;
    return { name, qty: q.value, unit: unitAfter(plain, q.end) || 'шт.', price: p.value };
  };

  // Пара «количество × цена» важнее разрядов — это основной формат ввода.
  const asPair = pick(numbersIn(plain, false));
  if (asPair) return asPair;
  const merged = pick(numbersIn(plain, true));
  if (merged) return merged;

  const one = numbersIn(plain, true);
  if (one.length === 1) {
    const n = one[0];
    const name = plain.slice(0, n.start).replace(/[\s.,;:—-]+$/, '').trim();
    // «Аренда 30 м²» — число с единицей это описание, а не цена.
    if (name && n.value > 0 && !unitAfter(plain, n.end) && tail(n.end) === '') {
      return { name, qty: 1, unit: 'шт.', price: n.value };
    }
  }

  // Названием считаем всё, что написали: цену и количество доспросим.
  // Но из одних цифр названия не выйдет — тут действительно нечего понять.
  if (!/[a-zA-Zа-яА-ЯёЁ]/.test(line)) return null;
  return { name: line.slice(0, 200), partial: true };
}

/** Строгий разбор — только полностью понятая позиция. Используется в прогоне. */
function parseItemLine(text) {
  const r = readItemLine(text);
  return r && !r.partial ? r : null;
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
  const org = bdb.getDefaultOrg(user.id);
  const q = res.quota;
  const tail = q.paid ? '' : `\n<i>Выписано в этом месяце: ${q.used} из ${q.limit} бесплатных.</i>`;
  // Проводка в журнал — вещь неочевидная, о ней надо сказать прямо,
  // иначе человек не поймёт, откуда взялся долг в разделе «Кто должен».
  const ledger = res.debt
    ? `\n<i>Долг ${formatRub(res.total)} внесён в журнал. Отметить оплату — в карточке документа.</i>`
    : '';
  await tg.sendDocument(chatId, {
    filename: res.file.filename,
    buffer: res.file.buffer,
    caption: `${esc(res.title)} № ${esc(res.doc.number)}`
      + ` от ${ru(res.doc.date)} для <b>${esc(cp.name)}</b> на ${formatRub(res.total)}`
      + (type === 'sch' ? (payable(org)
        ? '\nВ счёте есть QR — клиент платит, наведя камеру банка.'
        : '\n\n⚠️ В счёте нет реквизитов для оплаты: не заполнены банк и расчётный счёт. '
          + 'Клиенту некуда платить — добавьте их в «Моей организации».') : '')
      + (res.file.pdf ? '' : '\n\n(PDF недоступен — откройте файл в браузере и распечатайте / сохраните в PDF.)')
      + ledger + tail,
  });
  return true;
}

/** Есть ли куда платить: без банка счёт остаётся просьбой без реквизитов. */
const payable = (org) => Boolean(org && org.acc && org.bik && org.corr_acc);

/**
 * Экран после выданного документа.
 *
 * Раньше здесь открывалась карточка контрагента — двенадцать кнопок, среди
 * которых человек ищет, что делать дальше. А дальше он хочет одного из трёх:
 * отправить документ клиенту, выписать следующий или уйти. Плюс если платить
 * по счёту некуда, самое полезное сейчас — дозаполнить банк.
 */
async function afterDoc(tg, chatId, user, cpId) {
  const org = bdb.getDefaultOrg(user.id);
  const last = bdb.listDocs(user.id, 1)[0];
  const rows = [];
  if (last) {
    rows.push([{
      text: mailbox.has(user.id) ? '✉️ Отправить клиенту на почту' : '✉️ Отправить почтой',
      data: mailbox.has(user.id) ? `doc.mail:${last.id}` : 'mb',
    }]);
  }
  if (!payable(org)) rows.push([{ text: '🏦 Добавить банк и счёт', data: 'org.new' }]);
  // Повторение заводится здесь, а не отдельным мастером: позиции уже
  // набраны и проверены человеком, повторять нечего — только выбрать день.
  if (last && docService.ITEM_DOCS[last.type]) {
    rows.push([{ text: '🔁 Повторять каждый месяц', data: `rec.new:${last.id}` }]);
  }
  rows.push([{ text: '🧾 Выписать ещё', data: 'go.sch' },
    { text: '📄 Другой документ', data: 'go.any' }]);
  rows.push([{ text: '👤 Карточка клиента', data: `cp:${cpId}` }]);
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  await tg.sendMessage(chatId, '<b>Готово.</b> Что дальше?', keyboard(rows));
}

async function finishItems(tg, chatId, user, state) {
  const [, type, cpIdStr] = state.state.split(':');
  const cpId = Number(cpIdStr);
  const d = state.data;
  const doc = { number: d.number, date: d.date, items: d.items, ...(d.doc || {}) };
  bdb.clearState(user.id);
  const done = await issueDoc(tg, chatId, user, { type, cpId, doc, seq: d.seq, extra: d.doc || {} });
  if (!done) return;
  await afterDoc(tg, chatId, user, cpId);
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
  const year = currentYear();
  const seq = bdb.nextSeq(user.id, src.type, year);
  const data = { seq, number: String(seq), date: todayISO(), items, ask: '', doc: extra };
  bdb.setState(user.id, `items:${src.type}:${src.cp_id}`, data);
  await tg.sendMessage(chatId,
    `Повторяю <b>${esc(src.title.toLowerCase())} № ${esc(src.number)}</b>: ${items.length} поз., `
    + `${formatRub(src.total)}\nНовый номер — ${esc(data.number)}, дата — ${ru(data.date)}.`);
  await showPreview(tg, chatId, user, bdb.getState(user.id));
}

/**
 * Границы периода для реестра документов.
 *
 * Считает их общий lib/period.js — второй набор периодов в том же боте
 * рано или поздно разъехался бы с первым. Отличие у реестра одно и оно
 * осознанное: месяц, квартал и год берутся целиком, а не по сегодня —
 * реестр собирают за период, в том числе заранее. Подписи свои: в реестре
 * привычнее «текущий месяц», в акте сверки — «этот месяц».
 */
const REGISTRY_PERIODS = {
  prev: { code: 'pm', title: 'прошлый месяц' },
  quarter: { code: 'q', title: 'текущий квартал' },
  year: { code: 'y', title: 'текущий год' },
  month: { code: 'm', title: 'текущий месяц' },
};

function periodOf(name) {
  const p = REGISTRY_PERIODS[name] || REGISTRY_PERIODS.month;
  const r = period.presetRange(p.code, period.todayDate(), { whole: true });
  return { from: r.from, to: r.to, title: p.title };
}

/** Реестр выписанного за период — то, чем закрывают месяц. */
async function sendRegistry(tg, chatId, user, periodName) {
  const org = bdb.getDefaultOrg(user.id);
  if (!org) { await tg.sendMessage(chatId, 'Сначала заведите организацию.', mainMenu()); return; }
  const { from, to, title } = periodOf(periodName);
  const docs = bdb.docsBetween(user.id, from, to);

  await tg.sendChatAction(chatId, 'upload_document');
  const buf = await buildRegistry({ org, docs, from, to });
  const sum = round2(docs.reduce((a2, d) => a2 + (Number(d.total) || 0), 0));
  const unpaid = docs.filter((d) => !d.paid_at);
  const unpaidSum = round2(unpaid.reduce((a2, d) => a2 + (Number(d.total) || 0), 0));

  await tg.sendDocument(chatId, {
    filename: `Реестр_${from}_${to}.xlsx`,
    buffer: buf,
    caption: `Реестр за ${esc(title)} (${ru(from)}—${ru(to)}).\n`
      + `Документов: <b>${docs.length}</b> на <b>${formatRub(sum)}</b>`
      + (unpaid.length ? `\nНе оплачено: <b>${unpaid.length}</b> на <b>${formatRub(unpaidSum)}</b>` : '\nВсё оплачено.'),
  });
}

/** Что ещё не оплачено — то, за чем следят каждый день. */
async function showUnpaid(tg, chatId, user) {
  const list = bdb.unpaidDocs(user.id);
  if (!list.length) {
    await tg.sendMessage(chatId, 'Неоплаченных документов нет — все закрыты.',
      keyboard([[{ text: '⬅️ Меню', data: 'menu' }]]));
    return;
  }
  const today = todayISO();
  // Сумма — сделками, а не документами: счёт и закрывающий его акт на одну
  // сделку иначе складывались, и сводка расходилась с плиткой в приложении.
  const sum = bdb.dealTotals(list).sum;
  const rows = list.map((d) => {
    const cp = d.cp_id ? bdb.getCp(user.id, d.cp_id) : null;
    const days = Math.floor((new Date(today) - new Date(d.date)) / 86400000);
    return [{
      text: `${d.title} № ${d.number} · ${cp ? cp.name : '—'} · ${formatRub(d.total).replace(/<[^>]+>/g, '')}`
        + (days > 0 ? ` · ${days} дн.` : ''),
      data: `doc:${d.id}`,
    }];
  }).map((r) => [{ ...r[0], text: r[0].text.slice(0, 60) }]);
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  await tg.sendMessage(chatId,
    `<b>Не оплачено: ${formatRub(sum)}</b> — ${list.length} ${plural(list.length, 'документ', 'документа', 'документов')}.`,
    keyboard(rows));
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
  rows.push([{ text: '📊 Реестр за период (Excel)', data: 'reg' }]);
  const repeats = recurring.list(user.id).length;
  rows.push([{ text: `🔁 Регулярные документы${repeats ? ` (${repeats})` : ''}`, data: 'rec' }]);
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  await tg.sendMessage(chatId,
    `Последние документы (в этом месяце ${q.used}${q.paid ? '' : ` из ${q.limit} бесплатных`}):`,
    keyboard(rows));
}

/** Карточка документа: выслать файл заново или повторить новым номером. */
/**
 * Что сказать после пересчёта основания.
 *
 * Про строки оплаты надо говорить наравне с долгом: пересчёт может снять
 * оплату на 30 000 — сальдо уезжает ровно настолько, — а сообщение раньше
 * считало только реализации и рапортовало «ничего не менял».
 */
function rebuildText(fixed) {
  const parts = [];
  if (fixed.added) parts.push(`долг добавлен по ${fixed.added} ${plural(fixed.added, 'документу', 'документам', 'документам')}`);
  if (fixed.removed) parts.push(`убран у ${fixed.removed}`);
  if (fixed.paid) parts.push(`поправлено строк оплаты: ${fixed.paid}`);
  return parts.length ? `Пересчитал журнал: ${parts.join(', ')}.` : '';
}

async function showDoc(tg, chatId, user, docId) {
  const d = bdb.getDoc(user.id, docId);
  if (!d) { await tg.sendMessage(chatId, 'Документ не найден.', mainMenu()); return; }
  const cp = d.cp_id ? bdb.getCp(user.id, d.cp_id) : null;
  const items = (d.payload.items || [])
    .map((it, i) => `${i + 1}. ${esc(it.name)} — ${it.qty} × ${formatRub(it.price)}`).join('\n');
  const rows = [];
  if (d.type !== 'akt') rows.push([{ text: '📄 Прислать файл заново', data: `doc.get:${d.id}` }]);
  const payable = ['sch', 'usl', 'upd', 'torg12'].includes(d.type) && d.total > 0;
  if (payable) {
    rows.push([d.paid_at
      ? { text: `↩️ Снять отметку об оплате (${ru(d.paid_at)})`, data: `doc.unpaid:${d.id}` }
      : { text: '✅ Отметить оплаченным', data: `doc.paid:${d.id}` }]);
  }
  // Отмену проводки надо уметь отменить. Без этой кнопки документ навсегда
  // выпадал из долга, продолжая числиться в «Ждут оплаты».
  if (d.no_debt) rows.push([{ text: '↩️ Вернуть в долг', data: `doc.debt:${d.id}` }]);
  if (mailbox.resolve(user.id).ok && d.type !== 'akt') {
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
    + (payable ? `Оплата: <b>${d.paid_at ? `получена ${ru(d.paid_at)}` : 'не отмечена'}</b>\n` : '')
    + (d.no_debt ? 'Долг по этому документу отменён вручную.\n' : '')
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
  // Цену называем до кнопки, а не после перехода на оплату: человек имеет
  // право знать, сколько это стоит, прежде чем куда-то нажимать.
  const price = priceText();
  if (price) {
    lines.push('', `<b>${esc(price)}</b>`);
    const save = yearSaving();
    if (save > 0) lines.push(`<i>За год — выгода ${formatRub(save)}.</i>`);
  }
  if (!link) {
    lines.push('');
    lines.push('<i>Оплата пока не подключена. Напишите в поддержку — выдадим доступ вручную.</i>');
  }

  const rows = [];
  if (link) rows.push([{ text: a.active ? '⭐ Продлить' : '⭐ Оформить подписку', url: link }]);
  if (link) rows.push([{ text: '✅ Я оплатил', data: 'pay.claim' }]);
  // Код доступа показываем всегда: им пользуются и до подключения оплаты,
  // и когда доступ дают за отзыв, тест или взамен сорвавшегося платежа.
  rows.push([{ text: '🎟 У меня есть код', data: 'promo' }]);
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

/** Кого имел в виду владелец: номер, @имя или пересланное сообщение. */
function findTarget(who) {
  const clean = String(who || '').replace(/^@/, '').trim();
  if (!clean) return null;
  // По номеру заводим карточку сразу: доступ можно выдать заранее, ещё до
  // того как человек нажал «Старт», — при первом заходе он его уже увидит.
  if (/^\d+$/.test(clean)) return bdb.getOrCreateUser(Number(clean));
  return bdb.findUserByUsername(clean);
}

const OWNER_HELP = [
  '<b>Команды владельца</b>',
  '',
  '<b>Доступ конкретному человеку</b>',
  '<code>/grant 123456789 30</code> — выдать 30 дней по номеру',
  '<code>/grant @ivanov 30</code> — то же по имени (если он уже запускал бота)',
  '<code>/ungrant @ivanov</code> — снять доступ (пригодится, чтобы посмотреть, как выглядит бесплатный режим)',
  '<code>/who</code> — у кого сейчас есть доступ',
  '',
  '<b>Коды доступа</b> — когда номера человека нет',
  '<code>/code</code> — один код на 30 дней',
  '<code>/code 90</code> — на 90 дней',
  '<code>/code 30 5</code> — сразу пять кодов по 30 дней',
  '<code>/code 30 5 бета-тест</code> — с пометкой, чтобы потом вспомнить',
  '<code>/code 30 1x20 вебинар</code> — один код на 20 активаций',
  '<code>/codes</code> — список кодов и кто их активировал',
  '<code>/revoke PRV-XXXX-XXXX</code> — отключить код',
  '',
  '<b>Разное</b>',
  '<code>/id</code> — узнать свой номер (эту команду можно дать клиенту)',
].join('\n');

/** Команды владельца: выдать доступ руками, кодами и посмотреть, у кого он есть. */
async function ownerCommand(tg, chatId, text) {
  if (text === '/admin' || text === '/owner') {
    await tg.sendMessage(chatId, OWNER_HELP);
    return true;
  }

  const grant = /^\/grant\s+(\S+)\s+(\d+)/.exec(text);
  if (grant) {
    const who = grant[1].replace(/^@/, '');
    const days = Number(grant[2]);
    const target = findTarget(who);
    if (!target) {
      await tg.sendMessage(chatId,
        `Не нашёл пользователя ${esc(who)}.\n\nПо имени получится только если человек уже запускал бота. `
        + 'Иначе выдайте по номеру (<code>/grant 123456789 30</code>) — номер он узнает командой <code>/id</code> — '
        + 'или пришлите ему код: <code>/code</code>.');
      return true;
    }
    const until = billing.grantDays(target.id, days);
    await tg.sendMessage(chatId, `Выдал ${days} ${plural(days, 'день', 'дня', 'дней')} пользователю ${esc(target.name || who)} — до ${ru(until)}.`);
    try {
      await tg.sendMessage(target.tg_id, `✅ Доступ продлён до <b>${ru(until)}</b>.`);
    } catch (e) { if (e && e.blocked) bdb.markBlocked(target.id); }
    return true;
  }

  const ungrant = /^\/ungrant\s+(\S+)/.exec(text);
  if (ungrant) {
    const target = findTarget(ungrant[1]);
    if (!target) { await tg.sendMessage(chatId, `Не нашёл пользователя ${esc(ungrant[1])}.`); return true; }
    billing.revokeAccess(target.id);
    await tg.sendMessage(chatId, `Доступ снят: ${esc(target.name || target.tg_id)}. Остался бесплатный лимит.`);
    return true;
  }

  if (text === '/who') {
    const list = billing.paidUsers();
    await tg.sendMessage(chatId, list.length
      ? '<b>С доступом:</b>\n' + list.map((u) => {
        const how = billing.usedCodes(u.id).length ? ' · по коду' : '';
        return `• ${esc(u.name || u.tg_id)}${u.username ? ` @${esc(u.username)}` : ''}`
          + ` — до ${ru(u.access_until)}${how}\n  <code>${u.tg_id}</code>`;
      }).join('\n')
      : 'Доступов нет. Выдать: <code>/grant номер 30</code> или <code>/code</code>.');
    return true;
  }

  // /code [дней] [сколько кодов | 1x20 активаций] [пометка]
  // Список разбираем раньше выдачи: «/codes» тоже начинается с «/code».
  const code = text === '/codes' ? null : /^\/code\b\s*(.*)$/.exec(text);
  if (code) {
    const rest = code[1].trim();
    const m = /^(\d+)?\s*(?:(\d+)(?:x(\d+))?)?\s*(.*)$/i.exec(rest) || [];
    const days = Number(m[1]) || 30;
    const count = Number(m[2]) || 1;
    const maxUses = Number(m[3]) || 1;
    const note = (m[4] || '').trim();
    const made = billing.createCodes({ days, count, maxUses, note });
    const many = maxUses > 1 ? ` · до ${maxUses} активаций каждый` : '';
    await tg.sendMessage(chatId,
      `Готово: ${made.length} ${plural(made.length, 'код', 'кода', 'кодов')} на ${days} `
      + `${plural(days, 'день', 'дня', 'дней')}${many}${note ? ` · ${esc(note)}` : ''}\n\n`
      + made.map((c) => `<code>${c.pretty}</code>`).join('\n')
      + '\n\nОтдайте код человеку: в боте «⭐ Подписка» → «🎟 У меня есть код». '
      + 'Или пусть просто пришлёт код сообщением — бот поймёт.');
    return true;
  }

  if (text === '/codes') {
    const list = billing.listCodes(20);
    if (!list.length) {
      await tg.sendMessage(chatId, 'Кодов нет. Создать: <code>/code 30</code>.');
      return true;
    }
    const lines = list.map((c) => {
      const who = billing.codeUsers(c.code)
        .map((u) => (u.username ? `@${u.username}` : (u.name || u.tg_id))).join(', ');
      const state = c.revoked_at ? 'отключён'
        : (c.uses >= c.max_uses ? 'использован' : `свободен ${c.max_uses - c.uses} из ${c.max_uses}`);
      return `${c.live ? '🟢' : '⚪️'} <code>${c.pretty}</code> — ${c.days} дн. · ${state}`
        + `${c.note ? ` · ${esc(c.note)}` : ''}${who ? `\n   ${esc(who)}` : ''}`;
    });
    await tg.sendMessage(chatId, `<b>Коды доступа</b>\n\n${lines.join('\n')}`);
    return true;
  }

  const revoke = /^\/revoke\s+(\S+)/.exec(text);
  if (revoke) {
    const target = billing.getCode(revoke[1]);
    if (!target) { await tg.sendMessage(chatId, 'Такого кода нет.'); return true; }
    const done = billing.revokeCode(revoke[1]);
    await tg.sendMessage(chatId, done
      ? `Код <code>${target.pretty}</code> отключён. Уже выданный по нему доступ остаётся — снять: <code>/ungrant номер</code>.`
      : `Код <code>${target.pretty}</code> и так был отключён.`);
    return true;
  }

  return false;
}

/**
 * Активация кода доступа. Работает и из формы, и когда человек просто
 * прислал код сообщением — узнать его по виду несложно, а лишний шаг
 * «сначала нажмите кнопку» раздражает.
 */
async function redeemPromo(tg, chatId, user, text) {
  bdb.clearState(user.id);
  const res = billing.redeemCode(user.id, text);
  if (!res.ok) {
    await tg.sendMessage(chatId, `${esc(res.error)}`, keyboard([
      [{ text: '🎟 Ввести ещё раз', data: 'promo' }],
      [{ text: '💬 Поддержка', data: 'support' }, { text: '⬅️ Подписка', data: 'billing' }],
    ]));
    return;
  }
  await tg.sendMessage(chatId,
    `✅ Код принят: ${res.days} ${plural(res.days, 'день', 'дня', 'дней')} без ограничений.\n`
    + `Доступ до <b>${ru(res.until)}</b>.`, mainMenu());
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
  // Письмо уходит из ящика самого пользователя: с нашего адреса оно
  // попадало бы в спам и юридически отправителем были бы мы.
  const box = mailbox.resolve(user.id);
  if (!box.ok) {
    await tg.sendMessage(chatId, esc(box.reason),
      keyboard([[{ text: '✉️ Подключить почту', data: 'mb' }], [{ text: '⬅️ Меню', data: 'menu' }]]));
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
  }, box.options);

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

// ---------- почтовый ящик пользователя ----------

/** Экран «Почта для отправки»: что подключено и как это поменять. */
async function showMailbox(tg, chatId, user) {
  const box = mailbox.info(user.id);
  const rows = [];
  let txt = '<b>Почта для отправки</b>\n\n';
  if (box) {
    txt += `Подключён ящик <b>${esc(box.from)}</b>\n`
      + `Сервер: ${esc(box.host)}:${box.port}\n`
      + `Проверен: ${box.checkedAt ? 'да' : '<b>ещё нет</b>'}\n\n`
      + 'Счета и акты уходят клиентам с этого адреса — как будто вы отправили их сами.';
    // Сверху то, чем пользуются каждый день; настройка ящика — снизу.
    if (box.canRead) rows.push([{ text: '📥 Проверить входящие', data: 'inbox' }]);
    rows.push([{ text: '📨 Отправить проверочное письмо', data: 'mb.test' }]);
    rows.push([{ text: '🔁 Подключить другой ящик', data: 'mb.new' }]);
    rows.push([{ text: '🗑 Отключить почту', data: 'mb.del' }]);
  } else {
    txt += 'Ящик не подключён. Подключите свой — и документы будут уходить '
      + 'клиентам <b>с вашего адреса</b>.\n\n'
      + '<i>Почему со своего: письмо с чужого адреса почтовые службы кладут '
      + 'в спам, а получатель видит незнакомого отправителя и не открывает его.</i>';
    rows.push([{ text: '✉️ Подключить ящик', data: 'mb.new' }]);
  }
  rows.push([{ text: '⬅️ К организации', data: 'org' }]);
  await tg.sendMessage(chatId, txt, keyboard(rows));
}

/** Проверочное письмо самому себе: убедиться, что пароль принят. */
async function testMailbox(tg, chatId, user) {
  const box = mailbox.resolve(user.id);
  if (!box.ok) { await tg.sendMessage(chatId, esc(box.reason)); return; }
  await tg.sendChatAction(chatId, 'typing');
  const res = await mailer.sendMail({
    to: box.options.from,
    subject: 'Проверка почты — Первичка',
    text: 'Это проверочное письмо от бота «Первичка».\n\n'
      + 'Если вы его видите, отправка документов клиентам настроена верно.',
  }, box.options);
  if (!res.ok) {
    await tg.sendMessage(chatId,
      `Не получилось: ${esc(res.error)}\n\n`
      + '<i>Чаще всего дело в пароле: у Яндекса и Mail.ru нужен не обычный '
      + 'пароль от почты, а отдельный «пароль приложения».</i>',
      keyboard([[{ text: '🔁 Ввести заново', data: 'mb.new' }], [{ text: '⬅️ Назад', data: 'mb' }]]));
    return;
  }
  mailbox.markChecked(user.id);
  await tg.sendMessage(chatId,
    `✅ Письмо ушло на <b>${esc(box.options.from)}</b> — проверьте ящик.\n`
    + 'Почта настроена, документы можно отправлять клиентам.');
  await showMailbox(tg, chatId, user);
}

/**
 * Проверка входящей почты: забираем новые письма и показываем те, в которых
 * есть вложения похожие на документы.
 *
 * Письма не помечаем прочитанными и ничего не удаляем — человек по-прежнему
 * ведёт свою почту сам, а бот только подсматривает. Помечать чужие письма
 * своими действиями значит ломать чужой рабочий процесс.
 */
async function checkInbox(tg, chatId, user) {
  const conf = mailbox.resolveImap(user.id);
  if (!conf.ok) {
    await tg.sendMessage(chatId, `${esc(conf.reason)}`,
      keyboard([[{ text: '✉️ Настроить почту', data: 'mb' }], [{ text: '⬅️ Меню', data: 'menu' }]]));
    return;
  }

  await tg.sendChatAction(chatId, 'typing');
  const res = await fetchNew(conf.config, { limit: 15, unseenOnly: false, sinceDays: 14 });
  if (!res.ok) {
    await tg.sendMessage(chatId,
      `Не смог прочитать почту: ${esc(res.error)}\n\n`
      + '<i>Если пароль подошёл для отправки, но не подходит здесь — у некоторых '
      + 'провайдеров доступ по IMAP включается отдельно в настройках почты.</i>',
      keyboard([[{ text: '⬅️ Меню', data: 'menu' }]]));
    return;
  }

  // Оставляем только письма с вложениями-документами и только новые.
  const found = [];
  for (const m of res.messages) {
    if (m.uid <= conf.lastUid) continue;
    const parsed = mime.parseMessage(m.raw);
    const docs = parsed.attachments.filter(mime.looksLikeDocument);
    if (!docs.length) continue;
    const kinds = [...new Set(docs
      .map((d) => mime.documentKind(d.filename, parsed.subject))
      .filter(Boolean))].join(', ');
    found.push({ uid: m.uid, ...parsed, docs, kinds });
  }

  if (!found.length) {
    await tg.sendMessage(chatId,
      `Просмотрел ${res.messages.length} ${plural(res.messages.length, 'письмо', 'письма', 'писем')} `
      + 'за две недели — новых писем с документами не нашёл.\n\n'
      + '<i>Смотрю вложения: счета, акты, УПД, накладные, договоры — PDF, Word, Excel и сканы.</i>',
      keyboard([[{ text: '⬅️ Меню', data: 'menu' }]]));
    return;
  }

  inboxCache.set(user.id, found);
  const maxUid = Math.max(...found.map((f) => f.uid));
  mailbox.setLastUid(user.id, maxUid);

  await tg.sendMessage(chatId,
    `Нашёл ${found.length} ${plural(found.length, 'письмо', 'письма', 'писем')} с документами:`,
    keyboard([
      // В строке письма — вид документа, а не только тема: человек ищет
      // глазами «где акт», и открывать каждое письмо ради этого незачем.
      ...found.map((f, i) => [{
        text: `${f.kinds || '📎'} · ${f.fromName || f.from}`.slice(0, 60),
        data: `in.m:${i}`,
      }]),
      [{ text: '⬅️ Меню', data: 'menu' }],
    ]));
}

/** Разобранные письма держим в памяти до следующей проверки. */
const inboxCache = new Map();

/** Карточка письма: от кого, что во вложении, что с этим делать. */
async function showInboxMessage(tg, chatId, user, index) {
  const list = inboxCache.get(user.id) || [];
  const m = list[index];
  if (!m) { await tg.sendMessage(chatId, 'Письмо уже неактуально — проверьте почту заново.', mainMenu()); return; }

  const files = m.docs.map((d, i) => {
    const kind = mime.documentKind(d.filename, m.subject);
    return `${i + 1}. ${kind ? `<b>${esc(kind)}</b> — ` : ''}${esc(d.filename)}`
      + ` (${Math.round(d.size / 1024)} КБ)`;
  }).join('\n');
  const cps = bdb.listCps(user.id);
  // Пытаемся угадать контрагента по адресу отправителя или по имени.
  const guess = cps.find((c) => c.email && c.email.toLowerCase() === m.from)
    || cps.find((c) => m.fromName && c.name && m.fromName.toLowerCase().includes(c.name.toLowerCase().slice(0, 8)));

  await tg.sendMessage(chatId,
    `<b>${esc(m.fromName || m.from)}</b>\n${esc(m.from)}\n\n`
    + `<b>${esc(m.subject || 'Без темы')}</b>\n\n`
    + `Вложения:\n${files}\n\n`
    + (guess ? `Похоже на контрагента <b>${esc(guess.name)}</b>.` : 'Контрагент не опознан.'),
    keyboard([
      [{ text: '📎 Прислать вложение сюда', data: `in.f:${index}` }],
      ...(guess ? [[{ text: `💸 Внести долг перед ${guess.name}`.slice(0, 60), data: `in.op:${index}:${guess.id}` }]] : []),
      [{ text: '⬅️ К письмам', data: 'inbox' }],
    ]));
}

// ---------- подпись и печать (факсимиле) ----------

const FX_NAMES = { sign: 'подпись', stamp: 'печать' };

/** Человеческое название режима НДС организации. */
function vatLabel(org) {
  const v = bdb.vatOf(org);
  if (v.rate == null) return 'без НДС';
  return `${v.rate}%${v.rate === 0 ? '' : (v.gross ? ', цены с НДС' : ', НДС сверху')}`;
}

const BASIS_LABEL = {
  closing: 'по акту, УПД или накладной',
  invoice: 'по выставленному счёту',
  manual: 'не считать — веду журнал сам',
};

/**
 * Из чего возникает долг. Развилка не техническая, а про устройство бизнеса,
 * поэтому объясняем на примерах, а не терминами.
 */
async function showBasis(tg, chatId, user) {
  const org = bdb.getDefaultOrg(user.id);
  if (!org) { await tg.sendMessage(chatId, 'Сначала заведите организацию.', mainMenu()); return; }
  const now = bdb.basisOf(org);
  await tg.sendMessage(chatId,
    `<b>Когда контрагент становится должен</b>\n\nСейчас: <b>${esc(BASIS_LABEL[now])}</b>\n\n`
    + '<b>По акту</b> — обычный подряд и торговля: счёт это просьба заплатить, '
    + 'а долг появляется, когда работа сдана или товар отгружен.\n\n'
    + '<b>По счёту</b> — аренда и субаренда, абонентское обслуживание: акт '
    + 'каждый месяц не составляют, счёт и есть основание.\n\n'
    + '<i>Выбор один на организацию — иначе долг задвоится: сначала по счёту, '
    + 'потом по акту на ту же сделку.</i>',
    keyboard([
      [{ text: 'Долг по акту / УПД / накладной', data: 'basis.set:closing' }],
      [{ text: 'Долг по счёту (аренда)', data: 'basis.set:invoice' }],
      [{ text: 'Не считать автоматически', data: 'basis.set:manual' }],
      [{ text: '🤔 Не знаю — подберите по моему делу', data: 'biz' }],
      [{ text: '⬅️ К организации', data: 'org' }],
    ]));
}

// ---------- свободный ввод ----------

/**
 * Последняя попытка понять фразу, когда ни один разбор не сработал.
 *
 * Документ отсюда не выписывается никогда: в лучшем случае открывается
 * обычный мастер с заполненными позициями, и человек нажимает ту же кнопку,
 * что и всегда. Номера документов идут сквозным рядом — лишний счёт нельзя
 * тихо удалить, дыру в нумерации придётся объяснять при проверке.
 *
 * @returns {Promise<boolean>} true — ответили, меню показывать не надо
 */
async function handleFreeText(tg, chatId, user, text) {
  const intent = await ai.understand(text, user.id);

  if (intent.action === 'debts') { await showDebts(tg, chatId, user); return true; }
  if (intent.action === 'unpaid') { await showUnpaid(tg, chatId, user); return true; }
  if (intent.action === 'docs') { await showDocs(tg, chatId, user); return true; }
  if (intent.action === 'cps') { await showCps(tg, chatId, user); return true; }
  if (intent.action === 'org') { await showOrg(tg, chatId, user); return true; }
  if (intent.action === 'recurring') { await showRecurring(tg, chatId, user); return true; }
  if (intent.action === 'billing') { await showBilling(tg, chatId, user); return true; }
  if (intent.action === 'help') return false;      // помощь и так в меню

  // Акт сверки собирается по конкретному контрагенту — спрашиваем, по кому.
  if (intent.action === 'akt') {
    const cps = bdb.listCps(user.id);
    if (!cps.length) {
      await tg.sendMessage(chatId, 'Сверяться пока не с кем — сначала добавьте контрагента.',
        keyboard([[{ text: '👤 Добавить клиента', data: 'cp.new' }], [{ text: '⬅️ Меню', data: 'menu' }]]));
      return true;
    }
    const found = ai.matchCp(cps, intent.who || '');
    if (found.cp) { await askAktPeriod(tg, chatId, user, found.cp.id); return true; }
    await tg.sendMessage(chatId, 'С кем сверяемся?',
      keyboard([...cps.slice(0, 8).map((c) => ([{ text: c.name.slice(0, 60), data: `d.akt:${c.id}` }])),
        [{ text: '⬅️ Меню', data: 'menu' }]]));
    return true;
  }

  /*
   * Чужая работа. Налоговый учёт обязателен независимо от режима, и у
   * предпринимателя к нему масса вопросов — но бот не видит ни банка, ни
   * кассы, ни расходов. Совет по срокам и суммам, выданный по памяти,
   * стоит человеку денег и штрафов, поэтому здесь мы честно отказываемся
   * и говорим, что умеем вместо этого.
   */
  if (intent.action === 'outofscope') {
    await tg.sendMessage(chatId,
      'Налоги, взносы, КУДиР, отчётность и зарплату я не веду — для этого нужен доступ '
      + 'к вашему банку и кассе, а у меня его нет. Подскажу неверно — вам платить штраф.\n\n'
      + 'Что я умею: выписывать счета, акты, УПД, накладные, договоры и платёжки, вести '
      + 'расчёты с контрагентами и собирать акт сверки.',
      mainMenu());
    return true;
  }

  if (intent.action === 'draft') {
    const cps = bdb.listCps(user.id);
    if (!cps.length) {
      await tg.sendMessage(chatId, 'Сначала добавьте клиента — потом выпишем документ.',
        keyboard([[{ text: '👤 Добавить клиента', data: 'cp.new' }], [{ text: '⬅️ Меню', data: 'menu' }]]));
      return true;
    }
    const found = ai.matchCp(cps, intent.who);
    if (found.choices) {
      await tg.sendMessage(chatId, `Кого именно вы имели в виду — «${esc(intent.who)}»?`,
        keyboard([...found.choices.map((c) => ([{ text: c.name.slice(0, 60), data: `d.${intent.docType}:${c.id}` }])),
          [{ text: '⬅️ Меню', data: 'menu' }]]));
      return true;
    }
    if (!found.cp) {
      // Имя не опознано — не угадываем, а показываем список: выписать
      // документ не тому клиенту хуже, чем лишнее нажатие.
      await startDoc(tg, chatId, user, intent.docType);
      return true;
    }

    await startItems(tg, chatId, user, intent.docType, found.cp.id);
    const items = docService.cleanItems(intent.items || []);
    if (items.length) {
      const st = bdb.getState(user.id);
      if (st.state.startsWith('items:')) {
        st.data.items = items;
        bdb.setState(user.id, st.state, st.data);
        await tg.sendMessage(chatId,
          `Записал со слов:\n${items.map((it) => `• ${esc(it.name)} — ${it.qty} × ${formatRub(it.price)}`).join('\n')}`
          + '\n\n<i>Проверьте: добавьте ещё позиции или нажмите «Готово».</i>');
      }
    }
    return true;
  }

  if (intent.source === 'limit') {
    await tg.sendMessage(chatId,
      'Разбор фраз на этот месяц исчерпан — понимаю пока только команды и кнопки.\n\n'
      + '<i>Операция вносится текстом: <code>15.06 приход 94193</code>.</i>');
    return true;
  }
  return false;
}

// ---------- регулярные документы ----------

/**
 * Список повторений. Здесь их можно только посмотреть и выключить:
 * заводятся они сразу после выписанного документа, где позиции уже готовы.
 */
async function showRecurring(tg, chatId, user) {
  const list = recurring.list(user.id);
  if (!list.length) {
    await tg.sendMessage(chatId,
      '<b>Регулярные документы</b>\n\n'
      + 'Пока ничего не повторяется.\n\n'
      + 'Выпишите счёт или акт и нажмите «🔁 Повторять каждый месяц» — '
      + 'в нужный день я напомню и предложу выписать такой же.', mainMenu());
    return;
  }
  const rows = list.map((r) => ([{
    text: `✖️ ${docService.ITEM_DOCS[r.type] ? docService.ITEM_DOCS[r.type].title : r.type} · ${r.cp_name}`.slice(0, 60),
    data: `rec.off:${r.id}`,
  }]));
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  await tg.sendMessage(chatId,
    '<b>Регулярные документы</b>\n\n'
    + list.map((r) => {
      const title = docService.ITEM_DOCS[r.type] ? docService.ITEM_DOCS[r.type].title : r.type;
      const sum = r.items.reduce((a, it) => a + round2((Number(it.qty) || 0) * (Number(it.price) || 0)), 0);
      return `• <b>${esc(title)}</b> для ${esc(r.cp_name)} — ${formatRub(sum)}, ${r.dayText}`;
    }).join('\n')
    + '\n\n<i>Ничего не выписывается само: в нужный день я пришлю предложение '
    + 'с кнопкой. Нажмите на строку ниже, чтобы перестать напоминать.</i>',
    keyboard(rows));
}

/** Предложение выписать очередной документ. Отправляется раз в месяц. */
async function offerRecurring(tg, rec) {
  const user = bdb.userById(rec.user_id);
  if (!user || user.blocked_at) return false;
  const kind = docService.ITEM_DOCS[rec.type];
  if (!kind) return false;
  const sum = rec.items.reduce((a, it) => a + round2((Number(it.qty) || 0) * (Number(it.price) || 0)), 0);

  await tg.sendMessage(user.tg_id,
    `🔁 <b>Пора выставить: ${esc(kind.title)}</b>\n\n`
    + `Клиент: <b>${esc(rec.cp_name)}</b>\n`
    + `Сумма: <b>${formatRub(sum)}</b>\n`
    + `${rec.items.slice(0, 5).map((it) => `• ${esc(it.name)} — ${it.qty} × ${formatRub(it.price)}`).join('\n')}`
    + (rec.items.length > 5 ? `\n…и ещё ${rec.items.length - 5}` : ''),
    keyboard([
      [{ text: '✅ Выписать', data: `rec.go:${rec.id}` }],
      [{ text: '⏭ Пропустить месяц', data: `rec.skip:${rec.id}` }],
      [{ text: '✖️ Больше не напоминать', data: `rec.off:${rec.id}` }],
    ]));
  return true;
}

/**
 * Ежедневная проверка повторений.
 *
 * Отметку «предложено» ставим сразу после отправки, а не после ответа:
 * иначе бот пришёл бы с тем же предложением и завтра, и послезавтра, пока
 * человек не нажмёт кнопку.
 */
async function runDaily(tg) {
  let sent = 0;
  for (const rec of recurring.due()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await offerRecurring(tg, rec)) sent += 1;
      recurring.markOffered(rec.id);
    } catch (e) {
      console.error('регулярные документы:', e.message);
    }
  }
  for (const rec of recurring.overdue()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await warnOverdue(tg, rec)) sent += 1;
      recurring.markDueNoticed(rec.id);
    } catch (e) {
      console.error('просрочка:', e.message);
    }
  }
  if (sent) console.log(`Ежедневные дела: отправлено сообщений — ${sent}`);
  return sent;
}

/** Завести повторение по уже выписанному документу и рассказать, что будет. */
async function addRecurring(tg, chatId, user, src, when) {
  const { items = [], ...extra } = src.payload || {};
  const id = recurring.add(user.id, {
    cpId: src.cp_id, type: src.type, items, extra, ...when,
  });
  const rec = recurring.get(user.id, id);
  const title = docService.ITEM_DOCS[src.type].title;

  // Показываем весь цикл, а не только ближайшее действие: человек должен
  // понимать, за чем бот теперь следит, иначе напоминание о просрочке
  // придёт неожиданно и будет выглядеть ошибкой.
  const plan = [`• ${rec.offerDay}-го — предложу выписать «${esc(title)}»`];
  if (rec.pay_day) {
    plan.push(`• ${rec.pay_day}-го — срок оплаты по договору`);
    plan.push(`• ${rec.pay_day + 1}-го — напомню, если оплата не отмечена`);
  }

  await tg.sendMessage(chatId,
    `✅ Настроил для <b>${esc(rec.cp_name)}</b>:\n\n${plan.join('\n')}\n\n`
    + '<i>Сам ничего не выпишу и клиенту не напишу — пришлю предложение с кнопкой. '
    + 'За этот месяц документ уже выписан, так что начну со следующего.</i>',
    keyboard([
      ...(src.type !== 'usl'
        ? [[{ text: '➕ Ещё и акт в конце месяца', data: `rec.akt:${src.cp_id}` }]] : []),
      [{ text: '🔁 Все повторения', data: 'rec' }],
      [{ text: '⬅️ Меню', data: 'menu' }],
    ]));
}

/**
 * Первый день просрочки.
 *
 * Сообщаем владельцу, а не контрагенту. Письмо клиенту с требованием
 * заплатить — разговор, который человек ведёт сам: тон, отсрочка,
 * договорённость по телефону боту неизвестны, а испорченные отношения с
 * арендатором стоят дороже, чем несколько нажатий. Поэтому здесь готовый
 * текст и кнопка отправки, а не автоматическая рассылка.
 */
async function warnOverdue(tg, rec) {
  const user = bdb.userById(rec.user_id);
  if (!user || user.blocked_at) return false;

  // Счёт этого месяца этому контрагенту, по которому нет отметки об оплате.
  const month = recurring.monthKey();
  const unpaid = bdb.unpaidDocs(user.id, 200)
    .filter((d) => d.cp_id === rec.cp_id && String(d.date).startsWith(month));
  if (!unpaid.length) return false;              // оплачено или счёта не было

  const sum = bdb.dealTotals(unpaid).sum;
  const list = unpaid.slice(0, 5)
    .map((d) => `• ${esc(d.title)} № ${esc(d.number)} от ${ru(d.date)} — ${formatRub(d.total)}`);

  await tg.sendMessage(user.tg_id,
    `⏰ <b>Просрочка: ${esc(rec.cp_name)}</b>\n\n`
    + `Срок оплаты был ${ru(recurring.dueDate(rec))}, деньги не отмечены.\n`
    + `Не оплачено: <b>${formatRub(sum)}</b>\n${list.join('\n')}\n\n`
    + '<i>Если оплата пришла — отметьте её, и напоминание исчезнет.</i>',
    keyboard([
      [{ text: '✉️ Текст напоминания', data: 'debt.remind' }],
      [{ text: '✅ Оплата пришла', data: `doc.paid:${unpaid[0].id}` }],
      [{ text: '👤 Карточка клиента', data: `cp:${rec.cp_id}` }],
    ]));
  return true;
}

/**
 * «Чем занимаетесь» вместо «откуда берётся долг».
 *
 * Из всех настроек основание долга — единственная, в которой новичок
 * гарантированно теряется: вопрос бухгалтерский, а человек пришёл выставить
 * счёт. На вопрос о своём деле он отвечает не задумываясь, а правило
 * выводится само.
 */
async function showBizType(tg, chatId, user) {
  const org = bdb.getDefaultOrg(user.id);
  if (!org) { await tg.sendMessage(chatId, 'Сначала заведите организацию.', mainMenu()); return; }
  await tg.sendMessage(chatId,
    '<b>Чем занимаетесь?</b>\n\n'
    + '<i>По ответу подберу, когда клиент становится должен, — этот вопрос '
    + 'больше задавать не буду.</i>',
    keyboard([
      ...bizTypes.list().map((t) => ([{ text: `${t.name} — ${t.hint}`, data: `biz.set:${t.key}` }])),
      [{ text: '⬅️ К организации', data: 'org' }],
    ]));
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
    /*
     * Снимок с телефона, отправленный файлом, Telegram не сжимает — и в
     * предел не влезает. Отправленный как фото, сжимается им самим. Разница
     * невидима: в меню вложений это соседние пункты, и человек не знает,
     * что выбрал не тот. Поэтому подсказываем, а не сообщаем о неудаче.
     */
    const big = /слишком большой/i.test(e.message || '');
    await tg.sendMessage(chatId, big
      ? `Файл больше ${Math.round(facsimile.MAX_BYTES / 1024)} КБ.\n\n`
        + 'Отправьте тот же снимок <b>фотографией</b>, а не файлом: Telegram сожмёт '
        + 'его сам, и качества для печати хватит.'
      : `Не смог забрать файл: ${esc(e.message)}`);
    return;
  }

  const res = facsimile.save(user.id, kind, buf, mime);
  if (!res.ok) {
    await tg.sendMessage(chatId, `${esc(res.error)}\n\n`
      + 'Проще всего — отправить снимок фотографией, а не файлом: Telegram сожмёт его сам.');
    return;
  }
  bdb.clearState(user.id);
  await tg.sendMessage(chatId,
    `Сохранил ${FX_NAMES[kind]}. Проверьте на документе: выпишите счёт — `
    + 'если легло криво или бледно, пришлите снимок получше.');
  await showFacsimile(tg, chatId, user);
}

// ---------- банковская выписка, присланная файлом ----------

/**
 * Похоже ли вложение на выписку.
 *
 * Смотрим на имя, а не на mime: Telegram отдаёт для выгрузок из банка то
 * text/plain, то application/octet-stream, то вовсе ничего.
 */
const STATEMENT_FILE = /\.(csv|txt|ofx|qfx)$/i;

/**
 * Разбор выписки прямо в чате.
 *
 * В чате занести можно только уверенные совпадения — те, где сошёлся ИНН
 * или точное название вместе с точной суммой долга. Остальное отправляем в
 * приложение: перебирать десяток платежей кнопками мучительно, а угадывать
 * за человека нельзя.
 */
async function handleStatement(tg, chatId, user, msg) {
  const doc = msg.document;
  if (doc.file_size > 2 * 1024 * 1024) {
    await tg.sendMessage(chatId, 'Файл больше 2 МБ — выгрузите выписку за месяц, а не за год.');
    return;
  }
  await tg.sendChatAction(chatId, 'typing');

  const buf = await tg.downloadFile(doc.file_id, 2 * 1024 * 1024);
  const org = bdb.getDefaultOrg(user.id);
  const { format, rows } = bank.parseStatement(buf, { ownAccounts: [org && org.acc].filter(Boolean) });
  if (!rows.length) {
    await tg.sendMessage(chatId,
      'Не нашёл в файле ни одной операции.\n\n'
      + 'Подойдёт выгрузка «1С Клиент-Банк», OFX или CSV, где есть колонки с датой и суммой. '
      + 'В интернет-банке это обычно «Экспорт» → «1С».', mainMenu());
    return;
  }

  const cps = bdb.listCps(user.id);
  const debt = new Map();
  for (const cp of cps) {
    const b = bdb.balanceOf(user.id, cp.id);
    debt.set(cp.id, b ? b.closing : 0);
  }
  const matched = bank.matchToCounterparties(rows, cps, (id) => debt.get(id) || 0);
  const known = bdb.knownBankKeys(user.id, matched.map((t) => t.key));
  const fresh = matched.filter((t) => !known.has(t.key));
  const sure = fresh.filter((t) => t.cp && t.confidence >= 60);

  const lines = [`Выписка ${format}: строк ${rows.length}, поступлений ${matched.length}.`];
  if (matched.length !== fresh.length) {
    lines.push(`Уже занесено раньше: ${matched.length - fresh.length}.`);
  }
  if (!fresh.length) {
    lines.push('', 'Новых поступлений нет — повторно они не пройдут.');
    await tg.sendMessage(chatId, lines.join('\n'), mainMenu());
    return;
  }

  if (sure.length) {
    lines.push('', `<b>Узнал уверенно (${sure.length}):</b>`);
    for (const t of sure.slice(0, 15)) {
      lines.push(`• ${ru(t.date)} — ${esc(t.cp.name)} — <b>${formatRub(t.amount)}</b>`);
    }
    if (sure.length > 15) lines.push(`…и ещё ${sure.length - 15}`);
  }
  const rest = fresh.length - sure.length;
  if (rest) {
    lines.push('', `Ещё ${rest} ${plural(rest, 'поступление', 'поступления', 'поступлений')} `
      + 'не удалось привязать к клиенту наверняка — это видно в приложении.');
  }
  // Спорные называем поимённо: «не привязалось» без причины выглядит как
  // недоработка, а тут причина понятная и человеку решать её секунду.
  const doubtful = fresh.filter((t) => t.ambiguous);
  if (doubtful.length) {
    lines.push('', `Из них ${doubtful.length} совпало сразу с двумя клиентами:`);
    for (const t of doubtful.slice(0, 5)) {
      lines.push(`• ${ru(t.date)} · ${formatRub(t.amount)} — ${esc(t.rivals.join(' или '))}`);
    }
    lines.push('<i>Выберите нужного в приложении — сам не угадываю.</i>');
  }

  // Строки кладём в состояние: кнопка нажимается позже, а файла к тому
  // времени уже нет.
  bdb.setState(user.id, 'bank', {
    rows: sure.map((t) => ({ key: t.key, cpId: t.cp.id, amount: t.amount, date: t.date, doc: t.doc })),
  });

  const app = webAppUrl();
  await tg.sendMessage(chatId, lines.join('\n'), keyboard([
    ...(sure.length ? [[{ text: `✅ Занести ${sure.length} ${plural(sure.length, 'оплату', 'оплаты', 'оплат')}`, data: 'bank:take' }]] : []),
    ...(app ? [[{ text: '📱 Разобрать в приложении', webApp: app }]] : []),
    [{ text: '⬅️ Меню', data: 'menu' }],
  ]));
}

/**
 * Голосовое сообщение.
 *
 * Расшифровка — не действие, а всего лишь ввод: дальше фраза идёт ровно тем
 * же путём, что и напечатанная. Поэтому распознанное сначала показываем, и
 * только потом отвечаем: человек должен увидеть, что бот услышал, прежде
 * чем тот начнёт заполнять счёт. Расслышать «Заре» как «Заре-Строй» дороже,
 * чем лишняя строка в переписке.
 */
async function handleVoice(tg, chatId, user, msg) {
  if (!speech.speechAvailable()) {
    await tg.sendMessage(chatId,
      'Голосовые я пока не разбираю — нужен внешний сервис распознавания речи.\n'
      + `<i>${esc(speech.speechHint())}</i>\n\n`
      + 'Напишите то же самое текстом — пойму так же.', mainMenu());
    return;
  }

  const src = msg.voice || msg.audio || msg.video_note || {};
  if (!src.file_id) return;
  // Потолок Telegram на скачивание ботом — 20 МБ, выше него файла не будет.
  const buf = await tg.downloadFile(src.file_id, 20 * 1024 * 1024).catch(() => null);
  if (!buf) {
    await tg.sendMessage(chatId, 'Не смог забрать запись из Telegram. Попробуйте ещё раз.', mainMenu());
    return;
  }

  await tg.sendMessage(chatId, '🎧 Слушаю…');
  const got = await speech.transcribe(buf, Number(src.duration) || 0);
  if (!got.ok) {
    await tg.sendMessage(chatId, `Не разобрал запись: ${esc(got.error)}`, mainMenu());
    return;
  }

  await tg.sendMessage(chatId, `Услышал: «${esc(got.text)}»`);
  const answered = await handleFreeText(tg, chatId, user, got.text);
  if (!answered) {
    await tg.sendMessage(chatId,
      'Не понял, что с этим сделать. Скажите иначе — например: «выставь счёт Заре на 30 тысяч» '
      + 'или «кто мне должен».', mainMenu());
  }
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
    'Готово. Перешлите файлы должникам — или отправьте письмом из «Текста напоминания»: '
    + 'акт сверки уйдёт вложением.',
    keyboard([[{ text: '✉️ Текст напоминания', data: 'debt.remind' }],
      [{ text: '⬅️ Меню', data: 'menu' }]]));
}

/** Текст напоминания: и для копирования, и для письма — один и тот же. */
function reminderText(org, r) {
  const bank = org && org.acc
    ? `\n\nРеквизиты для оплаты:\n${org.bank_name || ''}\nБИК ${org.bik || '—'}\nР/с ${org.acc}`
    : '';
  return 'Здравствуйте!\n\n'
    + `По нашим данным на ${ru(todayISO())} за вами числится задолженность `
    + `${formatRub(r.amount).replace(/ /g, ' ').replace(/\sруб\.$/, ' руб')}`
    + `${r.cp.contract ? ` по ${r.cp.contract}` : ''}.\n\n`
    + 'Направляем акт сверки. Просим подтвердить сумму и сообщить срок оплаты. '
    + 'Если платёж уже прошёл — пришлите, пожалуйста, платёжное поручение.'
    + `${bank}\n\nС уважением,\n${(org && (org.full_name || org.name)) || ''}`;
}

/**
 * Напоминания должникам.
 *
 * Кнопка отправки появляется, если подключён свой ящик. Раньше здесь был
 * только текст «скопируйте и отправьте сами» — и это не сходилось с
 * остальным: счёт тому же клиенту уходит с того же ящика по кнопке.
 * Разницы между ними нет, в обоих случаях письмо отправляет человек,
 * увидев текст. Чего по-прежнему не бывает — писем без нажатия.
 */
async function debtReminder(tg, chatId, user) {
  const org = bdb.getDefaultOrg(user.id);
  const rows = bdb.debtors(user.id).filter((r) => r.theyOwe);
  if (!rows.length) { await tg.sendMessage(chatId, 'Должников нет.', mainMenu()); return; }
  const canMail = mailbox.has(user.id);
  await tg.sendMessage(chatId, canMail
    ? 'Тексты ниже. Отправлю письмом с актом сверки по кнопке — или скопируйте '
      + 'и отправьте как удобно.'
    : 'Тексты ниже — скопируйте и отправьте каждому.\n\n'
      + '<i>Подключите свою почту, и я смогу отправлять их письмом отсюда.</i>');

  for (const r of rows.slice(0, 10)) {
    const kb = [];
    if (canMail) {
      kb.push([r.cp.email
        ? { text: `✉️ Отправить на ${r.cp.email}`.slice(0, 60), data: `rm.mail:${r.cp.id}` }
        : { text: '✉️ Указать почту и отправить', data: `rm.ask:${r.cp.id}` }]);
    }
    await tg.sendMessage(chatId, `<code>${esc(reminderText(org, r))}</code>`,
      kb.length ? keyboard(kb) : undefined);
  }
}

/** Отправить напоминание должнику письмом — с актом сверки во вложении. */
async function sendReminderMail(tg, chatId, user, cpId, email) {
  const box = mailbox.resolve(user.id);
  if (!box.ok) { await tg.sendMessage(chatId, esc(box.reason), mainMenu()); return; }
  const cp = bdb.getCp(user.id, cpId);
  if (!cp) { await tg.sendMessage(chatId, 'Контрагент не найден.', mainMenu()); return; }
  const to = String(email || cp.email || '').trim();
  if (!mailer.validEmail(to)) {
    await tg.sendMessage(chatId, 'Адрес почты выглядит неправильно.', mainMenu());
    return;
  }
  const row = bdb.debtors(user.id).find((d) => d.cp.id === cpId);
  if (!row) { await tg.sendMessage(chatId, 'Долга за этим клиентом нет.', mainMenu()); return; }
  const org = bdb.getDefaultOrg(user.id) || {};

  await tg.sendChatAction(chatId, 'typing');
  /*
   * Акт прикладываем: в тексте прямо написано «направляем акт сверки», и
   * письмо без вложения этому противоречит. Не собрался — отправляем без
   * него, а не молчим: напоминание важнее приложения к нему.
   */
  const attachments = [];
  try {
    if (!cp.period_end) {
      bdb.updateCp(user.id, cp.id, { period_end: todayISO() });
      cp.period_end = todayISO();
    }
    const buf = await buildAkt({
      org: { brand: org.name, org_short: org.name, org_full: org.full_name || org.name,
        org_inn: org.inn, signer: org.signer },
      cp,
      ops: bdb.listOps(user.id, cp.id),
    });
    attachments.push({
      filename: `Акт_сверки_${docService.safeName(cp.name)}.xlsx`,
      content: Buffer.from(buf),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  } catch (e) {
    console.error('акт сверки к напоминанию:', e.message);
  }

  const res = await mailer.sendMail({
    to,
    subject: `Задолженность по расчётам${org.name ? ` — ${org.name}` : ''}`,
    text: reminderText(org, row),
    attachments,
  }, box.options);
  if (!res.ok) {
    await tg.sendMessage(chatId, `Не отправилось: ${esc(res.error)}`, mainMenu());
    return;
  }
  if (to !== cp.email) bdb.updateCp(user.id, cp.id, { email: to });
  await tg.sendMessage(chatId,
    `✅ Отправлено на <b>${esc(to)}</b>${attachments.length ? ' вместе с актом сверки' : ''}.`,
    mainMenu());
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
  const seq = bdb.nextSeq(user.id, 'dog', currentYear());
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
  const seq = bdb.nextSeq(user.id, 'pp', currentYear());
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
    caption: `Платёжное поручение № ${esc(doc.number)} получателю <b>${esc(cp.name)}</b> на ${formatRub(doc.amount)}`,
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

/**
 * Проводник «выписать документ».
 *
 * Главный экран продукта. Человек приходит выставить счёт, а не изучать
 * разделы: до этой кнопки, чтобы добраться до счёта, нужно было догадаться,
 * что документы живут внутри карточки контрагента — сначала завести
 * организацию, потом контрагента, потом найти его в списке. Кто не работал
 * в 1С, не догадывался и уходил.
 *
 * Здесь наоборот: жмём «Выписать счёт», а недостающее спрашиваем по дороге
 * и сразу возвращаемся к начатому делу.
 */
async function startDoc(tg, chatId, user, type) {
  const org = bdb.getDefaultOrg(user.id);
  if (!org || !org.name) {
    // Реквизиты нужны не «для порядка», а чтобы клиенту было куда платить, —
    // так и объясняем, иначе форма выглядит бюрократией на ровном месте.
    bdb.setState(user.id, 'form:orgq', { i: 0, values: { __then: type } });
    await tg.sendMessage(chatId,
      'Сначала пара слов о вас — это один раз, дальше не спрошу.\n\n'
      + '<i>Ваше название и счёт печатаются в документе: без них клиенту некуда платить.</i>');
    await askStep(tg, chatId, 'orgq', 0);
    return;
  }

  const cps = bdb.listCps(user.id);
  if (!cps.length) {
    bdb.setState(user.id, 'form:cpq', { i: 0, values: { __then: type } });
    await tg.sendMessage(chatId, 'Кому выставляем? Добавим первого клиента.');
    await askStep(tg, chatId, 'cpq', 0);
    return;
  }

  const rows = cps.slice(0, 12).map((c) => [{ text: `${c.kind === 'supplier' ? '📦' : '🧑‍💼'} ${c.name}`, data: `d.${type}:${c.id}` }]);
  rows.push([{ text: '➕ Новый клиент', data: `cp.new.${type}` }]);
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  await tg.sendMessage(chatId,
    `<b>${esc((ITEM_DOCS[type] || {}).title || 'Документ')}</b>\nКому выписываем?`, keyboard(rows));
}

/** Выбор вида документа, когда нужен не счёт. */
async function chooseDoc(tg, chatId, user) {
  bdb.clearState(user.id);
  const rows = [
    [{ text: '🧾 Счёт на оплату', data: 'go.sch' }, { text: '📝 Счёт-договор', data: 'go.schdog' }],
    [{ text: '🧾 Акт услуг', data: 'go.usl' }, { text: '📦 УПД', data: 'go.upd' }],
    [{ text: '🚚 ТОРГ-12', data: 'go.torg12' }],
    [{ text: '⬅️ Меню', data: 'menu' }],
  ];
  await tg.sendMessage(chatId,
    '<b>Какой документ нужен?</b>\n\n'
    + '<i>Счёт — попросить оплату. Акт — подтвердить, что услуга оказана. '
    + 'УПД и ТОРГ-12 — передать товар. Счёт-договор — счёт, который заменяет договор.</i>',
    keyboard(rows));
}

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
    [{ text: `📊 Долг: ${BASIS_LABEL[bdb.basisOf(org)]}`.slice(0, 60), data: 'basis' }],
    [{ text: mailbox.has(user.id) ? '✉️ Почта: подключена' : '✉️ Подключить почту', data: 'mb' }],
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
  if (msg.document && STATEMENT_FILE.test(msg.document.file_name || '')) {
    const from = msg.from || {};
    const user = bdb.getOrCreateUser(from.id, [from.first_name, from.last_name].filter(Boolean).join(' '), from.username || '');
    bdb.markActive(user.id);
    return handleStatement(tg, msg.chat.id, user, msg);
  }
  if (msg.voice || msg.audio || msg.video_note) {
    const from = msg.from || {};
    const user = bdb.getOrCreateUser(from.id, [from.first_name, from.last_name].filter(Boolean).join(' '), from.username || '');
    bdb.markActive(user.id);
    return handleVoice(tg, msg.chat.id, user, msg);
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
  // Свой номер нужен, чтобы владелец выдал доступ: имя в Telegram есть не у
  // всех и меняется, номер — нет.
  if (text === '/id') {
    await tg.sendMessage(chatId, `Ваш номер: <code>${user.tg_id}</code>\n\n`
      + '<i>Нажмите на номер, чтобы скопировать, и пришлите его в поддержку.</i>');
    return;
  }
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
  // Код можно просто прислать сообщением, без захода в меню, — но только
  // когда человек не заполняет форму: там «PRV-…» может оказаться названием.
  if (!state.state && billing.looksLikeCode(text)) {
    await redeemPromo(tg, chatId, user, text);
    return;
  }
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
        t ? `Добавлено: ${esc(t.name)} — ${qty} ${esc(t.unit || 'шт.')} × ${formatRub(t.price)}` : 'Шаблон не найден.',
        itemsKb(user, d));
      return;
    }

    // Дозапрос по начатой позиции: название уже знаем, ждём количество и цену.
    if (d.ask === 'np') {
      const p = d.pending || {};
      const reply = text.replace(/\s*[x×хX*]\s*(?=\d)/g, ';').replace(/\s+по\s+(?=\d)/gi, ';');
      const loose = numbersIn(reply, false);   // «2 4500» — два числа
      const tight = numbersIn(reply, true);    // «30 000» — одно число
      const unit = unitAfter(reply, ((loose[0] || {}).end) || 0);
      if (unit) p.unit = unit;

      if (p.qty != null) {
        // Количество уже знаем — значит это цена, и «30 000» здесь тридцать
        // тысяч, а не тридцать и ноль.
        if (tight.length) p.price = tight[tight.length - 1].value;
      } else if (loose.length >= 2 && loose[loose.length - 1].value > 0) {
        [p.qty, p.price] = [loose[0].value, loose[loose.length - 1].value];
      } else if (tight.length === 1) {
        p.qty = tight[0].value;
      }

      if (p.qty == null || p.qty <= 0) {
        d.pending = p; bdb.setState(user.id, state.state, d);
        await tg.sendMessage(chatId, 'Нужно количество числом. Например: <code>1</code> или <code>20 шт</code>');
        return;
      }
      if (p.price == null) {
        d.pending = p; bdb.setState(user.id, state.state, d);
        await tg.sendMessage(chatId,
          `<b>${esc(p.name)}</b> — ${p.qty} ${esc(p.unit || 'шт.')}\nПо какой цене за единицу?`);
        return;
      }
      d.items.push({ name: p.name, qty: p.qty, unit: p.unit || 'шт.', price: p.price });
      d.ask = ''; d.pending = null;
      bdb.setState(user.id, state.state, d);
      await tg.sendMessage(chatId,
        `Добавлено: ${esc(p.name)} — ${p.qty} ${esc(p.unit || 'шт.')} × ${formatRub(p.price)}\nЕщё позицию или «Готово».`,
        itemsKb(user, d));
      return;
    }

    const item = readItemLine(text);
    // Не поняли количество и цену — не отказываем, а спрашиваем. Человек
    // пишет позицию так, как говорит; подстраиваться должны мы.
    if (!item || item.partial) {
      if (!item) { await tg.sendMessage(chatId, 'Не разобрал — напишите наименование позиции.'); return; }
      d.ask = 'np'; d.pending = { name: item.name, qty: null, price: null, unit: null };
      bdb.setState(user.id, state.state, d);
      await tg.sendMessage(chatId,
        `<b>${esc(item.name)}</b>\nСколько и по какой цене?\n\n`
        + '<i>Можно одним сообщением: <code>1 30000</code>. Или сначала количество.</i>');
      return;
    }
    d.items.push(item);
    bdb.setState(user.id, state.state, d);
    await tg.sendMessage(chatId,
      `Добавлено: ${esc(item.name)} — ${item.qty} ${esc(item.unit)} × ${formatRub(item.price)}\nЕщё позицию или «Готово».`,
      itemsKb(user, d));
    return;
  }
  if (state.state.startsWith('pp:')) { await handlePpText(tg, chatId, user, state, text); return; }
  if (state.state.startsWith('dog:')) { await handleDogText(tg, chatId, user, state, text); return; }
  if (state.state === 'support') { await handleSupportText(tg, chatId, user, text); return; }
  if (state.state.startsWith('rm:')) {
    const cpId = Number(state.state.slice(3));
    bdb.clearState(user.id);
    await sendReminderMail(tg, chatId, user, cpId, text.trim());
    return;
  }
  if (state.state.startsWith('aktp:')) {
    await handleAktPeriodText(tg, chatId, user, Number(state.state.slice(5)), text);
    return;
  }
  if (state.state === 'claim') { await claimByEmail(tg, chatId, user, text); return; }
  if (state.state === 'promo') { await redeemPromo(tg, chatId, user, text); return; }
  if (state.state === 'mb:email') {
    const addr = text.trim().toLowerCase();
    if (!mailer.validEmail(addr)) {
      await tg.sendMessage(chatId, 'Это не похоже на адрес почты. Напишите ещё раз:');
      return;
    }
    const preset = mailbox.guessPreset(addr);
    const p = mailbox.PRESETS[preset];
    // У своего домена сервер известен только клиенту — без этого шага
    // подключить корпоративную почту было бы нельзя вовсе.
    if (preset === 'custom') {
      bdb.setState(user.id, 'mb:host', { email: addr, preset });
      await tg.sendMessage(chatId,
        `Почта <b>${esc(addr)}</b> — сервис незнакомый, нужен адрес его SMTP-сервера.\n\n`
        + 'Пришлите его в виде <code>smtp.вашдомен.ру</code> или '
        + '<code>smtp.вашдомен.ру:587</code>, если порт нестандартный.\n'
        + '<i>Адрес есть в справке вашего почтового провайдера, раздел «настройка почтовых программ».</i>',
        keyboard([[{ text: '✖️ Отмена', data: 'mb' }]]));
      return;
    }
    bdb.setState(user.id, 'mb:pass', { email: addr, preset });
    // Ссылка кнопкой: описание меню («Безопасность → Пароли приложений»)
    // устаревает раньше, чем мы успеваем выпустить обновление.
    const rows = [];
    if (p.passUrl) rows.push([{ text: '🔑 Открыть страницу пароля', url: p.passUrl }]);
    rows.push([{ text: '✖️ Отмена', data: 'mb' }]);
    await tg.sendMessage(chatId,
      `Почта <b>${esc(addr)}</b> — похоже на <b>${esc(p.title)}</b>.\n\n`
      + `${esc(p.hint)}\n\n`
      + 'Пришлите пароль сюда одним сообщением. Он хранится в зашифрованном виде и '
      + 'нигде не показывается; сразу после сохранения удалите своё сообщение с паролем из чата.',
      keyboard(rows));
    return;
  }
  if (state.state === 'mb:host') {
    const m = /^([a-z0-9.-]+)(?::(\d{2,5}))?$/i.exec(text.trim());
    if (!m) {
      await tg.sendMessage(chatId, 'Не разобрал адрес сервера. Пример: <code>smtp.вашдомен.ру:465</code>');
      return;
    }
    const port = Number(m[2] || 465);
    bdb.setState(user.id, 'mb:pass', {
      ...state.data, host: m[1], port, secure: port === 465,
    });
    await tg.sendMessage(chatId,
      `Сервер <b>${esc(m[1])}:${port}</b>. Теперь пришлите пароль от ящика.\n\n`
      + 'Он хранится в зашифрованном виде и нигде не показывается; '
      + 'сразу после сохранения удалите своё сообщение с паролем из чата.',
      keyboard([[{ text: '✖️ Отмена', data: 'mb' }]]));
    return;
  }
  if (state.state === 'mb:pass') {
    const { email, preset, host, port, secure } = state.data;
    const saved = mailbox.save(user.id, {
      preset, login: email, pass: text, from: email, host, port, secure,
    });
    bdb.clearState(user.id);
    if (!saved.ok) { await tg.sendMessage(chatId, esc(saved.error)); return; }
    await tg.sendMessage(chatId, 'Сохранил. Проверяю — отправлю письмо вам же…');
    await testMailbox(tg, chatId, user);
    return;
  }
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

  // Активного шага нет и ни один разбор не сработал — последняя попытка
  // понять фразу. Стоит она либо ничего (местные шаблоны), либо одного
  // обращения к модели в пределах месячного бюджета.
  if (await handleFreeText(tg, chatId, user, text)) return;

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
    /*
     * Ушёл в другой раздел — недописанное отменяем.
     *
     * Состояние диалога жило до тех пор, пока его кто-нибудь не перезапишет.
     * Человек начинал счёт, передумывал, уходил в «Мои документы» — и любое
     * следующее слово в чате попадало в брошенный сценарий: на «Спасибо»
     * бот отвечал «Сколько и по какой цене?». Выглядело как поломка.
     *
     * Кнопки самого сценария (позиции, предпросмотр, шаги формы) состояние,
     * разумеется, сохраняют — иначе сценарий не пройти.
     */
    {
      const was = bdb.getState(user.id);
      const own = was.state ? (FLOW_BUTTONS[Object.keys(FLOW_BUTTONS)
        .find((k) => was.state.startsWith(k))] || []) : [];
      if (was.state && !own.some((p) => data.startsWith(p))) {
        bdb.clearState(user.id);
        // Молча терять набранное нельзя: человек мог ввести десяток позиций.
        const items = (was.data && was.data.items) || [];
        if (was.state.startsWith('items:') && items.length) {
          await tg.sendMessage(chatId,
            `Незаконченный документ отменил — ${items.length} `
            + `${plural(items.length, 'позиция', 'позиции', 'позиций')} не сохранились.`);
        }
      }
    }

    if (data === 'menu') { await tg.sendMessage(chatId, 'Главное меню:', mainMenu()); return; }
    if (data === 'bank:take') {
      const st = bdb.getState(user.id);
      const rows = st.state === 'bank' && Array.isArray(st.data.rows) ? st.data.rows : [];
      bdb.clearState(user.id);
      if (!rows.length) {
        await tg.sendMessage(chatId, 'Выписка уже не в работе — пришлите файл заново.', mainMenu());
        return;
      }
      const res = bdb.importBankRows(user.id, rows);
      await tg.sendMessage(chatId,
        res.added
          ? `✅ Занёс ${res.added} ${plural(res.added, 'оплату', 'оплаты', 'оплат')} в журнал.`
            + (res.skipped ? `\nПропущено (уже были): ${res.skipped}.` : '')
          : 'Ничего не занёс — эти оплаты уже есть в журнале.', mainMenu());
      return;
    }
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
      // Именно null, а не удаление ключа: «без НДС» для этого счёта должно
      // перебивать настройку организации, а пустое место она заполнит сама.
      if (rate === 'none') { dd.doc.vatRate = null; dd.doc.priceIncludesVat = false; } else {
        dd.doc.vatRate = Number(rate);
        dd.doc.priceIncludesVat = gross === '1';
      }
      bdb.setState(user.id, st2.state, dd);
      await showPreview(tg, chatId, user, bdb.getState(user.id));
      return;
    }
    if (data === 'basis') { await showBasis(tg, chatId, user); return; }
    if (data.startsWith('basis.set:')) {
      const org = bdb.getDefaultOrg(user.id);
      if (org) {
        bdb.updateOrg(user.id, org.id, { debt_basis: data.slice(10) });
        // Пересобираем журнал под новое правило. Без этого переключение
        // меняло строчку в настройках и больше ничего: проводки создаются
        // при выписке, и уже выписанные документы оставались как были —
        // человек переключал основание и не видел никакой разницы.
        const fixed = bdb.rebuildDebt(user.id);
        const said = rebuildText(fixed);
        if (said) await tg.sendMessage(chatId, said);
      }
      await showBasis(tg, chatId, user);
      return;
    }
    if (data === 'biz') { await showBizType(tg, chatId, user); return; }
    if (data.startsWith('biz.set:')) {
      const t = bizTypes.get(data.slice(8));
      const org = bdb.getDefaultOrg(user.id);
      if (t && org) {
        bdb.updateOrg(user.id, org.id, { biz_type: data.slice(8), debt_basis: t.basis });
        // Та же дверь к тому же правилу, что и basis.set — значит, и тот же
        // пересчёт. Иначе выбравший «Аренда» читает «долг по счёту», а долг
        // по уже выписанным счетам не появляется.
        const said = rebuildText(bdb.rebuildDebt(user.id));
        await tg.sendMessage(chatId,
          `<b>${esc(t.name)}</b>\n\n${esc(t.why)}${said ? `\n\n${said}` : ''}`);
      }
      await showBasis(tg, chatId, user);
      return;
    }

    // --- регулярные документы ---
    if (data === 'rec') { await showRecurring(tg, chatId, user); return; }
    if (data.startsWith('rec.new:')) {
      const src = bdb.getDoc(user.id, Number(data.slice(8)));
      if (!src || !docService.ITEM_DOCS[src.type]) {
        await tg.sendMessage(chatId, 'Такой документ повторять нельзя.', mainMenu());
        return;
      }
      // Счёт на аренду живёт по договору: платят к определённому числу, а
      // счёт нужен заранее. Остальные документы просто привязаны к числу.
      const rent = ['sch', 'schdog'].includes(src.type);
      await tg.sendMessage(chatId,
        `<b>Повторять «${esc(docService.ITEM_DOCS[src.type].title)}» каждый месяц</b>\n\n`
        + (rent
          ? 'Какого числа клиент должен платить? Это число из договора — счёт пришлю '
            + 'заранее, а на следующий день после срока напомню, если денег не будет.\n\n'
          : 'Какого числа напоминать?\n\n')
        + '<i>29, 30 и 31 наступают не в каждом месяце — если нужен конец месяца, '
        + 'выберите «в последний день».</i>',
        keyboard([
          [{ text: '1-го', data: `rec.add:${src.id}:1` }, { text: '5-го', data: `rec.add:${src.id}:5` },
            { text: '10-го', data: `rec.add:${src.id}:10` }],
          [{ text: '15-го', data: `rec.add:${src.id}:15` }, { text: '20-го', data: `rec.add:${src.id}:20` },
            { text: '25-го', data: `rec.add:${src.id}:25` }],
          [{ text: 'В последний день месяца', data: `rec.add:${src.id}:0` }],
          [{ text: '⬅️ Меню', data: 'menu' }],
        ]));
      return;
    }
    if (data.startsWith('rec.add:')) {
      const [, idStr, dayStr] = data.split(':');
      const src = bdb.getDoc(user.id, Number(idStr));
      if (!src || !docService.ITEM_DOCS[src.type]) return;
      const day = Number(dayStr);

      // У счёта спрашиваем ещё и за сколько дней выставлять: в аренде это
      // отдельная договорённость, а «за 3 дня» — самый частый случай.
      if (['sch', 'schdog'].includes(src.type) && day) {
        await tg.sendMessage(chatId,
          `Оплата ${day}-го числа. За сколько дней выставлять счёт?`,
          keyboard([
            [{ text: 'За 3 дня', data: `rec.lead:${src.id}:${day}:3` },
              { text: 'За 5 дней', data: `rec.lead:${src.id}:${day}:5` }],
            [{ text: 'За 7 дней', data: `rec.lead:${src.id}:${day}:7` },
              { text: 'В день оплаты', data: `rec.lead:${src.id}:${day}:0` }],
            [{ text: '⬅️ Меню', data: 'menu' }],
          ]));
        return;
      }
      await addRecurring(tg, chatId, user, src, { day });
      return;
    }
    if (data.startsWith('rec.akt:')) {
      const cpId = Number(data.slice(8));
      const mine = recurring.list(user.id);
      if (mine.some((r) => r.cp_id === cpId && r.type === 'usl')) {
        await tg.sendMessage(chatId, 'Акт этому клиенту уже повторяется.', keyboard([
          [{ text: '🔁 Все повторения', data: 'rec' }], [{ text: '⬅️ Меню', data: 'menu' }],
        ]));
        return;
      }
      // Позиции берём из счёта этому же клиенту: акт закрывает ровно то,
      // за что выставлен счёт, и набирать их второй раз незачем.
      const src = mine.find((r) => r.cp_id === cpId && ['sch', 'schdog'].includes(r.type));
      if (!src) { await tg.sendMessage(chatId, 'Сначала настройте счёт.', mainMenu()); return; }
      const id = recurring.add(user.id, {
        cpId, type: 'usl', items: src.items, extra: src.extra, day: recurring.LAST_DAY,
      });
      const rec = recurring.get(user.id, id);
      await tg.sendMessage(chatId,
        `✅ Акт для <b>${esc(rec.cp_name)}</b> — ${rec.dayText}.\n\n`
        + '<i>Тоже предложением с кнопкой, не сам.</i>',
        keyboard([[{ text: '🔁 Все повторения', data: 'rec' }], [{ text: '⬅️ Меню', data: 'menu' }]]));
      return;
    }
    if (data.startsWith('rec.lead:')) {
      const [, idStr, dayStr, leadStr] = data.split(':');
      const src = bdb.getDoc(user.id, Number(idStr));
      if (!src || !docService.ITEM_DOCS[src.type]) return;
      await addRecurring(tg, chatId, user, src,
        { payDay: Number(dayStr), leadDays: Number(leadStr) });
      return;
    }
    if (data.startsWith('rec.go:')) {
      const rec = recurring.get(user.id, Number(data.slice(7)));
      if (!rec) { await tg.sendMessage(chatId, 'Это повторение уже удалено.', mainMenu()); return; }
      const done = await issueDoc(tg, chatId, user, {
        type: rec.type,
        cpId: rec.cp_id,
        doc: { items: rec.items, date: todayISO(), number: '' },
        extra: rec.extra,
      });
      if (done) await afterDoc(tg, chatId, user, rec.cp_id);
      return;
    }
    if (data.startsWith('rec.skip:')) {
      recurring.markOffered(Number(data.slice(9)));
      await tg.sendMessage(chatId, 'Пропустил. Напомню в следующем месяце.', mainMenu());
      return;
    }
    if (data.startsWith('rec.off:')) {
      recurring.off(user.id, Number(data.slice(8)));
      await tg.sendMessage(chatId, 'Больше напоминать не буду.');
      await showRecurring(tg, chatId, user);
      return;
    }
    if (data.startsWith('doc.paid:')) {
      const id = Number(data.slice(9));
      const when = bdb.markPaid(user.id, id);
      if (when) await tg.sendMessage(chatId, `✅ Отметил оплату ${ru(when)} — долг закрыт.`);
      await showDoc(tg, chatId, user, id);
      return;
    }
    if (data.startsWith('doc.unpaid:')) {
      const id = Number(data.slice(11));
      bdb.unmarkPaid(user.id, id);
      await tg.sendMessage(chatId, 'Отметку об оплате снял, долг вернул в журнал.');
      await showDoc(tg, chatId, user, id);
      return;
    }
    if (data.startsWith('doc.debt:')) {
      const id = Number(data.slice(9));
      const d = bdb.getDoc(user.id, id);
      if (d && bdb.restoreDebt(user.id, id)) {
        const b = d.cp_id ? bdb.balanceOf(user.id, d.cp_id) : null;
        await tg.sendMessage(chatId, 'Вернул документ в долг.'
          + (b ? ` Сальдо: <b>${formatRub(Math.abs(b.closing))}</b>.` : ''));
      }
      await showDoc(tg, chatId, user, id);
      return;
    }
    if (data === 'unpaid') { await showUnpaid(tg, chatId, user); return; }
    if (data === 'reg') {
      await tg.sendMessage(chatId, 'Реестр за какой период?', keyboard([
        [{ text: 'Текущий месяц', data: 'reg.p:month' }, { text: 'Прошлый месяц', data: 'reg.p:prev' }],
        [{ text: 'Квартал', data: 'reg.p:quarter' }, { text: 'Год', data: 'reg.p:year' }],
        [{ text: '⬅️ К документам', data: 'docs' }],
      ]));
      return;
    }
    if (data.startsWith('reg.p:')) { await sendRegistry(tg, chatId, user, data.slice(6)); return; }
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
    if (data === 'inbox') { await checkInbox(tg, chatId, user); return; }
    if (data.startsWith('in.m:')) { await showInboxMessage(tg, chatId, user, Number(data.slice(5))); return; }
    if (data.startsWith('in.f:')) {
      const m = (inboxCache.get(user.id) || [])[Number(data.slice(5))];
      if (!m) { await tg.sendMessage(chatId, 'Письмо уже неактуально.', mainMenu()); return; }
      for (const d of m.docs) {
        // eslint-disable-next-line no-await-in-loop
        await tg.sendDocument(chatId, {
          filename: d.filename, buffer: d.content,
          caption: `Из письма «${esc(m.subject || 'без темы')}» от ${esc(m.fromName || m.from)}.`,
        });
      }
      return;
    }
    if (data.startsWith('in.op:')) {
      const [idx, cpIdStr] = data.slice(6).split(':');
      const m = (inboxCache.get(user.id) || [])[Number(idx)];
      if (!m) { await tg.sendMessage(chatId, 'Письмо уже неактуально.', mainMenu()); return; }
      bdb.setState(user.id, `op:${Number(cpIdStr)}`);
      await tg.sendMessage(chatId,
        `Внесу операцию по контрагенту. Напишите сумму и вид, например:\n`
        + `<code>${ru(todayISO())} приход 60000</code>\n\n`
        + `<i>Из письма: ${esc(m.subject || 'без темы')}</i>`);
      return;
    }
    if (data === 'mb') { await showMailbox(tg, chatId, user); return; }
    if (data === 'mb.new') {
      bdb.setState(user.id, 'mb:email');
      await tg.sendMessage(chatId,
        'С какого адреса отправлять документы?\n\nНапишите почту, например <code>buh@yandex.ru</code>.',
        keyboard([[{ text: '✖️ Отмена', data: 'mb' }]]));
      return;
    }
    if (data === 'mb.test') { await testMailbox(tg, chatId, user); return; }
    if (data === 'mb.del') {
      mailbox.remove(user.id);
      await tg.sendMessage(chatId, 'Почту отключил. Документы можно по-прежнему скачивать и пересылать вручную.');
      await showMailbox(tg, chatId, user);
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
    // Проводник: «выписать счёт» с любого места, недостающее спросим по пути.
    if (data === 'go.any') { await chooseDoc(tg, chatId, user); return; }
    if (data.startsWith('go.')) { await startDoc(tg, chatId, user, data.slice(3)); return; }
    if (data.startsWith('cp.new.')) {
      bdb.setState(user.id, 'form:cpq', { i: 0, values: { __then: data.slice(7) } });
      await askStep(tg, chatId, 'cpq', 0);
      return;
    }
    /*
     * «Пропустить» — то же, что прислать «-», только руками этого никто не
     * делает. Для числа и даты «-» не годится: форма встанет и будет
     * бесконечно повторять «нужно число». Подставляем разумное умолчание —
     * ноль и сегодня.
     */
    if (data.startsWith('form.skip')) {
      const st = bdb.getState(user.id);
      if (!st.state.startsWith('form:')) return;
      const at = Number(data.split(':')[1]);
      if (Number.isFinite(at) && at !== st.data.i) return;   // кнопка из прошлого вопроса
      const form = FORMS[st.state.slice(5)];
      const step = form && form.steps[st.data.i];
      if (!step || !step.opt) return;                        // обязательное не пропускаем
      const value = step.num ? '0' : (step.date ? ru(docService.todayISO()) : '-');
      await applyFormValue(tg, chatId, user, st, value);
      return;
    }
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
    if (data.startsWith('d.akt:')) { await askAktPeriod(tg, chatId, user, Number(data.slice(6))); return; }
    if (data.startsWith('akt.p:')) {
      const [cpId, code] = data.slice(6).split(':');
      const r = period.presetRange(code);
      await genAktSverki(tg, chatId, user, Number(cpId), r.from, r.to);
      return;
    }
    if (data.startsWith('akt.own:')) {
      const cpId = Number(data.slice(8));
      bdb.setState(user.id, `aktp:${cpId}`, {});
      await tg.sendMessage(chatId,
        'Напишите период — как удобно:\n'
        + '<code>01.01.2026 - 31.03.2026</code>\n'
        + '<code>март</code>  ·  <code>апрель 2025</code>\n'
        + '<code>2 квартал</code>  ·  <code>2025</code>',
        keyboard([[{ text: '✖️ Отмена', data: `cp:${cpId}` }]]));
      return;
    }
    if (data.startsWith('d.usl:')) { await startItems(tg, chatId, user, 'usl', Number(data.slice(6))); return; }
    if (data.startsWith('d.schdog:')) {
      // Счёт-договор — тот же счёт по сути, ставку НДС берём так же.
      const org = bdb.getDefaultOrg(user.id);
      const v = org ? bdb.vatOf(org) : { rate: null, gross: false };
      await startItems(tg, chatId, user, 'schdog', Number(data.slice(9)),
        v.rate == null ? {} : { vatRate: v.rate, priceIncludesVat: v.gross });
      return;
    }
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
      await tg.sendMessage(chatId, `<b>${esc(t.name)}</b> по ${formatRub(t.price)} за ${esc(t.unit)}\nСколько?`);
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
    if (data === 'promo') {
      bdb.setState(user.id, 'promo', {});
      await tg.sendMessage(chatId,
        'Пришлите код доступа — он выглядит так: <code>PRV-A3KD-9MQX</code>.\n\n'
        + '<i>Регистр и дефисы неважны.</i>',
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
    if (data.startsWith('rm.mail:')) {
      await sendReminderMail(tg, chatId, user, Number(data.slice(8)));
      return;
    }
    if (data.startsWith('rm.ask:')) {
      const cpId = Number(data.slice(7));
      bdb.setState(user.id, `rm:${cpId}`, {});
      const cp = bdb.getCp(user.id, cpId);
      await tg.sendMessage(chatId,
        `Куда отправить напоминание для <b>${esc((cp && cp.name) || 'клиента')}</b>?\n\n`
        + '<i>Пришлите адрес почты — запомню его в карточке клиента.</i>',
        keyboard([[{ text: '✖️ Отмена', data: 'debts' }]]));
      return;
    }
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

  /*
   * Кто мы. Пробуем несколько раз: у российского хостинга связь с
   * api.telegram.org иногда моргает, и падать из-за этого при старте нельзя —
   * systemd поднимет заново, но в журнал ляжет трассировка, а бот всё равно
   * будет ждать сети. Лучше подождать сами и написать понятно.
   */
  let me = null;
  for (let attempt = 1; attempt <= 5 && !me; attempt += 1) {
    try {
      me = await tg.call('getMe');                    // eslint-disable-line no-await-in-loop
    } catch (e) {
      if (attempt === 5) throw e;
      console.error(`Telegram не отвечает (${e.message}), попытка ${attempt} из 5…`);
      await new Promise((r) => setTimeout(r, attempt * 3000));   // eslint-disable-line no-await-in-loop
    }
  }

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

  // Второй экземпляр на этой машине не запускаем: два читателя одного
  // токена отбирают обновления друг у друга, и бот отвечает через раз.
  const lock = acquireLock(`bot-${String(token).split(':')[0]}`);
  if (!lock.ok) {
    console.error(`Бот уже запущен на этой машине (процесс ${lock.pid}).`);
    console.error('Два экземпляра на одном токене мешают друг другу: Telegram отдаёт');
    console.error('входящие только одному, и сообщения будут теряться.');
    console.error('');
    console.error(`  что это за процесс:  ps -p ${lock.pid} -o pid,cmd`);
    console.error('  остановить службу:   systemctl stop trapeza-bot');
    console.error(`  снять замок вручную: rm ${lock.file}   (только если процесс мёртв)`);
    process.exit(1);
  }

  console.log(`Бот запущен: @${me.username}`);
  let offset = 0;
  let conflicts = 0;
  let quietUntil = 0;
  let netFails = 0;
  let netQuiet = 0;
  /*
   * Ежедневные дела делаем внутри того же цикла, а не отдельной службой:
   * второй процесс с той же базой — это второй источник ошибок и ещё один
   * unit, который надо не забыть перезапустить. Цикл и так просыпается не
   * реже чем раз в полминуты, а метка дня не даёт повториться.
   *
   * Первое пробуждение после запуска пропускаем намеренно: перезапуск бота
   * не должен превращаться в рассылку предложений.
   */
  let dailyDone = todayISO();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (dailyDone !== todayISO()) {
      dailyDone = todayISO();
      try { await runDaily(tg); } catch (e) { console.error('ежедневные дела:', e.message); }
    }
    let updates = [];
    try {
      updates = await tg.getUpdates(offset, 30);
      // Связь восстановилась — молчание про сбои снимаем, чтобы следующий
      // обрыв был виден сразу, а не через минуту.
      if (netFails) { console.log(`Связь с Telegram восстановлена (сбоев было ${netFails}).`); }
      conflicts = 0; netFails = 0; netQuiet = 0;
    } catch (e) {
      // 409 — тот же токен читает кто-то ещё. Сыпать в лог по строке каждые
      // три секунды бессмысленно и опасно: журнал вырастет на гигабайты и
      // забьёт диск. Говорим один раз подробно, дальше — раз в минуту.
      const clash = e.code === 409 || /Conflict/i.test(e.message || '');
      if (clash) {
        conflicts += 1;
        if (Date.now() > quietUntil) {
          console.error(`Тот же токен читает другой процесс (${conflicts} попыток подряд).`);
          console.error('Скорее всего где-то запущена вторая копия бота — на этом сервере');
          console.error('или на другом. Пока их две, сообщения будут теряться.');
          quietUntil = Date.now() + 60000;
        }
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      /*
       * Обрыв связи. Та же беда, что с конфликтом: при долгом сбое строка
       * каждые три секунды за ночь превращается в гигабайты и забивает диск,
       * а полезного в ней ничего. Говорим раз в минуту и с числом попыток,
       * между попытками ждём всё дольше — до полминуты.
       */
      netFails += 1;
      if (Date.now() > netQuiet) {
        console.error(`getUpdates: ${e.message} (сбоев подряд: ${netFails})`);
        netQuiet = Date.now() + 60000;
      }
      await new Promise((r) => setTimeout(r, Math.min(3000 * netFails, 30000)));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      try { await handleUpdate(tg, u); } catch (e) { console.error('handleUpdate:', e.message); }
    }
  }
}

if (require.main === module) main();

module.exports = {
  handleUpdate, runDaily, parseOp, parseDate, parseItemLine, readItemLine, parseAmount,
};
