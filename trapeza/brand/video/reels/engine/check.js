'use strict';
// Открывает собранный index.html в Chromium, гоняет таймлайн по всей длине и печатает ошибки JS.
// Рендер HyperFrames на ошибке не останавливается, а молча выдаёт пустые кадры, поэтому проверяем до рендера.
//
//   node engine/check.js mody/out/index.html
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const file = path.resolve(process.argv[2] || 'index.html');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => errs.push('нет файла: ' + r.url()));
  await page.goto('file://' + file);
  await page.waitForTimeout(800);
  const res = await page.evaluate(() => {
    const tls = Object.values(window.__timelines || {});
    if (!tls.length) return 'таймлайн не зарегистрирован';
    const tl = tls[0], d = tl.duration();
    for (let t = 0; t <= d; t += 0.25) tl.seek(t, false);
    return 'длина ' + d.toFixed(2) + ' с';
  }).catch((e) => 'evaluate: ' + e.message);
  await browser.close();
  console.log(res);
  if (errs.length) { console.log(errs.join('\n')); process.exit(1); }
  console.log('ошибок нет');
})();
