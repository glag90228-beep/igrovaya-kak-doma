'use strict';

/**
 * Генератор QR-кода без сторонних библиотек (режим «байты», версии 1–20).
 *
 * Нужен для платёжного QR в счёте: клиент наводит камеру банка и платит,
 * не переписывая реквизиты руками. Тянуть ради этого зависимость в проект,
 * где кроме exceljs ничего нет, не хочется — тем более код разворачивается
 * на чужом хостинге.
 *
 *   const { encodeQr, qrSvg } = require('./qr');
 *   qrSvg(encodeQr('ST00012|Name=...'), { size: 220 });
 *
 * Проверяется в check-qr.js: независимый декодер читает матрицу обратно,
 * плюс синдромы Рида — Соломона считаются другой формулой и должны быть нулём.
 */

// ─────────────────────────── поле Галуа GF(256) ───────────────────────────
// Примитивный многочлен 0x11D — как задано стандартом QR.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * Многочлен-генератор степени n: произведение (x − α^i), i = 0..n−1.
 * Внутри собираем по возрастанию степеней, наружу отдаём по убыванию —
 * так его ждёт деление в rsEncode: gen[0] = 1 при старшей степени.
 */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();
}

/** Проверочные байты для блока данных. */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

// ─────────────────────────── таблицы стандарта ───────────────────────────
// На каждую версию и уровень коррекции: [проверочных байт в блоке, блоков].
// Всё остальное выводится: общее число кодовых слов считается по свободным
// модулям матрицы, а разбиение данных по блокам — из этих двух чисел.

const ECC_TABLE = {
  L: [[7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4],
    [20, 4], [24, 4], [26, 4], [30, 4], [22, 6], [24, 6], [28, 6], [30, 6], [28, 7], [28, 8]],
  M: [[10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5],
    [30, 5], [22, 8], [22, 9], [24, 9], [24, 10], [28, 10], [28, 11], [26, 13], [26, 14], [26, 16]],
  Q: [[13, 1], [22, 1], [18, 2], [26, 2], [18, 4], [24, 4], [18, 6], [22, 6], [20, 8], [24, 8],
    [28, 8], [26, 10], [24, 12], [20, 16], [30, 12], [24, 17], [28, 16], [28, 18], [26, 21], [30, 20]],
  H: [[17, 1], [28, 1], [22, 2], [16, 4], [22, 4], [28, 4], [26, 5], [26, 6], [24, 8], [28, 8],
    [24, 11], [28, 11], [22, 16], [24, 16], [24, 18], [30, 16], [28, 19], [28, 21], [26, 25], [28, 25]],
};

const MAX_VERSION = 20;

/** Центры выравнивающих узоров для версии (пусто у версии 1). */
const ALIGN = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// ─────────────────────────── каркас матрицы ───────────────────────────

const sizeOf = (version) => 17 + 4 * version;

/**
 * Служебные модули версии: 1 — занято функциональным узором, 0 — свободно
 * под данные. Заодно сразу расставляем сами узоры.
 */
function skeleton(version) {
  const size = sizeOf(version);
  const mod = new Int8Array(size * size).fill(-1); // -1 = ещё не задано
  const used = new Uint8Array(size * size);        // 1 = функциональный модуль
  const at = (r, c) => r * size + c;
  const set = (r, c, v) => { mod[at(r, c)] = v; used[at(r, c)] = 1; };

  // три поисковых квадрата с отступом
  const finder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r; const cc = left + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, inRing || inCore ? 1 : 0);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // синхронизирующие дорожки
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(6, i, v); set(i, 6, v);
  }

  // Выравнивающие узоры. Пропускаем только три угла, занятых поисковыми
  // узорами. Проверять «модуль уже занят» нельзя: центры на линии
  // синхронизации тоже заняты, но узор там ставить надо.
  const centers = ALIGN[version];
  const last = size - 7;
  for (const r of centers) {
    for (const c of centers) {
      const corner = (r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  // тёмный модуль
  set(size - 8, 8, 1);

  // резерв под информацию о формате
  for (let i = 0; i < 9; i++) {
    if (!used[at(8, i)]) set(8, i, 0);
    if (!used[at(i, 8)]) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!used[at(8, size - 1 - i)]) set(8, size - 1 - i, 0);
    if (!used[at(size - 1 - i, 8)]) set(size - 1 - i, 8, 0);
  }

  // резерв под информацию о версии
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3); const c = i % 3;
      set(size - 11 + c, r, 0);
      set(r, size - 11 + c, 0);
    }
  }

  return { size, mod, used };
}

/** Сколько кодовых слов помещается в версию — считаем по свободным модулям. */
function totalCodewords(version) {
  const { used } = skeleton(version);
  let free = 0;
  for (let i = 0; i < used.length; i++) if (!used[i]) free += 1;
  return Math.floor(free / 8);
}

const TOTAL = [];
for (let v = 1; v <= MAX_VERSION; v++) TOTAL[v] = totalCodewords(v);

/** Раскладка блоков: [{ data: длина, ec: длина }, ...] */
function blockPlan(version, ecc) {
  const [ecPerBlock, blocks] = ECC_TABLE[ecc][version - 1];
  const total = TOTAL[version];
  const dataTotal = total - ecPerBlock * blocks;
  if (dataTotal <= 0) throw new Error(`Таблица коррекции не сходится: версия ${version}, уровень ${ecc}`);
  const short = Math.floor(dataTotal / blocks);
  const long = dataTotal % blocks; // столько блоков длиннее на один байт
  const plan = [];
  for (let i = 0; i < blocks; i++) {
    plan.push({ data: i < blocks - long ? short : short + 1, ec: ecPerBlock });
  }
  return { plan, dataTotal, ecPerBlock, blocks };
}

/** Сколько байт данных влезет в версию с учётом заголовка режима «байты». */
function byteCapacity(version, ecc) {
  const { dataTotal } = blockPlan(version, ecc);
  const countBits = version >= 10 ? 16 : 8;
  return Math.floor((dataTotal * 8 - 4 - countBits) / 8);
}

// ─────────────────────────── кодирование ───────────────────────────

class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length() { return this.bits.length; }
}

function buildCodewords(bytes, version, ecc) {
  const { plan, dataTotal } = blockPlan(version, ecc);
  const buf = new BitBuffer();
  buf.put(0b0100, 4);                                   // режим «байты»
  buf.put(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = dataTotal * 8;
  if (buf.length > capacityBits) throw new Error('Данные не помещаются в версию');
  buf.put(0, Math.min(4, capacityBits - buf.length));   // завершитель
  while (buf.length % 8 !== 0) buf.bits.push(0);

  const data = [];
  for (let i = 0; i < buf.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j];
    data.push(v);
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; data.length < dataTotal; i++) data.push(PAD[i % 2]);

  // режем на блоки и считаем коррекцию
  const dataBlocks = []; const ecBlocks = [];
  let pos = 0;
  for (const b of plan) {
    const chunk = data.slice(pos, pos + b.data);
    pos += b.data;
    dataBlocks.push(chunk);
    ecBlocks.push(rsEncode(chunk, b.ec));
  }

  // чересполосица: сначала данные по столбцам, потом коррекция
  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  const maxEc = Math.max(...ecBlocks.map((b) => b.length));
  for (let i = 0; i < maxEc; i++) {
    for (const b of ecBlocks) if (i < b.length) out.push(b[i]);
  }
  return out;
}

// ─────────────────────────── маски и формат ───────────────────────────

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** BCH-код информации о формате (15 бит). */
function formatBits(ecc, mask) {
  const data = (ECC_BITS[ecc] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH-код информации о версии (18 бит), нужен начиная с версии 7. */
function versionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  return (version << 12) | rem;
}

/** Штраф за узор — по нему выбираем лучшую маску. */
function penalty(mod, size) {
  const get = (r, c) => mod[r * size + c];
  let score = 0;

  // правило 1: пять и более одинаковых подряд
  for (let i = 0; i < size; i++) {
    let runR = 1; let runC = 1;
    for (let j = 1; j < size; j++) {
      runR = get(i, j) === get(i, j - 1) ? runR + 1 : 1;
      if (runR === 5) score += 3; else if (runR > 5) score += 1;
      runC = get(j, i) === get(j - 1, i) ? runC + 1 : 1;
      if (runC === 5) score += 3; else if (runC > 5) score += 1;
    }
  }

  // правило 2: блоки 2×2
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = get(r, c);
      if (v === get(r, c + 1) && v === get(r + 1, c) && v === get(r + 1, c + 1)) score += 3;
    }
  }

  // правило 3: узор 1:1:3:1:1 с полем в четыре модуля
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (vals, pat) => pat.every((p, k) => vals[k] === p);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c + 10 < size; c++) {
      const row = []; const col = [];
      for (let k = 0; k < 11; k++) { row.push(get(r, c + k)); col.push(get(c + k, r)); }
      if (match(row, A) || match(row, B)) score += 40;
      if (match(col, A) || match(col, B)) score += 40;
    }
  }

  // правило 4: перекос доли тёмных модулей
  let dark = 0;
  for (let i = 0; i < mod.length; i++) if (mod[i] === 1) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// ─────────────────────────── сборка ───────────────────────────

/** Раскладываем биты данных змейкой снизу справа. */
function placeData(mod, used, size, codewords) {
  let bit = 0;
  const total = codewords.length * 8;
  const nextBit = () => {
    if (bit >= total) return 0; // остаток добивается нулями
    const v = (codewords[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit += 1;
    return v;
  };
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // вертикальную дорожку пропускаем
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        const i = r * size + c;
        if (used[i]) continue;
        mod[i] = nextBit();
      }
    }
    upward = !upward;
  }
}

function applyFormat(mod, used, size, ecc, mask) {
  const bits = formatBits(ecc, mask);
  const bit = (i) => (bits >> i) & 1;
  for (let i = 0; i <= 5; i++) mod[8 * size + i] = bit(i);
  mod[8 * size + 7] = bit(6);
  mod[8 * size + 8] = bit(7);
  mod[7 * size + 8] = bit(8);
  for (let i = 9; i <= 14; i++) mod[(14 - i) * size + 8] = bit(i);
  for (let i = 0; i <= 7; i++) mod[(size - 1 - i) * size + 8] = bit(i);
  for (let i = 8; i <= 14; i++) mod[8 * size + (size - 15 + i)] = bit(i);
  mod[(size - 8) * size + 8] = 1; // тёмный модуль
  void used;
}

function applyVersion(mod, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const v = (bits >> i) & 1;
    const r = Math.floor(i / 3); const c = i % 3;
    mod[(size - 11 + c) * size + r] = v;
    mod[r * size + (size - 11 + c)] = v;
  }
}

/**
 * Кодирует строку в QR.
 * @returns {{size:number, modules:Uint8Array, version:number, ecc:string, mask:number}}
 */
function encodeQr(text, opts = {}) {
  const ecc = opts.ecc || 'M';
  if (!ECC_TABLE[ecc]) throw new Error(`Неизвестный уровень коррекции: ${ecc}`);
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));

  let version = Math.max(1, opts.minVersion || 1);
  while (version <= MAX_VERSION && byteCapacity(version, ecc) < bytes.length) version += 1;
  if (version > MAX_VERSION) {
    throw new Error(`Слишком длинная строка для QR: ${bytes.length} байт, уровень ${ecc}`);
  }

  const codewords = buildCodewords(bytes, version, ecc);
  const { size, mod: base, used } = skeleton(version);
  placeData(base, used, size, codewords);
  applyVersion(base, size, version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const mod = Int8Array.from(base);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!used[r * size + c] && MASKS[mask](r, c)) mod[r * size + c] ^= 1;
      }
    }
    applyFormat(mod, used, size, ecc, mask);
    const score = penalty(mod, size);
    if (!best || score < best.score) best = { score, mask, mod };
  }

  return {
    size, version, ecc, mask: best.mask,
    modules: Uint8Array.from(best.mod, (v) => (v === 1 ? 1 : 0)),
  };
}

// ─────────────────────────── вывод в SVG ───────────────────────────

/**
 * SVG-картинка кода. Рисуем одним путём — так PDF получается лёгким,
 * а на печати нет швов между соседними квадратами.
 */
function qrSvg(qr, opts = {}) {
  const px = opts.size || 200;
  const quiet = opts.quiet == null ? 4 : opts.quiet;
  const total = qr.size + quiet * 2;
  const parts = [];
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r * qr.size + c]) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" `
    + `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" `
    + `aria-label="QR-код для оплаты">`
    + `<rect width="${total}" height="${total}" fill="#fff"/>`
    + `<path d="${parts.join('')}" fill="#000"/></svg>`;
}

module.exports = {
  encodeQr, qrSvg, byteCapacity, totalCodewords, blockPlan, rsGenerator, ECC_TABLE, MAX_VERSION,
};
