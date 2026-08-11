'use strict';

/**
 * Проверка генератора QR. Ключевая мысль: читаем матрицу обратно кодом,
 * написанным отдельно от кодировщика, и отдельно считаем синдромы
 * Рида — Соломона — они вычисляются другой формулой, поэтому ошибка
 * в проверочных байтах не спрячется.
 *
 * Таблица блоков коррекции — единственное, что нельзя проверить самим собой:
 * её сверяем с опубликованными ёмкостями стандарта.
 *
 *   node check-qr.js
 */

const { encodeQr, qrSvg, byteCapacity, blockPlan, ECC_TABLE, MAX_VERSION } = require('./lib/qr');

let bad = 0;
const ok = (c, m, extra) => {
  console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra));
  if (!c) bad += 1;
};

// ─────────── поле Галуа заново, независимо от lib/qr.js ───────────

const EXP = new Uint8Array(512); const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Синдромы: значения многочлена кодового слова в точках α^i. Все нули = ошибок нет. */
function syndromes(block, ecLen) {
  const out = [];
  for (let i = 0; i < ecLen; i++) {
    let acc = 0;
    for (const byte of block) acc = mul(acc, EXP[i]) ^ byte;
    out.push(acc);
  }
  return out;
}

// ─────────── декодер: читаем матрицу так, как это делает сканер ───────────

const ECC_BY_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];
const ALIGN = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

/** Карта функциональных модулей — строим заново по описанию стандарта. */
function functionMap(version) {
  const size = 17 + 4 * version;
  const f = new Uint8Array(size * size);
  const mark = (r, c) => { if (r >= 0 && r < size && c >= 0 && c < size) f[r * size + c] = 1; };
  for (const [tr, tc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(tr + r, tc + c);
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      const corner = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3); const c = i % 3;
      mark(size - 11 + c, r); mark(r, size - 11 + c);
    }
  }
  return f;
}

function decodeQr(qr) {
  const { size, modules: m } = qr;
  const version = (size - 17) / 4;
  const get = (r, c) => m[r * size + c];

  // формат: 15 бит вдоль верхнего-левого угла
  let raw = 0;
  const seq = [];
  for (let i = 0; i <= 5; i++) seq.push(get(8, i));
  seq.push(get(8, 7), get(8, 8), get(7, 8));
  for (let i = 5; i >= 0; i--) seq.push(get(i, 8));
  seq.forEach((b, i) => { raw |= b << i; });
  const fmt = raw ^ 0x5412;

  // сверяем BCH-остаток — это проверка кодировщика, а не пересказ его же кода
  const dataBits = fmt >> 10;
  let rem = dataBits << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  const bchOk = (fmt & 0x3ff) === rem;

  const ecc = ECC_BY_BITS[(dataBits >> 3) & 3];
  const mask = dataBits & 7;

  // снимаем маску и читаем змейку
  const f = functionMap(version);
  const bits = [];
  let up = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = up ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (f[r * size + c]) continue;
        bits.push(get(r, c) ^ (MASKS[mask](r, c) ? 1 : 0));
      }
    }
    up = !up;
  }
  const codewords = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    codewords.push(v);
  }

  // расчёсываем чересполосицу обратно
  const { plan } = blockPlan(version, ecc);
  const dataBlocks = plan.map(() => []);
  const ecBlocks = plan.map(() => []);
  let p = 0;
  const maxData = Math.max(...plan.map((b) => b.data));
  for (let i = 0; i < maxData; i++) {
    plan.forEach((b, k) => { if (i < b.data) dataBlocks[k].push(codewords[p++]); });
  }
  const maxEc = Math.max(...plan.map((b) => b.ec));
  for (let i = 0; i < maxEc; i++) {
    plan.forEach((b, k) => { if (i < b.ec) ecBlocks[k].push(codewords[p++]); });
  }

  const synOk = plan.every((b, k) =>
    syndromes(dataBlocks[k].concat(ecBlocks[k]), b.ec).every((s) => s === 0));

  // разбираем поток данных
  const flat = [].concat(...dataBlocks);
  const stream = [];
  for (const byte of flat) for (let i = 7; i >= 0; i--) stream.push((byte >> i) & 1);
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | stream.shift(); return v; };
  const mode = take(4);
  const count = take(version >= 10 ? 16 : 8);
  const out = [];
  for (let i = 0; i < count; i++) out.push(take(8));

  return { version, ecc, mask, bchOk, synOk, mode, text: Buffer.from(out).toString('utf8') };
}

// ─────────── опубликованные ёмкости стандарта (режим «байты») ───────────

const PUBLISHED = {
  1: { L: 17, M: 14, Q: 11, H: 7 }, 2: { L: 32, M: 26, Q: 20, H: 14 },
  3: { L: 53, M: 42, Q: 32, H: 24 }, 4: { L: 78, M: 62, Q: 46, H: 34 },
  5: { L: 106, M: 84, Q: 60, H: 44 }, 6: { L: 134, M: 106, Q: 74, H: 58 },
  7: { L: 154, M: 122, Q: 86, H: 64 }, 8: { L: 192, M: 152, Q: 108, H: 84 },
  9: { L: 230, M: 180, Q: 130, H: 98 }, 10: { L: 271, M: 213, Q: 151, H: 119 },
  11: { L: 321, M: 251, Q: 177, H: 137 }, 12: { L: 367, M: 287, Q: 203, H: 155 },
  13: { L: 425, M: 331, Q: 241, H: 177 }, 14: { L: 458, M: 362, Q: 258, H: 194 },
  15: { L: 520, M: 412, Q: 292, H: 220 }, 16: { L: 586, M: 450, Q: 322, H: 250 },
  17: { L: 644, M: 504, Q: 364, H: 280 }, 18: { L: 718, M: 560, Q: 394, H: 310 },
  19: { L: 792, M: 624, Q: 442, H: 338 }, 20: { L: 858, M: 666, Q: 482, H: 382 },
};

// ─────────── прогон ───────────

console.log('\n── таблица блоков против опубликованных ёмкостей ──');
let capBad = [];
for (let v = 1; v <= MAX_VERSION; v++) {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    const got = byteCapacity(v, ecc);
    const want = PUBLISHED[v][ecc];
    if (got !== want) capBad.push(`v${v}-${ecc}: ${got} вместо ${want}`);
  }
}
ok(capBad.length === 0, `ёмкости всех ${MAX_VERSION * 4} сочетаний версия/уровень совпали со стандартом`,
  capBad.slice(0, 6).join('; '));

console.log('\n── многочлен-генератор ──');
// (x + α^0)(x + α^1) = x² + (1+α)x + α; в GF(256) α = 2, значит [1, 3, 2].
const { rsGenerator } = require('./lib/qr');
ok(String(rsGenerator(2)) === '1,3,2', 'генератор степени 2 совпал с ручным счётом', String(rsGenerator(2)));
ok(rsGenerator(10)[0] === 1 && rsGenerator(10).length === 11,
  'генератор степени 10: старший коэффициент 1, длина 11');

console.log('\n── структура таблицы ──');
const ALLOWED_EC = [7, 10, 13, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30];
let structBad = [];
for (const ecc of ['L', 'M', 'Q', 'H']) {
  ECC_TABLE[ecc].forEach(([ec, blocks], i) => {
    if (!ALLOWED_EC.includes(ec)) structBad.push(`v${i + 1}-${ecc}: ec=${ec}`);
    const { plan } = blockPlan(i + 1, ecc);
    if (plan.some((b) => b.data + b.ec > 255)) structBad.push(`v${i + 1}-${ecc}: блок длиннее 255`);
    if (plan.length !== blocks) structBad.push(`v${i + 1}-${ecc}: блоков ${plan.length}`);
  });
}
ok(structBad.length === 0, 'длины коррекции из набора стандарта, блоки укладываются в 255 байт',
  structBad.slice(0, 4).join('; '));

console.log('\n── кодирование и чтение обратно ──');
// Только однобайтовые символы — иначе строка длиной в ёмкость не влезет в байты.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789|=.,:/- ';
let roundBad = [];
let syndromeChecked = 0;
for (let v = 1; v <= MAX_VERSION; v++) {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    const cap = byteCapacity(v, ecc);
    let text = '';
    for (let i = 0; i < cap; i++) text += alphabet[(i * 7 + v * 13 + ecc.charCodeAt(0)) % alphabet.length];
    const qr = encodeQr(text, { ecc });
    const d = decodeQr(qr);
    syndromeChecked += 1;
    if (qr.version !== v) roundBad.push(`v${v}-${ecc}: выбрана версия ${qr.version}`);
    else if (!d.bchOk) roundBad.push(`v${v}-${ecc}: формат не сходится по BCH`);
    else if (!d.synOk) roundBad.push(`v${v}-${ecc}: синдромы не нулевые`);
    else if (d.ecc !== ecc || d.mask !== qr.mask) roundBad.push(`v${v}-${ecc}: уровень/маска прочитались как ${d.ecc}/${d.mask}`);
    else if (d.text !== text) roundBad.push(`v${v}-${ecc}: текст не совпал`);
  }
}
ok(roundBad.length === 0, `${syndromeChecked} кодов на полной ёмкости прочитаны обратно, синдромы нулевые`,
  roundBad.slice(0, 5).join('; '));

console.log('\n── проверка не пустая ──');
const probe = encodeQr('проверка порчи', { ecc: 'M' });
const before = decodeQr(probe);
ok(before.synOk && before.text === 'проверка порчи', 'кириллица в UTF-8 читается', before.text);
// портим один модуль данных и убеждаемся, что синдромы это ловят
const f = functionMap(probe.version);
let flipped = -1;
for (let i = probe.modules.length - 1; i >= 0 && flipped < 0; i--) if (!f[i]) flipped = i;
probe.modules[flipped] ^= 1;
const after = decodeQr(probe);
ok(!after.synOk, 'испорченный модуль ломает синдромы — значит проверка настоящая');

console.log('\n── SVG ──');
const svg = qrSvg(encodeQr('ST00012|Name=ИП Сарычева М. В.|PersonalAcc=40802810168000012345', { ecc: 'M' }), { size: 220 });
ok(svg.startsWith('<svg') && svg.includes('viewBox') && svg.includes('<path'), 'SVG собирается одним путём');
ok(!/[<>&](?![a-z#])/.test(svg.replace(/<[^>]+>/g, '')), 'в SVG не утекает сырой текст');

console.log('\n── платёжная строка по ГОСТ Р 56042 ──');
const { payString, payQrSvg, payProblems } = require('./lib/qr-pay');
const ORG = {
  name: 'ИП Сарычева М. В.', full_name: 'Индивидуальный предприниматель Сарычева Мария Витальевна',
  inn: '183112345678', acc: '40802810168000012345', bank_name: 'ПАО Сбербанк',
  bik: '049401601', corr_acc: '30101810400000000601',
};
ok(payProblems({ org: ORG }).length === 0, 'полные реквизиты проходят проверку');
ok(payProblems({ org: { ...ORG, bik: '04940160' } })[0].includes('БИК'),
  'короткий БИК отклоняется', payProblems({ org: { ...ORG, bik: '04940160' } })[0]);
ok(payQrSvg({ org: { ...ORG, acc: '' }, sum: 100 }) === null,
  'без расчётного счёта код не рисуется вовсе — лучше без QR, чем нерабочий');

const line = payString({ org: ORG, sum: 24700, purpose: 'Оплата по счёту № 1 от 10.08.2026' });
ok(line.startsWith('ST00012|'), 'заголовок формата и кодировка UTF-8', line.slice(0, 8));
const map = Object.fromEntries(line.split('|').slice(1).map((p) => {
  const i = p.indexOf('=');
  return [p.slice(0, i), p.slice(i + 1)];
}));
ok(REQUIRED_OK(map), 'все обязательные поля на месте', Object.keys(map).join(','));
function REQUIRED_OK(m) {
  return ['Name', 'PersonalAcc', 'BankName', 'BIC', 'CorrespAcc'].every((k) => m[k]);
}
ok(map.Sum === '2470000', 'сумма записана в копейках целым числом', map.Sum);
ok(map.PersonalAcc === '40802810168000012345' && map.BIC === '049401601',
  'счёт и БИК только цифрами');
// разделитель не должен попасть внутрь значения
const dirty = payString({ org: { ...ORG, bank_name: 'Банк | с трубой' }, sum: 1 });
ok(dirty.split('|').length === payString({ org: ORG, sum: 1 }).split('|').length,
  'символ-разделитель в реквизитах не ломает строку');

// и главное: код с этой строкой читается обратно
const paid = decodeQr(encodeQr(line, { ecc: 'M' }));
ok(paid.synOk && paid.text === line, 'платёжный код читается обратно байт в байт',
  `версия ${paid.version}, ${Buffer.byteLength(line)} байт`);

console.log('\n── QR внутри счёта ──');
const { buildSchetHtml } = require('./lib/schet');
const CP = { name: 'ООО «Заря»', full_name: 'ООО «Заря»', inn: '1832012345' };
const withQr = buildSchetHtml({ org: ORG, cp: CP,
  doc: { number: '1', date: '2026-08-10', items: [{ name: 'Канапе', qty: 2, unit: 'шт.', price: 650 }] } });
ok(withQr.includes('<svg') && withQr.includes('Оплата по QR'), 'счёт содержит платёжный код');
const noBank = buildSchetHtml({ org: { ...ORG, acc: '' }, cp: CP,
  doc: { number: '1', date: '2026-08-10', items: [{ name: 'Канапе', qty: 2, unit: 'шт.', price: 650 }] } });
ok(!noBank.includes('<svg'), 'без банковских реквизитов счёт печатается без кода');

console.log(bad ? `\nне прошло: ${bad}` : '\nQR-генератор верен ✅');
process.exit(bad ? 1 : 0);
