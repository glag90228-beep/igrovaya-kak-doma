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

  /*
   * Настоящий скрипт Telegram грузиться не должен.
   *
   * Страница тянет его из интернета, и он переписывает window.Telegram поверх
   * нашей заглушки. Вне мессенджера у настоящего initData пустой, приложение
   * честно говорит «Не удалось вас опознать» — и экрана, которого ждёт
   * проверка, не появляется никогда.
   *
   * Обиднее всего, что зависит это от сети: где telegram.org недоступен,
   * заглушка выживает и прогон зелёный, а где доступен — падает по таймауту.
   * Проверка обязана давать один и тот же ответ в обоих случаях.
   * (В miniapp-preview.js этот же запрет стоит с самого начала.)
   */
  await ctx.route('https://telegram.org/**', (route) => route.abort());

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

  console.log('\n── заставка при входе ──');
  {
    /*
     * Заставка лежит поверх всего экрана целую секунду. Если она ловит
     * касания, человек открывает приложение, тычет в кнопку, ничего не
     * происходит — и решает, что оно зависло. Проверка ровно об этом:
     * под заставкой должно нажиматься то, что под ней нарисовано.
     */
    const splash = page.locator('#splash');
    ok(await splash.count() === 1, 'заставка на странице есть');
    const through = await page.evaluate(() => {
      const s = document.getElementById('splash');
      if (!s || getComputedStyle(s).display === 'none') return 'ушла';
      const r = s.getBoundingClientRect();
      const el = document.elementFromPoint(r.width / 2, r.height / 2);
      return el && el.closest('#splash') ? 'ловит нажатия' : 'пропускает';
    });
    ok(through !== 'ловит нажатия', 'нажатия проходят сквозь неё', through);

    /*
     * Перечисление обязано погаснуть целиком до того, как появится знак.
     * На iPhone последнее слово оставалось висеть поверх листа: WebKit при
     * steps() вместе с forwards держит значение последнего шага, а не
     * конечное. Проверяем не «как отработало каждое слово», а результат —
     * виден ли хоть один текст в момент, когда его быть уже не должно.
     */
    const wordsLeft = await page.evaluate(() => {
      const box = document.querySelector('#splash .splash-words');
      if (!box) return 'слоя нет';
      // Перематываем на середину показа знака — слова к этому моменту ушли.
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = 700; }
      const seen = [...box.querySelectorAll('b')]
        .filter((b) => Number(getComputedStyle(b).opacity) > 0.01
          && getComputedStyle(b).visibility !== 'hidden'
          && getComputedStyle(box).visibility !== 'hidden')
        .map((b) => b.textContent);
      for (const a of document.getAnimations()) a.play();
      return seen.length ? seen.join(', ') : '';
    });
    ok(wordsLeft === '', 'к появлению знака слова уже погасли', wordsLeft || '—');

    // И она обязана уйти сама: заставка, оставшаяся на экране, — это
    // приложение, которое не открылось.
    await page.waitForFunction(() => {
      const s = document.getElementById('splash');
      return !s || s.classList.contains('gone');
    }, null, { timeout: 5000 });
    ok(true, 'и уходит сама, когда экран готов');
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

  /*
   * Сальдо в карточке: сумма не должна налезать на заголовок.
   *
   * Жалоба: «цифра стоит не в своём шаблоне, где надпись должен нам».
   * Справа от заголовка шестизначной сумме не хватало места — подпись
   * «Начали с 15 000,00 ₽ на 01.01.2026» шире половины экрана. Меряем
   * прямоугольники: слова и цифра не должны пересекаться.
   */
  console.log('\n── сальдо в карточке ──');
  await page.evaluate((cpId) => window.__go('cp', { id: cpId }), cp);
  await page.waitForSelector('.balance .v');
  const boxes = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().toJSON() : null; };
    return { row: r('.balance'), title: r('.balance .ellipsis'), v: r('.balance .v'), hint: r('.balance .hint') };
  });
  const overlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  ok(!overlap(boxes.title, boxes.v), 'сумма не налезает на заголовок',
    JSON.stringify({ title: boxes.title, v: boxes.v }));
  ok(boxes.v && boxes.v.right <= boxes.row.right + 0.5, 'и не вылезает за строку',
    boxes.v && `${Math.round(boxes.v.right)} / ${Math.round(boxes.row.right)}`);
  ok(boxes.hint && boxes.v && boxes.hint.top >= boxes.v.bottom - 0.5,
    'подпись стоит под суммой, а не рядом');

  /*
   * Назад после экрана, открытого с нуля.
   *
   * Внесли оплату — приложение показывает карточку клиента через reset,
   * стопка схлопывается, а стрелка «Назад» в шапке остаётся видимой и не
   * делает ничего. Проверяем настоящим жестом от левого края: он должен
   * вывести к списку контрагентов, а не оставить на месте.
   */
  console.log('\n── назад пальцем от края ──');
  await page.getByText('Внести оплату или приход', { exact: true }).click();
  await page.waitForSelector('#f-amount');
  await page.locator('#f-amount').fill('2500');
  await page.getByText('Внести в журнал', { exact: true }).click();
  await page.waitForTimeout(900);
  ok(await page.evaluate(() => document.querySelector('h1') === null
    || document.querySelector('.balance') !== null), 'после оплаты вернулись в карточку клиента');

  await page.touchscreen.tap(200, 400);              // сбросить возможный фокус
  const swipeBack = async () => {
    await page.touchscreen.tap(5, 400);
    await page.evaluate(() => {
      const t = (type, x) => {
        const touch = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 400 });
        document.dispatchEvent(new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
          bubbles: true,
        }));
      };
      t('touchstart', 6); t('touchmove', 90); t('touchend', 180);
    });
    await page.waitForTimeout(700);
  };
  await swipeBack();
  ok(await page.evaluate(() => (document.querySelector('h1') || {}).textContent) === 'Контрагенты',
    'жест от края увёл назад к списку, а не в никуда',
    await page.evaluate(() => (document.querySelector('h1') || {}).textContent));

  /*
   * Журнал операций: внесённое руками видно и убирается.
   *
   * До этого экрана внесённую оплату нельзя было ни увидеть, ни убрать —
   * в боте отменялась только последняя. А именно такие строки и держат
   * сумму на главной, из-за которой «удаляю документы, а цифра стоит».
   */
  console.log('\n── журнал операций ──');
  await page.evaluate((cpId) => window.__go('ops', { cpId }), cp);
  await page.waitForSelector('.swipe-face');
  ok(await page.evaluate(() => document.querySelectorAll('.swipe').length) === 1,
    'внесённая оплата видна строкой',
    await page.evaluate(() => document.querySelectorAll('.swipe').length));

  const opRow = await page.locator('.swipe-face').first().boundingBox();
  await page.touchscreen.tap(opRow.x + opRow.width / 2, opRow.y + opRow.height / 2);
  await swipe(-120, 0);
  const delBtn = await page.locator('.swipe-del').first().boundingBox();
  await page.touchscreen.tap(delBtn.x + delBtn.width / 2, delBtn.y + delBtn.height / 2);
  await page.waitForTimeout(900);
  ok(bdb.listOps(user.id, cp).length === 0, 'смахнули — строка ушла из журнала',
    bdb.listOps(user.id, cp).length);
  ok(bdb.balanceOf(user.id, cp).closing === 15000,
    'и сальдо вернулось к начальному', bdb.balanceOf(user.id, cp).closing);

  /*
   * Экран переписки. Рамки должны быть названы до того, как человек начал
   * печатать: узнать после третьего вопроса про взносы, что бот их не
   * ведёт, — обидно. И агент не должен ничего выписывать сам.
   */
  console.log('\n── переписка с агентом ──');
  await page.evaluate(() => window.__go('ask', {}));
  await page.waitForSelector('.ask-bar');
  const hello = await page.evaluate(() => document.querySelector('.bubble').textContent);
  ok(/Налоги/.test(hello) && /не веду/.test(hello), 'рамки объявлены сразу, до первого вопроса',
    hello.slice(0, 60));
  ok(await page.evaluate(() => Boolean(document.querySelector('.mic'))), 'кнопка записи на месте');

  /*
   * Обещание «сам я ничего не выписываю» верно ровно в одном режиме — когда
   * тумблер ассистента выключен. Включённый ассистент, наоборот, обязан
   * довести дело до файла: ради этого тумблер и заведён. Поэтому проверяем в
   * выключенном положении, а не «вообще».
   */
  bdb.setAiEnabled(user.id, false);
  const docsWas = bdb.listDocs(user.id, 50).length;
  await page.locator('.ask-input').fill('выставь счёт Заре');
  await page.locator('.ask-input').press('Enter');
  await page.waitForTimeout(900);
  const replies = await page.evaluate(() => [...document.querySelectorAll('.bubble')].map((b) => b.textContent));
  ok(replies.some((t) => /Заре/.test(t)), 'услышанное показано в переписке', replies.length);
  ok(replies.some((t) => /сам я ничего не выписываю/.test(t)),
    'с выключенным тумблером сказано прямо: сам не выписывает');
  ok(bdb.listDocs(user.id, 50).length === docsWas,
    'и документ действительно не выписан', `${docsWas} → ${bdb.listDocs(user.id, 50).length}`);
  bdb.setAiEnabled(user.id, true);

  await page.locator('.ask-input').fill('когда платить взносы за себя');
  await page.locator('.ask-input').press('Enter');
  await page.waitForTimeout(900);
  const last = await page.evaluate(() => {
    const all = document.querySelectorAll('.bubble');
    return all[all.length - 1].textContent;
  });
  ok(/не моя работа/.test(last), 'за налоги не берётся и говорит почему', last.slice(0, 60));

  // Строка ввода приклеена к низу — последний ответ не должен под ней прятаться.
  const fits = await page.evaluate(() => {
    const all = document.querySelectorAll('.bubble');
    const b = all[all.length - 1].getBoundingClientRect();
    const bar = document.querySelector('.ask-bar').getBoundingClientRect();
    return b.bottom <= bar.top + 1;
  });
  ok(fits, 'последний ответ виден целиком, а не под строкой ввода');

  /*
   * Цена на экране подписки.
   *
   * Жалоба: «очень коряво встают цифры». Так и было: «390 ₽ в месяц или
   * 2990 ₽ в год» одной фразой рвалось посреди числа — «2990» на одной
   * строке, «₽ в год» на другой. Цена, оторванная от знака рубля, читается
   * как ошибка, а по ней принимают решение. Меряем прямоугольники.
   */
  console.log('\n── цена на экране подписки ──');
  process.env.LAVA_PLAN_DAYS = '390:30,2990:365';
  process.env.LAVA_DEFAULT_DAYS = '30';
  await page.evaluate(() => window.__go('billing', {}));
  await page.waitForSelector('.price');

  const prices = await page.evaluate(() => [...document.querySelectorAll('.price')].map((el) => {
    const r = el.getBoundingClientRect();
    const title = el.closest('.row').querySelector('.grow div').getBoundingClientRect();
    return {
      text: el.textContent,
      lines: Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight || 24)),
      overlaps: title.right > r.left,
      inside: r.right <= el.closest('.row').getBoundingClientRect().right + 0.5,
    };
  }));
  ok(prices.length === 2, 'оба тарифа показаны отдельными строками', prices.length);
  ok(prices.every((p) => p.lines === 1), 'сумма не разорвана переносом',
    JSON.stringify(prices.map((p) => `${p.text}:${p.lines}`)));
  ok(prices.every((p) => !p.overlaps), 'и не налезает на название срока');
  ok(prices.every((p) => p.inside), 'и не вылезает за строку');
  ok(prices.some((p) => p.text.replace(/\s/g, '').includes('2990')),
    'годовая цена на месте целиком', prices.map((p) => p.text).join(' | '));

  /*
   * Обход всех денежных экранов на узком телефоне.
   *
   * Точечные проверки ловят то, про что уже знаешь. А ломается вёрстка там,
   * где длинное имя встретилось с большой суммой, — и узнаёшь об этом от
   * человека, который смотрит на кривые цифры. Поэтому здесь не разбор
   * конкретного экрана, а сторож на весь класс: сумма в две строки или
   * вылезшая за край — поломка, где бы она ни случилась.
   */
  console.log('\n── деньги на всех экранах ──');
  const bigCp = bdb.createCp(user.id, {
    name: 'ООО «Производственно-торговая компания Ромашка»', kind: 'customer',
    opening_balance: 1234567.89, opening_date: '2026-01-01',
  });
  bdb.addOp(user.id, bigCp, { date: '2026-03-01', kind: 'Оплата', doc: 'п/п 7', debit: 456789.01 });

  const money = (name, params) => page.evaluate(([n, p]) => {
    window.__go(n, p || {});
    return new Promise((done) => setTimeout(() => {
      const out = [];
      if (document.documentElement.scrollWidth > window.innerWidth + 1) {
        out.push(`шире экрана на ${document.documentElement.scrollWidth - window.innerWidth}px`);
      }
      for (const el of document.querySelectorAll('.money, .price, .sum, .v')) {
        const text = el.textContent.trim();
        if (!text) continue;
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
        if (Math.round(el.getBoundingClientRect().height / lh) > 1) out.push(`в две строки: «${text}»`);
        if (el.getBoundingClientRect().right > window.innerWidth + 0.5) out.push(`за краем: «${text}»`);
      }
      done(out);
    }, 500));
  }, [name, params]);

  for (const [name, params] of [['home'], ['docs'], ['cps'], ['debts'], ['unpaid'],
    ['billing'], ['why'], ['cp', { id: bigCp }], ['ops', { cpId: bigCp }]]) {
    // eslint-disable-next-line no-await-in-loop
    const bad = await money(name, params);
    ok(bad.length === 0, `«${name}»: суммы стоят ровно`, bad.join(' | '));
  }

  await browser.close();
  await new Promise((r) => server.close(r));
  await require(path.join(APP, 'lib/pdf')).closePdf();
  console.log(bad ? `\nне прошло: ${bad}` : '\nсмахивание работает ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ПРОГОН УПАЛ:', e); process.exit(1); });
