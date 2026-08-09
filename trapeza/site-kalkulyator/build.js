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
  // Каждый снимок открыт и проверен глазами: на нём именно это блюдо.
  'Закуска «Рафаэлло»': 'img/rafaello.webp',
  'Сырный ЧИЗБОЛ': 'img/syrnyy-chizbol.webp',
  'Мини-тарталетка с салатом полесский': 'img/tartlets.jpg',
  'Канапе из сыра Камамбер свежих ягод и мяты': 'img/kanape-kamamber-yagody.webp',
  'Канапе из сыра ламбер и винограда с мятой': 'img/kanape-lamber.webp',
  'Канапе из сальчичона, фетаксы и черри с микрозеленью': 'img/kanape-iz-salchichona-fetaksy-i-cherri.webp',
  'Канапе с креветкой и черри': 'img/kanape-s-krevetkoy.webp',
  'Брускетта с сёмгой с/с и творожным сыром': 'img/brusketta-s-semgoy-slabosolenoy.webp',
  'Брускетта с говядиной': 'img/brusketta-govyadina.webp',
  'Брускетта с пастромой копчёной, творожным сыром и черри': 'img/brusketta-pastroma.webp',
  'Мини-безе с кремом крем-чиз и голубикой': 'img/mini-beze-s-krem-chizom-i-golubikoy.webp',
  'Трайфл шоколадно-банановый / Красный бархат': 'img/zak_trayfl.webp',
  'Трюфели из тёмного шоколада с копчёной паприкой': 'img/zak_trufeli.webp',
  // на снимке ассорти видны начинки с мясом/грибами и с зелёным луком
  'Мини перепечи с мясом': 'img/mini-perepechi-v-assortimente.webp',
  'Мини перепечи с грибами': 'img/mini-perepechi-v-assortimente.webp',
  'Мини перепечи с зелёным луком': 'img/mini-perepechi-v-assortimente.webp',
};

// НЕ ставим (проверено глазами, имя файла обманывает):
//   mini-pirozhok-s-myasom.webp, mini-kokrok-s-yablokom.webp,
//   mini-elesh-s-kuricey.webp, mini-profitroli-s-zavarnym-kremom.webp —
//     это один и тот же снимок стола на кофе-брейке, а не блюдо;
//   photos/elesh-kurica-kartofel.png — на подносе сразу элеш и мини-безе;
//   buffet1, brusch, canape1/2, coffee*, banquet, korporativ-stol, furshet-img* —
//     общие виды накрытых столов.
const OUR_PHOTOS = {};

// ---------- цены на карточках сайта ----------
// На витрине сайта цены разошлись с прайсом. Приводим к прайсу — он источник правды.
const PRICE_FIX = [
  ['Брускетта с сёмгой слабосолёной', 180, 150],
  ['Канапе с сыром Ламбер, виноградом и мятой', 160, 115],
  ['Канапе из сальчичона, фетаксы и черри', 135, 125],
  ['Сырный чизбол', 155, 150],
  ['Брускетта с пастромой копчёной', 125, 120],
  ['Мини элеш с курицей', 50, 55],
];
// «Канапе с креветкой» на витрине 155 ₽ — эту цену перенесли в прайс,
// поэтому карточку не трогаем: она уже совпадает.

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

const today = new Date();
const stamp = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
const section = fs.readFileSync(path.join(D, 'kb-section.html'), 'utf8')
  .replace('<!--__DATE__-->', stamp);
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

// цены на карточках витрины: и в разметке, и в микроразметке Schema.org
function fixPrices(html, report) {
  for (const [name, was, now] of PRICE_FIX) {
    const card = new RegExp('(<h4 class="mc__name">' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + '</h4><span class="mc__price">)' + was + '( ₽)', 'g');
    const before = html;
    html = html.replace(card, `$1${now}$2`);
    if (html !== before) report.push(`${name}: ${was} → ${now} ₽`);

    const ld = new RegExp('("name": "' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + '", "offers": \\{"@type": "Offer", "price": ")' + was + '(")', 'g');
    html = html.replace(ld, `$1${now}$2`);
  }
  return html;
}

// ---------- баннер калькулятора на главной ----------
const BANNER = `
<!-- ════ КАЛЬКУЛЯТОР МЕНЮ ════ -->
<style>
.kalc-band{background:var(--c-dark);color:#fff;padding:clamp(3rem,7vw,5.5rem) 0}
.kalc-band__in{display:flex;gap:clamp(2rem,5vw,4rem);align-items:center;justify-content:space-between;flex-wrap:wrap}
.kalc-band__text{flex:1 1 440px}
.kalc-band h2{font-family:var(--ff-display);font-weight:600;font-size:clamp(2rem,4.6vw,3.4rem);
  line-height:1.08;color:#fff;margin:1rem 0 .9rem}
.kalc-band p{color:rgba(255,255,255,.72);font-size:clamp(1rem,1.4vw,1.12rem);line-height:1.7;max-width:52ch;margin-bottom:1.7rem}
.kalc-band .kicker{color:var(--c-accent-2)}
.kalc-band .kicker::before{background:var(--c-accent-2)}
.kalc-band__note{margin-top:1rem!important;font-size:.86rem!important;color:rgba(255,255,255,.5)!important}
.kalc-steps{flex:0 1 320px;list-style:none;display:grid;gap:.75rem;margin:0;padding:0}
.kalc-steps li{display:flex;align-items:center;gap:1rem;border:1px solid rgba(201,168,106,.28);
  border-radius:var(--r);background:rgba(255,255,255,.04);padding:1rem 1.2rem;font-size:.98rem}
.kalc-steps b{font-family:var(--ff-display);font-size:1.25rem;color:var(--c-accent-2);
  min-width:32px;font-variant-numeric:tabular-nums}
@media(max-width:640px){.kalc-band__in{gap:2rem}}
</style>
<section class="kalc-band" id="kalkulyator" aria-label="Калькулятор меню">
  <div class="wrap kalc-band__in">
    <div class="kalc-band__text">
      <span class="kicker">Новое · онлайн-расчёт</span>
      <h2>Соберите заказ<br>и сразу увидите смету</h2>
      <p>Всё фуршетное и банкетное меню с ценами и составом блюд. Отмечаете позиции,
         указываете число гостей — получаете готовую смету. Её можно распечатать,
         сохранить в PDF или отправить нам заявкой.</p>
      <a class="btn btn--on-dark btn--lg" href="kalkulyator.html">Открыть калькулятор
        <svg class="arrow" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             style="width:18px;height:18px"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a>
      <p class="kalc-band__note">132 позиции · расчёт за 2 минуты · без звонков</p>
    </div>
    <ol class="kalc-steps">
      <li><b>01</b> Выбираете блюда</li>
      <li><b>02</b> Указываете гостей</li>
      <li><b>03</b> Получаете смету</li>
    </ol>
  </div>
</section>
`;

// пункт «Калькулятор» во всех меню сайта ведёт на новую страницу
const pages = fs.readdirSync(OUT).filter((f) => f.endsWith('.html') && f !== 'kalkulyator.html');
let touched = 0;
const priceReport = [];
for (const f of pages) {
  const p = path.join(OUT, f);
  const before = fs.readFileSync(p, 'utf8');
  let after = before.replace(/href="furshet\.html#calc"/g, 'href="kalkulyator.html"');

  if (f === 'furshet.html') {
    // «Рассчитать стоимость» в обложке ведёт в новый калькулятор
    after = after.replace(/href="#calc" class="btn btn--outline-light"/,
      'href="kalkulyator.html" class="btn btn--outline-light"');
    after = fixPrices(after, priceReport);
  }

  if (f === 'index.html') {
    // баннер сразу под первым экраном — его видно, не листая
    after = after.replace('<!-- ════ SCROLLY', BANNER + '\n<!-- ════ SCROLLY');
    after = after.replace('17 фуршетных позиций · от 50 ₽ за штуку',
      '132 позиции меню · расчёт за 2 минуты');
    after = after.replace('>Рассчитать фуршет ', '>Открыть калькулятор ');
    if (!after.includes('kalc-band')) throw new Error('не удалось вставить баннер на главную');
  }

  if (after !== before) { fs.writeFileSync(p, after); touched++; }
}

// меню отдельным файлом — его правит панель admin.php, страница подхватывает на лету
fs.writeFileSync(path.join(OUT, 'menu.json'), JSON.stringify(
  { updated: new Date().toISOString(), transport: 1000,
    items: items.map((it, i) => ({ ...it, off: 0, sort: i })) },
  null, 2));
fs.copyFileSync(path.join(D, 'admin.php'), path.join(OUT, 'admin.php'));

// .htaccess: сайт запрещает отдавать *.json — а калькулятору нужен menu.json.
// Выводим его из-под запрета (отрицательный просмотр вперёд) и на всякий случай
// разрешаем явно; резервные копии наружу не отдаём.
const htPath = path.join(OUT, '.htaccess');
if (fs.existsSync(htPath)) {
  let ht = fs.readFileSync(htPath, 'utf8');
  if (!ht.includes('menu.json')) {
    const was = ht;
    ht = ht.replace(
      '<FilesMatch "\\.(htaccess|json|md)$">\n  Require all denied\n</FilesMatch>',
      '<FilesMatch "^(?!menu\\.json$).*\\.(htaccess|json|md)$">\n  Require all denied\n</FilesMatch>\n'
      + '\n# Меню калькулятора должно быть доступно странице (его пишет панель admin.php)\n'
      + '<Files "menu.json">\n  Require all granted\n</Files>\n'
      + '\n# Резервные копии меню наружу не отдаём\n'
      + 'RedirectMatch 404 ^/menu-backup/\n'
      + '\n# Текстовые заметки в корне сайта (инструкции, пароли) наружу не отдаём.\n'
      + '# robots.txt — исключение, он нужен поисковикам.\n'
      + '<FilesMatch "^(?!robots\\.txt$).*\\.txt$">\n  Require all denied\n</FilesMatch>');
    if (ht === was) throw new Error('не удалось поправить .htaccess');

    // Сайт разрешает браузеру держать HTML сутки — после обновления калькулятора
    // человек сутки видел бы старую страницу. Для неё и меню выключаем кэш.
    ht = ht.replace('<IfModule mod_headers.c>',
      '<IfModule mod_headers.c>\n'
      + '  # Калькулятор и меню всегда берём свежие\n'
      + '  <FilesMatch "^(kalkulyator\\.html|menu\\.json)$">\n'
      + '    Header set Cache-Control "no-cache, must-revalidate"\n'
      + '  </FilesMatch>\n');
    fs.writeFileSync(htPath, ht);
    console.log('.htaccess: menu.json разрешён, menu-backup закрыт');
  }
}

// ─────────────────────── SEO: карта сайта, robots и разметка организации
// Яндекс.Вебмастер ругался на sitemap: в нём кириллические адреса, а протокол
// требует ASCII — переписываем на punycode и добавляем новую страницу.

const HOST = 'https://xn--18-6kcaym8cgr.xn--p1ai';   // трапеза18.рф в ASCII
const iso = new Date().toISOString().slice(0, 10);
const SITEMAP = [
  ['/', 'weekly', '1.0'],
  ['/kalkulyator.html', 'weekly', '0.9'],
  ['/furshet.html', 'weekly', '0.9'],
  ['/biznes-lanch.html', 'weekly', '0.9'],
  ['/pirogi.html', 'weekly', '0.8'],
  ['/pravila.html', 'monthly', '0.3'],
  ['/rekvizity.html', 'monthly', '0.3'],
];
fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + SITEMAP.map(([u, freq, pr]) =>
    `  <url>\n    <loc>${HOST}${u}</loc>\n    <lastmod>${iso}</lastmod>\n`
    + `    <changefreq>${freq}</changefreq>\n    <priority>${pr}</priority>\n  </url>`).join('\n')
  + '\n</urlset>\n');

// robots.txt: адрес карты сайта тоже в ASCII, служебное закрываем,
// menu.json разрешаем — иначе он подпадает под общий запрет *.json
fs.writeFileSync(path.join(OUT, 'robots.txt'),
  'User-agent: *\n'
  + 'Allow: /\n'
  + 'Allow: /menu.json\n'
  + 'Disallow: /*.json$\n'
  + 'Disallow: /admin.php\n'
  + 'Disallow: /menu-backup/\n'
  + '\n'
  + `Sitemap: ${HOST}/sitemap.xml\n`);

// Микроразметка организации на главной: адрес, часы работы и город —
// по ней поисковик понимает, что сайт про Ижевск.
const BUSINESS = {
  '@context': 'https://schema.org',
  '@type': 'FoodEstablishment',
  '@id': HOST + '/#business',
  name: 'Трапеза',
  alternateName: 'Кейтеринг «Трапеза»',
  description: 'Кейтеринг и доставка обедов в Ижевске: фуршеты, банкеты, корпоративы, '
    + 'кофе-брейки, комплексные обеды в офис, пироги на заказ.',
  url: HOST + '/',
  telephone: '+7-912-454-14-81',
  priceRange: '₽₽',
  servesCuisine: 'Европейская, домашняя',
  image: HOST + '/img/korporativ-stol.webp',
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'ул. Пушкинская, 214',
    addressLocality: 'Ижевск',
    addressRegion: 'Удмуртская Республика',
    addressCountry: 'RU',
  },
  areaServed: [
    { '@type': 'City', name: 'Ижевск' },
    { '@type': 'AdministrativeArea', name: 'Удмуртская Республика' },
  ],
  openingHoursSpecification: [{
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    opens: '08:00', closes: '16:00',
  }],
  sameAs: ['https://t.me/trapezaizh',
    'https://max.ru/u/f9LHodD0cOIz8xuJ-IfBNwM6edcBt6rQkkcUaDH9taCFdfnYG6hHcI6o6Uo'],
};

{
  const p = path.join(OUT, 'index.html');
  let html = fs.readFileSync(p, 'utf8');
  if (!html.includes('#business')) {
    html = html.replace('</head>',
      '<script type="application/ld+json">' + JSON.stringify(BUSINESS) + '</script>\n</head>');
    fs.writeFileSync(p, html);
    console.log('index.html: добавлена микроразметка организации (адрес, город, часы)');
  }
}

console.log('sitemap.xml и robots.txt переписаны на ASCII-адреса');

console.log(`kalkulyator.html: ${(page.length / 1024).toFixed(0)} КБ, позиций ${items.length}`
  + ` (фуршет ${furshet.length} + банкет ${banket.length}), с фото ${items.filter((i) => i.ph).length}`);
console.log(`ссылку «Калькулятор» поправили на ${touched} страницах, sitemap обновлён`);
console.log('баннер калькулятора добавлен на главную, menu.json и admin.php готовы');
console.log('цены на карточках сайта приведены к прайсу:');
priceReport.forEach((r) => console.log('  • ' + r));
if (priceReport.length !== PRICE_FIX.length) {
  throw new Error('поправились не все цены: ' + priceReport.length + ' из ' + PRICE_FIX.length);
}
