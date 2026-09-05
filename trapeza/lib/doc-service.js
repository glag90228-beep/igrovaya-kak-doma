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
const { withStamps } = require('./doc-html');
const { round2, vatTotals } = require('./money');
const facsimile = require('./facsimile');
const { pdfAvailable, htmlToPdf } = require('./pdf');
const { buildAktUslugHtml } = require('./akt-uslug');
const { buildSchetHtml } = require('./schet');
const { buildSchetDogovorHtml } = require('./schet-dogovor');
const { buildPlatyozhkaHtml } = require('./platyozhka');
const { buildUpdHtml } = require('./upd');
const { buildTorg12Html } = require('./torg12');
const { buildDogovorHtml } = require('./dogovor');
const { buildAvansHtml } = require('./avans');
const { buildKsfHtml } = require('./ksf');
const { isNpd } = require('./npd');
// Акт сверки — Excel, а не HTML: это журнал, его дополняют и считают в нём.
const { buildAkt } = require('./xlsx-akt');
// А для просмотра — печатная форма: таблицу браузер не показывает (см. ниже).
const { buildAktHtml } = require('./akt-html');

/** Документы, которые состоят из позиций «наименование × количество × цена». */
const ITEM_DOCS = {
  sch: { title: 'Счёт на оплату', build: buildSchetHtml, file: 'Счет' },
  schdog: { title: 'Счёт-договор', build: buildSchetDogovorHtml, file: 'Счет-договор' },
  usl: { title: 'Акт об оказании услуг', build: buildAktUslugHtml, file: 'Акт_услуг' },
  upd: { title: 'УПД', build: buildUpdHtml, file: 'УПД' },
  torg12: { title: 'Товарная накладная ТОРГ-12', build: buildTorg12Html, file: 'ТОРГ-12' },
};

/** Остальные: собираются из своих полей, а не из позиций. */
const OTHER_DOCS = {
  pp: { title: 'Платёжное поручение', build: buildPlatyozhkaHtml, file: 'Платежка' },
  dog: { title: 'Договор', build: buildDogovorHtml, file: 'Договор' },
  // Счёт-фактура на предоплату: позиций нет, есть полученная сумма.
  avans: { title: 'Счёт-фактура на аванс', build: buildAvansHtml, file: 'СФ_аванс' },
  // Корректировочный: строки парные «было/стало», обычными позициями не лягут.
  ksf: { title: 'Корректировочный счёт-фактура', build: buildKsfHtml, file: 'КСФ' },
};

const ALL_DOCS = { ...ITEM_DOCS, ...OTHER_DOCS };

// «Сегодня» — по Москве, а не по поясу сервера (пояснение в lib/period.js).
const { todayISO } = require('./period');

/** ДД.ММ.ГГГГ — так дата пишется во всех наших бланках. */
const ruDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
};

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
      /*
       * Потолок — не придирка, а защита от переполнения. Само по себе
       * количество конечно, но произведение количества на цену считается
       * дальше в double: два числа по 1e200 дают бесконечность, и документ
       * с такой позицией останавливал весь процесс. Миллиард штук по
       * миллиарду рублей — заведомо больше всего, что бывает в первичке,
       * и произведение таких чисел double держит с запасом.
       */
      qty: Number.isFinite(qty) && qty > 0 ? round2(Math.min(qty, 1e9)) : 1,
      price: Number.isFinite(price) && price >= 0 ? round2(Math.min(price, 1e9)) : 0,
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

  // Режим НДС организации применяем здесь, а не в боте: иначе мини-приложение
  // выписывало бы счета всегда без налога, игнорируя настройку.
  // Явно переданный vatRate (в том числе null — «этот счёт без НДС»)
  // сильнее умолчания, поэтому проверяем наличие ключа, а не значение.
  // Накладная сюда добавлена не сразу: она считала «без НДС» всегда, даже
  // у плательщика, и печатала одинаковый итог в графах с налогом и без.
  // УПД добавлен в этот список по той же причине, что накладная до него: без
  // него мини-приложение выписывало его всегда без налога, хотя ставка у
  // организации задана.
  let fields = extra;
  if (['sch', 'schdog', 'torg12', 'upd'].includes(type)
      && !Object.prototype.hasOwnProperty.call(extra, 'vatRate')) {
    const v = bdb.vatOf(org);
    if (v.rate != null) fields = { ...extra, vatRate: v.rate, priceIncludesVat: v.gross };
  }

  /*
   * Статус УПД, когда его не назвали, выводим из режима НДС организации.
   *
   * lib/upd.js читает отсутствующий статус как двойку — «передаточный
   * документ без счёта-фактуры», где ставка принудительно пустая. Из
   * мини-приложения статус не передавался вовсе, и плательщик НДС получал
   * бланк без шапки счёта-фактуры и с «без НДС» в налоговой графе, хотя
   * плитка обещает «счёт-фактура и акт». Покупателю нечего было принять к
   * вычету.
   *
   * Единица не годится всем подряд: у того, кто на упрощёнке, счёта-фактуры
   * нет и быть не должно, и двойка для него верна. Поэтому решает режим
   * налога, а не догадка.
   *
   * Самозанятый — исключение из этого правила, и цена ошибки здесь не
   * бухгалтерская, а денежная. Плательщик НПД не может быть плательщиком НДС
   * (ФЗ № 422-ФЗ, ч. 9 ст. 2), но экраны «Самозанятость» и «НДС» в настройках
   * независимы: ничто не мешает включить НПД и следом выбрать ставку. Дальше
   * правило «есть ставка → значит статус 1» молча выписывало ему счёт-фактуру
   * с выделенным налогом, а по п. 5 ст. 173 НК неплательщик, выставивший
   * такой счёт-фактуру, обязан уплатить весь этот НДС в бюджет и подать
   * декларацию. Заказчик вычет всё равно не получит. То есть человек забирал
   * себе налоговое обязательство на ровном месте, а программа, заведённая
   * ровно для того, чтобы он не ошибся, не говорила ни слова.
   *
   * Поэтому у самозанятого статус всегда 2 — передаточный документ без
   * счёта-фактуры. Сама ставка при этом не трогается: разбираться с
   * противоречием в настройках — дело человека, а не наше, но подсунуть ему
   * из-за этого недопустимый документ мы не вправе.
   */
  if (type === 'upd' && !Object.prototype.hasOwnProperty.call(fields, 'status')) {
    const payer = bdb.vatOf(org).rate != null && !isNpd(org);
    fields = { ...fields, status: payer ? 1 : 2 };
  }

  /*
   * Строка 5б: чем закрываем ранее полученный аванс.
   *
   * С 1 апреля 2026 года (постановление № 26 от 23.01.2026) отгрузочный
   * счёт-фактура обязан ссылаться на авансовый, если отгрузка идёт в счёт
   * предоплаты. Ссылку не выдумываем: берём номера и даты счетов-фактур на
   * аванс, выписанных этому же контрагенту и ещё не закрытых. Их может быть
   * несколько — тогда через «;», как требует форма.
   *
   * Явно переданный advDoc сильнее: человек мог указать, какой именно аванс
   * закрывает эта отгрузка, и наша догадка не должна его перебивать.
   */
  if (type === 'upd' && Number(fields.status) === 1
      && !Object.prototype.hasOwnProperty.call(fields, 'advDoc')) {
    const open = bdb.openAdvances(userId, Number(cpId));
    if (open.length) {
      fields = { ...fields, advDoc: open.map((a) => `№ ${a.number} от ${ruDate(a.date)}`).join('; ') };
    }
  }

  const quota = bdb.quota(userId);
  if (!skipQuota && !quota.allowed) {
    return { ...fail('quota', `Бесплатные документы на этот месяц закончились (${quota.limit}).`), quota };
  }

  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : todayISO();
  const year = Number(when.slice(0, 4));
  const total = totalOf(clean, fields);

  /*
   * Заданный руками номер проверяем на занятость.
   *
   * Уникальный индекс защищает порядковый номер, но не сам номер: его можно
   * ввести своей рукой, и он строка. Отсюда выходило так: первый счёт с
   * номером «3» руками, второй и третий — сами, и третий получал тот же
   * номер 3. Два счёта с одним номером за год — вопрос от бухгалтера
   * контрагента и повод для спора, а ряд при этом ещё и ломался: второй
   * документ оказывался с меньшим номером, чем первый.
   *
   * Отказываем до сборки файла, чтобы человек не получил PDF, которого нет
   * в журнале.
   */
  const wanted = number == null || number === '' ? '' : String(number).slice(0, 40);
  if (wanted && bdb.numberTaken(userId, type, year, wanted)) {
    return fail('number', `${kind.title} № ${wanted} за ${year} год уже выписан. Укажите другой номер.`);
  }

  /*
   * Номер берётся до сборки файла — он в нём напечатан, — а сборка PDF идёт
   * около секунды. За это время тот же номер может занять другой документ:
   * из мини-приложения, со второго нажатия, из повторной попытки. База такую
   * запись не пропустит, и тогда мы берём следующий номер и пересобираем
   * файл. Три попытки: больше одновременных выписок у одного человека не
   * бывает, а бесконечный цикл в проде хуже отказа.
   */
  let num; let file; let id;
  for (let attempt = 0; ; attempt += 1) {
    let seq = bdb.nextSeq(userId, type, year);
    /*
     * Порядковый номер и номер документа — разные вещи, и совпадают они лишь
     * пока никто не вводил номер руками. Стоит человеку выписать счёт № 3
     * своей рукой, и присвоенная тройка через две выписки столкнётся с ним:
     * порядковый свободен, а номер занят. Сдвигаемся до свободного — ряд от
     * этого прерывается, но два документа с одним номером хуже пропуска.
     */
    if (!wanted) {
      while (bdb.numberTaken(userId, type, year, String(seq))) seq += 1;
    }
    num = String(wanted || seq).slice(0, 40);
    const doc = { number: num, date: when, items: clean, ...fields };
    // eslint-disable-next-line no-await-in-loop
    file = await renderFile(
      kind.build({ org: withFx(userId, org, type), cp, doc }),
      `${kind.file}_${safeName(num)}_${safeName(cp.name)}`,
    );
    try {
      id = bdb.saveDoc(userId, {
        orgId: org.id, cpId: cp.id, type, number: num, seq, date: when, total,
        payload: { items: clean, ...fields },
      });
      break;
    } catch (e) {
      if (!bdb.isSeqTaken(e) || attempt >= 2) throw e;
    }
  }

  bdb.rememberItems(userId, clean);

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
 * Какие штампы поставить на копию — с проверкой по базе.
 *
 * «Оплачено» ставится только тогда, когда оплата действительно отмечена.
 * Это не придирка: документ со штампом уходит контрагенту и в банк, и
 * галочка в интерфейсе не должна уметь напечатать на бумаге то, чего в
 * учёте нет. Дата берётся из базы по той же причине.
 *
 * @param {object} saved строка документа из журнала
 * @param {{paid?:boolean, copy?:boolean}} want что попросили
 */
/**
 * Выпуск документа, у которого нет позиций: счёт-фактура на аванс и
 * корректировочный.
 *
 * Отдельно от issueDocument, потому что у тех вся суть в позициях —
 * количество на цену, потолки, шаблоны, память о введённом. Здесь этого нет:
 * у аванса одна полученная сумма, у корректировочного — парные строки
 * «было/стало», которые обычным списком позиций не лягут. Общими остаются
 * нумерация, квота и запись в журнал, и их мы честно повторяем, а не обходим:
 * два счёта-фактуры с одним номером за год — спор с контрагентом.
 *
 * Долг эти документы не создают. Аванс — деньги уже пришли, и приход по нему
 * заводит платёж, а не счёт-фактура. Корректировочный меняет сумму прежней
 * отгрузки, и трогать журнал за неё он не вправе.
 *
 * @returns {{ok:true, doc, file, total, title}|{ok:false, reason, message}}
 */
async function issueFlat(userId, {
  type, cpId, date, number, payload = {}, total = 0, skipQuota = false,
}) {
  const kind = OTHER_DOCS[type];
  if (!kind || !['avans', 'ksf'].includes(type)) {
    return fail('type', 'Такой документ выписать нельзя.');
  }
  const org = bdb.getDefaultOrg(userId);
  if (!org) return fail('org', 'Сначала заполните реквизиты своей организации.');
  const cp = bdb.getCp(userId, Number(cpId));
  if (!cp) return fail('cp', 'Контрагент не найден.');

  /*
   * Счёт-фактуру не выписывает тот, кто не плательщик НДС.
   *
   * У самозанятого это прямо запрещено (422-ФЗ), и последствие описано выше
   * у статуса УПД: выставил с выделенным налогом — обязан уплатить его в
   * бюджет. У остальных без ставки счёт-фактура бессмыслен: нечего в него
   * писать.
   */
  if (isNpd(org)) {
    return fail('npd', 'Самозанятый не может выставлять счета-фактуры: он не плательщик НДС.');
  }
  if (payload.vatRate == null) {
    return fail('vat', 'Счёт-фактура выставляется со ставкой НДС. Выберите её в разделе «НДС».');
  }

  const quota = bdb.quota(userId);
  if (!skipQuota && !quota.allowed) {
    return { ...fail('quota', `Бесплатные документы на этот месяц закончились (${quota.limit}).`), quota };
  }

  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : todayISO();
  const year = Number(when.slice(0, 4));
  const wanted = number == null || number === '' ? '' : String(number).slice(0, 40);
  if (wanted && bdb.numberTaken(userId, type, year, wanted)) {
    return fail('number', `${kind.title} № ${wanted} за ${year} год уже выписан. Укажите другой номер.`);
  }

  let num; let file; let id;
  for (let attempt = 0; ; attempt += 1) {
    let seq = bdb.nextSeq(userId, type, year);
    if (!wanted) {
      while (bdb.numberTaken(userId, type, year, String(seq))) seq += 1;
    }
    num = String(wanted || seq).slice(0, 40);
    const doc = { number: num, date: when, ...payload };
    // eslint-disable-next-line no-await-in-loop
    file = await renderFile(
      kind.build({ org: withFx(userId, org, type), cp, doc }),
      `${kind.file}_${safeName(num)}_${safeName(cp.name)}`,
    );
    try {
      id = bdb.saveDoc(userId, {
        orgId: org.id, cpId: cp.id, type, number: num, seq, date: when,
        total: round2(total), payload,
      });
      break;
    } catch (e) {
      if (!bdb.isSeqTaken(e) || attempt >= 2) throw e;
    }
  }

  return {
    ok: true, total: round2(total), title: kind.title, file,
    doc: bdb.getDoc(userId, id),
  };
}

function stampFor(saved, want) {
  if (!want) return null;
  const paid = Boolean(want.paid) && Boolean(saved.paid_at);
  const copy = Boolean(want.copy);
  return paid || copy ? { paid, copy, paidAt: saved.paid_at || '' } : null;
}

/**
 * Пересобирает ранее выписанный документ по сохранённым данным.
 * Журнал хранит не файл, а поля — поэтому копия всегда свежая
 * и не занимает места, а номер и дата остаются прежними.
 *
 * @param {object} [opts] opts.stamp — {paid, copy}, см. stampFor;
 *        opts.forView — собрать для просмотра в браузере, а не для работы
 */
async function rebuildDocument(userId, docId, opts = {}) {
  const saved = bdb.getDoc(userId, Number(docId));
  if (!saved) return fail('notfound', 'Документ не найден.');

  const org0 = bdb.getOrg(userId, saved.org_id) || bdb.getDefaultOrg(userId);
  const cp0 = bdb.getCp(userId, saved.cp_id);
  if (!org0 || !cp0) return fail('data', 'Не хватает данных для сборки: проверьте организацию и контрагента.');

  /*
   * Акт сверки собирается иначе всех остальных: не из позиций документа, а
   * из журнала операций за период. Позиций у него нет и не было, поэтому он
   * долго не умел пересобираться — а значит, и уходить почтой, хотя именно
   * его чаще всего и отправляют: сверка нужна не себе, а контрагенту.
   *
   * Период берём тот, за который акт выписывали (он записан в payload).
   * Пересчёт по свежему журналу — намеренно: если после выписки внесли
   * оплату, контрагент должен увидеть её, а не устаревшую бумагу.
   */
  if (saved.type === 'akt') {
    const p = bdb.cpForPeriod(userId, saved.cp_id, saved.payload.from || '', saved.payload.to || '');
    if (!p) return fail('data', 'Не удалось собрать акт: проверьте контрагента.');
    const forAkt = {
      org: {
        brand: org0.name, org_short: org0.name, org_full: org0.full_name || org0.name,
        org_inn: org0.inn, inn: org0.inn, signer: org0.signer,
      },
      cp: p.view,
      ops: p.ops,
    };
    const head = {
      ok: true,
      title: 'Акт сверки',
      doc: saved,
      total: Math.abs(p.closing),
      period: { from: p.from, to: p.to },
    };

    /*
     * Два вида одного акта, и выбор между ними — не про красоту.
     *
     * Таблицу браузер не открывает: по ссылке контрагент вместо документа
     * получал окно «Загрузить файл?» от незнакомого сайта. Поэтому для
     * просмотра собираем печатную форму, а таблица остаётся там, где она и
     * нужна, — файлом в чат и почтой тому, кто будет считать.
     */
    if (opts.forView) {
      const file = await renderFile(buildAktHtml(forAkt), `Акт_сверки_${safeName(cp0.name)}`);
      return { ...head, file };
    }

    return {
      ...head,
      file: {
        filename: `Акт_сверки_${safeName(cp0.name)}.xlsx`,
        buffer: Buffer.from(await buildAkt(forAkt)),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pdf: false,
      },
    };
  }

  const kind = ALL_DOCS[saved.type];
  if (!kind) return fail('type', 'Этот документ пересобрать нельзя.');

  const org = org0;
  const cp = cp0;

  const doc = { number: saved.number, date: saved.date, ...saved.payload };
  const stamp = stampFor(saved, opts.stamp);
  const file = await renderFile(
    withStamps(kind.build({ org: withFx(userId, org, saved.type), cp, doc }), stamp),
    `${kind.file}_${safeName(saved.number)}_${safeName(cp.name)}`,
  );
  return {
    ok: true, file, stamp, title: saved.title || kind.title, doc: saved, total: saved.total,
  };
}

module.exports = {
  ITEM_DOCS, OTHER_DOCS, ALL_DOCS,
  issueDocument, issueFlat, rebuildDocument, renderFile, stampFor,
  totalOf, cleanItems, safeName, todayISO,
};
