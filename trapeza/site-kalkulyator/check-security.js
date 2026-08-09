'use strict';
/**
 * Проверки безопасности того, что уезжает на хостинг.
 *   node check-security.js <папка-собранного-сайта>
 * Запускает настоящий PHP и стучится в панель и сохранение сметы так,
 * как это делал бы посторонний.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, 'site-new'));
const PORT = 4470;
const B = `http://127.0.0.1:${PORT}`;
const PASS = process.env.ADMIN_PASS || '';

let bad = 0;
const ok = (c, m, extra) => {
  console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra));
  if (!c) bad += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body, headers = {}) => fetch(B + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual',
});

(async () => {
  const php = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', ROOT], { stdio: 'ignore' });
  await wait(1200);

  // ── панель: без пароля внутрь не попасть ──
  const noAuth = await post('/admin.php?api=save', { items: [{ n: 'взлом', p: 1 }] });
  ok(noAuth.status === 403, 'сохранение меню без входа отклоняется', noAuth.status);
  const noAuthPhoto = await fetch(B + '/admin.php?api=photo', { method: 'POST' });
  ok(noAuthPhoto.status === 403, 'загрузка фото без входа отклоняется', noAuthPhoto.status);

  const list = await fetch(B + '/admin.php');
  const html = await list.text();
  ok(!html.includes('kb-card') && html.includes('name="password"'),
    'без входа панель показывает только форму пароля');
  ok(!/\$2y\$/.test(html), 'хэш пароля в выдачу не попадает');
  ok(html.includes('noindex'), 'панель закрыта от поисковиков метатегом');

  // ── перебор пароля ограничен по адресу, а не по сессии ──
  fs.rmSync(path.join(ROOT, 'menu-backup', '.login'), { force: true });
  let blocked = 0;
  for (let i = 0; i < 11; i++) {
    // каждый раз без cookie — как будто новый посетитель
    const r = await fetch(B + '/admin.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=login&password=' + encodeURIComponent('подбор' + i),
    });
    if ((await r.text()).includes('Слишком много попыток')) blocked += 1;
  }
  ok(blocked >= 2, 'перебор пароля блокируется даже без cookie', 'сработало ' + blocked + ' раз из 11');

  // ── смета: чужой HTML не превращается в страницу ──
  const evil = await post('/smeta.php', {
    guests: 5, transport: 0,
    name: '<img src=x onerror=alert(1)>',
    items: [{ n: '<script>alert(1)</scr' + 'ipt>', u: 'шт', q: 1, p: 10 }],
  }).then((r) => r.json());
  ok(Boolean(evil.ok && evil.url), 'смета сохраняется', JSON.stringify(evil));
  if (evil.url) {
    ok(evil.url.startsWith('/smeta/'), 'сервер отдаёт относительный адрес, а не собранный из Host', evil.url);
    const saved = fs.readFileSync(path.join(ROOT, evil.url.replace(/^\//, '')), 'utf8');
    ok(!saved.includes('<script>alert(1)'), 'скрипт из названия блюда экранирован');
    // после экранирования текст «onerror=alert» остаётся, но уже как текст —
    // проверяем именно отсутствие живого тега
    ok(!/<img\s+src=x/i.test(saved) && saved.includes('&lt;img src=x'),
      'разметка из имени заказчика превращена в текст');
    ok(/smeta\/\d{6}-[0-9a-f]{16}\.html$/.test(evil.url),
      'имя файла сметы не подобрать перебором (8 байт случайности)', evil.url);
    ok(saved.includes('noindex'), 'сохранённая смета закрыта от поисковиков');
  }

  // подменённый Host не должен влиять на ссылку
  const spoof = await post('/smeta.php', { guests: 2, transport: 0,
    items: [{ n: 'Тест', u: 'шт', q: 1, p: 1 }] }, { Host: 'evil.example' }).then((r) => r.json());
  ok(!String(spoof.url || '').includes('evil.example'), 'подмена заголовка Host не уводит ссылку', spoof.url);

  // GET на сохранение сметы не работает
  const getSmeta = await fetch(B + '/smeta.php');
  ok(getSmeta.status === 405, 'смета создаётся только методом POST', getSmeta.status);

  // ── ограничение частоты сохранения смет ──
  fs.readdirSync(path.join(ROOT, 'smeta')).forEach((f) => {
    if (f.startsWith('.rate-')) fs.rmSync(path.join(ROOT, 'smeta', f));
  });
  let limited = false;
  for (let i = 0; i < 33; i++) {
    const r = await post('/smeta.php', { guests: 1, transport: 0,
      items: [{ n: 'Поток ' + i, u: 'шт', q: 1, p: 1 }] });
    if (r.status === 429) { limited = true; break; }
  }
  ok(limited, 'поток запросов на сохранение смет останавливается');

  // ── .htaccess: что закрыто ──
  const ht = fs.readFileSync(path.join(ROOT, '.htaccess'), 'utf8');
  ok(/FilesMatch "\^\(\?!robots\\\.txt\$\).*\\\.txt\$"/.test(ht), '.htaccess: текстовые заметки закрыты');
  ok(ht.includes('RedirectMatch 404 ^/menu-backup/'), '.htaccess: копии меню закрыты');
  ok(ht.includes('X-Robots-Tag'), '.htaccess: сметы помечены noindex');
  ok(ht.includes('REQUEST_FILENAME'), '.htaccess: существующие файлы не перехватываются редиректами');

  const rob = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  ok(rob.includes('Disallow: /admin.php') && rob.includes('Disallow: /smeta/')
    && rob.includes('Disallow: /menu-backup/'), 'robots: служебное закрыто от обхода');

  // ── в файлах на хостинге нет секретов ──
  const files = fs.readdirSync(ROOT).filter((f) => /\.(html|php|json|txt|xml)$/.test(f));
  const leaks = [];
  for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/\d{9,10}:AA[\w-]{30,}/.test(t)) leaks.push(f + ': токен бота');
    if (PASS && t.includes(PASS)) leaks.push(f + ': пароль панели текстом');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(t)) leaks.push(f + ': приватный ключ');
  }
  ok(leaks.length === 0, 'в выкладываемых файлах нет токенов и паролей', leaks.join('; '));
  ok(!files.some((f) => f.endsWith('.txt') && f !== 'robots.txt'),
    'посторонних текстовых файлов в корне нет',
    files.filter((f) => f.endsWith('.txt') && f !== 'robots.txt').join(', '));

  // ── загруженные фото не должны исполняться ──
  ok(fs.existsSync(path.join(ROOT, 'img', 'menu', '.htaccess'))
    || fs.readFileSync(path.join(__dirname, 'admin.php'), 'utf8').includes('php_flag engine off'),
    'папка загруженных фото защищена от выполнения кода');

  // ── панель: с паролем всё работает, CSRF обязателен ──
  if (PASS) {
    fs.rmSync(path.join(ROOT, 'menu-backup', '.login'), { force: true });
    const login = await fetch(B + '/admin.php', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=login&password=' + encodeURIComponent(PASS), redirect: 'manual',
    });
    const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])
      .map((c) => c.split(';')[0]).join('; ');
    ok(Boolean(cookie), 'вход с правильным паролем выдаёт сессию');
    const noCsrf = await post('/admin.php?api=save',
      { items: [{ n: 'без токена', p: 1 }] }, { Cookie: cookie });
    ok(noCsrf.status === 403, 'сохранение без CSRF-токена отклоняется', noCsrf.status);
  } else {
    console.log('  ·  проверки с паролем пропущены (задайте ADMIN_PASS)');
  }

  php.kill();
  console.log(bad ? `\nнебезопасных мест: ${bad}` : '\nпроверки безопасности пройдены ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ТЕСТ УПАЛ:', e); process.exit(1); });
