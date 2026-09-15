'use strict';

/**
 * Поиск ответа в интернете — но только по источникам, которым верим.
 *
 * Зачем список источников, а не «весь интернет». По налоговому вопросу
 * первые места в выдаче занимают статьи бухгалтерских блогов и сайтов
 * бухгалтерских услуг. Они пишут бойко, часто верно и почти всегда без
 * даты: статья 2023 года выглядит как сегодняшняя, а ставки с тех пор
 * поменялись дважды. Сослаться на такую — хуже, чем не ответить: человек
 * решит, что проверил.
 *
 * Поэтому здесь белый список: сайты, где текст нормы первичен, а не
 * пересказан. Всё остальное отбрасывается, даже если оно первое в выдаче
 * и выглядит убедительно.
 *
 * ── Чего этот модуль не делает ──
 *
 * Не решает, верен ли ответ. Он приносит найденное и говорит, откуда оно.
 * Решение «отвечать этим или молчать» принимается выше, в lib/knowledge.js,
 * и там же к ответу приклеивается пометка с адресом источника.
 *
 * ── Про провайдеров ──
 *
 * Поисковый API у нас пока один — Яндекса, потому что ключ и каталог для
 * него уже есть: на них работает распознавание речи и фото. Заводить второй
 * сервис ради поиска незачем.
 *
 * ВАЖНО. Этот модуль написан по документации, но живьём не проверялся:
 * сайты ФНС и поисковый API из среды разработки недоступны (403 от
 * прокси). Прогоны идут на провайдере mock. Перед включением на боевом
 * сервере проверьте `node tools/keys-check.js` — он делает настоящий запрос.
 */

/**
 * Кому верим.
 *
 * Только первоисточники: сам текст нормы, разъяснения ведомств и решения
 * судов. Пересказы — нет, сколько бы их ни было в выдаче.
 */
const TRUSTED = [
  { host: 'nalog.gov.ru', name: 'ФНС России' },
  { host: 'pravo.gov.ru', name: 'Официальный интернет-портал правовой информации' },
  { host: 'publication.pravo.gov.ru', name: 'Официальное опубликование' },
  { host: 'minfin.gov.ru', name: 'Минфин России' },
  { host: 'sfr.gov.ru', name: 'Социальный фонд России' },
  { host: 'kremlin.ru', name: 'Президент России' },
  { host: 'duma.gov.ru', name: 'Государственная Дума' },
  { host: 'vsrf.ru', name: 'Верховный Суд' },
];

const PROVIDER = () => String(process.env.SEARCH_PROVIDER || '').toLowerCase();

/** Готов ли поиск: провайдер выбран и ключи к нему есть. */
function searchAvailable() {
  const p = PROVIDER();
  if (p === 'mock') return true;
  if (p === 'yandex') return Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID);
  return false;
}

function searchHint() {
  const p = PROVIDER();
  if (!p) return 'Поиск выключен (SEARCH_PROVIDER не задан).';
  if (p === 'yandex') return 'Нет YANDEX_API_KEY или YANDEX_FOLDER_ID.';
  return `Неизвестный поисковый провайдер: ${p}.`;
}

/**
 * Домен ссылки без «www.» — и null, если это вообще не ссылка.
 *
 * Разбираем через URL, а не регуляркой: «https://evil.com/?x=nalog.gov.ru»
 * содержит доверенный домен в строке, но доверенным сайтом не является, и
 * поиск подстроки тут открывает дорогу ровно такой подделке.
 */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) { return null; }
}

/**
 * Доверяем ли источнику.
 *
 * Поддомены разрешаем (`www.nalog.gov.ru`, `lk.nalog.gov.ru`), но только
 * настоящие: hostname должен либо совпадать, либо кончаться на «.домен».
 * Без второй проверки «nalog.gov.ru.evil.com» прошёл бы как свой.
 */
function trustedSource(url) {
  const host = hostOf(url);
  if (!host) return null;
  return TRUSTED.find((t) => host === t.host || host.endsWith(`.${t.host}`)) || null;
}

/** Убрать разметку и лишние пробелы из куска текста выдачи. */
const clean = (s) => String(s || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&[a-z]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Найти. Возвращает только то, чему верим.
 *
 * @param {string} query вопрос человека
 * @param {number} limit сколько источников вернуть
 * @returns {Promise<{ok:boolean, results?:Array, error?:string}>}
 */
async function search(query, limit = 3) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return { ok: false, error: 'Пустой запрос.' };
  if (!searchAvailable()) return { ok: false, error: searchHint() };

  const p = PROVIDER();
  let raw;
  try {
    raw = p === 'mock' ? mockResults() : await viaYandex(q);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const results = [];
  for (const r of raw) {
    const src = trustedSource(r.url);
    if (!src) continue;                       // чужой сайт — мимо
    const text = clean(r.snippet);
    if (!text) continue;
    results.push({ url: r.url, title: clean(r.title), snippet: text, source: src.name, host: hostOf(r.url) });
    if (results.length >= limit) break;
  }
  if (!results.length) {
    return { ok: false, error: 'В доверенных источниках ничего не нашлось.', filtered: raw.length };
  }
  return { ok: true, results };
}

/** Подделка выдачи для прогонов: без сети и без денег. */
function mockResults() {
  try { return JSON.parse(process.env.SEARCH_MOCK || '[]'); } catch (_) { return []; }
}

/**
 * Яндекс: поисковый API возвращает XML, а не JSON.
 *
 * Разбираем сами, без библиотеки: нам нужны три поля из каждой находки, а
 * тянуть ради этого зависимость в проект, где их две, — плохой обмен.
 */
async function viaYandex(query) {
  const res = await fetch('https://searchapi.api.cloud.yandex.net/v2/web/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
    },
    body: JSON.stringify({
      query: { searchType: 'SEARCH_TYPE_RU', queryText: query },
      folderId: process.env.YANDEX_FOLDER_ID,
      responseFormat: 'FORMAT_XML',
      groupSpec: { groupMode: 'GROUP_MODE_DEEP', groupsOnPage: 10, docsInGroup: 1 },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Поиск Яндекса ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  // Ответ приходит в base64 — так устроен их API, поле называется rawData.
  const xml = Buffer.from(String(data.rawData || ''), 'base64').toString('utf8');
  return parseYandexXml(xml);
}

/** Выдрать находки из XML выдачи. */
function parseYandexXml(xml) {
  const out = [];
  const docs = String(xml).split('<doc').slice(1);
  for (const d of docs) {
    const url = (/<url>([\s\S]*?)<\/url>/.exec(d) || [])[1];
    const title = (/<title>([\s\S]*?)<\/title>/.exec(d) || [])[1];
    const passages = [...d.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map((m) => m[1]);
    const headline = (/<headline>([\s\S]*?)<\/headline>/.exec(d) || [])[1];
    const snippet = passages.join(' ') || headline || '';
    if (url) out.push({ url: clean(url), title: title || '', snippet });
  }
  return out;
}

module.exports = {
  search, searchAvailable, searchHint, trustedSource, hostOf, parseYandexXml, TRUSTED,
};
