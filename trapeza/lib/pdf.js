'use strict';

/**
 * HTML → PDF через headless Chromium. Кириллица и точная вёрстка.
 * Если Chromium недоступен, вызывающий код отправит HTML для печати.
 *
 * Браузер держим один на всех и закрываем по простою. Запуск Chromium —
 * это секунда времени и сотни мегабайт памяти; поднимать его на каждый
 * счёт нельзя, особенно на сервере с 2 ГБ, где два одновременных
 * документа съедали бы всю память.
 */

let _chromium; // undefined = не пробовали, null = недоступен
let launches = 0; // сколько раз поднимали браузер

/*
 * Где искать Playwright.
 *
 * PLAYWRIGHT_DIR первым, потому что на сервере пакет стоит глобально, а
 * глобальная папка модулей в обычный поиск Node не входит: require('playwright')
 * из /opt/trapeza её не видит, хотя пакет установлен. Путь до неё знает тот,
 * кто ставил (deploy/playwright.sh), — он его и передаёт службам.
 *
 * Ниже — прежние пути: обычный поиск для тех, у кого пакет в зависимостях, и
 * жёстко прописанная глобальная папка нашего сервера как последняя попытка.
 */
function loadChromium() {
  if (_chromium !== undefined) return _chromium;
  const candidates = [
    process.env.PLAYWRIGHT_DIR,
    'playwright', 'playwright-core',
    '/opt/node22/lib/node_modules/playwright',
    '/opt/node22/lib/node_modules/playwright-core',
  ].filter(Boolean);
  for (const p of candidates) {
    try { _chromium = require(p).chromium; return _chromium; } catch (_) { /* ignore */ }
  }
  _chromium = null;
  return _chromium;
}

function pdfAvailable() {
  return Boolean(loadChromium());
}

// ─────────────────── общий браузер с закрытием по простою ───────────────────

const IDLE_MS = Number(process.env.PDF_IDLE_MS || 120000);
let browser = null;
let idleTimer = null;
let busy = 0;
let starting = null;

function scheduleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (busy > 0 || !browser) return;
    const b = browser;
    browser = null;
    try { await b.close(); } catch (_) { /* уже упал */ }
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref(); // не держим процесс живым ради таймера
}

async function getBrowser() {
  const chromium = loadChromium();
  if (!chromium) throw new Error('Chromium/Playwright недоступен');
  if (browser && browser.isConnected && browser.isConnected()) return browser;
  if (starting) return starting;

  const launch = {
    // Без этого Chromium падает в контейнерах с маленьким /dev/shm.
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;

  launches += 1;   // счётчик запусков: по нему проверяют переиспользование
  starting = chromium.launch(launch).then((b) => {
    browser = b;
    starting = null;
    // Если браузер умер сам (нехватка памяти, обновление) — забудем ссылку,
    // следующий вызов поднимет заново, а не будет биться в закрытый канал.
    b.on('disconnected', () => { if (browser === b) browser = null; });
    return b;
  }).catch((e) => { starting = null; throw e; });

  return starting;
}

/** Одна попытка рендера в уже поднятом браузере. */
async function renderOnce(html, opts) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
      ...opts,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function htmlToPdf(html, opts = {}) {
  busy += 1;
  try {
    try {
      return await renderOnce(html, opts);
    } catch (e) {
      // Браузер мог умереть между вызовами — пробуем один раз с нуля.
      if (browser) { try { await browser.close(); } catch (_) { /* ignore */ } browser = null; }
      return await renderOnce(html, opts);
    }
  } finally {
    busy -= 1;
    scheduleClose();
  }
}

async function htmlToPng(html, filePath, opts = {}) {
  busy += 1;
  try {
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2 });
    try {
      await page.setContent(html, { waitUntil: 'load' });
      await page.screenshot({ path: filePath, fullPage: true, ...opts });
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    busy -= 1;
    scheduleClose();
  }
}

/** Закрыть браузер сразу — для тестов и корректного завершения службы. */
async function closePdf() {
  clearTimeout(idleTimer);
  if (browser) {
    const b = browser;
    browser = null;
    await b.close().catch(() => {});
  }
}

module.exports = {
  pdfAvailable, htmlToPdf, htmlToPng, closePdf, loadChromium,
  /** Сколько раз поднимался браузер — для проверки переиспользования. */
  launches: () => launches,
};
