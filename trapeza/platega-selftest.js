'use strict';

/**
 * Прогон интеграции платёжного шлюза Platega.io (СБП, банковские карты РФ).
 *
 * Проверяет:
 *   1. Проверку секретов (timingSafeEqual, защита от подделки).
 *   2. Тарифную сетку и расчёт дней (349 ₽ / 30 дн., 3490 ₽ / 365 дн.).
 *   3. Разбор входящего callback-вебхука (успешный, отклонённый, битый).
 *   4. Создание транзакции через API (заголовки, тело, ответ).
 *   5. Получение статуса транзакции.
 *   6. Сквозной приём вебхука сервером (БД SQLite, продление подписки, защита от дублей).
 *
 *   node platega-selftest.js
 */

require('./selftest-db'); // изолированная БД
const assert = require('node:assert');
const http = require('node:http');

const bdb = require('./lib/bot-db');
const billing = require('./lib/billing');
const platega = require('./lib/platega');
const { server } = require('./lava-webhook');

let bad = 0;
const ok = (c, m, extra) => {
  console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra));
  if (!c) bad += 1;
};

// Вспомогательный HTTP-клиент для локальных запросов к серверу вебхуков
function postJson(serverInstance, path, headers, body) {
  return new Promise((resolve, reject) => {
    const addr = serverInstance.address();
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: addr.port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      let respBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { respBody += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: respBody });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('── Platega: конфигурация и проверка ключей ──');

  delete process.env.PLATEGA_MERCHANT_ID;
  delete process.env.PLATEGA_SECRET;
  ok(!platega.isConfigured(), 'без ключей Platega не считается настроенной');

  process.env.PLATEGA_MERCHANT_ID = 'test-merchant-uuid-1234';
  process.env.PLATEGA_SECRET = 'test-secret-key-5678';
  ok(platega.isConfigured(), 'с ключами Platega активна');

  ok(platega.secretOk('test-merchant-uuid-1234', 'test-secret-key-5678'), 'верные merchant_id и secret принимаются');
  ok(!platega.secretOk('wrong-merchant', 'test-secret-key-5678'), 'чужой merchant_id отклоняется');
  ok(!platega.secretOk('test-merchant-uuid-1234', 'wrong-secret'), 'чужой secret отклоняется');
  ok(!platega.secretOk('', ''), 'пустые ключи отклоняются');

  console.log('\n── Platega: тарифы и дни ──');
  const plans = platega.plans();
  ok(plans.length >= 2, 'тарифная сетка содержит варианты');
  ok(plans.some((p) => p.amount === 349 && p.days === 30), 'тариф 1 месяц: 349 ₽ за 30 дней');
  ok(plans.some((p) => p.amount === 3490 && p.days === 365), 'тариф 1 год: 3 490 ₽ за 365 дней');
  ok(platega.daysFor({ amount: 349 }) === 30, '349 ₽ дают 30 дней');
  ok(platega.daysFor({ amount: 3490 }) === 365, '3490 ₽ дают 365 дней');
  ok(platega.daysFor({ amount: 99999 }) === 30, 'неизвестная сумма даёт дефолтный срок 30 дней');

  console.log('\n── Platega: разбор callback-вебхука ──');

  // 1. Успешная оплата СБП
  const goodWebhook = {
    id: 'plt-trans-001',
    amount: 349.00,
    currency: 'RUB',
    status: 'CONFIRMED',
    paymentMethod: 2,
    payload: JSON.stringify({ userId: 101, tgId: 999888777, plan: 'month' }),
  };
  const p1 = platega.parseWebhook(goodWebhook);
  ok(p1.ok, 'валидный вебхук разобран');
  ok(p1.payment.paid === true, 'статус CONFIRMED означает оплачено');
  ok(p1.payment.externalId === 'plt-trans-001', 'id транзакции сохранён');
  ok(p1.payment.amount === 349, 'сумма верна');
  ok(p1.payment.userId === 101, 'userId извлечён из payload');
  ok(p1.payment.tgId === 999888777, 'tgId извлечён из payload');

  // 2. Отклонённая / отменённая транзакция
  const canceledWebhook = {
    id: 'plt-trans-002',
    amount: 349.00,
    currency: 'RUB',
    status: 'CANCELED',
    paymentMethod: 2,
    payload: JSON.stringify({ userId: 101 }),
  };
  const p2 = platega.parseWebhook(canceledWebhook);
  ok(p2.ok, 'отклонённый вебхук разобран');
  ok(p2.payment.paid === false, 'статус CANCELED не даёт оплату');

  // 3. Битые данные
  ok(!platega.parseWebhook(null).ok, 'null отклонён');
  ok(!platega.parseWebhook({}).ok, 'пустой объект без id отклонён');
  ok(!platega.parseWebhook({ id: 'x', amount: -100 }).ok, 'отрицательная сумма отклонена');

  console.log('\n── Platega: создание транзакции (Mock API) ──');
  const originalFetch = global.fetch;
  let interceptedUrl = '';
  let interceptedOpts = {};

  global.fetch = async (url, opts) => {
    interceptedUrl = String(url);
    interceptedOpts = opts || {};
    if (interceptedUrl.includes('/transaction/process')) {
      const body = JSON.parse(opts.body || '{}');
      return {
        ok: true,
        json: async () => ({
          status: 'PENDING',
          id: body.id || 'gen-uuid',
          redirect: 'https://app.platega.io/pay/mock-session-url',
          qr: 'https://app.platega.io/qr/mock-qr',
        }),
      };
    }
    if (interceptedUrl.includes('/transaction/plt-check-1')) {
      return {
        ok: true,
        json: async () => ({
          id: 'plt-check-1',
          status: 'CONFIRMED',
          amount: 349,
          currency: 'RUB',
          payload: JSON.stringify({ userId: 101 }),
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };

  try {
    const tx = await platega.createTransaction({
      amount: 349,
      userId: 101,
      tgId: 999888777,
      paymentMethod: 2,
    });
    ok(tx.ok, 'транзакция создана успешно');
    ok(tx.redirect === 'https://app.platega.io/pay/mock-session-url', 'получена ссылка на оплату');
    ok(interceptedOpts.headers['X-MerchantId'] === 'test-merchant-uuid-1234', 'заголовок X-MerchantId отправлен');
    ok(interceptedOpts.headers['X-Secret'] === 'test-secret-key-5678', 'заголовок X-Secret отправлен');

    const statusCheck = await platega.getTransactionStatus('plt-check-1');
    ok(statusCheck.ok, 'статус транзакции получен');
    ok(statusCheck.paid === true, 'транзакция подтверждена');
    ok(statusCheck.userId === 101, 'userId из статуса извлечён');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('\n── Сквозной приём вебхука Platega в lava-webhook.js ──');
  const testServer = http.createServer(server.listeners('request')[0]);
  await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));

  try {
    // Создаём тестового пользователя
    const testUser = bdb.getOrCreateUser(777111222);
    ok(testUser && testUser.id, 'тестовый пользователь создан в БД');
    const initialAccess = billing.accessInfo(testUser.id);
    ok(!initialAccess.active, 'изначально у пользователя нет активной подписки');

    // 1. Запрос с неверным секретом
    const badSecretRes = await postJson(testServer, '/webhook', {
      'X-MerchantId': 'test-merchant-uuid-1234',
      'X-Secret': 'bad-secret',
    }, { id: 'test-1', amount: 349, status: 'CONFIRMED' });
    ok(badSecretRes.status === 401, 'вебхук Platega с неверным секретом получает HTTP 401');

    // 2. Валидный платёж Platega на /webhook
    const goodRes = await postJson(testServer, '/webhook', {
      'X-MerchantId': 'test-merchant-uuid-1234',
      'X-Secret': 'test-secret-key-5678',
    }, {
      id: 'plt-live-001',
      amount: 349,
      currency: 'RUB',
      status: 'CONFIRMED',
      paymentMethod: 2,
      payload: JSON.stringify({ userId: testUser.id, tgId: testUser.tg_id }),
    });
    ok(goodRes.status === 200, 'валидный вебхук Platega принят со статусом 200');

    const updatedAccess = billing.accessInfo(testUser.id);
    ok(updatedAccess.active, 'подписка пользователя активирована в базе');
    ok(updatedAccess.left >= 29 && updatedAccess.left <= 31, 'начислено 30 дней доступа');

    // Проверяем запись в таблице payments
    const userPayments = billing.paymentsOf(testUser.id, 5);
    ok(userPayments.length === 1, 'платёж сохранён в таблице payments');
    ok(userPayments[0].provider === 'platega', 'провайдер указан как platega');
    ok(userPayments[0].amount === 349, 'сумма платежа 349 ₽');

    // 3. Повторная доставка того же вебхука (idempotency check)
    const dupRes = await postJson(testServer, '/webhook', {
      'X-MerchantId': 'test-merchant-uuid-1234',
      'X-Secret': 'test-secret-key-5678',
    }, {
      id: 'plt-live-001',
      amount: 349,
      currency: 'RUB',
      status: 'CONFIRMED',
      paymentMethod: 2,
      payload: JSON.stringify({ userId: testUser.id, tgId: testUser.tg_id }),
    });
    ok(dupRes.status === 200, 'повторный вебхук принят со статусом 200');
    const accessAfterDup = billing.accessInfo(testUser.id);
    ok(accessAfterDup.until === updatedAccess.until, 'повтор вебхука не задвоил дни доступа');

    // 4. Запрос на эндпоинт /platega
    const plategaPathRes = await postJson(testServer, '/platega', {
      'X-MerchantId': 'test-merchant-uuid-1234',
      'X-Secret': 'test-secret-key-5678',
    }, {
      id: 'plt-live-002',
      amount: 3490,
      currency: 'RUB',
      status: 'CONFIRMED',
      paymentMethod: 2,
      payload: JSON.stringify({ userId: testUser.id, tgId: testUser.tg_id }),
    });
    ok(plategaPathRes.status === 200, 'вебхук на пути /platega успешно принят');
    const accessYear = billing.accessInfo(testUser.id);
    ok(accessYear.left >= 390, 'годовой платёж 3490 ₽ добавил 365 дней к текущему сроку');

  } finally {
    testServer.close();
  }

  console.log(bad ? `\nне прошло: ${bad}` : '\nPlatega.io работает целиком ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('ПРОГОН ПАЛ:', e);
  process.exit(1);
});
