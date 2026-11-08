'use strict';

/**
 * Подготовка фразы к разбору: слова-паразиты, числа словами, даты, имена.
 *
 * Фраза из голоса — это поток слов без знаков, без заглавных, с «ну», «эээ»
 * и «короче», с числами то цифрами, то словами и с клиентом в любом падеже.
 * Правила разбора в ai-agent.js написаны под аккуратный текст («выставь счёт
 * Заре на 30000»), и учить каждое из них всем вариантам было бы десять
 * копий одного и того же. Поэтому сначала фраза приводится к одному виду, а
 * уже потом разбирается.
 *
 * Порядок шагов важен и менять его нельзя:
 *   1. выбросить слова-паразиты и поправить типичные огрехи распознавания;
 *   2. вынуть даты и периоды («вчера», «за сентябрь», «с первого по пятнадцатое
 *      октября») — иначе «двадцать пятого» превратится в число 25 и уедет в сумму;
 *   3. числа словами → цифры, не трогая названия фирм («Три медведя»);
 *   4. «15 тысяч», «30к», «1,5 млн», «12 500» → одно число.
 */

const { wordsToDigits, WORDS } = require('./ru-num');
const period = require('./period');

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// ---------- слова-паразиты и огрехи распознавания ----------

/*
 * Только то, что ничего не значит. «Мне нужен счёт» и «надо бы выставить» —
 * это уже просьба, их оставляем: по ним правило выписки узнаёт намерение.
 *
 * Границы слов пишем руками: \b в JS не знает кириллицы (на этом проект уже
 * обжигался, см. комментарий к CUT_WHO в ai-agent.js).
 */
const FILLER = new RegExp(
  '(?<![\\p{L}\\d])(?:ну|короче|вот|значит|типа|как\\s+бы|в\\s+общем|в\\s+принципе|слушай(?:те)?|скажи|'
  + 'эм+|э+м*|ээ+|мм+|аа+|ага|угу|пожалуйста|пожалуй|плиз|пожалте|будь\\s+добр[а]?|будьте\\s+добры|'
  + 'это\\s+самое|как\\s+его|так\\s+вот|так|давай(?:те)?|быстренько|ты\\s+понял[а]?|ты\\s+понимаешь|понимаешь|в\\s+смысле|там|'
  + 'привет|здравствуй(?:те)?|добрый\\s+день|добрый\\s+вечер|алло|слышь|эй)'
  + '(?![\\p{L}\\d])[,\\s]*', 'giu');

/*
 * Как распознаватель пишет то, что люди произносят по буквам. «У-пэ-дэ» и
 * «торг двенадцать» — настоящие записи с боевого сервера, а не выдумка.
 */
const SPELLED = [
  [/(?<![\p{L}\d])(?:у[\s-]*пэ[\s-]*дэ|ю[\s-]*пэ[\s-]*дэ|юпд|упэдэ|упэде|уп[\s-]дэ)(?![\p{L}\d])/giu, 'упд'],
  [/(?<![\p{L}\d])(?:накладн[а-яё]*\s+)?торг[\s-]*(?:12|двенадцать)(?:\s+накладн[а-яё]*)?(?![\p{L}\d])/giu, 'накладная'],
  [/(?<![\p{L}\d])(?:эн[\s-]*дэ[\s-]*эс|эндээс)(?![\p{L}\d])/giu, 'ндс'],
  [/(?<![\p{L}\d])пэ[\s-]*пэ(?![\p{L}\d])/giu, 'платёжка'],
  [/(?<![\p{L}\d])куди[\s-]?р(?![\p{L}\d])/giu, 'кудир'],
];

// ---------- даты ----------

const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_ANY = '(?:январ[ьяе]|феврал[ьяе]|март[аеу]?|апрел[ьяе]|ма[йяе]|июн[ьяе]|июл[ьяе]|август[аеу]?|сентябр[ьяе]|октябр[ьяе]|ноябр[ьяе]|декабр[ьяе])';

const ORD = {
  перв: 1, втор: 2, трет: 3, четверт: 4, пят: 5, шест: 6, седьм: 7, восьм: 8, девят: 9,
  десят: 10, одиннадцат: 11, двенадцат: 12, тринадцат: 13, четырнадцат: 14, пятнадцат: 15,
  шестнадцат: 16, семнадцат: 17, восемнадцат: 18, девятнадцат: 19, двадцат: 20, тридцат: 30,
};
const ORD_STEM = Object.keys(ORD).sort((a, b) => b.length - a.length).join('|');
const ORD_END = '(?:ого|ое|ье|ьего|ому|ый|ий|ой)';
// «двадцать пятого», «пятнадцатое», «31-го», «1»
const DAY_WORD = `(?:(?:двадцать|тридцать)\\s+)?(?:${ORD_STEM})${ORD_END}`;
const DAY_ANY = `(?:${DAY_WORD}|\\d{1,2}(?:-?(?:го|е|ое))?)`;

function ordinalValue(s) {
  const w = norm(s).replace(/\s+/g, ' ').trim();
  let m = /^(?:(двадцать|тридцать) )?(.+?)(?:ого|ое|ье|ьего|ому|ый|ий|ой)$/.exec(w);
  if (m && ORD[m[2]] !== undefined) return (m[1] ? (m[1] === 'двадцать' ? 20 : 30) : 0) + ORD[m[2]];
  m = /^(\d{1,2})/.exec(w);
  return m ? Number(m[1]) : 0;
}

const MONTH_RES = [/^январ/, /^феврал/, /^март/, /^апрел/, /^ма[йяе]$/, /^июн/, /^июл/, /^август/, /^сентябр/, /^октябр/, /^ноябр/, /^декабр/];
const monthIndex = (w) => MONTH_RES.findIndex((re) => re.test(norm(w)));

const pad2 = (n) => String(n).padStart(2, '0');
function validISO(y, m, d) {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? `${y}-${pad2(m + 1)}-${pad2(d)}` : '';
}
const addDays = (today, n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n, 12);

/**
 * Достать из фразы даты и периоды и вырезать их.
 *
 * @param {string} text
 * @param {Date} today
 * @returns {{text:string, date:string, period:{from:string,to:string}|null, mentions:number}}
 */
function extractWhen(text, today) {
  let t = ` ${String(text)} `;
  const y = today.getFullYear();
  let date = '';
  let per = null;
  const cut = (re, fn) => {
    t = t.replace(re, (...a) => { fn(...a); return ' '; });
  };

  // ---- два дня через «с … по …» ----
  const dayMonth = `(${DAY_ANY})\\s+(${MONTH_ANY})(?:\\s+(20\\d{2}))?(?:\\s+года)?`;
  const rangeRe = new RegExp(`(?<![\\p{L}\\d])с\\s+${dayMonth}\\s+по\\s+${dayMonth}`, 'iu');
  const rm = rangeRe.exec(t);
  if (rm) {
    const a = validISO(Number(rm[3]) || y, monthIndex(rm[2]), ordinalValue(rm[1]));
    const b = validISO(Number(rm[6]) || y, monthIndex(rm[5]), ordinalValue(rm[4]));
    if (a && b) { per = { from: a, to: b }; t = t.replace(rm[0], ' '); }
  }
  // «с 01.09 по 15.10»
  if (!per) {
    const nr = /(?<![\p{L}\d])с\s+(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s+по\s+(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/iu.exec(t);
    if (nr) {
      const yy = (v) => (v ? (v.length === 2 ? 2000 + Number(v) : Number(v)) : y);
      const a = validISO(yy(nr[3]), Number(nr[2]) - 1, Number(nr[1]));
      const b = validISO(yy(nr[6]), Number(nr[5]) - 1, Number(nr[4]));
      if (a && b) { per = { from: a, to: b }; t = t.replace(nr[0], ' '); }
    }
  }

  // ---- «с первого января» — от даты до сегодня ----
  if (!per) {
    const fromRe = new RegExp(`(?<![\\p{L}\\d])с\\s+${dayMonth}`, 'iu');
    const fm = fromRe.exec(t);
    if (fm) {
      const a = validISO(Number(fm[3]) || y, monthIndex(fm[2]), ordinalValue(fm[1]));
      if (a) { per = { from: a, to: period.iso(today) }; t = t.replace(fm[0], ' '); }
    }
  }

  // ---- одна дата: «пятнадцатого сентября», «15 сентября», «20.10», «15.09.2026» ----
  const oneRe = new RegExp(`(?:(?<![\\p{L}\\d])(?:от|на|до|за|числом|датой|по)\\s+)?${dayMonth}`, 'iu');
  const om = oneRe.exec(t);
  if (om && !per) {
    // «за октябрь» — не день: день обязателен, и ловится именно он
    const iso = validISO(Number(om[3]) || y, monthIndex(om[2]), ordinalValue(om[1]));
    if (iso) { date = iso; t = t.replace(om[0], ' '); }
  }
  if (!date && !per) {
    const nm = /(?:(?<![\p{L}\d])(?:от|на|до|за|числом|датой)\s+)?(?<![\d.,])(0?[1-9]|[12]\d|3[01])[./](0[1-9]|1[0-2])(?:[./](20\d{2}|\d{2}))?(?![\d]|[.,]\d)/u.exec(t);
    if (nm) {
      const yy = nm[3] ? (nm[3].length === 2 ? 2000 + Number(nm[3]) : Number(nm[3])) : y;
      const iso = validISO(yy, Number(nm[2]) - 1, Number(nm[1]));
      if (iso) { date = iso; t = t.replace(nm[0], ' '); }
    }
  }

  // ---- «вчера», «позавчера», «сегодня» ----
  const rel = [
    [/(?<![\p{L}\d])(?:поза)вчера(?:шн[а-яё]+)?(?![\p{L}\d])/iu, -2],
    [/(?<![\p{L}\d])вчера(?:шн[а-яё]+)?(?:\s+числом)?(?![\p{L}\d])/iu, -1],
    [/(?<![\p{L}\d])сегодня(?:шн[а-яё]+)?(?:\s+числом)?(?![\p{L}\d])/iu, 0],
    [/(?<![\p{L}\d])завтра(?:шн[а-яё]+)?(?![\p{L}\d])/iu, 1],
  ];
  let relSeen = false;
  for (const [re, n] of rel) {
    const m = re.exec(t);
    if (m && !date) { date = period.iso(addDays(today, n)); t = t.replace(m[0], ' '); relSeen = true; break; }
  }

  // ---- периоды словами ----
  if (!per) {
    const word = (re, fn) => {
      const m = re.exec(t);
      if (m) { per = fn(m); if (per) t = t.replace(m[0], ' '); }
      return Boolean(per);
    };
    const preset = (code, whole = false) => {
      const r = period.presetRange(code, today, { whole });
      return { from: r.from, to: r.to };
    };
    const thisMon = (() => {
      const dow = (today.getDay() + 6) % 7;
      return addDays(today, -dow);
    })();
    const Q = { перв: 1, втор: 2, трет: 3, четверт: 4 };
    const qWord = (w) => Q[Object.keys(Q).find((k) => norm(w).startsWith(k))] || Number(String(w)[0]) || 0;
    const qRe = /(?:за|в|на)\s+(перв|втор|трет|четверт)[а-яё]*\s+квартал[а-яё]*(?:\s+(20\d{2}))?|(?:за|в|на)\s+([1-4])(?:-?[йго]+)?\s+квартал[а-яё]*(?:\s+(20\d{2}))?/iu;
    const _ = word(qRe, (m) => {
      const q = qWord(m[1] || m[3]);
      const yy = Number(m[2] || m[4]) || y;
      return q ? { from: period.iso(new Date(yy, (q - 1) * 3, 1)), to: period.iso(new Date(yy, (q - 1) * 3 + 3, 0)) } : null;
    })
      || word(/(?:за|в|на)\s+(перв|втор)[а-яё]*\s+полугоди[а-яё]*(?:\s+(20\d{2}))?/iu, (m) => {
        const yy = Number(m[2]) || y;
        return norm(m[1]).startsWith('перв')
          ? { from: `${yy}-01-01`, to: `${yy}-06-30` } : { from: `${yy}-07-01`, to: `${yy}-12-31` };
      })
      || word(/(?:за|в|на)\s+прошл[а-яё]+\s+квартал[а-яё]*/iu, () => preset('pq'))
      || word(/(?:за|в|на)\s+(?:этот|текущ[а-яё]+|последн[а-яё]+)\s+квартал[а-яё]*|(?:за|в|на)\s+квартал(?![а-яё])/iu, () => preset('q'))
      || word(/(?:за|в|на)\s+прошл[а-яё]+\s+месяц[а-яё]*/iu, () => preset('pm'))
      || word(/(?:за|в|на)\s+(?:этот|текущ[а-яё]+)\s+месяц[а-яё]*|в\s+этом\s+месяце/iu, () => preset('m'))
      || word(/(?:за|на|в)\s+прошл[а-яё]+\s+недел[а-яё]+/iu, () => ({ from: period.iso(addDays(thisMon, -7)), to: period.iso(addDays(thisMon, -1)) }))
      || word(/(?:за|на|в)\s+(?:эт[а-яё]+|текущ[а-яё]+)\s+недел[а-яё]+/iu, () => ({ from: period.iso(thisMon), to: period.iso(today) }))
      || word(/(?:за|в)\s+прошл[а-яё]+\s+год[а-яё]*/iu, () => preset('py'))
      || word(/с\s+начала\s+года|(?:за|в)\s+(?:этот|текущ[а-яё]+)\s+год[а-яё]*|за\s+год(?![а-яё])/iu, () => preset('y'))
      // «за 2025 год» — слово «год» обязательно: «за 2025» без него легко оказывается ценой.
      || word(/(?:за|в)\s+(20\d{2})\s*(?:год[а-яё]*|г\.?)(?![\p{L}\d])/iu, (m) => ({ from: `${m[1]}-01-01`, to: `${m[1]}-12-31` }));

    // Месяц словами: «за сентябрь», «в августе», «за декабрь прошлого года», «за март 2025»
    if (!per) {
      const mm = new RegExp(`(?:за|в|на|с)\\s+(${MONTH_ANY})(?:\\s+(?:и|по|-|–)\\s+(${MONTH_ANY}))?(?:\\s+(прошл[а-яё]+\\s+года|20\\d{2}))?(?:\\s+года)?`, 'iu').exec(t);
      if (mm) {
        const m = monthIndex(mm[1]);
        const m2 = mm[2] ? monthIndex(mm[2]) : -1;
        let yy = null;
        if (mm[3]) yy = /прошл/i.test(mm[3]) ? y - 1 : Number(mm[3]);
        const lastM = m2 >= 0 ? m2 : m;
        if (yy == null) {
          // год не назван: будущий месяц — это прошлогодний (так и в period.js)
          yy = new Date(y, lastM, 1) > today ? y - 1 : y;
        }
        // «август и сентябрь», «с ноября по февраль»: от первого до последнего
        const endYear = m2 >= 0 && m2 < m ? yy + 1 : yy;
        per = { from: period.iso(new Date(yy, m, 1)), to: period.iso(new Date(endYear, lastM + 1, 0)) };
        t = t.replace(mm[0], ' ');
      }
    }
  }
  return { text: t.replace(/\s{2,}/g, ' ').trim(), date, period: per, relative: relSeen };
}

// ---------- имена и падежи ----------

const ORG = /^(?:ооо|оао|зао|пао|ао|ип|тоо|нко|гк|кфх|чп|мбу|мку|мбоу)$/i;

const STEM_ENDS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ой', 'ей', 'ый', 'ий', 'ую', 'юю', 'ом', 'ем', 'ам', 'ям',
  'ах', 'ях', 'ых', 'их', 'ые', 'ие', 'ое', 'ее', 'ая', 'яя', 'ою', 'ею', 'ым', 'им', 'а', 'я', 'о', 'е', 'у', 'ю', 'ы', 'и', 'ь', 'й'];

/**
 * Корень слова для сравнения имён: «Заре», «Зарёй», «Зарю», «Заря» → «зар».
 * Это не лемматизатор: окончание срезается, а не угадывается. Для имён
 * клиентов этого хватает, а промахи ловит проверка «ровно один подходящий».
 */
function stem(w) {
  let x = norm(w);
  if (x.length <= 3) return x;
  // «ов/ев» в окончаниях нет нарочно: в «Сидоров» это часть фамилии, и срезанное
  // «сидор» не совпало бы с «сидорову»
  for (const e of STEM_ENDS) {
    if (x.length - e.length >= 3 && x.endsWith(e)) {
      x = x.slice(0, -e.length);
      break;
    }
  }
  return x.replace(/[ьй]$/, '');
}

/** «ветер» и «ветру»: беглая гласная не должна мешать узнать слово. */
function sameStem(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) !== 1 || Math.min(a.length, b.length) < 4) return false;
  const [lo, sh] = a.length > b.length ? [a, b] : [b, a];
  // выпадает гласная ближе к концу слова («ветер» → «ветр»); «север» и «сверь» не родня
  for (let i = Math.max(2, lo.length - 3); i < lo.length; i += 1) {
    if (/[ео]/.test(lo[i]) && lo.slice(0, i) + lo.slice(i + 1) === sh) return true;
  }
  return false;
}

const nameTokens = (name) => String(name || '').split(/[^\p{L}\p{N}]+/u).filter((w) => w && !ORG.test(w));

function lev1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}
const VOW = /[аеёиоуыэюя]/;
/** Похоже на ошибку распознавания: одна буква не та. */
function fuzzyStem(a, b) {
  if (a === b) return false;
  if (a.length < 3 || b.length < 3) return false;
  if (a.length === b.length) {
    let diff = -1;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) { if (diff >= 0) return false; diff = i; }
    }
    // короткие слова путаются только гласными, длинные — любой буквой
    return diff >= 0 && (a.length >= 5 || (VOW.test(a[diff]) && VOW.test(b[diff])));
  }
  return a.length >= 5 && b.length >= 5 && lev1(a, b);
}

/**
 * Насколько имя из фразы подходит клиенту.
 * @returns {{exact:number, prefix:number, fuzzy:number}}
 */
function nameScore(spoken, clientName) {
  const want = nameTokens(spoken).map(stem).filter((s) => s.length >= 3);
  const have = nameTokens(clientName).map(stem).filter((s) => s.length >= 3);
  let exact = 0; let prefix = 0; let fuzzy = 0;
  for (const w of want) {
    if (have.some((h) => sameStem(w, h))) exact += 1;
    else if (w.length >= 4 && have.some((h) => h.length >= 4 && (h.startsWith(w) || w.startsWith(h)))) prefix += 1;
    else if (have.some((h) => fuzzyStem(w, h))) fuzzy += 1;
  }
  return { exact, prefix, fuzzy, want: want.length, have: have.length };
}

/**
 * Где во фразе назван один из известных клиентов.
 *
 * Список клиентов — лучшая подсказка из всех: по нему видно и границы имени
 * («пекарне сладкий день» — одно имя, а не «пекарне» и посторонние слова), и
 * что «три медведя» — клиент, а не число с существительным.
 *
 * Сравниваем по корню слова, с первого слова клиента и подряд.
 *
 * @returns {{start:number,end:number,text:string,name:string}|null}
 */
function findClientMention(text, clients) {
  if (!clients || !clients.length) return null;
  const toks = [];
  // Дефисные названия («Лотос-Опт», «лотос-опту») режем по дефису: так слово
  // из фразы и слово из названия сравниваются один к одному.
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(text)) !== null) toks.push({ s: m[0], start: m.index, end: m.index + m[0].length });
  const numVal = (w) => (WORDS[norm(w)] ? WORDS[norm(w)].value : null);
  // Числительное в названии («Три медведя») совпадает по значению в любом падеже
  const same = (spoken, h) => {
    const a = numVal(spoken); const b = numVal(h);
    if (a !== null && b !== null) return a === b;
    const sa = stem(spoken);
    return sa.length >= 2 && sameStem(sa, stem(h));
  };
  let best = null;
  for (const name of clients) {
    const flat = nameTokens(name);
    if (!flat.length) continue;
    for (let i = 0; i < toks.length; i += 1) {
      for (let s0 = 0; s0 < flat.length; s0 += 1) {
        let k = s0; let j = i; let hits = 0;
        while (j < toks.length && k < flat.length && same(toks[j].s, flat[k])) { hits += 1; k += 1; j += 1; }
        if (!hits) continue;
        // одно короткое слово из многословного названия — слишком слабая улика;
        // а числительное одно — тем более: «три» есть в любой второй фразе
        if (flat.length > 1 && hits === 1 && (stem(flat[s0]).length < 4 || numVal(flat[s0]) !== null)) continue;
        const score = hits * 10 - (flat.length - hits);
        if (!best || score > best.score) {
          best = { score, start: toks[i].start, end: toks[j - 1].end, text: text.slice(toks[i].start, toks[j - 1].end), name };
        }
      }
    }
  }
  return best;
}

/** Участки текста, где названы клиенты с числительным в имени, — их числа не трогаем. */
function protectedRanges(text, clients) {
  const out = [];
  for (const name of clients || []) {
    if (!nameTokens(name).some((w) => WORDS[norm(w)])) continue;
    const hit = findClientMention(text, [name]);
    if (hit) out.push([hit.start, hit.end]);
  }
  return out;
}

// ---------- цифры: «15 тысяч», «30к», «12 500» ----------

function foldDigits(text) {
  let t = String(text);
  // «12 500» → 12500 (группа из ровно трёх цифр); «3 ‖ 100» остаётся двумя числами
  t = t.replace(/(?<![\d.,])(\d{1,3})((?:[   ]\d{3})+)(?![\d])(?![.,]\d{3})/g, (m, a, b) => a + b.replace(/[   ]/g, ''));
  // «50 тысяч», «1,5 млн», «30к», «15 т.р.»
  const mult = (re, k) => {
    t = t.replace(re, (m, n, tail) => {
      let v = Math.round(Number(String(n).replace(',', '.')) * k * 100) / 100;
      // «12 тысяч 500»: добавка из трёх цифр или круглого десятка — это остаток
      // той же суммы, а не отдельное число
      if (typeof tail === 'string' && k >= 1000) v += Number(tail);
      return String(v);
    });
  };
  mult(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:тысяч[а-яё]*|тыщ[а-яё]*|тыс(?![а-яё])\.?|т\.\s?р\.?(?![а-яё])|тр(?![а-яё])|тыр(?![а-яё]))(?:\s+(\d{3}|[1-9]0)(?![\d]))?/giu, 1000);
  mult(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:миллион[а-яё]*|млн(?![а-яё])\.?)(?:\s+(\d{3}000))?(?![\d])/giu, 1000000);
  mult(/(?<![\d.,])(\d+(?:[.,]\d+)?)[кk](?![\p{L}\d])/giu, 1000);
  // «100200 рублей 50 копеек» → 100200.50
  t = t.replace(/(\d+(?:[.,]\d+)?)\s*(?:руб[а-яё]*\.?|р\.?|₽)\s*(?:и\s+)?(\d{1,2})\s*коп[а-яё]*\.?/giu,
    (m, r, k) => `${r}.${String(k).padStart(2, '0')} руб`);
  return t;
}

/**
 * Привести фразу к виду, на который рассчитаны правила.
 *
 * @param {string} raw
 * @param {{today?:Date, clients?:string[]}} [opts]
 */
function prepare(raw, opts = {}) {
  const today = opts.today instanceof Date ? opts.today
    : opts.today ? new Date(`${opts.today}T12:00:00`) : period.todayDate();
  let t = String(raw || '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of SPELLED) t = t.replace(re, to);
  // «выстави-ка» — частица, а не часть слова
  t = t.replace(/(?<=[\p{L}])-ка(?![\p{L}\d])/giu, '');
  // «пол миллиона», «полтысячи»: половина масштаба, числа словами этого не умеют
  t = t.replace(/(?<![\p{L}\d])пол[\s-]?миллиона(?![\p{L}\d])/giu, '500000')
    .replace(/(?<![\p{L}\d])пол[\s-]?тысячи(?![\p{L}\d])/giu, '500');
  // «Бот, выставь…» — обращение; но «оплата бота» — предмет, поэтому только в начале
  t = t.replace(/^(?:бот|ассистент)[,\s]+/iu, '');
  t = t.replace(FILLER, ' ').replace(/\s{2,}/g, ' ').trim();
  const when = extractWhen(t, today);
  t = when.text;
  const keep = protectedRanges(t, opts.clients);
  t = wordsToDigits(t, { keep });
  // полкило и компания
  t = t.replace(/(?<![\p{L}\d])полкило(?:грамма)?(?![\p{L}\d])/giu, '0.5 кг')
    .replace(/(?<![\p{L}\d])пол[\s-]?литра(?![\p{L}\d])/giu, '0.5 л')
    .replace(/(?<![\p{L}\d])полчаса(?![\p{L}\d])/giu, '0.5 часа');
  t = foldDigits(t);
  t = t.replace(/\s{2,}/g, ' ').trim();
  // дата могла остаться словом после вырезания чисел («двадцать тысяч двадцатого октября») — вырезано выше
  return { raw: String(raw || ''), text: t, date: when.date, period: when.period, today, clients: opts.clients || [] };
}

module.exports = {
  prepare, extractWhen, stem, sameStem, nameTokens, nameScore, findClientMention, protectedRanges, foldDigits, ORG, norm,
};
