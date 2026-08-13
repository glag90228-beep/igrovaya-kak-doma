'use strict';

/**
 * Разбор реквизитов, вставленных одним текстом.
 *
 * Люди копируют реквизиты блоком — из письма, из 1С, из карточки контрагента:
 *   «ИП Сарычева… ИНН: 183111485159 ОГРНИП: … Расчётный счёт: 40802…
 *    Банк: … ПАО СБЕРБАНК БИК банка: 048073601 Корсчёт: 30101…
 *    ИНН банка: 7707083893 КПП банка: 183502001»
 * Набирать это по одному полю мучительно, а свалить в одно поле — ломает
 * счёт: без отдельных р/с, БИК и к/с не собрать платёжный QR.
 *
 * Главная тонкость — не перепутать реквизиты организации с реквизитами её
 * банка: в блоке есть и «ИНН», и «ИНН банка», и «КПП», и «КПП банка».
 * Берём то, что БЕЗ слова «банк».
 */

const clean = (s) => String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** Значение метки, у которой нет слова «банк» рядом (реквизит самой организации). */
function labelOwn(text, label, digits) {
  const re = new RegExp(`${label}\\s*(банка|банк)?\\s*[:№N]?\\s*(\\d{${digits}})`, 'gi');
  let m; let own = ''; let any = '';
  while ((m = re.exec(text)) !== null) {
    if (!m[1]) { own = m[2]; break; }
    any = any || m[2];
  }
  return own || ''; // «банковское» значение специально не возвращаем
}

/** Первый 20-значный счёт по метке; иначе — по префиксу из списка кандидатов. */
function account(text, labelRe, prefixes, used) {
  const byLabel = new RegExp(`(?:${labelRe})\\s*[:№N]?\\s*(\\d{20})`, 'i').exec(text);
  if (byLabel && !used.has(byLabel[1])) { used.add(byLabel[1]); return byLabel[1]; }
  const all = text.match(/\b\d{20}\b/g) || [];
  for (const a of all) {
    if (used.has(a)) continue;
    if (prefixes.some((p) => a.startsWith(p))) { used.add(a); return a; }
  }
  return '';
}

// В JS \b не работает с кириллицей, поэтому граница — пробел после формы.
const shorten = (name) => clean(name)
  .replace(/^индивидуальный предприниматель\s+/i, 'ИП ')
  .replace(/^общество с ограниченной ответственностью\s+/i, 'ООО ')
  .replace(/^публичное акционерное общество\s+/i, 'ПАО ')
  .replace(/^акционерное общество\s+/i, 'АО ');

/**
 * Разбирает блок реквизитов. Возвращает только то, что удалось узнать;
 * пустые поля вызывающий код спросит или дозапросит по ИНН из реестра.
 * @returns {{name,full_name,inn,kpp,address,bank_name,bik,acc,corr_acc,ogrnip}}
 */
function parseRequisites(raw) {
  const text = clean(raw);
  const out = {
    name: '', full_name: '', inn: '', kpp: '', address: '',
    bank_name: '', bik: '', acc: '', corr_acc: '', ogrnip: '',
  };

  out.inn = labelOwn(text, 'ИНН', '10,12') || labelOwn(text, 'ИНН', '12') || labelOwn(text, 'ИНН', '10');
  out.kpp = labelOwn(text, 'КПП', '9');
  out.bik = (/(?:БИК)\s*(?:банка|банк)?\s*[:№N]?\s*(\d{9})/i.exec(text) || [])[1] || '';
  out.ogrnip = (/ОГРНИ?П?\s*[:№N]?\s*(\d{13,15})/i.exec(text) || [])[1] || '';

  const used = new Set();
  out.corr_acc = account(text, 'корр?\\.?\\s*сч[ёе]т|корсч[ёе]т|к\\/с|кор\\.?\\s*сч', ['301'], used);
  out.acc = account(text, 'расч[ёе]тный\\s*сч[ёе]т|р\\/с|расч\\.?\\s*сч', ['405', '406', '407', '408', '40'], used);

  // «Банк» как отдельное слово (не хвост «Сбербанк»): в JS \b не годится
  // для кириллицы, поэтому проверяем соседей вручную.
  const bankLabel = /(?<![А-Яа-яЁё])Банк\s*(?:получателя|плательщика)?\s*[:]?\s*([^:]+?)\s*(?:БИК|Корр|Корсч|К\/с|Кор\.|ИНН|КПП|Р\/с|Расч|$)/i.exec(text);
  const bankIn = /(?<![А-Яа-яЁё])в\s+([А-ЯЁ][^:]+?)\s*(?:БИК|Корр|Корсч|К\/с|Кор\.|$)/i.exec(text);
  const bankName = (bankLabel && bankLabel[1]) || (bankIn && bankIn[1]) || '';
  if (bankName) out.bank_name = clean(bankName);

  // Наименование — то, что стоит до первого «делового» ключевого слова
  // (в JS \b не работает с кириллицей, поэтому ищем по ключевым словам).
  const stop = text.search(/(ИНН|ОГРН|КПП|Р\/с|Расч|Кор|БИК|Банк|Адрес)/i);
  let head = stop > 0 ? text.slice(0, stop) : '';
  head = head.replace(/^(получатель|поставщик|плательщик|заказчик|исполнитель|наименование|реквизиты|организация|контрагент)\s*[:.]?\s*/i, '');
  head = head.replace(/[«»"]/g, '').replace(/[,;]\s*$/, '').trim();
  if (head && head.length >= 3 && /[а-яёa-z]/i.test(head)) {
    out.full_name = head;
    out.name = shorten(head);
  }

  const addr = /Адрес\s*[:]?\s*([^:]+?)\s*(?:ИНН|КПП|Р\/с|Расч|Банк|БИК|Тел|$)/i.exec(text);
  if (addr) out.address = clean(addr[1]);

  return out;
}

/** Похоже ли, что это блок реквизитов, а не просто ИНН. */
function looksLikeBlock(raw) {
  const t = clean(raw);
  if (/^\d{10}$|^\d{12}$/.test(t.replace(/\s/g, ''))) return false; // чистый ИНН
  const hints = /сч[ёе]т|бик|р\/с|к\/с|банк|огрн|инн|кпп/i.test(t);
  return hints && /[а-яёa-z]/i.test(t) && t.length > 15;
}

module.exports = { parseRequisites, looksLikeBlock };
