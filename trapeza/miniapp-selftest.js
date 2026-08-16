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
const { server, setTelegram } = require('./miniapp');

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

  console.log('\n── подпись и доступ ──');
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

  console.log('\n── организация и контрагенты ──');
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

  console.log('\n── выписка документа ──');
  sentToChat.length = 0;
  r = await call('POST', '/api/doc', {
    user: masha,
    body: {
      type: 'sch',
      cpId,
      date: '2026-08-14',
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

  console.log('\n── лимит бесплатных ──');
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

  console.log('\n── код доступа ──');
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

  console.log('\n── Excel: акт сверки и реестр ──');
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

  console.log('\n── удаление документа ──');
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

  console.log('\n── журнал и копии ──');
  r = await call('GET', '/api/docs', { user: masha });
  const docs = r.json.docs;
  ok(docs.length === 3, 'в журнале три выписанных документа', docs.length);
  ok(docs[0].items.length === 1, 'позиции сохранились вместе с документом', docs[0].items.length);

  r = await call('GET', '/api/docs', { user: petya });
  ok(r.json.docs.length === 0, 'чужой журнал пуст');

  sentToChat.length = 0;
  r = await call('POST', '/api/doc/resend', { user: masha, body: { id: docs[0].id } });
  ok(r.status === 200 && sentToChat.length === 1, 'копия документа пересобрана и отправлена');
  r = await call('POST', '/api/doc/resend', { user: petya, body: { id: docs[0].id } });
  ok(r.status === 400, 'чужой документ не пересобрать', (r.json || {}).error);

  console.log('\n── подсказки по реквизитам ──');
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

  console.log('\n── долг и оплата ──');
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

  console.log('\n── банковская выписка ──');
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
  }

  console.log('\n── свой ящик и отправка на почту ──');
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

  console.log('\n── подпись и печать ──');
  // Настоящий PNG 1×1: важно, что тип определится по байтам, а не по заголовку.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await call('GET', '/api/state', { user: masha });
  ok(r.json.facsimile && r.json.facsimile.sign === null && r.json.facsimile.scope === 'all',
    'по умолчанию факсимиле нет, режим «на все документы»', r.json.facsimile && r.json.facsimile.scope);

  r = await call('POST', '/api/facsimile', { user: masha, body: { kind: 'sign', dataUrl: `data:image/png;base64,${PNG}` } });
  ok(r.status === 200 && r.json.facsimile.sign && /^data:image\/png/.test(r.json.facsimile.sign.preview),
    'подпись загружена и вернулась предпросмотром');

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

  console.log('\n── статика и защита ──');
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

  console.log('\n── ограничение частоты ──');
  const flood = [];
  for (let i = 0; i < 130; i += 1) flood.push(call('GET', '/api/templates', { user: petya }));
  const results = await Promise.all(flood);
  const limited = results.filter((x) => x.status === 429).length;
  ok(limited > 0, 'слишком частые запросы получают отказ', `${limited} из 130`);

  console.log('\n── разбор позиций (сервис) ──');
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

  console.log('\n── проверка подписи отдельно ──');
  ok(verifyInitData('', { token: TOKEN }).ok === false, 'пустая initData не проходит');
  ok(verifyInitData(initDataFor(MASHA), { token: TOKEN }).user.id === MASHA.id,
    'из подписанной строки достаётся тот же пользователь');

  await new Promise((r2) => server.close(r2));
  const { closePdf } = require('./lib/pdf');
  await closePdf();

  console.log(bad ? `\nне прошло: ${bad}` : '\nмини-приложение работает целиком ✅');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
