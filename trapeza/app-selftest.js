'use strict';

/**
 * Проверка жестов приложения настоящими касаниями.
 *
 * Всё остальное в мини-приложении проверяется запросами к серверу, но жест
 * живёт только в браузере: обработчики висят на touch-событиях, и мышью их
 * не воспроизвести. Утверждать «смахивание работает» можно, лишь подвигав
 * пальцем — пусть и синтетическим.
 *
 *   TRAPEZA_DB=/tmp/app.db node app-selftest.js
 *
 * Без Chromium прогон честно сообщает, что пропущен, и не падает.
 */

require('./selftest-db');   // своя база на прогон — до всего, что тянет db.js
const crypto = require('node:crypto');
const path = require('node:path');

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '111:SWIPE-TOKEN';
process.env.FREE_DOCS = '50';
const TOKEN = process.env.BOT_TOKEN;

const APP = __dirname;
const bdb = require(path.join(APP, 'lib/bot-db'));
const docService = require(path.join(APP, 'lib/doc-service'));
const { server, setTelegram } = require(path.join(APP, 'miniapp'));

const USER = { id: 515151, first_name: 'Мария', username: 'masha' };

function initData() {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(USER) };
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const q = new URLSearchParams(fields);
  q.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return q.toString();
}

let bad = 0;
const ok = (c, m, extra) => {
  console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra));
  if (!c) bad += 1;
};

(async () => {
  const user = bdb.getOrCreateUser(USER.id, 'Мария', 'masha');
  bdb.saveMyOrg(user.id, { name: 'ИП Тест', inn: '183209316119', signer: 'И. Т.' });
  const cp = bdb.createCp(user.id, { name: 'ООО «Клиент»', kind: 'customer', opening_date: '2026-01-01' });
  for (const n of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    await docService.issueDocument(user.id, {
      type: 'sch', cpId: cp, items: [{ name: `Услуга ${n}`, qty: 1, price: 1000 * n }], skipQuota: true,
    });
  }

  setTelegram({ async sendDocument() { return {}; } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const chromium = require(path.join(APP, 'lib/pdf')).loadChromium();
  if (!chromium) {
    console.log('  ·  Chromium недоступен — проверка жестов пропущена');
    await new Promise((r) => server.close(r));
    process.exit(0);
  }
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ru-RU',
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
  page.on('pageerror', (e) => ok(false, `ошибка страницы: ${e.message}`));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app .screen');
  await page.evaluate(() => window.__go('docs', {}));
  await page.waitForSelector('.swipe-face');

  const before = await page.evaluate(() => document.querySelectorAll('.swipe').length);
  ok(before === 3, 'три документа в списке', before);

  const shiftOf = () => page.evaluate(() => {
    const m = /translateX\((-?[\d.]+)px\)/.exec(document.querySelector('.swipe-face').style.transform || '');
    return m ? Math.round(Number(m[1])) : 0;
  });

  /** Провести пальцем от точки внутри первой строки. */
  async function swipe(dxTotal, dyTotal) {
    const box = await page.locator('.swipe-face').first().boundingBox();
    const x = box.x + box.width - 40;
    const y = box.y + box.height / 2;
    await page.evaluate(([sx, sy, dx, dy]) => {
      const el = document.elementFromPoint(sx, sy).closest('.swipe-face');
      // TouchEventInit требует настоящих Touch, а не объектов-двойников.
      const touch = (cx, cy) => [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })];
      el.dispatchEvent(new TouchEvent('touchstart', { touches: touch(sx, sy), bubbles: true }));
      for (let i = 1; i <= 6; i += 1) {
        el.dispatchEvent(new TouchEvent('touchmove', {
          touches: touch(sx + (dx * i) / 6, sy + (dy * i) / 6), bubbles: true,
        }));
      }
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    }, [x, y, dxTotal, dyTotal]);
    await page.waitForTimeout(260);
  }

  console.log('\n── смахивание ──');
  await swipe(-120, 0);
  ok(await shiftOf() === -92, 'смахнули влево — строка открылась на ширину кнопки', await shiftOf());
  ok(await page.locator('.swipe-del').first().isVisible(), 'кнопка удаления видна');

  await swipe(120, 0);
  ok(await shiftOf() === 0, 'смахнули обратно — строка закрылась', await shiftOf());

  await swipe(-20, 0);
  ok(await shiftOf() === 0, 'короткое движение не открывает', await shiftOf());

  // Вертикальное движение — это прокрутка списка, строка не должна ехать.
  await swipe(-60, -140);
  ok(await shiftOf() === 0, 'вертикальный жест отдан прокрутке', await shiftOf());

  console.log('\n── удаление ──');
  await swipe(-120, 0);
  const first = await page.evaluate(() => document.querySelector('.swipe-face .ellipsis').textContent);
  const btn = await page.locator('.swipe-del').first().boundingBox();
  await page.touchscreen.tap(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => document.querySelectorAll('.swipe').length);
  ok(after === 2, 'после нажатия на кнопку документ удалён', `${before} → ${after}`);
  const nowFirst = await page.evaluate(() => document.querySelector('.swipe-face .ellipsis').textContent);
  ok(nowFirst !== first, 'удалился именно тот, что смахнули', `${first} → ${nowFirst}`);
  ok(bdb.listDocs(user.id, 50).length === 2, 'в базе тоже два', bdb.listDocs(user.id, 50).length);

  /*
   * Начальное сальдо: по цифре вверху карточки и тыкают.
   *
   * Жалоба была «тыкаю на цифры и нифига»: строка сальдо стояла первой в
   * карточке, выглядела как соседние — нажимаемые, — а была мёртвым div.
   * Поля же лежали экраном ниже, за реквизитами и почтой. Проверяем
   * настоящим касанием, что строка ведёт к полю и что поле принимает ввод.
   */
  console.log('\n── начальное сальдо ──');
  await page.evaluate((cpId) => window.__go('cp', { id: cpId }), cp);
  await page.waitForSelector('#f-opening_balance');

  const row = await page.locator('.card .row').first().boundingBox();
  await page.touchscreen.tap(row.x + row.width / 2, row.y + row.height / 2);
  await page.waitForTimeout(700);
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'f-opening_balance',
    'нажатие на сальдо ведёт к полю начального сальдо',
    await page.evaluate(() => document.activeElement && document.activeElement.id));
  ok(await page.evaluate(() => {
    const r = document.getElementById('f-opening_balance').getBoundingClientRect();
    return r.top > 0 && r.bottom < window.innerHeight;
  }), 'и поле оказалось на экране, а не за его краем');

  await page.locator('#f-opening_balance').fill('15000');
  await page.locator('#f-opening_date').fill('2026-01-01');
  await page.getByText('Сохранить', { exact: true }).click();
  await page.waitForTimeout(900);
  const savedCp = bdb.getCp(user.id, cp);
  ok(Number(savedCp.opening_balance) === 15000 && savedCp.opening_date === '2026-01-01',
    'сальдо и дата сохранились', `${savedCp.opening_balance} / ${savedCp.opening_date}`);

  /*
   * Крупная цифра на главной.
   *
   * Жалоба та же, что и про сальдо, только громче: «счета удаляю, а сумма
   * на главной прежняя». Здесь она законна — при основании «по отгрузке»
   * счёт долга не создаёт, и всю сумму держит начальное сальдо, — но пока
   * цифра молчит, это неотличимо от поломки. Проверяем настоящим касанием,
   * что по ней можно нажать и что разбор называет источник.
   */
  console.log('\n── из чего сумма на главной ──');
  await page.evaluate(() => window.__go('home', {}));
  await page.waitForSelector('.hero .sum');
  ok(await page.evaluate(() => document.querySelector('.hero .sum').textContent.replace(/\s/g, ''))
    === '15000₽', 'на главной видно сальдо контрагента',
  await page.evaluate(() => document.querySelector('.hero .sum').textContent));

  const hero = await page.locator('.hero .tap').boundingBox();
  await page.touchscreen.tap(hero.x + hero.width / 2, hero.y + 20);
  await page.waitForTimeout(700);
  ok(await page.evaluate(() => document.querySelector('h1') && document.querySelector('h1').textContent)
    === 'Из чего эта сумма', 'нажатие на цифру ведёт к разбору',
  await page.evaluate(() => document.querySelector('h1') && document.querySelector('h1').textContent));

  const rows = await page.evaluate(() => [...document.querySelectorAll('.card .row .ellipsis')]
    .map((el) => el.textContent));
  ok(rows.includes('Начальное сальдо'), 'и разбор называет источник — начальное сальдо', rows.join(', '));
  ok(!rows.includes('Документы'), 'а документов в сумме нет: при «долге по отгрузке» счёт её не создаёт');

  await browser.close();
  await new Promise((r) => server.close(r));
  await require(path.join(APP, 'lib/pdf')).closePdf();
  console.log(bad ? `\nне прошло: ${bad}` : '\nсмахивание работает ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ПРОГОН УПАЛ:', e); process.exit(1); });
