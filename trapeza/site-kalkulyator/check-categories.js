'use strict';
// Работа с категориями в панели: переименовать, объединить, перенести, поменять порядок.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, 'site-new'));
const PASS = process.env.ADMIN_PASS || '';
const PORT = 4480;
const B = `http://127.0.0.1:${PORT}`;
let bad = 0;
const ok = (c, m, extra) => { console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra)); if (!c) bad += 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const menu = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'menu.json'), 'utf8'));

(async () => {
  if (!PASS) { console.log('нужен ADMIN_PASS'); process.exit(1); }
  const php = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', ROOT], { stdio: 'ignore' });
  await wait(1200);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  await p.route('**fonts.g**', (r) => r.abort());
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', async (d) => { /* переопределяем в каждом шаге */ await d.dismiss(); });

  const login = async () => {
    fs.rmSync(path.join(ROOT, 'menu-backup', '.login'), { force: true });
    await p.goto(B + '/admin.php', { waitUntil: 'domcontentloaded' });
    // сессия могла остаться с прошлого шага — тогда формы пароля нет
    if (await p.locator('input[name=password]').count()) {
      await p.fill('input[name=password]', PASS);
      await p.click('button[type=submit]');
    }
    await p.waitForSelector('.row [data-f="c"]');
    await p.waitForTimeout(400);
  };
  const save = async () => {
    await p.click('#save');
    await p.waitForTimeout(1800);
  };
  const answer = (text) => {
    p.removeAllListeners('dialog');
    p.on('dialog', async (d) => {
      if (d.type() === 'confirm') return d.accept();
      await d.accept(text);
    });
  };

  await login();

  // ── заголовки категорий с кнопками ──
  const heads = await p.locator('.cat').count();
  ok(heads >= 20, 'категории показаны отдельными блоками: ' + heads);
  ok(await p.locator('.cat [data-cat="rename"]').count() === heads, 'у каждой категории есть кнопки управления');
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT, fullPage: false }).catch(() => {});

  // ── у строки категория выбирается списком ──
  const isSelect = await p.evaluate(() => {
    const el = document.querySelector('.row [data-f="c"]');
    return { tag: el.tagName, options: el.options.length, hasNew: !!el.querySelector('option[value="__new__"]') };
  });
  ok(isSelect.tag === 'SELECT' && isSelect.hasNew,
    'категория у блюда — выпадающий список с пунктом «новая»', JSON.stringify(isSelect));

  // ── переименование категории целиком ──
  const before = menu();
  const wasCount = before.items.filter((i) => i.c === 'Шоты' && i.mt === 'furshet').length;
  answer('Шоты и коктейли');
  await p.click('.cat[data-key="furshet|Шоты"] [data-cat="rename"]');
  await p.waitForTimeout(500);
  ok(await p.locator('.cat[data-key="furshet|Шоты и коктейли"]').count() === 1,
    'после переименования появился новый заголовок');
  await save();
  let m = menu();
  ok(m.items.filter((i) => i.c === 'Шоты и коктейли').length === wasCount
    && m.items.filter((i) => i.c === 'Шоты').length === 0,
    `переименование сохранилось для всех ${wasCount} позиций`,
    m.items.filter((i) => i.c === 'Шоты и коктейли').length);

  // ── порядок категорий ──
  await login();
  const firstBefore = await p.evaluate(() => document.querySelector('.cat').dataset.key);
  const secondBefore = await p.evaluate(() => document.querySelectorAll('.cat')[1].dataset.key);
  await p.click(`.cat[data-key="${secondBefore}"] [data-cat="up"]`);
  await p.waitForTimeout(400);
  const firstAfter = await p.evaluate(() => document.querySelector('.cat').dataset.key);
  ok(firstAfter === secondBefore, 'категория поднялась выше', firstBefore + ' → ' + firstAfter);
  await save();
  m = menu();
  ok(m.items[0].c === secondBefore.split('|')[1],
    'новый порядок категорий сохранился', m.items[0].c);

  // ── перенос категории в другое меню ──
  await login();
  answer('');
  const moveCat = 'furshet|Сервировка и допы';
  const moveCount = menu().items.filter((i) => i.c === 'Сервировка и допы' && i.mt === 'furshet').length;
  await p.click(`.cat[data-key="${moveCat}"] [data-cat="move"]`);
  await p.waitForTimeout(500);
  await save();
  m = menu();
  ok(m.items.filter((i) => i.c === 'Сервировка и допы' && i.mt === 'banket').length === moveCount
    && m.items.filter((i) => i.c === 'Сервировка и допы' && i.mt === 'furshet').length === 0,
    `категория целиком уехала в банкетное меню (${moveCount})`);

  // ── объединение категорий ──
  await login();
  const mergeFrom = 'Пирожки', mergeTo = 'Слойки';
  const nFrom = menu().items.filter((i) => i.c === mergeFrom).length;
  const nTo = menu().items.filter((i) => i.c === mergeTo).length;
  answer(mergeTo);
  await p.click(`.cat[data-key="furshet|${mergeFrom}"] [data-cat="merge"]`);
  await p.waitForTimeout(500);
  await save();
  m = menu();
  ok(m.items.filter((i) => i.c === mergeTo).length === nFrom + nTo
    && m.items.filter((i) => i.c === mergeFrom).length === 0,
    `«${mergeFrom}» (${nFrom}) объединились со «${mergeTo}» (${nTo})`,
    m.items.filter((i) => i.c === mergeTo).length);

  // ── новая категория у отдельного блюда ──
  await login();
  answer('Сезонное');
  await p.selectOption('.row [data-f="c"]', '__new__');
  await p.waitForTimeout(500);
  await save();
  m = menu();
  ok(m.items.filter((i) => i.c === 'Сезонное').length === 1,
    'у блюда можно завести новую категорию', m.items.filter((i) => i.c === 'Сезонное').length);

  // ── новое блюдо попадает в выбранную категорию ──
  await login();
  await p.fill('#new_n', 'Тестовое канапе');
  await p.fill('#new_p', '99');
  await p.selectOption('#new_c', 'Канапе');
  await p.click('#add');
  await p.waitForTimeout(500);
  await save();
  m = menu();
  const added = m.items.find((i) => i.n === 'Тестовое канапе');
  ok(added && added.c === 'Канапе', 'новое блюдо встало в выбранную категорию', added && added.c);

  // ── калькулятор видит новые категории ──
  const c = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await c.route('**fonts.g**', (r) => r.abort());
  await c.route('**yandex**', (r) => r.abort());
  await c.goto(B + '/kalkulyator.html', { waitUntil: 'domcontentloaded' });
  await c.waitForTimeout(1200);
  const cats = await c.evaluate(() => Array.from(document.querySelectorAll('.kb-cat'))
    .map((h) => h.childNodes[0].textContent.trim()));
  ok(cats.includes('Шоты и коктейли'), 'переименованная категория видна на сайте', cats.slice(0, 4).join(', '));
  ok(!cats.includes('Пирожки'), 'объединённая категория с сайта пропала');
  ok(cats[0] === secondBefore.split('|')[1], 'порядок категорий на сайте совпадает с панелью', cats[0]);

  ok(errs.length === 0, 'ошибок JS нет' + (errs.length ? ': ' + errs.join('; ') : ''));

  await b.close();
  php.kill();
  console.log(bad ? `\nне прошло: ${bad}` : '\nкатегории редактируются ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ТЕСТ УПАЛ:', e.message); process.exit(1); });
