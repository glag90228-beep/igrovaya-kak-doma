'use strict';

/**
 * Приём оплат с Lava Top.
 *
 * Формат сверен с официальным SDK lava-top-sdk (август 2026): тело плоское,
 * ключевые поля — eventType, contractId, buyer.email, amount, currency,
 * product.title. Разбор оставлен терпимым к именам на случай смены версии.
 * Разные площадки (и разные версии одной площадки) называют поля по-разному,
 * а гадать в коде, который выдаёт платный доступ, — плохая идея. Поэтому
 * разбор устроен так:
 *
 *   • ищем значение по списку вероятных имён полей, в том числе вложенных;
 *   • если не нашли идентификатор платежа или сумму — НЕ выдаём доступ,
 *     а сохраняем письмо целиком и говорим об этом в логе;
 *   • по первому настоящему вебхуку правится один массив имён ниже.
 *
 * Привязка платежа к пользователю — двумя путями:
 *   1) в ссылку на оплату подставляется параметр с Telegram-id (LAVA_PARAM),
 *      площадка возвращает его в вебхуке;
 *   2) если не вернула — платёж остаётся «ничей», и пользователь забирает
 *      его в боте, введя почту, указанную на кассе.
 */

const crypto = require('node:crypto');

// Имена полей, под которыми встречаются нужные значения.
const FIELDS = {
  externalId: ['id', 'invoiceId', 'invoice_id', 'orderId', 'order_id', 'paymentId', 'payment_id', 'uuid', 'contractId'],
  email: ['email', 'buyerEmail', 'buyer_email', 'clientEmail', 'client_email', 'buyer.email', 'client.email'],
  amount: ['amount', 'sum', 'total', 'price', 'amountTotal', 'payment.amount'],
  currency: ['currency', 'currencyCode', 'currency_code'],
  status: ['status', 'state', 'eventType', 'event_type', 'event', 'type'],
  product: ['productId', 'product_id', 'offerId', 'offer_id', 'productTitle', 'product.title', 'offer.name'],
  /*
   * Поля, куда площадка кладёт наш собственный параметр из ссылки на оплату.
   * «comment» отсюда убран намеренно: это свободный текст, который пишет сам
   * плательщик. Из «оплата по счёту 1234567890» доставался номер счёта, и
   * платёж привязывался к постороннему Telegram-id — навсегда, потому что
   * забрать его по почте после этого уже нельзя (ищем только ничьи).
   */
  custom: ['clientUtm', 'client_utm', 'utm', 'customParam', 'custom_param', 'custom',
    'buyerParam', 'externalUserId', 'metadata.tg',
    'parameters.tg', 'additionalFields.tg'],
};

/** Достаёт значение по пути «a.b.c» или по простому ключу, без учёта регистра. */
function pick(obj, name) {
  const parts = String(name).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    const key = Object.keys(cur).find((k) => k.toLowerCase() === part.toLowerCase());
    if (key === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

function first(obj, names) {
  for (const n of names) {
    const v = pick(obj, n);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

const money = (v) => {
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/**
 * Из значения нашего параметра достаём Telegram-id.
 *
 * Берём только то, что параметром и является: голое число либо «tg=123»,
 * «tgid:123», «tg_id 123». Число, вырванное из середины произвольной фразы,
 * не берём — цена ошибки здесь несимметрична: чужой id закрывает
 * настоящему плательщику единственный запасной путь «Я оплатил + почта».
 */
function tgIdFrom(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  const m = /^(?:tg[_-]?id|tg|id)?\s*[:=]?\s*(\d{5,15})$/i.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * Момент платежа в одном виде, каким бы его ни прислали.
 *
 * Площадки шлют время то строкой ISO, то unix-секундами, то миллисекундами,
 * то с местным смещением. Раньше мы просто отрезали первые десять символов —
 * и «2026-08-22T23:30:00Z» с «2026-08-23T02:30:00+03:00» (это один и тот же
 * момент) выглядели разными платежами, а два unix-числа подряд — тоже
 * разными, потому что отрезались до одинакового куска не всегда.
 *
 * @returns {string|null} момент с точностью до секунды или null, если не разобрали
 */
function stampOf(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  const ms = /^\d{9,14}$/.test(s) ? Number(s) * (s.length > 11 ? 1 : 1000) : Date.parse(s);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 19)}Z` : null;
}

/**
 * Оплачен ли платёж. У Lava Top решает eventType: «payment.success» и
 * «subscription.recurring.payment.success» — доступ выдаём; «...failed»,
 * «cancelled», «refund» — нет. Запасной вариант (мок, чужой формат) —
 * по слову success/completed в статусе или, если статуса нет, по сумме.
 */
function isPaid(eventType, status, amount) {
  const et = String(eventType || '');
  const st = String(status || '');
  if (/fail|cancel|refund|error|decline/i.test(et) || /fail|cancel|refund|decline/i.test(st)) return false;
  if (/success|completed|paid|active/i.test(et)) return true;
  if (!et && /success|completed|paid|active/i.test(st)) return true;
  return !et && !st && Number(amount) > 0;
}

/**
 * Разбирает тело вебхука.
 * @returns {{ok:boolean, reason?:string, payment?:object}}
 */
function parseWebhook(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'пустое тело' };
  // некоторые площадки заворачивают полезное в data/payload/object
  const box = ['data', 'payload', 'object', 'result'].map((k) => pick(body, k))
    .find((v) => v && typeof v === 'object');
  const src = box ? { ...body, ...box } : body;

  const amount = money(first(src, FIELDS.amount));
  // eventType — главный признак у Lava; status держим отдельно для лога.
  const eventType = String(first(src, ['eventType', 'event_type', 'event', 'type']) || '').trim();
  const statusField = String(first(src, ['status', 'state']) || '').trim();

  /*
   * Ключ платежа. У разового платежа это его собственный id, и всё просто.
   * У подписки с ежемесячным списанием сложнее: если площадка присылает
   * только contractId — а он у всех списаний по одному договору один и тот
   * же, — второй месяц выглядел бы повтором первого. Оплату записали бы,
   * доступ не продлили, и человек, честно заплативший, остался бы ни с чем.
   *
   * Поэтому, когда собственного идентификатора нет, ключ собираем из
   * договора и всего, чем одно событие по нему отличается от другого:
   * момента, статуса и суммы. Так повторная доставка того же вебхука
   * (площадки шлют их по нескольку раз) остаётся повтором, а вот эти три
   * случая — уже нет:
   *
   *   • отказ и удачная оплата по одному договору в один день. Раньше
   *     ключом был договор плюс дата, отказ записывался первым и занимал
   *     место, а оплата через пять минут отбрасывалась как повтор —
   *     заплативший человек оставался без доступа;
   *   • два списания в один день на разные суммы (месяц, потом год) —
   *     второе терялось целиком;
   *   • время без ISO-строки: unix-число или местное смещение через
   *     полночь. Их приводит к одному виду stampOf.
   *
   * Времени может не быть вовсе — тогда берём отпечаток самого тела.
   * Он одинаков у всех доставок одного события и не зависит от того,
   * когда мы его приняли: подставлять сюда текущую дату нельзя, иначе
   * каждая повторная доставка становилась бы новым платежом и продлевала
   * доступ ещё раз.
   */
  const ownId = first(src, FIELDS.externalId.filter((k) => k !== 'contractId'));
  const contractId = first(src, ['contractId', 'contract_id']);
  const stamp = stampOf(first(src, ['timestamp', 'createdAt', 'created_at', 'date', 'paidAt']))
    || `body-${crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)}`;
  const mark = [stamp, eventType || statusField || '-', amount == null ? '-' : amount].join('/');
  const externalId = ownId || (contractId ? `${contractId}:${mark}` : null);

  if (!externalId) return { ok: false, reason: 'не нашёл идентификатор платежа' };
  if (amount == null) return { ok: false, reason: 'не нашёл сумму' };

  const custom = first(src, FIELDS.custom);
  return {
    ok: true,
    payment: {
      externalId: String(externalId),
      email: String(first(src, FIELDS.email) || '').trim().toLowerCase(),
      amount,
      currency: String(first(src, FIELDS.currency) || 'RUB').toUpperCase(),
      status: eventType || statusField,
      product: String(first(src, FIELDS.product) || ''),
      tgId: tgIdFrom(custom),
      paid: isPaid(eventType, statusField, amount),
      raw: body,
    },
  };
}

/**
 * Тарифы: сумма платежа → сколько дней доступа. Из LAVA_PLAN_DAYS.
 *
 * Один список на всё: и срок при оплате, и цена, которую показываем человеку.
 * Раньше цену не показывали нигде, а список жил сам по себе — и при смене
 * цены он оставался старым. Платёж на новую сумму не совпадал ни с одной
 * строкой, срок брался запасной (месяц), и оплативший год получал месяц.
 * Молча, на первой же годовой покупке.
 */
function plans() {
  return String(process.env.LAVA_PLAN_DAYS || '').trim().split(',')
    .map((pair) => {
      const [sum, days] = pair.split(':').map((x) => Number(String(x).trim()));
      return { amount: sum, days };
    })
    .filter((p) => Number.isFinite(p.amount) && Number.isFinite(p.days) && p.days > 0)
    .sort((a, b) => a.days - b.days);
}

/** Сколько дней даёт этот платёж. По умолчанию месяц; можно задать картой сумм. */
function daysFor(payment) {
  for (const p of plans()) {
    if (Math.abs(p.amount - payment.amount) < 0.01) return p.days;
  }
  return Number(process.env.LAVA_DEFAULT_DAYS || 30);
}

/**
 * Цена словами: «390 ₽ в месяц или 2990 ₽ в год».
 * Пусто, если тарифы не заданы — выдумывать цену нельзя.
 */
/** Как называется срок: «в месяц», «в год». Одно на бота и приложение. */
function planLabel(days) {
  if (days >= 350) return 'в год';
  if (days >= 175) return 'за полгода';
  if (days >= 80) return 'за квартал';
  return 'в месяц';
}

/** То же, но заголовком строки в списке тарифов: «Месяц», «Год». */
function planTitle(days) {
  if (days >= 350) return 'Год';
  if (days >= 175) return 'Полгода';
  if (days >= 80) return 'Квартал';
  return 'Месяц';
}

function priceText() {
  const parts = plans().map((p) => `${p.amount} ₽ ${planLabel(p.days)}`);
  if (!parts.length) return '';
  return parts.join(' или ');
}

/** Сколько экономит длинный тариф против помесячного, в рублях за год. */
function yearSaving() {
  const list = plans();
  const month = list.find((p) => p.days >= 28 && p.days <= 31);
  const year = list.find((p) => p.days >= 350);
  if (!month || !year) return 0;
  return Math.round(month.amount * 12 - year.amount);
}

/**
 * Сверка секрета: сравнение постоянного времени, чтобы не подбирался побайтно.
 *
 * Края обрезаем с обеих сторон. Опасность не в том, что лишний пробел пришлёт
 * площадка, — а в том, что он окажется в нашем собственном ключе: висящий \n
 * в .env, в EnvironmentFile= у systemd или при копировании из чата — самое
 * обычное дело. Тогда правильный ключ от Lava отвергался бы вечно, платежи не
 * доходили, а в журнале лежала бы совершенно правдоподобная строка «неверный
 * секрет». Пробелы по краям ключа не несут смысла ни у одной площадки, зато
 * стоят потерянных денег.
 */
function secretOk(given) {
  const want = String(process.env.LAVA_WEBHOOK_SECRET || '').trim();
  if (!want) return false;
  const a = Buffer.from(String(given == null ? '' : given).trim());
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Ссылка на оплату с подставленным Telegram-id. */
function payLink(tgId) {
  const base = process.env.LAVA_OFFER_URL || '';
  if (!base) return '';
  const param = process.env.LAVA_PARAM || 'clientUtm';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${encodeURIComponent(param)}=${encodeURIComponent(String(tgId))}`;
}

module.exports = {
  plans, priceText, planTitle, planLabel, yearSaving,
  parseWebhook, daysFor, secretOk, payLink, tgIdFrom, stampOf, FIELDS };
