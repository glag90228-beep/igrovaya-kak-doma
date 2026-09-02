'use strict';

/**
 * Разбор банковской выписки и сведение её с долгами.
 *
 * Зачем это в продукте. Счета выставлены, а кто заплатил — знает только
 * банк. Пока сверка делается глазами, человек открывает выписку, ищет в ней
 * своих клиентов и отмечает оплаты руками; на полусотне строк это полчаса и
 * пара пропущенных платежей. Здесь выписка читается целиком, поступления
 * сопоставляются с долгами, и человеку остаётся подтвердить догадки.
 *
 * Форматы:
 *   1C   — «1CClientBankExchange», выгрузка из Клиент-Банка. Самый частый
 *          и самый надёжный: в нём есть счета обеих сторон и ИНН.
 *   OFX  — единообразный, отдают многие банки.
 *   CSV  — из личного кабинета; у каждого банка свой, поэтому колонки ищем
 *          по названиям, а не по номерам, и разделитель определяем сами.
 *
 * Кодировка. Русские банки выгружают чаще в windows-1251, чем в UTF-8.
 * Читаем байтами: если открыть файл как текст, кириллица превратится в мусор
 * ещё до разбора.
 *
 * Направление платежа. Не угадываем по знаку, если можно сравнить счета:
 * свой расчётный счёт мы знаем из карточки организации, а в выписке указаны
 * счета плательщика и получателя. Ошибка здесь означает, что чужой расход
 * закроет чужой долг.
 *
 * Идемпотентность. У каждой операции есть ключ из даты, суммы, направления и
 * назначения; одинаковые строки внутри файла получают порядковый номер.
 * Повторная загрузка того же файла не создаст вторых проводок, а два
 * настоящих одинаковых платежа за день не склеятся в один. В учёте
 * задвоенная оплата хуже, чем ненайденная.
 */

const { round2 } = require('./money');

// ---------- чтение файла ----------

/**
 * Байты → текст.
 *
 * Кодировку определяем по содержимому, а не по расширению: UTF-8 узнаётся по
 * корректной последовательности байтов, всё остальное с кириллицей — это
 * windows-1251.
 */
function decodeBytes(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return bytes.slice(3).toString('utf8');                     // BOM
  }
  const asUtf8 = bytes.toString('utf8');
  // Символ замены появляется там, где байты не складываются в UTF-8.
  if (!asUtf8.includes('�')) return asUtf8;
  try {
    return new TextDecoder('windows-1251').decode(bytes);
  } catch (_) {
    return asUtf8;
  }
}

// ---------- мелочи разбора ----------

/** Разделитель колонок: банки используют все три. */
function detectSeparator(line) {
  const count = (ch) => line.split(ch).length - 1;
  const tabs = count('\t');
  const semis = count(';');
  const commas = count(',');
  if (tabs > 0 && tabs >= semis && tabs >= commas) return '\t';
  if (semis > 0 && semis >= commas) return ';';
  return commas > 0 ? ',' : ';';
}

/**
 * Строка CSV с учётом кавычек.
 *
 * Кавычка открывает поле только в его начале. Русские банки сплошь и рядом
 * пишут «ООО "Заря"» без внешних кавычек, и по строгому правилу CSV название
 * осталось бы без кавычек, а разделитель внутри поля разорвал бы строку.
 */
function splitLine(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (quoted) {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else if (cur === '') {
        quoted = true;
      } else {
        cur += '"';                 // кавычка внутри поля — обычный символ
      }
      continue;
    }
    if (c === sep && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Дата в любом из встречающихся видов.
 * OFX пишет 20260816120000[+3:MSK] — без разделителей и с хвостом.
 */
function parseDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})[.\-/](\d{2})[.\-/](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{2})[.\-/](\d{2})[.\-/](\d{2})(?!\d)/.exec(s);
  if (m) return `20${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})(\d{2})(\d{2})/.exec(s);                          // OFX
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Сумма. Банки пишут «1 234,56», «1234.56», «1,234.56», «-1 234,56 RUB».
 * Разделителем копеек считаем последний знак препинания и только если после
 * него не больше двух цифр: в «1.500» точка разделяет разряды, а не копейки.
 */
function parseMoney(raw) {
  let s = String(raw == null ? '' : raw).replace(/[^\d,.\-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const neg = s.startsWith('-');
  s = s.replace(/-/g, '');
  const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  if (last >= 0 && s.length - last - 1 <= 2 && s.length - last - 1 > 0) {
    s = `${s.slice(0, last).replace(/[,.]/g, '')}.${s.slice(last + 1)}`;
  } else {
    s = s.replace(/[,.]/g, '');
  }
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 300);

/** Только цифры — для сравнения счетов и ИНН. */
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

/**
 * ИНН из назначения платежа.
 *
 * Голое десятизначное число в тексте — это чаще номер счёта или договора,
 * чем ИНН, поэтому в свободном тексте требуем подпись «ИНН» (в OFX её пишут
 * латиницей). Из отдельной колонки берём как есть: там ничего другого быть
 * не может.
 */
function innFromText(...parts) {
  for (const p of parts) {
    const m = /(?:ИНН|INN)\D{0,3}(\d{12}|\d{10})(?!\d)/i.exec(String(p == null ? '' : p));
    if (m) return m[1];
  }
  return '';
}

/** ИНН из колонки (если она есть), иначе из текста. */
function innFrom(cell, ...texts) {
  const d = digits(cell);
  if (d.length === 10 || d.length === 12) return d;
  return innFromText(...texts);
}

/**
 * Ключ операции — защита от повторной загрузки одного и того же файла.
 * Дата, направление, сумма и начало назначения: этого достаточно, чтобы
 * узнать ту же строку, и мало, чтобы случайно склеить две разные.
 */
const keyOf = (t) => [
  t.date,
  t.incoming ? 'in' : 'out',
  Number(t.amount).toFixed(2),
  clean(t.purpose).slice(0, 60).toLowerCase(),
].join('|');

/**
 * Проставить ключи с учётом повторов внутри файла.
 * Два одинаковых платежа за один день — законная ситуация, и второй не
 * должен потеряться; при повторной загрузке того же файла нумерация
 * повторится, поэтому оба узнаются как уже загруженные.
 */
function assignKeys(rows) {
  const seen = new Map();
  for (const t of rows) {
    const base = keyOf(t);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    t.key = n > 1 ? `${base}#${n}` : base;
  }
  return rows;
}

// ---------- CSV ----------

const COL = {
  date: ['дата операции', 'дата платежа', 'дата проводки', 'дата документа', 'дата', 'date'],
  innPayer: ['инн плательщика', 'инн отправителя'],
  innPayee: ['инн получателя'],
  inn: ['инн контрагента', 'инн', 'inn'],
  income: ['сумма по кредиту', 'оборот по кредиту', 'приход', 'поступление', 'зачисление', 'кредит', 'credit'],
  expense: ['сумма по дебету', 'оборот по дебету', 'расход', 'списание', 'дебет', 'debit'],
  amount: ['сумма операции', 'сумма платежа', 'сумма в валюте счета', 'сумма', 'amount'],
  purpose: ['назначение платежа', 'назначение', 'описание операции', 'описание', 'комментарий', 'purpose', 'memo'],
  payer: ['наименование плательщика', 'плательщик', 'отправитель'],
  payee: ['наименование получателя', 'получатель'],
  name: ['наименование контрагента', 'контрагент', 'наименование', 'counterparty', 'description'],
  accPayer: ['счет плательщика', 'счёт плательщика'],
  accPayee: ['счет получателя', 'счёт получателя'],
  direction: ['тип операции', 'направление', 'приход/расход', 'тип', 'direction'],
};

/**
 * Номер колонки по любому из знакомых названий: сначала точное совпадение,
 * потом частичное. Занятые колонки пропускаем — иначе «ИНН получателя»
 * достанется полю «получатель», а «Сумма по дебету» — полю «сумма».
 */
function findCol(headers, names, used) {
  const free = (i) => i >= 0 && !used.has(i);
  for (const name of names) {
    const i = headers.findIndex((h, k) => h === name && free(k));
    if (i >= 0) { used.add(i); return i; }
  }
  for (const name of names) {
    const i = headers.findIndex((h, k) => h.includes(name) && free(k));
    if (i >= 0) { used.add(i); return i; }
  }
  return -1;
}

const at = (cols, i) => (i >= 0 && i < cols.length ? cols[i] : '');

/**
 * Разложить заголовок по полям. Порядок важен: сперва самые узкие названия,
 * иначе общее «сумма» или «получатель» заберёт чужую колонку.
 */
function mapHeader(headers) {
  const used = new Set();
  const c = {};
  c.date = findCol(headers, COL.date, used);
  c.innPayer = findCol(headers, COL.innPayer, used);
  c.innPayee = findCol(headers, COL.innPayee, used);
  c.inn = findCol(headers, COL.inn, used);
  c.accPayer = findCol(headers, COL.accPayer, used);
  c.accPayee = findCol(headers, COL.accPayee, used);
  c.income = findCol(headers, COL.income, used);
  c.expense = findCol(headers, COL.expense, used);
  c.amount = findCol(headers, COL.amount, used);
  c.purpose = findCol(headers, COL.purpose, used);
  c.payer = findCol(headers, COL.payer, used);
  c.payee = findCol(headers, COL.payee, used);
  c.name = findCol(headers, COL.name, used);
  c.direction = findCol(headers, COL.direction, used);
  return c;
}

const normHeader = (h) => h.toLowerCase().replace(/[«»"]/g, '').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Заголовок бывает не в первой строке: перед ним пишут «Выписка по счёту…». */
function findHeaderLine(lines) {
  for (let i = 0; i < Math.min(lines.length, 15); i += 1) {
    const sep = detectSeparator(lines[i]);
    const headers = splitLine(lines[i], sep).map(normHeader);
    if (headers.length < 2) continue;
    const c = mapHeader(headers);
    if (c.date >= 0 && (c.amount >= 0 || c.income >= 0 || c.expense >= 0)) {
      return { index: i, sep, cols: c };
    }
  }
  return null;
}

/**
 * @param {string} text содержимое CSV
 * @param {Set<string>} own свои расчётные счета (для точного направления)
 * @returns {Array<object>} операции
 */
function parseCsv(text, own = new Set()) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  const head = findHeaderLine(lines);
  if (!head) return [];
  const { sep, cols: c } = head;

  const out = [];
  for (const line of lines.slice(head.index + 1)) {
    const cols = splitLine(line, sep);
    if (cols.length < 2) continue;
    const date = parseDate(at(cols, c.date));
    if (!date) continue;

    // Приход и расход в разных колонках (Сбер и другие) — направление точное.
    const income = c.income >= 0 ? parseMoney(at(cols, c.income)) : null;
    const expense = c.expense >= 0 ? parseMoney(at(cols, c.expense)) : null;
    let amount = null;
    let incoming = null;
    /*
     * В выделенной колонке минус означает сторно.
     *
     * Направление здесь задаёт сама колонка, поэтому знак ничего не дублирует
     * и может значить только отмену: сторно ошибочного зачисления или
     * возврат. Раньше проверка `if (income)` считала истинным любое ненулевое
     * число, и такая строка проходила приходом, а Math.abs ниже стирал знак
     * окончательно. В приложении она вставала рядом с настоящей оплатой, обе
     * уверенно привязывались к тому же контрагенту по ИНН и отмечались
     * заранее — одно нажатие «Занести» закрывало долг дважды: сначала
     * оплатой, потом её же отменой.
     *
     * В одной общей колонке «Сумма» знак значит другое — там он просто
     * обозначает расход, и направление всё равно берётся из типа операции.
     * Поэтому ветка ниже трогать знак не должна.
     */
    if (income) {
      amount = Math.abs(income); incoming = income > 0;
    } else if (expense) {
      amount = Math.abs(expense); incoming = expense < 0;
    } else {
      amount = parseMoney(at(cols, c.amount));
      if (!amount) continue;
      const accPayee = digits(at(cols, c.accPayee));
      const accPayer = digits(at(cols, c.accPayer));
      const dir = at(cols, c.direction);
      if (own.size && accPayee && own.has(accPayee)) incoming = true;
      else if (own.size && accPayer && own.has(accPayer)) incoming = false;
      else if (/приход|поступ|зачисл|кредит|credit|incoming/i.test(dir)) incoming = true;
      else if (/расход|списан|дебет|debit|outgoing/i.test(dir)) incoming = false;
      else incoming = amount > 0;
    }
    if (!amount) continue;

    const purpose = clean(at(cols, c.purpose));
    // Контрагент — это вторая сторона: при поступлении плательщик, при
    // списании получатель.
    const side = incoming
      ? clean(at(cols, c.payer)) || clean(at(cols, c.name))
      : clean(at(cols, c.payee)) || clean(at(cols, c.name));
    const sideInn = incoming
      ? innFrom(at(cols, c.innPayer) || at(cols, c.inn), purpose)
      : innFrom(at(cols, c.innPayee) || at(cols, c.inn), purpose);

    out.push({
      date,
      amount: round2(Math.abs(amount)),
      incoming,
      name: side,
      inn: sideInn,
      purpose,
      doc: '',
    });
  }
  return assignKeys(out);
}

// ---------- OFX ----------

const ofxTag = (block, tag) => {
  const m = new RegExp(`<${tag}>\\s*([^<\\r\\n]+)`, 'i').exec(block);
  return m ? m[1].trim() : '';
};

/** @returns {Array<object>} операции из OFX/QFX */
function parseOfx(text) {
  const out = [];
  for (const block of String(text).match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || []) {
    const date = parseDate(ofxTag(block, 'DTPOSTED'));
    const amount = parseMoney(ofxTag(block, 'TRNAMT'));
    if (!date || !amount) continue;
    const name = clean(ofxTag(block, 'NAME'));
    const memo = clean(ofxTag(block, 'MEMO'));
    out.push({
      date,
      amount: round2(Math.abs(amount)),
      incoming: amount > 0,                       // в OFX знак — это и есть направление
      name,
      inn: innFromText(name, memo),
      purpose: memo || name,
      doc: clean(ofxTag(block, 'CHECKNUM')),
    });
  }
  return assignKeys(out);
}

// ---------- 1CClientBankExchange ----------

/**
 * Выгрузка из Клиент-Банка: пары «Ключ=Значение», документы между
 * «СекцияДокумент» и «КонецДокумента». Формат описан в стандарте 1С и
 * поддерживается почти всеми банками — если он есть, берём его.
 */
function parse1C(text, own = new Set()) {
  const lines = String(text).split(/\r?\n/);
  const mine = new Set(own);

  // Свои счета объявлены в шапке файла и в секциях расчётного счёта.
  for (const line of lines) {
    const m = /^(РасчСчет|РасчетныйСчет)\s*=\s*(.+)$/i.exec(line.trim());
    if (m) {
      const acc = digits(m[2]);
      if (acc) mine.add(acc);
    }
    if (/^СекцияДокумент/i.test(line.trim())) break;
  }

  const out = [];
  let doc = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^СекцияДокумент/i.test(line)) { doc = {}; continue; }
    if (/^КонецДокумента/i.test(line)) {
      if (doc) {
        const t = doc1C(doc, mine);
        if (t) out.push(t);
      }
      doc = null;
      continue;
    }
    if (!doc) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    doc[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return assignKeys(out);
}

function doc1C(d, mine) {
  const date = parseDate(d.датапоступило || d.датасписано || d.дата);
  const amount = parseMoney(d.сумма);
  if (!date || !amount) return null;

  const accPayee = digits(d.получательсчет || d.получательрасчсчет);
  const accPayer = digits(d.плательщиксчет || d.плательщикрасчсчет);
  let incoming;
  if (mine.size && accPayee && mine.has(accPayee)) incoming = true;
  else if (mine.size && accPayer && mine.has(accPayer)) incoming = false;
  else if (d.датапоступило) incoming = true;
  else if (d.датасписано) incoming = false;
  else return null;      // направление неизвестно — лучше пропустить, чем угадать

  const purpose = clean(d.назначениеплатежа);
  return {
    date,
    amount: round2(Math.abs(amount)),
    incoming,
    name: clean(incoming ? (d.плательщик || d.плательщик1) : (d.получатель || d.получатель1)),
    inn: innFrom(incoming ? d.плательщикинн : d.получательинн, purpose),
    purpose,
    doc: clean(d.номер),
  };
}

// ---------- точка входа ----------

/**
 * Разбор по содержимому: расширение файла может врать, содержимое — нет.
 *
 * @param {Buffer} buf файл выписки
 * @param {object} [opts]
 * @param {Array<string>} [opts.ownAccounts] свои расчётные счета из карточки
 *        организации — по ним направление платежа определяется точно
 * @returns {{format: string, rows: Array<object>}}
 */
function parseStatement(buf, opts = {}) {
  const text = decodeBytes(buf);
  const own = new Set((opts.ownAccounts || []).map(digits).filter(Boolean));
  if (/1CClientBankExchange/i.test(text)) return { format: '1C', rows: parse1C(text, own) };
  if (/<STMTTRN>/i.test(text)) return { format: 'OFX', rows: parseOfx(text) };
  return { format: 'CSV', rows: parseCsv(text, own) };
}

// ---------- сведение с контрагентами ----------

const LEGAL_FORMS = new Set(['ооо', 'оао', 'зао', 'пао', 'нко', 'ао', 'ип', 'фгуп', 'мбу', 'гбу', 'llc', 'ooo']);

/**
 * Похожесть названий: «ООО "Заря"» и «Заря, ООО» — одно и то же.
 * Слова режем по не-буквам: \b в JavaScript кириллицу не видит, поэтому
 * привычное \b(ооо)\b не сработало бы никогда.
 */
function similarity(a, b) {
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join('');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  let same = 0;
  const len = Math.min(x.length, y.length);
  while (same < len && x[same] === y[same]) same += 1;
  return same >= 5 ? same / Math.max(x.length, y.length) : 0;
}

/**
 * Кому относится поступление.
 *
 * Совпадение по ИНН решающее: он уникален, и в назначении платежа его пишет
 * сам банк. Название и совпадение суммы с долгом — подсказки. Уверенность
 * показываем человеку, а решение оставляем ему: ошибочно закрытый долг
 * заметят через месяц, когда клиент не заплатит.
 *
 * Шкала уверенности: 30 — минимум, чтобы вообще назвать контрагента,
 * 60 — достаточно, чтобы приложение отметило строку заранее. До 60 не
 * дотягивают ни одно название без ИНН, ни одна сумма без названия.
 *
 * @param {Array} rows операции из parseStatement
 * @param {Array} cps контрагенты (поля id, name, inn)
 * @param {Function} balanceOf (cpId) => сальдо, чтобы сверить сумму с долгом
 * @returns {Array<object>} только поступления, с полями cp и confidence
 */
function matchToCounterparties(rows, cps, balanceOf = () => 0) {
  return rows.filter((t) => t.incoming).map((t) => {
    let best = null;
    let score = 0;
    let rival = null;
    for (const cp of cps) {
      let s = 0;
      if (t.inn && cp.inn && digits(t.inn) === digits(cp.inn)) s += 60;
      // Полное совпадение названия весит заметно больше частичного: «Заря» и
      // «Заря» — это почти наверняка один и тот же, а «Заря» внутри
      // «Заря-Строй» — уже совсем другая организация.
      const sim = similarity(t.name || t.purpose, cp.name);
      if (sim === 1) s += 40;
      else s += Math.round(sim * 20);
      const debt = Math.abs(Number(balanceOf(cp.id)) || 0);
      if (debt && Math.abs(debt - t.amount) < 0.01) s += 25;
      else if (debt && Math.abs(debt - t.amount) < debt * 0.05) s += 10;
      if (s > score) { score = s; best = cp; rival = null; }
      else if (s === score && s > 0 && best && cp.id !== best.id) rival = cp;
    }
    /*
     * Ничья — это отказ, а не выбор первого попавшегося.
     *
     * Раньше при равном счёте побеждал тот, кого раньше завели: строка
     * набирала 60 и попадала в «узнал уверенно», то есть заносилась одним
     * нажатием. Два клиента с одинаковым коротким названием — и оплата
     * молча уходит не тому. Ошибка в деньгах, которую никто не заметит.
     */
    const tie = Boolean(rival && score > 0);
    return {
      ...t,
      cp: !tie && score >= 30 && best ? { id: best.id, name: best.name } : null,
      ambiguous: tie,
      rivals: tie ? [best.name, rival.name] : [],
      confidence: Math.min(100, score),
    };
  });
}

module.exports = {
  parseStatement, parseCsv, parseOfx, parse1C, matchToCounterparties,
  decodeBytes, parseDate, parseMoney, similarity, keyOf,
};
