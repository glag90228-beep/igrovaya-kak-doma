'use strict';
// Проверка того, на что ругался Яндекс.Вебмастер: карта сайта, robots, метатеги.
//   node check-seo.js <папка-собранного-сайта>

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, 'site-new'));
let bad = 0;
const ok = (c, m, extra) => {
  console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra));
  if (!c) bad += 1;
};

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- карта сайта ----------
const sm = read('sitemap.xml');
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const mods = [...sm.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);

ok(sm.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'sitemap: объявление XML на первой строке');
ok(sm.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'), 'sitemap: правильный namespace');
ok(locs.length > 0, 'sitemap: адреса найдены', locs.length);
// протокол требует ASCII: кириллический домен обязан быть в punycode
const nonAscii = locs.filter((u) => /[^\x20-\x7E]/.test(u));
ok(nonAscii.length === 0, 'sitemap: все адреса в ASCII', nonAscii.join(', '));
ok(mods.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), 'sitemap: даты в формате ГГГГ-ММ-ДД');

const files = locs.map((u) => u.replace(/^https?:\/\/[^/]+\//, '') || 'index.html');
const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
ok(missing.length === 0, 'sitemap: все страницы существуют', missing.join(', '));

const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const forgotten = pages.filter((f) => !files.includes(f));
ok(forgotten.length === 0, 'sitemap: ни одна страница не забыта', forgotten.join(', '));

// ---------- robots ----------
const rob = read('robots.txt');
ok(/Sitemap: https:\/\/[\x20-\x7E]+sitemap\.xml/.test(rob), 'robots: ссылка на карту сайта в ASCII');
ok(rob.includes('Disallow: /admin.php'), 'robots: панель закрыта от индексации');
ok(rob.includes('Allow: /menu.json'), 'robots: меню разрешено к обходу');

// ---------- метатеги ----------
for (const f of pages.sort()) {
  const s = read(f);
  const d = /<meta name="description" content="([^"]+)"/.exec(s);
  const t = /<title>([^<]+)<\/title>/.exec(s);
  const c = /<link rel="canonical" href="([^"]+)"/.exec(s);
  const len = d ? d[1].length : 0;
  ok(Boolean(t && d && c && len >= 60 && len <= 200),
    `${f}: title, description (${len} зн.) и canonical`,
    !d ? 'нет description' : !c ? 'нет canonical' : !t ? 'нет title' : 'длина description вне 60–200');
}

// ---------- разметка организации ----------
const idx = read('index.html');
const ld = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(idx);
ok(Boolean(ld), 'на главной есть микроразметка');
if (ld) {
  let j = null;
  try { j = JSON.parse(ld[1]); } catch { /* ниже сообщим */ }
  ok(Boolean(j), 'микроразметка — корректный JSON');
  if (j) {
    ok(j.address && j.address.addressLocality === 'Ижевск', 'в разметке указан город Ижевск',
      j.address && j.address.addressLocality);
    ok(Array.isArray(j.areaServed) && j.areaServed.length > 0, 'указан регион обслуживания');
    ok(Boolean(j.telephone && j.openingHoursSpecification), 'указаны телефон и часы работы');
  }
}

console.log(bad ? `\nне прошло: ${bad}` : '\nSEO-проверки пройдены ✅');
process.exit(bad ? 1 : 0);
