'use strict';
// Снимает настоящие экраны мини-приложения Первички на ДЕМО-данных (вымышленные клиенты, суммы — «ПРИМЕР»).
// Запуск (из trapeza/): env -u TRAPEZA_DB node brand/video/reels/pervichka-reklama/shoot.js
const path = require('node:path');
const APP = path.resolve(__dirname, '../../../..');
process.chdir(APP);
require(APP + '/selftest-db');
const crypto = require('node:crypto');
process.env.BOT_TOKEN = '111:SIM'; process.env.FREE_DOCS = '1000';
for (const k of ['GEMINI_API_KEY', 'AI_PROVIDER', 'AI_ENABLED', 'SPEECH_PROVIDER', 'VISION_PROVIDER']) delete process.env[k];
const bdb = require(APP + '/lib/bot-db'), ds = require(APP + '/lib/doc-service');
const { server, setTelegram } = require(APP + '/miniapp');
const OUT = path.join(__dirname, 'shots');
const USER = { id: 990777, first_name: 'Сергей', username: 'demo' };
const initData = () => { const f = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(USER) };
  const check = Object.entries(f).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update('111:SIM').digest(); const q = new URLSearchParams(f);
  q.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex')); return q.toString(); };
(async () => {
  const u = bdb.getOrCreateUser(USER.id, 'Сергей', 'demo');
  bdb.saveMyOrg(u.id, { name: 'ИП Орлов С. А.', inn: '500100732259', bank_name: 'Банк Пример', bik: '044525225', acc: '40802810000000000001', corr_acc: '30101810400000000225', address: 'Москва', debt_basis: 'invoice' });
  const mk = (name, inn) => bdb.createCp(u.id, { name, inn, kind: 'customer', opening_date: '2026-01-01' });
  const rows = [['ООО «Вектор»', '7707083893', 82000, 'Монтаж и настройка'], ['ИП Заря А. В.', '500100732260', 40500, 'Обслуживание за месяц'], ['ООО «Луч»', '7728168971', 25500, 'Консультации']];
  const ids = [];
  for (const [n, inn, sum, what] of rows) {
    const cp = mk(n, inn);
    const r = await ds.issueDocument(u.id, { type: 'sch', cpId: cp, items: [{ name: what, qty: 1, price: sum }], date: '2026-11-03', skipQuota: true });
    ids.push({ cp, doc: r.doc.id });
  }
  setTelegram({ async sendDocument() { return {}; }, async sendMessage() { return {}; } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chromium = require(APP + '/lib/pdf').loadChromium();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, locale: 'ru-RU' });
  await ctx.route('https://telegram.org/**', (r) => r.abort());
  await ctx.addInitScript((d) => { const n = () => {}; window.Telegram = { WebApp: { initData: d, initDataUnsafe: {}, themeParams: {}, colorScheme: 'light', ready: n, expand: n, close: n, openLink: n, setHeaderColor: n, disableVerticalSwipes: n, BackButton: { show: n, hide: n, onClick: n }, MainButton: { setParams() { return this; }, show() { return this; }, hide() { return this; }, onClick: n, offClick: n, showProgress: n, hideProgress: n }, HapticFeedback: { impactOccurred: n, notificationOccurred: n } } }; }, initData());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('#app .screen');
  const snap = async (name, route, params) => { if (route) await page.evaluate(([r, p]) => window.__go(r, p), [route, params || {}]); await page.waitForTimeout(2400); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('снято', name); };
  await snap('home-debt');                                  // «148 000 ₽ ждут оплаты»
  await snap('unpaid', 'unpaid');                           // «Ждут оплаты»: три счёта
  await snap('reminders', 'reminders', { cpId: ids[0].cp });  // готовый текст напоминания
  await snap('docs', 'docs');                               // журнал документов
  await snap('cp-vektor', 'cp', { id: ids[0].cp });         // карточка клиента
  await snap('new-sch', 'new', { type: 'sch', cpId: ids[0].cp });  // форма счёта
  for (const x of ids) await bdb.markPaid(u.id, x.doc, '2026-11-06');
  await snap('home-paid', 'home');                          // «все рассчитались»
  await browser.close(); process.exit(0);
})();
