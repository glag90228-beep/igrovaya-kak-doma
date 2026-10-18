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

/*
 * Округление до `d` знаков через десятичную запись, а не умножением.
 *
 * 1,0005 × 1000 в двойной точности даёт 1000,4999…, и «половина вверх»
 * терялась: количество 1,0005 округлялось вниз, а на тех же числах, записанных
 * в бланке, глаз бухгалтера видел округление вверх. Сдвиг запятой строкой
 * ('1.0005e3') даёт ровно 1000,5. Числа с показателем степени (совсем мелкие)
 * идут старым путём — они всё равно округлятся до нуля.
 */
function roundTo(n, d) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const s = String(v);
  if (s.includes('e')) return Math.round(v * 10 ** d) / 10 ** d;
  return Number(`${Math.round(Number(`${s}e${d}`))}e-${d}`);
}

/*
 * Количество хранится с тремя знаками, цена — с четырьмя; до копеек
 * округляются только суммы строк и итог.
 *
 * Раньше и то и другое резалось до сотых (round2). Мясо по 0,333 кг приходило
 * в документ как 0,33 кг, и сумма в накладной расходилась с весом на весах:
 * 0,333 × 10,01 = 3,33, а выходило 3,30. ТОРГ-12 допускает количество с тремя
 * знаками, а цену — с четырьмя, так что округлять раньше времени незачем.
 */
const round3 = (n) => roundTo(n, 3);
const round4 = (n) => roundTo(n, 4);

/** 13125 -> "13 125,00" */
function formatMoney(n) {
  const v = round2(n);
  const neg = v < 0;
  const [int, dec] = Math.abs(v).toFixed(2).split('.');
  const spaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '−' : '') + spaced + ',' + dec;
}

/**
 * Цена за единицу: как минимум копейки, но если в ней есть доли копейки
 * (33,3333), печатаем их все. Иначе в бланке стоит «33,33», а сумма за три
 * штуки — 100,00, и покупатель, перемножив графы, ловит расхождение на ровном
 * месте.
 */
function formatPrice(n) {
  const v = round4(n);
  const neg = v < 0;
  const [int, dec] = Math.abs(v).toFixed(4).split('.');
  const frac = dec.replace(/0{1,2}$/, '');
  return (neg ? '−' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + (frac.length < 2 ? dec.slice(0, 2) : frac);
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
    /*
     * unitNet округляется отдельно от net, и перемножение может разойтись на
     * копейку: 81,97 × 3 = 245,91, а net при 300 руб. и ставке 22% — 245,90.
     * Это замечают: графу «цена без налога» бухгалтер получателя перемножает
     * первым делом.
     *
     * И всё-таки считаем именно так, а не от unitNet × qty. Сойдётся одно —
     * разойдётся другое, обе сразу не сходятся при округлении до копеек:
     *
     *   net = total / (1+r)      → графа «налог» = графа «без налога» × ставку,
     *                              но столбец может не перемножиться;
     *   net = unitNet × qty      → столбец перемножается, но налог перестаёт
     *                              сходиться с базой (7 × 12,34 под 5%: база
     *                              82,25, налог 4,13, хотя 82,25 × 5% = 4,11).
     *
     * Выбираем первое, потому что пара «стоимость без налога / сумма налога»
     * — это то, что сверяет АСК НДС-2 автоматически у обеих сторон сделки, а
     * перемножение графы 3 на графу 4 не проверяет никто, кроме глаза. Цена
     * ошибки несимметрична, поэтому сходиться должно то, что машина и сверяет.
     */
    const total = round2(qty * price);
    const net = round2(total / (1 + r));
    return { unitNet: round2(price / (1 + r)), net, vat: round2(total - net), total };
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
  round3, round4, formatPrice,
  vatSplit, vatTotals, rateLabel, round2, formatMoney, formatRub, amountInWords, rubWithWords, plural };
