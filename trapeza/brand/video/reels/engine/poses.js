'use strict';
// Рисует персонажа в нескольких позах и костюмах в одну картинку-лист — посмотреть до сборки ролика.
//
//   NODE_PATH=$(npm root -g) node engine/poses.js <папка с three.global.js> out.png
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const POSES = [
  ['обычный', {}],
  ['машет', { armR: 2.6, armRx: -0.2, handR: 0.4, happy: 1 }],
  ['испуг', { eyeS: 1.35, armL: 2.5, armR: 2.5, armLx: -0.4, armRx: -0.4 }],
  ['показывает влево', { armL: 1.45, armLx: -0.3, rotY: -0.55, look: -0.8 }],
  ['хакер', { beret: 0, hood: 1, glasses: 1, laptop: 1, armL: 0.15, armR: 0.15, armLx: -1.05, armRx: -1.05, rotX: 0.12 }],
  ['детектив', { beret: 0, det: 1, mag: 1, armR: 1.9, armRx: -0.5, rotY: -0.5 }],
  ['охранник', { beret: 0, guard: 1, flash: 1, beam: 1, armR: 2.15, armRx: -0.25, rotY: -0.6 }],
  ['доктор и щит', { beret: 0, doc: 1, shield: 1 }],
  ['идея', { bulb: 1, lit: 1, happy: 1 }],
];

(async () => {
  const dir = path.resolve(process.argv[2]);
  const out = path.resolve(process.argv[3] || 'poses.png');
  const html = `<!doctype html><body style="margin:0;background:#F3EDE4">
<canvas id="c" width="1080" height="1920" style="display:none"></canvas>
<script src="file://${dir}/three.global.js"></script><script src="file://${path.join(__dirname, 'mascot3d.js')}"></script>
<script>
const ST = makeStage(document.getElementById('c'), { flat: true, dist: 15 }), P = ST.add(), H = Object.assign({}, P);
window.shot = (o) => { Object.assign(P, H, ST.at(540, 1500), { s: 1100 / (4.4 * ST.ppu), rotY: 0.3 }, o); ST.render(); return document.getElementById('c').toDataURL('image/png'); };
</script></body>`;
  const tmp = path.join(path.dirname(out), '.poses.html');
  fs.writeFileSync(tmp, html);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('file://' + tmp);
  const shots = [];
  for (const [name, o] of POSES) shots.push([name, await page.evaluate((x) => window.shot(x), o)]);
  const sheet = `<body style="margin:0;background:#F3EDE4;display:grid;grid-template-columns:repeat(3,360px);font:600 22px sans-serif">${shots.map(([n, d]) => `<div style="text-align:center"><img src="${d}" style="width:360px;height:640px;object-fit:cover">${n}</div>`).join('')}</body>`;
  await page.setContent(sheet);
  await page.setViewportSize({ width: 1080, height: 2100 });
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  fs.unlinkSync(tmp);
  if (errs.length) { console.log(errs.join('\n')); process.exit(1); }
  console.log('готово:', out);
})();
