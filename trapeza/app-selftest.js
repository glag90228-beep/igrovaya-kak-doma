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

/*
 * Ключи провайдеров убираем: прогон не должен зависеть от того, что лежит
 * в окружении запускающего. Проверка «без распознавания речи отказ понятен»
 * гасит SPEECH_PROVIDER, но одного YANDEX_API_KEY в окружении довольно,
 * чтобы модуль счёл себя настроенным, — и прогон получал другой отказ, а то
 * и ходил в сеть. Нужный ключ блок ставит себе сам.
 */
for (const k of ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'XAI_API_KEY', 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID',
  'VISION_PROVIDER', 'SPEECH_PROVIDER', 'AI_PROVIDER', 'AI_ENABLED', 'AI_MODEL',
  'AI_MOCK', 'AI_MOCK_USAGE', 'DADATA_TOKEN']) {
  delete process.env[k];
}
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
    // Итог ожидания — в проверку, а не ok(true) после него: истёкшее
    // ожидание роняло весь прогон вместо одной понятной строки.
    const splashGone = await page.waitForFunction(() => {
      const s = document.getElementById('splash');
      return !s || s.classList.contains('gone');
    }, null, { timeout: 5000 }).then(() => true, () => false);
    ok(splashGone, 'и уходит сама, когда экран готов');
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

  /*
   * Ведущее число — то, что человек пришёл узнать: сколько ему должны
   * ПРЯМО СЕЙЧАС. Раньше сверху стояло «должны вам» по выбранному
   * основанию, и при «долге по отгрузке» оно показывало ноль, хотя счета
   * выписаны и не оплачены. Три сигнала об одних деньгах спорили между
   * собой, и человек не понимал, должны ему или нет.
   */
  const heroSum = await page.evaluate(() => document.querySelector('.hero .sum').textContent.replace(/\s/g, ''));
  ok(heroSum !== '0₽', 'сверху не ноль, когда счета не оплачены', heroSum);
  ok(await page.evaluate(() => Boolean(document.querySelector('.hero .sub.wait'))),
    'ожидание оплаты помечено янтарным, а не зелёным');

  // Касание по числу ведёт к тем самым счетам, а не к общему разбору:
  // сверху стоит их сумма, и логично показать именно их.
  const hero = await page.locator('.hero .tap').boundingBox();
  await page.touchscreen.tap(hero.x + hero.width / 2, hero.y + 20);
  await page.waitForTimeout(700);
  ok(await page.evaluate(() => document.querySelector('h1') && document.querySelector('h1').textContent)
    === 'Ждут оплаты', 'нажатие на цифру ведёт к неоплаченным счетам',
  await page.evaluate(() => document.querySelector('h1') && document.querySelector('h1').textContent));

  /*
   * А разбор «из чего сумма» никуда не делся — он открывается плашкой
   * способа подсчёта. Жалоба «счета удаляю, а сумма прежняя» законна: при
   * основании «по отгрузке» счёт долга не создаёт, и всю сумму держит
   * начальное сальдо. Пока цифра молчит, это неотличимо от поломки.
   */
  await page.evaluate(() => window.__go('home', {}));
  await page.waitForSelector('.chip-basis');
  const chip = await page.locator('.chip-basis').boundingBox();
  await page.touchscreen.tap(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await page.waitForTimeout(700);
  ok(await page.evaluate(() => document.querySelector('h1') && document.querySelector('h1').textContent)
    === 'Из чего эта сумма', 'плашка способа подсчёта ведёт к разбору',
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

  // Фокус сбрасываем явно: тап «в пустое место» зависит от вёрстки и после
  // появления шапки попадал в строку списка.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const swipeBack = async () => {
    // Настоящий тап тут не нужен: Chromium подтягивает его к ближайшей строке списка
    // и открывает её. Жест проверяем событиями — их и слушает приложение.
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

  /*
   * Фраза нарочно такая, которой в базе ответов НЕТ.
   *
   * Раньше здесь стояло «когда платить взносы за себя» — и проверка сломалась,
   * как только появилась база: на этот вопрос бот теперь отвечает по норме, а
   * не отказывает. Отказ остался последним рубежом, и проверять его надо тем,
   * до чего база не достаёт.
   */
  await page.locator('.ask-input').fill('посчитай мне зарплату сотрудникам за июль');
  await page.locator('.ask-input').press('Enter');
  await page.waitForTimeout(900);
  const last = await page.evaluate(() => {
    const all = document.querySelectorAll('.bubble');
    return all[all.length - 1].textContent;
  });
  /*
   * Проверяем не только отказ, но и то, что текст ПРИШЁЛ С СЕРВЕРА.
   *
   * Раньше приложение писало свой — и он разошёлся с ботом, да ещё и с
   * вывихнутым порядком слов: «а подскажу неверно — платить штраф вам».
   * Одинаковость тут и есть суть правки, поэтому сверяем дословно.
   */
  const { OUTOFSCOPE_REPLY } = require('./lib/ai-agent');
  ok(/не веду/.test(last), 'за налоги не берётся и говорит почему', last.slice(0, 60));
  ok(last.includes('штраф платить вам'),
    'текст тот же, что в боте, и порядок слов не вывихнут', last.slice(0, 120));
  ok(last.replace(/\s+/g, ' ').includes(OUTOFSCOPE_REPLY.split('\n')[0].replace(/\s+/g, ' ')),
    'приложение показывает текст сервера, а не свой', last.slice(0, 80));

  /*
   * А на то, что в базе есть, приходит справка — и обязательно с нормой.
   * Ссылка на статью здесь не украшение: она и есть разница между «бот
   * сказал» и «так написано в законе».
   */
  await page.locator('.ask-input').fill('когда платить взносы за себя');
  await page.locator('.ask-input').press('Enter');
  await page.waitForTimeout(900);
  const spravka = await page.evaluate(() => {
    const all = document.querySelectorAll('.bubble');
    return all[all.length - 1].textContent;
  });
  ok(/28 декабря/.test(spravka), 'на вопрос из базы приходит справка, а не отказ',
    spravka.slice(0, 70));
  ok(/Основание:/.test(spravka) && /ст\. 430/.test(spravka),
    'и под ней стоит норма', spravka.slice(-90));
  ok(/не консультация/.test(spravka), 'и оговорка, что это не консультация');

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

  /*
   * Цена на лендинге лежит в двух почти одинаковых файлах.
   *
   * Поправить в одном и забыть про второй — самый вероятный способ начать
   * обещать одну цену и брать другую, а это уже не опечатка, а реклама
   * (ФЗ «О рекламе», ст. 5). Сравниваем файлы между собой, а заодно
   * проверяем, что выгода за год не выдумана, а равна разнице.
   */
  {
    const fsL = require('node:fs');
    const num = (s) => Number(String(s).replace(/[^\d]/g, ''));
    /*
     * Берём только тарифный блок, а не все числа со знаком рубля: на
     * странице есть демонстрационный счёт на 45 000,00 ₽, и он к цене
     * подписки отношения не имеет.
     */
    const priceOf = (file) => {
      // Цифры обёрнуты в <span class="price-…">: их при публикации подставляет
      // site.sh из сетки бота. Для чтения цены обёртки снимаем.
      const html = fsL.readFileSync(path.join(APP, 'public/landing', file), 'utf8')
        .replace(/<span class="price-[a-z]+">([^<]*)<\/span>/g, '$1');
      const month = html.match(/class="big">([\d  ]+)\s*₽/);
      const year = html.match(/Или\s+([\d  ]+)\s*₽\s*за год\s*—\s*выгода\s+([\d  ]+)\s*₽/);
      return {
        month: month ? num(month[1]) : 0,
        year: year ? num(year[1]) : 0,
        saving: year ? num(year[2]) : 0,
      };
    };
    const a = priceOf('index.html');
    const b = priceOf('index-v2.html');
    ok(a.month > 0 && a.year > 0, 'тариф на лендинге читается', JSON.stringify(a));
    ok(JSON.stringify(a) === JSON.stringify(b),
      'обе версии лендинга обещают одну и ту же цену',
      `${JSON.stringify(a)} против ${JSON.stringify(b)}`);
    ok(a.month * 12 - a.year === a.saving,
      'выгода за год равна разнице, а не взята с потолка',
      `${a.month} × 12 − ${a.year} = ${a.month * 12 - a.year}, обещано ${a.saving}`);
  }

  /*
   * Кнопка внизу формы обязана называть ту сумму, что выйдет в документе.
   *
   * Считалось количество на цену — и всё, без налога. У плательщика со
   * ставкой «сверху» кнопка обещала «Выписать на 100 000», а счёт выходил на
   * 122 000: человек отправлял клиенту документ на другие деньги, чем
   * собирался, и узнавал об этом от клиента.
   */
  console.log('\n── подпись кнопки не расходится с документом ──');
  {
    bdb.updateOrg(user.id, bdb.getDefaultOrg(user.id).id, { vat_rate: '22', vat_gross: 0 });
    await page.evaluate((cpId) => window.__go('new', { type: 'sch', cpId }), cp);
    await page.waitForSelector('.item input.name');
    await page.locator('.item input.name').first().fill('Услуга');
    await page.locator('.item [aria-label="Цена"]').first().fill('100000');
    await page.waitForTimeout(300);

    const shown = await page.evaluate(() => {
      const el = document.querySelector('.total-row .money');
      return el ? el.textContent.replace(/[^\d,]/g, '') : '';
    });
    ok(shown === '122000,00', 'в форме стоит сумма с налогом, а не голая цена', shown);

    // И то же число — в самом документе, выписанном теми же позициями.
    const issued = await docService.issueDocument(user.id, {
      type: 'sch', cpId: cp, items: [{ name: 'Услуга', qty: 1, price: 100000 }], skipQuota: true,
    });
    ok(issued.ok !== false && issued.total === 122000,
      'и документ выходит ровно на неё', issued.total);

    // Самозанятому сервер налог не начисляет при любой ставке в настройках —
    // а форма начисляла и обещала на 22 000 больше, чем выйдет.
    bdb.updateOrg(user.id, bdb.getDefaultOrg(user.id).id, { npd: 1 });
    await page.evaluate(() => window.__go('home'));
    await page.evaluate((cpId) => window.__go('new', { type: 'sch', cpId }), cp);
    await page.waitForSelector('.item input.name');
    await page.locator('.item input.name').first().fill('Услуга');
    await page.locator('.item [aria-label="Цена"]').first().fill('100000');
    await page.waitForTimeout(300);
    const npdShown = await page.evaluate(() => {
      const el = document.querySelector('.total-row .money');
      return el ? el.textContent.replace(/[^\d,]/g, '') : '';
    });
    const npdIssued = await docService.issueDocument(user.id, {
      type: 'sch', cpId: cp, items: [{ name: 'Услуга', qty: 1, price: 100000 }], skipQuota: true,
    });
    ok(npdShown === '100000,00' && npdIssued.total === 100000,
      'у самозанятого форма и документ сходятся — без налога', `${npdShown} / ${npdIssued.total}`);
    bdb.updateOrg(user.id, bdb.getDefaultOrg(user.id).id, { vat_rate: '', vat_gross: 0, npd: 0 });
  }

  /*
   * Нижняя панель и вкладка CRM — настоящим браузером и касаниями.
   *
   * Серверные проверки не видят, что панель вообще нарисована, что она не
   * закрывает последнюю строку списка и что счётчик на значке совпадает с
   * тем, что лежит на вкладке. Владелец когда-то не нашёл CRM именно потому,
   * что её не было на виду, — поэтому проверяем то, что видно глазами.
   */
  console.log('\n── нижняя панель и CRM ──');
  {
    const crmLib = require(path.join(APP, 'lib/crm'));
    const { db } = require(path.join(APP, 'db'));
    const today = docService.todayISO();
    const mkFu = (shift, text) => {
      const f = crmLib.addFollowup(user.id, cp, { today, days: 1, text });
      db.prepare('UPDATE cp_followups SET due = ? WHERE id = ?').run(crmLib.plusDays(today, shift), f.id);
    };
    mkFu(-2, 'Просроченное дело');
    mkFu(0, 'Дело на сегодня');
    mkFu(6, 'Дело на потом');
    crmLib.addNote(user.id, cp, 'Заметка для ленты');

    await page.evaluate(() => window.__go('home'));
    await page.waitForSelector('#tabs .tab');
    const labels = await page.$$eval('#tabs .tab', (b) => b.map((x) => x.lastElementChild.textContent.trim()));
    ok(labels.join('|') === 'Главная|Документы|Клиенты|CRM|Ещё', 'в панели пять вкладок, среди них CRM', labels.join('|'));

    const geo = await page.evaluate(() => {
      const t = document.getElementById('tabs').getBoundingClientRect();
      return { bottom: Math.round(t.bottom), vh: window.innerHeight, pos: getComputedStyle(document.getElementById('tabs')).position };
    });
    ok(geo.pos === 'fixed' && geo.bottom === geo.vh, 'панель прибита к низу экрана', JSON.stringify(geo));
    ok(await page.evaluate(() => document.querySelectorAll('#tabs .tab svg').length) === 5, 'у каждой вкладки есть значок-SVG');

    // Счётчик: просроченное и сегодняшнее — два; «на потом» не считается.
    await page.waitForFunction(() => {
      const b = document.querySelector('.tab-badge');
      return b && !b.hidden && b.textContent === '2';
    }, null, { timeout: 5000 }).catch(() => {});
    const badge = await page.evaluate(() => {
      const b = document.querySelector('#tabs .tab-badge');
      return b && !b.hidden ? b.textContent : 'нет';
    });
    ok(badge === '2', 'на значке CRM — две срочные задачи (просрочена и сегодня)', badge);

    // Переключение настоящим касанием.
    const tap = async (sel) => {
      const b = await page.locator(sel).first().boundingBox();
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(700);
    };
    await tap('#tabs .tab[data-name="crm"]');
    await page.waitForSelector('#app .section-title');
    ok(await page.evaluate(() => document.querySelector('#tabs .tab[aria-current="page"]').dataset.name) === 'crm',
      'касание по CRM открывает вкладку и подсвечивает её');
    const titles = await page.$$eval('#app .section-title', (n) => n.map((x) => x.textContent));
    ok(titles.some((t) => t.startsWith('Просрочено')) && titles.some((t) => t.startsWith('Сегодня'))
      && titles.some((t) => t.startsWith('Скоро')), 'напоминания разложены: просрочено / сегодня / скоро', titles.join(' | '));
    ok(await page.getByText('Заметка для ленты').count() === 1, 'в ленте событий есть заметка по клиенту');

    // Форма нового напоминания свёрнута: вкладку открывают за делами, а не за формой.
    ok(await page.evaluate(() => {
      const f = document.getElementById('crm-new'); return !!f && f.getBoundingClientRect().height === 0;
    }), 'форма «Новое напоминание» свёрнута');
    const order = await page.evaluate(() => {
      const t = [...document.querySelectorAll('#app .section-title')].find((x) => x.textContent.startsWith('Просрочено'));
      return t.getBoundingClientRect().top < document.getElementById('crm-new-btn').getBoundingClientRect().bottom + 200;
    });
    ok(order, 'дела видны сразу под кнопкой, форма их не вытесняет');
    await page.locator('#crm-new-btn').tap();
    await page.waitForTimeout(200);
    ok(await page.evaluate(() => document.getElementById('crm-new').getBoundingClientRect().height > 40),
      '«+ Напоминание» раскрывает форму');
    await page.locator('#crm-new-btn').tap();

    // Панель непрозрачная: текст карточек сквозь неё читаться не должен.
    const tabsBg = await page.evaluate(() => {
      const c = getComputedStyle(document.getElementById('tabs')).backgroundColor;
      const m = c.match(/rgba?\(([^)]+)\)/);
      const p = m ? m[1].split(/[ ,/]+/).filter(Boolean) : [];
      return p.length > 3 ? Number(p[3]) : 1;
    });
    ok(tabsBg === 1, 'фон нижней панели непрозрачный', String(tabsBg));

    // Панель не закрывает последнюю строку: докрутили вниз — низ контента выше верха панели.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    const clear = await page.evaluate(() => {
      const last = [...document.querySelectorAll('#app .card')].pop().getBoundingClientRect();
      return { last: Math.round(last.bottom), tabs: Math.round(document.getElementById('tabs').getBoundingClientRect().top) };
    });
    ok(clear.last <= clear.tabs, 'панель не перекрывает последнюю карточку', JSON.stringify(clear));

    // «Сделано» убирает дело и пересчитывает счётчик.
    await page.getByRole('button', { name: 'Сделано' }).first().tap();
    await page.waitForTimeout(900);
    ok(await page.getByText('Просроченное дело').count() === 0, '«Сделано» убирает просроченное дело');
    const badge2 = await page.evaluate(() => {
      const b = document.querySelector('#tabs .tab-badge');
      return b && !b.hidden ? b.textContent : 'нет';
    });
    ok(badge2 === '1', 'счётчик на значке уменьшился до одного', badge2);

    // «Отложить»: дело уходит из «сегодня» в «скоро», счётчик гаснет.
    await page.getByRole('button', { name: 'Отложить на 3 дня' }).first().tap();
    await page.waitForTimeout(900);
    const badge3 = await page.evaluate(() => {
      const b = document.querySelector('#tabs .tab-badge');
      return b && !b.hidden ? b.textContent : 'нет';
    });
    ok(badge3 === 'нет', 'после «Отложить» срочных нет — счётчик исчез', badge3);

    // Вложенный экран: панель на месте, подсвечена вкладка, откуда пришли.
    await page.getByRole('button', { name: 'К клиенту' }).first().tap();
    await page.waitForSelector('#crm-note', { timeout: 5000 });
    const inner = await page.evaluate(() => ({
      shown: !document.getElementById('tabs').hidden && document.getElementById('tabs').getBoundingClientRect().height > 40,
      lit: document.querySelector('#tabs .tab[aria-current="page"]')?.dataset.name,
    }));
    ok(inner.shown, 'в карточке клиента панель остаётся на виду');
    ok(inner.lit === 'crm', 'и подсвечена CRM — туда и вернёмся', inner.lit);

    await tap('#tabs .tab[data-name="cps"]');
    ok(await page.evaluate(() => document.querySelector('#tabs .tab[aria-current="page"]').dataset.name) === 'cps',
      'из карточки по панели можно уйти в «Клиенты»');

    // «Долги» ушли из панели, но не пропали: первая строка на вкладке «Ещё».
    await tap('#tabs .tab[data-name="more"]');
    await page.getByText('Кто сколько должен', { exact: true }).first().tap();
    await page.waitForTimeout(700);
    ok(await page.evaluate(() => document.getElementById('app').textContent.includes('Кто сколько должен') || document.getElementById('app').textContent.includes('Долгов нет')),
      'экран долгов открывается из «Ещё»');
  }

  /*
   * «Повторить» в карточке документа — настоящим касанием.
   *
   * Раньше кнопка уносила в форму одни позиции, и основание накладной с
   * ставкой НДС терялись. Проверяем то, что человек видит: форма открылась
   * с теми же клиентом, позициями и основанием, подписана как повтор и
   * ничего сама не выписала.
   */
  console.log('\n── «Повторить» в карточке документа ──');
  {
    const { db } = require(path.join(APP, 'db'));
    const src = await docService.issueDocument(user.id, {
      type: 'torg12', cpId: cp, date: '2026-09-11', skipQuota: true,
      items: [{ name: 'Бумага А4', unit: 'пачка', qty: 10, price: 300 }], extra: { basis: 'Заказ № 77' },
    });
    const docsBefore = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?').get(user.id).n;
    await page.evaluate((id) => window.__go('doc', { id }), src.doc.id);
    const btn = page.getByRole('button', { name: 'Повторить', exact: true });
    await btn.waitFor({ timeout: 5000 });
    await btn.tap();
    await page.waitForSelector('#repeat-note', { timeout: 5000 });
    ok((await page.textContent('#repeat-note')).includes(`№ ${src.doc.number}`), 'форма подписана как повтор исходного документа');
    ok(await page.inputValue('#f-basis') === 'Заказ № 77', 'основание накладной перенесено в форму');
    const vals = await page.$$eval('#app input', (n) => n.map((x) => x.value));
    ok(vals.includes('Бумага А4'), 'позиция на месте и её можно править', vals.join('|'));
    ok(await page.inputValue('#f-date') === docService.todayISO(), 'дата в форме — сегодняшняя');
    ok(db.prepare('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?').get(user.id).n === docsBefore,
      'сама кнопка ничего не выписала — только открыла форму');
  }

  /*
   * «Акт за месяц» из карточки клиента — касаниями: кнопка → предпросмотр
   * позиций → «Создать» → экран честно говорит, что всё уже в акте.
   */
  console.log('\n── акт за месяц в карточке клиента ──');
  {
    const { db } = require(path.join(APP, 'db'));
    const thisYm = docService.todayISO().slice(0, 7);
    const cpM = bdb.createCp(user.id, { name: 'ООО «Месячный акт»', kind: 'customer', opening_date: '2026-01-01' });
    for (const [day, price] of [['01', 30000], ['02', 20000]]) {
      await docService.issueDocument(user.id, {
        type: 'torg12', cpId: cpM, date: `${thisYm}-${day}`, skipQuota: true,
        items: [{ name: 'Обеды', unit: 'шт.', qty: 1, price }],
      });
    }
    const actsBefore = () => db.prepare("SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND type = 'usl' AND payload LIKE '%monthAct%'").get(user.id).n;
    ok(actsBefore() === 0, 'до нажатия актов за месяц нет');

    // Без предоплаты кнопки нет: акт сразу «оплачен», а накладные висят долгом.
    await page.evaluate((id) => window.__go('cp', { id }), cpM);
    await page.getByText('Акт сверки', { exact: true }).first().waitFor({ timeout: 5000 });
    ok(await page.getByText('Акт за месяц', { exact: true }).count() === 0,
      'у клиента без предоплаты в карточке нет «Акт за месяц»');

    bdb.setPrepayMode(user.id, cpM, bdb.currentOrgId(user.id), true);
    await page.evaluate((id) => window.__go('cp', { id }), cpM);
    const entry = page.getByText('Акт за месяц', { exact: true }).first();
    await entry.waitFor({ timeout: 5000 });
    await entry.tap();
    await page.waitForSelector('#monthact-list', { timeout: 5000 });
    ok(await page.locator('#monthact-list .row').count() === 3, 'в предпросмотре две накладные и строка «Итого в акте»');
    ok((await page.textContent('#monthact-make')).replace(/\s/g, ' ').includes('50 000'), 'кнопка называет сумму акта');
    ok(await page.evaluate(() => {
      const b = document.getElementById('monthact-make').getBoundingClientRect();
      window.scrollTo(0, document.body.scrollHeight);
      const tabs = document.getElementById('tabs').getBoundingClientRect();
      const after = document.getElementById('monthact-make').getBoundingClientRect();
      return b.height > 0 && after.bottom <= tabs.top + 1;
    }), 'кнопку «Создать» не закрывает нижняя панель');
    ok(actsBefore() === 0, 'предпросмотр акта не выписывает');
    await page.locator('#monthact-make').tap();
    await page.getByText('Всё за месяц уже в акте').waitFor({ timeout: 8000 });
    ok(actsBefore() === 1, 'после «Создать» выписан ровно один акт');
    ok(await page.locator('#monthact-make').count() === 0, 'второй раз создать нечего: кнопки «Создать» уже нет');
  }

  /*
   * Самозанятый: «Чеки не пробиты» на главной → список → «Чек пробил».
   */
  console.log('\n── чеки «Мой налог» ──');
  {
    const cheques = require(path.join(APP, 'lib/cheques'));
    const orgId = bdb.getDefaultOrg(user.id).id;
    bdb.updateOrg(user.id, orgId, { npd: 1 });
    const cpC = bdb.createCp(user.id, { name: 'ООО «Чековый»', inn: '7707083893', kind: 'customer', opening_date: '2026-01-01' });
    const made = await docService.issueDocument(user.id, {
      type: 'sch', cpId: cpC, items: [{ name: 'Уборка', qty: 1, price: 4000 }], skipQuota: true,
    });
    await page.evaluate(() => window.__go('home'));
    await page.waitForSelector('#app', { timeout: 5000 });
    ok(await page.locator('#cheques-home').count() === 0, 'пока оплаты нет, строки про чеки на главной нет');

    bdb.markPaid(user.id, made.doc.id);
    const chq = cheques.owe(user.id, made.doc.id, docService.todayISO());
    await page.evaluate(() => window.__go('home'));
    await page.waitForSelector('#cheques-home', { timeout: 5000 });
    ok((await page.textContent('#cheques-home')).includes('Чеки не пробиты: 1'), 'на главной — «Чеки не пробиты: 1»');
    await page.locator('#cheques-home .row').tap();
    await page.waitForSelector(`#cheque-ok-${chq.id}`, { timeout: 5000 });
    const txt = (await page.textContent('#app')).replace(/\s/g, ' ');
    ok(txt.includes('Уборка') && txt.includes('организация, ИНН 7707083893'), 'на экране чеков — данные для «Мой налог»');
    ok(await page.evaluate((id) => {
      const b = document.getElementById(`cheque-ok-${id}`).getBoundingClientRect();
      window.scrollTo(0, document.body.scrollHeight);
      const tabs = document.getElementById('tabs').getBoundingClientRect();
      const after = document.getElementById(`cheque-ok-${id}`).getBoundingClientRect();
      return b.height > 0 && after.bottom <= tabs.top + 1;
    }, chq.id), 'кнопку «Чек пробил» не закрывает нижняя панель');
    await page.locator(`#cheque-ok-${chq.id}`).tap();
    await page.getByText('Все чеки пробиты').waitFor({ timeout: 8000 });
    ok(cheques.get(user.id, chq.id).status === 'done', 'после «Чек пробил» чек отмечен в базе');

    await page.evaluate((id) => window.__go('doc', { id }), made.doc.id);
    await page.waitForSelector('#doc-cheque', { timeout: 5000 });
    ok((await page.textContent('#doc-cheque')).includes('пробит'), 'в карточке документа чек числится пробитым');
    await page.evaluate(() => window.__go('home'));
    await page.waitForSelector('.hero', { timeout: 5000 });
    ok(await page.locator('#cheques-home').count() === 0, 'на главной строка про чеки исчезла');
    bdb.updateOrg(user.id, orgId, { npd: 0 });
  }

  /*
   * Расписания: в карточке документа выбрать «Каждый день», увидеть его в списке
   * и в карточке клиента, остановить. Выписывать при этом нечего — документ
   * появляется только по «Всё верно» в боте.
   */
  console.log('\n── расписания: период в карточке документа ──');
  {
    const recLib = require(path.join(APP, 'lib/recurring'));
    const { db } = require(path.join(APP, 'db'));
    const cpS = bdb.createCp(user.id, { name: 'ООО «Обеды»', kind: 'customer', opening_date: '2026-01-01' });
    const srcS = await docService.issueDocument(user.id, {
      type: 'torg12', cpId: cpS, date: '2026-09-11', skipQuota: true,
      items: [{ name: 'Обед комплексный', unit: 'шт.', qty: 20, price: 350 }],
    });
    const docsN = () => db.prepare('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?').get(user.id).n;
    const n0 = docsN();
    await page.evaluate((id) => window.__go('doc', { id }), srcS.doc.id);
    await page.waitForSelector('#rec-open', { timeout: 5000 });
    await page.locator('#rec-open').tap();
    await page.waitForSelector('#rec-day', { timeout: 5000 });
    const names = (await page.textContent('#app')).replace(/\s/g, ' ');
    ok(names.includes('Каждый день') && names.includes('По будням') && names.includes('Раз в неделю') && names.includes('Раз в месяц'),
      'в карточке документа — выбор: каждый день, по будням, раз в неделю, раз в месяц');
    ok(await page.evaluate(() => {
      const b = document.getElementById('rec-month').getBoundingClientRect();
      return b.height >= 44;
    }), 'строки выбора — крупные цели нажатия');
    await page.locator('#rec-week').tap();
    await page.waitForSelector('#rec-wd-3', { timeout: 5000 });
    ok(await page.locator('[id^=rec-wd-]').count() === 7, 'раз в неделю — семь дней недели');
    await page.locator('#rec-day').tap();
    await page.waitForSelector('.plan', { timeout: 8000 });
    const list = (await page.textContent('#app')).replace(/\s/g, ' ');
    ok(list.includes('каждый день') && list.includes('пришлю на проверку') && list.includes('следующее предложение'),
      'расписание появилось в списке: «каждый день», проверка, дата следующего');
    ok(docsN() === n0, 'настройка расписания ничего не выписала');
    const rec = recLib.list(user.id).find((r) => r.cp_id === cpS);
    ok(rec && rec.period === 'day', 'в базе расписание «day»');

    await page.evaluate((id) => window.__go('cp', { id }), cpS);
    await page.waitForSelector('#cp-schedules', { timeout: 5000 });
    ok((await page.textContent('#cp-schedules')).includes('каждый день'), 'в карточке клиента — его расписание');
    await page.locator('#cp-schedules .row-act').tap();
    await page.waitForFunction(() => !document.getElementById('cp-schedules'), null, { timeout: 8000 });
    ok(!recLib.list(user.id).some((r) => r.cp_id === cpS), 'остановка из карточки клиента сняла расписание');
  }

  await browser.close();
  await new Promise((r) => server.close(r));
  await require(path.join(APP, 'lib/pdf')).closePdf();
  console.log(bad ? `\nне прошло: ${bad}` : '\nсмахивание работает ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ПРОГОН УПАЛ:', e); process.exit(1); });
