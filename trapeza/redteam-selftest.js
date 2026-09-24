'use strict';

/**
 * Прогон по следам адверсариального разбора.
 *
 *   node redteam-selftest.js
 *
 * Здесь собраны краевые случаи, которые ломали расчёты и документы. Каждый
 * тест писался на подтверждённой запуском дыре: сначала он падал, потом
 * чинился код. Держать их отдельно от остальных прогонов удобно тем, что
 * видно, какие именно атаки продукт уже переживает.
 *
 * Порядок — по тяжести последствий: сначала деньги, потом документ, потом
 * удобство.
 */

require('./selftest-db');   // своя база на прогон — до всего, что тянет db.js
const bdb = require('./lib/bot-db');
const period = require('./lib/period');
const { parseOp } = require('./bot');
const { round2, formatRub } = require('./lib/money');

let bad = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg + (cond || extra === undefined ? '' : ' → ' + extra));
  if (!cond) bad += 1;
};

let seq = 0;
function freshUser() {
  seq += 1;
  const u = bdb.getOrCreateUser(900000 + seq).id;
  const org = bdb.createOrg(u, { name: 'ИП Проверка', inn: '183209316119', signer: 'И. П.' });
  return { u, org };
}

// ---------- деньги ----------

console.log('\n=== Деньги ===');
{
  /*
   * Одна оплата — одна проводка.
   *
   * При основании «по счёту» долг создаёт счёт. Человек отмечает оплаченным
   * и счёт, и закрывающий его акт — обе суммы по 30 000, — и сальдо уходило
   * в минус: выходило, что это мы должны клиенту, который заплатил один раз.
   */
  const { u, org } = freshUser();
  bdb.updateOrg(u, org, { debt_basis: 'invoice' });
  const cp = bdb.createCp(u, { name: 'Клиент', kind: 'customer' });
  const sch = bdb.saveDoc(u, {
    orgId: org, cpId: cp, type: 'sch', number: '1', seq: 1, date: '2026-03-01', total: 30000, payload: {},
  });
  bdb.addOpForDoc(u, cp, { date: '2026-03-01', kind: 'Реализация', doc: 'Счёт 1', credit: 30000 }, sch);
  const usl = bdb.saveDoc(u, {
    orgId: org, cpId: cp, type: 'usl', number: '1', seq: 1, date: '2026-03-02', total: 30000, payload: {},
  });
  bdb.markPaid(u, sch, '2026-03-05');
  ok(bdb.balanceOf(u, cp).closing === 0, 'оплата счёта закрывает долг', bdb.balanceOf(u, cp).closing);
  bdb.markPaid(u, usl, '2026-04-05');
  ok(bdb.balanceOf(u, cp).closing === 0,
    'отметка акта не задваивает ту же оплату', bdb.balanceOf(u, cp).closing);
  ok(bdb.unpaidDocs(u).length === 0, 'при этом оба документа считаются оплаченными',
    bdb.unpaidDocs(u).length);
}

{
  // Разряды через пробел: «1 000» распадалось на «1» и «000», и в журнал
  // уходил один рубль вместо тысячи. Молча.
  ok(parseOp('15.06 приход 1 000').credit === 1000, 'разряды через пробел не теряются',
    parseOp('15.06 приход 1 000').credit);
  ok(parseOp('15.06 приход 1 000 000').credit === 1000000, 'и в миллионе тоже',
    parseOp('15.06 приход 1 000 000').credit);
  ok(parseOp('15.06 приход 12 345 678,90').credit === 12345678.9, 'вместе с копейками',
    parseOp('15.06 приход 12 345 678,90').credit);
  // Доли копейки в деньгах не существует, а заведомо невозможная сумма —
  // это опечатка, и лучше переспросить, чем занести.
  ok(parseOp('15.06 приход 12,345').credit === 12.35, 'копейки округляются',
    parseOp('15.06 приход 12,345').credit);
  ok(parseOp('15.06 приход 99999999999999999999') === null, 'невозможная сумма отвергнута');
}

{
  // Накопление ошибки округления: сто строк по копейке должны дать рубль.
  const { u } = freshUser();
  const cp = bdb.createCp(u, { name: 'Копейки', kind: 'customer' });
  for (let i = 0; i < 100; i += 1) {
    bdb.addOp(u, cp, { date: '2026-05-01', kind: 'Приход', doc: `${i}`, credit: 0.01 });
  }
  const b = bdb.balanceOf(u, cp);
  ok(b.closing === 1, 'сто копеек складываются ровно в рубль', b.closing);
  ok(round2(0.1 + 0.2) === 0.3, 'round2 гасит двоичную погрешность', round2(0.1 + 0.2));
}

// ---------- даты ----------

console.log('\n=== Даты ===');
{
  /*
   * Несуществующая дата — опечатка, а не «сегодня» и не 31 февраля.
   *
   * Раньше «31.02.2026 приход 94193» заносилось с датой 2026-02-31 и вело
   * себя дико: в карточке сумма есть, а в акт за февраль операция попадала
   * или нет в зависимости от сравнения строк. «45.99.2026» пропадало из
   * всех актов вовсе, оставаясь в сальдо карточки, — то есть карточка и
   * акт сверки показывали разные цифры.
   */
  ok(parseOp('31.02.2026 приход 94193') === null, '31 февраля не принимается');
  ok(parseOp('31.04.2026 приход 700') === null, '31 апреля тоже');
  ok(parseOp('45.99.2026 оплата 1000') === null, 'мусор вместо даты не принимается');
  ok(parseOp('29.02.2025 приход 500') === null, '29 февраля в невисокосный год');
  ok(parseOp('29.02.2024 приход 500').date === '2024-02-29', 'а в високосный — принимается',
    parseOp('29.02.2024 приход 500').date);
  ok(period.parseDay('31.02.2026') === null, 'разбор даты один на весь проект');
}

{
  // Перевёрнутый период не должен врать: если конец раньше начала, внутрь
  // не попадает ничего, и это честнее, чем молча поменять их местами.
  const { u } = freshUser();
  const cp = bdb.createCp(u, {
    name: 'Период', kind: 'customer', opening_balance: 10000, opening_date: '2026-01-01',
  });
  bdb.addOp(u, cp, { date: '2026-02-10', kind: 'Приход', doc: 'x', credit: 5000 });
  const back = bdb.periodBalance(u, cp, '2026-03-01', '2026-01-31');
  ok(back.ops.length === 0, 'в перевёрнутом периоде операций нет', back.ops.length);
  ok(back.opening === back.closing, 'и сальдо не меняется', `${back.opening} → ${back.closing}`);

  const one = bdb.periodBalance(u, cp, '2026-02-10', '2026-02-10');
  ok(one.ops.length === 1, 'период в один день включает операцию этого дня', one.ops.length);
}

// ---------- документы ----------

console.log('\n=== Документы ===');
{
  /*
   * Акты всем должникам отвечали 500 с самого своего появления: в функцию
   * передавали row.cpId, а debtors() отдаёт row.cp. Проверка живёт в
   * miniapp-selftest.js, здесь — сама причина: поле называется cp.
   */
  const { u } = freshUser();
  const cp = bdb.createCp(u, { name: 'Должник', kind: 'customer' });
  bdb.addOp(u, cp, { date: '2026-03-01', kind: 'Приход', doc: 'x', credit: 5000 });
  const rows = bdb.debtors(u);
  ok(rows.length === 1 && rows[0].cp && rows[0].cp.id === cp,
    'debtors отдаёт контрагента в поле cp, а не cpId',
    rows.length && JSON.stringify(Object.keys(rows[0])));
}

{
  // Пустой контрагент и пустой журнал не должны ронять расчёт.
  const { u } = freshUser();
  const cp = bdb.createCp(u, { name: 'Пустой', kind: 'customer' });
  const b = bdb.periodBalance(u, cp, '2026-01-01', '2026-01-31');
  ok(b && b.ops.length === 0 && b.closing === 0, 'пустой журнал считается нулём',
    b && b.closing);
  ok(bdb.periodBalance(u, 999999, '', '') === null, 'несуществующий контрагент — null, а не падение');
}

{
  // Спецсимволы в названии не должны попадать в документ как разметка.
  const { u } = freshUser();
  const evil = '<script>alert(1)</script> & «Ко»';
  const cp = bdb.createCp(u, { name: evil, kind: 'customer' });
  const saved = bdb.getCp(u, cp);
  ok(saved.name === evil, 'название хранится как есть, без порчи', saved.name.slice(0, 20));
  const { buildSchetHtml } = require('./lib/schet');
  const org = bdb.getDefaultOrg(u);
  const html = buildSchetHtml({
    org: { ...org, org_short: org.name, org_full: org.name, org_inn: org.inn },
    cp: saved,
    doc: { number: '1', date: '2026-05-01', items: [{ name: evil, qty: 1, price: 100 }] },
  });
  ok(!html.includes('<script>alert(1)</script>'), 'в документ разметка не подставляется');
  ok(html.includes('&lt;script&gt;'), 'она экранируется');
}

// ---------- сервер смет: живой процесс ----------

/*
 * Эти проверки поднимают настоящий server.js на свободном порту со своей
 * базой: вход в админку и приём заказа проверяются тем же путём, каким по
 * ним ходит браузер, а не вызовом функции.
 */
const { spawn } = require('node:child_process');
const fsR = require('node:fs');
const osR = require('node:os');
const pathR = require('node:path');
const netR = require('node:net');

const freePort = () => new Promise((resolve) => {
  const srv = netR.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function startSmeta(env = {}) {
  const port = await freePort();
  const dbPath = pathR.join(osR.tmpdir(), `smeta-${process.pid}-${port}.db`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, ADMIN_PASSWORD: '', ...env, PORT: String(port), TRAPEZA_DB: dbPath },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { await fetch(`${base}/api/settings`); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }
  const post = async (url, body) => {
    const r = await fetch(`${base}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const stop = () => {
    child.kill();
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fsR.rmSync(f, { force: true });
  };
  return { base, post, stop };
}

(async () => {
  console.log('\n=== Сервер смет: вход в админку ===');
  {
    /*
     * Пароль «trapeza» стоял в seed.js, а репозиторий публичный — то есть
     * войти в админку с чужими сметами и токеном бота мог любой, кто
     * прочитал код. Пустая настройка пускала с пустым паролем.
     */
    const s = await startSmeta();
    const def = await s.post('/api/login', { password: 'trapeza' });
    ok(def.status === 403, 'опубликованный пароль «trapeza» не пускает', def.status);
    const empty = await s.post('/api/login', { password: '' });
    ok(empty.status === 403, 'пустой пароль не пускает', empty.status);
    ok(/ADMIN_PASSWORD/.test(empty.json.error || ''), 'и сказано, как задать свой', empty.json.error);
    s.stop();

    const s2 = await startSmeta({ ADMIN_PASSWORD: 'длинный-свой-пароль-7' });
    const good = await s2.post('/api/login', { password: 'длинный-свой-пароль-7' });
    ok(good.status === 200, 'свой пароль из окружения пускает', good.status);
    const wrong = await s2.post('/api/login', { password: 'trapeza' });
    ok(wrong.status === 403, 'а старый опубликованный — нет', wrong.status);
    s2.stop();
  }

  console.log('\n=== Сервер смет: цены и файлы ===');
  {
    const s = await startSmeta();
    const boot = await (await fetch(`${s.base}/api/bootstrap`)).json();
    const dish = (boot.menu || []).find((m) => !m.price_tbd && Number(m.price) > 1);
    /*
     * Цена — из меню, а не из запроса. Раньше сохранялось то, что прислал
     * браузер, и смета на фирменном бланке выходила с ценой в рубль.
     */
    const r = await s.post('/api/orders', {
      client_name: 'Тест', phone: '1', transport: 0,
      items: [{ id: dish.id, name: dish.name, qty: 2, price: 1, price_tbd: 0 }],
    });
    const saved = r.json.code ? await (await fetch(`${s.base}/api/orders/${r.json.code}`)).json() : {};
    const it = ((saved.order || {}).items || [])[0] || {};
    ok(r.status === 201 && it.price === dish.price, 'цена позиции — из меню, а не из запроса',
      `${it.price} против ${dish.price}`);
    ok(saved.order && Number(saved.order.transport) === Number(saved.settings.transport_default),
      'доставку назначает меню, а не посетитель', saved.order && saved.order.transport);
    const fake = await s.post('/api/orders', {
      client_name: 'Тест', phone: '1', items: [{ id: 999999, name: 'Икра по рублю', qty: 1, price: 1 }],
    });
    ok(fake.status === 400, 'позицию, которой нет в меню, не сохранить', fake.status);

    /*
     * Выход в соседний каталог. Проверка «путь начинается с public» пропускала
     * «public-что-угодно»: «/..%2Fpublic-x/файл» отдавал файл рядом с сайтом.
     */
    const sib = pathR.join(__dirname, `public-selftest-${process.pid}`);
    fsR.mkdirSync(sib, { recursive: true });
    fsR.writeFileSync(pathR.join(sib, 'secret.txt'), 'секрет');
    try {
      const leak = await fetch(`${s.base}/..%2Fpublic-selftest-${process.pid}/secret.txt`);
      const body = await leak.text();
      ok(!body.includes('секрет'), 'файл из соседнего каталога не отдаётся', `${leak.status} ${body.slice(0, 20)}`);
    } finally {
      fsR.rmSync(sib, { recursive: true, force: true });
    }
    s.stop();
  }

  console.log('\n=== Прогоны не трогают боевое ===');
  {
    const { spawnSync } = require('node:child_process');
    /*
     * База смет: заказы есть, людей бота нет. Заслонка считала только людей
     * бота и признавала такую базу пустой — прогон писал в неё свои записи.
     */
    const live = pathR.join(osR.tmpdir(), `live-${process.pid}.db`);
    {
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(live);
      d.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, code TEXT); INSERT INTO orders(code) VALUES ('живой заказ')");
      d.close();
    }
    const run = spawnSync(process.execPath, ['bank-selftest.js'], {
      cwd: __dirname, env: { ...process.env, TRAPEZA_DB: live }, encoding: 'utf8',
    });
    ok(run.status === 1 && /не пустая/.test(run.stderr), 'на живую базу смет прогон не пошёл',
      `${run.status} ${String(run.stderr).trim().slice(0, 60)}`);
    {
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(live, { readOnly: true });
      const tables = d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
      d.close();
      ok(tables === 1, 'и ни одной своей таблицы в неё не завёл', tables);
    }
    for (const f of [live, `${live}-wal`, `${live}-shm`]) fsR.rmSync(f, { force: true });

    /*
     * Журнал вебхуков оплаты. Прогоны, подключающие lava-webhook.js,
     * дописывали тестовые платежи в data/lava-webhook.log рядом с кодом — на
     * сервере это боевой журнал оплат.
     */
    const logFile = pathR.join(__dirname, 'data', 'lava-webhook.log');
    const stat = () => (fsR.existsSync(logFile) ? `${fsR.statSync(logFile).size}:${fsR.statSync(logFile).mtimeMs}` : 'нет');
    const before = stat();
    const env = { ...process.env };
    delete env.TRAPEZA_DB;
    delete env.LAVA_LOG;
    spawnSync(process.execPath, ['platega-selftest.js'], { cwd: __dirname, env, encoding: 'utf8' });
    ok(stat() === before, 'прогон оплат не пишет в боевой журнал вебхуков', `${before} → ${stat()}`);
  }

  console.log(bad ? `\nне прошло: ${bad}` : '\nвсе атаки отражены ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.log(`  ❌ проверка оборвалась → ${e.message}`);
  process.exit(1);
});
