'use strict';
// Заявка должна уносить с собой ссылку на сохранённую смету.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'site-new');
const OUT = __dirname;
const PORT = 4450;
const B = `http://127.0.0.1:${PORT}`;
let bad = 0;
const ok = (c, m, extra) => { console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra)); if (!c) bad += 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(path.join(ROOT, 'smeta'), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'smeta'), { recursive: true });
  const php = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', ROOT], { stdio: 'ignore' });
  await wait(1200);

  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 950 } });
  await p.route('**fonts.g**', (r) => r.abort());
  await p.route('**yandex**', (r) => r.abort());
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const posted = [];
  await p.route('**/trapeza-forms.glag90228.workers.dev/**', async (route) => {
    posted.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await p.goto(B + '/kalkulyator.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1100);

  // поиск: «семга» без ё и два слова в любом порядке
  await p.fill('#kb-q', 'семга');
  await p.waitForTimeout(350);
  const s1 = await p.locator('.kb-card').count();
  ok(s1 >= 4, 'поиск «семга» без ё находит блюда: ' + s1);
  await p.fill('#kb-q', 'мясо перепечи');
  await p.waitForTimeout(350);
  const s2 = await p.locator('.kb-card').count();
  ok(s2 === 2, 'поиск двумя словами в любом порядке: ' + s2);
  await p.fill('#kb-q', 'салат');
  await p.waitForTimeout(350);
  ok(await p.locator('.kb-switch').count() === 1, 'подсказка «показать в банкетном меню» появилась');
  await p.click('.kb-switch');
  await p.waitForTimeout(500);
  const s3 = await p.locator('.kb-card').count();
  ok(s3 >= 15, 'переключение на банкетное меню из поиска: ' + s3);
  await p.click('#kb-type button[data-type="furshet"]');
  await p.fill('#kb-q', '');
  await p.waitForTimeout(400);

  // собираем заказ и отправляем заявку
  for (let i = 0; i < 3; i++) { await p.locator('.kb-add').first().click(); await p.waitForTimeout(160); }
  await p.click('#kb-make');
  await p.waitForTimeout(700);
  await p.fill('#kb-name', 'Иван Петров');
  await p.fill('#kb-phone', '+7 912 111-22-33');
  await p.fill('#kb-place', 'ул. Пушкина, 10');
  await p.fill('#kb-comment', 'Без орехов');
  await p.check('#kb-consent');
  await p.evaluate(() => { try { localStorage.removeItem('trapeza_last'); } catch (e) {} });
  await p.click('#kb-send');
  await p.waitForTimeout(1500);

  ok(posted.length === 1, 'заявка ушла', posted.length);
  const d = posted[0] || {};
  const url = d['Смета'] || '';
  ok(/\/smeta\/\d{6}-[0-9a-f]{16}\.html$/.test(url), 'в заявке есть ссылка на смету', url);
  const saved = fs.readdirSync(path.join(ROOT, 'smeta')).filter((f) => f.endsWith('.html'));
  ok(saved.length === 1, 'файл сметы сохранён на сервере', saved.join(', '));
  ok(!(await p.locator('#kb-ok a').isHidden()), 'клиенту показана ссылка на смету');

  // открываем сохранённую смету
  const page2 = await b.newPage({ viewport: { width: 1280, height: 950 } });
  await page2.route('**fonts.g**', (r) => r.abort());
  const local = url.replace(/^https?:\/\/[^/]+/, B);
  await page2.goto(local, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(400);
  const txt = await page2.textContent('body');
  ok(txt.includes('СМЕТА') && txt.includes('Иван Петров'), 'смета открывается и содержит заказчика');
  ok(txt.includes('Без орехов'), 'комментарий попал в смету');
  ok((await page2.locator('.bill tbody tr').count()) >= 4, 'позиции в смете на месте');
  ok((await page2.locator('meta[name=robots]').getAttribute('content')).includes('noindex'),
    'сохранённая смета закрыта от поисковиков');
  await page2.screenshot({ path: OUT + '/70-saved-smeta.png', fullPage: true });

  // подстановка чужого HTML не проходит
  const evil = await p.evaluate(async (base) => {
    const r = await fetch(base + '/smeta.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guests: 5, transport: 0,
        items: [{ n: '<script>alert(1)</scr' + 'ipt>', u: 'шт', q: 1, p: 10 }] }),
    });
    return r.json();
  }, B);
  const evilFile = fs.readFileSync(path.join(ROOT, 'smeta',
    evil.url.split('/').pop()), 'utf8');
  ok(!evilFile.includes('<script>alert(1)'), 'HTML из заказа экранируется, а не выполняется');

  ok(errs.length === 0, 'ошибок JS нет' + (errs.length ? ': ' + errs.join('; ') : ''));

  await b.close();
  php.kill();
  console.log(bad ? `\nне прошло: ${bad}` : '\nсмета и поиск работают ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ТЕСТ УПАЛ:', e.message); process.exit(1); });
