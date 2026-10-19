'use strict';

/**
 * Снимки экранов мини-приложения — чтобы смотреть глазами, а не воображать.
 *
 *   TRAPEZA_DB=/tmp/preview.db node miniapp-preview.js [папка]
 *
 * Поднимаем настоящий сервер приложения на временной базе с показательными
 * данными, открываем его настоящим Chromium в размере телефона и снимаем
 * каждый экран в светлой и тёмной теме. Telegram подменяем заглушкой: она
 * отдаёт подписанную initData и цвета темы — ровно то, что даёт мессенджер.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'preview-out'));
fs.mkdirSync(OUT, { recursive: true });

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '111:PREVIEW-TOKEN';
process.env.FREE_DOCS = process.env.FREE_DOCS || '5';
// Без адреса оферты экран подписки честно прячет кнопку оплаты — для снимка
// подставляем демонстрационный, чтобы экран был виден целиком.
process.env.LAVA_OFFER_URL = process.env.LAVA_OFFER_URL || 'https://app.lava.top/products/demo';
const TOKEN = process.env.BOT_TOKEN;

const bdb = require('./lib/bot-db');
const docService = require('./lib/doc-service');
const { server, setTelegram, forgetRate } = require('./miniapp');

const USER = { id: 424242, first_name: 'Мария', last_name: 'Сарычева', username: 'masha' };

function initDataFor(user) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) };
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const q = new URLSearchParams(fields);
  q.set('hash', hash);
  return q.toString();
}

/** Цвета Telegram: слева светлая тема, справа тёмная — как в мессенджере. */
const THEMES = {
  light: {
    bg_color: '#ffffff',
    secondary_bg_color: '#f2f2f7',
    section_bg_color: '#ffffff',
    text_color: '#12171c',
    hint_color: '#7d8b99',
    link_color: '#2b7fd4',
    button_color: '#2b7fd4',
    button_text_color: '#ffffff',
    destructive_text_color: '#d1453b',
    section_header_text_color: '#7d8b99',
  },
  dark: {
    bg_color: '#17212b',
    secondary_bg_color: '#131c26',
    section_bg_color: '#1d2733',
    text_color: '#f1f4f7',
    hint_color: '#8fa1b3',
    link_color: '#62a3e3',
    button_color: '#5288c1',
    button_text_color: '#ffffff',
    destructive_text_color: '#ec6a5e',
    section_header_text_color: '#8fa1b3',
  },
};

/** Что заведено при посеве: идентификаторы нужны снимкам, которые открывают экран по клиенту. */
const SEED = { cp: 0 };

/** Показательные данные: пустой экран — плохая витрина. */
async function seed() {
  const user = bdb.getOrCreateUser(USER.id, 'Мария Сарычева', 'masha');
  bdb.saveMyOrg(user.id, {
    name: 'ИП Сарычева М. В.',
    full_name: 'Индивидуальный предприниматель Сарычева Мария Витальевна',
    inn: '183209316119', signer: 'М. В. Сарычева', address: 'г. Ижевск, ул. Пушкинская, 150',
    bank_name: 'АО «ТБанк»', bik: '044525974',
    acc: '40802810700005555555', corr_acc: '30101810145250000974',
  });

  const cps = [
    { name: 'ООО «Заря»', inn: '1831234567', kind: 'customer', address: 'г. Ижевск, ул. Ленина, 1' },
    { name: 'ООО «Пирамида»', inn: '1832345678', kind: 'customer', address: 'г. Ижевск, ул. Карла Маркса, 20' },
    { name: 'ИП Волков А. С.', inn: '183301234567', kind: 'supplier', address: 'г. Сарапул' },
  ];
  const ids = cps.map((cp) => bdb.createCp(user.id, { ...cp, opening_date: '2026-01-01' }));

  // Знак как в журнале: credit — приход (нам должны), debit — оплата.
  bdb.addOp(user.id, ids[0], { date: '2026-07-12', kind: 'Приход', doc: 'Счёт 4', credit: 66693 });
  bdb.addOp(user.id, ids[1], { date: '2026-06-02', kind: 'Приход', doc: 'Счёт 2', credit: 54193 });
  bdb.addOp(user.id, ids[1], { date: '2026-06-20', kind: 'Оплата', doc: 'п/п 88', debit: 20000 });
  bdb.addOp(user.id, ids[2], { date: '2026-07-30', kind: 'Приход', doc: 'ТН 15', credit: 18400 });

  const docs = [
    { type: 'sch', cpId: ids[0], date: '2026-08-12', items: [
      { name: 'Канапе ассорти', unit: 'шт.', qty: 60, price: 650 },
      { name: 'Обслуживание банкета', unit: 'усл.', qty: 1, price: 12000 },
      { name: 'Доставка по городу', unit: 'усл.', qty: 1, price: 1500 }] },
    { type: 'usl', cpId: ids[1], date: '2026-08-06', items: [
      { name: 'Фуршет на 30 персон', unit: 'усл.', qty: 1, price: 54193 }] },
    { type: 'upd', cpId: ids[0], date: '2026-07-28', items: [
      { name: 'Кофе-брейк', unit: 'шт.', qty: 25, price: 480 }] },
  ];
  // Отгрузки этого месяца — иначе «Акт за месяц» на снимке пустая заглушка.
  const ym = docService.todayISO().slice(0, 7);
  docs.push(
    { type: 'torg12', cpId: ids[0], date: `${ym}-03`, items: [
      { name: 'Канапе ассорти', unit: 'шт.', qty: 40, price: 650 },
      { name: 'Пирожные', unit: 'шт.', qty: 30, price: 210 }] },
    { type: 'upd', cpId: ids[0], date: `${ym}-09`, items: [
      { name: 'Кофе-брейк', unit: 'шт.', qty: 25, price: 480 }] },
  );
  SEED.cp = ids[0];
  for (const d of docs) {
    // eslint-disable-next-line no-await-in-loop
    await docService.issueDocument(user.id, { ...d, skipQuota: true });
  }

  // «Акт за месяц» есть только у клиентов на предоплате.
  bdb.setPrepayMode(user.id, SEED.cp, bdb.currentOrgId(user.id), true);

  // Пара повторений — иначе экран «Каждый месяц» на снимке пустой.
  require('./lib/recurring').add(user.id, {
    cpId: ids[0], type: 'sch', payDay: 5, leadDays: 3,
    items: [{ name: 'Абонентское обслуживание', unit: 'мес.', qty: 1, price: 18000 }],
  });
  require('./lib/recurring').add(user.id, {
    cpId: ids[1], type: 'usl', day: 0,
    items: [{ name: 'Кофе-брейк по договору', unit: 'усл.', qty: 1, price: 12000 }],
  });
  // Короткие расписания — иначе список «По расписанию» и блок в карточке клиента на снимке пусты.
  require('./lib/recurring').add(user.id, {
    cpId: ids[0], type: 'torg12', period: 'weekdays', offeredThisMonth: false,
    items: [{ name: 'Обед комплексный', unit: 'шт.', qty: 20, price: 350 }],
  });
  require('./lib/recurring').add(user.id, {
    cpId: ids[1], type: 'sch', period: 'week', weekday: 3, offeredThisMonth: false,
    items: [{ name: 'Доставка воды', unit: 'шт.', qty: 12, price: 280 }],
  });
  // Подпись и печать: без них экран реквизитов на снимке выглядит пустым,
  // а это заметная часть работы. Рисуем их тут же, чтобы не тащить файлы.
  const fx = require('./lib/facsimile');
  const chromiumForArt = require('./lib/pdf').loadChromium();
  if (chromiumForArt) {
    const br = await chromiumForArt.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const pg = await br.newPage();
    await pg.setViewportSize({ width: 600, height: 260 });
    await pg.setContent(`<body style="margin:0;background:#fff"><svg width="600" height="260"
      xmlns="http://www.w3.org/2000/svg"><rect width="600" height="260" fill="#fdfdfb"/>
      <path d="M40 175 C 90 70, 130 225, 180 120 S 260 45, 300 160 C 330 225, 360 100, 420 130 L 470 100"
        stroke="#1b2a6b" stroke-width="7" fill="none" stroke-linecap="round"/>
      <path d="M180 190 L 430 182" stroke="#1b2a6b" stroke-width="4" fill="none"/></svg></body>`);
    fx.save(user.id, 'sign', await pg.screenshot({ type: 'png' }), 'image/png');
    await pg.setViewportSize({ width: 420, height: 420 });
    await pg.setContent(`<body style="margin:0;background:#fff"><svg width="420" height="420"
      xmlns="http://www.w3.org/2000/svg"><rect width="420" height="420" fill="#fefefe"/>
      <g fill="none" stroke="#2b3ea8" stroke-width="6"><circle cx="210" cy="210" r="195"/>
      <circle cx="210" cy="210" r="150"/><circle cx="210" cy="210" r="120"/></g>
      <text x="210" y="196" font-family="Arial" font-size="30" font-weight="bold" fill="#2b3ea8"
        text-anchor="middle">ИП</text>
      <text x="210" y="232" font-family="Arial" font-size="21" fill="#2b3ea8"
        text-anchor="middle">САРЫЧЕВА</text></svg></body>`);
    fx.save(user.id, 'stamp', await pg.screenshot({ type: 'png' }), 'image/png');
    await br.close();
  }

  // Подключённый ящик: без него экран напоминаний показывает только
  // «скопируйте текст», а главное на нём — отправка письмом.
  require('./lib/mailbox').save(user.id, {
    preset: 'custom', login: 'buh@sarycheva.ru', from: 'buh@sarycheva.ru',
    pass: 'для-снимков', fromName: 'ИП Сарычева М. В.',
    host: 'smtp.example.invalid', port: 587, secure: false,
  });
  for (const [i, id] of ids.entries()) {
    if (i < 2) bdb.updateCp(user.id, id, { email: `buh${i + 1}@client.ru` });
  }

  /*
   * Мини-CRM: без напоминаний вкладка CRM на снимке — пустая заглушка, а
   * смотреть там надо именно просрочку, «сегодня» и счётчик на вкладке.
   * Срок через API не поставить раньше завтрашнего (напоминание «в прошлом»
   * человек создать не может), поэтому правим его прямо в таблице.
   */
  {
    const crm = require('./lib/crm');
    const { db } = require('./db');
    const today = docService.todayISO();
    const fu = (cpIdx, shift, text) => {
      const f = crm.addFollowup(user.id, ids[cpIdx], { today, days: 1, text });
      db.prepare('UPDATE cp_followups SET due = ? WHERE id = ?').run(crm.plusDays(today, shift), f.id);
    };
    fu(1, -2, 'Позвонить по счёту № 2, обещали оплатить в пятницу');
    fu(0, 0, 'Уточнить количество гостей на банкет');
    fu(0, 0, 'Отправить акт на подпись');
    fu(2, 4, 'Согласовать поставку на следующую неделю');
    crm.addNote(user.id, ids[0], 'Договорились на пятницу: 60 канапе и обслуживание, оплата сразу после банкета');
    crm.addNote(user.id, ids[1], 'Бухгалтер просила прислать акт сверки до конца месяца');
  }

  // Пара позиций про запас, чтобы было видно «частые позиции».
  bdb.rememberItems(user.id, [
    { name: 'Кофе-брейк', unit: 'шт.', price: 480 },
    { name: 'Канапе ассорти', unit: 'шт.', price: 650 },
  ]);
}

const SHOTS = [
  { name: 'glavnaya', title: 'Главная', go: null },
  {
    name: 'novyy-schet',
    title: 'Новый счёт',
    go: ['new', {
      type: 'sch',
      items: [
        { name: 'Канапе ассорти', unit: 'шт.', qty: 60, price: 650 },
        { name: 'Обслуживание банкета', unit: 'усл.', qty: 1, price: 12000 },
      ],
    }],
  },
  { name: 'pustoy-schet', title: 'Новый счёт (пустой)', go: ['new', { type: 'sch' }] },
  { name: 'dokumenty', title: 'Документы', go: ['docs', {}] },
  { name: 'klienty', title: 'Клиенты', go: ['cps', {}] },
  { name: 'crm', title: 'Дела', go: ['crm', {}] },
  { name: 'crm-nizhe', title: 'Дела: лента событий', go: ['crm', {}], scroll: 'bottom' },
  {
    name: 'crm-forma', title: 'Дела: раскрыта форма напоминания', go: ['crm', {}],
    act: async (page) => { await page.locator('#crm-new-btn').click(); await page.waitForTimeout(250); },
  },
  {
    // Карточка документа: внизу кнопка «Повторить», и форма, которую она открывает.
    name: 'dokument-povtor', title: 'Карточка документа: «Повторить»', go: ['docs', {}], scroll: 'bottom',
    act: async (page) => {
      await page.locator('#app .card .row').first().click();
      const b = page.getByRole('button', { name: 'Повторить', exact: true });
      await b.waitFor({ timeout: 5000 });
      await b.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'povtor-forma', title: 'Форма повтора документа', go: ['docs', {}],
    act: async (page) => {
      await page.locator('#app .card .row').first().click();
      const b = page.getByRole('button', { name: 'Повторить', exact: true });
      await b.waitFor({ timeout: 5000 });
      await b.click();
      await page.waitForSelector('#repeat-note', { timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'akt-mesyaca', title: 'Акт за месяц: предпросмотр', go: null,
    act: async (page) => {
      await page.evaluate((id) => window.__go('monthact', { cpId: id }), SEED.cp);
      await page.waitForSelector('#monthact-list', { timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'akt-mesyaca-kartochka', title: 'Карточка клиента: «Акт за месяц»', go: null,
    act: async (page) => {
      await page.evaluate((id) => window.__go('cp', { id }), SEED.cp);
      await page.getByText('Акт за месяц', { exact: true }).first().waitFor({ timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  { name: 'dolgi', title: 'Долги', go: ['debts', {}] },
  { name: 'organizaciya', title: 'Моя организация', go: ['org', {}] },
  { name: 'podpiska', title: 'Подписка', go: ['billing', {}] },
  // Карточка подписи и печати живёт в конце экрана реквизитов — без
  // прокрутки она в кадр не попадает.
  { name: 'faksimile', title: 'Подпись и печать', go: ['org', {}], scroll: 'bottom' },
];

async function main() {
  await seed();
  /*
   * Карточка документа и карточка клиента открываются по id, а он появляется
   * только после посева. Раньше эти экраны в снимки не попадали вовсе — и
   * именно на них живут отправка почтой, отметка оплаты и повтор документа.
   */
  {
    const me = bdb.getOrCreateUser(USER.id);
    const lastDoc = bdb.listDocs(me.id, 10).find((d) => d.type === 'sch') || bdb.listDocs(me.id, 1)[0];
    const firstCp = bdb.listCps(me.id)[0];
    if (lastDoc) SHOTS.push({ name: 'kartochka-dokumenta', title: 'Карточка документа', go: ['doc', { id: lastDoc.id }] });
    // Штампы, ссылка для клиента и отправка почтой живут в конце карточки —
    // без прокрутки их в кадре не видно.
    if (lastDoc) {
      SHOTS.push({
        name: 'kartochka-dokumenta-nizhe',
        title: 'Карточка документа: ссылка и штампы',
        go: ['doc', { id: lastDoc.id }],
        scroll: 'bottom',
      });
    }
    if (firstCp) SHOTS.push({ name: 'kartochka-klienta', title: 'Карточка клиента', go: ['cp', { id: firstCp.id }] });
    SHOTS.push({ name: 'eshchyo', title: 'Ещё', go: ['more', {}] });
    SHOTS.push({ name: 'pochta', title: 'Почта', go: ['mail', {}] });
    SHOTS.push({ name: 'pochta-nastroyka', title: 'Подключить почту', go: ['mail.new', {}] });
    SHOTS.push({ name: 'nds', title: 'НДС', go: ['vat', {}] });
    SHOTS.push({ name: 'osnovanie-dolga', title: 'Откуда долг', go: ['basis', {}] });
    SHOTS.push({ name: 'osnovanie-dolga-nizhe', title: 'Откуда долг: вид дела', go: ['basis', {}], scroll: 'bottom' });
    SHOTS.push({ name: 'kazhdyy-mesyac', title: 'По расписанию: список', go: ['recurring', {}] });
    if (lastDoc) {
      SHOTS.push({
        name: 'raspisanie-vybor', title: 'Карточка документа: «Повторять по расписанию»', go: ['doc', { id: lastDoc.id }],
        act: async (page) => {
          await page.locator('#rec-open').click();
          await page.waitForSelector('#rec-day', { timeout: 5000 });
          await page.locator('#rec-week').click();
          await page.waitForSelector('#rec-wd-3', { timeout: 5000 });
          await page.locator('#rec-wd-3').scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
        },
      });
    }
    if (firstCp) {
      SHOTS.push({
        name: 'raspisanie-klient', title: 'Карточка клиента: его расписания', go: ['cp', { id: firstCp.id }], scroll: null,
      });
    }
    SHOTS.push({ name: 'zhdut-oplaty', title: 'Ждут оплаты', go: ['unpaid', {}] });
    SHOTS.push({ name: 'reestr', title: 'Реестр', go: ['registry', {}] });
    SHOTS.push({ name: 'akt-sverki', title: 'Акт сверки', go: ['akt', {}] });
    SHOTS.push({ name: 'kak-polzovatsya', title: 'Как пользоваться', go: ['help', {}] });
    if (firstCp) SHOTS.push({ name: 'operaciya', title: 'Операция', go: ['op', { cpId: firstCp.id }] });
    SHOTS.push({ name: 'platezhka', title: 'Платёжка', go: ['other', { type: 'pp' }] });
    SHOTS.push({ name: 'dogovor', title: 'Договор', go: ['other', { type: 'dog' }] });
    SHOTS.push({ name: 'napominaniya', title: 'Напоминания', go: ['reminders', {}] });
    SHOTS.push({ name: 'podderzhka', title: 'Поддержка', go: ['support', {}] });
    SHOTS.push({ name: 'snimok', title: 'Снимок счёта', go: ['scan', {}] });
    /*
     * Самозанятый: чеки «Мой налог». Включаем НПД и оплату прямо перед снимком —
     * иначе остальные экраны (УПД в плитках и прочее) снялись бы уже без УПД.
     * Ставятся в самый конец очереди из-за этой перестановки.
     */
    const chequeSetup = async () => {
      const cheques = require('./lib/cheques');
      const org = bdb.getDefaultOrg(me.id);
      bdb.updateOrg(me.id, org.id, { npd: 1 });
      if (cheques.openCount(me.id)) return;
      const cpA = bdb.listCps(me.id)[0];
      const cpB = bdb.listCps(me.id)[1];
      for (const [cp, name, price] of [[cpA, 'Уборка помещения', 12000], [cpB, 'Консультация и выезд', 4500]]) {
        // eslint-disable-next-line no-await-in-loop
        const made = await docService.issueDocument(me.id, { type: 'sch', cpId: cp.id, items: [{ name, qty: 1, price }], skipQuota: true });
        bdb.markPaid(me.id, made.doc.id);
        cheques.owe(me.id, made.doc.id, docService.todayISO());
      }
    };
    SHOTS.push({
      name: 'cheki-glavnaya', title: 'Главная самозанятого: чеки не пробиты', go: null,
      act: async (page) => {
        await chequeSetup();
        await page.evaluate(() => window.__go('home'));
        await page.waitForSelector('#cheques-home', { timeout: 5000 });
        await page.waitForTimeout(300);
      },
    });
    SHOTS.push({
      name: 'cheki', title: 'Чеки «Мой налог»', go: null,
      act: async (page) => {
        await chequeSetup();
        await page.evaluate(() => window.__go('cheques'));
        await page.waitForSelector('.cheque-card', { timeout: 5000 });
        await page.waitForTimeout(300);
      },
    });
    SHOTS.push({
      name: 'cheki-nizhe', title: 'Чеки «Мой налог»: второй чек', go: null, scroll: 'bottom',
      act: async (page) => {
        await page.evaluate(() => window.__go('cheques'));
        await page.waitForSelector('.cheque-card', { timeout: 5000 });
        await page.waitForTimeout(300);
      },
    });
    SHOTS.push({
      name: 'kartochka-dokumenta-chek', title: 'Карточка документа: чек «Мой налог»', go: null, scroll: 'bottom',
      act: async (page) => {
        await chequeSetup();
        const docs = bdb.listDocs(me.id, 10).filter((d) => d.paid_at);
        await page.evaluate((id) => window.__go('doc', { id }), docs[0].id);
        await page.waitForSelector('#doc-cheque', { timeout: 5000 });
        await page.waitForTimeout(300);
      },
    });
    SHOTS.push({
      name: 'vypiska',
      title: 'Выписка из банка',
      go: ['bank', {}],
      // Показываем разобранную выписку: один платёж узнан по ИНН, второй
      // только похож по названию, третий неизвестен — ровно те три случая,
      // ради которых экран и сделан.
      async act(page) {
        await page.setInputFiles('input[type=file]', {
          name: 'vypiska.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from([
            'Дата;ИНН плательщика;Плательщик;Приход;Назначение платежа',
            '12.08.2026;1831234567;ООО "Заря";66 693,00;Оплата по счету 4 от 12.07.2026',
            '13.08.2026;;Пирамида;34 193,00;Оплата по акту от 06.08.2026',
            '14.08.2026;;ООО "Северный ветер";12 000,00;Оплата по счету 118',
          ].join('\n'), 'utf8'),
        });
        await page.waitForSelector('.pay', { timeout: 10000 });
        await page.waitForTimeout(300);
      },
    });
  }
  setTelegram({ async sendDocument() { return {}; } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Playwright лежит не всегда в проекте — берём тот же поиск, что и PDF.
  const chromium = require('./lib/pdf').loadChromium();
  if (!chromium) { console.error('Chromium недоступен — снимки не сделать.'); process.exit(1); }
  // --lang нужен именно браузеру: поля «дата» рисуются им, и без русской
  // локали на снимке будет 08/14/2026 вместо 14.08.2026.
  const launch = { args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=ru-RU'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launch);

  const initData = initDataFor(USER);
  const made = [];

  for (const [themeName, theme] of Object.entries(THEMES)) {
    // Второй круг (тёмная тема) начинается с того же состояния, что и первый:
    // самозанятость и чеки включаются только перед своими снимками.
    {
      const me = bdb.getOrCreateUser(USER.id);
      bdb.updateOrg(me.id, bdb.getDefaultOrg(me.id).id, { npd: 0 });
      require('./db').db.prepare('DELETE FROM npd_cheques WHERE user_id = ?').run(me.id);
    }
    // PREVIEW_WIDTH_PX=1080 — снимки шириной 1080 px при той же раскладке 390 px.
    const px = Number(process.env.PREVIEW_WIDTH_PX) || 780;
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: px / 390,
      colorScheme: themeName,
      locale: 'ru-RU',
    });

    // Скрипт Telegram живёт в интернете, а нам нужна предсказуемая заглушка.
    await ctx.route('https://telegram.org/**', (route) => route.abort());

    await ctx.addInitScript(({ data, params }) => {
      const noop = () => {};

      /**
       * Главная кнопка Telegram рисуется самим мессенджером под окном
       * приложения, и окно на её высоту ужимается. Для снимков рисуем её
       * сами — иначе на картинке не будет главного действия экрана.
       */
      const bar = document.createElement('div');
      bar.id = 'fake-main-button';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:56px;'
        + 'display:none;align-items:center;justify-content:center;z-index:60;'
        + 'font:500 16px/1 -apple-system,BlinkMacSystemFont,Roboto,sans-serif;';
      const shift = document.createElement('style');
      shift.textContent = '.tabs{bottom:56px !important}';

      const btn = {
        text: '', isVisible: false, isActive: true,
        setParams(p) {
          Object.assign(this, p);
          if (p.text !== undefined) bar.textContent = p.text;
          if (p.is_active !== undefined) this.isActive = p.is_active;
          bar.style.opacity = this.isActive ? '1' : '.6';
          return this;
        },
        show() {
          this.isVisible = true;
          bar.style.display = 'flex';
          if (!shift.isConnected) document.head.append(shift);
          return this;
        },
        hide() {
          this.isVisible = false;
          bar.style.display = 'none';
          shift.remove();
          return this;
        },
        onClick: noop, offClick: noop, showProgress: noop, hideProgress: noop,
      };
      document.addEventListener('DOMContentLoaded', () => {
        bar.style.background = params.button_color;
        bar.style.color = params.button_text_color;
        document.body.append(bar);
      });
      window.Telegram = {
        WebApp: {
          initData: data,
          initDataUnsafe: {},
          themeParams: params,
          colorScheme: 'light',
          ready: noop,
          expand: noop,
          close: noop,
          openLink: noop,
          setHeaderColor: noop,
          disableVerticalSwipes: noop,
          BackButton: { show: noop, hide: noop, onClick: noop },
          MainButton: btn,
          HapticFeedback: { impactOccurred: noop, notificationOccurred: noop },
        },
      };
      // Telegram отдаёт цвета переменными на корне документа.
      document.addEventListener('DOMContentLoaded', () => {
        for (const [k, v] of Object.entries(params)) {
          document.documentElement.style.setProperty(`--tg-theme-${k.replace(/_/g, '-')}`, v);
        }
        document.documentElement.style.setProperty('--tg-theme-bg-color', params.bg_color);
      });
    }, { data: initData, params: theme });

    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  ⚠️ ошибка на странице (${themeName}): ${e.message}`));

    // PREVIEW_ONLY=crm,glavnaya — снять только перечисленные экраны.
    const only = (process.env.PREVIEW_ONLY || '').split(',').filter(Boolean);
    for (const shot of SHOTS.filter((x) => !only.length || only.includes(x.name))) {
      // Предел частоты рассчитан на человека, а снимки идут подряд: без сброса экран после двадцатого получал «Слишком много запросов».
      forgetRate();
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app .screen', { timeout: 15000 });
      /*
       * Дождаться ухода заставки. Экран под ней готов почти сразу, а сама
       * она держится около полутора секунд — и без этого ожидания все
       * снимки до одного оказывались заставкой: витрина приложения из
       * двадцати одинаковых картинок с логотипом.
       */
      // state: 'attached' — потому что ушедшая заставка это display: none,
      // а обычное ожидание ждёт видимый элемент и не дождалось бы никогда.
      await page.waitForSelector('#splash.gone', { state: 'attached', timeout: 15000 })
        .catch(() => {});
      if (shot.go) {
        await page.evaluate(([name, params]) => window.__go(name, params), shot.go);
        await page.waitForTimeout(400);
      }
      // Экран может показывать главное только после действия — например,
      // выписка пуста, пока не загружен файл. Пустая витрина бесполезна.
      if (shot.act) {
        // eslint-disable-next-line no-await-in-loop
        await shot.act(page);
      }
      if (shot.scroll === 'bottom') {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(200);
      const file = path.join(OUT, `${shot.name}-${themeName}.png`);
      await page.screenshot({ path: file, fullPage: false });
      // PREVIEW_TAPS=1 — перечислить цели нажатия меньше 44 px (с учётом расширенной зоны вокруг).
      if (process.env.PREVIEW_TAPS && themeName === 'light') {
        const small = await page.evaluate(() => {
          const out = [];
          const hit = (el, x, y) => {
            if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true;   // за экраном не проверить
            const t = document.elementFromPoint(x, y);
            return Boolean(t) && (t === el || el.contains(t));
          };
          for (const el of document.querySelectorAll('#app button, #app a[href], #app input:not([type=hidden]), #app select, #app textarea, #topbar button, #tabs button')) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
            const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
            const okH = r.width >= 44 || (hit(el, cx - 21, cy) && hit(el, cx + 21, cy));
            const okV = r.height >= 44 || (hit(el, cx, cy - 21) && hit(el, cx, cy + 21));
            if (!okH || !okV) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} «${(el.textContent || el.value || '').trim().slice(0, 30)}» ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
          return out;
        });
        for (const line of small) console.log(`  мелкая цель [${shot.name}]: ${line}`);
      }
      made.push({ file, title: shot.title, theme: themeName });
    }
    await ctx.close();
  }

  await browser.close();
  await new Promise((r) => server.close(r));

  console.log(`\nСнимки в ${OUT}:`);
  for (const m of made) console.log(`  ${m.title} (${m.theme}) — ${path.basename(m.file)}`);
  process.exit(0);
}

// Показательные данные нужны и записи демо-ролика (tools/demo-video.js) —
// заводить их во второй раз значило бы разойтись с тем, что на снимках.
module.exports = { seed, USER };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
