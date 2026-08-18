'use strict';

/**
 * Периоды для акта сверки.
 *
 * Один и тот же набор периодов нужен и боту (кнопками), и мини-приложению
 * (чипами), поэтому считаем их здесь, а не в двух местах. Пустое `from`
 * значит «от начала расчётов»: тогда акт стартует с начального сальдо из
 * карточки контрагента, а не с нуля.
 *
 * Даты собираем руками, а не через toISOString(): у сервера часовой пояс
 * может быть какой угодно, а «первое число этого месяца» должно совпадать
 * с тем, что человек видит в календаре у себя, а не в UTC.
 */

// Название месяца в тексте: и «март», и «марта», и «марте» — по корню.
const MONTH_ROOTS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const pad = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD' по местному времени. */
function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Первое число месяца (y, m — 0-based месяц; переполнение месяца допустимо). */
const first = (y, m) => iso(new Date(y, m, 1));
/** Последнее число месяца — нулевой день следующего. */
const last = (y, m) => iso(new Date(y, m + 1, 0));

/**
 * Готовые периоды. Возвращает { code, from, to, label }.
 * Незнакомый код — как «за всё время»: лучше показать больше, чем пустой акт.
 */
function presetRange(code, today = new Date()) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const now = iso(today);
  switch (String(code)) {
    case 'm': return { code: 'm', from: first(y, m), to: now, label: 'этот месяц' };
    case 'pm': return { code: 'pm', from: first(y, m - 1), to: last(y, m - 1), label: 'прошлый месяц' };
    case 'q': {
      const qm = Math.floor(m / 3) * 3;
      return { code: 'q', from: first(y, qm), to: now, label: `${qm / 3 + 1}-й квартал` };
    }
    case 'pq': {
      const qm = Math.floor(m / 3) * 3 - 3;
      const py = qm < 0 ? y - 1 : y;
      const pm = qm < 0 ? qm + 12 : qm;
      return { code: 'pq', from: first(py, pm), to: last(py, pm + 2), label: `${pm / 3 + 1}-й квартал ${py}` };
    }
    case 'y': return { code: 'y', from: `${y}-01-01`, to: now, label: `${y} год` };
    case 'py': return { code: 'py', from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: `${y - 1} год` };
    default: return { code: 'all', from: '', to: now, label: 'за всё время' };
  }
}

/** Кнопки периодов для бота — код и подпись. */
const PRESETS = [
  { code: 'm', text: 'Этот месяц' },
  { code: 'pm', text: 'Прошлый месяц' },
  { code: 'q', text: 'Этот квартал' },
  { code: 'pq', text: 'Прошлый квартал' },
  { code: 'y', text: 'Этот год' },
  { code: 'all', text: 'За всё время' },
];

/** '15.06.2026' / '15.6.26' / '15.06' → ISO; иначе null. */
function parseDay(s, today = new Date()) {
  const m = /^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/.exec(String(s).trim());
  if (!m) return null;
  const day = Number(m[1]);
  const mon = Number(m[2]);
  if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
  let y = m[3] || String(today.getFullYear());
  if (y.length === 2) y = `20${y}`;
  return `${y}-${pad(mon)}-${pad(day)}`;
}

/** Номер месяца (0-based) по слову: «март», «марта», «мае» → 2, 4. */
function monthByWord(word) {
  const w = String(word).toLowerCase().replace(/ё/g, 'е');
  // «май» и «март» начинаются одинаково — проверяем длинные корни первыми.
  let best = -1;
  let len = 0;
  MONTH_ROOTS.forEach((root, i) => {
    if (w.startsWith(root) && root.length > len) { best = i; len = root.length; }
  });
  return best;
}

/**
 * Период из свободного текста. Понимает то, что человек пишет сам:
 *
 *   «01.01.2026 - 31.03.2026», «с 1.1.26 по 31.3.26», «01.01.2026 31.03.2026»
 *   «март», «март 2025», «за апрель»
 *   «1 квартал», «II квартал 2025»
 *   «2025»
 *   «с 01.03.2026» — от даты по сегодня
 *
 * Возвращает { from, to } или null, если не разобрали.
 */
function parsePeriodText(text, today = new Date()) {
  const raw = String(text || '').trim().toLowerCase().replace(/ё/g, 'е');
  if (!raw) return null;
  if (/^(вс[её]|все время|за вс[её]|весь период|с начала)/.test(raw)) {
    return { from: '', to: iso(today) };
  }

  // Две даты — самый частый и самый однозначный случай.
  const days = raw.match(/\d{1,2}[.\-/]\d{1,2}(?:[.\-/]\d{2,4})?/g) || [];
  if (days.length >= 2) {
    const a = parseDay(days[0], today);
    const b = parseDay(days[1], today);
    if (a && b) return a <= b ? { from: a, to: b } : { from: b, to: a };
  }
  if (days.length === 1) {
    const a = parseDay(days[0], today);
    if (a) return { from: a, to: iso(today) };
  }

  const yearIn = /(20\d{2})/.exec(raw);
  const year = yearIn ? Number(yearIn[1]) : today.getFullYear();

  // Квартал: «1 квартал», «i кв 2025», «квартал 2».
  if (/кв(артал)?/.test(raw)) {
    const rim = { i: 1, ii: 2, iii: 3, iv: 4 };
    const num = /\b([1-4])\b/.exec(raw.replace(/20\d{2}/g, ''));
    const rm = /\b(iv|iii|ii|i)\b/.exec(raw);
    const q = num ? Number(num[1]) : (rm ? rim[rm[1]] : 0);
    if (q) return { from: first(year, (q - 1) * 3), to: last(year, (q - 1) * 3 + 2) };
  }

  // Месяц словом: «март», «за апрель 2025».
  for (const word of raw.split(/[^\p{L}]+/u)) {
    if (word.length < 3) continue;
    const m = monthByWord(word);
    if (m >= 0) return { from: first(year, m), to: last(year, m) };
  }

  // Только год.
  if (yearIn && /^\D*20\d{2}\D*$/.test(raw)) {
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  return null;
}

module.exports = { PRESETS, presetRange, parsePeriodText, iso };
