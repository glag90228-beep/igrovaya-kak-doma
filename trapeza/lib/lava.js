'use strict';

/**
 * Приём оплат с Lava Top.
 *
 * ЧЕСТНО О ГЛАВНОМ: точный формат вебхука Lava здесь не зашит намертво.
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
  custom: ['clientUtm', 'client_utm', 'utm', 'customParam', 'custom_param', 'custom',
    'comment', 'buyerParam', 'clientId', 'client_id', 'externalUserId', 'metadata.tg',
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

/** Из произвольного значения достаём Telegram-id, если он там есть. */
function tgIdFrom(value) {
  const m = /(\d{5,15})/.exec(String(value == null ? '' : value));
  return m ? Number(m[1]) : null;
}

/** Статусы, при которых доступ выдаётся. Всё остальное — просто запись. */
const PAID = /^(paid|success|successful|completed|complete|subscription-recurring-payment-success|payment\.success|payment_success)$/i;

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

  const externalId = first(src, FIELDS.externalId);
  const amount = money(first(src, FIELDS.amount));
  const status = String(first(src, FIELDS.status) || '').trim();

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
      status,
      product: String(first(src, FIELDS.product) || ''),
      tgId: tgIdFrom(custom),
      paid: PAID.test(status) || (!status && amount > 0),
      raw: body,
    },
  };
}

/** Сколько дней даёт этот платёж. По умолчанию месяц; можно задать картой сумм. */
function daysFor(payment) {
  const map = String(process.env.LAVA_PLAN_DAYS || '').trim(); // «349:30,3490:365»
  if (map) {
    for (const pair of map.split(',')) {
      const [sum, days] = pair.split(':').map((x) => Number(String(x).trim()));
      if (Number.isFinite(sum) && Math.abs(sum - payment.amount) < 0.01) return days;
    }
  }
  return Number(process.env.LAVA_DEFAULT_DAYS || 30);
}

/** Сверка секрета: сравнение постоянного времени, чтобы не подбирался побайтно. */
function secretOk(given) {
  const want = process.env.LAVA_WEBHOOK_SECRET || '';
  if (!want) return false;
  const a = Buffer.from(String(given || ''));
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

module.exports = { parseWebhook, daysFor, secretOk, payLink, tgIdFrom, FIELDS };
