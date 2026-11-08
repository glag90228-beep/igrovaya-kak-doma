'use strict';

/**
 * Запись демонстрации мини-приложения — настоящим Chromium, с живого кода.
 *
 *   TRAPEZA_DB=/tmp/demo.db node tools/demo-video.js [папка]
 *
 * Зачем. Для рекламы нужен ролик, где приложение работает. Нарисованный
 * интерфейс для этого не годится: он врёт про продукт, а через месяц ещё и
 * расходится с ним. Здесь снимается то, что действительно работает — на
 * показательных данных, но настоящим кодом и настоящими документами.
 *
 * Получается webm (Playwright пишет только его) и набор кадров PNG. Если в
 * системе есть ffmpeg, рядом кладётся mp4 — его просят рекламные кабинеты.
 * Тот ffmpeg, что стоит вместе с Playwright, для этого не годится: он собран
 * под запись webm и mp4 не умеет.
 *
 * Данные показательные и выдуманные: настоящих клиентов и сумм в рекламе
 * быть не должно.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const APP = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(APP, 'demo-out'));
fs.mkdirSync(OUT, { recursive: true });

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '111:DEMO-TOKEN';
process.env.FREE_DOCS = process.env.FREE_DOCS || '50';
const TOKEN = process.env.BOT_TOKEN;

const { server, setTelegram } = require(path.join(APP, 'miniapp'));
const preview = require(path.join(APP, 'miniapp-preview.js'));

const USER = preview.USER;

function initData() {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(USER) };
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const q = new URLSearchParams(fields);
  q.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return q.toString();
}

/** Кадры ролика: что показываем и сколько держим. */
const SCENES = [
  { go: ['home', {}], hold: 2600, shot: 'glavnaya', scroll: 420 },
  {
    go: ['new', { type: 'sch' }],
    hold: 1400,
    shot: 'vypisat-schet',
    // Счёт выписывается по-настоящему: заполняем позицию и жмём кнопку.
    // Ради этого кадра всё и снимается — «пришёл готовый документ».
    async act(page) {
      await page.locator('#f-cp').selectOption({ index: 0 });
      await page.waitForTimeout(600);
      const name = page.locator('.item input.name').first();
      await name.click();
      await name.type('Монтаж оборудования', { delay: 55 });
      await page.waitForTimeout(400);
      const nums = page.locator('.nums input');
      await nums.nth(1).fill('');
      await nums.nth(1).type('24000', { delay: 70 });
      await page.waitForTimeout(1100);
      await page.screenshot({ path: path.join(OUT, 'schet-zapolnen.png') });
      await page.locator('#tg-main-button').click();
      await page.waitForTimeout(2600);
      await page.screenshot({ path: path.join(OUT, 'schet-gotov.png') });
      await page.waitForTimeout(1200);
    },
  },
  {
    // Самый нужный кадр: что именно человек получит. Раньше в ролике был
    // только всплывающий «файл отправлен в чат», а сам счёт не показан —
    // покупатель как раз хочет увидеть документ, а не сообщение о нём.
    // HTML берётся тем же генератором, что печатает боевой PDF, поэтому
    // это настоящий документ, а не картинка «как бы счёта».
    go: ['docs', {}],
    hold: 600,
    async act(page) {
      const bdb = require(path.join(APP, 'lib/bot-db'));
      const { buildSchetHtml } = require(path.join(APP, 'lib/schet'));
      const user = bdb.getOrCreateUser(USER.id);
      const org = bdb.getDefaultOrg(user.id);
      const doc = bdb.listDocs(user.id, 30).find((d) => d.type === 'sch');
      if (!doc) return;
      const cp = bdb.getCp(user.id, doc.cp_id);
      const html = await buildSchetHtml({
        org: { ...org, org_short: org.name, org_full: org.full_name, org_inn: org.inn },
        cp,
        doc: { number: doc.number, date: doc.date, items: (doc.payload || {}).items || [] },
      });
      const sheet = await page.context().newPage();
      await sheet.setViewportSize({ width: 780, height: 1688 });
      await sheet.setContent(html, { waitUntil: 'networkidle' });
      // Лист А4 наполовину пустой, а в вертикальном кадре из-за этого текст
      // мельчает до нечитаемого. Режем по нижнему краю содержимого.
      const bottom = await sheet.evaluate(() => {
        let low = 0;
        for (const el of document.body.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.height && r.bottom > low) low = r.bottom;
        }
        return Math.ceil(low + 24);
      });
      await sheet.screenshot({
        path: path.join(OUT, 'dokument.png'),
        clip: { x: 0, y: 0, width: 780, height: Math.max(400, bottom) },
      });
      await sheet.close();
      // Показываем лист поверх приложения — как будто открыли присланный файл.
      const png = fs.readFileSync(path.join(OUT, 'dokument.png')).toString('base64');
      await page.evaluate((b64) => {
        const wrap = document.createElement('div');
        wrap.id = 'demo-doc';
        wrap.style.cssText = 'position:fixed;inset:0;background:#5a6472;z-index:99999;'
          + 'display:flex;align-items:flex-start;justify-content:center;padding:18px;'
          + 'overflow:hidden;opacity:0;transition:opacity .35s';
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${b64}`;
        img.style.cssText = 'width:100%;border-radius:8px;box-shadow:0 18px 50px rgba(0,0,0,.45)';
        wrap.appendChild(img);
        document.body.appendChild(wrap);
        requestAnimationFrame(() => { wrap.style.opacity = '1'; });
      }, png);
      await page.waitForTimeout(3400);
      await page.evaluate(() => {
        const w = document.getElementById('demo-doc');
        if (w) { w.style.opacity = '0'; setTimeout(() => w.remove(), 400); }
      });
      await page.waitForTimeout(700);
    },
  },
  { go: ['docs', {}], hold: 2400, shot: 'zhurnal', scroll: 260 },
  { go: ['cps', {}], hold: 2000, shot: 'klienty' },
  { go: ['akt', {}], hold: 2600, shot: 'akt-sverki', scroll: 300 },
  { go: ['debts', {}], hold: 2200, shot: 'dolgi' },
  { go: ['home', {}], hold: 1800, shot: 'final' },
];

(async () => {
  await preview.seed();
  setTelegram({ async sendDocument() { return {}; } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const chromium = require(path.join(APP, 'lib/pdf')).loadChromium();
  if (!chromium) {
    console.log('Chromium недоступен — записать нечего.');
    await new Promise((r) => server.close(r));
    process.exit(1);
  }
  /*
   * Поля <input type=date> Chromium рисует по локали своего процесса, а не по
   * locale страницы: без этого в ролике про российскую бухгалтерию даты
   * выглядят как 08/18/2026 и mm/dd/yyyy. Флаг --lang на это не влияет,
   * проверено — решает именно LANG в окружении процесса браузера.
   */
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=ru-RU'],
    env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru_RU' },
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    // Пишем в размер вдвое больше экрана: ролик пойдёт в вертикальные
    // форматы, где мыло заметно сразу.
    recordVideo: { dir: OUT, size: { width: 780, height: 1688 } },
  });
  await ctx.addInitScript((data) => {
    const noop = () => {};
    /*
     * Главную кнопку рисует сам Telegram, под окном приложения, — в браузере
     * её нет. В ролике это заметно: экран выписки документа остаётся без
     * действия, будто счёт выставить нечем. Поэтому рисуем её сами, как в
     * мессенджере: снизу, во всю ширину, с текстом от приложения.
     */
    let btn = null;
    const ensure = () => {
      if (btn) return btn;
      btn = document.createElement('button');
      btn.id = 'tg-main-button';
      btn.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;height:50px;'
        + 'border:0;border-radius:12px;background:#2481cc;color:#fff;font:600 16px/1 '
        + '-apple-system,system-ui,sans-serif;z-index:9999;display:none;box-shadow:'
        + '0 6px 20px rgba(36,129,204,.35)';
      document.body.appendChild(btn);
      return btn;
    };
    const main = {
      setParams(p) {
        const b = ensure();
        if (p && p.text) b.textContent = p.text;
        b.style.opacity = p && p.is_active === false ? '.45' : '1';
        return this;
      },
      show() { ensure().style.display = 'block'; return this; },
      hide() { ensure().style.display = 'none'; return this; },
      onClick(fn) { ensure().onclick = fn; },
      offClick() { ensure().onclick = null; },
      showProgress: noop, hideProgress: noop,
    };
    window.Telegram = { WebApp: {
      initData: data, initDataUnsafe: {}, themeParams: {}, colorScheme: 'light',
      ready: noop, expand: noop, close: noop, openLink: noop, setHeaderColor: noop,
      disableVerticalSwipes: noop,
      BackButton: { show: noop, hide: noop, onClick: noop },
      MainButton: main,
      HapticFeedback: { impactOccurred: noop, notificationOccurred: noop },
    } };
  }, initData());

  const page = await ctx.newPage();
  // Ноль отсчёта — здесь: запись начинается с появлением страницы, а не с
  // первой сцены. Иначе все отсечки в монтажном листе уехали бы на полторы
  // секунды, и монтажёр резал бы мимо.
  const startedAt = Date.now();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app .screen');
  await page.waitForTimeout(1200);

  /*
   * Отсечки печатаем в конце: без них монтажный лист приходится составлять
   * на глаз, пересматривая ролик. Отсчёт от первого кадра записи, а не от
   * старта процесса, — Playwright пишет с момента открытия страницы.
   */
  const marks = [];
  const stamp = (ms) => {
    const t = Math.round(ms / 1000);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  for (const scene of SCENES) {
    const from = Date.now() - startedAt;
    await page.evaluate(([name, params]) => window.__go(name, params), scene.go);
    await page.waitForSelector('#app .screen');
    await page.waitForTimeout(scene.hold);
    if (scene.shot) {
      await page.screenshot({ path: path.join(OUT, `${scene.shot}.png`) });
    }
    if (scene.act) await scene.act(page);
    // Прокрутка человеческой рукой: короткими шагами, а не рывком.
    if (scene.scroll) {
      for (let done = 0; done < scene.scroll; done += 60) {
        // eslint-disable-next-line no-await-in-loop
        await page.mouse.wheel(0, 60);
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(90);
      }
      await page.waitForTimeout(900);
      await page.mouse.wheel(0, -scene.scroll);
      await page.waitForTimeout(700);
    }
    marks.push({
      name: scene.shot || scene.go[0],
      from: stamp(from),
      to: stamp(Date.now() - startedAt),
    });
    console.log(`  снято: ${scene.shot || scene.go[0]}`);
  }

  const video = page.video();
  await ctx.close();                       // на закрытии контекста ролик дописывается
  const raw = await video.path();
  const webm = path.join(OUT, 'demo.webm');
  fs.renameSync(raw, webm);
  await browser.close();
  await new Promise((r) => server.close(r));
  await require(path.join(APP, 'lib/pdf')).closePdf();

  /*
   * mp4 — только системным ffmpeg. Тот, что лежит рядом с браузером
   * Playwright, собран под одну задачу: писать webm. Мультиплексора mp4 в
   * нём нет, и попытка кончается «Unable to choose an output format».
   */
  let mp4 = path.join(OUT, 'demo.mp4');
  try {
    execFileSync('ffmpeg', ['-y', '-i', webm, '-c:v', 'libx264', '-preset', 'slow',
      '-crf', '20', '-pix_fmt', 'yuv420p', mp4], { stdio: 'ignore' });
  } catch (_) {
    mp4 = '';
  }

  const size = (f) => `${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} МБ`;
  console.log(`\nГотово, в ${OUT}:`);
  console.log(`  demo.webm — ${size(webm)}`);
  if (mp4) console.log(`  demo.mp4  — ${size(mp4)}`);
  else console.log('  mp4 не собран: нет системного ffmpeg. webm понимают браузеры,\n                   Telegram и все монтажки; для mp4 —  ffmpeg -i demo.webm demo.mp4');
  console.log(`  кадры PNG — ${SCENES.filter((s) => s.shot).length} шт.`);
  console.log('\nМонтажный лист:');
  for (const m of marks) console.log(`  ${m.from}–${m.to}  ${m.name}`);
  fs.writeFileSync(path.join(OUT, 'montazh.txt'),
    `${marks.map((m) => `${m.from}–${m.to}\t${m.name}`).join('\n')}\n`);
  process.exit(0);
})().catch((e) => { console.error('ЗАПИСЬ УПАЛА:', e); process.exit(1); });
