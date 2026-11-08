'use strict';

/**
 * Прогон интеграции платёжного шлюза Platega.io (СБП, банковские карты РФ).
 *
 * Проверяет:
 *   1. Проверку секретов (timingSafeEqual, защита от подделки).
 *   2. Тарифную сетку и расчёт дней (390 ₽ / 30 дн., 2990 ₽ / 365 дн.).
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
  // Запасная сетка — цены, утверждённые владельцем. Прежние 349/3490 здесь
  // и были закреплены проверкой — оттого старые цены и дожили до оферты.
  ok(plans.some((p) => p.amount === 390 && p.days === 30), 'тариф 1 месяц: 390 ₽ за 30 дней');
  ok(plans.some((p) => p.amount === 2990 && p.days === 365), 'тариф 1 год: 2 990 ₽ за 365 дней');
  ok(platega.daysFor({ amount: 390 }) === 30, '390 ₽ дают 30 дней');
  ok(platega.daysFor({ amount: 2990 }) === 365, '2990 ₽ дают 365 дней');
  ok(platega.daysFor({ amount: 99999 }) === 30, 'неизвестная сумма даёт дефолтный срок 30 дней');

  console.log('\n── настоящий ответ Platega с боевого платежа ──');
  {
    /*
     * Это не выдуманный пример. Так выглядит вебхук, пришедший на боевой
     * сервер 15.09.2026 после первого настоящего платежа: поля, статус и
     * номер способа оплаты — оттуда. До него форма ответа была написана по
     * общей документации и не подтверждена ничем.
     *
     * Номера и идентификаторы обезличены, содержательная форма сохранена.
     */
    const живой = {
      id: 'f5d5f024-0000-0000-0000-000000000000',
      amount: 378.67,                     // ЗА ВЫЧЕТОМ комиссии: платили 390
      currency: 'RUB',
      status: 'CONFIRMED',
      paymentMethod: 2,                   // СБП — подтверждено живым платежом
      payload: JSON.stringify({ userId: 1, tgId: 700000000, plan: 'month', ts: 1789459961549 }),
    };
    const r = platega.parseWebhook(живой);
    ok(r.ok, 'настоящий вебхук разобран', r.ok ? '' : r.reason);
    ok(r.payment.paid === true, 'CONFIRMED считается оплатой');
    ok(r.payment.amount === 378.67, 'сумма взята как есть', String(r.payment.amount));
    ok(r.payment.tgId === 700000000, 'Telegram-id вернулся в payload — человек опознан',
      String(r.payment.tgId));
    ok(r.payment.paymentMethod === 2, 'способ оплаты 2 = СБП');

    /*
     * Тот платёж шёл ДО правки, и days в payload не было. Проверяем, что
     * старые платежи не ломаются: срок подбирается по сумме с допуском.
     */
    ok(r.payment.days === 0, 'в старом платеже срока нет — так и должно быть');
    const wasP = process.env.LAVA_PLAN_DAYS;
    process.env.LAVA_PLAN_DAYS = '390:30,2990:365';
    ok(platega.daysFor(r.payment) === 30, 'и он всё равно опознан как месяц',
      String(platega.daysFor(r.payment)));
    if (wasP === undefined) delete process.env.LAVA_PLAN_DAYS; else process.env.LAVA_PLAN_DAYS = wasP;

    /*
     * Ответ площадки должен лежать в базе разобранным с одного раза.
     * Лежал с двух: lava отдаёт объект, platega — строку, а recordPayment
     * кодировал всё подряд ещё раз. Разбор происшествия начинался с
     * «payload не вернулся», хотя он вернулся.
     */
    const billing2 = require('./lib/billing');
    const bdb2 = require('./lib/bot-db');
    const uid2 = bdb2.getOrCreateUser(559001).id;
    for (const [вид, raw] of [['строкой', JSON.stringify(живой)], ['объектом', живой]]) {
      const ext = `raw-${вид}-${Date.now()}`;
      billing2.recordPayment({
        externalId: ext, provider: 'platega', userId: uid2, email: '',
        amount: 378.67, currency: 'RUB', days: 30, status: 'CONFIRMED', raw,
      });
      const row = billing2.findPayment('platega', ext);
      let parsed = null;
      try { parsed = JSON.parse(row.raw); } catch (_) { parsed = null; }
      ok(parsed && typeof parsed === 'object' && parsed.id === живой.id,
        `ответ, переданный ${вид}, читается одним JSON.parse`,
        parsed === null ? 'не разобрался' : typeof parsed);
    }
  }

  console.log('\n── Platega: срок берётся из выбора человека, а не из зачисленной суммы ──');
  {
    const was = process.env.LAVA_PLAN_DAYS;
    process.env.LAVA_PLAN_DAYS = '390:30,2990:365';

    /*
     * Главная ошибка, которую здесь ловим: площадка сообщает сумму ЗА
     * ВЫЧЕТОМ комиссии. За платёж в 390 ₽ пришло 378,67 — в сетке такой
     * суммы нет. Раньше сравнение было точным, поэтому ЛЮБОЙ платёж
     * проваливался в умолчание (30 дней). Месяц случайно работал, а год
     * превращался в месяц: человек платит за год, получает тридцать дней.
     */
    ok(platega.daysFor({ amount: 378.67, days: 30 }) === 30,
      'месяц по выбору человека', String(platega.daysFor({ amount: 378.67, days: 30 })));
    ok(platega.daysFor({ amount: 2903.03, days: 365 }) === 365,
      'ГОД по выбору человека, а не 30 дней', String(platega.daysFor({ amount: 2903.03, days: 365 })));

    // Платёж без payload — по прямой ссылке. Ищем по сумме с допуском.
    ok(platega.daysFor({ amount: 2903.03 }) === 365,
      'без payload год опознаётся по сумме за вычетом комиссии',
      String(platega.daysFor({ amount: 2903.03 })));
    ok(platega.daysFor({ amount: 378.67 }) === 30,
      'и месяц тоже', String(platega.daysFor({ amount: 378.67 })));
    ok(platega.daysFor({ amount: 390 }) === 30, 'ровная сумма по-прежнему работает');

    // Чужая сумма тариф не выдумывает.
    ok(platega.daysFor({ amount: 500 }) === 30, 'посторонняя сумма — умолчание, а не год',
      String(platega.daysFor({ amount: 500 })));
    ok(platega.daysFor({ amount: 5 }) === 30, 'и пять рублей не становятся годом');

    // Тариф по имени: цена и срок из одного места.
    const m = platega.planByName('month');
    const y = platega.planByName('year');
    ok(m.amount === 390 && m.days === 30, 'месяц из сетки', JSON.stringify(m));
    ok(y.amount === 2990 && y.days === 365, 'год из сетки', JSON.stringify(y));

    // payload довозит срок до вебхука.
    const hook = platega.parseWebhook({
      id: 'abc', status: 'CONFIRMED',
      paymentDetails: { amount: 2903.03, currency: 'RUB' },
      payload: JSON.stringify({ userId: 7, tgId: 77, plan: 'year', days: 365 }),
    });
    ok(hook.ok && hook.payment.days === 365, 'срок доехал в payload', JSON.stringify(hook.payment.days));
    ok(platega.daysFor(hook.payment) === 365, 'и по нему начислен год');

    if (was === undefined) delete process.env.LAVA_PLAN_DAYS; else process.env.LAVA_PLAN_DAYS = was;
  }

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
      amount: 2990,
      currency: 'RUB',
      status: 'CONFIRMED',
      paymentMethod: 2,
      payload: JSON.stringify({ userId: testUser.id, tgId: testUser.tg_id }),
    });
    ok(plategaPathRes.status === 200, 'вебхук на пути /platega успешно принят');
    const accessYear = billing.accessInfo(testUser.id);
    ok(accessYear.left >= 390, 'годовой платёж 2990 ₽ добавил 365 дней к текущему сроку');

    const H = { 'X-MerchantId': 'test-merchant-uuid-1234', 'X-Secret': 'test-secret-key-5678' };
    const hook = (u, id, status) => postJson(testServer, '/platega', H, {
      id, amount: 390, currency: 'RUB', status, paymentMethod: 2,
      payload: JSON.stringify({ userId: u.id, tgId: u.tg_id }),
    });

    /*
     * 5. Сначала «в обработке», потом «оплачено» — с одним и тем же id.
     *
     * У Platega id транзакции одинаков во всех уведомлениях. Раньше первое
     * записывало строку без дней, второе отбрасывалось как повтор: деньги
     * списаны, доступа нет.
     */
    const u5 = bdb.getOrCreateUser(777111301);
    await hook(u5, 'plt-pend-001', 'PENDING');
    ok(!billing.accessInfo(u5.id).active, '«в обработке» доступа не даёт');
    await hook(u5, 'plt-pend-001', 'CONFIRMED');
    const a5 = billing.accessInfo(u5.id);
    ok(a5.active && a5.left >= 29, 'а следом «оплачено» по тому же id — даёт', JSON.stringify(a5));

    /*
     * 6. Два «оплачено» одновременно по одной ожидающей строке.
     *
     * Обе доставки видят нулевой срок; дописать строку должна только одна.
     */
    const u6 = bdb.getOrCreateUser(777111302);
    await hook(u6, 'plt-pend-002', 'PENDING');
    await Promise.all([hook(u6, 'plt-pend-002', 'CONFIRMED'), hook(u6, 'plt-pend-002', 'CONFIRMED')]);
    const a6 = billing.accessInfo(u6.id);
    ok(a6.left >= 29 && a6.left <= 31, 'двойная доставка «оплачено» дала срок один раз', a6.left);

    /*
     * 7. Выдача дней упала — повторная доставка обязана их выдать.
     *
     * Раньше платёж записывался, а срок продлевался отдельной командой. Сбой
     * второй оставлял строку записанной, и повтор видел «уже записан».
     */
    const u7 = bdb.getOrCreateUser(777111303);
    const realGrant = billing.grantDays;
    billing.grantDays = () => { throw new Error('SQLITE_BUSY (имитация)'); };
    const first = await hook(u7, 'plt-fail-001', 'CONFIRMED');
    billing.grantDays = realGrant;
    ok(first.status >= 500, 'сбой выдачи — приёмник просит повторить', first.status);
    ok(billing.paymentsOf(u7.id, 5).length === 0, 'и платёж не остался записанным наполовину');
    await hook(u7, 'plt-fail-001', 'CONFIRMED');
    const a7 = billing.accessInfo(u7.id);
    ok(a7.active && a7.left >= 29, 'повторная доставка срок выдала', JSON.stringify(a7));

  } finally {
    testServer.close();
  }

  console.log(bad ? `\nне прошло: ${bad}` : '\nPlatega.io работает целиком ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('ПРОГОН ПАЛ:', e);
  process.exit(1);
});
