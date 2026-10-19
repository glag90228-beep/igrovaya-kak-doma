'use strict';

/**
 * Позиции документа из фразы: «сорок обедов по 350», «краска 5 по 800 и кисти
 * 10 по 150», «на 15000 за аренду».
 *
 * Работает с текстом, где числа уже цифрами (см. phrase-norm.prepare).
 *
 * Главное правило — НЕ УГАДЫВАТЬ. Если из фразы нельзя однозначно понять, что
 * количество, а что цена, возвращается weak: true и пустой список позиций.
 * Вызывающий код в этом случае спрашивает человека (или отдаёт фразу модели),
 * а не выписывает документ на сумму, которую никто не называл. Цена ошибки
 * несимметрична: лишний вопрос стоит секунды, неверная сумма в документе с
 * номером в сквозном ряду — выправления через клиента.
 *
 * Как читается фраза
 * ------------------
 * Слова делятся на классы, и роль числа определяется соседями:
 *   «по N»                 — цена за единицу;
 *   «на N», «итого N»      — общая сумма;
 *   «N штук/кг/часов…»     — количество с единицей;
 *   «N рублей за штуку»    — цена за единицу;
 *   «N обедов» в начале    — количество;
 *   «аренда 20000»         — сумма, если ничего другого про число не сказано.
 */

const UNIT_WORDS = {
  шт: 'шт', штука: 'шт', штуки: 'шт', штук: 'шт', штуку: 'шт', штучка: 'шт',
  кг: 'кг', кило: 'кг', килограмм: 'кг', килограмма: 'кг', килограммов: 'кг', килограмме: 'кг',
  г: 'г', грамм: 'г', грамма: 'г', граммов: 'г',
  л: 'л', литр: 'л', литра: 'л', литров: 'л', литре: 'л',
  м: 'м', метр: 'м', метра: 'м', метров: 'м', м2: 'м2', кв: 'м2',
  час: 'ч', часа: 'ч', часов: 'ч', ч: 'ч', часы: 'ч',
  день: 'дн', дня: 'дн', дней: 'дн', дн: 'дн', сутки: 'дн', суток: 'дн',
  упаковка: 'упак', упаковки: 'упак', упаковок: 'упак', упаковку: 'упак', уп: 'упак', пачка: 'упак', пачки: 'упак', пачек: 'упак',
  порция: 'порц', порции: 'порц', порций: 'порц', порцию: 'порц',
  единица: 'шт', единицу: 'шт', единицы: 'шт', единиц: 'шт',
  // «два раза по пятьдесят тысяч»: «раза» — счётное слово, в название не идёт
  раз: '', раза: '',
};
const CUR_WORDS = new Set(['руб', 'рубль', 'рубля', 'рублей', 'р', '₽', 'рублях']);
const NA_WORDS = new Set(['на', 'итого', 'всего', 'сумма', 'сумму', 'суммой', 'стоимость', 'стоимостью', 'цена', 'цену', 'ценой', 'сумме']);
const SEP_WORDS = new Set(['и', 'плюс', 'ещё', 'еще', 'потом', 'также', 'затем']);
const EDGE_NOISE = new Set(['в', 'во', 'на', 'по', 'за', 'из', 'для', 'с', 'со', 'к', 'от', 'и', 'а', 'же', 'ещё', 'еще', 'всего', 'итого',
  'сумму', 'сумма', 'суммой', 'рублей', 'руб', 'рубль', 'цена', 'цену', 'ценой', 'стоимость', 'стоимостью', 'то', 'есть', 'это', 'нужно', 'надо']);

const TOKEN = /‖|\d+(?:[.,]\d+)?|[\p{L}]+(?:-[\p{L}\d]+)*|[,;:+₽№]/gu;

function lex(s) {
  const out = [];
  let m;
  const re = new RegExp(TOKEN.source, 'gu');
  while ((m = re.exec(String(s))) !== null) {
    const w = m[0];
    const lw = w.toLowerCase().replace(/ё/g, 'е');
    // «50 процентов» — доля, а не деньги и не количество: число с процентом выбрасываем целиком
    if (/^процент/.test(lw) && out.length && out[out.length - 1].t === 'NUM') { out.pop(); continue; }
    let tok;
    if (w === '‖') tok = { t: 'AMB', s: w };
    else if (/^\d/.test(w)) tok = { t: 'NUM', s: w, v: Number(w.replace(',', '.')) };
    else if (w === ',' || w === ';' || w === ':' || w === '+') tok = { t: 'SEP', s: w };
    else if (w === '₽' || CUR_WORDS.has(lw)) tok = { t: 'CUR', s: w };
    else if (lw === 'по') tok = { t: 'PO', s: w };
    else if (lw === 'за') tok = { t: 'ZA', s: w };
    else if (NA_WORDS.has(lw)) tok = { t: 'NA', s: w, lw };
    else if (SEP_WORDS.has(lw)) tok = { t: 'SEP', s: w, word: true };
    else if (UNIT_WORDS[lw] !== undefined) tok = { t: 'UNIT', s: w, u: UNIT_WORDS[lw] };
    else tok = { t: 'WORD', s: w, lw };
    out.push(tok);
  }
  return out;
}

const isPlain = (t) => t && t.t === 'WORD';

/** Разрезать на позиции: по запятым, «и», «плюс» и по смене «название число название число». */
function splitSegments(toks) {
  const segs = [[]];
  for (const t of toks) {
    if (t.t === 'SEP') { segs.push([]); continue; }
    segs[segs.length - 1].push(t);
  }
  // неявные границы: «уборка 5000 мойка окон 3000»
  const out = [];
  for (const seg of segs) {
    let cur = [];
    for (let i = 0; i < seg.length; i += 1) {
      cur.push(seg[i]);
      if (seg[i].t !== 'NUM') continue;
      const hasWordBefore = cur.some(isPlain);
      // цена с «рублей» и «за штуку» — одно целое с числом
      let e = i;
      if (seg[e + 1] && seg[e + 1].t === 'CUR') e += 1;
      if (seg[e + 1] && seg[e + 1].t === 'ZA' && seg[e + 2] && seg[e + 2].t === 'UNIT') e += 2;
      for (let q = i + 1; q <= e; q += 1) cur.push(seg[q]);
      i = e;
      const nxt = seg[i + 1];
      const laterNum = seg.slice(i + 2).some((t) => t.t === 'NUM');
      // «40 обедов по 350» начинается с числа — это количество, а не граница
      // «сахар 40 мешков по 1100»: после числа слово, а дальше «по N» — это количество
      let q = i + 1;
      while (q < seg.length && seg[q].t !== 'NUM') q += 1;
      const qtyBeforePo = q < seg.length && seg[q - 1] && seg[q - 1].t === 'PO';
      if (hasWordBefore && isPlain(nxt) && laterNum && !qtyBeforePo) { out.push(cur); cur = []; }
    }
    out.push(cur);
  }
  // сегмент без чисел — название для следующего («кисти и краски по 150»); хвост без чисел — мусор
  const merged = [];
  let carry = [];
  const lastNum = out.reduce((acc, seg, i) => (seg.some((t) => t.t === 'NUM' || t.t === 'AMB') ? i : acc), -1);
  for (let si = 0; si < out.length; si += 1) {
    const seg = out[si];
    if (!seg.length) continue;
    // «15000 за настройку и монтаж оборудования»: хвост после «и» — продолжение названия
    const prev = merged[merged.length - 1];
    if (si > lastNum && prev && prev.some((t) => t.t === 'ZA') && !seg.some((t) => t.t === 'NUM') && seg.length <= 4) {
      prev.push({ t: 'WORD', s: 'и', lw: 'и' }, ...seg);
      continue;
    }
    if (seg.some((t) => t.t === 'NUM' || t.t === 'AMB')) { merged.push([...carry, ...seg]); carry = []; } else carry = [...carry, ...seg, { t: 'WORD', s: 'и', lw: 'и' }];
  }
  return merged;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Прочитать одну позицию.
 * @returns {{item:Object|null, weak:boolean}}
 */
function readSegment(seg, defName) {
  if (seg.some((t) => t.t === 'AMB')) return { item: null, weak: true };
  let qty = null; let price = null; let total = null; let unit = null;
  const money = [];
  const used = new Set();
  // «350 рублей за штуку», «за час работы 600»: единица цены. А «за упаковку 700» —
  // это название позиции: после единицы сразу число
  const perUnitAt = (i) => seg[i].t === 'ZA' && seg[i + 1] && seg[i + 1].t === 'UNIT' && !(seg[i + 2] && seg[i + 2].t === 'NUM');
  const perUnit = seg.some((t, i) => perUnitAt(i));

  seg.forEach((t, k) => {
    if (t.t !== 'NUM') return;
    const prev = seg[k - 1];
    const next = seg[k + 1];
    const next2 = seg[k + 2];
    const next3 = seg[k + 3];
    const wordsBefore = seg.slice(0, k).some(isPlain);
    const poLater = seg.some((x, q) => q > k && x.t === 'NUM' && seg[q - 1] && seg[q - 1].t === 'PO');
    if (prev && prev.t === 'PO') {
      price = t.v; used.add(k); used.add(k - 1);
      let e = k;
      if (next && next.t === 'CUR') { e = k + 1; used.add(e); }
      if (seg[e + 1] && seg[e + 1].t === 'ZA' && seg[e + 2] && seg[e + 2].t === 'UNIT') {
        unit = unit || seg[e + 2].u; used.add(e + 1); used.add(e + 2);
      }
    } else if (next && next.t === 'UNIT') {
      // «на 2 часа по 1500»: после «на» тоже бывает количество, а не сумма
      qty = t.v; unit = next.u; used.add(k); used.add(k + 1);
    } else if (prev && prev.t === 'NA' && poLater && isPlain(next)) {
      qty = t.v; used.add(k); used.add(k - 1);
    } else if (prev && prev.t === 'NA') {
      total = t.v; used.add(k); used.add(k - 1);
      if (next && next.t === 'CUR') used.add(k + 1);
    } else if (next && next.t === 'CUR') {
      used.add(k); used.add(k + 1);
      if (next2 && next2.t === 'ZA' && next3 && next3.t === 'UNIT') {
        price = t.v; unit = unit || next3.u; used.add(k + 2); used.add(k + 3);
      } else money.push(t.v);
    } else if (next && isPlain(next) && (!wordsBefore || poLater)) {
      qty = t.v; used.add(k);
    } else if (next && next.t === 'PO') {
      qty = t.v; used.add(k);
    } else {
      money.push(t.v); used.add(k);
    }
  });

  // «за час», «за штуку» без числа — единица цены, она уже учтена
  seg.forEach((t, k) => {
    if (perUnitAt(k)) {
      used.add(k); used.add(k + 1);
      unit = unit || seg[k + 1].u;
    }
  });

  const rec = {};
  let weak = false;
  if (price !== null) {
    rec.qty = qty !== null ? qty : 1;
    rec.price = price;
    // третье число обязано сходиться, иначе это разные вещи и гадать нельзя
    if (total !== null && Math.abs(round2(rec.qty * price) - total) > 0.01) weak = true;
    if (money.length) weak = true;
  } else if (total !== null) {
    if (money.length) weak = true;
    else if (qty !== null && qty > 0) {
      const p = round2(total / qty);
      // деление нацело до копеек — иначе «цена» выдумана; сумму сохраняем одной позицией
      if (Math.abs(p * qty - total) < 0.005) { rec.qty = qty; rec.price = p; } else { rec.qty = 1; rec.price = total; }
    } else { rec.qty = 1; rec.price = total; }
  } else if (money.length === 1) {
    if (qty === null) { rec.qty = 1; rec.price = money[0]; } else if (perUnit) { rec.qty = qty; rec.price = money[0]; } else weak = true;
  } else weak = true;
  if (weak) return { item: null, weak: true };

  // название — слова, не вошедшие в числа и единицы
  // в названии остаются и внутренние «по», «за»: «услуги по настройке сервера»
  const words = seg.map((t, k) => ({ t, k })).filter(({ t, k }) => ['WORD', 'PO', 'ZA', 'NA', 'UNIT'].includes(t.t) && !used.has(k)).map(({ t }) => t.s);
  while (words.length && EDGE_NOISE.has(words[0].toLowerCase())) words.shift();
  while (words.length && EDGE_NOISE.has(words[words.length - 1].toLowerCase())) words.pop();
  const name = words.join(' ').trim();
  const item = { name: name ? cap(name) : defName, qty: rec.qty, price: rec.price };
  if (unit) item.unit = unit;
  return { item, weak: false };
}

/**
 * @param {string} text фраза без имени клиента, чисел-словами и дат
 * @param {string} defName название позиции, если его не назвали
 * @returns {{items:Object[], weak:boolean, numbers:number}}
 */
function parseItems(text, defName = 'Оказание услуг') {
  // «50000 в месяц» — срок, за который назван платёж, а не название позиции
  const toks = lex(String(text).replace(/\s+в\s+(?:месяц|год|день|неделю|квартал|сутки)(?![\p{L}])/giu, ' '));
  const numbers = toks.filter((t) => t.t === 'NUM' || t.t === 'AMB').length;
  if (!numbers) return { items: [], weak: false, numbers };
  const segs = splitSegments(toks);
  const items = [];
  let weak = false;
  for (const seg of segs) {
    const r = readSegment(seg, defName);
    if (r.weak) weak = true;
    else if (r.item) items.push(r.item);
  }
  // Часть позиций понятна, часть нет — не выписываем «что поняли»: документ на
  // неполную сумму хуже вопроса.
  if (weak) return { items: [], weak: true, numbers };
  return { items, weak: false, numbers };
}

module.exports = { parseItems, lex, UNIT_WORDS };
