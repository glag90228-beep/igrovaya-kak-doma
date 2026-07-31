'use strict';

// Денежный формат «Трапезы»: 13 125,00 — пробелы в тысячах, запятая в дробной части.

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** 13125 -> "13 125,00" */
function formatMoney(n) {
  const v = round2(n);
  const neg = v < 0;
  const [int, dec] = Math.abs(v).toFixed(2).split('.');
  const spaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '−' : '') + spaced + ',' + dec;
}

/** 13125 -> "13 125,00 руб." */
function formatRub(n) {
  return formatMoney(n) + ' руб.';
}

const ONES = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
  'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
  'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят',
  'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот',
  'восемьсот', 'девятьсот'];

/** Правильное окончание: 1 рубль, 2 рубля, 5 рублей */
function plural(n, one, few, many) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Триада 0..999 прописью */
function tripletToWords(num, feminine) {
  const words = [];
  const h = Math.floor(num / 100);
  const rest = num % 100;
  if (h) words.push(HUNDREDS[h]);
  if (rest < 20) {
    if (rest) words.push((feminine ? ONES_F : ONES)[rest]);
  } else {
    words.push(TENS[Math.floor(rest / 10)]);
    const o = rest % 10;
    if (o) words.push((feminine ? ONES_F : ONES)[o]);
  }
  return words;
}

const SCALES = [
  { one: 'триллион', few: 'триллиона', many: 'триллионов', feminine: false },
  { one: 'миллиард', few: 'миллиарда', many: 'миллиардов', feminine: false },
  { one: 'миллион', few: 'миллиона', many: 'миллионов', feminine: false },
  { one: 'тысяча', few: 'тысячи', many: 'тысяч', feminine: true },
  null, // рубли добавляются отдельно
];

/** Целое число прописью (без валюты) */
function intToWords(n, feminine) {
  if (n === 0) return 'ноль';
  const triplets = [];
  let rest = n;
  while (rest > 0) {
    triplets.unshift(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  const offset = SCALES.length - triplets.length;
  const words = [];
  triplets.forEach((t, i) => {
    if (t === 0) return;
    const scale = SCALES[offset + i];
    words.push(...tripletToWords(t, scale ? scale.feminine : feminine));
    if (scale) words.push(plural(t, scale.one, scale.few, scale.many));
  });
  return words.join(' ');
}

/**
 * Сумма прописью в формате актов «Трапезы»:
 * 77388 -> "Семьдесят семь тысяч триста восемьдесят восемь рублей 00 копеек"
 */
function amountInWords(amount) {
  const v = round2(Math.abs(amount));
  const rub = Math.floor(v);
  const kop = Math.round((v - rub) * 100);
  const words = intToWords(rub, false);
  const capitalized = words.charAt(0).toUpperCase() + words.slice(1);
  const rubWord = plural(rub, 'рубль', 'рубля', 'рублей');
  const kopWord = plural(kop, 'копейка', 'копейки', 'копеек');
  return `${capitalized} ${rubWord} ${String(kop).padStart(2, '0')} ${kopWord}`;
}

/** «77 388,00 руб. (Семьдесят семь тысяч триста восемьдесят восемь рублей 00 копеек)» */
function rubWithWords(amount) {
  return `${formatRub(amount)} (${amountInWords(amount)})`;
}

module.exports = { round2, formatMoney, formatRub, amountInWords, rubWithWords, plural };
