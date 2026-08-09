'use strict';
// Собирает kalkulyator.html на файлах сайта трапеза18.рф:
// его же шапка, подвал, шрифты, токены и скрипты — плюс наш конструктор сметы.
//
//   node build.js <папка-с-сайтом> [<папка-результата>]
//
// Первая папка — распакованный архив сайта (index.html, furshet.html, img/…).
// Результат — её копия с добавленной страницей kalkulyator.html.

const fs = require('node:fs');
const path = require('node:path');

const D = __dirname;
const SRC = path.resolve(process.argv[2] || path.join(D, 'site'));
const OUT = path.resolve(process.argv[3] || path.join(D, 'site-new'));
const TRAPEZA = path.join(D, '..');
if (!fs.existsSync(path.join(SRC, 'furshet.html'))) {
  console.error('Не нашёл сайт в ' + SRC + '. Укажите папку: node build.js <папка-с-сайтом>');
  process.exit(1);
}

// ---------- меню ----------
// Фото: сначала то, что уже лежит на сайте (img/…), затем наши файлы (img/menu/…).
const PHOTO = {
  'Закуска «Рафаэлло»': 'img/rafaello.webp',
  'Сырный ЧИЗБОЛ': 'img/syrnyy-chizbol.webp',
  'Канапе из сыра Камамбер свежих ягод и мяты': 'img/kanape-kamamber-yagody.webp',
  'Канапе из сыра ламбер и винограда с мятой': 'img/kanape-lamber.webp',
  'Канапе из сальчичона, фетаксы и черри с микрозеленью': 'img/kanape-iz-salchichona-fetaksy-i-cherri.webp',
  'Канапе с креветкой и черри': 'img/kanape-s-krevetkoy.webp',
  'Брускетта с сёмгой с/с и творожным сыром': 'img/brusketta-s-semgoy-slabosolenoy.webp',
  'Брускетта с пастромой копчёной, творожным сыром и черри': 'img/brusketta-pastroma.webp',
  'Мини пирожок с мясом': 'img/mini-pirozhok-s-myasom.webp',
  'Мини кокрок с яблоком': 'img/mini-kokrok-s-yablokom.webp',
  'Мини элеш с куриной грудкой': 'img/mini-elesh-s-kuricey.webp',
  'Мини-безе с кремом крем-чиз и голубикой': 'img/mini-beze-s-krem-chizom-i-golubikoy.webp',
  // наш снимок — кладём в img/menu/
  'Мини элеш «Курица-картофель»': 'img/menu/elesh-kurica-kartofel.png',
};
// У перепечей с мясом и с зелёным луком в архиве оказался один и тот же файл
// (общее фото ассорти) — ставить его двум разным блюдам нельзя, оставили без фото.
const OUR_PHOTOS = {
  'img/menu/elesh-kurica-kartofel.png': 'elesh-kurica-kartofel.png',
};

const furshet = require(path.join(TRAPEZA, 'menu-data.js'));
const banket = require(path.join(TRAPEZA, 'menu-data-banket.js'));
const items = [];
for (const [mt, list] of [['furshet', furshet], ['banket', banket]]) {
  for (const [n, d, u, p, c, t] of list) {
    items.push({ n, d: d || '', u: u || '', p, t: t || 0, c, mt, ph: PHOTO[n] || '' });
  }
}

// ---------- разбор страницы сайта ----------
const src = fs.readFileSync(path.join(SRC, 'furshet.html'), 'utf8');
const cut = (from, to, label) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('не нашёл блок: ' + label);
  return src.slice(a, b + to.length);
};

const head = cut('<!DOCTYPE html>', '</head>', 'head');
// Стили страниц (.page-hero, .h1, .breadcrumb …) лежат отдельным блоком сразу за </head>
const afterHead = src.indexOf('</head>') + '</head>'.length;
const ps = src.indexOf('<style>', afterHead);
const pageStyle = src.slice(ps, src.indexOf('</style>', ps) + '</style>'.length);
if (ps < 0 || !pageStyle.includes('.page-hero')) throw new Error('не нашёл стили страницы');
const header = cut('<header class="site-header"', '</header>', 'шапка');
const mobile = cut('<div class="mobile-menu"', '</div>\n', 'мобильное меню');
const order = cut('<section class="section order" id="order">', '</section>', 'блок заявки');
const footer = cut('<footer class="site-footer">', '</footer>', 'подвал');
const privacy = cut('<div id="privacy-modal"', '<script>/* ════ FORM CONFIG', 'модалка 152-ФЗ')
  .replace('<script>/* ════ FORM CONFIG', '');
const scripts = cut('<script>/* ════ FORM CONFIG', '</body>', 'скрипты').replace('</body>', '');

// шапку правим: пункт «Калькулятор» ведёт на новую страницу
const relink = (s) => s
  .replace(/href="furshet\.html#calc"/g, 'href="kalkulyator.html"')
  .replace(/href="#order"/g, 'href="index.html#order"');

// ---------- голова новой страницы ----------
let newHead = head
  .replace(/<title>[\s\S]*?<\/title>/,
    '<title>Калькулятор меню — соберите заказ и получите смету | Трапеза</title>')
  .replace(/<meta name="description"[\s\S]*?>/,
    '<meta name="description" content="Калькулятор кейтеринга «Трапеза»: фуршетное и банкетное меню '
    + 'с ценами и составом блюд. Выберите позиции и количество гостей — получите готовую смету '
    + 'с расчётом и отправьте заявку.">')
  .replace(/<meta property="og:title"[\s\S]*?>/,
    '<meta property="og:title" content="Калькулятор меню — Трапеза">')
  .replace(/<meta property="og:description"[\s\S]*?>/,
    '<meta property="og:description" content="Соберите заказ по меню и получите готовую смету за пару минут.">')
  .replace(/<link rel="canonical"[\s\S]*?>/, '<link rel="canonical" href="https://трапеза18.рф/kalkulyator.html">')
  .replace(/<meta property="og:url"[\s\S]*?>/, '<meta property="og:url" content="https://трапеза18.рф/kalkulyator.html">');

// микроразметку конкретной страницы фуршета убираем — она не про калькулятор
newHead = newHead.replace(/<script type="application\/ld\+json">\{"@context": "https:\/\/schema\.org", "@type": "ItemList"[\s\S]*?<\/script>\n?/, '');

const section = fs.readFileSync(path.join(D, 'kb-section.html'), 'utf8');
const script = fs.readFileSync(path.join(D, 'kb-script.html'), 'utf8')
  .replace('/*__MENU__*/[]', JSON.stringify(items));

const page = [
  newHead.replace('</head>', pageStyle + '\n' + section.slice(0, section.indexOf('</style>') + 8) + '\n</head>'),
  '<body>',
  relink(header),
  relink(mobile),
  section.slice(section.indexOf('</style>') + 8).trim(),
  relink(order),
  relink(footer),
  privacy.trim(),
  relink(scripts).trim(),
  script.trim(),
  '</body>',
  '</html>',
].join('\n');

// ---------- копия сайта с правками ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'kalkulyator.html'), page);

// наши фотографии блюд → img/menu/
fs.mkdirSync(path.join(OUT, 'img', 'menu'), { recursive: true });
for (const [dest, file] of Object.entries(OUR_PHOTOS)) {
  fs.copyFileSync(path.join(TRAPEZA, 'photos', file), path.join(OUT, dest));
}

// пункт «Калькулятор» во всех меню сайта ведёт на новую страницу
const pages = fs.readdirSync(OUT).filter((f) => f.endsWith('.html') && f !== 'kalkulyator.html');
let touched = 0;
for (const f of pages) {
  const p = path.join(OUT, f);
  const before = fs.readFileSync(p, 'utf8');
  let after = before.replace(/href="furshet\.html#calc"/g, 'href="kalkulyator.html"');
  // и «Рассчитать стоимость» в шапке страницы кейтеринга
  if (f === 'furshet.html') after = after.replace(/href="#calc" class="btn btn--outline-light"/,
    'href="kalkulyator.html" class="btn btn--outline-light"');
  if (after !== before) { fs.writeFileSync(p, after); touched++; }
}

// карта сайта
const smPath = path.join(OUT, 'sitemap.xml');
const sm = fs.readFileSync(smPath, 'utf8');
if (!sm.includes('kalkulyator.html')) {
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(smPath, sm.replace('</urlset>',
    `  <url>\n    <loc>https://трапеза18.рф/kalkulyator.html</loc>\n`
    + `    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>\n</urlset>`));
}

console.log(`kalkulyator.html: ${(page.length / 1024).toFixed(0)} КБ, позиций ${items.length}`
  + ` (фуршет ${furshet.length} + банкет ${banket.length}), с фото ${items.filter((i) => i.ph).length}`);
console.log(`ссылку «Калькулятор» поправили на ${touched} страницах, sitemap обновлён`);
