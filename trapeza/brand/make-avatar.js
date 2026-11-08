'use strict';
// Аватар бота: рисуем векторно, чтобы знак рубля был правильной формы,
// а не тем, что придумал генератор картинок.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');

const THEMES = {
  gold:  { bg: '#241F1A', sheet: '#FBF7F1', accent: '#C9A86A' },
  blue:  { bg: '#16233A', sheet: '#F5F8FF', accent: '#4C9AFF' },
};

/** Знак рубля построен из линий: стойка с чашей одним контуром и перекладина. */
function rouble(color) {
  // Масштаб подобран так, чтобы знак занимал большую часть листа: аватар
  // чаще всего видят кружком в 40 пикселей, там мелочь не читается.
  return `
    <g transform="translate(392,298) scale(3.05)" fill="none" stroke="${color}"
       stroke-width="17" stroke-linecap="butt" stroke-linejoin="round">
      <path d="M30 132 V8 a34 34 0 0 1 0 68"/>
      <path d="M6 102 H68"/>
    </g>`;
}

// Лист занимает почти весь круг обрезки: углы отстоят от центра на 430 px
// при радиусе круга 512 — влезает с запасом.
const SHEET = { x0: 232, y0: 152, x1: 792, y1: 872, fold: 112, r: 34 };

function sheetPath({ x0, y0, x1, y1, fold, r }) {
  return `M${x0 + r} ${y0} H${x1 - fold} L${x1} ${y0 + fold} V${y1 - r}`
    + ` a${r} ${r} 0 0 1 -${r} ${r} H${x0 + r} a${r} ${r} 0 0 1 -${r} -${r}`
    + ` V${y0 + r} a${r} ${r} 0 0 1 ${r} -${r} Z`;
}

function svg(t, bare = false) {
  const { x0, y0, x1, fold } = SHEET;
  if (bare) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${t.bg}"/>
  <g transform="translate(350,215) scale(4.3)" fill="none" stroke="${t.accent}"
     stroke-width="17" stroke-linecap="butt" stroke-linejoin="round">
    <path d="M30 132 V8 a34 34 0 0 1 0 68"/><path d="M6 102 H68"/>
  </g>
</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${t.bg}"/>
  <path d="${sheetPath(SHEET)}" fill="${t.sheet}"/>
  <path d="M${x1 - fold} ${y0} L${x1} ${y0 + fold} H${x1 - fold} Z" fill="${t.accent}"/>
  ${rouble(t.accent)}
</svg>`;
}

(async () => {
  const out = process.argv[2];
  const b = await chromium.launch();
  for (const [name, t] of Object.entries(THEMES)) {
    const file = path.join(out, `avatar-${name}.svg`);
    fs.writeFileSync(file, svg(t));
    const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
    await p.setContent(`<body style="margin:0">${svg(t)}</body>`);
    await p.screenshot({ path: path.join(out, `avatar-${name}.png`) });
    fs.writeFileSync(path.join(out, `avatar-${name}-bare.svg`), svg(t, true));
    await p.setViewportSize({ width: 1024, height: 1024 });
    await p.setContent(`<body style="margin:0">${svg(t, true)}</body>`);
    await p.screenshot({ path: path.join(out, `avatar-${name}-bare.png`) });
    const mini = (px, bare) => svg(t, bare).replace('width="1024" height="1024"', `width="${px}" height="${px}"`);
    await p.setViewportSize({ width: 780, height: 190 });
    await p.setContent(`<body style="margin:0;display:flex;gap:26px;align-items:center;
      background:#0E1621;padding:32px;font:15px system-ui;color:#fff">
      <div style="width:120px;height:120px;border-radius:50%;overflow:hidden;flex:none">${mini(120)}</div>
      <div style="width:64px;height:64px;border-radius:50%;overflow:hidden;flex:none">${mini(64)}</div>
      <div style="width:40px;height:40px;border-radius:50%;overflow:hidden;flex:none">${mini(40)}</div>
      <div style="opacity:.4">|</div>
      <div style="width:120px;height:120px;border-radius:50%;overflow:hidden;flex:none">${mini(120, true)}</div>
      <div style="width:64px;height:64px;border-radius:50%;overflow:hidden;flex:none">${mini(64, true)}</div>
      <div style="width:40px;height:40px;border-radius:50%;overflow:hidden;flex:none">${mini(40, true)}</div>
    </body>`);
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(out, `avatar-${name}-chat.png`) });
    await p.close();
  }
  await b.close();
  console.log('готово');
})();
