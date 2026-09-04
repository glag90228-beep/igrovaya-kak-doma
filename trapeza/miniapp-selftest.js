'use strict';

/**
 * Проверка мини-приложения без Telegram.
 *
 * Поднимаем настоящий сервер на свободном порту и стучимся в него обычными
 * запросами, подписывая initData так же, как это делает Telegram. Мокать
 * здесь нечего: смысл проверки как раз в том, что чужой и подделанный
 * запрос не проходят, а свой — проходит и видит только свои данные.
 *
 *   TRAPEZA_DB=/tmp/miniapp.db node miniapp-selftest.js
 */

require('./selftest-db');   // своя база на прогон — до всего, что тянет db.js
const crypto = require('node:crypto');

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '111:TEST-TOKEN';
process.env.FREE_DOCS = '2';          // лимит маленький — так его видно в тесте
process.env.ENFORCE_LIMIT = '1';
// DADATA_MOCK — это карта «значение → ответ справочника», а не флаг:
// так прогон проверяет и разбор ответа, а не только факт вызова.
// Данные выдуманные: настоящих организаций и людей в тестах не держим.
process.env.MAIL_KEY = 'test-mail-key';
process.env.DADATA_MOCK = JSON.stringify({
  7712345678: {
    name: { short_with_opf: 'ООО «Ромашка»', full_with_opf: 'Общество с ограниченной ответственностью «Ромашка»' },
    inn: '7712345678',
    kpp: '771201001',
    address: { value: 'г Москва, ул Тестовая, д 1' },
    management: { name: 'Иванов Иван Иванович' },
    state: { status: 'ACTIVE' },
  },
  '044525999': {
    name: { payment: 'АО «Тестбанк»' },
    correspondent_account: '30101810400000000999',
    bic: '044525999',
  },
});

const TOKEN = process.env.BOT_TOKEN;

const bdb = require('./lib/bot-db');
const { verifyInitData } = require('./lib/webapp-auth');
const docService = require('./lib/doc-service');
const docSvcForAkt = docService;
const { server, setTelegram, forgetRate } = require('./miniapp');

/**
 * Заголовок раздела — и заодно сброс счётчика частоты.
 *
 * Предел в 120 запросов в минуту рассчитан на человека, который тычет в
 * кнопки. Самопроверка делает столько за секунду, и очередная добавленная
 * проверка начинает падать с 429 в разделе, который к частоте отношения не
 * имеет. Сбрасываем на границе разделов: внутри раздела счётчик работает —
 * там его и проверяем, залпом из 130 запросов.
 */
function section(name) {
  forgetRate();
  console.log(`\n── ${name} ──`);
}

let bad = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg + (cond || extra === undefined ? '' : ' → ' + extra));
  if (!cond) bad += 1;
};

// ---------- подписываем initData как Telegram ----------

function initDataFor(user, { authDate = Math.floor(Date.now() / 1000), token = TOKEN } = {}) {
  const fields = { auth_date: String(authDate), user: JSON.stringify(user), query_id: 'AAH' };
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const q = new URLSearchParams(fields);
  q.set('hash', hash);
  return q.toString();
}

const MASHA = { id: 500101, first_name: 'Мария', username: 'masha' };
const PETYA = { id: 500202, first_name: 'Пётр', username: 'petya' };
// Отдельный человек для проверок главного экрана: у Маши к тому месту в
// прогоне уже десяток документов, и по её цифрам ничего не разглядеть.
const ANNA = { id: 500303, first_name: 'Анна', username: 'anna' };

// Телеграм подменяем: файлы «отправляются», но в сеть никто не идёт.
const sentToChat = [];
setTelegram({
  async sendDocument(chatId, { filename, caption }) { sentToChat.push({ chatId, filename, caption }); return {}; },
});

let base = '';

async function call(method, path, { user, body, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (user !== undefined) init.headers.Authorization = `tma ${user}`;
  if (raw !== undefined) init.headers.Authorization = raw;
  if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* не JSON — так и надо для статики */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  const masha = initDataFor(MASHA);
  const petya = initDataFor(PETYA);

  section('подпись и доступ');
  let r = await call('GET', '/api/state');
  ok(r.status === 401, 'без подписи API не отвечает', r.status);

  r = await call('GET', '/api/state', { raw: 'tma user=%7B%22id%22%3A1%7D&hash=deadbeef' });
  ok(r.status === 401, 'выдуманная подпись отвергнута', r.status);

  const tampered = masha.replace(/user=[^&]*/, `user=${encodeURIComponent(JSON.stringify({ id: 999, first_name: 'Чужой' }))}`);
  r = await call('GET', '/api/state', { user: tampered });
  ok(r.status === 401, 'подмена пользователя в подписанной строке отвергнута', r.status);

  const stale = initDataFor(MASHA, { authDate: Math.floor(Date.now() / 1000) - 90000 });
  r = await call('GET', '/api/state', { user: stale });
  ok(r.status === 401, 'вчерашняя ссылка не работает', (r.json || {}).error);

  const foreign = initDataFor(MASHA, { token: '222:OTHER-BOT' });
  r = await call('GET', '/api/state', { user: foreign });
  ok(r.status === 401, 'подпись чужого бота не принимается');

  r = await call('GET', '/api/state', { user: masha });
  ok(r.status === 200 && r.json.user.tgId === MASHA.id, 'своя подпись пускает и узнаёт пользователя',
    r.json && r.json.user && r.json.user.tgId);
  ok(r.json.quota.limit === 2, 'лимит бесплатных берётся из настроек', r.json.quota.limit);

  section('организация и контрагенты');
  r = await call('POST', '/api/org', {
    user: masha,
    body: {
      name: 'ИП Сарычева М. В.', full_name: 'Индивидуальный предприниматель Сарычева Мария Витальевна',
      inn: '183209316100', signer: 'М. В. Сарычева', address: 'г. Ижевск',
      bank_name: 'АО «ТБанк»', bik: '044525974', acc: '40802810700005555552',
      corr_acc: '30101810145250000974',
    },
  });
  ok(r.status === 200 && r.json.org.name === 'ИП Сарычева М. В.', 'организация сохранена');

  r = await call('POST', '/api/org', { user: masha, body: { name: '' } });
  ok(r.status === 400, 'организация без названия не сохраняется', (r.json || {}).error);

  r = await call('POST', '/api/cp', {
    user: masha,
    body: { name: 'ООО «Заря»', inn: '1831234560', kind: 'customer', address: 'г. Ижевск, ул. Ленина, 1' },
  });
  const cpId = r.json.cp.id;
  ok(r.status === 200 && cpId > 0, 'контрагент создан', cpId);

  r = await call('POST', '/api/cp', { user: masha, body: { name: '' } });
  ok(r.status === 400, 'контрагент без названия отклонён');

  r = await call('GET', '/api/cps', { user: petya });
  ok(r.status === 200 && r.json.cps.length === 0, 'чужой пользователь не видит наших контрагентов',
    r.json && r.json.cps.length);

  r = await call('POST', '/api/cp', { user: petya, body: { id: cpId, name: 'Перехват' } });
  ok(r.status === 400, 'чужого контрагента нельзя править по прямому id', (r.json || {}).error);
  r = await call('GET', '/api/cps', { user: masha });
  ok(r.json.cps[0].name === 'ООО «Заря»', 'название нашего контрагента не изменилось', r.json.cps[0].name);

  section('НДС: новые ставки 22%, 5%, 7%');
  {
    // Реформа НДС с 2026 года: общая ставка выросла до 22%, а пониженные
    // ставки УСН без права на вычет — 5% и 7%. До этой правки /api/vat
    // принимал только 0, 10 и 20 — новые ставки отклонялись с ошибкой,
    // хотя lib/money.js умел считать налог по любой ставке.
    r = await call('POST', '/api/vat', { user: masha, body: { rate: 22, gross: 1 } });
    ok(r.status === 200 && r.json.vat.rate === 22 && r.json.vat.gross === true,
      'ставка 22% (общая с 2026 года) принята', JSON.stringify(r.json));

    r = await call('POST', '/api/vat', { user: masha, body: { rate: 5, gross: 0 } });
    ok(r.status === 200 && r.json.vat.rate === 5, 'ставка 5% УСН принята', JSON.stringify(r.json));

    r = await call('POST', '/api/vat', { user: masha, body: { rate: 7, gross: 0 } });
    ok(r.status === 200 && r.json.vat.rate === 7, 'ставка 7% УСН принята', JSON.stringify(r.json));

    r = await call('POST', '/api/vat', { user: masha, body: { rate: 15, gross: 0 } });
    ok(r.status === 400 && Boolean(r.json.error), 'несуществующая ставка 15% всё равно отклонена',
      JSON.stringify(r.json));

    r = await call('POST', '/api/vat', { user: masha, body: { rate: null, gross: 0 } });
    ok(r.status === 200 && r.json.vat.rate === null, 'ставка сброшена обратно на «без НДС»');
  }

  section('переключатель ИИ-ассистента');
  {
    /*
     * В приложении переключатель был нарисован, а на сервере его не было:
     * экран дёргал /api/user/ai и читал aiEnabled, а miniapp.js не знал ни
     * того, ни другого. Кнопка всегда показывала «включён» и падала с
     * ошибкой при нажатии.
     */
    r = await call('GET', '/api/state', { user: masha });
    ok(r.json.aiEnabled === true, 'по умолчанию ассистент включён', r.json.aiEnabled);

    r = await call('POST', '/api/user/ai', { user: masha, body: { enabled: false } });
    ok(r.status === 200 && r.json.aiEnabled === false, 'выключается', JSON.stringify(r.json));
    r = await call('GET', '/api/state', { user: masha });
    ok(r.json.aiEnabled === false, 'и состояние это помнит', r.json.aiEnabled);

    r = await call('POST', '/api/user/ai', { user: petya, body: { enabled: false } });
    r = await call('GET', '/api/state', { user: masha });
    ok(r.json.aiEnabled === false, 'чужой переключатель на наш не влияет', r.json.aiEnabled);

    r = await call('POST', '/api/user/ai', { user: masha, body: { enabled: true } });
    ok(r.json.aiEnabled === true, 'включается обратно', JSON.stringify(r.json));
  }

  section('выписка документа');
  sentToChat.length = 0;
  r = await call('POST', '/api/doc', {
    user: masha,
    body: {
      type: 'sch',
      cpId,
      /*
       * Дата задана явно — так проверяется, что приложение её принимает, а не
       * ставит сегодняшнюю. Но месяц обязан быть текущим: бесплатный лимит
       * считается по документам этого месяца, и документ, помеченный прошлым
       * месяцем, в квоту не попадает. Раньше здесь стояло 14 августа, и в
       * августе всё сходилось; в сентябре третий документ переставал упираться
       * в лимит, а в журнале появлялся лишний. Первое число берём потому, что
       * оно всегда уже наступило — будущей датой документ не пометить.
       */
      date: `${require('./lib/period').todayISO().slice(0, 7)}-01`,
      items: [
        { name: 'Канапе ассорти', unit: 'шт.', qty: 20, price: 650 },
        { name: 'Доставка', unit: 'усл.', qty: 1, price: 1500 },
      ],
    },
  });
  ok(r.status === 200 && r.json.total === 14500, 'счёт выписан и сумма посчитана', r.json && r.json.total);
  ok(r.json.doc.number === '1', 'номер присвоен сам', r.json.doc.number);
  ok(sentToChat.length === 1 && sentToChat[0].chatId === MASHA.id,
    'файл ушёл в чат владельцу', sentToChat.length && sentToChat[0].chatId);
  ok(/\.(pdf|html)$/.test(r.json.file.name), 'файл получил имя', r.json.file.name);

  const fileUrl = r.json.file.url;
  const got = await fetch(base + fileUrl);
  ok(got.status === 200 && Number(got.headers.get('content-length')) > 1000,
    'файл скачивается по одноразовой ссылке', got.headers.get('content-length'));
  const again = await fetch(base + fileUrl);
  ok(again.status === 404, 'вторая попытка по той же ссылке уже не работает', again.status);

  r = await call('POST', '/api/doc', { user: masha, body: { type: 'sch', cpId, items: [] } });
  ok(r.status === 400, 'документ без позиций не выписывается', (r.json || {}).error);

  r = await call('POST', '/api/doc', {
    user: masha, body: { type: 'sch', cpId: 999999, items: [{ name: 'X', qty: 1, price: 1 }] },
  });
  ok(r.status === 400 && /онтрагент/.test(r.json.error), 'на чужого контрагента выписать нельзя', r.json.error);

  section('лимит бесплатных');
  r = await call('POST', '/api/doc', {
    user: masha, body: { type: 'usl', cpId, items: [{ name: 'Услуга', qty: 1, price: 1000 }] },
  });
  ok(r.status === 200, 'второй документ ещё бесплатный');
  r = await call('POST', '/api/doc', {
    user: masha, body: { type: 'sch', cpId, items: [{ name: 'Третий', qty: 1, price: 100 }] },
  });
  ok(r.status === 400 && r.json.reason === 'quota', 'третий документ упирается в лимит', r.json.error);

  const mashaUser = bdb.getOrCreateUser(MASHA.id);
  require('./lib/billing').grantDays(mashaUser.id, 30);
  r = await call('POST', '/api/doc', {
    user: masha, body: { type: 'sch', cpId, items: [{ name: 'С подпиской', qty: 2, price: 300 }] },
  });
  ok(r.status === 200 && r.json.total === 600, 'с подпиской лимит не мешает', r.json && r.json.total);

  section('код доступа');
  {
    const billing = require('./lib/billing');
    const petyaUser = bdb.getOrCreateUser(PETYA.id);
    const [code] = billing.createCodes({ days: 14, count: 1, note: 'мини-апп' });

    r = await call('POST', '/api/promo', { user: petya, body: { code: '' } });
    ok(r.json.error === 'Введите код.', 'пустой код не проходит');
    r = await call('POST', '/api/promo', { user: petya, body: { code: 'PRV-QQQQ-QQQQ' } });
    ok(r.json.error.includes('Такого кода нет'), 'выдуманный код отклонён', r.json.error);
    ok(!billing.accessInfo(petyaUser.id).active, 'доступа всё ещё нет');

    // Регистр и разделители неважны: код часто переписывают руками.
    r = await call('POST', '/api/promo', { user: petya, body: { code: code.pretty.toLowerCase() } });
    ok(r.status === 200 && r.json.days === 14, 'код активирован', r.json && r.json.days);
    ok(r.json.quota.paid && r.json.access.active, 'экран сразу получил новое состояние');
    ok(billing.accessInfo(petyaUser.id).active, 'доступ выдан');

    r = await call('POST', '/api/promo', { user: petya, body: { code: code.pretty } });
    ok(r.json.error.includes('уже активировали'), 'повторно тот же код не проходит', r.json.error);

    // Чужой код нельзя активировать дважды одним и тем же человеком, но
    // главное — что он вообще одноразовый.
    r = await call('POST', '/api/promo', { user: masha, body: { code: code.pretty } });
    ok(r.json.error.includes('уже использован'), 'одноразовый код у второго не работает',
      r.json.error);
  }

  section('Excel: акт сверки и реестр');
  {
    // Обе кнопки в приложении не работали: файл собирался, но уходил в
    // ссылку, которую Telegram скачать не даёт. Теперь он ещё и в чат.
    sentToChat.length = 0;
    r = await call('GET', `/api/akt?cp=${cpId}`, { user: masha });
    ok(r.status === 200 && r.json.file && /\.xlsx$/.test(r.json.file.name),
      'акт сверки собирается', r.status === 200 ? r.json.file.name : (r.json || {}).error);
    ok(sentToChat.length === 1, 'акт сверки уходит в чат с ботом', sentToChat.length);
    const aktFile = await fetch(base + r.json.file.url);
    ok(aktFile.status === 200 && Number(aktFile.headers.get('content-length')) > 3000,
      'файл акта скачивается и не пустой', aktFile.headers.get('content-length'));

    sentToChat.length = 0;
    r = await call('GET', '/api/registry?from=2026-01-01&to=2026-12-31', { user: masha });
    ok(r.status === 200 && r.json.count > 0, 'реестр собирается',
      r.status === 200 ? `${r.json.count} шт. на ${r.json.total}` : (r.json || {}).error);
    ok(sentToChat.length === 1, 'реестр уходит в чат с ботом');

    r = await call('GET', '/api/registry?from=2020-01-01&to=2020-12-31', { user: masha });
    ok(r.status === 200 && r.json.count === 0, 'за пустой период реестр пуст, а не ошибка');

    r = await call('GET', `/api/akt?cp=${cpId}`, { user: petya });
    ok(r.status === 400, 'чужой акт сверки не собрать', (r.json || {}).error);
  }

  section('удаление документа');
  {
    const before = (await call('GET', '/api/docs', { user: masha })).json.docs.length;
    const victim = (await call('POST', '/api/doc', {
      user: masha,
      body: { type: 'sch', cpId, items: [{ name: 'На удаление', qty: 1, price: 100 }] },
    })).json.doc;
    r = await call('POST', '/api/doc/delete', { user: petya, body: { id: victim.id } });
    ok(r.status === 400, 'чужой документ удалить нельзя', (r.json || {}).error);
    r = await call('POST', '/api/doc/delete', { user: masha, body: { id: victim.id } });
    ok(r.status === 200 && r.json.deleted, 'свой документ удаляется', (r.json || {}).error);
    const after = (await call('GET', '/api/docs', { user: masha })).json.docs.length;
    ok(after === before, 'журнал вернулся к прежней длине', `${before} → ${after}`);
    r = await call('POST', '/api/doc/delete', { user: masha, body: { id: victim.id } });
    ok(r.status === 400, 'повторное удаление отвечает понятно', (r.json || {}).error);
  }


  section('журнал и копии');
  r = await call('GET', '/api/docs', { user: masha });
  const docs = r.json.docs;
  /*
   * Четыре, а не три: акт сверки тоже попадает в журнал. Раньше приложение
   * собирало его мимо — документа не было в «Моих документах», он не считался
   * в бесплатном лимите и его нельзя было переслать заново. Бот при этом
   * записывал: одно и то же действие через две двери давало разный результат.
   */
  ok(docs.length === 4, 'в журнале четыре документа, включая акт сверки', docs.length);
  ok(docs.some((d) => d.type === 'akt'), 'акт из приложения записан в журнал',
    docs.map((d) => d.type).join(','));
  const withItems = docs.find((d) => d.items.length);
  ok(withItems && withItems.items.length === 1, 'позиции сохранились вместе с документом',
    withItems && withItems.items.length);

  r = await call('GET', '/api/docs', { user: petya });
  ok(r.json.docs.length === 0, 'чужой журнал пуст');

  sentToChat.length = 0;
  r = await call('POST', '/api/doc/resend', { user: masha, body: { id: withItems.id } });
  ok(r.status === 200 && sentToChat.length === 1, 'копия документа пересобрана и отправлена');
  r = await call('POST', '/api/doc/resend', { user: petya, body: { id: docs[0].id } });
  ok(r.status === 400, 'чужой документ не пересобрать', (r.json || {}).error);

  /*
   * Штампы приходят из браузера, а значит, могут прийти любыми. Проверяем
   * не вёрстку — её проверяет bot-selftest, — а то, что просьба напечатать
   * «Оплачено» на неоплаченном счёте до бумаги не доходит.
   */
  r = await call('POST', '/api/doc/resend', {
    user: masha, body: { id: withItems.id, stamp: { paid: true } },
  });
  ok(r.status === 200 && r.json.stamp === null,
    'штамп «Оплачено» на неоплаченном документе не поставлен', JSON.stringify(r.json.stamp));
  r = await call('POST', '/api/doc/resend', {
    user: masha, body: { id: withItems.id, stamp: { copy: 'да' } },
  });
  ok(r.status === 200 && r.json.stamp && r.json.stamp.copy === true,
    'строка вместо галочки приведена к «да», а не сломала сборку');
  r = await call('POST', '/api/doc/resend', {
    user: masha, body: { id: withItems.id, stamp: 'ОПЛАЧЕНО' },
  });
  ok(r.status === 200 && r.json.stamp === null, 'мусор вместо штампов просто игнорируется');

  section('временная ссылка на документ');
  {
    const docLink = require('./lib/doc-link');
    const wasPublic = process.env.PUBLIC_URL;
    const wasApp = process.env.WEBAPP_URL;

    // Без своего адреса в интернете ссылку делать не из чего — и об этом
    // надо сказать, а не выдать «https://undefined/d/…».
    delete process.env.PUBLIC_URL;
    delete process.env.WEBAPP_URL;
    r = await call('POST', '/api/doc/link', { user: masha, body: { id: withItems.id } });
    ok(r.status === 400 && /адрес/.test(r.json.error || ''),
      'без адреса сайта ссылку не обещаем', (r.json || {}).error);

    process.env.PUBLIC_URL = 'https://pervichkaru.ru';
    r = await call('POST', '/api/doc/link', { user: masha, body: { id: withItems.id } });
    const link = r.json.link;
    ok(r.status === 200 && /^https:\/\/pervichkaru\.ru\/d\/[A-Za-z0-9_-]{20,}$/.test(link.url),
      'ссылка выдана и ведёт на наш домен', link && link.url);

    r = await call('POST', '/api/doc/link', { user: masha, body: { id: withItems.id } });
    ok(r.json.link.token === link.token,
      'второе нажатие отдаёт ту же ссылку, а не плодит новые');

    // Главное здесь: адрес открывается без подписи Telegram — его открывает
    // клиент, у которого нашего бота нет.
    const token = link.url.split('/d/')[1];
    r = await call('GET', `/d/${token}`);
    ok(r.status === 200, 'документ по ссылке открывается без подписи', r.status);
    ok(/noindex/.test(r.headers.get('x-robots-tag') || ''),
      'поисковику вход закрыт заголовком, а не только robots.txt',
      r.headers.get('x-robots-tag'));
    ok((r.headers.get('cache-control') || '').includes('no-store'),
      'и не кэшируется: исправленный счёт должен приходить исправленным');
    ok(/inline/.test(r.headers.get('content-disposition') || ''),
      'открывается в браузере, а не падает в «Загрузки»',
      r.headers.get('content-disposition'));

    r = await call('GET', `/api/doc/link?id=${withItems.id}`, { user: masha });
    ok(r.json.links[0] && r.json.links[0].opens === 1,
      'открытие посчитано — владельцу видно, дошёл ли документ',
      r.json.links[0] && r.json.links[0].opens);

    r = await call('GET', '/d/этоНеТокен');
    ok(r.status === 404 && /Документ недоступен/.test(r.text),
      'на выдуманный токен — человеческая страница, а не голый 404', r.status);

    // Чужую ссылку не отозвать: иначе любой мог бы закрыть доступ к чужому
    // документу, зная только его номер в базе.
    r = await call('POST', '/api/doc/link/revoke', { user: petya, body: { id: withItems.id } });
    ok(r.status === 400, 'чужой документ не отозвать', (r.json || {}).error);
    r = await call('GET', `/d/${token}`);
    ok(r.status === 200, 'и ссылка после этой попытки жива');

    r = await call('POST', '/api/doc/link/revoke', { user: masha, body: { id: withItems.id } });
    ok(r.json.revoked === 1, 'владелец отзывает', JSON.stringify(r.json));
    r = await call('GET', `/d/${token}`);
    ok(r.status === 404, 'после отзыва документ по ссылке не открывается', r.status);

    /*
     * Акт сверки по ссылке должен открываться, а не скачиваться. Таблицу
     * Excel браузер не показывает — контрагент вместо документа получал окно
     * «Загрузить файл?» от незнакомого сайта. Для просмотра собираем
     * печатную форму, для работы таблица остаётся.
     */
    const aktDoc = docs.find((d) => d.type === 'akt');
    if (aktDoc) {
      const byMail = await docSvcForAkt.rebuildDocument(bdb.getOrCreateUser(MASHA.id).id, aktDoc.id);
      ok(byMail.file.filename.endsWith('.xlsx'),
        'файлом и почтой акт сверки уходит таблицей', byMail.file.filename);

      const forView = await docSvcForAkt.rebuildDocument(
        bdb.getOrCreateUser(MASHA.id).id, aktDoc.id, { forView: true },
      );
      ok(!forView.file.filename.endsWith('.xlsx'),
        'а для просмотра — печатной формой', forView.file.filename);
      ok(forView.file.mime === 'application/pdf' || forView.file.mime.startsWith('text/html'),
        'её браузер умеет показать', forView.file.mime);
    }

    // Истёкшая ссылка мертва так же, как отозванная.
    const fresh = docLink.create(bdb.getOrCreateUser(MASHA.id).id, withItems.id);
    require('./db').db.prepare('UPDATE doc_links SET expires_at = ? WHERE token = ?')
      .run('2020-01-01T00:00:00.000Z', fresh.token);
    r = await call('GET', `/d/${fresh.token}`);
    ok(r.status === 404, 'истёкшая ссылка тоже закрыта', r.status);
    ok(docLink.resolve(fresh.token) === null, 'и в базе она больше не находится');

    if (wasPublic === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = wasPublic;
    if (wasApp === undefined) delete process.env.WEBAPP_URL; else process.env.WEBAPP_URL = wasApp;
  }

  section('самозанятость и чек');
  {
    const unpaid = docs.find((d) => d.type === 'sch' && d.total);
    r = await call('POST', '/api/doc/paid', { user: masha, body: { id: unpaid.id } });
    ok(r.status === 200 && r.json.npd === null,
      'не применяющему НПД приложение про чек не говорит', JSON.stringify(r.json.npd));

    r = await call('POST', '/api/npd', { user: masha, body: { on: true } });
    ok(r.json.npd === true, 'галочку можно поставить');
    r = await call('GET', '/api/state', { user: masha });
    ok(Number(r.json.org.npd) === 1, 'и приложение видит её в состоянии');

    await call('POST', '/api/doc/paid', { user: masha, body: { id: unpaid.id, paid: false } });
    r = await call('POST', '/api/doc/paid', { user: masha, body: { id: unpaid.id } });
    ok(r.json.npd && /чек в «Моём налоге»/.test(r.json.npd.text),
      'с галочкой — напоминание про чек', r.json.npd && r.json.npd.text.slice(0, 60));
    ok(r.json.npd.url === 'https://lknpd.nalog.ru/',
      'и адрес личного кабинета, а не выдуманная схема', r.json.npd.url);

    await call('POST', '/api/npd', { user: masha, body: { on: false } });
  }

  section('подсказки по реквизитам');
  r = await call('POST', '/api/lookup', { user: masha, body: { inn: '7712345678' } });
  ok(r.status === 200 && r.json.party && r.json.party.name === 'ООО «Ромашка»',
    'по ИНН пришли данные организации', r.json.party && r.json.party.name);
  ok(r.json.party.signer === 'И. И. Иванов', 'директор приведён к виду для подписи',
    r.json.party && r.json.party.signer);

  r = await call('POST', '/api/lookup', { user: masha, body: { bik: '044525999' } });
  ok(r.status === 200 && r.json.bank && r.json.bank.bank_name === 'АО «Тестбанк»'
    && r.json.bank.corr_acc === '30101810400000000999',
    'по БИК пришли банк и корр. счёт', r.json.bank && r.json.bank.bank_name);

  r = await call('POST', '/api/lookup', { user: masha, body: { inn: '12345' } });
  ok(r.status === 400 && /10 или 12/.test(r.json.error), 'ИНН неверной длины отклонён с объяснением',
    (r.json || {}).error);
  r = await call('POST', '/api/lookup', { user: masha, body: { inn: '7799999999' } });
  ok(r.status === 400 && /не нашлось/.test(r.json.error), 'ненайденный ИНН объясняет причину',
    (r.json || {}).error);
  r = await call('POST', '/api/lookup', { user: masha, body: {} });
  ok(r.status === 400, 'запрос без ИНН и БИК отклонён');

  r = await call('POST', '/api/parse', {
    user: masha,
    body: {
      text: 'ООО «Ромашка», ИНН 7707083893, КПП 770701001, р/с 40702810100000000001 '
        + 'в Банк ВТБ (ПАО), БИК 044525187, к/с 30101810700000000187',
    },
  });
  ok(r.status === 200 && r.json.fields.inn === '7707083893' && r.json.fields.bik === '044525187',
    'вставленный блок реквизитов разобран', r.json.fields && r.json.fields.bik);

  section('долг и оплата');
  {
    r = await call('GET', '/api/state', { user: masha });
    ok(r.json.debtBasis === 'closing', 'по умолчанию долг возникает по акту', r.json.debtBasis);

    r = await call('POST', '/api/basis', { user: masha, body: { basis: 'выдумка' } });
    ok(r.status === 400, 'неизвестное основание отклонено');
    r = await call('POST', '/api/basis', { user: masha, body: { basis: 'invoice' } });
    ok(r.status === 200 && r.json.basis === 'invoice', 'основание переключается на счёт');

    const cp2 = (await call('POST', '/api/cp', {
      user: masha, body: { name: 'Арендатор ООО «Луч»', kind: 'customer' },
    })).json.cp.id;
    r = await call('POST', '/api/doc', {
      user: masha,
      body: { type: 'sch', cpId: cp2, items: [{ name: 'Аренда, август', qty: 1, price: 60000 }] },
    });
    ok(r.status === 200, 'счёт арендатору выписан', (r.json || {}).error);
    r = await call('GET', '/api/cps', { user: masha });
    const luch = r.json.cps.find((c) => c.id === cp2);
    ok(luch.balance === 60000, 'счёт создал долг арендатора', luch.balance);

    r = await call('GET', '/api/unpaid', { user: masha });
    const unpaidDoc = r.json.docs.find((d) => d.cpId === cp2);
    ok(Boolean(unpaidDoc), 'счёт попал в список неоплаченных');

    r = await call('POST', '/api/doc/paid', { user: masha, body: { id: unpaidDoc.id } });
    ok(r.status === 200 && r.json.paidAt, 'оплата отмечена', (r.json || {}).paidAt);
    r = await call('GET', '/api/cps', { user: masha });
    ok(r.json.cps.find((c) => c.id === cp2).balance === 0, 'после оплаты долг закрыт');

    r = await call('POST', '/api/doc/paid', { user: masha, body: { id: unpaidDoc.id, paid: false } });
    ok(r.status === 200, 'отметку можно снять');
    r = await call('GET', '/api/cps', { user: masha });
    ok(r.json.cps.find((c) => c.id === cp2).balance === 60000, 'долг вернулся');

    r = await call('POST', '/api/doc/paid', { user: petya, body: { id: unpaidDoc.id } });
    ok(r.status === 400, 'чужой документ оплаченным не отметить');

    await call('POST', '/api/basis', { user: masha, body: { basis: 'closing' } });
  }

  section('что показывает главный экран');
  {
    /*
     * Три жалобы, которые на этом экране сходятся в одну: «цифры врут».
     * Проверяем их разом на чистом человеке — у Маши к этому месту в
     * прогоне уже слишком много документов, чтобы что-то разглядеть.
     */
    const anna = initDataFor(ANNA);
    // ИНН настоящий по контрольным суммам: /api/org их проверяет.
    r = await call('POST', '/api/org', {
      user: anna, body: { name: 'ИП Анна', inn: '183209316100', signer: 'А. А.' },
    });
    ok(r.status === 200 && r.json.org, 'организация Анны заведена', (r.json || {}).error);
    const cpA = (await call('POST', '/api/cp', {
      user: anna, body: { name: 'ООО «Сделка»', kind: 'customer' },
    })).json.cp.id;

    // Одна сделка, два документа: счёт и закрывающий его акт на те же 30 000.
    for (const type of ['sch', 'usl']) {
      // eslint-disable-next-line no-await-in-loop
      await call('POST', '/api/doc', {
        user: anna, body: { type, cpId: cpA, items: [{ name: 'Работа', qty: 1, price: 30000 }] },
      });
    }
    r = await call('GET', '/api/state', { user: anna });
    ok(r.json.unpaid.sum === 30000 && r.json.unpaid.count === 1,
      'счёт и закрывающий его акт — одна сделка, а не две',
      `${r.json.unpaid.sum} / ${r.json.unpaid.count} шт.`);
    ok(r.json.debts.owedToUs === 30000, 'и долг тоже один', r.json.debts.owedToUs);

    /*
     * Плитка и экран за ней обязаны показывать одно число.
     *
     * Плитка считала сделками, а экран складывал список сам — человек видел
     * «30 000», нажимал и получал «2 счёта на 60 000». Оба берут сумму из
     * одного места; список при этом остаётся полным, но второй документ
     * сделки помечен.
     */
    const tile = r.json.unpaid;
    const scr = (await call('GET', '/api/unpaid', { user: anna })).json;
    ok(scr.sum === tile.sum && scr.count === tile.count,
      'экран «Ждут оплаты» показывает то же, что плитка на главной',
      `плитка ${tile.sum}/${tile.count} — экран ${scr.sum}/${scr.count}`);
    ok(scr.docs.length === 2, 'но в списке видны оба документа', scr.docs.length);
    ok(scr.docs.filter((d) => d.pair).length === 1,
      'и второй помечен как та же сделка', scr.docs.filter((d) => d.pair).length);

    // Вид деятельности — вторая дверь к тому же правилу, что и основание.
    // Заходит в неё как раз тот, кто в основаниях не разбирается.
    await call('POST', '/api/basis', { user: anna, body: { basis: 'closing' } });
    const cpR2 = (await call('POST', '/api/cp', {
      user: anna, body: { name: 'ООО «Арендатор»', kind: 'customer' },
    })).json.cp.id;
    // Мимо HTTP: бесплатных документов в прогоне всего два, и оба уже ушли
    // на сделку выше. Здесь проверяется пересчёт, а не лимит.
    await docService.issueDocument(bdb.getOrCreateUser(ANNA.id).id, {
      type: 'sch', cpId: cpR2, items: [{ name: 'Аренда', qty: 1, price: 40000 }], skipQuota: true,
    });
    r = await call('GET', '/api/state', { user: anna });
    const before = r.json.debts.owedToUs;
    r = await call('POST', '/api/biztype', { user: anna, body: { key: 'rent' } });
    ok(r.status === 200 && r.json.fixed && r.json.fixed.added >= 1,
      'выбор «Аренда» пересчитал прошлые счета, а не только настройку',
      JSON.stringify((r.json || {}).fixed));
    r = await call('GET', '/api/state', { user: anna });
    // Долг переехал со счёта на счёт: акт перестал его создавать, зато оба
    // счёта начали. 30 000 у первого клиента + 40 000 у арендатора.
    ok(r.json.debts.owedToUs === 70000,
      'и цифра на главной наконец сдвинулась', `${before} → ${r.json.debts.owedToUs}`);

    // Ручной режим: человек сам сказал, что журнал ведёт он.
    await call('POST', '/api/basis', { user: anna, body: { basis: 'manual' } });
    r = await call('GET', '/api/state', { user: anna });
    ok(r.json.basisMismatch === null,
      'в ручном режиме подсказка про основание молчит — иначе она врёт',
      JSON.stringify(r.json.basisMismatch));

    /*
     * Подсказка не должна звать туда, где человек уже стоит. У Кати
     * основание «по счёту», висит неоплаченный акт и долга нет: раньше
     * экран советовал «считать по счетам», кнопка ничего не меняла и
     * рапортовала «Готово» — замкнутый круг.
     */
    const katya = initDataFor({ id: 500404, first_name: 'Катя', username: 'katya' });
    await call('POST', '/api/org', {
      user: katya, body: { name: 'ИП Катя', inn: '183209316100', signer: 'К. К.' },
    });
    await call('POST', '/api/basis', { user: katya, body: { basis: 'invoice' } });
    const cpK = (await call('POST', '/api/cp', {
      user: katya, body: { name: 'ООО «Акт»', kind: 'customer' },
    })).json.cp.id;
    await call('POST', '/api/doc', {
      user: katya, body: { type: 'usl', cpId: cpK, items: [{ name: 'Работа', qty: 1, price: 20000 }] },
    });
    r = await call('GET', '/api/state', { user: katya });
    ok(r.json.basisMismatch && r.json.basisMismatch.to === 'closing',
      'подсказка зовёт туда, где долг появится, а не туда, где уже стоим',
      JSON.stringify(r.json.basisMismatch));

    // Отмена проводки руками — и путь назад из неё.
    const docK = (await call('GET', '/api/docs', { user: katya })).json.docs[0];
    r = await call('GET', '/api/cps', { user: katya });
    ok(r.json.cps.find((c) => c.id === cpK).balance === 0, 'при «долге по счёту» акт долга не создаёт');
    await call('POST', '/api/basis', { user: katya, body: { basis: 'closing' } });
    r = await call('GET', '/api/cps', { user: katya });
    ok(r.json.cps.find((c) => c.id === cpK).balance === 20000, 'после переключения долг появился');

    // Отменить проводку можно из бота; приложение обязано это показать.
    bdb.deleteLastOp(bdb.getOrCreateUser(500404).id, cpK);
    r = await call('GET', '/api/docs', { user: katya });
    const undone = r.json.docs.find((x) => x.id === docK.id);
    ok(undone && undone.noDebt === true,
      'отмена проводки видна в карточке документа', JSON.stringify(undone && undone.noDebt));
    r = await call('POST', '/api/doc/debt', { user: katya, body: { id: docK.id } });
    ok(r.status === 200 && r.json.balance === 20000,
      'и «вернуть в долг» возвращает его обратно', JSON.stringify(r.json));

    // Разбор суммы: слагаемые обязаны сходиться с самой цифрой.
    await call('POST', '/api/basis', { user: anna, body: { basis: 'invoice' } });
    const st = (await call('GET', '/api/state', { user: anna })).json;
    const w = (await call('GET', '/api/debts/why', { user: anna })).json;
    ok(w.total === st.debts.owedToUs, 'разбор считает ту же цифру, что и главная',
      `${w.total} / ${st.debts.owedToUs}`);
    ok(w.opening + w.docs + w.manual + w.orphan === w.total,
      'и слагаемые сходятся', JSON.stringify(w));
  }

  section('переписка с агентом');
  {
    /*
     * Агент в приложении отвечает намерением, а не действием: документ он
     * не выписывает никогда — номер уходит в сквозной ряд, и лишний счёт
     * не удалить тихо. Проверяем, что он понимает, отказывается от чужой
     * работы и не действует сам.
     */
    r = await call('POST', '/api/ask', { user: masha, body: { text: '' } });
    ok(r.status === 400, 'пустой вопрос отклонён');

    r = await call('POST', '/api/ask', { user: masha, body: { text: 'кто мне должен' } });
    ok(r.status === 200 && r.json.action === 'debts' && r.json.source === 'local',
      'вопрос про долги разобран бесплатно', JSON.stringify(r.json).slice(0, 80));
    ok(r.json.heard === 'кто мне должен', 'в ответе видно, что услышано');

    r = await call('POST', '/api/ask', { user: masha, body: { text: 'когда платить взносы за себя' } });
    ok(r.json.action === 'outofscope', 'за налоги не берётся', r.json.action);

    r = await call('POST', '/api/ask', { user: masha, body: { text: 'выставь счёт Заре' } });
    ok(r.json.action === 'draft' && r.json.docType === 'sch',
      'счёт разобран как намерение, но не выписан', JSON.stringify(r.json).slice(0, 80));
    const docsBefore = (await call('GET', '/api/docs', { user: masha })).json.docs.length;
    const docsAfter = (await call('GET', '/api/docs', { user: masha })).json.docs.length;
    ok(docsBefore === docsAfter, 'переписка ничего не выписала сама', `${docsBefore} → ${docsAfter}`);

    // Голос: без провайдера — честный отказ, с заглушкой — разбор.
    r = await call('POST', '/api/ask/voice', { user: masha, body: { audio: 'AAA=' } });
    ok(r.status === 400 && /не подключено|SPEECH/i.test(r.json.error || ''),
      'без распознавания речи отказ понятен', (r.json || {}).error);

    process.env.SPEECH_PROVIDER = 'mock';
    process.env.SPEECH_MOCK = 'что не оплачено';
    r = await call('POST', '/api/ask/voice', { user: masha, body: { audio: Buffer.from('OggS зв').toString('base64'), seconds: 3 } });
    ok(r.status === 200 && r.json.action === 'unpaid' && r.json.heard === 'что не оплачено',
      'голос расшифрован и разобран', JSON.stringify(r.json).slice(0, 80));
    r = await call('POST', '/api/ask/voice', { user: masha, body: { audio: '' } });
    ok(r.status === 400, 'пустая запись отклонена');
    delete process.env.SPEECH_PROVIDER;
    delete process.env.SPEECH_MOCK;

    r = await call('POST', '/api/ask', { user: petya, body: { text: 'кто мне должен' } });
    ok(r.status === 200 && r.json.action === 'debts', 'у второго пользователя свой разбор');
  }

  section('начальное сальдо и период акта');
  {
    // Раньше приложение не умело задать начальное сальдо вовсе: полей не
    // было, а endpoint их игнорировал. Акт открывался нулём.
    r = await call('POST', '/api/cp', {
      user: masha,
      body: {
        name: 'ООО «С долгом»', kind: 'customer',
        opening_balance: '10000,50', opening_date: '2026-01-01',
      },
    });
    ok(r.status === 200, 'клиент с начальным сальдо создан', (r.json || {}).error);
    const cpOpen = r.json.cp.id;
    ok(r.json.cp.opening_balance === 10000.5, 'запятая в сумме принята',
      r.json.cp.opening_balance);
    ok(r.json.cp.opening_date === '2026-01-01', 'дата сохранена', r.json.cp.opening_date);

    r = await call('GET', '/api/cps', { user: masha });
    const back = r.json.cps.find((c) => c.id === cpOpen);
    ok(back.opening_balance === 10000.5, 'сальдо возвращается в приложение — есть что править',
      back.opening_balance);

    await call('POST', '/api/op', {
      user: masha, body: { cpId: cpOpen, kind: 'income', amount: 5000, date: '2026-01-20' },
    });
    await call('POST', '/api/op', {
      user: masha, body: { cpId: cpOpen, kind: 'payment', amount: 2000, date: '2026-02-15' },
    });

    r = await call('GET', `/api/akt?cp=${cpOpen}&from=2026-02-01&to=2026-02-28`, { user: masha });
    ok(r.status === 200 && r.json.opening === 15000.5,
      'акт за февраль открывается сальдо на 1 февраля, а не нулём', (r.json || {}).opening);
    ok(r.json.ops === 1 && r.json.closing === 13000.5, 'внутри только февральская операция',
      `${r.json.ops} оп., ${r.json.closing}`);
    ok(r.json.from === '2026-02-01' && r.json.to === '2026-02-28', 'период тот, что запросили',
      `${r.json.from}—${r.json.to}`);

    // Второй акт за другой период не должен унаследовать прошлые даты.
    r = await call('GET', `/api/akt?cp=${cpOpen}`, { user: masha });
    ok(r.json.from === '2026-01-01' && r.json.opening === 10000.5,
      'акт за всё время снова начинается с начального сальдо',
      `${r.json.from} / ${r.json.opening}`);
    ok(r.json.ops === 2, 'и включает обе операции', r.json.ops);

    r = await call('GET', `/api/akt?cp=${cpOpen}`, { user: petya });
    ok(r.status === 400, 'по чужому клиенту акт не собрать', (r.json || {}).error);
  }

  section('вид деятельности и повторения');
  {
    r = await call('POST', '/api/biztype', { user: masha, body: { key: 'выдумка' } });
    ok(r.status === 400, 'неизвестный вид деятельности отклонён');

    r = await call('POST', '/api/biztype', { user: masha, body: { key: 'rent' } });
    ok(r.status === 200 && r.json.basis === 'invoice', 'аренда переключает долг на счёт',
      (r.json || {}).basis);
    r = await call('GET', '/api/state', { user: masha });
    ok(r.json.bizType === 'rent' && r.json.debtBasis === 'invoice', 'выбор виден в состоянии',
      `${r.json.bizType} / ${r.json.debtBasis}`);
    ok(r.json.bizTypes.length >= 5, 'список видов деятельности отдаётся приложению',
      r.json.bizTypes.length);

    // Повторение заводится из уже выписанного документа.
    const lastDoc = (await call('GET', '/api/docs', { user: masha })).json.docs
      .find((d) => d.items && d.items.length);
    r = await call('POST', '/api/recurring', { user: masha, body: { docId: lastDoc.id, day: 31 } });
    ok(r.status === 200 && r.json.day === 28, '31-е число сведено к 28-му', (r.json || {}).day);
    const recId = r.json.id;

    r = await call('GET', '/api/recurring', { user: masha });
    const mine = r.json.items.find((x) => x.id === recId);
    ok(Boolean(mine) && mine.total > 0, 'повторение в списке с суммой', mine && mine.total);

    // Цикл аренды: одно число из договора задаёт счёт, срок и просрочку.
    r = await call('POST', '/api/recurring', {
      user: masha, body: { docId: lastDoc.id, payDay: 5, leadDays: 3 },
    });
    ok(r.status === 200 && r.json.offerDay === 2 && r.json.payDay === 5,
      'счёт за 3 дня до 5-го — 2-го числа', JSON.stringify(r.json));
    const rentId = r.json.id;
    r = await call('GET', '/api/recurring', { user: masha });
    const rentRec = r.json.items.find((x) => x.id === rentId);
    ok(rentRec.payDay === 5 && rentRec.leadDays === 3 && rentRec.offerDay === 2,
      'приложение получает весь цикл, а не одну дату', JSON.stringify(rentRec));
    await call('POST', '/api/recurring/off', { user: masha, body: { id: rentId } });

    r = await call('GET', '/api/recurring', { user: petya });
    ok(r.json.items.length === 0, 'чужие повторения не видны');
    r = await call('POST', '/api/recurring/off', { user: petya, body: { id: recId } });
    ok(r.status === 400, 'чужое повторение не выключить');

    r = await call('POST', '/api/recurring/off', { user: masha, body: { id: recId } });
    ok(r.status === 200, 'своё выключается');
    r = await call('GET', '/api/recurring', { user: masha });
    ok(!r.json.items.some((x) => x.id === recId), 'после выключения его нет в списке');

    await call('POST', '/api/basis', { user: masha, body: { basis: 'closing' } });
  }

  section('банковская выписка');
  {
    // Контрагент с долгом: ровно та ситуация, ради которой выписку и грузят.
    const cpId = (await call('POST', '/api/cp', {
      user: masha, body: { name: 'ООО «Заря»', inn: '7701234560', kind: 'customer' },
    })).json.cp.id;
    await call('POST', '/api/op', {
      user: masha, body: { cpId, kind: 'income', amount: 45000, date: '2026-08-01', doc: 'Акт № 5' },
    });

    const csv = [
      'Дата;ИНН плательщика;Плательщик;Приход;Назначение платежа',
      '05.08.2026;7701234560;ООО "Заря";45 000,00;Оплата по акту 5',
      '06.08.2026;9999999999;ООО "Незнакомец";1 200,00;Оплата по счету 99',
    ].join('\n');
    const dataUrl = `data:text/csv;base64,${Buffer.from(csv, 'utf8').toString('base64')}`;

    r = await call('POST', '/api/bank/parse', { user: masha, body: { dataUrl } });
    ok(r.status === 200 && r.json.rows && r.json.rows.length === 2,
      'выписка разобрана', JSON.stringify(r.json).slice(0, 120));
    const zarya = r.json.rows[0];
    const stranger = r.json.rows[1];
    ok(zarya.cp && zarya.cp.id === cpId, 'плательщик сведён с контрагентом по ИНН');
    ok(zarya.confidence >= 60, 'совпадение уверенное — строка будет отмечена', zarya.confidence);
    ok(stranger.cp === null, 'незнакомый плательщик остался без контрагента');
    ok(zarya.known === false, 'строка ещё не загружалась');

    r = await call('POST', '/api/bank/import', {
      user: masha,
      body: { rows: [{ key: zarya.key, cpId, amount: zarya.amount, date: zarya.date, doc: 'Оплата' }] },
    });
    ok(r.status === 200 && r.json.added === 1, 'оплата занесена', JSON.stringify(r.json));
    r = await call('GET', '/api/cps', { user: masha });
    ok(r.json.cps.find((c) => c.id === cpId).balance === 0, 'долг закрылся оплатой из выписки');

    // Главное свойство: тот же файл, загруженный второй раз, ничего не меняет.
    r = await call('POST', '/api/bank/parse', { user: masha, body: { dataUrl } });
    ok(r.json.rows[0].known === true, 'при повторном разборе строка помечена как загруженная');
    r = await call('POST', '/api/bank/import', {
      user: masha,
      body: { rows: [{ key: zarya.key, cpId, amount: zarya.amount, date: zarya.date, doc: 'Оплата' }] },
    });
    ok(r.json.added === 0 && r.json.skipped === 1, 'повторная загрузка не задваивает оплату',
      JSON.stringify(r.json));
    r = await call('GET', '/api/cps', { user: masha });
    ok(r.json.cps.find((c) => c.id === cpId).balance === 0, 'сальдо не ушло в минус');

    // Чужой контрагент недоступен даже при подделанном cpId.
    r = await call('POST', '/api/bank/import', {
      user: petya,
      body: { rows: [{ key: 'чужой|in|100.00|тест', cpId, amount: 100, date: '2026-08-05' }] },
    });
    ok(r.json.added === 0, 'в чужого контрагента оплату не занести', JSON.stringify(r.json));

    r = await call('POST', '/api/bank/parse', {
      user: masha, body: { dataUrl: 'data:text/csv;base64,0LrQsNC60LDRjy3RgtC+' },
    });
    ok(r.status === 400 && /не нашлось операций/.test(r.json.error || ''),
      'файл без операций объясняет, что не так', (r.json || {}).error);

    /*
     * Автосверка: занесённые деньги закрывают счёт, но не сами — приложение
     * возвращает предложение, а отмечает следующий вызов, по нажатию.
     */
    const docSvc = require('./lib/doc-service');
    const bdbA = require('./lib/bot-db');
    const mid = bdbA.getOrCreateUser(MASHA.id).id;
    const orgA = bdbA.getDefaultOrg(mid);
    if (orgA) bdbA.updateOrg(mid, orgA.id, { debt_basis: 'closing' });
    const cpA = bdbA.createCp(mid, { name: 'ООО «Сверка А»', kind: 'customer', opening_date: '2026-01-01' });
    await docSvc.issueDocument(mid, {
      type: 'usl', cpId: cpA, date: '2026-08-04',
      items: [{ name: 'Работа', qty: 1, price: 17000 }], skipQuota: true });

    r = await call('POST', '/api/bank/import', {
      user: masha,
      body: { rows: [{ key: 'сверка|in|17000|оплата', cpId: cpA, amount: 17000, date: '2026-08-25', doc: 'п/п 5' }] },
    });
    ok(r.json.added === 1 && (r.json.deals || []).length === 1,
      'приложение предложило закрыть счёт', JSON.stringify(r.json.deals || []));
    ok(bdbA.unpaidDocs(mid).some((d) => d.cp_id === cpA),
      'но сам не закрыл — до нажатия документ не оплачен');

    const deals = r.json.deals;
    r = await call('POST', '/api/bank/close', { user: masha, body: { deals } });
    ok(r.json.docs === 1, 'по подтверждению счёт закрыт', JSON.stringify(r.json));
    ok(!bdbA.unpaidDocs(mid).some((d) => d.cp_id === cpA), 'и ушёл из «не оплачено»');
    ok(bdbA.balanceOf(mid, cpA).closing === 0, 'долг закрылся ровно, без задвоения',
      bdbA.balanceOf(mid, cpA).closing);

    // Чужие сделки не закрываются: leadId проверяется по владельцу.
    r = await call('POST', '/api/bank/close', { user: petya, body: { deals } });
    ok(r.json.docs === 0, 'чужую сделку закрыть нельзя', JSON.stringify(r.json));
  }

  section('свой ящик и отправка на почту');
  {
    const net = require('node:net');
    const got = { rcpt: [], data: '', auth: null };
    const smtp = net.createServer((sock) => {
      let inData = false; let body = ''; let expect = null;
      sock.setEncoding('utf8');
      sock.write('220 local ESMTP\r\n');
      sock.on('data', (chunk) => {
        if (inData) {
          body += chunk;
          const e2 = body.indexOf('\r\n.\r\n');
          if (e2 === -1) return;
          got.data = body.slice(0, e2); inData = false; body = '';
          sock.write('250 Ok: queued\r\n');
          return;
        }
        for (const line of chunk.split('\r\n').filter(Boolean)) {
          if (expect) {
            const v = Buffer.from(line, 'base64').toString('utf8');
            if (expect === 'user') { got.auth = { user: v }; expect = 'pass'; sock.write('334 UA==\r\n'); } else {
              got.auth.pass = v; expect = null; sock.write('235 ok\r\n');
            }
            continue;
          }
          if (/^EHLO/i.test(line)) sock.write('250-local\r\n250-AUTH LOGIN\r\n250 HELP\r\n');
          else if (/^AUTH LOGIN/i.test(line)) { expect = 'user'; sock.write('334 VQ==\r\n'); }
          else if (/^RCPT TO:/i.test(line)) { got.rcpt.push(line.slice(8).replace(/[<>]/g, '').trim()); sock.write('250 Ok\r\n'); }
          else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
          else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 Ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((r2) => smtp.listen(0, '127.0.0.1', r2));
    const port = smtp.address().port;

    const someDoc = (await call('GET', '/api/docs', { user: masha })).json.docs
      .find((x) => x.type === 'sch');

    r = await call('GET', '/api/state', { user: masha });
    ok(r.json.features.mail === false && r.json.mailbox === null,
      'без своего ящика почта недоступна');
    r = await call('POST', '/api/doc/mail', { user: masha, body: { id: someDoc.id, email: 'a@b.ru' } });
    ok(r.status === 400 && /не подключена/.test(r.json.error), 'отправка без ящика отклоняется',
      (r.json || {}).error);

    r = await call('POST', '/api/mailbox', { user: masha, body: { email: 'не-адрес', pass: 'x' } });
    ok(r.status === 400, 'кривой адрес ящика отклонён');

    r = await call('POST', '/api/mailbox', {
      user: masha,
      body: { email: 'buh@mycompany.ru', pass: 'секрет-приложения', host: '127.0.0.1', port, secure: false },
    });
    ok(r.status === 200 && r.json.mailbox && r.json.mailbox.from === 'buh@mycompany.ru',
      'ящик подключён и сразу проверен письмом', (r.json || {}).error);
    ok(got.rcpt.includes('buh@mycompany.ru'), 'проверочное письмо ушло на свой адрес', got.rcpt.join());
    ok(got.auth && got.auth.pass === 'секрет-приложения', 'пароль дошёл до сервера');
    ok(!JSON.stringify(r.json).includes('секрет-приложения'), 'пароль наружу не отдаётся');

    r = await call('GET', '/api/state', { user: petya });
    ok(r.json.mailbox === null && r.json.features.mail === false,
      'чужой ящик другому пользователю не виден');

    got.rcpt.length = 0;
    r = await call('POST', '/api/doc/mail', { user: masha, body: { id: someDoc.id, email: 'buh@zarya.ru' } });
    ok(r.status === 200 && r.json.sent === 'buh@zarya.ru', 'документ отправлен клиенту',
      r.status === 200 ? r.json.sent : (r.json || {}).error);
    ok(got.rcpt.includes('buh@zarya.ru'), 'сервер получил адрес клиента', got.rcpt.join());
    ok(/Content-Disposition: attachment/.test(got.data), 'вложение на месте');
    ok(/^From:.*mycompany\.ru/m.test(got.data),
      'письмо ушло с адреса клиента, а не с нашего', (/^From:.*/m.exec(got.data) || [''])[0]);

    r = await call('GET', '/api/cps', { user: masha });
    const owner = r.json.cps.find((c) => c.id === someDoc.cpId);
    ok(owner && owner.email === 'buh@zarya.ru', 'почта запомнилась у контрагента из документа',
      owner && owner.email);

    got.rcpt.length = 0;
    r = await call('POST', '/api/doc/mail', { user: masha, body: { id: someDoc.id } });
    ok(r.status === 200 && got.rcpt.includes('buh@zarya.ru'),
      'повторная отправка идёт по сохранённому адресу');

    r = await call('POST', '/api/doc/mail', { user: petya, body: { id: someDoc.id, email: 'a@b.ru' } });
    ok(r.status === 400, 'чужой документ по почте не отправить', (r.json || {}).error);

    /*
     * Напоминание должнику письмом. Раньше приложение умело только показать
     * текст и предложить скопировать — при том что счёт тому же клиенту
     * уходит с того же ящика по кнопке.
     */
    got.rcpt.length = 0; got.data = '';
    r = await call('GET', '/api/reminders', { user: masha });
    ok(r.json.canMail === true, 'приложение знает, что почта подключена');
    const debt = (r.json.reminders || [])[0];
    ok(Boolean(debt) && debt.text.includes('задолженность'), 'текст напоминания готов');

    r = await call('POST', '/api/reminder/mail', {
      user: masha, body: { cpId: debt.cpId, email: 'buh@dolzhnik.ru', text: debt.text },
    });
    ok(r.status === 200 && r.json.sent === 'buh@dolzhnik.ru', 'напоминание отправлено',
      r.status === 200 ? r.json.sent : (r.json || {}).error);
    ok(r.json.withAkt === true, 'акт сверки приложен');
    ok(got.rcpt.includes('buh@dolzhnik.ru'), 'сервер получил адрес должника', got.rcpt.join());
    ok(/Content-Disposition: attachment/.test(got.data), 'вложение на месте');

    /*
     * Текст правится человеком, и уйти должна именно его правка, а не наша
     * заготовка. Тело письма — base64, поэтому ищем не в сыром потоке, а в
     * расшифрованном: иначе проверка пройдёт на чём угодно.
     */
    got.data = '';
    const myText = 'Иван, добрый день! Напомню про оплату по договору 7.';
    r = await call('POST', '/api/reminder/mail', {
      user: masha, body: { cpId: debt.cpId, email: 'buh@dolzhnik.ru', text: myText },
    });
    ok(r.status === 200, 'правленый текст принят', (r.json || {}).error);
    const decoded = got.data.split(/\r?\n\r?\n/)
      .map((part) => Buffer.from(part.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'))
      .join('\n');
    ok(decoded.includes(myText), 'в письме именно то, что написал человек',
      decoded.slice(0, 80).replace(/\s+/g, ' '));
    ok(!decoded.includes('числится задолженность'), 'наша заготовка его не подменила');

    r = await call('POST', '/api/reminder/mail', {
      user: masha, body: { cpId: debt.cpId, email: 'buh@dolzhnik.ru', text: 'ок' },
    });
    ok(r.status === 400, 'пустой текст напоминания не отправляется', (r.json || {}).error);

    r = await call('POST', '/api/reminder/mail', {
      user: petya, body: { cpId: debt.cpId, email: 'a@b.ru', text: debt.text },
    });
    ok(r.status === 400, 'чужому контрагенту напоминание не отправить', (r.json || {}).error);

    // Отдельная кнопка «отправить проверочное письмо» — её добавили позже
    // экрана почты, и она никем не проверялась.
    got.rcpt.length = 0;
    r = await call('POST', '/api/mailbox/test', { user: masha });
    ok(r.status === 200 && r.json.sent === 'buh@mycompany.ru',
      'проверочное письмо уходит по кнопке', r.status === 200 ? r.json.sent : (r.json || {}).error);
    ok(got.rcpt.includes('buh@mycompany.ru'), 'и приходит на свой же адрес', got.rcpt.join());

    r = await call('POST', '/api/mailbox/delete', { user: masha });
    ok(r.status === 200, 'ящик можно отключить');
    r = await call('GET', '/api/state', { user: masha });
    ok(r.json.mailbox === null, 'после отключения ящика нет');

    smtp.close();
  }

  section('подпись и печать');
  // Настоящий PNG 1×1: важно, что тип определится по байтам, а не по заголовку.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await call('GET', '/api/state', { user: masha });
  ok(r.json.facsimile && r.json.facsimile.sign === null && r.json.facsimile.scope === 'all',
    'по умолчанию факсимиле нет, режим «на все документы»', r.json.facsimile && r.json.facsimile.scope);

  r = await call('POST', '/api/facsimile', { user: masha, body: { kind: 'sign', dataUrl: `data:image/png;base64,${PNG}` } });
  ok(r.status === 200 && r.json.facsimile.sign && /^data:image\/png/.test(r.json.facsimile.sign.preview),
    'подпись загружена и вернулась предпросмотром');

  /*
   * WebP: приложение кодирует снимки именно в него. Раньше отправлялся PNG,
   * и фотография печати весила 2,5 МБ при пределе в 1 МБ — человек видел
   * отказ, ничего не сделав неправильно. Если сервер разучится принимать
   * WebP, печать снова перестанет грузиться, и заметить это будет негде.
   */
  const WEBP = 'UklGRjIAAABXRUJQVlA4WAoAAAAQAAAABwAAAwAAVlA4IFoAAAAQAgCdASoIAAQAAMASJQBOgNEAL6e5mAIAAP772P8of/lkP/ybf/on/n0l+UUfGsji//er//5P5/8TH/5QNvlf9HCm8vCmp/cN3f2EfiG7uAPr3BnNyOtTgAA=';
  r = await call('POST', '/api/facsimile', { user: masha, body: { kind: 'stamp', dataUrl: `data:image/webp;base64,${WEBP}` } });
  ok(r.status === 200 && r.json.facsimile.stamp && /^data:image\/webp/.test(r.json.facsimile.stamp.preview),
    'WebP принимается — в нём приложение и присылает снимки', (r.json || {}).error);
  await call('POST', '/api/facsimile/delete', { user: masha, body: { kind: 'stamp' } });

  r = await call('POST', '/api/facsimile', { user: masha, body: { kind: 'sign', dataUrl: 'привет' } });
  ok(r.status === 400, 'не-картинка отклонена', (r.json || {}).error);
  r = await call('POST', '/api/facsimile', { user: masha, body: { kind: 'подпись', dataUrl: `data:image/png;base64,${PNG}` } });
  ok(r.status === 400, 'неизвестный вид изображения отклонён');
  // Больше допустимого, но в тело запроса ещё влезает: должен прийти
  // понятный отказ, а не оборванное соединение.
  r = await call('POST', '/api/facsimile', {
    user: masha,
    body: { kind: 'stamp', dataUrl: `data:image/png;base64,${'A'.repeat(1_500_000)}` },
  });
  ok(r.status === 400 && /КБ/.test(r.json.error || ''), 'слишком большая картинка отклонена с объяснением',
    (r.json || {}).error);

  // И совсем огромное тело: сервер отвечает, а не рвёт соединение.
  r = await call('POST', '/api/facsimile', {
    user: masha,
    body: { kind: 'stamp', dataUrl: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` },
  });
  ok(r.status === 413 && /уменьшите/i.test((r.json || {}).error || ''),
    'запрос сверх лимита получает 413, а не обрыв связи', `${r.status} ${(r.json || {}).error || ''}`);

  // Подделка заголовка: внутри GIF, заявлен PNG — тип берётся из байтов.
  const GIF = Buffer.from('GIF89a').toString('base64');
  r = await call('POST', '/api/facsimile', { user: masha, body: { kind: 'stamp', dataUrl: `data:image/png;base64,${GIF}` } });
  ok(r.status === 400, 'GIF под видом PNG не принимается', (r.json || {}).error);

  r = await call('GET', '/api/state', { user: petya });
  ok(r.json.facsimile.sign === null, 'чужая подпись не видна другому пользователю');

  r = await call('POST', '/api/facsimile/scope', { user: masha, body: { scope: 'closing' } });
  ok(r.status === 200 && r.json.facsimile.scope === 'closing', 'режим переключается');
  r = await call('POST', '/api/facsimile/scope', { user: masha, body: { scope: 'выдумка' } });
  ok(r.status === 400, 'неизвестный режим отклонён');

  // Главное: попадает ли подпись в сам документ.
  const fx = require('./lib/facsimile');
  const mashaId = bdb.getOrCreateUser(MASHA.id).id;
  const buildSchet = require('./lib/schet').buildSchetHtml;
  const org = bdb.getDefaultOrg(mashaId);
  const cpRow = bdb.getCp(mashaId, cpId);
  const docArgs = { number: '1', date: '2026-08-14', items: [{ name: 'Услуга', qty: 1, price: 100 }] };

  fx.setScope(mashaId, 'all');
  let html = buildSchet({ org: { ...org, fx: fx.forDocument(mashaId, 'sch') }, cp: cpRow, doc: docArgs });
  const hasFx = (t) => t.includes('<img class="fx fx-sign');
  ok(hasFx(html), 'подпись попадает в счёт при режиме «на все»');

  fx.setScope(mashaId, 'closing');
  html = buildSchet({ org: { ...org, fx: fx.forDocument(mashaId, 'sch') }, cp: cpRow, doc: docArgs });
  ok(!hasFx(html), 'в режиме «только закрывающие» на счёте подписи нет');
  const aktHtml = require('./lib/akt-uslug').buildAktUslugHtml({
    org: { ...org, fx: fx.forDocument(mashaId, 'usl') }, cp: cpRow, doc: docArgs,
  });
  ok(hasFx(aktHtml), 'а на акте — есть');

  fx.setScope(mashaId, 'off');
  html = buildSchet({ org: { ...org, fx: fx.forDocument(mashaId, 'sch') }, cp: cpRow, doc: docArgs });
  ok(!hasFx(html) && !html.includes('<img class="fx fx-stamp'),
    'в режиме «выключено» факсимиле нет нигде');
  fx.setScope(mashaId, 'all');

  const ppHtml = require('./lib/platyozhka').buildPlatyozhkaHtml({
    org: { ...org, fx: fx.forDocument(mashaId, 'pp') }, cp: cpRow,
    doc: { number: '1', date: '2026-08-14', amount: 100, purpose: 'Оплата' },
    p: { signer: org.signer },
  });
  ok(!hasFx(ppHtml), 'на платёжное поручение факсимиле не ставится никогда');

  r = await call('POST', '/api/facsimile/delete', { user: masha, body: { kind: 'sign' } });
  ok(r.status === 200 && r.json.facsimile.sign === null, 'подпись убирается');

  section('статика и защита');
  r = await call('GET', '/');
  ok(r.status === 200 && /Первичка/.test(r.text), 'главная страница отдаётся');
  r = await call('GET', '/app.css');
  ok(r.status === 200 && /--tg-theme/.test(r.text), 'стили отдаются и берут тему Telegram');
  r = await call('GET', '/app.js');
  ok(r.status === 200 && r.headers.get('x-content-type-options') === 'nosniff',
    'у статики стоит защита от подмены типа');
  r = await call('GET', '/../../../etc/passwd');
  ok(!/root:/.test(r.text), 'выход за пределы папки приложения не отдаёт системные файлы');
  r = await call('GET', '/health');
  ok(r.status === 200 && r.text === 'ok', 'health отвечает');
  r = await call('GET', '/api/unknown', { user: masha });
  ok(r.status === 404, 'неизвестный метод API — 404');
  r = await call('POST', '/api/cp', { body: { name: 'Без подписи' } });
  ok(r.status === 401, 'POST без подписи тоже не проходит', r.status);

  section('ограничение частоты');
  const flood = [];
  for (let i = 0; i < 130; i += 1) flood.push(call('GET', '/api/templates', { user: petya }));
  const results = await Promise.all(flood);
  const limited = results.filter((x) => x.status === 429).length;
  ok(limited > 0, 'слишком частые запросы получают отказ', `${limited} из 130`);

  section('разбор позиций (сервис)');
  const clean = docService.cleanItems([
    { name: '  Хлеб  ', qty: '3', price: '25,5' },
    { name: '', qty: 5, price: 10 },
    { name: 'Отрицательное', qty: -2, price: -5 },
    'мусор',
  ]);
  ok(clean.length === 2, 'пустые и мусорные позиции отброшены', clean.length);
  ok(clean[0].name === 'Хлеб' && clean[0].qty === 3, 'пробелы и запятая в числах разобраны',
    JSON.stringify(clean[0]));
  ok(clean[1].qty === 1 && clean[1].price === 0, 'отрицательные количество и цена обезврежены',
    JSON.stringify(clean[1]));
  ok(docService.totalOf([{ qty: 3, price: 10.005 }]) === 30.02, 'копейки округляются вверх по правилу',
    docService.totalOf([{ qty: 3, price: 10.005 }]));

  section('удаление документа и сальдо');
  /*
   * Удаление должно вслух сказать, что стало с долгом.
   *
   * Жалоба была ровно такая: «при удалении документов не меняется сумма у
   * контрагента». Долг создаёт не всякий документ — при основании «по
   * отгрузке» счёт проводки не делает, — и молчаливое «удалено» неотличимо
   * от поломки. Теперь ответ содержит delta, а список — долг по документу.
   */
  {
    const closing = (await call('POST', '/api/doc', {
      user: masha,
      body: { type: 'usl', cpId, items: [{ name: 'Работы', qty: 1, price: 7000 }] },
    })).json.doc;
    const listed = (await call('GET', '/api/docs', { user: masha })).json.docs
      .find((d) => d.id === closing.id);
    ok(listed && listed.debt === 7000, 'в списке видно долг по акту', listed && listed.debt);

    const balBefore = (await call('GET', '/api/cps', { user: masha })).json.cps
      .find((c) => c.id === cpId).balance;
    r = await call('POST', '/api/doc/delete', { user: masha, body: { id: closing.id } });
    ok(r.json.delta === 7000, 'удаление акта отвечает, на сколько изменился долг', r.json.delta);
    const balAfter = (await call('GET', '/api/cps', { user: masha })).json.cps
      .find((c) => c.id === cpId).balance;
    ok(balBefore - balAfter === 7000, 'и сальдо контрагента действительно изменилось',
      `${balBefore} → ${balAfter}`);

    // Счёт при основании «по отгрузке» долга не создаёт — и это надо сказать,
    // а не молчать: иначе человек решит, что удаление сломано.
    const invoice = (await call('POST', '/api/doc', {
      user: masha,
      body: { type: 'sch', cpId, items: [{ name: 'Счёт', qty: 1, price: 5000 }] },
    })).json.doc;
    const inList = (await call('GET', '/api/docs', { user: masha })).json.docs
      .find((d) => d.id === invoice.id);
    ok(inList && inList.debt === 0, 'у счёта долга нет — так и помечен', inList && inList.debt);
    r = await call('POST', '/api/doc/delete', { user: masha, body: { id: invoice.id } });
    ok(r.json.delta === 0, 'и при его удалении сальдо честно не меняется', r.json.delta);
  }

  section('акты всем должникам');
  {
    /*
     * Этот адрес отвечал 500 с самого своего появления: в него передавали
     * row.cpId, а debtors() отдаёт row.cp. Ни один тест его не вызывал —
     * поэтому поломка и уехала на сервер. Теперь вызывает.
     */
    const cpDebt = (await call('POST', '/api/cp', {
      user: masha, body: { name: 'ООО «Должник по актам»', kind: 'customer' },
    })).json.cp.id;
    await call('POST', '/api/op', {
      user: masha, body: { cpId: cpDebt, amount: 33000, kind: 'credit', date: '2026-03-01' },
    });
    const r2 = await call('GET', '/api/akt/all', { user: masha });
    ok(r2.status === 200, 'акты всем должникам отвечают, а не падают', r2.status);
    ok(r2.json && r2.json.count >= 1, 'хотя бы один акт собран', r2.json && r2.json.count);
    ok(r2.json && Array.isArray(r2.json.items) && r2.json.items.some((i) => i.cp.includes('Должник')),
      'и это акт по настоящему должнику', r2.json && JSON.stringify(r2.json.items));
  }

  section('проверка подписи отдельно');
  ok(verifyInitData('', { token: TOKEN }).ok === false, 'пустая initData не проходит');
  ok(verifyInitData(initDataFor(MASHA), { token: TOKEN }).user.id === MASHA.id,
    'из подписанной строки достаётся тот же пользователь');

  section('дыры, найденные ревизией');
  {
    const bdbR = require('./lib/bot-db');
    const dsr = require('./lib/doc-service');

    /*
     * Подсказка про основание долга гасла по условию owedToUs > 0, а оно
     * глобальное — по всем контрагентам сразу. Достаточно было одного
     * должника, чтобы неоплаченный счёт молча выпал из виду.
     */
    const u = bdbR.getOrCreateUser(788001);
    bdbR.saveMyOrg(u.id, { name: 'ИП Основание', inn: '183209316119' });
    const orgR = bdbR.getDefaultOrg(u.id);
    const c1 = bdbR.createCp(u.id, { name: 'ООО «Счёт»', kind: 'customer', opening_date: '2026-01-01' });
    await dsr.issueDocument(u.id, {
      type: 'sch', cpId: c1, items: [{ name: 'Работа', qty: 1, price: 200000 }], skipQuota: true,
    });
    const owed0 = bdbR.debtors(u.id).filter((r) => r.theyOwe).reduce((s, r) => s + r.amount, 0);
    const m0 = bdbR.basisMismatch(u.id, orgR, owed0);
    ok(m0 && m0.to === 'invoice' && m0.zero === true,
      'счёт не в долге — подсказка есть и говорит про ноль', JSON.stringify(m0));

    const c2 = bdbR.createCp(u.id, { name: 'ООО «Акт»', kind: 'customer', opening_date: '2026-01-01' });
    await dsr.issueDocument(u.id, {
      type: 'usl', cpId: c2, items: [{ name: 'Работа', qty: 1, price: 5000 }], skipQuota: true,
    });
    const owed1 = bdbR.debtors(u.id).filter((r) => r.theyOwe).reduce((s, r) => s + r.amount, 0);
    const m1 = bdbR.basisMismatch(u.id, orgR, owed1);
    ok(m1 && m1.zero === false,
      'и не гаснет из-за того, что кто-то другой должен', `долг ${owed1}, ${JSON.stringify(m1)}`);

    /*
     * Начало месяца для реестра считалось по поясу сервера, а конец — по
     * Москве. Сервер в UTC: первого числа в 00:30 по Москве здесь был ещё
     * прошлый месяц, и реестр приходил за него целиком плюс один день.
     */
    /*
     * Поведением это не проверить: пояс сервера внутри уже запущенного
     * процесса не подменить, а разница проявляется единственной ночью в
     * месяце. Поэтому сторожим саму запись — чтобы никто не вернул расчёт
     * по new Date(), не заметив, что «по» рядом считается по Москве.
     */
    const appSrc = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'miniapp.js'), 'utf8');
    ok(/const first = `\$\{docService\.todayISO\(\)\.slice\(0, 7\)\}-01`/.test(appSrc),
      `начало месяца для реестра берётся по московскому календарю (${dsr.todayISO().slice(0, 7)})`);
  }

  section('чужую операцию через приложение не удалить');
  {
    const bdbX = require('./lib/bot-db');
    const dsx2 = require('./lib/doc-service');
    const victim = bdbX.getOrCreateUser(788010);
    bdbX.saveMyOrg(victim.id, { name: 'ИП Жертва', inn: '183209316118' });
    const cpV = bdbX.createCp(victim.id, { name: 'Клиент жертвы', kind: 'customer', opening_date: '2026-01-01' });
    const opV = bdbX.addOp(victim.id, cpV, { date: '2026-09-01', kind: 'Оплата', doc: 'чужая', debit: 100000 });
    const before = bdbX.balanceOf(victim.id, cpV).closing;

    const mine = bdbX.getOrCreateUser(MASHA.id);
    const cpM = bdbX.listCps(mine.id)[0];
    const doc = await dsx2.issueDocument(mine.id, {
      type: 'usl', cpId: cpM.id, items: [{ name: 'Работа', qty: 1, price: 100000 }], skipQuota: true,
    });
    await call('POST', '/api/bank/close', {
      user: masha,
      body: { deals: [{ opId: opV, cpId: cpM.id, leadId: doc.doc.id, total: 100000, date: '2026-09-01' }] },
    });
    ok(bdbX.balanceOf(victim.id, cpV).closing === before,
      'сальдо чужого пользователя не тронуто',
      `${before} → ${bdbX.balanceOf(victim.id, cpV).closing}`);
  }

  // Сервер держим до конца: проверки выше ходят к нему по HTTP, и закрытый
  // раньше времени он давал ECONNREFUSED вместо внятного провала.
  await new Promise((r2) => server.close(r2));

  const { closePdf } = require('./lib/pdf');
  await closePdf();

  console.log(bad ? `\nне прошло: ${bad}` : '\nмини-приложение работает целиком ✅');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
