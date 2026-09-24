'use strict';

/**
 * Платёжный шлюз Platega.io (СБП по QR-коду, карты РФ/МИР, международный эквайринг).
 *
 * Официальная документация API: https://platega-io.gitbook.io/platega.io-api-dokumentaciya
 * Личный кабинет мерчанта: https://my.platega.io
 *
 * ── Что подтверждено живым платежом (15.09.2026) ──
 *
 * Форма ответа была написана по общей документации; первый настоящий платёж
 * её подтвердил и уточнил:
 *
 *   • вебхук приходит POST на путь из поля Callback URL в кабинете;
 *   • заголовки X-MerchantId и X-Secret — те же, что мы шлём в запросах;
 *   • поля ответа: id, amount, currency, status, paymentMethod, payload;
 *   • статус успешной оплаты — CONFIRMED;
 *   • paymentMethod: 2 — это СБП (мы его и просим при создании);
 *   • payload возвращается ДОСЛОВНО, строкой. На нём и держится привязка
 *     платежа к человеку и к выбранному тарифу.
 *
 * И главное, чего в документации не найти: amount приходит ЗА ВЫЧЕТОМ
 * комиссии площадки. За платёж в 390 ₽ пришло 378,67. Поэтому опознавать по
 * нему тариф нельзя — см. daysFor.
 *
 * Переменные окружения:
 *   PLATEGA_MERCHANT_ID — UUID мерчанта из раздела настроек Platega;
 *   PLATEGA_SECRET      — секретный API-ключ (Secret);
 *   PLATEGA_API_URL     — базовый URL API (по умолчанию https://app.platega.io);
 *   PLATEGA_PLAN_DAYS   — тарифная сетка «сумма:дни», например «349:30,3490:365»;
 *   PLATEGA_DEFAULT_DAYS— срок по умолчанию (30 дней).
 */

const crypto = require('node:crypto');

const API_BASE = () => (process.env.PLATEGA_API_URL || 'https://app.platega.io').replace(/\/+$/, '');
const MERCHANT_ID = () => String(process.env.PLATEGA_MERCHANT_ID || '').trim();
const SECRET = () => String(process.env.PLATEGA_SECRET || '').trim();

/** Настроен ли платёжный шлюз (заданы ли обязательные ключи). */
function isConfigured() {
  return Boolean(MERCHANT_ID() && SECRET());
}

/**
 * Тарифы: сумма платежа → сколько дней доступа.
 * Считывается из PLATEGA_PLAN_DAYS или LAVA_PLAN_DAYS (если настроена общая),
 * иначе — цены, которые утвердил владелец: 390 ₽ за 30 дней, 2 990 ₽ за год.
 *
 * Запасная сетка раньше была 349/3490 — цены, от которых отказались. Пока в
 * .env стояла своя, это было незаметно; но оферта и тарифы на сайте
 * переписали именно эти старые числа, и человек видел в оферте одну цену, а
 * платил другую.
 */
const DEFAULT_PLANS = '390:30,2990:365';

function plans() {
  const raw = process.env.PLATEGA_PLAN_DAYS || process.env.LAVA_PLAN_DAYS || DEFAULT_PLANS;
  return String(raw).trim().split(',')
    .map((pair) => {
      const [sum, days] = pair.split(':').map((x) => Number(String(x).trim()));
      return { amount: sum, days };
    })
    .filter((p) => Number.isFinite(p.amount) && Number.isFinite(p.days) && p.days > 0)
    .sort((a, b) => a.days - b.days);
}

/**
 * Сколько дней даёт этот платёж.
 *
 * Порядок важен, и первый шаг — главный.
 *
 * Раньше дни определялись ТОЛЬКО по сумме из вебхука, и это оказалось
 * неверно вдвойне. Во-первых, площадка сообщает сумму ЗА ВЫЧЕТОМ своей
 * комиссии: за платёж в 390 ₽ приходит 378,67 — в сетке такой суммы нет, и
 * поиск не находил ничего. Во-вторых, цены в кнопках бота (349 и 3490)
 * разошлись с сеткой в .env (390 и 2990), так что не совпало бы и без
 * комиссии.
 *
 * Обе ошибки складывались в одну тихую: ЛЮБОЙ платёж проваливался в
 * умолчание, а умолчание — 30 дней. Месячная подписка случайно работала
 * правильно, а годовая давала месяц. Человек платит за год и получает
 * тридцать дней; узнаём мы об этом от него, а не от кода.
 *
 * Поэтому считаем по тому, что человек ВЫБРАЛ, а не по тому, сколько нам
 * зачислили: срок кладётся в payload при создании платежа и возвращается
 * оттуда же.
 */
function daysFor(payment) {
  // 1. Срок, выбранный человеком. Мы сами его туда положили при создании.
  const fromPayload = Number((payment && payment.days) || 0);
  if (Number.isFinite(fromPayload) && fromPayload > 0) return Math.round(fromPayload);

  /*
   * 2. Платёж без payload — начатый по прямой ссылке, а не кнопкой в боте.
   *
   * Ищем по сумме, но с допуском на комиссию: зачисленное всегда МЕНЬШЕ
   * заплаченного, поэтому подходит ближайший тариф, который не ниже
   * пришедшей суммы и отстоит от неё не больше чем на MAX_FEE. Точное
   * сравнение тут бессмысленно — оно и не работало.
   */
  const amt = Number((payment && payment.amount) || 0);
  if (amt > 0) {
    const maxFee = Number(process.env.PLATEGA_MAX_FEE || 0.15);
    const fit = plans()
      .filter((p) => p.amount >= amt - 0.01 && (p.amount - amt) <= p.amount * maxFee)
      .sort((a, b) => a.amount - b.amount)[0];
    if (fit) return fit.days;
  }

  return Number(process.env.PLATEGA_DEFAULT_DAYS || process.env.LAVA_DEFAULT_DAYS || 30);
}

function planLabel(days) {
  if (days >= 350) return 'в год';
  if (days >= 175) return 'за полгода';
  if (days >= 80) return 'за квартал';
  return 'в месяц';
}

/**
 * Тариф по имени: «month» или «year».
 *
 * Цену и срок берём из сетки, а не из числа в коде. Разошлись они уже
 * однажды: кнопки предлагали 349 и 3490, сетка знала 390 и 2990, и ни один
 * платёж в неё не попадал. Одно место — одна правда.
 */
function planByName(name) {
  const list = plans();
  if (!list.length) return null;
  const wantYear = String(name || '').toLowerCase().startsWith('year');
  const year = list.filter((p) => p.days >= 300).sort((a, b) => a.days - b.days)[0];
  const month = list.filter((p) => p.days < 300).sort((a, b) => a.days - b.days)[0];
  /*
   * Нет такого тарифа — значит нет, а не «какой-нибудь».
   *
   * Раньше здесь стоял запасной list[0]: без годового тарифа в сетке кнопка
   * «Год» создавала платёж на месячную сумму, человек платил и получал
   * тридцать дней. Теперь кнопку года показывают, только если год есть.
   */
  return (wantYear ? year : month) || null;
}

/**
 * Цифры для страниц сайта: месяц, год, выгода, год в пересчёте на месяц.
 *
 * Отдельной функцией, потому что эти же числа печатаются в трёх местах —
 * на главной, в тарифах и в оферте — и считаются из одной сетки. Ручной
 * пересчёт уже подвёл: при смене цен «выгода 700 ₽» и «2 месяца в подарок»
 * остались от старых.
 */
function priceFacts() {
  const m = planByName('month');
  const y = planByName('year');
  if (!m || !y) return null;
  return {
    month: m.amount,
    year: y.amount,
    save: Math.max(0, Math.round(m.amount * 12 - y.amount)),
    permonth: Math.round(y.amount / 12),
  };
}

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

/** Сравнение строк постоянного времени (timing-safe). */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a == null ? '' : a).trim());
  const bufB = Buffer.from(String(b == null ? '' : b).trim());
  if (bufA.length === 0 || bufB.length === 0) return false;
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Проверка аутентичности входящего запроса от Platega.io.
 * Мерчант передаёт X-MerchantId и X-Secret в заголовках вебхука.
 */
function secretOk(givenMerchantId, givenSecret) {
  const wantMerchant = MERCHANT_ID();
  const wantSecret = SECRET();
  if (!wantMerchant || !wantSecret) return false;

  const mOk = safeEqual(givenMerchantId, wantMerchant);
  const sOk = safeEqual(givenSecret, wantSecret);
  return mOk && sOk;
}

/**
 * Парсинг полезной нагрузки (payload) из транзакции или вебхука.
 * Возвращает объект с userId, tgId, plan и т.д.
 */
function parsePayload(rawPayload) {
  if (!rawPayload) return {};
  if (typeof rawPayload === 'object') return rawPayload;
  try {
    return JSON.parse(String(rawPayload));
  } catch (_) {
    const res = {};
    const parts = String(rawPayload).split(/[,;&]+/);
    for (const part of parts) {
      const [k, v] = part.split(/[:=]/).map((s) => s.trim());
      if (k && v) res[k] = v;
    }
    return res;
  }
}

/**
 * Разбор входящего callback-вебхука от Platega.io.
 */
function parseWebhook(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'тело не объект' };
  }

  const externalId = body.id || body.transactionId || body.orderId;
  if (!externalId) {
    return { ok: false, reason: 'нет идентификатора платежа (id)' };
  }

  const amount = Number(String(body.amount != null ? body.amount : (body.paymentDetails && body.paymentDetails.amount)).replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'некорректная сумма' };
  }

  const currency = String(body.currency || (body.paymentDetails && body.paymentDetails.currency) || 'RUB').toUpperCase();
  const status = String(body.status || '').toUpperCase();
  const paid = status === 'CONFIRMED';

  const payload = parsePayload(body.payload);
  const userId = Number(payload.userId || payload.user_id || payload.uid) || 0;
  const tgId = Number(payload.tgId || payload.tg_id || payload.tg) || 0;
  const days = Number(payload.days) || 0;
  const email = String(payload.email || body.email || '').trim().toLowerCase();

  return {
    ok: true,
    payment: {
      externalId: String(externalId),
      amount: Math.round(amount * 100) / 100,
      currency,
      status,
      paid,
      userId,
      tgId,
      days,
      email,
      paymentMethod: body.paymentMethod != null ? Number(body.paymentMethod) : null,
      raw: JSON.stringify(body),
    },
  };
}

/**
 * Создание платёжной транзакции через REST API Platega.
 */
async function createTransaction(opts = {}) {
  const merchantId = MERCHANT_ID();
  const secret = SECRET();

  if (!merchantId || !secret) {
    return { ok: false, error: 'Platega не настроена (отсутствует PLATEGA_MERCHANT_ID или PLATEGA_SECRET)' };
  }

  const amount = Number(opts.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Некорректная сумма платежа' };
  }

  const id = opts.transactionId || (crypto.randomUUID ? crypto.randomUUID() : `plt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const payloadData = {
    userId: opts.userId || 0,
    tgId: opts.tgId || 0,
    plan: opts.plan || 'subscription',
    // Срок кладём здесь, а не выводим потом из зачисленной суммы: площадка
    // сообщает её за вычетом комиссии, и по ней тариф не опознать.
    days: Number(opts.days) || 0,
    ts: Date.now(),
  };

  const bodyData = {
    paymentMethod: opts.paymentMethod !== undefined ? opts.paymentMethod : 2, // по умолчанию СБП QR
    id,
    paymentDetails: {
      amount: Math.round(amount * 100) / 100,
      currency: 'RUB',
    },
    description: opts.description || `Подписка Первичка (${amount} ₽)`,
    return: opts.returnUrl || 'https://t.me/pervichka_app_bot?start=pay_success',
    failedUrl: opts.failedUrl || 'https://t.me/pervichka_app_bot?start=pay_failed',
    payload: JSON.stringify(payloadData),
  };

  const url = `${API_BASE()}/transaction/process`;
  try {
    const res = await fetch(url, {
      // Без таймаута замолчавшая площадка вешала «Оплатить СБП» навсегда, а
      // бот обрабатывает обновления по одному — замирал весь бот, не только
      // этот человек, и сам не отвисал до перезапуска.
      signal: AbortSignal.timeout(20000),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MerchantId': merchantId,
        'X-Secret': secret,
      },
      body: JSON.stringify(bodyData),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      const errMsg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
      return { ok: false, error: `Ошибка API Platega: ${errMsg}` };
    }

    return {
      ok: true,
      id: json.id || id,
      redirect: json.redirect || json.url || '',
      qr: json.qr || null,
      status: json.status || 'PENDING',
      expiresIn: json.expiresIn || null,
      raw: json,
    };
  } catch (err) {
    return { ok: false, error: `Сетевая ошибка Platega: ${err.message}` };
  }
}

/**
 * Получение актуального статуса транзакции из API Platega.
 */
async function getTransactionStatus(id) {
  const merchantId = MERCHANT_ID();
  const secret = SECRET();

  if (!merchantId || !secret) {
    return { ok: false, error: 'Platega не настроена' };
  }

  const url = `${API_BASE()}/transaction/${encodeURIComponent(String(id).trim())}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      method: 'GET',
      headers: {
        'X-MerchantId': merchantId,
        'X-Secret': secret,
      },
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      const errMsg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
      return { ok: false, error: `Ошибка API Platega: ${errMsg}` };
    }

    const payload = parsePayload(json.payload);
    return {
      ok: true,
      id: json.id || id,
      status: String(json.status || '').toUpperCase(),
      amount: Number(json.paymentDetails && json.paymentDetails.amount) || Number(json.amount) || 0,
      currency: String((json.paymentDetails && json.paymentDetails.currency) || json.currency || 'RUB').toUpperCase(),
      paid: String(json.status || '').toUpperCase() === 'CONFIRMED',
      userId: Number(payload.userId || payload.user_id) || 0,
      tgId: Number(payload.tgId || payload.tg_id) || 0,
      days: Number(payload.days) || 0,
      raw: json,
    };
  } catch (err) {
    return { ok: false, error: `Сетевая ошибка Platega: ${err.message}` };
  }
}

module.exports = {
  isConfigured,
  planByName,
  plans,
  priceFacts,
  DEFAULT_PLANS,
  daysFor,
  planTitle,
  planLabel,
  priceText,
  secretOk,
  parseWebhook,
  createTransaction,
  getTransactionStatus,
  MERCHANT_ID,
  SECRET,
};
