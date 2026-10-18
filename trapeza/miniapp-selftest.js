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

/*
 * Ключи провайдеров убираем: прогон не должен зависеть от того, что лежит
 * в окружении запускающего. Проверка «без распознавания речи отказ понятен»
 * гасит SPEECH_PROVIDER, но одного YANDEX_API_KEY в окружении довольно,
 * чтобы модуль счёл себя настроенным, — и прогон получал другой отказ, а то
 * и ходил в сеть. Нужный ключ блок ставит себе сам.
 */
for (const k of ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'XAI_API_KEY', 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID',
  'VISION_PROVIDER', 'SPEECH_PROVIDER', 'AI_PROVIDER', 'AI_ENABLED', 'AI_MODEL',
  'AI_MOCK', 'AI_MOCK_USAGE', 'DADATA_TOKEN']) {
  delete process.env[k];
}
// DADATA_MOCK — это карта «значение → ответ справочника», а не флаг:
// так прогон проверяет и разбор ответа, а не только факт вызова.
// Данные выдуманные: настоящих организаций и людей в тестах не держим.
process.env.MAIL_KEY = 'test-mail-key';
// Игрушечный SMTP этого прогона слушает 127.0.0.1 на случайном порту, а
// обычно ящик на внутреннем адресе заводить нельзя: поле «сервер» иначе
// превращается в сканер нашей сети. Сам запрет проверяется в mail-selftest.
process.env.MAIL_ALLOW_LOCAL = '1';
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
  async sendDocument(chatId, { filename, caption, buttons }) {
    sentToChat.push({ chatId, filename, caption, buttons: buttons || [] });
    return {};
  },
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

  {
    /*
     * Несколько организаций на одном аккаунте.
     *
     * Приложение обязано не только уметь переключаться, но и заводить новую
     * так, чтобы она не перезаписала старую: POST /api/org правит ТЕКУЩУЮ,
     * поэтому /api/org/add сперва переключается на свежую. Без этого человек
     * заполнил бы анкету второй фирмы, а переписал бы ею первую — и заметил
     * бы по чужим реквизитам в ближайшем счёте.
     */
    const one = await call('GET', '/api/orgs', { user: masha });
    ok(one.status === 200 && one.json.orgs.length === 1,
      'пока организация одна', one.json && one.json.orgs.length);
    const firstId = one.json.active;
    const firstName = one.json.orgs[0].name;

    const added = await call('POST', '/api/org/add', { user: masha });
    ok(added.status === 200 && added.json.active !== firstId,
      'новая организация заведена и стала текущей', JSON.stringify(added.json));

    await call('POST', '/api/org', {
      user: masha, body: { name: 'ООО «Вторая»', inn: '7707083893' },
    });
    const two = await call('GET', '/api/orgs', { user: masha });
    ok(two.json.orgs.length === 2, 'организаций стало две', two.json.orgs.length);
    ok((two.json.orgs.find((o) => o.id === firstId) || {}).name === firstName,
      'и первая не перезаписана второй', JSON.stringify(two.json.orgs.map((o) => o.name)));

    // Переключение туда и обратно.
    const back = await call('POST', '/api/org/use', { user: masha, body: { id: firstId } });
    ok(back.status === 200 && back.json.active === firstId,
      'переключились обратно на первую', JSON.stringify(back.json));
    const st = await call('GET', '/api/state', { user: masha });
    ok(st.json.org && st.json.org.id === firstId,
      'и главный экран показывает её реквизиты', st.json.org && st.json.org.name);

    // Чужую не подсунуть.
    const alien = await call('POST', '/api/org/use', { user: petya, body: { id: firstId } });
    ok(alien.status === 400, 'на чужую организацию переключиться нельзя', alien.status);

    /*
     * Третью не заводим: в тариф входит две.
     *
     * Отказываем ДО анкеты, а не после. Пустить и выставить счёт потом
     * значит однажды отключить фирму за неоплату — то есть запереть чужой
     * учёт вместе с её документами.
     */
    const third = await call('POST', '/api/org/add', { user: masha });
    ok(third.status === 400 && third.json.reason === 'orgs',
      'третья организация не заводится — предел тарифа', JSON.stringify(third.json));
    ok(/поддержку/.test(third.json.error || ''),
      'и сказано, куда идти за местом', third.json.error);
    const still = await call('GET', '/api/orgs', { user: masha });
    ok(still.json.orgs.length === 2, 'а две уже заведённые на месте', still.json.orgs.length);

    // После доплаты место открывается, и заведённое не трогается.
    const bdbQ = require('./lib/bot-db');
    bdbQ.grantOrgSlots(bdbQ.getOrCreateUser(MASHA.id).id, 1);
    const paid = await call('POST', '/api/org/add', { user: masha });
    ok(paid.status === 200, 'с оплаченным местом третья заводится', JSON.stringify(paid.json));

    /*
     * Прибираем за собой: третью убираем, возвращаемся на первую.
     *
     * Проверки ниже смотрят список контрагентов, а он теперь сортируется
     * «свои выше чужих». Оставшись на свежей фирме, где своих нет вовсе, мы
     * поменяли бы порядок списка — и уронили бы соседнюю проверку не своей
     * ошибкой, а мусором в состоянии.
     */
    require('./db').db.prepare('DELETE FROM orgs WHERE id = ?').run(paid.json.active);
    await call('POST', '/api/org/use', { user: masha, body: { id: firstId } });
  }

  /*
   * Числовые реквизиты режутся по цифрам, а не по знакам.
   *
   * Раньше поля обрезал общий str(): «ИНН 7707083893» проходил проверку
   * контрольной суммы (она сама выбрасывает нецифровое) и ложился в базу как
   * «ИНН 77070838» — двенадцать знаков, из них восемь цифр. Проверялось одно
   * значение, печаталось другое, и в счетах стоял несуществующий ИНН.
   */
  {
    r = await call('POST', '/api/cp', {
      user: masha,
      body: { name: 'ООО «С подписью»', inn: 'ИНН 7707083893', kind: 'customer' },
    });
    ok(r.status === 200 && r.json.cp, 'контрагент с подписанным ИНН заведён', (r.json || {}).error);
    ok(r.json.cp && r.json.cp.inn === '7707083893',
      'в базу лёг сам ИНН, а не обрезанная подпись', r.json.cp && r.json.cp.inn);

    /*
     * И обратная беда: счёт, скопированный из банка по четыре цифры,
     * обрезался до шестнадцати и отклонялся по контрольной сумме, хотя с ним
     * всё было в порядке.
     */
    r = await call('POST', '/api/cp', {
      user: masha,
      body: { name: 'ООО «Пробелы»', kind: 'customer',
        bik: '044525974', acc: '4080 2810 7000 0555 5552', corr_acc: '30101810145250000974' },
    });
    ok(r.status === 200 && r.json.cp, 'счёт с пробелами по четыре принят, а не отклонён',
      (r.json || {}).error);
    ok(r.json.cp && r.json.cp.acc === '40802810700005555552',
      'и лёг двадцатью цифрами — в QR по ГОСТ пробелам места нет', r.json.cp && r.json.cp.acc);
  }

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

  section('чат называет клиента — открывается он же');
  {
    /*
     * Ошибка, которую поймал владелец: чат писал «Готовлю документ для
     * „Заря“», а на экране стоял совсем другой контрагент.
     *
     * Виноваты были два звена сразу: /api/ask отдавал только имя словами и
     * не искал по нему клиента, а экран черновика при отсутствии cpId молча
     * подставлял ПЕРВОГО из списка. Выписать документ не тому клиенту — из
     * тех ошибок, что замечают у контрагента, а не у себя.
     */
    process.env.AI_ENABLED = '1';
    process.env.AI_PROVIDER = 'mock';

    r = await call('POST', '/api/ask', { user: masha, body: { text: 'выставь Заре счёт на 1000' } });
    ok(r.json.action === 'draft', 'фраза разобрана как черновик', JSON.stringify(r.json).slice(0, 120));
    ok(Number(r.json.cpId) === cpId && r.json.cpName === 'ООО «Заря»',
      'сервер сам нашёл контрагента по имени и вернул его id',
      `${r.json.cpId} / ${r.json.cpName}`);

    r = await call('POST', '/api/ask', { user: masha, body: { text: 'выставь Неизвестному Клиенту счёт на 1000' } });
    ok(r.json.cpMissing === true && !r.json.cpId,
      'ненайденный клиент помечен, а чужой id не подставлен', JSON.stringify(r.json).slice(0, 140));

    delete process.env.AI_PROVIDER;
    delete process.env.AI_ENABLED;
  }

  section('оплата словами в приложении');
  {
    /*
     * Тот же путь, что в боте, но через приложение: фраза внутрь — изменённый
     * журнал наружу. Раньше действия «внести оплату» не существовало вовсе,
     * и фраза уходила в пустоту.
     */
    process.env.AI_ENABLED = '1';
    process.env.AI_PROVIDER = 'mock';
    const bdbA = require('./lib/bot-db');
    const mashaId2 = bdbA.getOrCreateUser(MASHA.id).id;
    const cpPay = bdbA.createCp(mashaId2, { name: 'ООО «Оплата»', kind: 'customer', opening_date: '2026-01-01' });
    bdbA.addOp(mashaId2, cpPay, { date: '2026-08-01', kind: 'Приход', credit: 40000 });

    r = await call('POST', '/api/ask', { user: masha, body: { text: 'проведи оплату по Оплата 10000' } });
    ok(r.json.action === 'pay' && Number(r.json.cpId) === cpPay && r.json.amount === 10000,
      'фраза разобрана как оплата и клиент найден', JSON.stringify(r.json).slice(0, 130));

    // «Собери КУДиР» — не отказ «налоги не веду», а подсказка, куда прислать выписку.
    r = await call('POST', '/api/ask', { user: masha, body: { text: 'собери КУДиР' } });
    ok(r.json.action === 'kudir' && /выписк/.test(r.json.replyText || '') && !/не веду/.test(r.json.replyText || ''),
      'на «собери КУДиР» приложение объясняет, как собрать книгу', JSON.stringify(r.json).slice(0, 140));

    r = await call('POST', '/api/pay', { user: masha, body: { cpId: cpPay, amount: 10000 } });
    ok(r.status === 200 && r.json.balance === 30000,
      'проводка внесена, сальдо 40 000 − 10 000', JSON.stringify(r.json));

    r = await call('POST', '/api/op/delete', { user: masha, body: { id: r.json.id, cpId: cpPay } });
    ok(r.status === 200, 'и её можно отменить тем же путём, что рисует кнопка', r.status);
    ok(bdbA.balanceOf(mashaId2, cpPay).closing === 40000, 'сальдо вернулось');

    r = await call('POST', '/api/pay', { user: petya, body: { cpId: cpPay, amount: 5 } });
    ok(r.status === 400, 'по чужому контрагенту проводку не внести', r.status);

    r = await call('POST', '/api/pay', { user: masha, body: { cpId: cpPay, amount: 0 } });
    ok(r.status === 400, 'нулевая сумма отклоняется', (r.json || {}).error);

    // Дата ложилась в журнал любой строкой — и операция выпадала из всех
    // периодов: ни в акт, ни в отчёт она уже не попадала.
    for (const bad of ['вчера', '2026-02-31', '2026-13-01']) {
      r = await call('POST', '/api/pay', { user: masha, body: { cpId: cpPay, amount: 100, date: bad } });
      ok(r.status === 400, `дата «${bad}» в оплате отклоняется`, JSON.stringify(r.json));
      r = await call('POST', '/api/op', { user: masha, body: { cpId: cpPay, amount: 100, date: bad } });
      ok(r.status === 400, `и в журнале тоже — «${bad}»`, JSON.stringify(r.json).slice(0, 80));
    }
    ok(bdbA.balanceOf(mashaId2, cpPay).closing === 40000, 'ни одна кривая дата в журнал не попала',
      bdbA.balanceOf(mashaId2, cpPay).closing);

    delete process.env.AI_PROVIDER;
    delete process.env.AI_ENABLED;
  }

  section('счета-фактуры в приложении');
  {
    /*
     * Те же три документа, что в боте, но через приложение — путь целиком:
     * запрос внутрь, файл и запись в журнале наружу.
     */
    /*
     * Отдельный пользователь, а не Маша.
     *
     * Здесь выписывается пять документов подряд, а бесплатных в месяц два —
     * и выдача Маше доступа ломала бы соседние проверки, которые как раз на
     * этот лимит и рассчитаны. Свой человек со своим доступом никому не мешает.
     */
    const SF = { id: 500404, first_name: 'Сергей', username: 'sf' };
    const sfUser = initDataFor(SF);
    const bdbS = require('./lib/bot-db');
    const mid = bdbS.getOrCreateUser(SF.id).id;
    bdbS.saveMyOrg(mid, { name: 'ООО «СФ»', inn: '7701234567', acc: '40702810900000000001', bik: '044525974' });
    const orgS = bdbS.getDefaultOrg(mid);
    bdbS.updateOrg(mid, orgS.id, { vat_rate: '22', npd: 0 });
    require('./lib/billing').grantDays(mid, 30);
    const cpS = bdbS.createCp(mid, { name: 'ООО «Покупатель СФ»', inn: '7707654321', kind: 'customer', opening_date: '2026-01-01' });

    // --- аванс ---
    sentToChat.length = 0;
    r = await call('POST', '/api/doc/avans', { user: sfUser, body: {
      cpId: cpS, sum: 100000, payDoc: '№ 55 от 01.09.2026', subject: 'Монтаж' } });
    ok(r.status === 200 && r.json.vat === 18032.79,
      'аванс выписан, налог по расчётной ставке', JSON.stringify(r.json && r.json.vat));
    ok(r.json.file && /СФ_аванс/.test(r.json.file.name), 'и файл отдан приложению',
      (r.json.file || {}).name);

    /*
     * Аванс тоже обязан прийти в чат.
     *
     * Здесь была тихая поломка: sendToChat читал res.doc.cp.name, а issueFlat
     * (аванс и корректировочный) отдаёт сырую строку из базы, где есть только
     * cp_id. Обращение к undefined.name падало, вызов обёрнут в
     * .catch(() => {}) — и человек выписывал счёт-фактуру, а в чат не
     * приходило НИЧЕГО. Ни ошибки, ни следа.
     */
    ok(sentToChat.length === 1, 'счёт-фактура на аванс дошёл до чата', sentToChat.length);
    ok(/Покупатель СФ/.test((sentToChat[0] || {}).caption || ''),
      'и в подписи назван клиент, а не пустое место', (sentToChat[0] || {}).caption);

    r = await call('POST', '/api/doc/avans', { user: sfUser, body: { cpId: cpS, sum: 0 } });
    ok(r.status === 400, 'нулевая предоплата отклоняется', (r.json || {}).error);

    // --- отгрузка со ссылкой на аванс ---
    r = await call('POST', '/api/doc', { user: sfUser, body: {
      type: 'upd', cpId: cpS, items: [{ name: 'Монтаж', qty: 1, price: 150000 }], vatRate: 22, status: 1 } });
    const shipId = r.json.doc.id;
    ok(r.status === 200, 'УПД выписан через приложение', (r.json || {}).error);
    ok(/^№ \d+ от /.test(String((bdbS.getDoc(mid, shipId).payload || {}).advDoc || '')),
      'строка 5б заполнилась сама', (bdbS.getDoc(mid, shipId).payload || {}).advDoc);

    // --- основание накладной: своё, из карточки или «Без договора» ---
    {
      const payloadOf = (res) => (bdbS.getDoc(mid, ((res.json || {}).doc || {}).id) || {}).payload || {};
      r = await call('POST', '/api/doc', { user: sfUser, body: {
        type: 'torg12', cpId: cpS, items: [{ name: 'Кабель', qty: 10, price: 500 }],
        basis: '  Договор поставки № 7 от 01.09.2026  ' } });
      ok(r.status === 200, 'накладная с основанием выписана', (r.json || {}).error);
      ok(payloadOf(r).basis === 'Договор поставки № 7 от 01.09.2026',
        'основание, написанное руками, дошло до документа', payloadOf(r).basis);

      // Без основания и без договора в карточке: прежняя вставка здесь падала,
      // обращаясь к дате раньше, чем та была посчитана.
      r = await call('POST', '/api/doc', { user: sfUser, body: {
        type: 'torg12', cpId: cpS, items: [{ name: 'Кабель', qty: 1, price: 500 }] } });
      ok(r.status === 200, 'без основания накладная тоже выписывается', (r.json || {}).error);
      ok(!('basis' in payloadOf(r)),
        'пустое основание не записывается — шаблон решит по карточке', payloadOf(r).basis);

      r = await call('POST', '/api/doc', { user: sfUser, body: {
        type: 'sch', cpId: cpS, items: [{ name: 'Кабель', qty: 1, price: 500 }], basis: 'Договор № 1' } });
      ok(!('basis' in payloadOf(r)), 'у счёта графы «Основание» нет — и в документ она не попадает');

      const { buildTorg12Html } = require('./lib/torg12');
      const blank = { number: '1', date: '2026-10-05', items: [{ name: 'Кабель', qty: 1, price: 1 }] };
      const cpNoContract = { name: 'Покупатель' };
      const orgT = { name: 'Поставщик' };
      ok(buildTorg12Html({ org: orgT, cp: cpNoContract, doc: { ...blank, basis: 'Заказ № 45' } }).includes('Заказ № 45'),
        'своё основание напечатано в накладной');
      ok(buildTorg12Html({ org: orgT, cp: { ...cpNoContract, contract: 'Договор № 3 от 01.02.2026' }, doc: blank })
        .includes('Договор № 3 от 01.02.2026'), 'без своего — договор из карточки');
      ok(buildTorg12Html({ org: orgT, cp: cpNoContract, doc: blank }).includes('Без договора'),
        'а без договора — «Без договора»');
    }

    // --- что можно корректировать ---
    r = await call('GET', `/api/doc/correctable?cpId=${cpS}`, { user: sfUser });
    ok(r.json.docs.some((d) => d.id === shipId), 'счёт-фактура предлагается к корректировке',
      r.json.docs.length);

    // --- корректировка ---
    r = await call('POST', '/api/doc/ksf', { user: sfUser, body: {
      baseId: shipId, reason: 'Соглашение № 3',
      lines: [{ name: 'Монтаж', qty: 1, price: 130000 }] } });
    ok(r.status === 200 && (r.json.down || {}).total === 24400,
      'корректировка на уменьшение посчитана',
      `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);

    r = await call('POST', '/api/doc/ksf', { user: sfUser, body: {
      baseId: shipId, reason: 'X', lines: [{ name: 'A', qty: 1, price: 1 }, { name: 'B', qty: 1, price: 2 }] } });
    ok(r.status === 400 && /столько же строк/.test((r.json || {}).error || ''),
      'лишняя строка отклоняется с объяснением', (r.json || {}).error);

    r = await call('POST', '/api/doc/ksf', { user: sfUser, body: {
      baseId: shipId, lines: [{ name: 'Монтаж', qty: 1, price: 130000 }] } });
    ok(r.status === 400 && /основания/.test((r.json || {}).error || ''),
      'без основания корректировочный не выписать', (r.json || {}).error);

    /*
     * Смешанная корректировка: одна позиция дорожает, другая дешевеет.
     * В итог документа раньше шло «up.total || down.total» — одно
     * увеличение, а уменьшение на 12 200 пропадало. А корректировка на
     * уменьшение ложилась в реестр с плюсом и прибавлялась к продажам.
     */
    const downDoc = bdbS.getDoc(mid, bdbS.docsBetween(mid, '2000-01-01', '2100-01-01')
      .find((d) => d.type === 'ksf').id);
    ok(downDoc.total === -24400, 'корректировка на уменьшение записана с минусом', downDoc.total);
    r = await call('POST', '/api/doc', { user: sfUser, body: {
      type: 'upd', cpId: cpS, vatRate: 22, status: 1,
      items: [{ name: 'Монтаж', qty: 1, price: 100000 }, { name: 'Материал', qty: 1, price: 50000 }] } });
    const twoId = r.json.doc.id;
    r = await call('POST', '/api/doc/ksf', { user: sfUser, body: {
      baseId: twoId, reason: 'Соглашение № 4',
      lines: [{ name: 'Монтаж', qty: 1, price: 120000 }, { name: 'Материал', qty: 1, price: 40000 }] } });
    ok(r.status === 200 && r.json.up.total === 24400 && r.json.down.total === 12200,
      'увеличение и уменьшение посчитаны раздельно', JSON.stringify([r.json.up, r.json.down]));
    const mixed = bdbS.getDoc(mid, r.json.doc.id);
    ok(mixed.total === 12200, 'в итог документа пошло изменение целиком: +24 400 − 12 200', mixed.total);
    const ExcelJS = require('exceljs');
    const wbR = new ExcelJS.Workbook();
    await wbR.xlsx.load(await require('./lib/xlsx-registry').buildRegistry({
      org: bdbS.getDefaultOrg(mid), from: '2000-01-01', to: '2100-01-01',
      docs: bdbS.docsBetween(mid, '2000-01-01', '2100-01-01').filter((d) => d.id === mixed.id),
    }));
    const regRow = wbR.getWorksheet('Реестр').getRow(6);
    ok(regRow.getCell(5).value === 10000 && regRow.getCell(6).value === 2200 && regRow.getCell(7).value === 12200,
      'и в реестре то же: без НДС +10 000, НДС +2 200',
      [5, 6, 7].map((c) => regRow.getCell(c).value).join(' / '));

    /*
     * Платёжка из приложения шла мимо общей нумерации: номер, введённый
     * руками, не проверялся — выходило две платёжки № 1 за год, — а сумма
     * записывалась с долями копейки.
     */
    r = await call('POST', '/api/doc/other', { user: sfUser, body: {
      type: 'pp', cpId: cpS, amount: 1234.567, purpose: 'Оплата по счёту № 1' } });
    ok(r.status === 200 && r.json.total === 1234.57, 'сумма платёжки округлена до копеек',
      `${r.status} ${JSON.stringify(r.json && r.json.total)}`);
    const ppNo = r.json.doc && r.json.doc.number;
    r = await call('POST', '/api/doc/other', { user: sfUser, body: {
      type: 'pp', cpId: cpS, amount: 100, purpose: 'Ещё', number: ppNo } });
    ok(r.status === 400 && /уже выписан/.test((r.json || {}).error || ''),
      'занятый номер платёжки не пропускается', `${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);

    /*
     * Свой договор из приложения: прочитать файл, сохранить шаблон, выписать
     * по нему. Чужой договор — разбор. Модель — заглушкой (MYCON_PROVIDER).
     */
    {
      const { makeZip } = require('./lib/zip');
      process.env.MYCON_PROVIDER = 'mock';
      process.env.MYCON_MOCK = JSON.stringify({ title: 'Банкетный договор', replacements: [
        { find: '12.05.2026', key: 'event_date', label: 'Дата банкета', type: 'date' },
        { find: '90 000', key: 'price', label: 'Сумма', type: 'money' }] });
      const docxM = makeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>ДОГОВОР</w:t></w:r></w:p>'
        + '<w:p><w:r><w:t>Банкет 12.05.2026 за 90 000 рублей.</w:t></w:r></w:p></w:body></w:document>' });
      const dataUrl = `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${docxM.toString('base64')}`;
      r = await call('POST', '/api/mycontract/analyze', { user: sfUser, body: { dataUrl, name: 'наш.docx' } });
      ok(r.status === 200 && r.json.template && r.json.ask.map((f) => f.key).join(',') === 'event_date,price',
        'приложение прочитало свой договор и нашло поля', JSON.stringify(r.json).slice(0, 120));
      const tplM = r.json.template;
      r = await call('POST', '/api/mycontract/save', { user: sfUser, body: { template: tplM, cpId: 0 } });
      ok(r.status === 200 && r.json.ok, 'шаблон сохранён');
      r = await call('GET', `/api/mycontract?cpId=${cpS}`, { user: sfUser });
      ok(r.status === 200 && r.json.active && r.json.active.title === 'Банкетный договор' && !r.json.active.body,
        'для клиента действует общий шаблон, текст наружу не отдаём лишний раз', JSON.stringify(r.json.active).slice(0, 100));
      r = await call('POST', '/api/doc/other', { user: sfUser, body: {
        type: 'dog', cpId: cpS, tplId: r.json.active.id, values: { event_date: '01.07.2026', price: '120 000', hacker: 'x' } } });
      const bdbM = require('./lib/bot-db');
      const dogM = r.status === 200 ? bdbM.getDoc(bdbM.getOrCreateUser(SF.id).id, r.json.doc.id) : null;
      ok(dogM && dogM.payload.values.event_date === '01.07.2026' && dogM.payload.values.price === 120000
        && dogM.payload.values.hacker === undefined && r.json.total === 120000,
      'договор по шаблону выписан из приложения, лишние поля отброшены', JSON.stringify(dogM && dogM.payload.values));
      r = await call('POST', '/api/mycontract/analyze', { user: sfUser, body: { dataUrl: 'не файл' } });
      ok(r.status === 400, 'без файла — понятный отказ');
      process.env.MYCON_REVIEW_MOCK = JSON.stringify({ title: 'Аренда', summary: 'Аренда зала.', risks: [{ level: 'high', text: 'Автопролонгация' }] });
      r = await call('POST', '/api/contract/review', { user: sfUser, body: { dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`, name: 'аренда.pdf' } });
      ok(r.status === 200 && r.json.review.risks[0].text === 'Автопролонгация', 'разбор чужого договора из приложения');
      r = await call('POST', '/api/mycontract/delete', { user: sfUser, body: { cpId: 0 } });
      ok(r.status === 200 && r.json.ok, 'шаблон убирается');
      delete process.env.MYCON_PROVIDER; delete process.env.MYCON_MOCK; delete process.env.MYCON_REVIEW_MOCK;
    }

    /*
     * Имя клиента в подписи к акту сверки шло в HTML как есть. «&» или «<»
     * в названии — и Telegram отклонял сообщение целиком: акт не приходил.
     */
    const cpAmp = bdbS.createCp(mid, { name: 'ООО «Рога & Копыта» <юг>', kind: 'customer', opening_date: '2026-01-01' });
    sentToChat.length = 0;
    r = await call('GET', `/api/akt?cp=${cpAmp}&from=2026-01-01&to=2026-12-31`, { user: sfUser });
    const aktCap = (sentToChat[0] || {}).caption || '';
    ok(r.status === 200 && aktCap.includes('Рога &amp; Копыта» &lt;юг&gt;'),
      'имя клиента в подписи к акту экранировано', aktCap.slice(0, 90));

    // --- исправление ---
    r = await call('POST', '/api/doc/fix', { user: sfUser, body: { id: shipId } });
    ok(r.status === 200 && r.json.no === 1, 'исправление № 1 выписано', JSON.stringify(r.json && r.json.no));
    r = await call('POST', '/api/doc/fix', { user: sfUser, body: { id: shipId } });
    ok(r.json.no === 2, 'следующее — № 2, документ помнит предыдущее', r.json.no);
    const afterFix = bdbS.getDoc(mid, shipId);
    ok(afterFix.number === bdbS.getDoc(mid, shipId).number,
      'номер счёта-фактуры при исправлении не меняется');

    // --- неплательщику нельзя ---
    bdbS.updateOrg(mid, orgS.id, { npd: 1 });
    r = await call('POST', '/api/doc/avans', { user: sfUser, body: { cpId: cpS, sum: 1000 } });
    ok(r.status === 400 && /Самозанятый/.test((r.json || {}).error || ''),
      'самозанятому счёт-фактуру не выписать и через приложение', (r.json || {}).error);
    bdbS.updateOrg(mid, orgS.id, { npd: 0, vat_rate: '' });
  }

  section('деньги: проверки на входе (количество, даты, УПД)');
  {
    /*
     * То, что ревизор присылал в API мимо формы: количество «0» и «abc»,
     * запятая вместо точки, 30 февраля, УПД от самозанятого.
     */
    const GU = { id: 500505, first_name: 'Глеб', username: 'gleb' };
    const gUser = initDataFor(GU);
    const bdbG = require('./lib/bot-db');
    const gid = bdbG.getOrCreateUser(GU.id).id;
    bdbG.saveMyOrg(gid, { name: 'ИП Глеб', inn: '183209316100' });
    const orgG = bdbG.getDefaultOrg(gid);
    require('./lib/billing').grantDays(gid, 30);
    const cpG = bdbG.createCp(gid, { name: 'ООО «Вход»', kind: 'customer', opening_date: '2026-01-01' });
    const post = (body) => call('POST', '/api/doc', { user: gUser, body: { type: 'sch', cpId: cpG, ...body } });

    for (const [qty, price] of [[0, 100], [-1, 100], ['abc', 100], [1, -5]]) {
      // eslint-disable-next-line no-await-in-loop
      r = await post({ items: [{ name: 'Мусор', qty, price }] });
      ok(r.status === 400 && /Мусор/.test(r.json.error || ''), `Р12: qty=${JSON.stringify(qty)} price=${JSON.stringify(price)} — отказ`, r.json.error);
    }
    r = await post({ items: [{ name: 'Дробная', qty: '1,5', price: '100,50' }] });
    ok(r.status === 200 && r.json.total === 150.75, 'Р12: «1,5 × 100,50» с запятой читается — 150,75', JSON.stringify(r.json.total || r.json.error));
    r = await post({ items: [{ name: 'Весовой', qty: 0.333, price: 10.01 }] });
    ok(r.status === 200 && r.json.total === 3.33, 'Р1: 0,333 × 10,01 = 3,33 (а не 3,30 от 0,33)', r.json.total);

    for (const d of ['2026-02-30', '2026-04-31', '2026-13-01', 'вчера']) {
      // eslint-disable-next-line no-await-in-loop
      r = await post({ items: [{ name: 'Х', qty: 1, price: 1 }], date: d });
      ok(r.status === 400 && /календар/.test(r.json.error || ''), `Р11: дата «${d}» в /api/doc отвергается`, r.json.error);
    }
    r = await post({ items: [{ name: 'Х', qty: 1, price: 10 }], date: '2026-10-05' });
    ok(r.status === 200, 'Р11: настоящая дата проходит', r.json.error);
    const paidDoc = r.json.doc.id;
    r = await call('POST', '/api/doc/paid', { user: gUser, body: { id: paidDoc, date: '2026-02-30' } });
    ok(r.status === 400 && /не бывает/.test(r.json.error || '') && !bdbG.getDoc(gid, paidDoc).paid_at,
      'Р11: «Оплатил» с выдуманной датой отвергается и ничего не отмечает', r.json.error);
    r = await call('POST', '/api/doc/paid', { user: gUser, body: { id: paidDoc, date: '2026-10-06' } });
    ok(r.status === 200 && r.json.paidAt === '2026-10-06', 'Р11: настоящая дата оплаты принята');

    bdbG.updateOrg(gid, orgG.id, { npd: 1 });
    r = await post({ type: 'upd', items: [{ name: 'Х', qty: 1, price: 100 }] });
    ok(r.status === 400 && r.json.reason === 'npd' && /УПД/.test(r.json.error || ''), 'Р20: УПД самозанятого через API — отказ', r.json.error);
    r = await post({ type: 'upd', items: [{ name: 'Х', qty: 1, price: 100 }], status: 1, vatRate: 22 });
    ok(r.status === 400 && r.json.reason === 'npd', 'Р20: и со статусом 1 тоже', r.json.error);
    bdbG.updateOrg(gid, orgG.id, { npd: 0 });

    // Р8: сумма расписания в списке приложения — с НДС, как у будущего документа.
    bdbG.updateOrg(gid, orgG.id, { vat_rate: '22', vat_gross: 0 });
    const recG = require('./lib/recurring').add(gid, { cpId: cpG, type: 'torg12', period: 'day', weekday: 0,
      items: [{ name: 'Обед', unit: 'шт.', qty: 20, price: 350 }], offeredThisMonth: false });
    r = await call('GET', '/api/recurring', { user: gUser });
    const recRow = (r.json.items || []).find((x) => x.id === recG);
    ok(recRow && recRow.total === 8540, 'Р8: в списке расписаний 8 540 (7 000 + НДС 22%), а не 7 000', recRow && recRow.total);
    require('./lib/recurring').off(gid, recG);
    bdbG.updateOrg(gid, orgG.id, { vat_rate: '' });

    // Р5/Р6 через API: платёж «по накладной № N» привязывается к названному документу,
    // а частичная оплата остаётся частичной, пока не набралась вся сумма.
    const base = bdbG.unpaidSummary(gid);       // до этого в разделе уже выписано и не оплачено кое-что
    const cpB = bdbG.createCp(gid, { name: 'ООО «Выписка»', kind: 'customer', inn: '7707654321', opening_date: '2026-01-01' });
    r = await call('POST', '/api/doc', { user: gUser, body: { type: 'torg12', cpId: cpB, date: '2026-10-01', items: [{ name: 'Работы', qty: 1, price: 50000 }] } });
    const bigId = r.json.doc.id;
    const bigNo = bdbG.getDoc(gid, bigId).number;
    r = await call('POST', '/api/bank/import', { user: gUser, body: { rows: [
      { key: 'g-part-1', cpId: cpB, amount: 20000, date: '2026-10-05', doc: 'Оплата, п/п № 5', purpose: `Оплата по накладной № ${bigNo} частично` }] } });
    ok(r.json.added === 1 && r.json.deals.length === 1 && r.json.deals[0].partial && r.json.deals[0].left === 30000,
      'Р5/Р6: платёж с номером документа предлагается как частичная оплата (осталось 30 000)', JSON.stringify(r.json.deals));
    r = await call('POST', '/api/bank/close', { user: gUser, body: { deals: r.json.deals } });
    ok(r.json.docs === 0 && r.json.partial === 1 && bdbG.linkedPaid(bigId) === 20000 && !bdbG.getDoc(gid, bigId).paid_at,
      'Р6: подтвердили — оплата привязана, документ не закрыт', JSON.stringify(r.json));
    ok(Math.round((r.json.sum - base.sum) * 100) / 100 === 30000, 'и «ждут оплаты» выросло на 30 000, а не на 50 000', r.json.sum - base.sum);
    r = await call('POST', '/api/bank/import', { user: gUser, body: { rows: [
      { key: 'g-part-2', cpId: cpB, amount: 30000, date: '2026-10-12', doc: 'Оплата, п/п № 9', purpose: `Доплата по накладной № ${bigNo}` }] } });
    ok(r.json.deals.length === 1 && !r.json.deals[0].partial && r.json.deals[0].total === 30000, 'Р6: доплата 30 000 закрывает документ целиком', JSON.stringify(r.json.deals));
    r = await call('POST', '/api/bank/close', { user: gUser, body: { deals: r.json.deals } });
    ok(r.json.docs === 1 && bdbG.getDoc(gid, bigId).paid_at && bdbG.balanceOf(gid, cpB).closing === 0 && r.json.count === base.count && r.json.sum === base.sum,
      'Р6: документ, оплаченный двумя платежами, закрыт и из «ждут оплаты» ушёл', JSON.stringify(r.json));
  }

  section('деньги: чек самозанятого на каждое поступление (API)');
  {
    // Р3 через приложение: частичная оплата руками → чек на 20 000; «Оплатил» → чек на остаток 30 000.
    const NU = { id: 500606, first_name: 'Нина', username: 'nina' };
    const nUser = initDataFor(NU);
    const bdbN = require('./lib/bot-db');
    const nid = bdbN.getOrCreateUser(NU.id).id;
    bdbN.saveMyOrg(nid, { name: 'Иванова Н. Н.', inn: '183200000011' });
    const orgN = bdbN.getDefaultOrg(nid);
    bdbN.updateOrg(nid, orgN.id, { npd: 1, debt_basis: 'invoice' });
    require('./lib/billing').grantDays(nid, 30);
    const cpN = bdbN.createCp(nid, { name: 'Петров П. П.', kind: 'customer', inn: '183100000099', opening_date: '2026-01-01' });
    r = await call('POST', '/api/doc', { user: nUser, body: { type: 'sch', cpId: cpN, date: '2026-10-01', items: [{ name: 'Консультация', qty: 1, price: 50000 }] } });
    const invN = r.json.doc.id;
    r = await call('POST', '/api/op', { user: nUser, body: { cpId: cpN, kind: 'payment', amount: 20000, date: '2026-10-02', doc: 'п/п 1' } });
    ok(r.status === 200 && r.json.npd && /на 20 000 ₽/.test(r.json.npd.text.replace(/\s/g, ' ')),
      'Р3: оплата 20 000 руками — приложение сразу напоминает про чек на 20 000', JSON.stringify(r.json.npd && r.json.npd.text));
    r = await call('POST', '/api/doc/paid', { user: nUser, body: { id: invN, date: '2026-10-03', free: 'new' } });
    ok(r.json.npd && /на 30 000 ₽/.test(r.json.npd.text.replace(/\s/g, ' ')) && r.json.npd.cheque.amount === 30000,
      'Р3: «Оплатил» после частичной — чек на остаток 30 000, а не на 50 000', JSON.stringify(r.json.npd && r.json.npd.cheque && r.json.npd.cheque.amount));
    r = await call('GET', '/api/cheques', { user: nUser });
    ok(r.json.items.length === 2 && r.json.items.reduce((a, c) => a + c.amount, 0) === 50000,
      'Р3: в списке чеков два (20 000 и 30 000) — всего 50 000, как и получено', JSON.stringify(r.json.items.map((c) => c.amount)));
    r = await call('POST', '/api/doc/paid', { user: nUser, body: { id: invN, date: '2026-10-04' } });
    ok(r.json.npd === null, 'Р3: повторное «Оплатил» нового напоминания не даёт');
    r = await call('POST', '/api/op', { user: nUser, body: { cpId: cpN, kind: 'prepay', amount: 10000, date: '2026-10-05' } });
    ok(r.json.npd && r.json.npd.cheque.amount === 10000, 'Р3: аванс 10 000 — чек на аванс', JSON.stringify(r.json.npd));
    r = await call('POST', '/api/doc/paid', { user: nUser, body: { id: invN, paid: false } });
    r = await call('GET', '/api/cheques', { user: nUser });
    ok(r.json.items.length === 2 && r.json.items.map((c) => c.amount).sort((a, b) => a - b).join() === '10000,20000',
      'Р3: снятие оплаты сняло ожидание чека на 30 000; чеки на 20 000 и аванс 10 000 остались', JSON.stringify(r.json.items.map((c) => c.amount)));
    // Выписка: чек в момент занесения.
    r = await call('POST', '/api/bank/import', { user: nUser, body: { rows: [
      { key: 'nina-1', cpId: cpN, amount: 7000, date: '2026-10-06', doc: 'Оплата, п/п № 3', purpose: 'Оплата консультации' }] } });
    ok(r.json.added === 1 && r.json.npd && r.json.npd.cheque.amount === 7000, 'Р3: платёж из выписки — чек сразу при занесении', JSON.stringify(r.json.npd && r.json.npd.cheque));
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

  /*
   * Файл без кнопок — тупик.
   *
   * Человек получал PDF и дальше не знал, что делать: переслать клиенту,
   * отметить оплату и открыть карточку можно было только разыскав документ
   * в меню бота, куда из шторки приложения никто не идёт.
   *
   * «Переслать клиенту» ведёт в doc.link — тот делает публичную ссылку и
   * даёт родной выбор чата. Через switch_inline_query вышло бы короче, но
   * inline-режим включается отдельно в BotFather, и без него такая кнопка
   * молча не работает.
   */
  {
    const flat = (sentToChat[0].buttons || []).flat();
    const dataOf = (re) => (flat.find((b) => re.test(b.text)) || {}).data || '';
    ok(flat.length === 3, 'под файлом три кнопки', flat.map((b) => b.text).join(' | '));
    ok(dataOf(/Переслать/) === `doc.link:${r.json.doc.id}`, 'переслать клиенту — через ссылку',
      dataOf(/Переслать/));
    ok(dataOf(/Оплачено/) === `doc.paid:${r.json.doc.id}`, 'отметка оплаты на месте', dataOf(/Оплачено/));
    ok(dataOf(/Открыть/) === `doc:${r.json.doc.id}`, 'карточка документа открывается', dataOf(/Открыть/));
    ok(!flat.some((b) => b.data && !/^doc[.:]/.test(b.data)),
      'все кнопки ведут в существующие обработчики бота');
  }
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
  ok(r.status === 400 && /нет в вашем списке/.test(r.json.error), 'на чужого контрагента выписать нельзя', r.json.error);

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
    ok(r.json.npd && /Пробейте чек в «Мой налог» на 600 ₽/.test(r.json.npd.text),
      'с галочкой — напоминание про чек с суммой', r.json.npd && r.json.npd.text.slice(0, 60));
    ok(r.json.npd.url === 'https://lknpd.nalog.ru/',
      'и адрес личного кабинета, а не выдуманная схема', r.json.npd.url);

    // Учёт чеков: ждёт, видно на главной и в карточке, закрывается отметкой.
    const chqId = r.json.npd.cheque.id;
    r = await call('GET', '/api/state', { user: masha });
    ok(r.json.cheques && r.json.cheques.open === 1 && r.json.cheques.sum === 600,
      'главная знает: «Чеки не пробиты: 1» на 600 ₽', JSON.stringify(r.json.cheques));
    r = await call('GET', '/api/cheques', { user: masha });
    ok(r.json.items.length === 1 && r.json.items[0].id === chqId && r.json.items[0].service,
      'список чеков отдаёт данные для «Мой налог»', JSON.stringify(r.json.items).slice(0, 120));
    r = await call('GET', '/api/cheques', { user: petya });
    ok(r.json.items.length === 0, 'чужие чеки не видны');
    r = await call('POST', '/api/cheques/done', { user: petya, body: { id: chqId } });
    ok(r.json.error, 'и отметить чужой чек нельзя', JSON.stringify(r.json));
    r = await call('POST', '/api/cheques/done', { user: masha, body: { id: chqId, link: 'https://evil.example/x' } });
    ok(r.json.error && /lknpd\.nalog\.ru/.test(r.json.error), 'ссылка не из «Моего налога» отвергается', JSON.stringify(r.json));
    r = await call('GET', '/api/docs', { user: masha });
    ok((r.json.docs.find((d) => d.id === unpaid.id) || {}).cheque.status === 'open', 'в карточке документа чек «не пробит»');
    r = await call('POST', '/api/cheques/done', { user: masha,
      body: { id: chqId, link: 'https://lknpd.nalog.ru/api/v1/receipt/770123456789/abc123/print' } });
    ok(r.json.cheque && r.json.cheque.status === 'done' && r.json.cheque.number === 'abc123' && r.json.summary.open === 0,
      'отметка со ссылкой: чек пробит, номер выделен, на главной чисто', JSON.stringify(r.json).slice(0, 140));
    r = await call('GET', '/api/docs', { user: masha });
    ok(/lknpd\.nalog\.ru/.test((r.json.docs.find((d) => d.id === unpaid.id) || {}).cheque.link), 'ссылка лежит в карточке документа');
    // Повторное «оплачен» на документе с пробитым чеком нового чека не заводит.
    r = await call('POST', '/api/doc/paid', { user: masha, body: { id: unpaid.id } });
    r = await call('GET', '/api/cheques', { user: masha });
    ok(r.json.items.length === 0, 'пробитый чек второй раз не всплывает');

    await call('POST', '/api/npd', { user: masha, body: { on: false } });
  }

  section('платёжный QR до отправки');
  {
    /*
     * Код показывается на карточке документа, чтобы человек проверил его
     * камерой банка ДО того, как счёт уйдёт клиенту: там ошибка в реквизитах
     * или сумме ещё стоит одну правку, а не разговор с бухгалтерией.
     *
     * И главное — когда реквизитов не хватает, отдаём не пустоту, а список
     * недостающего. Кода по ГОСТ Р 56042 без счёта, БИК и корр. счёта не
     * существует, и обещать его на экране нельзя.
     */
    const bdbQ = require('./lib/bot-db');
    const uq = bdbQ.getOrCreateUser(500505, 'Пётр QR', 'qr');
    require('./lib/billing').grantDays(uq.id, 30);
    const qrUser = initDataFor({ id: 500505, first_name: 'Пётр QR', username: 'qr' });
    bdbQ.saveMyOrg(uq.id, { name: 'ИП Петров', inn: '183209316119' });
    const cpq = bdbQ.createCp(uq.id, { name: 'ООО «Клиент»', kind: 'customer', opening_date: '2026-01-01' });
    const made = await call('POST', '/api/doc', {
      user: qrUser,
      body: { type: 'sch', cpId: cpq, items: [{ name: 'Услуга', qty: 1, price: 1000 }] },
    });
    ok(made.status === 200, 'счёт выписан', JSON.stringify(made.json).slice(0, 60));
    const docId = made.json.doc.id;

    // Реквизитов ещё нет — значит и кода нет, и мы говорим, чего не хватает.
    const bad = await call('GET', `/api/doc/qr?id=${docId}`, { user: qrUser });
    ok(!bad.json.svg, 'без реквизитов кода не отдаём');
    ok((bad.json.problems || []).length > 0, 'зато перечислено, чего не хватает',
      (bad.json.problems || []).join(', '));
    ok((bad.json.problems || []).some((p) => /счёт/i.test(p)),
      'и расчётный счёт назван прямо', (bad.json.problems || []).join(', '));

    // Заполняем — код появляется.
    const orgQ = bdbQ.getDefaultOrg(uq.id);
    bdbQ.updateOrg(uq.id, orgQ.id, {
      bank_name: 'АО «Тестбанк»', bik: '044525999',
      acc: '40802810500000000123', corr_acc: '30101810400000000999',
    });
    const good = await call('GET', `/api/doc/qr?id=${docId}`, { user: qrUser });
    ok(typeof good.json.svg === 'string' && good.json.svg.includes('<svg'),
      'с реквизитами приходит настоящий SVG', String(good.json.svg).slice(0, 30));
    ok(!(good.json.problems || []).length, 'и жалоб больше нет');

    // Чужой документ по прямому адресу не отдаётся: это тот же рубеж, что и
    // у остальных эндпоинтов, и проверять его надо на каждом новом.
    const alien = await call('GET', `/api/doc/qr?id=${docId}`, { user: petya });
    ok(!alien.json.svg && /не найден/i.test(alien.json.error || ''),
      'чужой документ кода не отдаёт', JSON.stringify(alien.json));
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

  /*
   * Дневной предел на человека: квота DaData общая на весь продукт.
   *
   * Раньше здесь стоял только общий ограничитель в 120 запросов в минуту —
   * один пользователь выедал дневной лимит справочника примерно за полтора
   * часа, и ИНН переставал подставляться у ВСЕХ до полуночи.
   */
  {
    const wasLimit = process.env.LOOKUPS_PER_DAY;
    process.env.LOOKUPS_PER_DAY = '3';
    // Считаем и удачные, и неудачные: в квоту DaData уходят оба.
    const codes = [];
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const one = await call('POST', '/api/lookup', { user: petya, body: { inn: '7712345678' } });
      codes.push(one.status);
    }
    ok(codes.slice(0, 3).every((c) => c === 200), 'первые запросы проходят', codes.join(','));
    ok(codes.slice(-1)[0] === 400, 'сверх дневного предела справочник не дёргается', codes.join(','));
    // Сосед берётся свежий: у Маши выше по прогону запросы уже были, и на
    // пределе в три штуки она бы упёрлась не из-за общей квоты, а по-своему.
    const sosed = initDataFor({ id: 500303, first_name: 'Сосед', username: 'sosed' });
    const other = await call('POST', '/api/lookup', { user: sosed, body: { inn: '7712345678' } });
    ok(other.status === 200, 'предел считается по человеку, а не общий на всех', String(other.status));
    if (wasLimit === undefined) delete process.env.LOOKUPS_PER_DAY;
    else process.env.LOOKUPS_PER_DAY = wasLimit;
  }

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
    r = await call('POST', '/api/doc', {
      user: katya, body: { type: 'usl', cpId: cpK, items: [{ name: 'Работа', qty: 1, price: 20000 }] },
    });
    // Приложение должно узнать об этом в момент выписки, а не через ноль в
    // карточке клиента: по этим полям оно и объясняет, почему долга нет.
    ok(r.status === 200 && r.json.debt === false && r.json.debtBasis === 'invoice',
      'ответ на выписку говорит, что акт в долг не попал и почему',
      JSON.stringify({ debt: r.json.debt, debtBasis: r.json.debtBasis }));
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
    // А при «по отгрузке» накладная попадает в долг — и ответ это подтверждает.
    const cpT = (await call('POST', '/api/cp', {
      user: katya, body: { name: 'ООО «Накладная»', kind: 'customer' },
    })).json.cp.id;
    r = await call('POST', '/api/doc', {
      user: katya, body: { type: 'torg12', cpId: cpT, items: [{ name: 'Кабель', qty: 2, price: 1500 }] },
    });
    ok(r.status === 200 && r.json.debt === true && r.json.debtBasis === 'closing',
      'при «по отгрузке» ответ на ТОРГ-12 говорит, что долг внесён',
      JSON.stringify({ status: r.status, debt: r.json.debt, error: r.json.error }));
    r = await call('GET', '/api/cps', { user: katya });
    ok(r.json.cps.find((c) => c.id === cpT).balance === 3000,
      'и долг накладной виден на контрагенте', r.json.cps.find((c) => c.id === cpT).balance);

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

    /*
     * Отказ модели виден владельцу.
     *
     * Человеку показывают «попробуйте позже» — и правильно, чинить он это не
     * может. А владельцу нужна причина: истёкший ключ и запрет провайдера по
     * адресу выглядят одинаково, а чинятся по-разному. В боте такая запись
     * была, в приложении её не было, и причина не оседала нигде.
     */
    {
      const office = require('./lib/office');
      const keep = {};
      for (const k of ['AI_PROVIDER', 'AI_ENABLED', 'GEMINI_API_KEY', 'GEMINI_BASE_URL']) keep[k] = process.env[k];
      process.env.AI_ENABLED = '1';
      process.env.AI_PROVIDER = 'gemini';
      process.env.GEMINI_API_KEY = 'test-key-not-real';   // латиницей: кириллица в заголовке падает раньше сети
      // Адрес, который отказывает сразу: ждать 35 секунд тайм-аута незачем,
      // а в сеть прогон не ходит вовсе.
      process.env.GEMINI_BASE_URL = 'http://127.0.0.1:1';
      const before = office.list('ai', 50).length;
      r = await call('POST', '/api/ask', { user: masha, body: { text: 'посоветуй, что делать с должниками' } });
      ok(r.status === 200 && /не отвечает/i.test(r.json.replyText || ''),
        'при отказе модели человек видит «не отвечает», а не «не понял»',
        `${r.status} ${(r.json || {}).replyText}`);
      ok(r.json.source === 'error' && r.json.error === undefined,
        'сырой ответ провайдера наружу не уходит', JSON.stringify(r.json.error));
      const now = office.list('ai', 50);
      ok(now.length === before + 1, 'отказ модели записан в журнал поддержки',
        `${before} → ${now.length}`);
      ok((now[0].error || '').length > 0, 'и в записи видна причина, а не пустая строка',
        (now[0] || {}).error);
      ok((now[0].where_at || '').includes('приложение'), 'видно, что это из приложения',
        (now[0] || {}).where_at);
      for (const [k, v] of Object.entries(keep)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    /*
     * ── цену назначает сервер ──
     *
     * Раньше /api/pay/create брал сумму из тела запроса. Приложение слало
     * 349, и всё выглядело правильно — но тело запроса пишет не приложение,
     * а тот, кто его открыл. Запрос с {"amount": 1} создавал настоящую
     * транзакцию на рубль. Проверяем не «работает ли оплата», а что
     * присланная клиентом цена игнорируется.
     */
    {
      const platega = require('./lib/platega');
      const keepP = {};
      for (const k of ['PLATEGA_MERCHANT_ID', 'PLATEGA_SECRET', 'LAVA_PLAN_DAYS', 'PLATEGA_API_URL']) keepP[k] = process.env[k];
      process.env.LAVA_PLAN_DAYS = '390:30,2990:365';
      // Ключей нет нарочно: до сети дело не дойдёт, а цену сервер назначит
      // до всякой сети — её и проверяем.
      delete process.env.PLATEGA_MERCHANT_ID;
      delete process.env.PLATEGA_SECRET;

      ok(platega.planByName('month').amount === 390, 'месяц стоит столько, сколько в сетке');
      ok(platega.planByName('year').amount === 2990, 'год — тоже');

      /*
       * Смотрим не на ответ, а на то, какая сумма УШЛА в Platega. Первая
       * версия этой проверки обходилась ответом — и проходила по
       * недоразумению: без ключей обработчик до цены вообще не доходит, и
       * «цена не равна рублю» выполнялось само собой.
       */
      const http2 = require('node:http');
      const seen = [];
      const fake = http2.createServer((q, res2) => {
        let b = '';
        q.on('data', (c) => { b += c; });
        q.on('end', () => {
          try { seen.push(JSON.parse(b)); } catch (_) { seen.push({}); }
          res2.writeHead(200, { 'content-type': 'application/json' });
          res2.end(JSON.stringify({ id: 'test-1', redirect: 'https://example/pay', status: 'PENDING' }));
        });
      });
      await new Promise((res3) => fake.listen(0, '127.0.0.1', res3));
      process.env.PLATEGA_MERCHANT_ID = '7b7ed2b3-16a7-49da-8076-b2f63498858b';
      process.env.PLATEGA_SECRET = 'test-secret';
      process.env.PLATEGA_API_URL = `http://127.0.0.1:${fake.address().port}`;

      r = await call('POST', '/api/pay/create', { user: masha, body: { plan: 'month', amount: 1 } });
      ok(seen.length === 1, 'запрос до площадки дошёл', String(seen.length));
      const sent = (seen[0] || {}).paymentDetails || {};
      ok(sent.amount === 390, 'в Platega ушли 390 ₽, а не присланный клиентом рубль',
        String(sent.amount));
      ok(JSON.parse((seen[0] || {}).payload || '{}').days === 30,
        'и срок уехал в payload', (seen[0] || {}).payload);

      seen.length = 0;
      r = await call('POST', '/api/pay/create', { user: masha, body: { plan: 'year', amount: 1 } });
      const sentY = (seen[0] || {}).paymentDetails || {};
      ok(sentY.amount === 2990, 'за год ушли 2990 ₽', String(sentY.amount));
      ok(JSON.parse((seen[0] || {}).payload || '{}').days === 365,
        'и в payload 365 дней — год не превратится в месяц', (seen[0] || {}).payload);
      fake.close();
      delete process.env.PLATEGA_API_URL;

      for (const [k, v] of Object.entries(keepP)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    /*
     * ── связь сорвалась — повторяем, но ничего не задваиваем ──
     *
     * На боевом сервере соединение наружу иногда не устанавливается, и
     * встроенный fetch сдавался с «fetch failed» с первого раза: помощник «не
     * отвечал», оплата «временно недоступна», хотя площадки были живы.
     * Площадки здесь поддельные и рвут первое соединение по-настоящему.
     */
    {
      const http2 = require('node:http');
      const { fetchRetry, beforeSend } = require('./lib/net-retry');
      const keepN = {};
      for (const k of ['PLATEGA_MERCHANT_ID', 'PLATEGA_SECRET', 'LAVA_PLAN_DAYS', 'PLATEGA_API_URL',
        'AI_PROVIDER', 'AI_ENABLED', 'GEMINI_API_KEY', 'GEMINI_BASE_URL']) keepN[k] = process.env[k];
      const restoreN = () => {
        for (const [k, v] of Object.entries(keepN)) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      };
      const warnOrig = console.warn;
      const warned = [];
      let onWarn = () => {};
      console.warn = (...a) => { warned.push(a.join(' ')); onWarn(); };
      try {
        // Node перебирает адреса и отдаёт AggregateError с кодом ETIMEDOUT —
        // по коду это не отличить от обрыва посреди ответа, по syscall можно.
        const agg = Object.assign(new Error('x'), {
          code: 'ETIMEDOUT',
          errors: [{ code: 'ETIMEDOUT', syscall: 'connect' }, { code: 'ENETUNREACH', syscall: 'connect' }],
        });
        ok(beforeSend(new TypeError('fetch failed', { cause: agg })),
          'не подключились ни к одному адресу — запрос не ушёл');
        ok(!beforeSend(new TypeError('fetch failed', { cause: { code: 'ECONNRESET', syscall: 'read' } })),
          'обрыв при чтении ответа — запрос мог уйти');
        ok(!beforeSend(new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } })),
          '«площадка закрыла соединение» — тоже мог уйти');

        // Истёкший срок — не сбой связи: повторять его — ждать сверх срока.
        warned.length = 0;
        const gone = await fetchRetry('http://127.0.0.1:1/', { signal: AbortSignal.abort() }, { idempotent: true })
          .then(() => 'ответ', (e) => e.name);
        ok(gone === 'AbortError' && warned.length === 0, 'отменённый запрос не повторяется',
          `${gone}, повторов ${warned.length}`);

        process.env.LAVA_PLAN_DAYS = '390:30,2990:365';
        process.env.PLATEGA_MERCHANT_ID = '7b7ed2b3-16a7-49da-8076-b2f63498858b';
        process.env.PLATEGA_SECRET = 'test-secret';
        const payOk = { id: 'net-1', redirect: 'https://example/pay', status: 'PENDING' };

        // 1. Площадка приняла запрос и оборвала связь, не ответив. Платёж мог
        // создаться — второй запрос выставил бы человеку второй счёт.
        let hits = 0;
        const cut = http2.createServer((q, res2) => {
          hits += 1;
          q.resume();
          q.on('end', () => {
            if (hits === 1) { q.socket.destroy(); return; }
            res2.writeHead(200, { 'content-type': 'application/json' });
            res2.end(JSON.stringify(payOk));
          });
        });
        await new Promise((res3) => cut.listen(0, '127.0.0.1', res3));
        process.env.PLATEGA_API_URL = `http://127.0.0.1:${cut.address().port}`;
        r = await call('POST', '/api/pay/create', { user: masha, body: { plan: 'month' } });
        ok(hits === 1, 'оборванное после отправки создание платежа не повторяется',
          `запросов: ${hits}`);
        ok(r.json.provider !== 'platega', 'и человеку не отдают несуществующий счёт',
          JSON.stringify(r.json));

        // 2. До площадки не достучались вовсе — запрос не ушёл, повтор безопасен.
        // Площадка «оживает», как только клиент заметил отказ и собрался повторить:
        // так проверка не зависит от того, насколько быстрая машина.
        await new Promise((res3) => cut.close(res3));
        hits = 1;          // первый ответ этой площадки — сразу нормальный
        const port = Number(process.env.PLATEGA_API_URL.split(':').pop());
        onWarn = () => { if (!cut.listening) cut.listen(port, '127.0.0.1'); };
        warned.length = 0;
        r = await call('POST', '/api/pay/create', { user: masha, body: { plan: 'month' } });
        onWarn = () => {};
        ok(r.json.ok && r.json.provider === 'platega' && r.json.id === 'net-1',
          'не подключились к Platega с первого раза — счёт всё равно выставлен', JSON.stringify(r.json));
        ok(hits === 2 && warned.some((w) => /ECONNREFUSED/.test(w)),
          'со второй попытки и ровно один', `запросов: ${hits - 1}, ${warned.join(' | ')}`);
        ok(warned.every((w) => !w.includes('test-secret') && !w.includes('/transaction')),
          'в журнал попал только адрес площадки', warned.join(' | '));
        await new Promise((res3) => cut.close(res3));

        // 3. Помощник: модель только читает, поэтому и обрыв после отправки
        // повторяем — иначе человек видит «не отвечает» на ровном месте.
        let gHits = 0;
        const gem = http2.createServer((q, res2) => {
          gHits += 1;
          q.resume();
          q.on('end', () => {
            if (gHits === 1) { q.socket.destroy(); return; }
            res2.writeHead(200, { 'content-type': 'application/json' });
            res2.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"action":"debts"}' }] } }] }));
          });
        });
        await new Promise((res3) => gem.listen(0, '127.0.0.1', res3));
        process.env.AI_ENABLED = '1';
        process.env.AI_PROVIDER = 'gemini';
        process.env.GEMINI_API_KEY = 'test-key-not-real';
        process.env.GEMINI_BASE_URL = `http://127.0.0.1:${gem.address().port}`;
        r = await call('POST', '/api/ask', { user: masha, body: { text: 'посоветуй, что делать с должниками' } });
        ok(r.status === 200 && r.json.source === 'model' && gHits === 2,
          'модель оборвала связь — помощник переспросил и ответил',
          `${r.status} ${r.json.source} ${r.json.replyText || ''} запросов: ${gHits}`);
        await new Promise((res3) => gem.close(res3));
      } finally {
        console.warn = warnOrig;
        restoreN();
      }
    }

    // Голос: без провайдера — честный отказ, с заглушкой — разбор.
    r = await call('POST', '/api/ask/voice', { user: masha, body: { audio: 'AAA=' } });
    ok(r.status === 400 && /не подключено|SPEECH/i.test(r.json.error || ''),
      'без распознавания речи отказ понятен', (r.json || {}).error);

    process.env.SPEECH_PROVIDER = 'mock';
    process.env.SPEECH_MOCK = 'что не оплачено';
    process.env.AI_KOP_VOICE = '120';       // 1,2 ₽ за минуту речи
    // Бюджет виден только в ответе переписки; спрашиваем бесплатной фразой
    // — её разбирает местный код, и расход от неё не растёт.
    const budgetNow = async () => (await call('POST', '/api/ask',
      { user: masha, body: { text: 'кто мне должен' } })).json.budget;
    const kopWas = (await budgetNow()).kopecks;
    r = await call('POST', '/api/ask/voice', { user: masha, body: { audio: Buffer.from('OggS зв').toString('base64'), seconds: 3 } });
    ok(r.status === 200 && r.json.action === 'unpaid' && r.json.heard === 'что не оплачено',
      'голос расшифрован и разобран', JSON.stringify(r.json).slice(0, 80));
    /*
     * Три секунды звука по 1,2 ₽ за минуту — шесть копеек. Проверяем не
     * арифметику (она проверена в bot-selftest), а то, что приложение вообще
     * доходит до кошелька: запись до двадцати мегабайт тарифицируется по
     * секундам, а в бюджете весила столько же, сколько набранная фраза.
     */
    ok(r.json.budget && r.json.budget.kopecks === kopWas + 6,
      'секунды звука записаны в расход', JSON.stringify((r.json.budget || {}).kopecks));
    delete process.env.AI_KOP_VOICE;
    r = await call('POST', '/api/ask/voice', { user: masha, body: { audio: '' } });
    ok(r.status === 400, 'пустая запись отклонена');
    delete process.env.SPEECH_PROVIDER;
    delete process.env.SPEECH_MOCK;

    // Помощник и ответ голосом. Свободный вопрос — ответ помощника; голосом
    // спросили — голосом и ответили (WAV: браузеру хватает); напечатали — без звука.
    {
      const keepA = {};
      for (const k of ['AI_ENABLED', 'AI_PROVIDER', 'AI_MOCK', 'CONSULT_MOCK', 'TTS_PROVIDER', 'SPEECH_PROVIDER', 'SPEECH_MOCK']) keepA[k] = process.env[k];
      Object.assign(process.env, {
        AI_ENABLED: '1', AI_PROVIDER: 'mock', AI_MOCK: '{"action":"unknown"}', TTS_PROVIDER: 'mock',
        CONSULT_MOCK: 'Акт — для услуг, УПД — когда покупателю нужен ещё и счёт-фактура.',
        SPEECH_PROVIDER: 'mock', SPEECH_MOCK: 'чем акт отличается от упд',
      });
      r = await call('POST', '/api/ask', { user: masha, body: { text: 'чем акт отличается от упд' } });
      ok(r.status === 200 && r.json.consult === true && /для услуг/.test(r.json.replyText || '') && !r.json.audio,
        'на вопрос в приложении отвечает помощник, напечатанное — без звука', JSON.stringify(r.json).slice(0, 120));
      const wavIn = Buffer.from('RIFF....WAVE').toString('base64');
      r = await call('POST', '/api/ask/voice', { user: masha, body: { audio: wavIn, seconds: 2 } });
      ok(r.status === 200 && r.json.consult === true && r.json.audioMime === 'audio/wav'
        && Buffer.from(r.json.audio || '', 'base64').toString('latin1', 0, 4) === 'RIFF',
        'спросили голосом — ответ пришёл и голосом', JSON.stringify({ c: r.json.consult, m: r.json.audioMime }));
      r = await call('POST', '/api/ask/voice', { user: masha, body: { audio: wavIn, seconds: 2, speak: false } });
      ok(r.status === 200 && !r.json.audio, 'выключили голос — отвечаю только текстом');
      process.env.SPEECH_MOCK = 'кто мне должен';
      r = await call('POST', '/api/ask/voice', { user: masha, body: { audio: wavIn, seconds: 2 } });
      ok(r.status === 200 && r.json.action === 'debts' && r.json.audio,
        'на «кто мне должен» голосом — сводка вслух, а экран долгов кнопкой', r.json.action);
      for (const [k, v] of Object.entries(keepA)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }

    /*
     * Снимок счёта из приложения. Путь тот же, что у бота, и кошелёк тот же
     * — а проверки до сих пор не было вовсе.
     */
    process.env.VISION_PROVIDER = 'mock';
    process.env.VISION_MOCK = JSON.stringify({
      date: '2026-08-03', amount: 6250, docNo: '148', inn: '1832012345', name: 'ООО «Заря»',
    });
    process.env.AI_KOP_PHOTO = '90';        // 90 копеек за снимок
    const scanWas = (await budgetNow()).kopecks;
    const dataUrl = `data:image/jpeg;base64,${Buffer.from('снимок счёта').toString('base64')}`;
    r = await call('POST', '/api/scan', { user: masha, body: { dataUrl } });
    ok(r.status === 200 && r.json.fields && r.json.fields.amount === 6250,
      'сумма со снимка разобрана', JSON.stringify((r.json || {}).fields || r.json).slice(0, 80));
    const scanNow = (await budgetNow()).kopecks;
    ok(scanNow - scanWas === 90, 'снимок записан в расход', scanNow - scanWas);
    r = await call('POST', '/api/scan', { user: masha, body: { dataUrl: 'не картинка' } });
    ok(r.status === 400, 'мусор вместо снимка отклонён');
    delete process.env.AI_KOP_PHOTO;
    delete process.env.VISION_PROVIDER;
    delete process.env.VISION_MOCK;

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

    // Короткие периоды: каждый день, по будням, раз в неделю.
    const recLib = require('./lib/recurring');
    r = await call('POST', '/api/recurring', { user: masha, body: { docId: lastDoc.id, period: 'day' } });
    ok(r.status === 200 && r.json.dayText === 'каждый день' && r.json.period === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(r.json.next),
      '«каждый день»: расписание заведено, названо словами, известен следующий день', JSON.stringify(r.json));
    const dayRec = r.json.id;
    r = await call('POST', '/api/recurring', { user: masha, body: { docId: lastDoc.id, period: 'day' } });
    ok(r.status === 400 && /уже есть/.test(r.json.error), 'второе такое же расписание не заводится', JSON.stringify(r.json));
    r = await call('POST', '/api/recurring', { user: masha, body: { docId: lastDoc.id, period: 'weekdays' } });
    ok(r.status === 200 && r.json.dayText === 'по будням (пн–пт)', '«по будням» заведено');
    const wdRec = r.json.id;
    r = await call('POST', '/api/recurring', { user: masha, body: { docId: lastDoc.id, period: 'week' } });
    ok(r.status === 400 && /день недели/.test(r.json.error), 'раз в неделю без дня недели отклонено');
    r = await call('POST', '/api/recurring', { user: masha, body: { docId: lastDoc.id, period: 'week', weekday: 3 } });
    ok(r.status === 200 && r.json.dayText === 'раз в неделю, в среду', '«раз в неделю» — в среду', JSON.stringify(r.json));
    const wkRec = r.json.id;
    r = await call('POST', '/api/recurring', { user: masha, body: { docId: lastDoc.id, period: 'hourly' } });
    ok(r.status === 400, 'выдуманный период отклонён');
    r = await call('POST', '/api/recurring', { user: petya, body: { docId: lastDoc.id, period: 'day' } });
    ok(r.status === 400, 'по чужому документу расписание не завести');

    r = await call('GET', '/api/recurring', { user: masha });
    const dayItem = r.json.items.find((x) => x.id === dayRec);
    ok(dayItem && dayItem.periodic && dayItem.period === 'day' && dayItem.next, 'в списке: период и следующий день', JSON.stringify(dayItem));
    ok(r.json.items.find((x) => x.id === wkRec).weekday === 3, 'и день недели у недельного');
    r = await call('GET', `/api/recurring?cp=${lastDoc.cpId}`, { user: masha });
    ok(r.json.items.length >= 3 && r.json.items.every((x) => x.cpId === lastDoc.cpId), 'список можно сузить до одного клиента');
    r = await call('GET', '/api/recurring?cp=999999', { user: masha });
    ok(r.json.items.length === 0, 'у чужого или несуществующего клиента — пусто');
    r = await call('POST', '/api/recurring/off', { user: petya, body: { id: dayRec } });
    ok(r.status === 400, 'чужое расписание не остановить');
    for (const id of [dayRec, wdRec, wkRec]) await call('POST', '/api/recurring/off', { user: masha, body: { id } });
    r = await call('GET', '/api/recurring', { user: masha });
    ok(![dayRec, wdRec, wkRec].some((id) => r.json.items.some((x) => x.id === id)), 'остановленные расписания пропали из списка');
    // Документ за сегодня уже выписан — сегодняшнюю доставку не предлагаем второй раз.
    const todayDoc = (await call('POST', '/api/doc', { user: masha, body: {
      type: 'torg12', cpId: lastDoc.cpId, date: docService.todayISO(), items: [{ name: 'Обеды', unit: 'шт.', qty: 1, price: 100 }] } })).json.doc;
    r = await call('POST', '/api/recurring', { user: masha, body: { docId: todayDoc.id, period: 'day' } });
    ok(recLib.get(bdb.getOrCreateUser(MASHA.id).id, r.json.id).last_offer === docService.todayISO(),
      'если документ выписан сегодня, сегодняшняя доставка уже закрыта');
    await call('POST', '/api/recurring/off', { user: masha, body: { id: r.json.id } });

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

    /*
     * Деньги из выписки пришли на самом деле: сняв отметку или удалив
     * документ, человек отменяет привязку, а не поступление. Раньше строка
     * удалялась, а отметка о загрузке оставалась — и выписку было уже не
     * загрузить заново: 17 000 пропадали из учёта насовсем.
     */
    const leadId = deals[0].leadId;
    r = await call('POST', '/api/doc/paid', { user: masha, body: { id: leadId, paid: false } });
    ok(bdbA.unpaidDocs(mid).some((d) => d.id === leadId), 'сняли отметку — документ снова ждёт оплаты');
    ok(bdbA.balanceOf(mid, cpA).closing === 0, 'а деньги из выписки остались в журнале',
      bdbA.balanceOf(mid, cpA).closing);
    ok(r.json.kept === 17000, 'и приложение говорит об этом, а не «долг вернулся»', JSON.stringify(r.json.kept));
    r = await call('POST', '/api/doc/delete', { user: masha, body: { id: leadId } });
    ok(bdbA.balanceOf(mid, cpA).closing === -17000, 'удалили документ — оплата стала авансом, а не исчезла',
      bdbA.balanceOf(mid, cpA).closing);

    // Выписка на бо́льшую сумму: остаток остаётся свободной строкой, а
    // привязанная часть на отметку о загрузке уже не ссылается.
    const cpB = bdbA.createCp(mid, { name: 'ООО «Сверка Б»', kind: 'customer', opening_date: '2026-01-01' });
    await docSvc.issueDocument(mid, {
      type: 'usl', cpId: cpB, date: '2026-08-04',
      items: [{ name: 'Работа', qty: 1, price: 17000 }], skipQuota: true });
    r = await call('POST', '/api/bank/import', {
      user: masha,
      body: { rows: [{ key: 'сверка-б|in|20000|оплата', cpId: cpB, amount: 20000, date: '2026-08-25', doc: 'п/п 6' }] },
    });
    await call('POST', '/api/bank/close', { user: masha, body: { deals: r.json.deals } });
    ok(bdbA.balanceOf(mid, cpB).closing === -3000, 'переплата 3 000 видна авансом',
      bdbA.balanceOf(mid, cpB).closing);
    await call('POST', '/api/doc/paid', { user: masha, body: { id: r.json.deals[0].leadId, paid: false } });
    ok(bdbA.balanceOf(mid, cpB).closing === -3000, 'и после снятия отметки все 20 000 на месте',
      bdbA.balanceOf(mid, cpB).closing);

    /*
     * Долг «по акту», а оплачен одинокий счёт — долга он не создаёт. Раньше
     * деньги всё равно привязывались к нему, и первый же пересчёт журнала
     * их убирал как лишние: 12 000 пропадали из сальдо.
     */
    const cpC = bdbA.createCp(mid, { name: 'ООО «Сверка В»', kind: 'customer', opening_date: '2026-01-01' });
    await docSvc.issueDocument(mid, {
      type: 'sch', cpId: cpC, date: '2026-08-04',
      items: [{ name: 'Работа', qty: 1, price: 12000 }], skipQuota: true });
    r = await call('POST', '/api/bank/import', {
      user: masha,
      body: { rows: [{ key: 'сверка-в|in|12000|оплата', cpId: cpC, amount: 12000, date: '2026-08-25', doc: 'п/п 7' }] },
    });
    ok((r.json.deals || []).length === 1, 'счёт предложен к закрытию', JSON.stringify(r.json.deals || []));
    await call('POST', '/api/bank/close', { user: masha, body: { deals: r.json.deals } });
    await call('POST', '/api/basis', { user: masha, body: { basis: 'closing' } });
    ok(bdbA.balanceOf(mid, cpC).closing === -12000, 'после пересчёта оплата по счёту осталась авансом',
      bdbA.balanceOf(mid, cpC).closing);
    await call('POST', '/api/basis', { user: masha, body: { basis: 'invoice' } });
    ok(bdbA.balanceOf(mid, cpC).closing === 0, 'перешли на долг «по счёту» — оплата не задвоилась',
      bdbA.balanceOf(mid, cpC).closing);
    await call('POST', '/api/basis', { user: masha, body: { basis: 'closing' } });
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

    /*
     * Д14: почтовый сервер перестал отвечать. Человек должен прочитать
     * «Письмо не ушло: не удалось связаться с почтовым сервером», а не
     * «Не соединиться с 127.0.0.1:… — connect ECONNREFUSED …».
     */
    smtp.close();
    const rawErr = /ECONN|ENOTFOUND|127\.0\.0\.1|getaddrinfo|Не соединиться/;
    r = await call('POST', '/api/reminder/mail', {
      user: masha, body: { cpId: debt.cpId, email: 'buh@dolzhnik.ru', text: debt.text },
    });
    ok(r.status === 400 && r.json.error === 'Письмо не ушло: не удалось связаться с почтовым сервером.' && r.json.reason === 'mail',
      'Д14: напоминание — понятная причина и признак reason=mail', JSON.stringify(r.json));
    ok(!rawErr.test(JSON.stringify(r.json)), 'Д14: сырых кодов и адресов сервера в ответе нет');
    r = await call('POST', '/api/doc/mail', { user: masha, body: { id: someDoc.id, email: 'buh@zarya.ru' } });
    ok(r.status === 400 && /^Письмо не ушло: не удалось связаться/.test(r.json.error) && r.json.reason === 'mail',
      'Д14: документ на почту — то же', (r.json || {}).error);
    r = await call('POST', '/api/mailbox/test', { user: masha });
    ok(r.status === 400 && /^Письмо не ушло: не удалось связаться/.test(r.json.error) && !rawErr.test(r.json.error),
      'Д14: проверочное письмо — то же', (r.json || {}).error);

    r = await call('POST', '/api/mailbox/delete', { user: masha });
    ok(r.status === 200, 'ящик можно отключить');
    r = await call('GET', '/api/state', { user: masha });
    ok(r.json.mailbox === null, 'после отключения ящика нет');
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

  {
    /*
     * Подъём по дереву не отдаёт ни системные файлы, ни боевую базу.
     *
     * Держит это не проверка в serveStatic, а new URL() выше: он схлопывает
     * «..» сам — «/../../data/trapeza.db» приходит уже как «/data/…». Стоит
     * это записать проверкой, потому что защита неочевидна и её легко
     * потерять, разбирая адрес иначе.
     *
     * Запрос шлём сокетом, а не fetch: fetch наводит порядок в адресе у себя,
     * и до сервера подъём не доезжает вовсе — такая проверка была бы зелёной
     * при любой дыре, потому что проверяла бы поведение своего же клиента.
     * Атакующий возьмёт сокет, а Node отдаёт req.url как пришло.
     */
    const fsS = require('node:fs');
    const pathS = require('node:path');
    const sibling = pathS.join(__dirname, 'public', 'app-old');
    fsS.mkdirSync(sibling, { recursive: true });
    fsS.writeFileSync(pathS.join(sibling, 'secret.txt'), 'ЭТОГО-НАРУЖУ-БЫТЬ-НЕ-ДОЛЖНО');
    const rawGet = (line) => new Promise((resolve) => {
      const { port } = server.address();
      const sock = require('node:net').connect(port, '127.0.0.1', () => {
        sock.write(`GET ${line} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('close', () => resolve(buf));
      sock.on('error', () => resolve(buf));
    });
    try {
      for (const attempt of ['/../app-old/secret.txt', '/%2e%2e/app-old/secret.txt',
        '/..%2fapp-old/secret.txt', '/../../app-old/secret.txt']) {
        // eslint-disable-next-line no-await-in-loop
        const leak = await rawGet(attempt);
        ok(!/НАРУЖУ-БЫТЬ-НЕ-ДОЛЖНО/.test(leak),
          `подъём «${attempt}» соседнюю папку не отдаёт`, leak.split('\r\n')[0]);
      }
      const fine = await rawGet('/app.css');
      ok(/--tg-theme/.test(fine), 'а свои файлы по-прежнему отдаются',
        fine.split('\r\n')[0]);
    } finally {
      fsS.rmSync(sibling, { recursive: true, force: true });
    }
  }
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

  section('главный экран: имя и повтор счёта');
  {
    /*
     * Имя в Telegram пишет сам человек, и там бывает что угодно. «Здравствуйте,
     * ;)» выглядит как поломка интерфейса, а не как обращение, — поэтому в
     * приветствие идут только настоящие имена. Логика живёт в app.js
     * (greetName), здесь проверяем то же правило на тех же случаях: файл
     * приложения в прогоне не исполняется, а правило должно быть одно.
     */
    const greetName = (raw) => {
      const first = String(raw || '').trim().split(/\s+/)[0] || '';
      return (first.match(/\p{L}/gu) || []).length >= 2 ? `Здравствуйте, ${first}` : 'Здравствуйте';
    };
    const src = require('node:fs').readFileSync('./public/app/app.js', 'utf8');
    ok(/letters >= 2 \? `Здравствуйте, \$\{first\}`/.test(src),
      'приложение здоровается по тому же правилу, что и прогон');
    for (const [raw, want] of [
      ['Мария Сарычева', 'Здравствуйте, Мария'],
      [';)', 'Здравствуйте'],
      ['🙂', 'Здравствуйте'],
      ['.', 'Здравствуйте'],
      ['', 'Здравствуйте'],
      ['Ян', 'Здравствуйте, Ян'],
    ]) ok(greetName(raw) === want, `имя «${raw || 'пусто'}» → «${want}»`, greetName(raw));

    // Кнопка повтора подписывается именем клиента — значит оно должно
    // приезжать в сводке документа. Без него было бы «Повторить: последний
    // счёт», то есть кнопка без ответа на «кому».
    const mashaU = require('./lib/bot-db').getOrCreateUser(MASHA.id);
    const stateR = await call('GET', '/api/state', { user: masha });
    const withName = (stateR.json.docs || []).find((d) => d.cpName);
    ok(Boolean(withName), 'в сводке документа приезжает имя клиента',
      JSON.stringify((stateR.json.docs || [])[0] || {}).slice(0, 80));
    ok(mashaU.id > 0, 'пользователь на месте');
  }

  section('обращение в поддержку');
  {
    /*
     * Отсюда сообщение уходит прямо в чат владельца, а общий ограничитель
     * пропускает 120 запросов в минуту — по две тысячи символов сто двадцать
     * раз подряд. Настоящее обращение в таком потоке потерялось бы.
     */
    const podderzhka = initDataFor({ id: 500404, first_name: 'Жалобщик', username: 'zhaloba' });
    const short2 = await call('POST', '/api/support', { user: podderzhka, body: { text: 'ой' } });
    ok(/пары слов мало/.test((short2.json || {}).error || ''), 'слишком короткое обращение отклонено',
      JSON.stringify(short2.json));
    const codes2 = [];
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const one = await call('POST', '/api/support', {
        user: podderzhka, body: { text: `Не открывается счёт номер ${i}` },
      });
      codes2.push(one.json && one.json.error ? 'стоп' : 'ушло');
    }
    ok(codes2.slice(0, 5).every((c) => c === 'ушло'), 'первые обращения доходят', codes2.join(','));
    ok(codes2.slice(-1)[0] === 'стоп', 'поток в чат владельца останавливается', codes2.join(','));
  }

  section('оплата по почте: чужую не отдаём');
  {
    /*
     * Ничьим приходит КАЖДЫЙ боевой платёж: Lava не возвращает Telegram-id.
     * Значит «Я оплатил» — дорога к доступу для всех, кто платит, и раньше
     * она открывалась одним лишь знанием чужого адреса с кассы. Проверяем,
     * что теперь нужен код из письма.
     */
    const billX = require('./lib/billing');
    const bdbP = require('./lib/bot-db');
    const mailerX = require('./lib/mail');
    const realSendX = mailerX.sendMail;
    let toX = '';
    let textX = '';
    mailerX.sendMail = async (l) => { toX = l.to; textX = l.text || ''; return { ok: true }; };
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_FROM = 'bot@test';

    const { handlePayment } = require('./lava-webhook');
    await handlePayment({ externalId: 'mini-1', amount: 349, currency: 'RUB', status: 'paid',
      email: 'payer@mail.ru', tgId: null, paid: true, raw: {} });

    const mashaU = bdbP.getOrCreateUser(MASHA.id);
    const petyaU = bdbP.getOrCreateUser(PETYA.id);
    billX.revokeAccess(mashaU.id);
    billX.revokeAccess(petyaU.id);

    // Пётр знает чужой адрес и пробует забрать оплату себе.
    const rq = await call('POST', '/api/pay/claim', { user: petya, body: { email: 'payer@mail.ru' } });
    ok(rq.json && rq.json.sent === true, 'приложение отвечает «код выслан», а не выдаёт доступ',
      JSON.stringify(rq.json));
    ok(!billX.accessInfo(petyaU.id).active, 'постороннему доступ не выдан');
    ok(billX.unclaimedByEmail('payer@mail.ru').length === 1, 'оплата осталась ничьей');
    ok(!JSON.stringify(rq.json).includes(((textX.match(/(\d{6})/) || [])[1]) || 'нет-кода'),
      'кода в ответе API нет');

    // Ответ одинаков и для адреса, по которому оплаты нет: иначе перебором
    // видно, кто у нас платил.
    const rq2 = await call('POST', '/api/pay/claim', { user: petya, body: { email: 'nikto@mail.ru' } });
    ok(JSON.stringify(rq2.json) === JSON.stringify(rq.json),
      'по несуществующей оплате ответ тот же — перебором плательщиков не найти',
      JSON.stringify(rq2.json));

    const rbad = await call('POST', '/api/pay/claim/confirm', { user: petya, body: { code: '123' } });
    ok(rbad.json && /шесть цифр/.test(rbad.json.error || ''), 'короткий код отклоняется',
      JSON.stringify(rbad.json));

    // А владелец почты вводит код из письма и получает доступ.
    await call('POST', '/api/pay/claim', { user: masha, body: { email: 'payer@mail.ru' } });
    ok(toX === 'payer@mail.ru', 'письмо ушло на адрес из платежа', toX);
    const codeX = ((textX.match(/(\d{6})/) || [])[1]) || '';
    const rok = await call('POST', '/api/pay/claim/confirm', { user: masha, body: { code: codeX } });
    ok(rok.json && rok.json.found === 1, 'по верному коду оплата зачтена', JSON.stringify(rok.json));
    ok(billX.accessInfo(mashaU.id).active, 'и доступ включился');
    ok(billX.unclaimedByEmail('payer@mail.ru').length === 0, 'ничьих оплат по этому адресу не осталось');

    /*
     * Упавшая отправка кода не теряется — как и в боте.
     *
     * Стоял .catch(() => {}): почта легла, приложение отвечало «код выслан»,
     * человек ждал письма, которого не было, и на каждый заход тратил одну из
     * пяти суточных попыток. Ответ ему менять нельзя (выдаст, кто платил), а
     * вот в журнал офиса запись нужна, и попытку надо вернуть.
     */
    await handlePayment({ externalId: 'mini-2', amount: 349, currency: 'RUB', status: 'paid',
      email: 'down@mail.ru', tgId: null, paid: true, raw: {} });
    const officeX = require('./lib/office');
    const wasX = officeX.list('claim-mail').length;
    mailerX.sendMail = async () => { throw new Error('SMTP 421'); };
    billX.revokeAccess(petyaU.id);
    const sentWas = (billX.pendingClaim(petyaU.id) || {}).sentToday || 0;
    const rdown = await call('POST', '/api/pay/claim', { user: petya, body: { email: 'down@mail.ru' } });
    ok(JSON.stringify(rdown.json) === JSON.stringify(rq.json),
      'при упавшей почте ответ прежний — иначе видно, кто платил', JSON.stringify(rdown.json));
    const evX = officeX.list('claim-mail');
    ok(evX.length > wasX && evX[0].text === 'down@mail.ru',
      'но в журнале офиса запись есть', `${evX.length} шт., первое: ${evX[0] && evX[0].text}`);
    const pcX = billX.pendingClaim(petyaU.id);
    ok(pcX && pcX.sentToday === sentWas, 'и сгоревшая впустую попытка возвращена',
      `${sentWas} → ${pcX && pcX.sentToday}`);

    mailerX.sendMail = realSendX;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
  }

  section('выгрузка переписок — только владельцу');
  {
    /*
     * Выгрузка идёт по всем клиентам сразу. Раньше её получал любой, кто
     * открыл приложение, — это была утечка чужих имён, сумм и вопросов.
     * Проверяем по-настоящему: Маша пишет ассистенту, Петя просит выгрузку
     * и не должен увидеть ни одной Машиной фразы.
     */
    const bdbD = require('./lib/bot-db');
    const mashaD = bdbD.getOrCreateUser(MASHA.id).id;
    const secret = 'ООО Тайная Ромашка должна 777 777';
    bdbD.saveAiMessage({ userId: mashaD, source: 'miniapp', role: 'user', type: 'text', text: secret });

    const was = process.env.SUPPORT_CHAT_ID;
    process.env.SUPPORT_CHAT_ID = String(MASHA.id);

    const byPetya = await call('GET', '/api/ask/dataset?limit=5000', { user: petya });
    ok(!byPetya.text.includes('Тайная Ромашка'), 'посторонний не видит чужих фраз', byPetya.text.slice(0, 80));
    ok(!(byPetya.json && Array.isArray(byPetya.json.dataset)), 'и выгрузку не получает вовсе');

    const byOwner = await call('GET', '/api/ask/dataset?limit=5000', { user: masha });
    ok(byOwner.json && Array.isArray(byOwner.json.dataset)
      && byOwner.json.dataset.some((m) => m.text === secret), 'владелец выгрузку получает');

    // Без SUPPORT_CHAT_ID владельца нет — значит выгрузки нет ни у кого.
    delete process.env.SUPPORT_CHAT_ID;
    const noOwner = await call('GET', '/api/ask/dataset', { user: masha });
    ok(!(noOwner.json && Array.isArray(noOwner.json.dataset)), 'без владельца выгрузка закрыта для всех');

    if (was === undefined) delete process.env.SUPPORT_CHAT_ID; else process.env.SUPPORT_CHAT_ID = was;
  }

  section('CRM: вкладка, лента и напоминания');
  {
    /*
     * Вкладка CRM держится на трёх запросах: список напоминаний, их закрытие
     * и общая лента. Раньше ни один из них не проверялся вовсе — а ошибка тут
     * самая дорогая: чужая заметка в своей ленте или чужое напоминание,
     * которое можно закрыть по номеру.
     */
    const crmLib = require('./lib/crm');
    const mu = bdb.getOrCreateUser(MASHA.id);
    const pu = bdb.getOrCreateUser(PETYA.id);
    const myCp = bdb.createCp(mu.id, { name: 'ООО «CRM-Клиент»', kind: 'customer' });
    const hisCp = bdb.createCp(pu.id, { name: 'ООО «Чужой клиент»', kind: 'customer' });
    const today = docService.todayISO();

    r = await call('GET', '/api/crm/feed');
    ok(r.status === 401, 'лента CRM без подписи не отдаётся', r.status);

    r = await call('POST', '/api/crm/note', { user: masha, body: { cpId: myCp, text: 'Договорились на пятницу' } });
    ok(r.json && r.json.id > 0, 'заметка по своему клиенту сохраняется', JSON.stringify(r.json));
    r = await call('POST', '/api/crm/note', { user: petya, body: { cpId: hisCp, text: 'Секрет Петра' } });
    ok(r.json && r.json.id > 0, 'у Петра своя заметка');

    r = await call('GET', '/api/crm/feed', { user: masha });
    const feedItems = (r.json && r.json.items) || [];
    const mine = feedItems.find((i) => i.text === 'Договорились на пятницу');
    ok(r.status === 200 && Boolean(mine), 'своя заметка в общей ленте', JSON.stringify(feedItems).slice(0, 120));
    ok(mine && mine.kind === 'note' && mine.cpId === myCp && mine.cpName === 'ООО «CRM-Клиент»',
      'у события есть вид, клиент и его название');
    ok(!JSON.stringify(feedItems).includes('Секрет Петра') && !JSON.stringify(feedItems).includes('Чужой клиент'),
      'чужих заметок и клиентов в ленте нет');
    ok(feedItems.every((it, i) => i === 0 || String(feedItems[i - 1].at) >= String(it.at)),
      'лента идёт от свежего к старому');

    // Напоминания: просроченное, на сегодня и на потом — сервер сам помечает срок.
    const mk = (uid, cpId, shift, text) => {
      const f = crmLib.addFollowup(uid, cpId, { today, days: 1, text });
      require('./db').db.prepare('UPDATE cp_followups SET due = ? WHERE id = ?').run(crmLib.plusDays(today, shift), f.id);
      return f.id;
    };
    const fLate = mk(mu.id, myCp, -3, 'Просрочено: позвонить');
    const fToday = mk(mu.id, myCp, 0, 'Сегодня: отправить акт');
    const fSoon = mk(mu.id, myCp, 5, 'Скоро: согласовать');
    const fHis = mk(pu.id, hisCp, 0, 'Чужое напоминание');

    r = await call('GET', '/api/crm/followups', { user: masha });
    const fl = (r.json && r.json.followups) || [];
    const by = (id) => fl.find((f) => f.id === id) || {};
    ok(by(fLate).overdue === true && by(fToday).today === true && !by(fSoon).overdue && !by(fSoon).today,
      'просрочено / сегодня / скоро размечены сервером');
    ok(!fl.some((f) => f.id === fHis), 'чужого напоминания в списке нет');

    r = await call('POST', '/api/crm/followup/done', { user: masha, body: { id: fHis } });
    ok(r.json && r.json.error, 'чужое напоминание закрыть нельзя', JSON.stringify(r.json));
    r = await call('POST', '/api/crm/followup/snooze', { user: masha, body: { id: fHis, days: 3 } });
    ok(r.json && r.json.error, 'и отложить его тоже', JSON.stringify(r.json));

    r = await call('POST', '/api/crm/followup/done', { user: masha, body: { id: fToday } });
    ok(r.json && r.json.ok, '«Сделано» закрывает своё напоминание');
    r = await call('POST', '/api/crm/followup/snooze', { user: masha, body: { id: fLate, days: 3 } });
    ok(r.json && r.json.ok, '«Отложить» сдвигает просроченное');
    r = await call('GET', '/api/crm/followups', { user: masha });
    const after = (r.json && r.json.followups) || [];
    ok(!after.some((f) => f.id === fToday), 'закрытое пропало из списка');
    const moved = after.find((f) => f.id === fLate);
    ok(moved && moved.due === crmLib.plusDays(today, 3) && !moved.overdue,
      'отложенное — через три дня от сегодня и уже не просрочено', moved && moved.due);
  }

  section('«Повторить»: данные для формы');
  {
    /*
     * Раньше «Повторить» брало из списка документов одни позиции: ставка НДС и
     * основание накладной терялись, и копия выходила не такой, как оригинал.
     * Теперь форме отдаёт данные сервер — и обязан делать это только владельцу.
     */
    const mu = bdb.getOrCreateUser(MASHA.id);
    const cpRep = bdb.createCp(mu.id, { name: 'ООО «Повторяемый»', kind: 'customer' });
    const items = [{ name: 'Бумага А4', unit: 'пачка', qty: 10, price: 300 }];
    const issued = await call('POST', '/api/doc', {
      user: masha, body: { type: 'torg12', cpId: cpRep, date: '2026-09-11', items, vatRate: null, basis: 'Заказ № 77' },
    });
    ok(issued.json && issued.json.doc, 'исходная накладная выписана', JSON.stringify(issued.json).slice(0, 100));
    const srcId = issued.json.doc.id;
    bdb.markPaid(mu.id, srcId, '2026-09-20');

    r = await call('GET', `/api/doc/repeat?id=${srcId}`);
    ok(r.status === 401, 'без подписи данные для повтора не отдаются', r.status);
    r = await call('GET', `/api/doc/repeat?id=${srcId}`, { user: petya });
    ok(r.json && r.json.error && !r.json.draft, 'чужой документ повторить нельзя', JSON.stringify(r.json));
    r = await call('GET', '/api/doc/repeat?id=999999', { user: masha });
    ok(r.json && r.json.error, 'несуществующий документ — понятный отказ', JSON.stringify(r.json));

    r = await call('GET', `/api/doc/repeat?id=${srcId}`, { user: masha });
    const dr = (r.json || {}).draft || {};
    ok(dr.type === 'torg12' && dr.cpId === cpRep, 'тот же тип и клиент', JSON.stringify(dr).slice(0, 100));
    ok(dr.items && dr.items.length === 1 && dr.items[0].name === 'Бумага А4' && dr.items[0].qty === 10 && dr.items[0].price === 300,
      'те же позиции');
    ok(dr.basis === 'Заказ № 77', 'основание накладной переезжает в форму', dr.basis);
    ok(Object.prototype.hasOwnProperty.call(dr, 'vatRate') && dr.vatRate === null,
      '«без НДС» остаётся явным null, а не «возьми ставку фирмы»', JSON.stringify(dr.vatRate));
    ok(!('paidAt' in dr) && !('paid_at' in dr) && !('number' in dr) && !('date' in dr),
      'оплата, номер и дата в копию не едут — номер возьмёт сервер, дата сегодняшняя', Object.keys(dr).join());
    ok(r.json.from.number === issued.json.doc.number && r.json.otherOrg === false,
      'сказано, что повторяем, и что фирма та же');

    // Повтор через форму — обычная выписка: документ новый, неоплаченный, с номером по порядку.
    const again = await call('POST', '/api/doc', { user: masha, body: { ...dr } });
    ok(again.json && again.json.doc && again.json.doc.id !== srcId, 'выписка по данным повтора проходит как обычная',
      JSON.stringify(again.json).slice(0, 100));
    const copy = bdb.getDoc(mu.id, again.json.doc.id);
    ok(!copy.paid_at && copy.date === docService.todayISO(), 'у копии нет отметки оплаты и сегодняшняя дата',
      `${copy.paid_at} / ${copy.date}`);
    ok(Number(copy.seq) > Number(bdb.getDoc(mu.id, srcId).seq), 'номер — следующий по порядку',
      `${bdb.getDoc(mu.id, srcId).seq} → ${copy.seq}`);

    // Другая фирма: повтор выйдет от текущей, и приложение об этом предупреждает.
    const orgOld = bdb.currentOrg(mu.id).id;
    const orgNew = bdb.createOrg(mu.id, { name: 'ООО «Вторая фирма»', inn: '7707083893' });
    bdb.setActiveOrg(mu.id, orgNew);
    r = await call('GET', `/api/doc/repeat?id=${srcId}`, { user: masha });
    ok(r.json && r.json.otherOrg === true && r.json.orgName === 'ООО «Вторая фирма»',
      'документ другой фирмы: приложение знает об этом и называет текущую', JSON.stringify(r.json).slice(-90));
    bdb.setActiveOrg(mu.id, orgOld);

    // Не-позиционный документ повторять нельзя.
    const pay = bdb.saveDoc(mu.id, { orgId: orgOld, cpId: cpRep, type: 'pp', number: '1', seq: 9001, date: '2026-09-01', total: 100, payload: {} });
    r = await call('GET', `/api/doc/repeat?id=${pay}`, { user: masha });
    ok(r.json && r.json.error, 'платёжку «Повторить» не предлагает: у неё нет позиций', JSON.stringify(r.json));
  }

  section('акт за месяц');
  {
    /*
     * Акт складывает накладные и УПД клиента за месяц в один документ. Три вещи
     * здесь стоят денег: чужой клиент, второй акт на те же накладные и долг,
     * который акт обязан не менять — сумма уже в накладных.
     */
    const mu = bdb.getOrCreateUser(MASHA.id);
    const cpMa = bdb.createCp(mu.id, { name: 'ООО «Месячный»', kind: 'customer', opening_date: '2026-01-01' });
    const today = docService.todayISO();
    const thisYm = today.slice(0, 7);
    const prevYm = (() => {
      const d = new Date(`${thisYm}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();
    const ship = (date, price, type = 'torg12') => call('POST', '/api/doc', {
      user: masha, body: { type, cpId: cpMa, date, items: [{ name: 'Обеды', unit: 'шт.', qty: 1, price }] },
    });
    const s1 = await ship(`${thisYm}-01`, 30000);
    const s2 = await ship(`${thisYm}-02`, 20000, 'upd');
    const s3 = await ship(`${prevYm}-15`, 7000);
    ok(s1.json.doc && s2.json.doc && s3.json.doc, 'три отгрузки выписаны: две в этом месяце, одна в прошлом');
    const bal = () => bdb.balanceOf(mu.id, cpMa).closing;
    const actsOf = () => bdb.listDocs(mu.id, 200, cpMa).filter((d) => d.type === 'usl').length;

    // Клиент без предоплаты: накладные висят долгом, акт «оплачен» был бы неправдой.
    r = await call('GET', `/api/month-act?cpId=${cpMa}`, { user: masha });
    ok(r.json && r.json.reason === 'noprepay' && !r.json.months && /предоплат/.test(r.json.error || ''),
      'клиенту без предоплаты предпросмотр акта за месяц отказывает понятным текстом', JSON.stringify(r.json));
    const debtPlain = bal();
    r = await call('POST', '/api/month-act', { user: masha, body: { cpId: cpMa, ym: thisYm } });
    ok(r.json && r.json.reason === 'noprepay' && !r.json.doc, 'и выписать такой акт нельзя', JSON.stringify(r.json));
    ok(actsOf() === 0 && bal() === debtPlain, 'отказ ничего не выписал и долг не тронул');
    const cardOf = async () => ((await call('GET', '/api/cps', { user: masha })).json.cps || []).find((c) => c.id === cpMa);
    ok((await cardOf()).prepay === null, 'в карточке клиента без предоплаты prepay пуст — кнопки «Акт за месяц» не будет');
    bdb.setPrepayMode(mu.id, cpMa, bdb.currentOrgId(mu.id), true);
    ok((await cardOf()).prepay, 'включили предоплату — в карточке она есть и кнопка появится');

    r = await call('GET', `/api/month-act?cpId=${cpMa}`);
    ok(r.status === 401, 'без подписи предпросмотр не отдаётся', r.status);
    r = await call('GET', `/api/month-act?cpId=${cpMa}`, { user: petya });
    ok(r.json && r.json.error && !r.json.months, 'чужого клиента предпросмотр не показывает', JSON.stringify(r.json));
    r = await call('POST', '/api/month-act', { user: petya, body: { cpId: cpMa, ym: thisYm } });
    ok(r.json && r.json.error, 'и выписать акт на чужого клиента нельзя', JSON.stringify(r.json));

    r = await call('GET', `/api/month-act?cpId=${cpMa}`, { user: masha });
    const [cur, prev] = r.json.months || [];
    ok(r.json.months && r.json.months.length === 2 && cur.ym === thisYm && prev.ym === prevYm,
      'предпросмотр — два месяца: этот и прошлый', JSON.stringify((r.json.months || []).map((m) => m.ym)));
    ok(cur.docs.length === 2 && cur.sum === 50000 && !cur.done && prev.docs.length === 1 && prev.sum === 7000,
      'в этом месяце две отгрузки на 50 000, в прошлом одна на 7 000', `${cur.docs.length}/${cur.sum}, ${prev.docs.length}/${prev.sum}`);

    const debt0 = bal();
    r = await call('POST', '/api/month-act', { user: masha, body: { cpId: cpMa, ym: thisYm } });
    ok(r.json && r.json.doc && r.json.total === 50000 && r.json.file && r.json.month, 'акт за этот месяц выписан на 50 000', JSON.stringify(r.json).slice(0, 120));
    const act1 = bdb.getDoc(mu.id, r.json.doc.id);
    // Р10: акт отмечается оплаченным только тогда, когда оплачены накладные месяца. Здесь предоплата
    // включена, но денег на ней нет — накладные висят долгом, и «оплачен» на акте было бы неправдой.
    ok(act1.type === 'usl' && act1.no_debt === 1 && !act1.paid_at,
      'акт — «без долга», но не оплачен, пока по накладным месяца долг');
    ok(bal() === debt0, 'долг клиента не изменился', `${debt0} → ${bal()}`);
    bdb.rebuildDebt(mu.id);
    ok(bal() === debt0, 'пересчёт долга акт не удваивает');

    r = await call('GET', `/api/month-act?cpId=${cpMa}`, { user: masha });
    ok(r.json.months[0].done && r.json.months[0].docs.length === 0 && r.json.months[0].acts.length === 1,
      'теперь месяц «в акте»: позиций нет, акт назван');
    r = await call('POST', '/api/month-act', { user: masha, body: { cpId: cpMa, ym: thisYm } });
    ok(r.json && r.json.reason === 'have', 'второй акт на те же накладные не выписывается', JSON.stringify(r.json));

    // Новая накладная после акта: во второй акт идёт одна она.
    await ship(`${thisYm}-03`, 5000);
    r = await call('GET', `/api/month-act?cpId=${cpMa}`, { user: masha });
    ok(r.json.months[0].docs.length === 1 && r.json.months[0].sum === 5000 && !r.json.months[0].done,
      'после акта в предпросмотре — только новая накладная (5 000)');
    r = await call('POST', '/api/month-act', { user: masha, body: { cpId: cpMa, ym: thisYm } });
    ok(r.json && r.json.total === 5000, 'второй акт — на 5 000, а не на весь месяц заново', JSON.stringify(r.json).slice(0, 80));

    // Прошлый месяц и граничные случаи.
    r = await call('POST', '/api/month-act', { user: masha, body: { cpId: cpMa, ym: prevYm } });
    ok(r.json && r.json.total === 7000, 'акт за прошлый месяц — на 7 000');
    r = await call('POST', '/api/month-act', { user: masha, body: { cpId: cpMa, ym: '2099-01' } });
    ok(r.json && r.json.reason === 'ym', 'будущий месяц отклонён', JSON.stringify(r.json));
    r = await call('POST', '/api/month-act', { user: masha, body: { cpId: cpMa, ym: 'абв' } });
    ok(r.json && r.json.reason === 'ym', 'кривой месяц отклонён');
    r = await call('POST', '/api/month-act', { user: masha, body: { cpId: cpMa, ym: '2020-01' } });
    ok(r.json && r.json.reason === 'none', 'месяц без отгрузок: акту не на чем строиться', JSON.stringify(r.json));
    ok(bal() === debt0 + 5000 && bdb.monthActsOf(mu.id, cpMa, thisYm).length === 2,
      'итог: долг вырос только на новую накладную, актов за месяц два', String(bal() - debt0));

    // Р10: оплатили накладные первого акта — он оплачен; отменили оплату одной — снова нет.
    const actPaid = () => Boolean(bdb.getDoc(mu.id, act1.id).paid_at);
    await call('POST', '/api/doc/paid', { user: masha, body: { id: s1.json.doc.id } });
    ok(!actPaid(), 'Р10: оплачена одна накладная из двух — акт ещё не оплачен');
    await call('POST', '/api/doc/paid', { user: masha, body: { id: s2.json.doc.id } });
    ok(actPaid(), 'Р10: оплачены обе — акт за месяц оплачен сам');
    ok(bdb.unpaidSummary(mu.id).docs.every((d) => d.id !== act1.id), 'и из «ждут оплаты» он ушёл');
    await call('POST', '/api/doc/paid', { user: masha, body: { id: s1.json.doc.id, paid: false } });
    ok(!actPaid(), 'Р10: оплату накладной отменили — акт снова не оплачен');
    ok(bdb.getDoc(mu.id, act1.id).no_debt === 1 && bdb.listOps(mu.id, cpMa).every((o) => o.doc_id !== act1.id),
      'при этом акт по-прежнему долга не создаёт и проводок не имеет');
  }

  section('вкладка CRM в разметке приложения');
  {
    // Файл приложения в этом прогоне не исполняется, а вкладка — это строка
    // в таблице; проверяем, что она на месте и что значок есть в спрайте.
    const fs = require('node:fs');
    const js = fs.readFileSync('./public/app/app.js', 'utf8');
    const html = fs.readFileSync('./public/app/index.html', 'utf8');
    ok(/\{ name: 'crm', label: 'CRM', icon: 'bell' \}/.test(js), 'вкладка CRM есть в нижней панели');
    ok(/screens\.crm = async function/.test(js), 'у вкладки есть экран');
    ok(html.includes('id="i-bell"'), 'значок вкладки есть в спрайте');
    ok(html.includes('<nav id="tabs"'), 'нижняя панель есть в разметке');
    // Вкладок ровно пять: шестая на узком экране уже не помещается.
    const tabs = /const TABS = \[([\s\S]*?)\n\];/.exec(js)[1].match(/name: '/g) || [];
    ok(tabs.length === 5, 'в панели пять вкладок', tabs.length);
  }

  section('публичная ссылка /d/ не роняет сервер');
  {
    /*
     * Кривое процентное кодирование на публичном адресе раньше бросало
     * URIError из асинхронного обработчика — и Node завершал процесс.
     * Сервер здесь живёт в том же процессе, что и проверки, поэтому на
     * прежнем коде весь прогон обрывался прямо на этом запросе.
     */
    const bad = await call('GET', '/d/%E0%A4%A');
    ok(bad.status === 404, 'кривая ссылка — обычный ответ «не работает»', bad.status);
    const alive = await call('GET', '/health');
    ok(alive.status === 200 && alive.text === 'ok', 'и сервер после неё жив');

    /*
     * Первый адрес в X-Forwarded-For пишет сам клиент. Раньше лимит считался
     * по нему, и каждая подмена открывала новый счётчик — перебор ссылок
     * шёл без ограничения. Здесь 61 запрос с разными X-Forwarded-For: лимит
     * 60 в минуту обязан сработать, потому что пришли все с одного адреса.
     */
    let limited = false;
    for (let i = 0; i < 61 && !limited; i += 1) {
      const r = await call('GET', `/d/nope${i}`, { headers: { 'X-Forwarded-For': `203.0.113.${i}` } });
      if (r.status === 429) limited = true;
    }
    ok(limited, 'подмена X-Forwarded-For не обходит ограничение частоты');
  }

  section('вход с сайта: одноразовый вход и сессия');
  {
    const webAuth = require('./lib/web-auth');
    const { db } = require('./db');
    const web = bdb.getOrCreateUser(610001, 'Вера Веб', 'vera');
    const anna = bdb.getOrCreateUser(ANNA.id, 'Анна', 'anna');
    const XRW = { 'X-Requested-With': 'pervichka' };
    const hostOf = () => base;                  // «свой» Origin — адрес этого же сервера
    const sha = (s2) => crypto.createHash('sha256').update(s2).digest('hex');
    const ASCII_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    webAuth.resetLimits();

    // --- старт ---
    r = await call('POST', '/api/login/start', { body: {} });
    ok(r.status === 403, 'старт входа без заголовка приложения отвергнут', r.status);
    r = await call('POST', '/api/login/start', { body: {}, headers: { ...XRW, Origin: 'https://evil.example' } });
    ok(r.status === 403, 'старт входа с чужого сайта (Origin) отвергнут', r.status);
    r = await call('GET', '/api/login/start', { headers: XRW });
    ok(r.status === 405, 'старт входа только POST', r.status);

    r = await call('POST', '/api/login/start', { body: {}, headers: { ...XRW, Origin: hostOf(), 'User-Agent': ASCII_UA } });
    ok(r.status === 200 && /^[A-Za-z0-9_-]{32}$/.test(r.json.nonce), 'старт входа выдаёт nonce в 32 знака base64url', JSON.stringify(r.json).slice(0, 120));
    const nonce = r.json.nonce;
    ok(r.json.link === `https://t.me/pervichka_app_bot?start=login_${nonce}`, 'ссылка ведёт в бота с параметром login_<nonce>', r.json.link);
    ok(/^<svg[\s\S]*<\/svg>$/.test(r.json.qr) && r.json.qr.includes('для входа через Telegram'), 'вместе со ссылкой приходит QR для неё');
    ok(r.json.ttl === 300, 'вход живёт пять минут', r.json.ttl);
    const startCode = r.json.code;
    ok(Number.isInteger(startCode) && startCode >= 10 && startCode <= 99, 'вместе с входом приходит двузначное число для сверки в боте', startCode);
    ok(!/\d/.test(/aria-label="([^"]*)"/.exec(r.json.qr)[1]) && !r.json.link.endsWith(String(startCode)),
      'числа нет ни в подписи QR, ни в ссылке (QR могут сфотографировать)');
    ok(db.prepare('SELECT code FROM web_logins WHERE nonce_hash = ?').get(sha(nonce)).code === startCode, 'число записано во вход');
    {
      // Сто входов: число всегда двузначное и не залипает на одном значении.
      const seen = new Set();
      for (let i = 0; i < 100; i += 1) {
        const t = webAuth.startLogin({ ip: '203.0.113.1' });
        seen.add(t.code);
        if (t.code < 10 || t.code > 99) { ok(false, 'число вне 10–99', t.code); break; }
      }
      ok(seen.size > 30, 'числа разные от входа к входу', seen.size);
    }

    // Имя бота берётся из окружения, но только если оно похоже на имя.
    process.env.BOT_USERNAME = '@my_test_bot';
    webAuth.resetLimits();
    const rb = await call('POST', '/api/login/start', { body: {}, headers: XRW });
    ok(rb.json.link.startsWith('https://t.me/my_test_bot?start=login_'), 'имя бота берётся из BOT_USERNAME', rb.json.link);
    process.env.BOT_USERNAME = 'bad name/with?junk';
    const rb2 = await call('POST', '/api/login/start', { body: {}, headers: XRW });
    ok(rb2.json.link.startsWith('https://t.me/pervichka_app_bot?'), 'кривое имя бота не попадает в адрес', rb2.json.link);
    delete process.env.BOT_USERNAME;

    // --- в базе только хэш ---
    {
      const rows = db.prepare('SELECT * FROM web_logins').all();
      const mine = rows.find((x) => x.nonce_hash === sha(nonce));
      ok(mine && mine.confirmed === 0 && mine.used === 0 && mine.user_id === null, 'вход записан хэшем: не подтверждён, не использован, user_id пуст');
      ok(!rows.some((x) => Object.values(x).some((v) => String(v).includes(nonce))), 'самого nonce нет ни в одном поле таблицы');
      ok(mine && mine.ua.includes('Chrome') && mine.expires_at > mine.created_at, 'браузер и срок записаны для показа в боте');
    }

    // --- сверка числа (то, что делает бот при нажатии на кнопку) ---
    {
      const t = webAuth.startLogin({ ip: '203.0.113.2', ua: ASCII_UA });
      const pv = webAuth.previewLogin(t.nonce);
      ok(pv.choices.length === 3 && new Set(pv.choices).size === 3 && pv.choices.includes(t.code), 'три разных числа, верное среди них', JSON.stringify(pv.choices));
      ok(JSON.stringify(webAuth.previewLogin(t.nonce).choices) === JSON.stringify(pv.choices), 'повторный показ даёт те же числа в том же порядке');
      const good = pv.choices.indexOf(t.code);
      const bad = [0, 1, 2].find((i) => i !== good);
      ok(webAuth.answerLogin(pv.id, 3, web.id) === 'stale' && webAuth.answerLogin(pv.id, -1, web.id) === 'stale'
        && webAuth.answerLogin(pv.id, 1.5, web.id) === 'stale' && webAuth.answerLogin(pv.id, '1', web.id) === 'stale', 'номер кнопки вне 0–2 или не целый — отказ, вход цел');
      ok(webAuth.answerLogin(pv.id, bad, web.id) === 'wrong', 'неверное число — «не совпало»');
      ok(webAuth.answerLogin(pv.id, good, web.id) === 'stale', 'после ошибки верное уже не принимается');
      ok(webAuth.checkLogin(t.nonce).status === 'denied', 'вход отклонён навсегда');
      const t2 = webAuth.startLogin({ ip: '203.0.113.2' });
      const pv2 = webAuth.previewLogin(t2.nonce);
      ok(webAuth.answerLogin(pv2.id, pv2.choices.indexOf(t2.code), web.id) === 'ok', 'верное число — подтверждено');
      ok(webAuth.answerLogin(pv2.id, pv2.choices.indexOf(t2.code), web.id) === 'stale', 'и второй раз — уже нет');
      ok(webAuth.checkLogin(t2.nonce).status === 'ok', 'сайт получает сессию');
      webAuth.logoutAll(web.id);
      // Без показа кнопок отвечать нечем: числа ещё не выбраны.
      const t3 = webAuth.startLogin({});
      ok(webAuth.answerLogin(webAuth.sha(t3.nonce).slice(0, 20), 0, web.id) === 'stale', 'ответ на вход, которого боту ещё не показывали, — отказ');
      // Среднее по неверным ответам: без знания числа проходит не больше трети.
      let pass = 0;
      const N = 300;
      for (let i = 0; i < N; i += 1) {
        const x = webAuth.startLogin({});
        const px = webAuth.previewLogin(x.nonce);
        if (webAuth.answerLogin(px.id, crypto.randomInt(0, 3), web.id) === 'ok') pass += 1;
      }
      ok(pass > 0.2 * N && pass < 0.47 * N, 'слепой выбор из трёх проходит примерно в трети случаев и без второй попытки', `${pass} из ${N}`);
      webAuth.logoutAll(web.id);
    }

    // --- миграция: у старой базы таблица была без числа ---
    {
      const { DatabaseSync } = require('node:sqlite');
      const old = new DatabaseSync(':memory:');
      old.exec(`CREATE TABLE web_logins (
        id INTEGER PRIMARY KEY AUTOINCREMENT, nonce_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, user_id INTEGER, confirmed INTEGER NOT NULL DEFAULT 0,
        denied INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0,
        ip TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '')`);
      old.prepare('INSERT INTO web_logins (nonce_hash, created_at, expires_at) VALUES (?,?,?)').run('h1', 'a', 'b');
      webAuth.migrate(old);
      webAuth.migrate(old);                      // повторный запуск ничего не ломает
      const cols = old.prepare('PRAGMA table_info(web_logins)').all().map((c) => c.name);
      const row = old.prepare('SELECT * FROM web_logins').get();
      ok(cols.includes('code') && cols.includes('choices') && row.nonce_hash === 'h1' && row.code === 0 && row.choices === '',
        'миграция добавляет code и choices, старая строка цела (число 0), повторный запуск безопасен');
      old.close();
      // Вход старой строки без числа боту не предлагается.
      const legacy = crypto.randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO web_logins (nonce_hash, created_at, expires_at, code) VALUES (?,?,?,0)')
        .run(sha(legacy), new Date().toISOString(), new Date(Date.now() + 60000).toISOString());
      ok(webAuth.previewLogin(legacy) === null, 'вход, заведённый до сверки чисел (code = 0), боту не предлагается');
    }

    // --- опрос до подтверждения ---
    webAuth.resetLimits();
    r = await call('POST', '/api/login/check', { body: { nonce }, headers: XRW });
    ok(r.status === 200 && r.json.status === 'wait' && !r.headers.get('set-cookie'), 'пока не подтвердили — ждём, cookie нет', JSON.stringify(r.json));
    r = await call('POST', '/api/login/check', { body: { nonce }, headers: XRW });
    ok(r.status === 429, 'опрос чаще раза в секунду на один вход — 429', r.status);

    // --- кривой и чужой nonce ---
    webAuth.resetLimits();
    for (const bad of ['', 'short', 'x'.repeat(33), `${nonce.slice(0, 31)}!`, 12345, null, ['a'], { a: 1 }]) {
      const rr = await call('POST', '/api/login/check', { body: { nonce: bad }, headers: XRW });
      if (rr.status !== 400) { ok(false, `кривой nonce ${JSON.stringify(bad)} → 400`, rr.status); break; }
      webAuth.resetLimits();
    }
    ok(true, 'кривые nonce (пустой, короткий, длинный, не base64url, не строка) отвергаются 400');
    const stranger = crypto.randomBytes(24).toString('base64url');
    r = await call('POST', '/api/login/check', { body: { nonce: stranger }, headers: XRW });
    ok(r.status === 404 && r.json.status === 'gone', 'чужой правильной формы nonce — «не действует», cookie нет', r.status);
    r = await call('POST', '/api/login/check', { body: {}, headers: { ...XRW, Origin: 'https://evil.example' } });
    ok(r.status === 403, 'опрос с чужого сайта отвергнут раньше любых проверок nonce', r.status);
    r = await call('POST', '/api/login/check', { body: { nonce }, headers: {} });
    ok(r.status === 403, 'опрос без заголовка приложения отвергнут (иначе чужая страница подсадила бы чужую cookie)', r.status);

    // --- подтверждение и выдача сессии ---
    const pre = webAuth.previewLogin(nonce);
    ok(pre && /^[0-9a-f]{20}$/.test(pre.id) && pre.shortUa === 'Chrome, Windows', 'бот видит вход: короткий идентификатор и «Chrome, Windows»', JSON.stringify(pre));
    ok(webAuth.confirmLogin(pre.id, web.id) === true, 'подтверждение записывает того, кто нажал');
    ok(webAuth.confirmLogin(pre.id, anna.id) === false, 'второе подтверждение того же входа — отказ (подтвердившего не переписать)');
    ok(webAuth.denyLogin(pre.id) === false, 'и «Нет» после «Да» уже ничего не меняет');
    ok(webAuth.previewLogin(nonce) === null, 'решённый вход боту больше не предлагается');

    webAuth.resetLimits();
    r = await call('POST', '/api/login/check', { body: { nonce }, headers: { ...XRW, Origin: hostOf(), 'User-Agent': ASCII_UA } });
    const setCookie = r.headers.get('set-cookie') || '';
    ok(r.status === 200 && r.json.status === 'ok', 'после подтверждения опрос отвечает «ок»', JSON.stringify(r.json));
    ok(/^pv_sid=[A-Za-z0-9_-]{43};/.test(setCookie), 'cookie с токеном в 43 знака', setCookie.slice(0, 40));
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) {
      ok(setCookie.split('; ').includes(flag), `cookie: ${flag}`, setCookie);
    }
    const token = /pv_sid=([^;]+)/.exec(setCookie)[1];
    ok(!r.text.includes(token), 'сам токен в тело ответа не попадает — только в cookie');
    const cookie = `pv_sid=${token}`;

    webAuth.resetLimits();
    r = await call('POST', '/api/login/check', { body: { nonce }, headers: XRW });
    ok(r.status === 404 && !r.headers.get('set-cookie'), 'второй опрос по тому же входу — отказ, второй сессии нет', r.status);

    {
      const rows = db.prepare('SELECT * FROM web_sessions WHERE user_id = ?').all(web.id);
      ok(rows.length === 1 && rows[0].token_hash === sha(token), 'в базе лежит SHA-256 токена');
      ok(!rows.some((x) => Object.values(x).some((v) => String(v).includes(token))), 'самого токена в таблице сессий нет');
      const span = Date.parse(rows[0].expires_at) - Date.parse(rows[0].created_at);
      ok(Math.abs(span - 30 * 86400000) < 5000, 'сессия живёт 30 дней', span);
      ok(rows[0].ua.includes('Chrome') && rows[0].last_seen_at, 'у сессии есть браузер и «был в сети»');
      const lg = db.prepare('SELECT * FROM web_logins WHERE nonce_hash = ?').get(sha(nonce));
      ok(lg.used === 1 && lg.user_id === web.id, 'вход помечен использованным');
    }

    // --- API по cookie ---
    r = await call('GET', '/api/state', { headers: { ...XRW, Cookie: cookie } });
    ok(r.status === 200 && r.json.user.tgId === 610001, 'по cookie API отвечает и узнаёт именно этого человека', r.status);
    r = await call('GET', '/api/state', { headers: { Cookie: cookie } });
    ok(r.status === 403, 'чтение по cookie без заголовка приложения отвергнуто', r.status);
    r = await call('GET', '/api/state');
    ok(r.status === 401, 'без cookie и без подписи — 401', r.status);
    r = await call('GET', '/api/state', { headers: { ...XRW, Cookie: `pv_sid=${crypto.randomBytes(32).toString('base64url')}` } });
    ok(r.status === 401 && /Max-Age=0/.test(r.headers.get('set-cookie') || ''), 'выдуманная cookie — 401, и браузеру велено её забыть', r.status);
    r = await call('GET', '/api/state', { headers: { ...XRW, Cookie: 'pv_sid=short' } });
    ok(r.status === 401, 'cookie кривой формы — 401', r.status);
    r = await call('GET', '/api/state', { headers: { ...XRW, Cookie: `other=1; pv_sid=${token}; x=2` } });
    ok(r.status === 200, 'cookie находится среди прочих');

    r = await call('POST', '/api/user/ai', { body: { enabled: true }, headers: { Cookie: cookie } });
    ok(r.status === 403, 'POST по cookie без X-Requested-With отвергнут', r.status);
    r = await call('POST', '/api/user/ai', { body: { enabled: true }, headers: { ...XRW, Cookie: cookie, Origin: 'https://evil.example' } });
    ok(r.status === 403, 'POST по cookie с чужим Origin отвергнут', r.status);
    r = await call('POST', '/api/user/ai', { body: { enabled: true }, headers: { ...XRW, Cookie: cookie, Origin: 'null' } });
    ok(r.status === 403, 'Origin: null (песочница, data:-страница) отвергнут', r.status);
    r = await call('POST', '/api/user/ai', { body: { enabled: true }, headers: { ...XRW, Cookie: cookie, Origin: `http://127.0.0.1.evil.example:${new URL(base).port}` } });
    ok(r.status === 403, 'Origin с похожим, но чужим хостом отвергнут', r.status);
    r = await call('POST', '/api/user/ai', { body: { enabled: true }, headers: { ...XRW, Cookie: cookie, Referer: 'https://evil.example/page' } });
    ok(r.status === 403, 'без Origin, но с чужим Referer — отвергнут', r.status);
    r = await call('POST', '/api/user/ai', { body: { enabled: true }, headers: { ...XRW, Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } });
    ok(r.status === 403, 'Sec-Fetch-Site: cross-site отвергнут', r.status);
    r = await call('POST', '/api/user/ai', { body: { enabled: true }, headers: { ...XRW, Cookie: cookie, 'Sec-Fetch-Site': 'same-site' } });
    ok(r.status === 403, 'Sec-Fetch-Site: same-site (соседний поддомен) отвергнут', r.status);
    r = await call('POST', '/api/user/ai', { body: { enabled: true }, headers: { ...XRW, Cookie: cookie, Origin: hostOf(), 'Sec-Fetch-Site': 'same-origin' } });
    ok(r.status === 200 && r.json.aiEnabled === true, 'свой Origin и заголовок — POST проходит', r.status);
    r = await call('POST', '/api/user/ai', { body: { enabled: false }, headers: { ...XRW, Cookie: cookie } });
    ok(r.status === 200 && r.json.aiEnabled === false, 'без Origin (не браузер) при заголовке — тоже проходит');

    // Подпись Telegram и cookie не смешиваются: плохая подпись не спасается cookie.
    r = await call('GET', '/api/state', { raw: 'tma user=%7B%22id%22%3A1%7D&hash=deadbeef', headers: { ...XRW, Cookie: cookie } });
    ok(r.status === 401, 'неверная подпись при действующей cookie — всё равно 401', r.status);
    // А с верной подписью cookie не нужна и CSRF-заголовок не требуется: как раньше.
    r = await call('GET', '/api/state', { user: masha });
    ok(r.status === 200 && r.json.user.tgId === MASHA.id, 'вход из Telegram работает как прежде');
    r = await call('GET', '/api/state', { user: masha, headers: { Cookie: cookie } });
    ok(r.status === 200 && r.json.user.tgId === MASHA.id, 'с подписью и чужой cookie отвечает подпись, а не cookie');

    // --- данные изолированы ---
    {
      const orgA = await call('POST', '/api/org', { headers: { ...XRW, Cookie: cookie },
        body: { name: 'ИП Вера', inn: '183209316100', signer: 'В. В. Веб', address: 'г. Ижевск',
          bank_name: 'АО «ТБанк»', bik: '044525974', acc: '40802810700005555552', corr_acc: '30101810145250000974' } });
      const mine = await call('GET', '/api/state', { headers: { ...XRW, Cookie: cookie } });
      const hers = await call('GET', '/api/state', { user: masha });
      ok(orgA.status === 200, 'человек с сайта сохраняет организацию по cookie', JSON.stringify(orgA.json));
      ok(mine.json.org && mine.json.org.name === 'ИП Вера'
        && !(hers.json.org && hers.json.org.name === 'ИП Вера'), 'человек с сайта видит и правит только свои данные');
    }

    // --- страница и заголовки ---
    r = await call('GET', '/');
    ok(r.status === 200 && /frame-ancestors 'self' https:\/\/\*\.telegram\.org/.test(r.headers.get('content-security-policy') || ''),
      'страница не вставляется в чужую рамку (кроме Telegram)', r.headers.get('content-security-policy'));
    r = await call('GET', '/app.js');
    ok(r.status === 200 && !r.headers.get('content-security-policy'), 'скрипту рамочная политика не нужна');

    // --- выход ---
    r = await call('POST', '/api/logout', { body: {}, headers: { Cookie: cookie } });
    ok(r.status === 403, 'выход по cookie без заголовка приложения — отказ (чужая страница не выкинет из приложения)', r.status);
    r = await call('POST', '/api/logout', { body: {}, headers: { ...XRW, Cookie: cookie } });
    ok(r.status === 200 && /Max-Age=0/.test(r.headers.get('set-cookie') || '') && /HttpOnly/.test(r.headers.get('set-cookie')),
      'выход очищает cookie', r.headers.get('set-cookie'));
    ok(db.prepare('SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ?').get(web.id).n === 0, 'сессия удалена из базы');
    r = await call('GET', '/api/state', { headers: { ...XRW, Cookie: cookie } });
    ok(r.status === 401, 'после выхода тот же токен не работает', r.status);

    // --- «выйти на всех устройствах» ---
    async function loginAs(userRow, ua = ASCII_UA) {
      webAuth.resetLimits();
      const s0 = await call('POST', '/api/login/start', { body: {}, headers: { ...XRW, 'User-Agent': ua } });
      const p0 = webAuth.previewLogin(s0.json.nonce);
      webAuth.confirmLogin(p0.id, userRow.id);
      webAuth.resetLimits();
      const c0 = await call('POST', '/api/login/check', { body: { nonce: s0.json.nonce }, headers: { ...XRW, 'User-Agent': ua } });
      return `pv_sid=${/pv_sid=([^;]+)/.exec(c0.headers.get('set-cookie') || '')[1]}`;
    }
    const ck1 = await loginAs(web);
    const ck2 = await loginAs(web, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1');
    const other = bdb.getOrCreateUser(610002, 'Олег Другой', 'oleg');
    const ckOther = await loginAs(other);
    ok(webAuth.listSessions(web.id).length === 2, 'у человека два живых сеанса');
    ok(webAuth.listSessions(web.id).map((x) => x.shortUa).sort().join('|') === 'Chrome, Windows|Safari, iPhone', 'в списке узнаются Chrome/Windows и Safari/iPhone',
      webAuth.listSessions(web.id).map((x) => x.shortUa).join('|'));
    r = await call('POST', '/api/logout/all', { body: {}, headers: { ...XRW, Cookie: ck1 } });
    ok(r.status === 200 && r.json.ended === 2, '«выйти везде» закрывает оба сеанса', JSON.stringify(r.json));
    r = await call('GET', '/api/state', { headers: { ...XRW, Cookie: ck2 } });
    ok(r.status === 401, 'второй браузер тоже вышел', r.status);
    r = await call('GET', '/api/state', { headers: { ...XRW, Cookie: ckOther } });
    ok(r.status === 200 && r.json.user.tgId === 610002, 'сеанс другого человека «выйти везде» не тронуло', r.status);

    // «Выйти везде» гасит и подтверждённый, но ещё не забранный вход.
    {
      webAuth.resetLimits();
      const s1 = await call('POST', '/api/login/start', { body: {}, headers: XRW });
      webAuth.confirmLogin(webAuth.previewLogin(s1.json.nonce).id, web.id);
      webAuth.logoutAll(web.id);
      webAuth.resetLimits();
      const c1 = await call('POST', '/api/login/check', { body: { nonce: s1.json.nonce }, headers: XRW });
      ok(c1.status === 404 && !c1.headers.get('set-cookie'), '«выйти везде» отменяет и подтверждённый, но не забранный вход', c1.status);
    }

    // --- истёкшее, отклонённое, повторное ---
    {
      webAuth.resetLimits();
      const s2 = await call('POST', '/api/login/start', { body: {}, headers: XRW });
      const id2 = webAuth.previewLogin(s2.json.nonce).id;
      db.prepare('UPDATE web_logins SET expires_at = ? WHERE nonce_hash = ?').run(new Date(Date.now() - 1000).toISOString(), sha(s2.json.nonce));
      ok(webAuth.previewLogin(s2.json.nonce) === null, 'истёкший вход боту не предлагается');
      ok(webAuth.confirmLogin(id2, web.id) === false, 'истёкший вход подтвердить нельзя');
      webAuth.resetLimits();
      const c2 = await call('POST', '/api/login/check', { body: { nonce: s2.json.nonce }, headers: XRW });
      ok(c2.status === 200 && c2.json.status === 'expired' && !c2.headers.get('set-cookie'), 'истёкший вход: «время вышло», cookie нет', JSON.stringify(c2.json));

      // Подтвердили вовремя, но сайт забрал после срока — сессию уже не выдаём.
      const s3 = await call('POST', '/api/login/start', { body: {}, headers: XRW });
      webAuth.confirmLogin(webAuth.previewLogin(s3.json.nonce).id, web.id);
      db.prepare('UPDATE web_logins SET expires_at = ? WHERE nonce_hash = ?').run(new Date(Date.now() - 1000).toISOString(), sha(s3.json.nonce));
      webAuth.resetLimits();
      const c3 = await call('POST', '/api/login/check', { body: { nonce: s3.json.nonce }, headers: XRW });
      ok(c3.json.status === 'expired' && !c3.headers.get('set-cookie'), 'подтверждённый, но забранный после срока вход сессии не даёт');

      webAuth.resetLimits();
      const s4 = await call('POST', '/api/login/start', { body: {}, headers: XRW });
      const id4 = webAuth.previewLogin(s4.json.nonce).id;
      ok(webAuth.denyLogin(id4) === true, '«Нет» отклоняет вход');
      ok(webAuth.confirmLogin(id4, web.id) === false, 'отклонённый вход подтвердить нельзя');
      webAuth.resetLimits();
      const c4 = await call('POST', '/api/login/check', { body: { nonce: s4.json.nonce }, headers: XRW });
      ok(c4.status === 200 && c4.json.status === 'denied' && !c4.headers.get('set-cookie'), 'сайт узнаёт об отказе, cookie нет', JSON.stringify(c4.json));
    }

    // --- два опроса подряд на одном подтверждённом входе: сессия одна ---
    {
      webAuth.resetLimits();
      const s5 = await call('POST', '/api/login/start', { body: {}, headers: XRW });
      webAuth.confirmLogin(webAuth.previewLogin(s5.json.nonce).id, other.id);
      const before = db.prepare('SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ?').get(other.id).n;
      const a1 = webAuth.checkLogin(s5.json.nonce);
      const a2 = webAuth.checkLogin(s5.json.nonce);
      const after = db.prepare('SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ?').get(other.id).n;
      ok(a1.status === 'ok' && a2.status === 'gone' && after === before + 1, 'вход отдаёт сессию ровно один раз', `${a1.status}/${a2.status} ${before}->${after}`);
    }

    // --- просроченная сессия ---
    {
      const ck3 = await loginAs(web);
      db.prepare('UPDATE web_sessions SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), web.id);
      r = await call('GET', '/api/state', { headers: { ...XRW, Cookie: ck3 } });
      ok(r.status === 401, 'просроченная сессия не пускает', r.status);
      ok(db.prepare('SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ?').get(web.id).n === 0, 'и стирается при обращении');
    }

    // --- «был в сети» не чаще раза в минуту ---
    {
      const ck4 = await loginAs(web);
      const row0 = db.prepare('SELECT last_seen_at FROM web_sessions WHERE user_id = ?').get(web.id);
      await call('GET', '/api/state', { headers: { ...XRW, Cookie: ck4 } });
      const row1 = db.prepare('SELECT last_seen_at FROM web_sessions WHERE user_id = ?').get(web.id);
      ok(row0.last_seen_at === row1.last_seen_at, 'в пределах минуты «был в сети» не переписывается');
      db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE user_id = ?').run(new Date(Date.now() - 120000).toISOString(), web.id);
      await call('GET', '/api/state', { headers: { ...XRW, Cookie: ck4 } });
      const row2 = db.prepare('SELECT last_seen_at FROM web_sessions WHERE user_id = ?').get(web.id);
      ok(Date.now() - Date.parse(row2.last_seen_at) < 5000, 'через две минуты — обновляется');
      webAuth.logoutAll(web.id);
    }

    // --- потолок сессий на человека ---
    {
      const capUser = bdb.getOrCreateUser(610003, 'Много Браузеров', 'many');
      for (let i = 0; i < 23; i += 1) {
        const s6 = webAuth.startLogin({ ip: '203.0.113.9', ua: ASCII_UA });
        webAuth.confirmLogin(webAuth.previewLogin(s6.nonce).id, capUser.id);
        webAuth.checkLogin(s6.nonce);
      }
      ok(webAuth.listSessions(capUser.id).length === 20, 'сессий на человека не больше двадцати: старые уходят', webAuth.listSessions(capUser.id).length);
    }

    // --- Secure можно отключить только явно ---
    {
      process.env.WEB_COOKIE_INSECURE = '1';
      const ck5 = await loginAs(web);
      webAuth.resetLimits();
      const s7 = await call('POST', '/api/login/start', { body: {}, headers: XRW });
      webAuth.confirmLogin(webAuth.previewLogin(s7.json.nonce).id, web.id);
      webAuth.resetLimits();
      const c7 = await call('POST', '/api/login/check', { body: { nonce: s7.json.nonce }, headers: XRW });
      const sc = c7.headers.get('set-cookie') || '';
      ok(!sc.includes('Secure') && sc.includes('HttpOnly') && sc.includes('SameSite=Lax'), 'WEB_COOKIE_INSECURE=1 снимает только Secure (для разработки без https)', sc);
      ok(typeof ck5 === 'string', 'вход при этом работает');
      delete process.env.WEB_COOKIE_INSECURE;
      webAuth.logoutAll(web.id);
    }

    // --- ограничения частоты ---
    {
      webAuth.resetLimits();
      let last = 0;
      let firstLimited = 0;
      for (let i = 1; i <= 11; i += 1) {
        const rr = await call('POST', '/api/login/start', { body: {}, headers: XRW });
        last = rr.status;
        if (rr.status === 429 && !firstLimited) firstLimited = i;
      }
      ok(firstLimited === 11 && last === 429, 'десять стартов входа с адреса пропускаются, одиннадцатый — 429', `первый отказ на ${firstLimited}`);
      // X-Forwarded-For пишет сам клиент — счётчик им не обнуляется.
      const spoof = await call('POST', '/api/login/start', { body: {}, headers: { ...XRW, 'X-Forwarded-For': '198.51.100.7' } });
      ok(spoof.status === 429, 'подмена X-Forwarded-For лимит входа не обходит', spoof.status);
      // А X-Real-IP от своего nginx (запрос здесь идёт с петли) — настоящий адрес: у другого адреса свой счётчик.
      const real = await call('POST', '/api/login/start', { body: {}, headers: { ...XRW, 'X-Real-IP': '198.51.100.8' } });
      ok(real.status === 200, 'другой адрес от nginx считается отдельно', real.status);
      webAuth.resetLimits();
    }

    // --- тело ---
    {
      webAuth.resetLimits();
      const rr = await call('POST', '/api/login/start', { body: { junk: 'x'.repeat(5000) }, headers: XRW });
      ok(rr.status === 413, 'большое тело на входе отвергается (4 КБ хватает с запасом)', rr.status);
      const rr2 = await fetch(`${base}/api/login/start`, { method: 'POST', headers: { ...XRW, 'Content-Type': 'application/json' }, body: '{oops' });
      ok(rr2.status === 400, 'битый JSON — 400');
      const rr3 = await fetch(`${base}/api/login/nonsense`, { method: 'POST', headers: { ...XRW, 'Content-Type': 'application/json' }, body: '{}' });
      ok(rr3.status === 404, 'неизвестный адрес входа — 404', rr3.status);
    }

    // --- уборка ---
    {
      const old = new Date(Date.now() - 3600 * 1000).toISOString();
      db.prepare('INSERT INTO web_logins (nonce_hash, created_at, expires_at) VALUES (?,?,?)').run(sha('old-login'), old, old);
      db.prepare('INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)')
        .run(sha('old-session'), web.id, old, old, old);
      const gone = webAuth.purge();
      const live = webAuth.startLogin({});
      ok(gone.logins >= 1 && gone.sessions >= 1, 'уборка стирает просроченные входы и сессии', JSON.stringify(gone));
      ok(webAuth.previewLogin(live.nonce) !== null, 'живой вход уборка не трогает');
    }

    // --- короткое имя браузера ---
    {
      const u = webAuth.shortUa;
      ok(u('Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0') === 'Firefox, Linux', 'Firefox, Linux');
      ok(u('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126 Safari/537.36 Edg/126') === 'Edge, Windows', 'Edge, а не Chrome');
      ok(u('Mozilla/5.0 (Windows NT 10.0) Chrome/126 YaBrowser/24.6 Safari/537.36') === 'Яндекс Браузер, Windows', 'Яндекс Браузер');
      ok(u('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36') === 'Chrome, Android', 'Chrome, Android');
      ok(u('') === 'неизвестный браузер' && u('curl/8') === 'неизвестный браузер', 'пустое и незнакомое — «неизвестный браузер»');
      ok(!/[<>&"]/.test(u('<script>alert(1)</script> Chrome/1')), 'чужой текст в короткое имя не попадает');
    }
  }

  section('«Оплатил» спрашивает про свободную оплату (Р2)');
  {
    const U = { id: 500707, first_name: 'Олег', username: 'oleg' };
    const ud = initDataFor(U);
    const bdbF = require('./lib/bot-db');
    const uid = bdbF.getOrCreateUser(U.id).id;
    bdbF.saveMyOrg(uid, { name: 'ИП Олегов', inn: '183209316100', signer: 'О. О. Олегов' });
    const bal = (cpId) => Math.round(bdbF.balanceOf(uid, cpId).closing * 100) / 100;
    const mkCp = (name) => bdbF.createCp(uid, { name, kind: 'customer', opening_date: '2026-01-01' });
    const mk = async (cpId, price, date) => (await docService.issueDocument(uid, {
      type: 'torg12', cpId, date, skipQuota: true, items: [{ name: 'Обед', qty: 1, price }],
    })).doc;
    const pay = (id, extra = {}) => call('POST', '/api/doc/paid', { user: ud, body: { id, ...extra } });
    const freeOp = (cpId, amount, date = '2026-10-12') => call('POST', '/api/op', { user: ud, body: { cpId, kind: 'payment', amount, date } });

    // Сценарий ревизора: накладные 3 000 и 4 000, оплата 3 000 внесена строкой.
    const cpA = mkCp('ООО «Заря»');
    const a1 = await mk(cpA, 3000, '2026-10-01');
    const a2 = await mk(cpA, 4000, '2026-10-02');
    await freeOp(cpA, 3000);
    ok(bal(cpA) === 4000, 'до отметки долг 4 000', bal(cpA));
    r = await pay(a1.id);
    ok(r.status === 200 && r.json.ask && r.json.ask.options.length === 1 && !r.json.paidAt,
      '«Оплатил» вместо отметки спрашивает: есть свободная оплата', JSON.stringify(r.json));
    ok(/У клиента ООО «Заря» уже есть оплата 3 000 ₽ от 12\.10, не привязанная к документу\. Это она\?/.test(r.json.ask.question.replace(/\s/g, ' ')),
      'вопрос назван словами из задачи', r.json.ask.question);
    ok(!bdbF.getDoc(uid, a1.id).paid_at && bal(cpA) === 4000, 'вопрос ничего не записал');
    const opA = r.json.ask.options[0].opId;
    r = await pay(a1.id, { free: opA });
    ok(r.status === 200 && r.json.paidAt === '2026-10-12' && r.json.linked.amount === 3000 && !r.json.linked.partial,
      'Да, это она: документ оплачен датой поступления', JSON.stringify(r.json.linked));
    ok(bal(cpA) === 4000, 'долг остался 4 000: проводки новой нет', bal(cpA));
    ok(bdbF.listOps(uid, cpA).filter((o) => o.debit > 0).length === 1, 'проводка оплаты одна');
    const us = bdbF.unpaidSummary(uid);
    ok(us.docs.filter((d) => d.cp_id === cpA).length === 1 && us.docs.find((d) => d.cp_id === cpA).id === a2.id,
      'в «Ждут оплаты» у клиента осталась вторая накладная');
    // Повторно привязать ту же оплату нельзя.
    r = await pay(a2.id, { free: opA });
    ok(r.status === 400 && /уже привязана/.test(r.json.error), 'уже привязанную оплату второй раз не привязать', (r.json || {}).error);
    // Снятие отметки возвращает деньги свободной строкой.
    r = await pay(a1.id, { paid: false });
    ok(r.json.kept === 3000 && bal(cpA) === 4000, 'снятие отметки: оплата осталась свободной, долг прежний', JSON.stringify(r.json));
    ok(bdbF.rebuildDebt(uid).added === 0 && bal(cpA) === 4000, 'пересчёт долга ничего не двигает');

    // «Нет, это новая оплата» — прежние 1 000.
    const cpB = mkCp('ООО «Заря-Нет»');
    const b1 = await mk(cpB, 3000, '2026-10-01');
    await mk(cpB, 4000, '2026-10-02');
    await freeOp(cpB, 3000);
    r = await pay(b1.id, { free: 'new' });
    ok(r.status === 200 && r.json.paidAt && bal(cpB) === 1000, 'Нет: оплата записана заново, долг 1 000', bal(cpB));

    // Предоплату не предлагаем: она предназначена для отгрузок.
    const cpPre = mkCp('ООО «Аванс»');
    const pr1 = await mk(cpPre, 3000, '2026-10-01');
    bdbF.addPrepay(uid, cpPre, 3000, '2026-09-30');
    ok(bdbF.freePaymentsFor(uid, pr1.id).length === 0, 'предоплату в свободные оплаты не предлагаем');

    // Меньше остатка — частичная оплата; потом «Оплатил» на остаток без вопроса.
    const cpC = mkCp('ООО «Заря-Часть»');
    const c1 = await mk(cpC, 3000, '2026-10-01');
    await freeOp(cpC, 1000, '2026-10-06');
    r = await pay(c1.id);
    r = await pay(c1.id, { free: r.json.ask.options[0].opId });
    ok(r.json.linked.partial && r.json.linked.left === 2000 && !r.json.paidAt && !bdbF.getDoc(uid, c1.id).paid_at,
      'меньше остатка: частичная оплата, осталось 2 000', JSON.stringify(r.json.linked));
    const us2 = bdbF.unpaidSummary(uid).docs.find((d) => d.id === c1.id);
    ok(us2 && us2.paid === 1000 && us2.left === 2000, '«Ждут оплаты»: оплачено 1 000, осталось 2 000');
    r = await pay(c1.id);
    ok(!r.json.ask && r.json.paidAt && bal(cpC) === 0, 'свободных больше нет — «Оплатил» закрывает остаток без вопроса', JSON.stringify(r.json));

    // Больше остатка — привязывается часть, остальное свободно.
    const cpD = mkCp('ООО «Заря-Больше»');
    const d1 = await mk(cpD, 3000, '2026-10-01');
    await freeOp(cpD, 5000, '2026-10-07');
    r = await pay(d1.id);
    r = await pay(d1.id, { free: r.json.ask.options[0].opId });
    ok(r.json.paidAt && r.json.linked.amount === 3000 && r.json.linked.rest === 2000, 'больше остатка: привязано 3 000, 2 000 свободны', JSON.stringify(r.json.linked));
    ok(bal(cpD) === -2000 && bdbF.linkedPaid(d1.id) === 3000, 'сальдо те же: -2 000, на документе 3 000');

    // Несколько оплат: до трёх, ближайшая по сумме — первой.
    const cpE = mkCp('ООО «Заря-Много»');
    const e1 = await mk(cpE, 3000, '2026-10-01');
    for (const amount of [1000, 3000, 5000, 3500]) await freeOp(cpE, amount, '2026-10-05');
    r = await pay(e1.id);
    ok(r.json.ask.options.length === 3 && r.json.ask.options[0].amount === 3000 && /Какая из них/.test(r.json.ask.question),
      'несколько оплат: три варианта, первый — ровно по сумме', JSON.stringify(r.json.ask.options.map((o) => o.amount)));

    // Чужая оплата: её id в запросе другого человека не принимается.
    const cpF = mkCp('ООО «Заря-Чужая»');
    const f1 = await mk(cpF, 1000, '2026-10-01');
    const otherUser = initDataFor({ id: 500808, first_name: 'Чужой' });
    await call('GET', '/api/state', { user: otherUser });
    r = await call('POST', '/api/doc/paid', { user: otherUser, body: { id: f1.id, free: opA } });
    ok(r.status === 400, 'чужой документ с чужой оплатой не отметить', (r.json || {}).error);
    r = await pay(f1.id, { free: 99999999 });
    ok(r.status === 400 && /уже привязана|удалена/.test(r.json.error), 'выдуманный номер оплаты — отказ', (r.json || {}).error);
  }

  section('самозанятый: «Да, это она» не задваивает чек (Р2)');
  {
    const U = { id: 500909, first_name: 'Нина', username: 'nina2' };
    const ud = initDataFor(U);
    const bdbF = require('./lib/bot-db');
    const uid = bdbF.getOrCreateUser(U.id).id;
    bdbF.saveMyOrg(uid, { name: 'Иванова Н. Н.', inn: '183200000011' });
    const org = bdbF.getDefaultOrg(uid);
    bdbF.updateOrg(uid, org.id, { npd: 1, debt_basis: 'invoice' });
    const cpN = bdbF.createCp(uid, { name: 'Петров П. П.', kind: 'customer', inn: '183100000099', opening_date: '2026-01-01' });
    const inv = (await docService.issueDocument(uid, { type: 'sch', cpId: cpN, date: '2026-10-01', skipQuota: true,
      items: [{ name: 'Консультация', qty: 1, price: 20000 }] })).doc;
    r = await call('POST', '/api/op', { user: ud, body: { cpId: cpN, kind: 'payment', amount: 20000, date: '2026-10-02' } });
    ok(r.json.npd && r.json.npd.cheque.amount === 20000, 'оплата руками — чек на 20 000 заведён сразу');
    r = await call('POST', '/api/doc/paid', { user: ud, body: { id: inv.id } });
    ok(r.json.ask, 'при «Оплатил» спрашивает про свободную оплату');
    r = await call('POST', '/api/doc/paid', { user: ud, body: { id: inv.id, free: r.json.ask.options[0].opId } });
    const open = require('./lib/cheques').open(uid);
    ok(open.length === 1 && open[0].amount === 20000 && open[0].doc_id === inv.id,
      'после «Да, это она» чек один — прежний, и он теперь «за документ»', JSON.stringify(open.map((c) => [c.amount, c.doc_id])));
    ok(r.json.npd === null || !r.json.npd, 'про чек второй раз не напоминаем: человек уже знает');
  }

  section('после выписки: вопрос про дело один раз, без реквизитов — reason=org (Д4, Д2)');
  {
    const U = { id: 501010, first_name: 'Вера', username: 'vera2' };
    const ud = initDataFor(U);
    const bdbF = require('./lib/bot-db');
    const uid = bdbF.getOrCreateUser(U.id).id;
    r = await call('GET', '/api/state', { user: ud });
    ok(r.json.bizAsked === false && r.json.bizType === '', 'Д4: вопрос про дело ещё не задавали');
    // Без реквизитов документ не выписать — приложение получает признак reason=org.
    const cp0 = bdbF.createCp(uid, { name: 'ООО «Ромашка»', kind: 'customer', opening_date: '2026-01-01' });
    r = await call('POST', '/api/doc', { user: ud, body: { type: 'sch', cpId: cp0, items: [{ name: 'Обед', qty: 1, price: 100 }] } });
    ok(r.status === 400 && r.json.reason === 'org', 'Д2: без реквизитов выписка отвечает reason=org — по нему приложение ведёт на реквизиты', JSON.stringify(r.json));
    bdbF.saveMyOrg(uid, { name: 'ИП Веров', inn: '183209316100', signer: 'В. В.' });
    r = await call('POST', '/api/doc', { user: ud, body: { type: 'torg12', cpId: cp0, date: '2026-09-02', items: [{ name: 'Канапе', qty: 1, price: 14000 }] } });
    ok(r.status === 200 && r.json.askBiz === true, 'Д4: первая выписка — вопрос про дело задать (askBiz)');
    r = await call('POST', '/api/doc', { user: ud, body: { type: 'torg12', cpId: cp0, date: '2026-09-25', items: [{ name: 'Кофе', qty: 1, price: 7000 }] } });
    ok(r.status === 200 && r.json.askBiz === false, 'Д4: вторая — уже не спрашиваем', JSON.stringify(r.json.askBiz));
    r = await call('GET', '/api/state', { user: ud });
    ok(r.json.bizAsked === true, 'и состояние это помнит (bizAsked)');
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
