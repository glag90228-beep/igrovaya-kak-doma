/*
 * Брендовые ассеты для промо-роликов и обложек.
 *
 *   node tools/brand-shots.js ./brand-out
 *
 * Зачем отдельный инструмент, а не папка с картинками в репозитории: знак,
 * цвета и подпись живут в public/app (заставка) и в фавиконке страниц. Стоит
 * их поправить — и любые заранее нарисованные ассеты начинают врать, причём
 * молча. Здесь всё считается из тех же значений, поэтому расхождение
 * невозможно по построению.
 *
 * Обводка рубля тут 13, а не 9, как в заставке. Её утолщили ради шестнадцати
 * пикселей во вкладке браузера, и знак теперь везде такой — иначе у продукта
 * оказалось бы два разных знака.
 *
 * Playwright ищется тем же способом, что и для документов: на сервере пакет
 * стоит глобально и в обычный поиск Node не попадает.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadChromium } = require('../lib/pdf');

const OUT = process.argv[2] || 'brand-out';

// Цвета — ровно те, что в public/app/app.css у #splash.
const BG = 'radial-gradient(120% 90% at 50% 40%, #1E2E4C 0%, #16233A 62%, #101A2C 100%)';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const PLATE = '#16233A';
const SHEET = '#F5F8FF';
const ACCENT = '#4C9AFF';
const NAME = '#C9D8F5';
const WORD = '#E7EEFC';
const WORD_ALT = '#9FC4FF';

/** Лист с загнутым углом и рублём — знак как он есть, без подложки. */
const glyph = `
  <g transform="translate(100 100) scale(1.12) translate(-97 -99)">
    <path fill="${SHEET}" d="M46 24H128L156 52V166a8 8 0 0 1-8 8H46a8 8 0 0 1-8-8V32a8 8 0 0 1 8-8Z"/>
    <path fill="${ACCENT}" d="M128 24L156 52H128Z"/>
    <g fill="none" stroke="${ACCENT}" stroke-width="13" stroke-linejoin="round">
      <path d="M84 132V72a17 17 0 0 1 0 34"/><path d="M72 117H103"/>
    </g>
  </g>`;

const svg = (size, inner) =>
  `<svg viewBox="0 0 200 200" width="${size}" height="${size}" role="img" aria-label="Первичка">${inner}</svg>`;

const mark = (size) => svg(size, glyph);

/** Он же на тёмной плашке — иконка приложения, как её видно на телефоне. */
const icon = (size) => svg(size, `<rect width="200" height="200" rx="40" fill="${PLATE}"/>${glyph}`);

/*
 * Начертание задаём отдельными свойствами, а не сокращением `font`.
 *
 * Сокращение обязано нести за собой семейство, а в семействе стоит "Segoe UI"
 * в тех же кавычках, которыми ограничен атрибут style. Атрибут обрывается на
 * первой из них, и всё, что дальше — цвет, размер, — браузер молча
 * выбрасывает. Поймано прогоном: текст вышел мелким и чёрным. Семейство
 * наследуется от body, там оно внутри <style>, и кавычки никому не мешают.
 */
const type = (weight, size, color, extra = '') =>
  `font-weight:${weight};font-size:${size}px;line-height:1;color:${color};${extra}`;

const page = (body, bg, gap = 30) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%}
  body{background:${bg};display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:${gap}px;font-family:${FONT};text-align:center}
</style>${body}`;

// Кадр перечисления — первые 380 мс запуска, четыре слова по 95 мс.
const slovo = (w, color) => page(
  `<div style="${type(700, 104, color, 'letter-spacing:-.01em')}">${w}</div>`, BG);

// Финал заставки: то, что остаётся на экране через секунду после запуска.
const zastavka = (m, name) => page(
  `${mark(m)}<div style="${type(600, name, NAME, 'letter-spacing:.04em')}">Первичка</div>`, BG, 34);

/*
 * Конечная плашка.
 *
 * Цена здесь та же, что напечатана на лендинге. Своей цифры ролик придумывать
 * не вправе: это недостоверная реклама (ФЗ «О рекламе», ст. 5), да и в
 * lib/lava.js на выдуманные цены стоит прямой запрет. Меняется тариф —
 * сначала лендинг, потом это место.
 */
const PRICE = '390 ₽ в месяц';

const final = (k) => page(`
  ${icon(Math.round(300 * k))}
  <div style="${type(700, Math.round(76 * k), SHEET, 'letter-spacing:.01em')}">Первичка</div>
  <div style="${type(600, Math.round(46 * k), ACCENT)}">${PRICE}</div>
  <div style="${type(500, Math.round(34 * k), NAME, 'line-height:1.55;opacity:.92')}">
    @pervichka_app_bot<br>pervichkaru.ru
  </div>`, BG, Math.round(30 * k));

const V = [1080, 1920];   // вертикаль — Telegram, Reels, Shorts
const H = [1920, 1080];   // горизонталь — лендинг и YouTube

const SHOTS = [
  // Знаки на прозрачном фоне: их кладут поверх любого кадра.
  ['pervichka-ikonka-1024.png', page(icon(1024), 'transparent'), 1024, 1024, true],
  ['pervichka-znak-1024.png', page(mark(1024), 'transparent'), 1024, 1024, true],

  ['01-slovo-akty.png', slovo('Акты', WORD), ...V, false],
  ['02-slovo-scheta.png', slovo('Счета', WORD_ALT), ...V, false],
  ['03-slovo-upd.png', slovo('УПД', WORD), ...V, false],
  ['04-slovo-dogovory.png', slovo('Договоры', WORD_ALT), ...V, false],
  ['05-zastavka.png', zastavka(440, 72), ...V, false],
  ['06-final.png', final(1), ...V, false],

  ['07-zastavka-16x9.png', zastavka(320, 54), ...H, false],
  ['08-final-16x9.png', final(0.72), ...H, false],
];

async function main() {
  const chromium = loadChromium();
  if (!chromium) {
    console.error('❌ Playwright не найден. Он же нужен для PDF — см. deploy/playwright.sh');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  for (const [name, html, width, height, transparent] of SHOTS) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.setContent(html, { waitUntil: 'load' });
    await p.screenshot({ path: path.join(OUT, name), omitBackground: transparent });
    await ctx.close();
    console.log('✅', name, `${width}×${height}`);
  }
  await browser.close();
  console.log(`\nГотово: ${SHOTS.length} файлов в ${path.resolve(OUT)}`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
