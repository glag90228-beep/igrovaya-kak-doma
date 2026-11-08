'use strict';

/**
 * Правила разбора фразы без модели: выписка документа, оплата, акт сверки,
 * «напомни», «повтори».
 *
 * Принцип тот же, что и у всего разбора: правило либо уверено, либо молчит.
 * Молчание — это не ошибка: фраза уходит модели, а если её нет — человеку
 * задаётся вопрос. Ошибка — это когда правило ответило, но неверно, потому что
 * дальше бот сам выпишет документ или внесёт оплату. Поэтому там, где правило не
 * может отличить «двести» от «два по сто», оно оставляет сумму пустой.
 *
 * Все функции принимают контекст из phrase-norm.prepare(): текст, в котором
 * уже нет слов-паразитов, дат и чисел словами.
 */

const { findClientMention, ORG, norm } = require('./phrase-norm');
const { parseItems } = require('./phrase-items');
const { amountFrom } = require('./phrase-money');

const L = '[\\p{L}\\d]';
const NB = `(?<!${L})`;          // слева не буква: \b не знает кириллицы
const NA = `(?!${L})`;           // справа не буква

// ---------- документы ----------

/*
 * Падежные формы перечислены руками, а не «акт[а-я]*»: иначе «активные» и
 * «счётчик» становились бы документами. Ссылки («по счёту 105», «по договору
 * 5») документом не считаем — это не просьба выписать, а указание на другой.
 */
const REF_BEFORE = '(?<!(?:по|согласно|к|от|в\\s+рамках|на\\s+основании)\\s)';
const DOC_RE = new RegExp(`${NB}${REF_BEFORE}(`
  + 'сч[её]т[\\s-]*договор(?:а|у|ом|е)?|'
  + 'плат[её]жн(?:ое|ого|ым|ом)\\s+поручени(?:е|я|ю|ем)|'
  + 'плат[её]жк(?:а|у|и|е|ой)|'
  + 'накладн(?:ая|ую|ой|ые|ых)|торг[\\s-]*12|упд|'
  + 'акт(?:а|у|ом|е|ы|ов)?(?!\\s+сверк)|'
  + 'сч[её]т(?:а|у|ом|е|ов|ам)?|'
  + `договор(?:а|у|ом|е|ы|ов)?)${NA}`, 'iu');

function docKind(word) {
  const w = norm(word).replace(/\s+/g, ' ');
  if (/^счет[\s-]*договор/.test(w)) return 'schdog';
  if (/^платежн|^платежк/.test(w)) return 'pp';
  if (/^накладн|^торг/.test(w)) return 'torg12';
  if (w === 'упд') return 'upd';
  if (/^акт/.test(w)) return 'usl';
  if (/^счет/.test(w)) return 'sch';
  if (/^договор/.test(w)) return 'dog';
  return '';
}

/*
 * Глагол просьбы — повелительное наклонение, неопределённая форма и «давай
 * выставим». Формы перечислены явно: по корню «выпис…» ловились и «что я
 * выписал», и «выписанные документы» — рассказ о сделанном принимался за
 * просьбу и превращался в новый документ.
 */
const CREATE = new RegExp(`${NB}(?:`
  + 'выстав(?:ь|ьте|ить|ляй|ляйте|лять|им|лю|ишь|и)|'
  + 'выпиш(?:и|ите|ем|у|ешь)|выпис(?:ать)|'
  + 'созда(?:й|йте|ть|м|дим)|'
  + 'оформ(?:и|ите|ить|им|лю)|'
  + 'сдела(?:й|йте|ть|ем|ю)|'
  + 'сформир(?:уй|уйте|овать|уем|ую)|'
  + 'состав(?:ь|ьте|ить|им|лю)|'
  + 'подготов(?:ь|ьте|ить|им|лю)|'
  + 'пробе(?:й|йте)|пробить|'
  + 'нарису(?:й|йте|ем)|нарисовать|'
  + 'накин(?:ь|ьте|уть)|'
  + 'сгенерир(?:уй|овать)|'
  + `оплати(?:ть|те)?)${NA}`, 'iu');
const WANT = new RegExp(`${NB}(?:нужен|нужна|нужно|надо|необходим[а-яё]*|требуется|хочу)${NA}`, 'iu');
const VIEW = new RegExp(`${NB}(?:покаж[а-яё]*|открой|найд[а-яё]*|выведи|список|посмотр[а-яё]*|где|какие|сколько|есть\\s+ли|удали[а-яё]*|отмени[а-яё]*|скача[а-яё]*|отправ[а-яё]*|пришли|вышли|скинь|перешли|распечата[а-яё]*|исправ[а-яё]*)${NA}`, 'iu');
/*
 * Вопрос, условие, пожелание — не поручение. «Как выставить счёт», «выставлен ли
 * счёт», «если Заря оплатит, выставь акт», «хочу, чтобы Заря оплатила» содержат
 * все слова поручения и ни одного его смысла. Такие фразы правила не берут:
 * ответит помощник или модель.
 */
const QUESTION = new RegExp(`^(?:что|как|чем|почему|зачем|когда|какой|какая|какие|можно\\s+ли|нужно\\s+ли|надо\\s+ли|кто|сколько|где|если|а\\s+если|вдруг|пока)${NA}`, 'iu');
const PARTICLE_LI = new RegExp(`(?:^|\\s)ли(?:\\s|$)`, 'u');
const HYPOTHETICAL = new RegExp(`${NB}(?:чтобы|если|вдруг|пусть|когда|пока|как\\s+только)${NA}`, 'iu');
const isQuestion = (t) => QUESTION.test(t) || PARTICLE_LI.test(t);
// «выставил», «выписана», «выставленный» — о сделанном, а не просьба
const PAST_CREATE = new RegExp(`${NB}(?:выстав|выпис|созда|оформ|сдела|сформир|состав|подготов)[а-яё]*(?:ил[аио]?|ал[аио]?|ен[аоы]?|енн[а-яё]+|анн[а-яё]+)${NA}`, 'iu');
const NEGATION_BEFORE = /(?:^|\s)(?:не|нельзя|ни)\s+(?:надо\s+|нужно\s+|стоит\s+|будем\s+|вздумай\s+)?$/iu;

/** Ссылки на чужие документы: «по договору 5», «по счёту № 105», «№ 12» — не деньги и не позиции. */
const REF_CLAUSE = new RegExp(`(?:${NB}(?:по|согласно|к|от|в\\s+рамках|на\\s+основании)\\s+(?:договор|сч[её]т|накладн|акт|поручени)[а-яё]*\\s*(?:№\\s*|номер\\s+)?\\d[\\w/-]*)|(?:№\\s*\\d[\\w/-]*)`, 'giu');

// ---------- НДС ----------

function takeVat(text) {
  let t = text;
  let vatRate;
  let incl = false;
  if (/(?:без\s*ндс|без\s*налога)/i.test(t)) {
    vatRate = null;
    t = t.replace(/(?:без\s*ндс|без\s*налога)/gi, ' ');
  } else {
    // «в т.ч. НДС 22» (признак ДО ставки) и «НДС 22 в том числе» (после) — одно и то же
    const m = /(?:(в\s*том\s*числе|в\s*т\.?\s*ч\.?)\s+)?(?:с\s+)?ндс\s*(\d+)\s*(?:%|процент[а-яё]*)?(?:\s*(сверху|в\s*том\s*числе|в\s*т\.?\s*ч\.?|цены\s*с\s*ндс))?/i.exec(t)
      || /(\d+)\s*(?:%|процент[а-яё]*)\s*ндс(?:\s*(сверху|в\s*том\s*числе|в\s*т\.?\s*ч\.?|цены\s*с\s*ндс))?/i.exec(t);
    if (m) {
      const second = m.length === 4;       // первая форма: три группы, вторая — две
      vatRate = Number(second ? m[2] : m[1]);
      const flag = second ? `${m[1] || ''} ${m[3] || ''}` : (m[2] || '');
      if (/в\s*том|в\s*т|цены/i.test(flag)) incl = true;
      t = t.replace(m[0], ' ');
    } else if (/(?:с\s+ндс|плюс\s+ндс)/i.test(t)) {
      t = t.replace(/(?:с\s+ндс|плюс\s+ндс)/gi, ' ');
    }
  }
  return { text: t, vatRate, incl };
}

// ---------- имя клиента ----------

const PREP_FRONT = /^(?:для|на\s+имя|в\s+адрес|на\s+клиента|на|в|к|с|со|по|у|от)\s+(?!\d)/iu;
const NAME_STOP = new Set(['на', 'за', 'по', 'с', 'со', 'без', 'ндс', 'в', 'при', 'для', 'из', 'от', 'до', 'и', 'а', 'но', 'то', 'что', 'как', 'мне',
  'сумму', 'сумма', 'итого', 'всего', 'вчера', 'сегодня']);
const ROLE_WORDS = /^(?:клиент[а-яё]*|контрагент[а-яё]*|покупател[а-яё]*|заказчик[а-яё]*|партн[её]р[а-яё]*|фирм[а-яё]*|компани[а-яё]*|организаци[а-яё]*)$/iu;

const cap = (s) => (s && /^[а-яё]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Откусить имя клиента от начала строки.
 * Известные клиенты человека — лучшая опора; без них — эвристика: форма
 * собственности и следующее слово либо одно слово.
 *
 * @returns {{who:string, rest:string}}
 */
function takeWho(str, clients) {
  let s = String(str || '').trim().replace(/^[,:;\s]+/, '');
  s = s.replace(PREP_FRONT, '');
  // «клиенту Заре» — роль не имя
  for (;;) {
    const m = /^(\S+)\s+(?=\S)/u.exec(s);
    if (m && ROLE_WORDS.test(m[1])) s = s.slice(m[0].length); else break;
  }
  if (!s || /^\d/.test(s)) return { who: '', rest: s };

  const hit = findClientMention(s, clients);
  if (hit) {
    // «ИП Сидорову», «ооо на дровах»: форма собственности перед названием — его часть
    const before = s.slice(0, hit.start).trim();
    if (!before || ORG.test(before)) return { who: cap(s.slice(0, hit.end).trim()), rest: s.slice(hit.end) };
  }

  const toks = [];
  const re = /«[^»]*»|"[^"]*"|[^\s,;:]+|[,;:]/gu;
  let m;
  while ((m = re.exec(s)) !== null) toks.push({ s: m[0], start: m.index, end: m.index + m[0].length });
  if (!toks.length) return { who: '', rest: s };
  const first = toks[0].s;
  if (NAME_STOP.has(norm(first)) || /^[,;:]$/.test(first)) return { who: '', rest: s };

  let end = 1;
  if (ORG.test(first)) {
    // форма собственности: дальше название, в кавычках или словами
    if (toks[1] && !/^[,;:]$/.test(toks[1].s)) {
      end = 2;
      const quoted = /^[«"]/.test(toks[1].s);
      // «ООО За Рулём»: название с заглавной продолжается заглавными словами
      while (!quoted && toks[end] && /^[А-ЯЁA-Z]/.test(toks[end].s) && !NAME_STOP.has(norm(toks[end].s))) end += 1;
      // «ИП Иванов Иван Иванович»: фамилия, имя, отчество
    }
  } else if (/^[А-ЯЁA-Z]/.test(first) && !/^[А-ЯЁ]+$/.test(first)) {
    // typed text: «Заре» — одно слово, но «Торговый дом Север» — все с большой буквы
    while (toks[end] && /^[А-ЯЁA-Z]/.test(toks[end].s) && !NAME_STOP.has(norm(toks[end].s)) && !/^[,;:]$/.test(toks[end].s)) end += 1;
  }
  const who = s.slice(toks[0].start, toks[end - 1].end);
  return { who: cap(who), rest: s.slice(toks[end - 1].end) };
}

function findWho(text, clients) {
  const hit = findClientMention(text, clients);
  if (hit) return { who: cap(hit.text), start: hit.start, end: hit.end };
  return null;
}

// ---------- выписка документа ----------

const DEFAULT_NAME = { torg12: 'Товар' };

// Что пишут после названия бумаги, но к клиенту и позициям не относится.
const DOC_TAIL = /^\s*(?:на\s+(?:оплату|предоплату|аванс)(?:\s+услуг)?|выполненн[а-яё]+\s+работ|оказанн[а-яё]+\s+услуг|об\s+оказании\s+услуг|на\s+оказание\s+услуг)/iu;

/**
 * @returns {Object|null}
 */
function draftFrom(ctx) {
  const raw = ctx.text;
  if (!raw || isQuestion(raw) || HYPOTHETICAL.test(raw) || PAST_CREATE.test(raw)) return null;
  const vat = takeVat(raw);
  let t = vat.text.replace(REF_CLAUSE, ' ').replace(/\s{2,}/g, ' ').trim();

  const dm = DOC_RE.exec(t);
  let verb = CREATE.exec(t);
  if (verb && NEGATION_BEFORE.test(t.slice(0, verb.index))) return null;
  const want = WANT.exec(t);
  const payVerb = verb && /^оплати/i.test(verb[0]);

  let docType = dm ? docKind(dm[1]) : '';
  if (payVerb && dm) docType = 'pp';
  let how = '';

  if (verb && !payVerb && (dm || /^выстав|^выпис|^выпиш/i.test(verb[0]))) how = 'verb';
  else if (payVerb && dm) how = 'verb';
  else if (want && dm) how = 'want';
  else if (dm && !VIEW.test(t)) how = 'bare';
  if (!how) return null;
  if (!docType) docType = 'sch';        // «выставь Заре 30000» — это счёт

  // Бытовые слова вокруг: «мне нужен», «надо бы», «хочу» — не имя.
  const MODAL = new RegExp(`${NB}(?:мне|нам|надо|нужно|нужен|нужна|необходимо|бы|ещё|еще|сейчас|срочно|новый|новую|новое|тогда|также|мой|ну|пожалуйста|можешь|можете|можно|хочу|хотел|хотела|хотим)${NA}`, 'giu');
  const clean = (s) => s.replace(MODAL, ' ').replace(CREATE, ' ').replace(/[,:;.]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  let who = '';
  let rest = '';
  let early = true;

  /*
   * Если среди клиентов человека есть названный во фразе — берём его откуда бы
   * он ни стоял и вырезаем вместе с предлогом перед ним: «счёт на 3 млн для
   * Меридиана», «акт на монтаж для севера сорок тысяч». Порядок слов в живой
   * речи свободный, а по списку клиентов видно, где имя начинается и
   * кончается; без списка остаётся угадывание по соседству с документом.
   */
  const mention = findClientMention(t, ctx.clients);
  if (mention) {
    // кавычки вокруг названия — часть имени фирмы: «ООО «Ромашка»»
    let mEnd = mention.end;
    if (/^[»"”]/.test(t.slice(mEnd))) mEnd += 1;
    const quoteOpen = /[«"“]\s*$/.exec(t.slice(0, mention.start));
    const mStart = quoteOpen ? mention.start - quoteOpen[0].length : mention.start;
    const head = t.slice(0, mStart);
    const org = /(?<![\p{L}\d])(?:ооо|оао|зао|пао|ао|ип|тоо)\s+$/iu.exec(head);
    const whoStart = org ? head.length - org[0].length : head.length;
    const prep = /(?<![\p{L}\d])(?:для|в\s+пользу|на\s+имя|клиенту|контрагенту|покупателю|компании|фирме|организации|с|со|к|у)\s+$/iu.exec(head.slice(0, whoStart));
    const cutStart = prep ? whoStart - prep[0].length : whoStart;
    who = cap(t.slice(whoStart, mEnd).trim());
    const t2 = `${t.slice(0, cutStart)} ${t.slice(mEnd)}`.replace(/\s{2,}/g, ' ');
    const dm2 = DOC_RE.exec(t2);
    let body = t2;
    if (dm2) {
      early = clean(t2.slice(0, dm2.index)).split(/\s+/).filter(Boolean).length <= 2;
      body = `${t2.slice(0, dm2.index)} ${t2.slice(dm2.index + dm2[0].length).replace(DOC_TAIL, ' ')}`;
    }
    // запятые остаются: по ним делятся позиции, а в «2,5» они — часть числа
    rest = body.replace(MODAL, ' ').replace(CREATE, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,:;.]+|[\s,:;.]+$/g, '');
  } else if (dm) {
    const pre = clean(t.slice(0, dm.index));
    // «счёт на оплату», «акт выполненных работ» — это название бумаги, а не имя и не позиция
    const post = t.slice(dm.index + dm[0].length).replace(DOC_TAIL, ' ');
    early = pre.split(/\s+/).filter(Boolean).length <= 2;
    if (pre) {
      const w = takeWho(pre, ctx.clients);
      who = w.who;
      rest = `${w.rest} ${post}`;
    } else {
      const w = takeWho(post, ctx.clients);
      who = w.who;
      rest = w.rest;
    }
  } else {
    // документ не назван: «надо бы выставить Заре за аренду 30000»
    const vi = verb ? verb.index + verb[0].length : (want ? want.index + want[0].length : 0);
    const w = takeWho(clean(t.slice(vi)), ctx.clients);
    who = w.who;
    rest = w.rest;
    // «выпиши рецепт» — не документ: без названной фирмы из списка и без суммы это не наша просьба
    if (!mention && !/\d/.test(rest)) return null;
    if (!who) return null;
  }

  // Фирма названа после суммы, а списка клиентов нет: «счёт на 3 млн для
  // Меридиана», «платёжка на 25 тысяч в пользу Севера».
  if (!who) {
    const m = /(?:^|\s)(?:для|в\s+пользу|на\s+имя|клиенту|контрагенту|покупателю)\s+(?=\S)/iu.exec(rest);
    if (m) {
      const w = takeWho(rest.slice(m.index + m[0].length), ctx.clients);
      if (w.who) { who = w.who; rest = `${rest.slice(0, m.index)} ${w.rest}`; }
    }
  }

  if (how === 'bare') {
    /*
     * Без глагола фразу выпиской считаем, только если она на неё похожа
     * целиком. Иначе «счёт 105 оплачен» или «акт был вчера» стали бы
     * документами. Доказательства два, хватит любого:
     *  — во фразе названа фирма из списка клиентов человека;
     *  — после имени стоит «на N»/«по N»: «акт горизонту на 20 тысяч».
     * И документ должен стоять в начале фразы, а не посреди рассказа.
     */
    const okMoney = /(?:^|\s)(?:на|по)\s+\d/iu.test(` ${rest}`);
    if (!who || !early || (!mention && !okMoney)) return null;
  }
  if (how === 'want' && (!who || (!mention && !/(?:^|\s)(?:на|по)\s+\d/iu.test(` ${rest}`)))) return null;

  const parsed = parseItems(rest.replace(/^[\s,:;]+/, ''), DEFAULT_NAME[docType] || 'Оказание услуг');
  const res = { action: 'draft', docType, who: who.replace(/[\s,]+$/, ''), items: parsed.items };
  if (vat.vatRate !== undefined) { res.vatRate = vat.vatRate; res.priceIncludesVat = vat.incl; }
  if (ctx.date) res.date = ctx.date;
  if (ctx.period) res.period = ctx.period;
  if (parsed.weak) res.weak = true;
  // Про налог что-то сказали, а разобрать не вышло («НДС сверху не нужен»):
  // решать за человека нельзя — пусть смотрит модель, а без неё остаётся вопрос.
  if (/ндс|налог/i.test(vat.text)) res.weak = true;
  return res;
}

// ---------- оплата ----------

const OWN_PAY = new RegExp(`${NB}я\\s+(?:уже\\s+|только\\s+что\\s+)?(?:оплатил[а]?|заплатил[а]?|перевёл|перевел[а]?|перечислил[а]?|отдал[а]?)${NA}`, 'iu');
const PAY_VERB = new RegExp(`${NB}(?:оплатил[аи]?|заплатил[аи]?|перечислил[аи]?|перев[её]л[аи]?|скинул[аи]?|закинул[аи]?|кинул[аи]?|отдал[аи]?|погасил[аи]?|рассчитал(?:ся|ась|ись)|закрыл[аи]?|вернул[аи]?|прислал[аи]?|внес(?:ла|ли)?|внёс|выплатил[аи]?|расплатил(?:ся|ась|ись)|упал[аои]|зачислил[аи]?|прилетел[аои]?)${NA}`, 'iu');
const PAY_CMD = new RegExp(`${NB}(?:провед[а-яё]*|внес[а-яё]*|отмет[а-яё]*|запиш[а-яё]*|зафиксир[а-яё]*|проставь|добав[а-яё]*)\\s+(?:что\\s+)?(?:(?:мне|ещё|еще)\\s+)?(?:оплат[а-яё]*|приход[а-яё]*|плат[её]ж[а-яё]*|деньги|аванс[а-яё]*|предоплат[а-яё]*|поступлени[а-яё]*)`, 'iu');
const PAY_NOUN = new RegExp(`${NB}оплат[ауы]\\s+.{0,40}?(?:сделал[аи]?|провел[аи]?|произвел[аи]?|отправил[аи]?|прислал[аи]?)${NA}|^(?:оплата|предоплата|аванс|плат[её]ж|поступлени[а-яё]*)${NA}(?=.*(?:\\d|\\sот\\s))|${NB}(?:поступил[аио]?|пришл[ао]|получил[аи]?)${NA}|${NB}деньги\\s+.{0,30}?(?:пришли|поступили|упали)${NA}|${NB}пришли\\s+(?:деньги|средства|плат[её]ж[а-яё]*|оплат[а-яё]*)`, 'iu');
const SHIP_VERB = new RegExp(`${NB}(?:отгрузил[аи]?|поставил[аи]?|продал[аи]?|реализовал[аи]?)${NA}`, 'iu');
const PAY_ASK = /(?:подписк|тариф|бота|доступ)/i;

function payFrom(ctx) {
  const t0 = ctx.text;
  if (!t0 || isQuestion(t0) || PAY_ASK.test(t0) || HYPOTHETICAL.test(t0)) return null;
  if (OWN_PAY.test(t0)) return { action: 'unknown', reason: 'own-payment' };
  const t = t0.replace(REF_CLAUSE, ' ').replace(/\s{2,}/g, ' ').trim();
  const verb = PAY_VERB.exec(t);
  const cmd = PAY_CMD.exec(t);
  const noun = PAY_NOUN.exec(t);
  // «оплатить», «оплати» — приказ платить самому, это платёжка, а не приход
  const ship = SHIP_VERB.exec(t);
  if (!verb && !cmd && !noun && !ship) return null;
  // «кто не рассчитался» — не оплата, а вопрос о долгах
  if (verb && /(?:^|\s)не\s+(?:\S+\s+)?$/iu.test(t.slice(0, verb.index))) return null;
  // «выставь счёт Заре, она оплатит» — просьба о выписке; оплату вносят в прошедшем времени
  if (!cmd && CREATE.test(t) && DOC_RE.test(t) && !verb) return null;

  // сумма: «20 тысяч из ста» — оплачено двадцать, а не сто
  const forAmount = t.replace(/(?:^|\s)из\s+\d[\d.,]*/giu, ' ');
  const amount = amountFrom(forAmount);

  // кто платил
  let who = '';
  const mention = findClientMention(t, ctx.clients);
  if (mention) who = cap(mention.text);
  else {
    const pre = (m) => t.slice(0, m.index).replace(/[,:;]+/g, ' ').trim();
    const tail = (re) => { const m = re.exec(t); return m ? takeWho(t.slice(m.index + m[0].length), ctx.clients).who : ''; };
    who = tail(new RegExp(`${NB}(?:от|по|у)\\s+(?!сч[её]т|договор|накладн|акт|поручени)(?=${L})`, 'iu'));
    if (!who && (verb || ship)) {
      // подлежащее перед глаголом: «ромашка оплатила», «ИП Сидоров перевёл»
      const words = pre(verb || ship).split(/\s+/).filter((w) => w && !NAME_STOP.has(norm(w)) && !ROLE_WORDS.test(w) && !/^\d/.test(w)
        && !/^(?:что|вчера|сегодня|уже|тоже|опять|снова|он[аи]?|они|мне|нам)$/iu.test(w));
      if (words.length) {
        const last = words.slice(-1)[0];
        const prev = words.slice(-2)[0];
        who = cap(words.length > 1 && ORG.test(prev) ? `${prev} ${last}` : last);
      }
    }
  }
  const res = { action: 'pay', who, amount, kind: 'Оплата' };
  // «Приход» — отгрузка в долг, деньги наоборот уходят в долг клиента. Слово «платёж»
  // в проверке не участвует: оно прячется в фамилиях («Платёжкин»).
  if (/(?<![\p{L}])(?:приход|поставк|отгруз|реализац|оказал|продал)/iu.test(t) && !/(?<![\p{L}])(?:оплат|заплат)/iu.test(t)) res.kind = 'Приход';
  else if (ship && !verb) res.kind = 'Приход';
  if (/аванс|предоплат/i.test(t)) res.prepay = true;
  if (ctx.date) res.date = ctx.date;
  return res;
}

// ---------- акт сверки, журнал, напоминание, повтор ----------

const AKT = new RegExp(`${NB}(?:акт[а-яё]*\\s+сверк[а-яё]*|сверк[а-яё]*|сверь[а-яё]*|сверим[а-яё]*|сверит[а-яё]*)${NA}`, 'iu');

function aktFrom(ctx) {
  if (!AKT.test(ctx.text) || isQuestion(ctx.text)) return null;
  const res = { action: 'akt' };
  const w = findWho(ctx.text, ctx.clients) || heurWho(ctx.text, AKT);
  if (w) res.who = w.who;
  if (ctx.period) res.period = ctx.period;
  else if (ctx.date) res.period = { from: ctx.date, to: ctx.date };
  return res;
}

/** Имя после предлога, когда списка клиентов нет: «с зарёй», «по ромашке». */
function heurWho(text, skipRe) {
  const t = text.replace(skipRe, ' ');
  const m = new RegExp(`${NB}(?:с|со|по|для|от|у|к)\\s+(?!сч[её]т|договор|накладн|акт|\\d|прошл|эт[ио]|текущ|квартал|месяц|год|начала)(${L}[^\\s,;:]*(?:\\s+[А-ЯЁA-Z][^\\s,;:]*)*)`, 'iu').exec(t);
  if (!m) return null;
  const w = takeWho(m[1], []);
  return w.who ? { who: w.who } : null;
}

const REMIND = new RegExp(`${NB}(?:напомн[а-яё]*|пни|дожм[а-яё]*|подтолкн[а-яё]*|поторопи[а-яё]*|отправ[а-яё]*\\s+напоминани[а-яё]*)${NA}|${NB}напиш[а-яё]*\\s+[^.]{0,40}?(?:пора\\s+плат|про\\s+долг|об\\s+оплат)`, 'iu');

function remindFrom(ctx) {
  const t = ctx.text;
  if (!REMIND.test(t) || isQuestion(t)) return null;
  // «напомни мне позвонить» — просьба напомнить самому себе, клиента тут нет
  if (/напомн[а-яё]*\s+(?:мне|нам|через|завтра|в\s+\d)/iu.test(t)) return null;
  const res = { action: 'remind' };
  const w = findWho(t, ctx.clients) || (() => {
    const m = new RegExp(`${NB}(?:напомн[а-яё]*|пни|дожм[а-яё]*|подтолкн[а-яё]*|поторопи[а-яё]*|напомнить|напиш[а-яё]*|отправ[а-яё]*\\s+напоминани[а-яё]*)\\s+(?:(?:о|об|про|по|за)\\s+)?(?!долг|оплат|сч[её]т)(${L}[^\\s,;:]*)`, 'iu').exec(t);
    return m ? { who: cap(m[1]) } : null;
  })();
  if (w) res.who = w.who;
  const dm = DOC_RE.exec(t);
  if (dm) res.docType = docKind(dm[1]);
  return res;
}

const RECURRING = new RegExp(`${NB}(?:кажд(?:ый|ую|ое|ые)\\s+(?:месяц|недел[юи]|день|квартал|год)|ежемесячн[а-яё]*|еженедельн[а-яё]*|ежедневн[а-яё]*|раз\\s+в\\s+(?:месяц|недел[юи]|квартал)|по\\s+расписанию|регулярн[а-яё]*|повторя[а-яё]*|по\\s+перв(?:ым|ому)\\s+числ[а-яё]*)${NA}`, 'iu');
const REPEAT = new RegExp(`${NB}(?:повтор[а-яё]*|продублир[а-яё]*|скопиру[а-яё]*|сдела[а-яё]*\\s+так(?:ой|ую|ое|ие)\\s+же|выстав[а-яё]*\\s+ещ[её]\\s+раз|ещ[её]\\s+(?:одну|один|одно)\\s+так[а-яё]+|как\\s+вчера|как\\s+в\\s+прошлый\\s+раз|сдела[а-яё]*\\s+как(?=\\s|$))`, 'iu');

function repeatFrom(ctx) {
  const t = ctx.text;
  if (RECURRING.test(t) || !REPEAT.test(t) || isQuestion(t)) return null;
  const res = { action: 'repeat' };
  const dm = DOC_RE.exec(t);
  if (dm) res.docType = docKind(dm[1]);
  const w = findWho(t, ctx.clients);
  if (w) res.who = w.who;
  else {
    const m = new RegExp(`${NB}(?:для|как|клиенту)\\s+(${L}[^\\s,;:]*)`, 'iu').exec(t);
    if (m && !/^(?:вчера|прошл|такой|этот)/iu.test(m[1])) res.who = cap(m[1]);
    else {
      // «повтори последний счёт ромашке», «продублируй акт сидорову»: имя после документа
      const h = dm ? takeWho(t.slice(dm.index + dm[0].length).replace(/^\s*(?:за\s+\S+)?/u, ''), ctx.clients) : null;
      if (h && h.who && !NAME_STOP.has(norm(h.who))) res.who = h.who;
    }
  }
  if (ctx.date) res.date = ctx.date;
  return res;
}

function recurringWho(ctx) {
  const w = findWho(ctx.text, ctx.clients);
  return w ? w.who : '';
}

module.exports = {
  draftFrom, payFrom, aktFrom, remindFrom, repeatFrom, recurringWho, takeWho, findWho,
  RECURRING, REPEAT, REMIND, AKT, DOC_RE, docKind,
};
