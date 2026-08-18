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
  { go: ['new', { type: 'sch' }], hold: 2200, shot: 'vypisat-schet' },
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
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
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
    window.Telegram = { WebApp: {
      initData: data, initDataUnsafe: {}, themeParams: {}, colorScheme: 'light',
      ready: noop, expand: noop, close: noop, openLink: noop, setHeaderColor: noop,
      disableVerticalSwipes: noop,
      BackButton: { show: noop, hide: noop, onClick: noop },
      MainButton: { setParams() { return this; }, show() { return this; }, hide() { return this; },
        onClick: noop, offClick: noop, showProgress: noop, hideProgress: noop },
      HapticFeedback: { impactOccurred: noop, notificationOccurred: noop },
    } };
  }, initData());

  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app .screen');
  await page.waitForTimeout(1200);

  for (const scene of SCENES) {
    await page.evaluate(([name, params]) => window.__go(name, params), scene.go);
    await page.waitForSelector('#app .screen');
    await page.waitForTimeout(scene.hold);
    if (scene.shot) {
      await page.screenshot({ path: path.join(OUT, `${scene.shot}.png`) });
    }
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
  process.exit(0);
})().catch((e) => { console.error('ЗАПИСЬ УПАЛА:', e); process.exit(1); });
