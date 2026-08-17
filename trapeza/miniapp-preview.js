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
const { server, setTelegram } = require('./miniapp');

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
  for (const d of docs) {
    // eslint-disable-next-line no-await-in-loop
    await docService.issueDocument(user.id, { ...d, skipQuota: true });
  }

  // Пара повторений — иначе экран «Каждый месяц» на снимке пустой.
  require('./lib/recurring').add(user.id, {
    cpId: ids[0], type: 'sch', payDay: 5, leadDays: 3,
    items: [{ name: 'Абонентское обслуживание', unit: 'мес.', qty: 1, price: 18000 }],
  });
  require('./lib/recurring').add(user.id, {
    cpId: ids[1], type: 'usl', day: 0,
    items: [{ name: 'Кофе-брейк по договору', unit: 'усл.', qty: 1, price: 12000 }],
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
  { name: 'kontragenty', title: 'Контрагенты', go: ['cps', {}] },
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
    if (firstCp) SHOTS.push({ name: 'kartochka-klienta', title: 'Карточка клиента', go: ['cp', { id: firstCp.id }] });
    SHOTS.push({ name: 'eshchyo', title: 'Ещё', go: ['more', {}] });
    SHOTS.push({ name: 'pochta', title: 'Почта', go: ['mail', {}] });
    SHOTS.push({ name: 'pochta-nastroyka', title: 'Подключить почту', go: ['mail.new', {}] });
    SHOTS.push({ name: 'nds', title: 'НДС', go: ['vat', {}] });
    SHOTS.push({ name: 'osnovanie-dolga', title: 'Откуда долг', go: ['basis', {}] });
    SHOTS.push({ name: 'osnovanie-dolga-nizhe', title: 'Откуда долг: вид дела', go: ['basis', {}], scroll: 'bottom' });
    SHOTS.push({ name: 'kazhdyy-mesyac', title: 'Каждый месяц', go: ['recurring', {}] });
    SHOTS.push({ name: 'zhdut-oplaty', title: 'Ждут оплаты', go: ['unpaid', {}] });
    SHOTS.push({ name: 'reestr', title: 'Реестр', go: ['registry', {}] });
    if (firstCp) SHOTS.push({ name: 'operaciya', title: 'Операция', go: ['op', { cpId: firstCp.id }] });
    SHOTS.push({ name: 'platezhka', title: 'Платёжка', go: ['other', { type: 'pp' }] });
    SHOTS.push({ name: 'dogovor', title: 'Договор', go: ['other', { type: 'dog' }] });
    SHOTS.push({ name: 'napominaniya', title: 'Напоминания', go: ['reminders', {}] });
    SHOTS.push({ name: 'podderzhka', title: 'Поддержка', go: ['support', {}] });
    SHOTS.push({ name: 'snimok', title: 'Снимок счёта', go: ['scan', {}] });
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
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
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

    for (const shot of SHOTS) {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app .screen', { timeout: 15000 });
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

main().catch((e) => { console.error(e); process.exit(1); });
