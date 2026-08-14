'use strict';

/**
 * Выпуск документов без Telegram.
 *
 * Раньше вся сборка жила внутри bot.js и была намертво сцеплена с отправкой
 * в чат. Мини-приложению нужно то же самое, но результат — не сообщение, а
 * файл в ответе HTTP. Копировать логику нельзя: два места разъедутся на
 * первой же правке формы. Поэтому здесь общая часть — какие бывают
 * документы, как собрать файл, как посчитать сумму, как записать в журнал, —
 * а бот и мини-апп сверху лишь по-своему отдают готовое пользователю.
 *
 * Правила нумерации и лимитов те же, что были: номер сквозной по типу за год,
 * бесплатных документов в месяц — сколько скажет quota().
 */

const bdb = require('./bot-db');
const { round2, vatTotals } = require('./money');
const facsimile = require('./facsimile');
const { pdfAvailable, htmlToPdf } = require('./pdf');
const { buildAktUslugHtml } = require('./akt-uslug');
const { buildSchetHtml } = require('./schet');
const { buildPlatyozhkaHtml } = require('./platyozhka');
const { buildUpdHtml } = require('./upd');
const { buildTorg12Html } = require('./torg12');
const { buildDogovorHtml } = require('./dogovor');

/** Документы, которые состоят из позиций «наименование × количество × цена». */
const ITEM_DOCS = {
  sch: { title: 'Счёт на оплату', build: buildSchetHtml, file: 'Счет' },
  usl: { title: 'Акт об оказании услуг', build: buildAktUslugHtml, file: 'Акт_услуг' },
  upd: { title: 'УПД', build: buildUpdHtml, file: 'УПД' },
  torg12: { title: 'Товарная накладная ТОРГ-12', build: buildTorg12Html, file: 'ТОРГ-12' },
};

/** Остальные: собираются из своих полей, а не из позиций. */
const OTHER_DOCS = {
  pp: { title: 'Платёжное поручение', build: buildPlatyozhkaHtml, file: 'Платежка' },
  dog: { title: 'Договор', build: buildDogovorHtml, file: 'Договор' },
};

const ALL_DOCS = { ...ITEM_DOCS, ...OTHER_DOCS };

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Имя файла: кириллицу оставляем, всё остальное — в подчёркивания. */
const safeName = (s) => String(s)
  .replace(/[«»"]/g, '')
  .replace(/[^\wА-Яа-яЁё-]+/g, '_')
  .replace(/^[_-]+|[_-]+$/g, '');

/**
 * HTML → файл. PDF, если поднимается Chromium; иначе тот же HTML —
 * его можно открыть в браузере и распечатать. Молча ронять выпуск
 * из-за неустановленного браузера нельзя: документ нужен человеку сейчас.
 */
async function renderFile(html, base) {
  if (pdfAvailable()) {
    try {
      const buffer = await htmlToPdf(html);
      return { filename: `${base}.pdf`, buffer, mime: 'application/pdf', pdf: true };
    } catch (_) { /* падаем на HTML ниже */ }
  }
  return {
    filename: `${base}.html`,
    buffer: Buffer.from(html, 'utf8'),
    mime: 'text/html; charset=utf-8',
    pdf: false,
  };
}

/**
 * Сумма документа — единственный источник итога, руками её не передают.
 *
 * С НДС «сверху» сумма к оплате больше произведения количества на цену:
 * 100 руб. + 20% это 120. Если считать без налога, в журнале и в подписи
 * к файлу окажется заниженная сумма, а долг контрагента — неверный.
 */
function totalOf(items, extra = {}) {
  const rate = extra.vatRate == null ? null : Number(extra.vatRate);
  return vatTotals(items || [], rate, Boolean(extra.priceIncludesVat)).total;
}

/**
 * Приводит присланные позиции к нашему виду и отбрасывает мусор.
 * Данные приходят из браузера, поэтому доверять типам нельзя.
 */
function cleanItems(raw) {
  const out = [];
  for (const it of Array.isArray(raw) ? raw.slice(0, 200) : []) {
    const name = String((it && it.name) || '').trim().slice(0, 300);
    if (!name) continue;
    const qty = Number(it.qty);
    const price = Number(it.price);
    out.push({
      name,
      unit: String((it && it.unit) || 'шт.').trim().slice(0, 20) || 'шт.',
      qty: Number.isFinite(qty) && qty > 0 ? round2(qty) : 1,
      price: Number.isFinite(price) && price >= 0 ? round2(price) : 0,
    });
  }
  return out;
}

/** Ошибка выпуска с понятной человеку причиной. */
function fail(reason, message) {
  return { ok: false, reason, message };
}

/**
 * Добавляет к организации подпись и печать для этого типа документа.
 * Шаблоны про базу ничего не знают — получают готовые картинки в org.fx.
 *
 * Платёжное поручение и договор сюда не попадают намеренно: платёжку
 * подписывают в банке живой подписью, а факсимиле на договоре по статье
 * 160 ГК допустимо только если стороны об этом заранее договорились.
 */
function withFx(userId, org, docType) {
  return { ...org, fx: facsimile.forDocument(userId, docType) };
}

/**
 * Выпускает документ: собирает файл и кладёт запись в журнал.
 *
 * @returns {{ok:true, doc:object, file:object, total:number, title:string}
 *          |{ok:false, reason:string, message:string, quota?:object}}
 */
async function issueDocument(userId, {
  type, cpId, items, date, number, extra = {}, skipQuota = false,
}) {
  const kind = ITEM_DOCS[type];
  if (!kind) return fail('type', 'Такой документ выписать нельзя.');

  const org = bdb.getDefaultOrg(userId);
  if (!org) return fail('org', 'Сначала заполните реквизиты своей организации.');

  const cp = bdb.getCp(userId, Number(cpId));
  if (!cp) return fail('cp', 'Контрагент не найден.');

  const clean = cleanItems(items);
  if (!clean.length) return fail('items', 'Добавьте хотя бы одну позицию.');

  const quota = bdb.quota(userId);
  if (!skipQuota && !quota.allowed) {
    return { ...fail('quota', `Бесплатные документы на этот месяц закончились (${quota.limit}).`), quota };
  }

  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : todayISO();
  const year = Number(when.slice(0, 4));
  const seq = bdb.nextSeq(userId, type, year);
  const num = String(number == null || number === '' ? seq : number).slice(0, 40);
  const total = totalOf(clean, extra);

  const doc = { number: num, date: when, items: clean, ...extra };
  const file = await renderFile(
    kind.build({ org: withFx(userId, org, type), cp, doc }),
    `${kind.file}_${safeName(num)}_${safeName(cp.name)}`,
  );

  bdb.rememberItems(userId, clean);
  const id = bdb.saveDoc(userId, {
    orgId: org.id, cpId: cp.id, type, number: num, seq, date: when, total,
    payload: { items: clean, ...extra },
  });

  // Долг в журнал — если этот тип документа его создаёт при выбранном
  // основании. Проводка привязана к документу: её видно, можно отменить,
  // и повторный выпуск того же документа её не задвоит.
  const debt = bdb.makesDebt(org, type) && total > 0
    ? bdb.addOpForDoc(userId, cp.id, {
      date: when, kind: 'Реализация', doc: `${kind.title} № ${num}`, credit: total,
    }, id)
    : false;

  return {
    ok: true,
    total,
    debt,
    basis: bdb.basisOf(org),
    title: kind.title,
    file,
    doc: {
      id, type, number: num, date: when, total, title: kind.title,
      cp: { id: cp.id, name: cp.name },
    },
    quota: bdb.quota(userId),
  };
}

/**
 * Пересобирает ранее выписанный документ по сохранённым данным.
 * Журнал хранит не файл, а поля — поэтому копия всегда свежая
 * и не занимает места, а номер и дата остаются прежними.
 */
async function rebuildDocument(userId, docId) {
  const saved = bdb.getDoc(userId, Number(docId));
  if (!saved) return fail('notfound', 'Документ не найден.');

  const kind = ALL_DOCS[saved.type];
  if (!kind) return fail('type', 'Этот документ пересобрать нельзя.');

  const org = bdb.getOrg(userId, saved.org_id) || bdb.getDefaultOrg(userId);
  const cp = bdb.getCp(userId, saved.cp_id);
  if (!org || !cp) return fail('data', 'Не хватает данных для сборки: проверьте организацию и контрагента.');

  const doc = { number: saved.number, date: saved.date, ...saved.payload };
  const file = await renderFile(
    kind.build({ org: withFx(userId, org, saved.type), cp, doc }),
    `${kind.file}_${safeName(saved.number)}_${safeName(cp.name)}`,
  );
  return { ok: true, file, title: saved.title || kind.title, doc: saved, total: saved.total };
}

module.exports = {
  ITEM_DOCS, OTHER_DOCS, ALL_DOCS,
  issueDocument, rebuildDocument, renderFile,
  totalOf, cleanItems, safeName, todayISO,
};
