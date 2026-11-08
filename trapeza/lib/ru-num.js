'use strict';

/**
 * Числа словами → цифры: «двадцать две тысячи пятьсот» → 22500.
 *
 * Зачем. Голосовое сообщение приходит текстом, и числа в нём — слова, если
 * распознаватель не успел их «нормализовать» (Gemini это делает через раз,
 * SpeechKit — только в асинхронном режиме). Весь остальной разбор живёт на
 * цифрах: «на 30000», «по 350». Проще один раз перевести слова в цифры в
 * начале, чем учить каждое правило двум написаниям.
 *
 * Что здесь нарочно НЕ делается
 * -----------------------------
 * Склеивать подряд идущие числа нельзя там, где они склеиваются неверно.
 * «Два по сто» — это два по сто, а не двести; «три сто» — не 103. Поэтому
 * разбор следит за порядком разрядов: после десятков идут только единицы,
 * после сотен — десятки, тысячи не бывают после единиц. Как только порядок
 * нарушен, число заканчивается и начинается новое — и вызывающий видит два
 * числа подряд, а не одно выдуманное. Двусмысленность остаётся двусмысленностью:
 * дальше по ней бот спросит, а не угадает.
 *
 * Названия фирм: «ООО Три медведя» — не «ООО 3 медведя». Слово с заглавной
 * буквы посреди фразы считаем именем и не трогаем; кроме того, вызывающий может
 * передать участки, которые трогать нельзя (известные клиенты человека).
 */

const norm = (w) => String(w).toLowerCase().replace(/ё/g, 'е');

// kind: u — единицы, t — «-надцать» и десять, d — десятки, h — сотни, s — тысяча/миллион/миллиард, z — ноль
const WORDS = {};
const put = (kind, value, forms) => { for (const f of forms.split(' ')) WORDS[f] = { kind, value }; };

put('z', 0, 'ноль нуль');
put('u', 1, 'один одна одно одну');
put('u', 2, 'два две двух двум двумя');
put('u', 3, 'три трех трем тремя');
put('u', 4, 'четыре четырех четырем четырьмя');
put('u', 5, 'пять пяти пятью');
put('u', 6, 'шесть шести шестью');
put('u', 7, 'семь семи семью');
put('u', 8, 'восемь восьми восемью');
put('u', 9, 'девять девяти девятью');
put('t', 10, 'десять десяти десятью');
put('t', 11, 'одиннадцать одиннадцати');
put('t', 12, 'двенадцать двенадцати');
put('t', 13, 'тринадцать тринадцати');
put('t', 14, 'четырнадцать четырнадцати');
put('t', 15, 'пятнадцать пятнадцати');
put('t', 16, 'шестнадцать шестнадцати');
put('t', 17, 'семнадцать семнадцати');
put('t', 18, 'восемнадцать восемнадцати');
put('t', 19, 'девятнадцать девятнадцати');
put('d', 20, 'двадцать двадцати');
put('d', 30, 'тридцать тридцати');
put('d', 40, 'сорок сорока');
put('d', 50, 'пятьдесят пятидесяти');
put('d', 60, 'шестьдесят шестидесяти');
put('d', 70, 'семьдесят семидесяти');
put('d', 80, 'восемьдесят восьмидесяти');
put('d', 90, 'девяносто девяноста');
put('h', 100, 'сто ста');
put('h', 200, 'двести двухсот');
put('h', 300, 'триста трехсот');
put('h', 400, 'четыреста четырехсот');
put('h', 500, 'пятьсот пятисот');
put('h', 600, 'шестьсот шестисот');
put('h', 700, 'семьсот семисот');
put('h', 800, 'восемьсот восьмисот');
put('h', 900, 'девятьсот девятисот');
put('s', 1e3, 'тысяча тысячи тысяч тысячу тысяче тысячей тыща тыщи тыщ тыщу тыще');
put('s', 1e6, 'миллион миллиона миллионов миллиону миллионе миллионом');
put('s', 1e9, 'миллиард миллиарда миллиардов');
// «полтора миллиона», «полторы тысячи»: полтора — это 1,5, а масштаб дальше умножит.
put('half', 1.5, 'полтора полторы');

/*
 * Жаргон. «Косарь» — тысяча, «полтинник» — пятьдесят, «сотка» — сто. Это не
 * экзотика: в голосовых так и говорят. «Штука» (тысяча) сюда не входит
 * сознательно: «две штуки» — и две тысячи, и две вещи, а выбирать за человека
 * в деньгах нельзя.
 */
const SLANG = {
  косарь: 1000, косаря: 1000, косарей: 1000, косари: 1000,
  полтинник: 50, полтинника: 50, сотка: 100, сотку: 100, сотки: 100, пятихатка: 500, пятихатку: 500,
};

/*
 * Два числа подряд, которые не склеились в одно («три сто»), разделяем
 * видимой чертой, а не пробелом: «3 100» дальше читается как три тысячи сто.
 */
const NUMSEP = ' ‖ ';

const isWordChar = /[\p{L}\p{N}]/u;

function tokenize(text) {
  const out = [];
  const re = /[\p{L}\p{N}]+(?:[.,]\d+)?|[^\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ s: m[0], start: m.index, end: m.index + m[0].length, word: isWordChar.test(m[0][0]) });
  }
  return out;
}

const fmt = (n) => {
  const r = Math.round(n * 1000) / 1000;
  return String(r);
};

/**
 * Разобрать подряд идущие числительные в одно или несколько чисел.
 * @param {Array<{kind:string,value:number}>} run
 * @returns {number[]}
 */
function parseRun(run) {
  const nums = [];
  let total = 0;        // уже закрытые тысячи/миллионы
  let group = 0;        // текущая тройка разрядов
  let lastScale = Infinity;
  let any = false;
  let hasHalf = false;

  const flush = () => {
    if (any) nums.push(total + group);
    total = 0; group = 0; lastScale = Infinity; any = false; hasHalf = false;
  };

  for (let i = 0; i < run.length; i += 1) {
    const t = run[i];
    const v = t.value;
    if (t.kind === 'withhalf') {
      // «двенадцать с половиной тысяч»: полвторого к текущей группе, масштаб умножит
      if (any && !hasHalf && group > 0 && group < 1000) { group += 0.5; hasHalf = true; continue; }
      flush();
      continue;
    }
    if (t.kind === 'half') {
      if (any && group > 0) flush();
      group = 1.5; any = true; hasHalf = true;
      continue;
    }
    if (t.kind === 's') {
      // «тысяча» без числа перед ней — это одна тысяча
      if (!any && group === 0) { group = 1; any = true; }
      if (group === 0 || v >= lastScale) { flush(); group = 1; any = true; }
      total += group * v;
      group = 0;
      lastScale = v;
      hasHalf = false;
      continue;
    }
    if (t.kind === 'z') {
      if (any) flush();
      nums.push(0);
      continue;
    }
    // дробь в группе — только перед масштабом; цифры после неё начинают новое число
    if (hasHalf) { flush(); }
    // Порядок разрядов: сотни — только в начале группы, десятки — после сотен,
    // единицы — после десятков или сотен. Иначе это уже следующее число.
    const g100 = group % 100;
    let fits;
    if (t.kind === 'h') fits = group === 0;
    else if (t.kind === 'd' || t.kind === 't') fits = g100 === 0;
    else fits = g100 === 0 || (g100 >= 20 && g100 % 10 === 0);
    if (!fits) flush();
    group += v;
    any = true;
  }
  flush();
  return nums;
}

/**
 * Заменить числа словами цифрами.
 *
 * @param {string} text
 * @param {{keep?:Array<[number,number]>}} [opts] участки, которые трогать нельзя
 */
function wordsToDigits(text, opts = {}) {
  const src = String(text || '');
  const keep = opts.keep || [];
  const toks = tokenize(src);
  const isKept = (t) => keep.some(([a, b]) => t.start < b && t.end > a);

  /*
   * Слово-число или нет. Заглавная буква посреди фразы — имя («ООО Три
   * медведя»), а не число; в начале фразы заглавная ничего не значит.
   */
  const numTok = (idx) => {
    const t = toks[idx];
    if (!t || !t.word || /^\d/.test(t.s)) return null;
    const w = norm(t.s);
    let def = WORDS[w];
    if (!def) return null;
    if (isKept(t)) return null;
    // «12 тысяч»: число уже цифрами, слово при нём — множитель, его потом
    // применит foldDigits; одному «тысяч» цифрой становиться нельзя
    if (def.kind === 's') {
      let p = idx - 1;
      while (p >= 0 && !toks[p].word && /^[ \t\u00a0\u202f]+$/.test(toks[p].s)) p -= 1;
      if (p >= 0 && toks[p].word && /^\d/.test(toks[p].s)) return null;
    }
    if (/^[А-ЯЁ]/.test(t.s) && !/^[А-ЯЁ]{2,}$/.test(t.s)) {
      // первое слово фразы или слово после точки/восклицания — обычное начало предложения
      let j = idx - 1;
      while (j >= 0 && !toks[j].word && !/[.!?]/.test(toks[j].s)) j -= 1;
      const atStart = j < 0 || (!toks[j].word && /[.!?]/.test(toks[j].s));
      if (!atStart) return null;
    }
    return def;
  };

  const out = [];
  let i = 0;
  while (i < toks.length) {
    const def = numTok(i);
    const t = toks[i];
    if (!def) {
      if (t.word && SLANG[norm(t.s)] && !isKept(t) && !/^[А-ЯЁ]/.test(t.s)) {
        // «пять косарей» — число уже стоит выше, множитель берём здесь
        const prev = out.length >= 2 ? out[out.length - 2] : null;
        const prevNum = prev && /^\d+(?:\.\d+)?$/.test(prev) ? prev : null;
        if (prevNum && out[out.length - 1].trim() === '') {
          out.splice(out.length - 2, 2, fmt(Number(prevNum) * SLANG[norm(t.s)]));
        } else {
          out.push(fmt(SLANG[norm(t.s)]));
        }
        i += 1;
        continue;
      }
      out.push(t.s);
      i += 1;
      continue;
    }
    // собираем серию числительных, разделённых только пробелами
    const run = [def];
    let j = i;
    for (;;) {
      const sep = toks[j + 1];
      const nxtIdx = j + 2;
      if (sep && !sep.word && /^[ \t  ]+$/.test(sep.s)) {
        // «с половиной»
        if (norm((toks[nxtIdx] || {}).s || '') === 'с' && toks[nxtIdx + 1] && /^[ \t ]+$/.test(toks[nxtIdx + 1].s)
          && norm((toks[nxtIdx + 2] || {}).s || '') === 'половиной' && run.length) {
          run.push({ kind: 'withhalf', value: 0.5 });
          j = nxtIdx + 2;
          continue;
        }
        const nd = numTok(nxtIdx);
        if (nd) { run.push(nd); j = nxtIdx; continue; }
      }
      break;
    }
    // Одинокое «один/одна/одну» цифрой не становится: количество по умолчанию и
    // так единица, а «ещё одну такую же» от этого превращалось в «ещё 1 такую».
    if (run.length === 1 && run[0].kind === 'u' && run[0].value === 1) {
      out.push(t.s);
      i = j + 1;
      continue;
    }
    const nums = parseRun(run);
    out.push(nums.map(fmt).join(NUMSEP));
    i = j + 1;
  }
  return out.join('');
}

module.exports = { wordsToDigits, WORDS, NUMSEP };
