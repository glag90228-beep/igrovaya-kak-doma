'use strict';

// Денежный формат «Трапезы»: 13 125,00 — пробелы в тысячах, запятая в дробной части.

/*
 * Не-число и бесконечность приводим к нулю.
 *
 * Умножение на сто переполняет double уже около 1e307, и round2 возвращала
 * Infinity, оставаясь при этом формально числом: Number.isFinite до неё
 * проверять бесполезно. Дальше это значение уходило в сумму прописью, где
 * цикл деления на тысячу не заканчивался никогда — Infinity / 1000 снова
 * Infinity. Node однопоточный, поэтому один документ с таким числом
 * останавливал бота, приложение и приём оплат разом.
 */
function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
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
  /*
   * Вторая застава, после round2.
   *
   * Условие цикла ниже — rest > 0, а бесконечность больше нуля всегда:
   * остановить его нечем. Проверка стоит здесь, а не только у вызывающего,
   * потому что страховка не должна зависеть от того, кто и как посчитал
   * число до нас. Отрицательное тоже отсекаем: раньше цикл не выполнялся
   * ни разу и функция молча возвращала пустую строку.
   */
  if (!Number.isFinite(n) || n <= 0) return 'ноль';
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


/**
 * Раскладка позиции по НДС — общая для счёта и УПД.
 *
 * gross — цена уже включает налог («в том числе»), иначе он начисляется
 * сверху. Разница принципиальная: 100 руб. с НДС 20% это 83,33 + 16,67,
 * а 100 руб. без НДС — это 100 + 20. Ошибка здесь превращается в спор
 * с контрагентом на сумму налога.
 *
 * @param {{qty:number, price:number}} it позиция
 * @param {number|null} rate ставка в процентах; null — без НДС
 * @param {boolean} gross цена включает налог
 */
function vatSplit(it, rate, gross) {
  const qty = Number(it.qty) || 0;
  const price = Number(it.price) || 0;
  if (rate == null) {
    const sum = round2(qty * price);
    return { unitNet: price, net: sum, vat: null, total: sum };
  }
  const r = Number(rate) / 100;
  if (gross) {
    const total = round2(qty * price);
    const unitNet = round2(price / (1 + r));
    const net = round2(unitNet * qty);
    return { unitNet, net, vat: round2(total - net), total };
  }
  const net = round2(qty * price);
  const vat = round2(net * r);
  return { unitNet: price, net, vat, total: round2(net + vat) };
}

/** Итоги по списку позиций с учётом НДС. */
function vatTotals(items, rate, gross) {
  let net = 0; let vat = 0; let total = 0;
  for (const it of items || []) {
    const s = vatSplit(it, rate, gross);
    net += s.net; total += s.total;
    if (s.vat != null) vat += s.vat;
  }
  return {
    net: round2(net),
    vat: rate == null ? null : round2(vat),
    total: round2(total),
  };
}

const rateLabel = (rate) => (rate == null ? 'Без НДС' : `${rate}%`);

module.exports = {
  vatSplit, vatTotals, rateLabel, round2, formatMoney, formatRub, amountInWords, rubWithWords, plural };
