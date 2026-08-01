'use strict';

// HTML → PDF через headless Chromium (Playwright). Кириллица и точная вёрстка.
// Если Chromium недоступен на сервере — вызывающий код отправит HTML для печати.

let _chromium; // undefined = не пробовали, null = недоступен

function loadChromium() {
  if (_chromium !== undefined) return _chromium;
  const candidates = [
    'playwright', 'playwright-core',
    '/opt/node22/lib/node_modules/playwright',
    '/opt/node22/lib/node_modules/playwright-core',
  ];
  for (const p of candidates) {
    try { _chromium = require(p).chromium; return _chromium; } catch (_) { /* ignore */ }
  }
  _chromium = null;
  return _chromium;
}

function pdfAvailable() {
  return Boolean(loadChromium());
}

async function htmlToPdf(html, opts = {}) {
  const chromium = loadChromium();
  if (!chromium) throw new Error('Chromium/Playwright недоступен');
  const launch = {};
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const buf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
      ...opts,
    });
    return buf;
  } finally {
    await browser.close();
  }
}

async function htmlToPng(html, path, opts = {}) {
  const chromium = loadChromium();
  if (!chromium) throw new Error('Chromium/Playwright недоступен');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path, fullPage: true, ...opts });
  } finally {
    await browser.close();
  }
}

module.exports = { pdfAvailable, htmlToPdf, htmlToPng };
