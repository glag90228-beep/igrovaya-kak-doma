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

    /*
     * Раскладка update.sh и install.sh удаляет всё, чего нет в репозитории, —
     * кроме базы, ключей и зависимостей. Одна пропавшая защита, и обновление
     * стирает боевую базу. Команду берём из самого скрипта, а не переписываем
     * сюда: иначе проверялась бы копия, а скрипт жил бы своей жизнью.
     *
     * SRC у скриптов разный: update.sh получает корень клона и сам дописывает
     * trapeza/, install.sh — уже папку trapeza, в которой лежит.
     */
    const haveRsync = spawnSync('rsync', ['--version']).status === 0;
    for (const [name, srcDir] of [['update.sh', 'src'], ['install.sh', 'src/trapeza']]) {
      const script = fsR.readFileSync(pathR.join(__dirname, 'deploy', name), 'utf8');
      const cmd = (/^rsync -a --delete[\s\S]*?"\$APP\/"$/m.exec(script) || [])[0];
      ok(Boolean(cmd), `в ${name} раскладка идёт через rsync --delete`);
      if (!cmd || !haveRsync) continue;
      const box = fsR.mkdtempSync(pathR.join(osR.tmpdir(), 'trapeza-deploy-'));
      const put = (rel, text) => {
        fsR.mkdirSync(pathR.dirname(pathR.join(box, rel)), { recursive: true });
        fsR.writeFileSync(pathR.join(box, rel), text);
      };
      put('src/trapeza/bot.js', 'новый код');
      put('src/trapeza/.env.example', 'BOT_TOKEN=');
      put('app/bot.js', 'поправлено руками на сервере');
      put('app/lib/udalyonnyj.js', 'модуль, убранный из репозитория');
      const keep = ['data/trapeza.db', 'data/lava-webhook.log', 'node_modules/exceljs/index.js',
        '.env', '.env.bak.20260901', '.package-lock.deployed'];
      for (const f of keep) put(`app/${f}`, `боевое: ${f}`);
      const r = spawnSync('bash', ['-c', cmd], {
        env: { ...process.env, SRC: pathR.join(box, srcDir), APP: pathR.join(box, 'app') }, encoding: 'utf8',
      });
      const read = (rel) => (fsR.existsSync(pathR.join(box, 'app', rel)) ? fsR.readFileSync(pathR.join(box, 'app', rel), 'utf8') : null);
      const lost = keep.filter((f) => read(f) !== `боевое: ${f}`);
      ok(r.status === 0 && !lost.length, `${name}: база, ключи и зависимости переживают раскладку`,
        `${r.status} ${lost.join(', ')} ${String(r.stderr).trim()}`);
      ok(read('lib/udalyonnyj.js') === null, `${name}: убранный из репозитория файл с сервера удалён`);
      ok(read('bot.js') === 'новый код', `${name}: правка руками на сервере заменена кодом из репозитория`);
      fsR.rmSync(box, { recursive: true, force: true });
    }
    if (!haveRsync) console.log('  — rsync на этой машине нет: раскладку проверит прогон на сервере');
  }

  console.log('\n=== Вход на сайт: подбор, повтор, подделка запроса ===');
  {
    process.env.BOT_TOKEN = process.env.BOT_TOKEN || '111:REDTEAM';
    const cryptoW = require('node:crypto');
    const webAuth = require('./lib/web-auth');
    const { db: dbW } = require('./db');
    const { server: srvW } = require('./miniapp');
    await new Promise((r) => srvW.listen(0, r));
    const base = `http://127.0.0.1:${srvW.address().port}`;
    const XRW = { 'X-Requested-With': 'pervichka' };
    const sha = (v) => cryptoW.createHash('sha256').update(v).digest('hex');
    const post = (p, body, headers = {}) => fetch(base + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, headers: res.headers, text: await res.text() }));
    const get = (p, headers = {}) => fetch(base + p, { headers }).then(async (res) => ({
      status: res.status, headers: res.headers, text: await res.text(),
    }));
    const victim = bdb.getOrCreateUser(990001, 'Жертва', 'victim');
    const cookieOf = (res) => /pv_sid=([^;]+)/.exec(res.headers.get('set-cookie') || '');

    /** Вход, подтверждённый жертвой, — получаем её cookie. */
    async function victimCookie() {
      webAuth.resetLimits();
      const s = await post('/api/login/start', {}, XRW);
      const nonce = JSON.parse(s.text).nonce;
      webAuth.confirmLogin(webAuth.previewLogin(nonce).id, victim.id);
      webAuth.resetLimits();
      const c = await post('/api/login/check', { nonce }, XRW);
      return { cookie: `pv_sid=${cookieOf(c)[1]}`, token: cookieOf(c)[1], nonce };
    }

    // --- подбор nonce ---
    {
      webAuth.resetLimits();
      let ok200 = 0;
      let limited = 0;
      let first429 = 0;
      for (let i = 1; i <= 160; i += 1) {
        const guess = cryptoW.randomBytes(24).toString('base64url');
        const res = await post('/api/login/check', { nonce: guess }, XRW);
        if (res.status === 200) ok200 += 1;
        if (res.status === 429) { limited += 1; if (!first429) first429 = i; }
        if (cookieOf(res)) ok200 += 1000;
      }
      ok(ok200 === 0, 'подбор nonce: ни одной удачи и ни одной cookie за 160 попыток', ok200);
      ok(first429 === 121 && limited === 40, 'с одного адреса после 120 попыток в минуту — 429 (запас на несколько вкладок, не на перебор)', `первый отказ на ${first429}, всего ${limited}`);
      webAuth.resetLimits();
    }

    // --- хэши из базы не заменяют секреты ---
    {
      const { cookie, token, nonce } = await victimCookie();
      const sessRow = dbW.prepare('SELECT token_hash FROM web_sessions WHERE user_id = ?').get(victim.id);
      const loginRow = dbW.prepare('SELECT nonce_hash FROM web_logins WHERE nonce_hash = ?').get(sha(nonce));
      const viaHash = await get('/api/state', { ...XRW, Cookie: `pv_sid=${sessRow.token_hash}` });
      ok(viaHash.status === 401, 'утёкший хэш токена из копии базы войти не позволяет', viaHash.status);
      webAuth.resetLimits();
      const viaNonceHash = await post('/api/login/check', { nonce: loginRow.nonce_hash }, XRW);
      ok(viaNonceHash.status === 400, 'и хэш nonce — не nonce', viaNonceHash.status);
      const viaId = await post('/api/login/check', { nonce: webAuth.sha(nonce).slice(0, 20) }, XRW);
      ok(viaId.status === 400 || viaId.status === 429, 'идентификатор из кнопки бота тоже не годится как nonce', viaId.status);
      const dump = JSON.stringify(dbW.prepare('SELECT * FROM web_sessions').all()) + JSON.stringify(dbW.prepare('SELECT * FROM web_logins').all());
      ok(!dump.includes(token) && !dump.includes(nonce), 'ни токена, ни nonce нет в таблицах целиком');
      void cookie;
    }

    // --- повтор ---
    {
      const { cookie, nonce } = await victimCookie();
      webAuth.resetLimits();
      const again = await post('/api/login/check', { nonce }, XRW);
      ok(again.status === 404 && !cookieOf(again), 'повтор опроса по использованному nonce сессии не выдаёт', again.status);
      const out = await post('/api/logout', {}, { ...XRW, Cookie: cookie });
      const replay = await get('/api/state', { ...XRW, Cookie: cookie });
      ok(out.status === 200 && replay.status === 401, 'украденная и «проигранная» после выхода cookie не работает', replay.status);
    }

    // --- подделка запроса с чужого сайта ---
    {
      const { cookie } = await victimCookie();
      const ai = () => dbW.prepare('SELECT ai_enabled FROM bot_users WHERE id = ?').get(victim.id).ai_enabled;
      await post('/api/user/ai', { enabled: true }, { ...XRW, Cookie: cookie });
      const before = ai();
      const attempts = [
        ['форма с чужого сайта (text/plain, без заголовка)', { 'Content-Type': 'text/plain', Cookie: cookie, Origin: 'https://evil.example' }],
        ['fetch с чужого сайта (заголовок есть, Origin чужой)', { ...XRW, Cookie: cookie, Origin: 'https://evil.example' }],
        ['без Origin, Referer чужой', { ...XRW, Cookie: cookie, Referer: 'https://evil.example/x' }],
        ['Sec-Fetch-Site: cross-site', { ...XRW, Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }],
        ['только cookie, без заголовка и Origin', { Cookie: cookie }],
      ];
      for (const [name, headers] of attempts) {
        const res = await post('/api/user/ai', { enabled: false }, headers);
        ok(res.status === 403 && ai() === before, `подделка: ${name} — отказ, данные не тронуты`, `${res.status}`);
      }
      const rm = await post('/api/logout/all', {}, { Cookie: cookie, Origin: 'https://evil.example' });
      ok(rm.status === 403 && webAuth.listSessions(victim.id).length >= 1, 'чужой сайт не может выбросить человека из приложения (logout)', rm.status);

      // Подмена входа: чужая страница не подсадит браузеру жертвы cookie атакующего.
      webAuth.resetLimits();
      const mine = await post('/api/login/start', {}, XRW);
      const attackerNonce = JSON.parse(mine.text).nonce;
      const attacker = bdb.getOrCreateUser(990002, 'Атакующий', 'mallory');
      webAuth.confirmLogin(webAuth.previewLogin(attackerNonce).id, attacker.id);
      webAuth.resetLimits();
      const cross = await post('/api/login/check', { nonce: attackerNonce }, { ...XRW, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
      const form = await post('/api/login/check', { nonce: attackerNonce }, { 'Content-Type': 'text/plain', Origin: 'https://evil.example' });
      ok(cross.status === 403 && form.status === 403 && !cookieOf(cross) && !cookieOf(form),
        'login CSRF: чужая страница не может подсадить браузеру cookie чужого входа', `${cross.status}/${form.status}`);
      ok(webAuth.checkLogin(attackerNonce).status === 'ok', 'а настоящему браузеру тот вход всё ещё отдаётся (отказы его не сожгли)');
    }

    // --- подмена сессии до входа ---
    {
      const planted = cryptoW.randomBytes(32).toString('base64url');
      const noAuth = await get('/api/state', { ...XRW, Cookie: `pv_sid=${planted}` });
      ok(noAuth.status === 401, 'подброшенная заранее cookie не даёт ничего', noAuth.status);
      webAuth.resetLimits();
      const s = await post('/api/login/start', {}, { ...XRW, Cookie: `pv_sid=${planted}` });
      const nonce = JSON.parse(s.text).nonce;
      webAuth.confirmLogin(webAuth.previewLogin(nonce).id, victim.id);
      webAuth.resetLimits();
      const c = await post('/api/login/check', { nonce }, { ...XRW, Cookie: `pv_sid=${planted}` });
      ok(cookieOf(c)[1] !== planted, 'после входа выдан новый токен, подброшенный не принимается (фиксации сессии нет)');
      const still = await get('/api/state', { ...XRW, Cookie: `pv_sid=${planted}` });
      ok(still.status === 401, 'подброшенный токен остаётся мёртвым', still.status);
    }

    // --- жертва по чужой ссылке: числа она не видела ---
    {
      const { offer, answer } = require('./lib/bot-web-login');
      const sentW = [];
      const fakeTg = {
        async sendMessage(_c, text, opts) { sentW.push({ text, kb: ((opts || {}).reply_markup || {}).inline_keyboard || [] }); return {}; },
        async call() { return {}; },
      };
      const N = 300;
      let landed = 0;          // вход подтверждён жертвой вслепую
      let secondTry = 0;       // удалось нажать ещё раз после ошибки
      let wrongKept = 0;       // неверный выбор оставил вход живым
      for (let i = 0; i < N; i += 1) {
        webAuth.resetLimits();
        // Атакующий открывает сайт у себя и получает ссылку; число видит только он.
        const s = await post('/api/login/start', {}, { ...XRW, 'X-Real-IP': `198.51.100.${i % 250 + 1}` });
        const { nonce, code } = JSON.parse(s.text);
        // Жертва открывает бота по присланной ссылке и тыкает, не зная числа.
        sentW.length = 0;
        await offer(fakeTg, { id: victim.id }, nonce);
        const buttons = sentW[0].kb[0];
        const pick = cryptoW.randomInt(0, 3);
        sentW.length = 0;
        await answer(fakeTg, { id: victim.id }, victim, buttons[pick].callback_data, 1, undefined);
        const verdict = sentW[0].text;
        const right = Number(buttons[pick].text) === code;
        if (right && verdict.includes('Вход подтверждён')) landed += 1;
        if (!right) {
          // Ошибка отменяет вход: ни другая кнопка, ни верная, ни повторное открытие ссылки не помогают.
          for (let k = 0; k < 3; k += 1) {
            if (k === pick) continue;
            sentW.length = 0;
            await answer(fakeTg, { id: victim.id }, victim, buttons[k].callback_data, 1, undefined);
            if (!sentW[0].text.includes('Ссылка устарела')) secondTry += 1;
          }
          sentW.length = 0;
          await offer(fakeTg, { id: victim.id }, nonce);
          if (sentW[0].kb.length) secondTry += 1;
          webAuth.resetLimits();
          if (webAuth.checkLogin(nonce).status !== 'denied') wrongKept += 1;
        }
      }
      ok(secondTry === 0 && wrongKept === 0, 'после неверного числа второй попытки нет: ни другие кнопки, ни верная, ни повторное открытие ссылки', `${secondTry}/${wrongKept}`);
      ok(landed > 0.2 * N && landed < 0.47 * N, 'жертва, не видевшая экрана, проходит в среднем в одном случае из трёх (кнопок три), не чаще', `${landed} из ${N}`);

      // Знающий число (сам владелец у своего экрана) проходит всегда.
      webAuth.resetLimits();
      const s2 = await post('/api/login/start', {}, XRW);
      const { nonce: n2, code: c2 } = JSON.parse(s2.text);
      sentW.length = 0;
      await offer(fakeTg, { id: victim.id }, n2);
      const btn2 = sentW[0].kb[0].find((b) => Number(b.text) === c2);
      await answer(fakeTg, { id: victim.id }, victim, btn2.callback_data, 1, undefined);
      webAuth.resetLimits();
      const ck2 = await post('/api/login/check', { nonce: n2 }, XRW);
      ok(ck2.status === 200 && cookieOf(ck2), 'тот, кто видит экран и выбрал верное число, входит');

      // Из сообщения бота верное число не прочитать: ни в тексте, ни в данных кнопок нет указания на верную.
      const flat = JSON.stringify(sentW);
      ok(!flat.includes(n2) && sentW[0].kb[0].every((b) => /^wl\.n[0-2]:[0-9a-f]{20}$/.test(b.callback_data)),
        'в кнопках бота нет nonce, а данные кнопок не выдают, какая из них верная');
    }

    // --- мусор вместо токена и nonce ---
    {
      const junk = ["' OR 1=1 --", '%00', '../../etc/passwd', 'a'.repeat(5000), '<script>', '\u0000'];
      let bad401 = true;
      for (const j of junk) {
        let res;
        try { res = await get('/api/state', { ...XRW, Cookie: `pv_sid=${encodeURIComponent(j)}` }); } catch (_) { continue; }
        if (res.status !== 401) bad401 = false;
      }
      ok(bad401, 'мусор в cookie (SQL, нули, путь, мегабайты) — всегда 401, сервер жив');
      webAuth.resetLimits();
      let bad400 = true;
      for (const j of junk) {
        const res = await post('/api/login/check', { nonce: j }, XRW);
        // 413 — тело в пять килобайт не читается вовсе: на входе хватает четырёх.
        if (res.status !== 400 && res.status !== 413) bad400 = false;
        webAuth.resetLimits();
      }
      ok(bad400, 'мусор вместо nonce — всегда 400 (а слишком большое тело — 413)');
      const alive = await get('/health');
      ok(alive.status === 200, 'сервер после всего жив');
    }

    // --- чужой User-Agent не попадает в сообщение бота разметкой ---
    {
      const { offer } = require('./lib/bot-web-login');
      const said = [];
      const fakeTg = { async sendMessage(_c, text) { said.push(text); return {}; } };
      const evil = webAuth.startLogin({ ip: '203.0.113.77', ua: '<img src=x onerror=alert(1)> <a href="https://evil.example">нажми</a> Chrome/1 Windows' });
      await offer(fakeTg, { id: 1 }, evil.nonce);
      ok(said.length === 1 && !/<img|<a |evil\.example|onerror/.test(said[0]) && said[0].includes('Chrome, Windows'),
        'User-Agent с разметкой и ссылками показывается только как «Chrome, Windows»', said[0]);
    }

    // --- залив ожидающими входами ---
    {
      const now = new Date();
      const later = new Date(Date.now() + 300000).toISOString();
      const ins = dbW.prepare('INSERT INTO web_logins (nonce_hash, created_at, expires_at) VALUES (?,?,?)');
      dbW.exec('BEGIN');
      for (let i = 0; i < 3000; i += 1) ins.run(sha(`flood-${i}`), now.toISOString(), later);
      dbW.exec('COMMIT');
      webAuth.resetLimits();
      const res = await post('/api/login/start', {}, { ...XRW, 'X-Real-IP': '198.51.100.99' });
      ok(res.status === 503, 'когда ожидающих входов слишком много (залив с разных адресов), новые не принимаются', res.status);
      dbW.prepare('DELETE FROM web_logins WHERE created_at = ?').run(now.toISOString());
      webAuth.resetLimits();
      const fine = await post('/api/login/start', {}, XRW);
      ok(fine.status === 200, 'после уборки вход снова открыт', fine.status);
    }

    // --- рамка ---
    {
      const page = await get('/');
      ok(/frame-ancestors/.test(page.headers.get('content-security-policy') || ''), 'страницу нельзя вставить в чужую рамку (кликджекинг)');
    }
    await new Promise((r) => srvW.close(r));
  }

  console.log(bad ? `\nне прошло: ${bad}` : '\nвсе атаки отражены ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.log(`  ❌ проверка оборвалась → ${e.message}`);
  process.exit(1);
});
