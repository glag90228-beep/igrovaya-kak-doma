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

/*
 * Названия месяцев: корень и допустимые окончания.
 *
 * По одному корню сверять нельзя: «максимум» начинается на «ма», «декада» —
 * на «дек», «маркетинг» — на «мар», и по корню все три превращались в месяцы.
 * Поэтому слово должно быть либо самим корнем (сокращение «мар», «сен»),
 * либо корнем с одним из окончаний — «марта», «сентябре», «мае».
 *
 * Букву «ё» текст теряет раньше, поэтому окончаний с ней здесь нет.
 */
const MONTHS = [
  ['янв', 'арь|аря|аре|арем'],
  ['фев', 'раль|раля|рале|ралем'],
  ['мар', 'т|та|те|том'],
  ['апр', 'ель|еля|еле|елем'],
  ['ма', 'й|я|е|ем'],
  ['июн', 'ь|я|е|ем'],
  ['июл', 'ь|я|е|ем'],
  ['авг', 'уст|уста|усте|устом'],
  ['сен', 'т|тябрь|тября|тябре|тябрем'],
  ['окт', 'ябрь|ября|ябре|ябрем'],
  ['ноя', 'брь|бря|бре|брем'],
  ['дек', 'абрь|абря|абре|абрем'],
];
const MONTH_RE = MONTHS.map(([root, tails]) => new RegExp(`^${root}(${tails})?$`));

const pad = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD' по местному времени. */
function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/*
 * «Сегодня» — по Москве, а не по часовому поясу сервера.
 *
 * Раньше дата бралась как new Date().toISOString(), то есть по UTC. Сервер
 * стоит в UTC, значит с 21:00 до полуночи по Москве наступал уже следующий
 * день — и счёт, выписанный в 01:00 первого сентября, получал дату
 * 31 августа. Для бухгалтерского документа это не косметика: он попадает
 * в другой месяц, а в новогоднюю ночь ещё и номер уходит в другой год.
 *
 * Москва выбрана как единый ориентир: документы российские, и дата на них
 * не должна зависеть от того, где физически стоит сервер.
 */
const mskFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Сегодняшняя дата по Москве, 'YYYY-MM-DD'. */
function todayISO(at = new Date()) { return mskFmt.format(at); }

/** Сегодня как Date с московским календарём в местных getFullYear/getMonth.
 *  Полдень — чтобы никакой сдвиг на час не перекинул дату на соседний день. */
function todayDate(at = new Date()) {
  const [y, m, d] = todayISO(at).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** Текущий год по Москве — для нумерации документов. */
function currentYear(at = new Date()) { return Number(todayISO(at).slice(0, 4)); }

/** Первое число месяца (y, m — 0-based месяц; переполнение месяца допустимо). */
const first = (y, m) => iso(new Date(y, m, 1));
/** Последнее число месяца — нулевой день следующего. */
const last = (y, m) => iso(new Date(y, m + 1, 0));

/**
 * Готовые периоды. Возвращает { code, from, to, label }.
 * Незнакомый код — как «за всё время»: лучше показать больше, чем пустой акт.
 */
function presetRange(code, today = todayDate(), { whole = false } = {}) {
  const y = today.getFullYear();
  const m = today.getMonth();
  /*
   * Незакрытые периоды кончаются сегодня или последним числом — смотря
   * зачем спрашивают. Акт сверки подписывают «по сегодня»: сверять надо то,
   * что уже случилось. Реестр документов, наоборот, собирают за месяц
   * целиком, в том числе заранее. Отсюда флаг whole.
   */
  const now = whole ? last(y, m) : iso(today);
  switch (String(code)) {
    case 'm': return { code: 'm', from: first(y, m), to: now, label: 'этот месяц' };
    case 'pm': return { code: 'pm', from: first(y, m - 1), to: last(y, m - 1), label: 'прошлый месяц' };
    case 'q': {
      const qm = Math.floor(m / 3) * 3;
      return {
        code: 'q', from: first(y, qm), label: `${qm / 3 + 1}-й квартал`,
        to: whole ? last(y, qm + 2) : iso(today),
      };
    }
    case 'pq': {
      const qm = Math.floor(m / 3) * 3 - 3;
      const py = qm < 0 ? y - 1 : y;
      const pm = qm < 0 ? qm + 12 : qm;
      return { code: 'pq', from: first(py, pm), to: last(py, pm + 2), label: `${pm / 3 + 1}-й квартал ${py}` };
    }
    case 'y': return {
      code: 'y', from: `${y}-01-01`, label: `${y} год`,
      to: whole ? `${y}-12-31` : iso(today),
    };
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
function parseDay(s, today = todayDate()) {
  const m = /^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/.exec(String(s).trim());
  if (!m) return null;
  const day = Number(m[1]);
  const mon = Number(m[2]);
  let y = m[3] || String(today.getFullYear());
  if (y.length === 2) y = `20${y}`;

  // Дату надо не только распарсить, но и проверить, что она существует:
  // «31.02.2026» раньше проходило и печаталось в шапке акта как
  // «по 31.02.2026». Такой документ клиенту не подпишешь.
  const d = new Date(Number(y), mon - 1, day);
  if (d.getFullYear() !== Number(y) || d.getMonth() !== mon - 1 || d.getDate() !== day) {
    return null;
  }
  return `${y}-${pad(mon)}-${pad(day)}`;
}

/** Номер месяца (0-based) по слову: «март», «марта», «мае» → 2, 4; иначе −1. */
function monthByWord(word) {
  const w = String(word).toLowerCase().replace(/ё/g, 'е');
  return MONTH_RE.findIndex((re) => re.test(w));
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
function parsePeriodText(text, today = todayDate()) {
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

  // Месяцы словами: «март», «за апрель 2025», «с марта по май», «апрель-июнь».
  //
  // Раньше брался первый попавшийся месяц и разбор на этом заканчивался:
  // на «с марта по май» приходил акт за один март. Ошибку такого рода
  // человек замечает только сверив суммы, поэтому берём весь диапазон —
  // от первого названного месяца до последнего.
  const months = [];
  for (const word of raw.split(/[^\p{L}]+/u)) {
    if (word.length < 3) continue;
    const m = monthByWord(word);
    if (m >= 0) months.push(m);
  }
  if (months.length) {
    const a = months[0];
    const b = months[months.length - 1];
    // «ноябрь-февраль» — это через новый год, иначе период вышел бы пустым.
    return { from: first(year, a), to: last(b < a ? year + 1 : year, b) };
  }

  // Только год.
  if (yearIn && /^\D*20\d{2}\D*$/.test(raw)) {
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  return null;
}

// parseDay наружу: он единственный разбор даты, который проверяет, что
// такая дата существует. bot.js держал свою копию без проверки — и «31.02»
// попадало в журнал.
module.exports = {
  PRESETS, presetRange, parsePeriodText, parseDay, iso, todayISO, todayDate, currentYear,
};
