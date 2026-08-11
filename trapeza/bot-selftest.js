'use strict';

/**
 * Прогон бота без живого токена: подставляем вместо Telegram заглушку и
 * проводим пользователя по сценарию — организация, контрагент, операции,
 * все четыре документа. Файлы складываем в папку и рендерим в PNG,
 * чтобы посмотреть глазами.
 *
 *   TRAPEZA_DB=/tmp/selftest.db node bot-selftest.js [папка-для-файлов]
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'selftest-out'));
fs.mkdirSync(OUT, { recursive: true });

const { handleUpdate, parseOp, parseItemLine } = require('./bot');
const { htmlToPng } = require('./lib/pdf');

let bad = 0;
const ok = (c, m, extra) => {
  console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra));
  if (!c) bad += 1;
};

// ---------- заглушка Telegram ----------

const sent = [];   // все сообщения боту→пользователю
const files = [];  // все отправленные документы

const tg = {
  async sendMessage(chatId, text, opts = {}) {
    sent.push({ text, kb: (opts.reply_markup || {}).inline_keyboard || [] });
    return { message_id: sent.length };
  },
  async sendDocument(chatId, { filename, buffer, caption }) {
    fs.writeFileSync(path.join(OUT, filename), Buffer.from(buffer));
    files.push({ filename, caption, size: buffer.length });
    return { message_id: sent.length };
  },
  async sendChatAction() {},
  async answerCallbackQuery() {},
  async editMessageText() {},
  async call() { return {}; },
};

const USER = { id: 777001, first_name: 'Мария', last_name: 'Сарычева', username: 'trapeza_test' };
const CHAT = { id: 777001 };

const say = (text) => handleUpdate(tg, { message: { chat: CHAT, from: USER, text } });
const tap = (data) => handleUpdate(tg,
  { callback_query: { id: 'cb', from: USER, data, message: { chat: CHAT } } });

const last = () => (sent[sent.length - 1] || {}).text || '';
/** Деньги печатаются с неразрывными пробелами — для сравнений выравниваем. */
const norm = (s) => String(s).replace(/\s/g, ' ');
/** Ищем кнопку по подстроке текста и возвращаем её callback_data. */
function button(sub) {
  for (let i = sent.length - 1; i >= 0; i--) {
    for (const row of sent[i].kb) {
      for (const b of row) if (b.text.includes(sub)) return b.callback_data;
    }
  }
  return null;
}

// ---------- сценарий ----------

(async () => {
  console.log('\n── разбор текста ──');
  const op1 = parseOp('15.05 приход 94193');
  ok(op1 && op1.credit === 94193 && op1.date === '2026-05-15', 'операция «15.05 приход 94193»', JSON.stringify(op1));
  const op2 = parseOp('02.07 оплата 50000 №79000');
  ok(op2 && op2.debit === 50000 && op2.doc.includes('79000'), 'операция с номером документа', op2 && op2.doc);
  ok(parseOp('привет') === null, 'мусор не превращается в операцию');
  const it = parseItemLine('Канапе ассорти; 20; 650');
  ok(it && it.qty === 20 && it.price === 650, 'позиция «Наименование; кол-во; цена»', JSON.stringify(it));
  ok(parseItemLine('Фуршет 10 1500').name === 'Фуршет', 'позиция без разделителей тоже читается');

  console.log('\n── старт и организация ──');
  await say('/start');
  ok(last().includes('Трапеза Документы'), 'бот поздоровался и показал меню');
  await tap('org.new');
  const ORG = ['ИП Сарычева М. В.', 'Индивидуальный предприниматель Сарычева Мария Витальевна',
    '183112345678', '-', 'М. В. Сарычева', 'г. Ижевск, ул. Пушкинская, 214',
    'ПАО Сбербанк', '049401601', '40802810168000012345', '30101810400000000601'];
  for (const v of ORG) await say(v);
  ok(last().includes('сохранена'), 'организация заведена', last().slice(0, 60));
  await tap('org');
  ok(last().includes('049401601'), 'реквизиты организации показываются');

  console.log('\n── контрагент ──');
  await tap('cps');
  await tap('cp.new');
  await say('ООО «Заря»');
  await say('Общество с ограниченной ответственностью «Заря»');
  await say('1832012345');
  await say('183201001');
  await tap('fb:customer');
  await say('Договор № 5 от 01.02.2026');
  await say('0');
  await say('01.01.2026');
  await say('ПАО Сбербанк');
  await say('049401601');
  await say('40702810100000098765');
  await say('30101810400000000601');
  await say('г. Ижевск, ул. Ленина, 1');
  ok(last().includes('Заря'), 'контрагент создан и показана карточка');

  const cpBtn = button('Внести операцию');
  ok(Boolean(cpBtn), 'в карточке есть кнопка «Внести операцию»', cpBtn);
  const cpId = Number(String(cpBtn).split(':')[1]);

  console.log('\n── операции ──');
  await tap(`op:${cpId}`);
  await say('15.05 приход 94193');
  await say('20.05 оплата 40000');
  await say('02.07 приход 26496,42');
  await say('10.07 оплата 26496,42');
  ok(last().includes('Текущее сальдо'), 'бот считает сальдо после каждой операции');
  const saldo = /Текущее сальдо: <b>([^<]+)<\/b>/.exec(last());
  ok(saldo && saldo[1].replace(/\s/g, '').startsWith('54193'),
    'сальдо посчитано верно (94193 − 40000 = 54 193)', saldo && saldo[1]);

  console.log('\n── документы ──');
  await tap(`d.akt:${cpId}`);
  ok(files.some((f) => f.filename.endsWith('.xlsx')), 'акт сверки пришёл файлом Excel',
    (files[files.length - 1] || {}).filename);

  await tap(`d.usl:${cpId}`);
  await say('Фуршетное обслуживание, 30 персон; 1; 54193');
  await tap('items.done');
  ok(last().includes('Итого'), 'перед выпуском показана сводка с итогом');
  await tap('doc.make');
  ok(files.length === 2, 'акт об оказании услуг сформирован', (files[1] || {}).filename);

  await tap(`d.sch:${cpId}`);
  ok(last().includes('Счёт на оплату № 1'), 'номер счёта присвоен сам', last().slice(0, 44));
  await say('Канапе ассорти; 20; 650');
  await say('Брускетты ассорти; 15; 780');
  await tap('items.undo');
  ok(last().includes('Убрал'), 'последнюю позицию можно убрать');
  await say('Брускетты ассорти; 15; 780');
  await tap('items.done');
  await tap('doc.make');
  ok(files.length === 3, 'счёт на оплату сформирован', (files[2] || {}).filename);
  ok(files[2].filename.includes('_1_'), 'номер попал в имя файла', files[2].filename);
  ok(files[2].caption.includes('QR'), 'в подписи сказано про оплату по QR');

  console.log('\n── нумерация, номер и дата вручную ──');
  await tap(`d.sch:${cpId}`);
  ok(last().includes('№ 2'), 'следующий счёт получил номер 2', last().slice(0, 40));
  await say('Доставка; 1; 1000');
  await tap('items.done');
  await tap('doc.num');
  await say('СЧ-2026/007');
  ok(last().includes('СЧ-2026/007'), 'номер можно задать свой', last().slice(0, 40));
  await tap('doc.date');
  await say('05.08.2026');
  ok(last().includes('05.08.2026'), 'дату можно поправить');
  await tap('doc.make');
  ok(files.length === 4 && String((files[3] || {}).filename).includes('СЧ-2026_007'),
    'счёт вышел со своим номером', (files[3] || {}).filename || last().slice(0, 120));

  console.log('\n── шаблоны позиций ──');
  await tap(`d.sch:${cpId}`);
  const tplBtn = button('Канапе ассорти');
  ok(Boolean(tplBtn), 'частая позиция предложена кнопкой', tplBtn);
  await tap(tplBtn);
  ok(last().includes('Сколько'), 'бот спросил количество');
  await say('30');
  ok(last().includes('30'), 'позиция из шаблона добавлена', last().slice(0, 60));
  await tap('items.done');
  await tap('doc.make');
  ok(files.length === 5, 'счёт из шаблона сформирован', files[4].filename);

  console.log('\n── журнал и повтор ──');
  await tap('docs');
  ok(last().includes('Последние документы'), 'журнал открывается');
  const docBtn = button('СЧ-2026/007');
  ok(Boolean(docBtn), 'документ со своим номером виден в журнале', docBtn);
  await tap(docBtn);
  ok(last().includes('Доставка'), 'в карточке документа видны позиции');
  await tap(`doc.get:${docBtn.split(':')[1]}`);
  ok(files.length === 6 && files[5].caption.includes('копия'), 'файл высылается заново', files[5].filename);
  await tap(`d.rep:${docBtn.split(':')[1]}`);
  ok(last().includes('Итого'), 'повтор открыл сводку с теми же позициями');
  await tap('doc.make');
  ok(files.length === 7, 'повторный документ выписан', files[6].filename);
  ok(!files[6].filename.includes('СЧ-2026'), 'у повтора новый номер, не старый', files[6].filename);

  await tap(`d.pp:${cpId}`);
  await say('26496,42');
  await say('Оплата по счёту № 1 от 10.08.2026');
  ok(files.length === 8, 'платёжное поручение сформировано', (files[7] || {}).filename);

  console.log('\n── УПД, накладная, договор ──');
  await tap(`d.upd:${cpId}`);
  ok(last().includes('Статус 2') && last().includes('Статус 1'),
    'бот спрашивает статус УПД и объясняет разницу');
  await tap(`upd.s2:${cpId}`);
  ok(last().includes('УПД № 1'), 'у УПД своя нумерация', last().slice(0, 40));
  await say('Продукты для фуршета; 1; 24700');
  await tap('items.done');
  await tap('doc.make');
  ok(files.length === 9 && files[8].filename.startsWith('УПД'), 'УПД статуса 2 сформирован', files[8].filename);

  console.log('\n── УПД статус 1: счёт-фактура с НДС ──');
  const { vatSplit, okei } = require('./lib/upd');
  const g = vatSplit({ qty: 2, price: 600 }, 20, true);   // цены с НДС
  ok(g.net === 1000 && g.vat === 200 && g.total === 1200,
    'НДС выделен из суммы: 1200 = 1000 + 200', JSON.stringify(g));
  const n = vatSplit({ qty: 2, price: 500 }, 20, false);  // НДС сверху
  ok(n.net === 1000 && n.vat === 200 && n.total === 1200,
    'НДС начислен сверху: 1000 + 200 = 1200', JSON.stringify(n));
  const z = vatSplit({ qty: 3, price: 100 }, null, false);
  ok(z.vat === null && z.total === 300, 'без НДС налог не считается');
  ok(okei('шт.') === '796' && okei('кг') === '166' && okei('бочка') === '',
    'коды ОКЕИ подставляются, неизвестные не выдумываются');

  await tap(`d.upd:${cpId}`);
  await tap(`upd.s1:${cpId}`);
  ok(last().includes('Ставка НДС'), 'бот спросил ставку');
  await tap(`upd.r:${cpId}:20`);
  ok(last().includes('с налогом или без'), 'бот уточнил, включён ли налог в цену');
  await tap(`upd.g:${cpId}:20:1`);
  await say('Обслуживание банкета; 1; 120000');
  await tap('items.done');
  ok(last().includes('статус 1') && last().includes('НДС 20%') && last().includes('цены с НДС'),
    'в сводке видно статус и режим НДС', last().slice(0, 90));
  await tap('doc.make');
  const updHtml = require('./lib/upd').buildUpdHtml({
    org: { name: 'ИП', full_name: 'ИП Сарычева М. В.', inn: '183112345678', address: 'Ижевск' },
    cp: { name: 'ООО «Заря»', full_name: 'ООО «Заря»', inn: '1832012345', kpp: '183201001' },
    doc: { number: '1', date: '2026-08-11', status: 1, vatRate: 20, priceIncludesVat: true,
      items: [{ name: 'Обслуживание банкета', qty: 1, unit: 'усл.', price: 120000 }] },
  });
  ok(updHtml.includes('Счёт-фактура №'), 'в статусе 1 есть строка счёта-фактуры');
  ok(updHtml.includes('ИНН/КПП покупателя'), 'заполнены строки шапки счёта-фактуры');
  ok(updHtml.includes('Главный бухгалтер'), 'подписи руководителя и бухгалтера на месте');
  ok(norm(updHtml).includes('20 000,00'), 'НДС 20% из 120 000 выделен как 20 000',
    (norm(updHtml).match(/20 000,00/g) || []).length + ' совпадений');
  ok(norm(updHtml).includes('100 000,00'), 'стоимость без налога — 100 000');
  const upd2 = require('./lib/upd').buildUpdHtml({
    org: { name: 'ИП', full_name: 'ИП Сарычева М. В.' }, cp: { name: 'ООО «Заря»' },
    doc: { number: '2', date: '2026-08-11', status: 2, items: [{ name: 'Услуга', qty: 1, price: 100 }] },
  });
  ok(!upd2.includes('Счёт-фактура №') && upd2.includes('не является'),
    'в статусе 2 счёта-фактуры нет и указана упрощёнка');

  await tap(`d.torg12:${cpId}`);
  await say('Пирожки с мясом; 100; 45');
  await say('Морсы, 1 л; 10; 250');
  await tap('items.done');
  await tap('doc.make');
  ok(files.length === 11 && files[10].filename.startsWith('ТОРГ-12'), 'накладная сформирована', files[10].filename);
  // formatRub ставит неразрывный пробел — сравниваем по обычному
  const cap9 = norm(files[10].caption);
  ok(cap9.includes('7 000,00'), 'сумма накладной посчитана', cap9.slice(0, 80));

  await tap(`d.dog:${cpId}`);
  await say('услуги по организации фуршетного обслуживания');
  await say('150000');
  await say('31.12.2026');
  ok(files.length === 12 && files[11].filename.startsWith('Договор'), 'договор сформирован', files[11].filename);
  ok(files[11].caption.includes('юристу'), 'в подписи есть оговорка про юриста');

  // все три пересобираются из журнала
  await tap('docs');
  const updBtn = button('УПД № 1');
  ok(Boolean(updBtn), 'УПД виден в журнале', updBtn);
  await tap(`doc.get:${updBtn.split(':')[1]}`);
  ok(files.length === 13 && files[12].filename.startsWith('УПД'), 'УПД пересобирается из журнала', files[12].filename);

  console.log('\n── разбор текста счёта ──');
  const { parseInvoiceText } = require('./lib/vision');
  const SCAN = `ООО «Ромашка»
Счет на оплату № 148 от 03.08.2026
Поставщик: ООО «Ромашка», ИНН 1832012345
1  Кофе зерновой   5 кг   870,00   4 350,00
2  Стаканы 300 мл  200 шт   9,50    1 900,00
Итого: 6 250,00
Всего к оплате: 6 250,00`;
  const scan = parseInvoiceText(SCAN);
  ok(scan.amount === 6250, 'сумма взята из «всего к оплате», а не самая большая цифра', String(scan.amount));
  ok(scan.date === '2026-08-03', 'дата разобрана', scan.date);
  ok(scan.docNo === '148', 'номер счёта найден', scan.docNo);
  ok(scan.inn === '1832012345', 'ИНН найден', scan.inn);
  const wordDate = parseInvoiceText('Акт от 11 августа 2026 г. Итого 1 200,50');
  ok(wordDate.date === '2026-08-11' && wordDate.amount === 1200.5,
    'дата словами и сумма с копейками', `${wordDate.date} / ${wordDate.amount}`);

  console.log('\n── фото счёта ──');
  const photoMsg = {
    chat: CHAT, from: USER,
    photo: [{ file_id: 'small' }, { file_id: 'big' }],
  };
  // без провайдера бот честно отказывается
  delete process.env.VISION_PROVIDER;
  await handleUpdate(tg, { message: photoMsg });
  ok(last().includes('не подключено'), 'без провайдера бот честно говорит об этом', last().slice(0, 50));

  // с заглушкой — распознаёт и предлагает выбрать контрагента
  process.env.VISION_PROVIDER = 'mock';
  process.env.VISION_MOCK = JSON.stringify({
    date: '2026-08-03', amount: 6250, docNo: '148', inn: '1832012345', name: 'ООО «Заря»', text: SCAN,
  });
  tg.downloadFile = async () => Buffer.from('фото');
  await handleUpdate(tg, { message: photoMsg });
  ok(norm(last()).includes('6 250,00'), 'сумма со снимка показана', norm(last()).slice(0, 60));
  ok(last().includes('узнал'), 'контрагент опознан по ИНН');
  const phBtn = button('✅ ООО «Заря»');
  ok(Boolean(phBtn), 'узнанный контрагент предложен первым', phBtn);
  await tap(phBtn);
  ok(last().includes('Что это за операция'), 'бот спрашивает приход или оплата');
  await tap('ph.k:credit');
  ok(last().includes('Текущее сальдо'), 'операция занесена со снимка');
  ok(last().includes('занёс со снимка') || sent[sent.length - 2].text.includes('занёс со снимка'),
    'в подтверждении сказано, что это с фотографии');
  delete process.env.VISION_PROVIDER;

  console.log('\n── дебиторка ──');
  // второй контрагент-поставщик, которому должны мы
  await tap('cp.new');
  await say('ООО «Поставка»');
  await say('-'); await say('1832055555'); await say('-');
  await tap('fb:supplier');
  await say('-'); await say('0'); await say('01.02.2026');
  await say('-'); await say('-'); await say('-'); await say('-'); await say('-');
  const supBtn = button('Внести операцию');
  const supId = Number(String(supBtn).split(':')[1]);
  await tap(`op:${supId}`);
  await say('01.03 приход 30000');

  await tap('debts');
  ok(last().includes('Нам должны') && last().includes('Мы должны'),
    'долги разделены на наши и чужие', last().slice(0, 60));
  // 94 193 − 40 000 + 6 250 со снимка = 60 443
  ok(norm(last()).includes('60 443,00'), 'долг заказчика посчитан с учётом операции со снимка',
    norm(last()).slice(0, 90));
  ok(last().includes('без движения'), 'показано, сколько дней тишины');
  ok(last().includes('⚠️'), 'застарелый долг помечен');

  const before = files.length;
  await tap('debt.akts');
  ok(files.length === before + 1, 'акт сверки собран по каждому должнику', String(files.length - before));
  ok(last().includes('не пишет вашим контрагентам'),
    'честно сказано, что рассылку делает пользователь');

  await tap('debt.remind');
  ok(last().includes('задолженность') && last().includes('Р/с'),
    'готовый текст напоминания с реквизитами', last().slice(0, 60));

  console.log('\n── разбор вебхука Lava ──');
  const lava = require('./lib/lava');
  const flat = lava.parseWebhook({ id: 'inv-1', status: 'paid', amount: '349,00',
    currency: 'RUB', email: 'Ivan@Mail.RU', clientUtm: '777001' });
  ok(flat.ok && flat.payment.amount === 349 && flat.payment.paid, 'плоское тело разобрано',
    JSON.stringify(flat.payment && { a: flat.payment.amount, p: flat.payment.paid }));
  ok(flat.payment.email === 'ivan@mail.ru', 'почта приведена к нижнему регистру');
  ok(flat.payment.tgId === 777001, 'Telegram-id вытащен из параметра ссылки');

  const nested = lava.parseWebhook({ event: 'payment.success',
    data: { invoiceId: 'inv-2', sum: 3490, buyer: { email: 'a@b.ru' }, clientUtm: 'tg777002' } });
  ok(nested.ok && nested.payment.externalId === 'inv-2' && nested.payment.tgId === 777002,
    'вложенное тело и id внутри строки', nested.ok ? nested.payment.externalId : nested.reason);

  const failed = lava.parseWebhook({ id: 'inv-3', status: 'failed', amount: 349 });
  ok(failed.ok && !failed.payment.paid, 'неуспешный платёж помечен как неоплаченный');
  const junk = lava.parseWebhook({ hello: 'world' });
  ok(!junk.ok, 'непонятное тело не выдаёт доступ', junk.reason);

  process.env.LAVA_PLAN_DAYS = '349:30,3490:365';
  ok(lava.daysFor({ amount: 3490 }) === 365 && lava.daysFor({ amount: 349 }) === 30,
    'дни подбираются по сумме');
  ok(lava.daysFor({ amount: 111 }) === 30, 'незнакомая сумма — срок по умолчанию');

  process.env.LAVA_WEBHOOK_SECRET = 'sekret';
  ok(lava.secretOk('sekret') && !lava.secretOk('sekret1') && !lava.secretOk(''),
    'секрет сверяется точно');
  process.env.LAVA_OFFER_URL = 'https://lava.top/x?a=1';
  ok(lava.payLink(777001).includes('clientUtm=777001'), 'ссылка на оплату несёт Telegram-id',
    lava.payLink(777001));

  console.log('\n── доступ и оплата ──');
  const bill = require('./lib/billing');
  const meUser = require('./lib/bot-db').getOrCreateUser(USER.id);
  ok(!bill.accessInfo(meUser.id).active, 'по умолчанию доступ не оплачен');
  const until1 = bill.grantDays(meUser.id, 30);
  ok(bill.accessInfo(meUser.id).active && bill.accessInfo(meUser.id).left >= 29,
    'доступ выдан на 30 дней', until1);
  const until2 = bill.grantDays(meUser.id, 30);
  ok(until2 > until1, 'продление добавляется к остатку, а не сгорает', `${until1} → ${until2}`);
  bill.revokeAccess(meUser.id);

  const { handlePayment } = require('./lava-webhook');
  const pay = { externalId: 'inv-10', amount: 349, currency: 'RUB', status: 'paid',
    email: 'k@l.ru', tgId: USER.id, paid: true, raw: {} };
  await handlePayment(pay);
  ok(bill.accessInfo(meUser.id).active, 'вебхук выдал доступ');
  const untilOnce = bill.accessInfo(meUser.id).until;
  await handlePayment(pay);
  ok(bill.accessInfo(meUser.id).until === untilOnce, 'повторная доставка вебхука не продлевает дважды');

  // платёж без Telegram-id забирается по почте
  await handlePayment({ externalId: 'inv-11', amount: 349, currency: 'RUB', status: 'paid',
    email: 'nobody@mail.ru', tgId: null, paid: true, raw: {} });
  ok(bill.unclaimedByEmail('nobody@mail.ru').length === 1, 'ничей платёж ждёт владельца');
  await tap('billing');
  ok(last().includes('Подписка'), 'экран подписки открывается');
  await tap('pay.claim');
  await say('не-почта');
  ok(last().includes('не похоже на почту'), 'кривой адрес отклоняется');
  await tap('pay.claim');
  await say('nobody@mail.ru');
  ok(last().includes('Нашёл'), 'оплата по почте найдена и привязана', last().slice(0, 40));
  ok(bill.unclaimedByEmail('nobody@mail.ru').length === 0, 'платёж больше не ничей');

  console.log('\n── команды владельца ──');
  process.env.SUPPORT_CHAT_ID = String(CHAT.id);
  await say('/who');
  ok(last().includes('оплаченным доступом') || last().includes('Оплаченных'), 'сводка по доступам');
  const gBefore = sent.length;
  await say(`/grant ${USER.id} 90`);
  const gMsgs = sent.slice(gBefore).map((m) => m.text);
  // владелец в тесте — тот же чат, поэтому приходят оба сообщения:
  // отчёт владельцу и уведомление пользователю
  ok(gMsgs.some((t) => t.includes('Выдал 90')), 'доступ выдаётся вручную', gMsgs.join(' | ').slice(0, 70));
  ok(gMsgs.some((t) => t.includes('Доступ продлён')), 'пользователя уведомили о продлении');
  delete process.env.SUPPORT_CHAT_ID;
  const nBefore = sent.length;
  await say('/grant 777002 90');
  ok(sent[nBefore] && !sent[nBefore].text.includes('Выдал'),
    'посторонний не может выдать доступ себе', (sent[nBefore] || {}).text?.slice(0, 40));

  delete process.env.LAVA_OFFER_URL;
  delete process.env.LAVA_WEBHOOK_SECRET;
  delete process.env.LAVA_PLAN_DAYS;

  console.log('\n── поддержка и правовые страницы ──');
  const legal = require('./lib/legal');
  ok(legal.missing().length > 0, 'сборка правовых страниц требует заполнить реквизиты',
    legal.missing().join(', '));
  const pol = legal.buildPolicyHtml({ ...legal.CONFIG, inn: '1', ogrnip: '2', address: 'a',
    email: 'x@y.z', botLink: 'https://t.me/x' });
  ok(pol.includes('152') || pol.includes('персональных данных'), 'политика собирается');
  ok(pol.includes('удаляется целиком') && pol.includes('отозвать согласие'),
    'в политике есть удаление и отзыв согласия');
  const of = legal.buildOfertaHtml({ ...legal.CONFIG, inn: '1', ogrnip: '2', address: 'a',
    email: 'x@y.z', botLink: 'https://t.me/x' });
  ok(of.includes('не оказывает бухгалтерских'), 'оферта прямо говорит, что это не бухгалтерия');
  ok(of.includes('Ответственность за содержание'), 'ответственность за документ на пользователе');

  process.env.SUPPORT_CHAT_ID = '999';
  process.env.LEGAL_OFERTA_URL = 'https://example.test/oferta.html';
  await tap('support');
  ok(last().includes('Поддержка'), 'экран поддержки открывается');
  ok(last().includes('оферту'), 'на экране есть ссылка на оферту');
  await tap('sup.write');
  ok(last().includes('Опишите'), 'бот ждёт текст обращения');
  const beforeSup = sent.length;
  await say('Не приходит счёт, кнопка не реагирует');
  const forwarded = sent.slice(beforeSup).find((m) => m.text.includes('Обращение в поддержку'));
  ok(Boolean(forwarded), 'обращение ушло владельцу');
  ok(forwarded && forwarded.text.includes('Не приходит счёт'), 'текст обращения передан целиком');
  ok(last().includes('Отправил'), 'пользователю подтвердили отправку');
  delete process.env.SUPPORT_CHAT_ID;
  await tap('support');
  ok(!last().includes('Написать в поддержку') || last().includes('не настроен')
    || last().includes('Напишите нам'), 'без настройки бот не обещает того, чего не может');
  delete process.env.LEGAL_OFERTA_URL;

  console.log('\n── блокировка бота ──');
  const blockErr = Object.assign(new Error('Forbidden: bot was blocked by the user'),
    { code: 403, blocked: true });
  const dead = { ...tg, sendMessage: async () => { throw blockErr; } };
  await handleUpdate(dead, { message: { chat: CHAT, from: USER, text: '/start' } });
  const bdb2 = require('./lib/bot-db');
  const me = bdb2.getOrCreateUser(USER.id);
  ok(bdb2.isBlocked(me.id), 'заблокировавший помечен в базе');
  ok(!bdb2.reachableUsers().some((u) => u.tg_id === USER.id), 'в списке для рассылки его нет');
  await say('/start');
  ok(!bdb2.isBlocked(me.id), 'вернулся и написал — пометка снята');

  console.log('\n── оформление бота ──');
  const setup = require('./lib/bot-setup');
  ok(setup.checkSetup().length === 0, 'тексты и команды укладываются в лимиты Telegram',
    setup.checkSetup().join('; '));
  ok(setup.SHORT.length <= 120 && setup.DESCRIPTION.length <= 512,
    `короткое ${setup.SHORT.length}/120, полное ${setup.DESCRIPTION.length}/512`);
  const menuCmds = setup.COMMANDS.map((c) => c.command);
  ok(menuCmds.includes('start') && menuCmds.includes('help'), 'в меню есть /start и /help');

  // каждая команда из меню должна что-то открывать, а не молчать
  for (const c of menuCmds) {
    if (c === 'cancel') continue;
    const before = sent.length;
    await say('/' + c);
    ok(sent.length > before, `команда /${c} отвечает`);
  }
  // применение оформления: собираем вызовы, живой сети не нужно
  const calls = [];
  await setup.applySetup({ call: async (m, p) => { calls.push({ m, p }); } }, { log: () => {} });
  ok(calls.map((c) => c.m).join(',')
    === 'setMyName,setMyShortDescription,setMyDescription,setMyCommands,setChatMenuButton',
    'оформление накатывается пятью вызовами', calls.map((c) => c.m).join(','));
  // один упавший шаг не должен ронять остальные
  let tries = 0;
  const flaky = { call: async () => { tries += 1; if (tries === 1) throw new Error('Too Many Requests'); } };
  const r = await setup.applySetup(flaky, { log: () => {} });
  ok(tries === 5 && r.failed.length === 1, 'сбой на одном шаге не отменяет остальные', `${tries} вызовов`);

  console.log('\n── изоляция пользователей ──');
  const OTHER = { id: 777002, first_name: 'Чужой', username: 'other' };
  await handleUpdate(tg, { message: { chat: { id: 777002 }, from: OTHER, text: '/start' } });
  await handleUpdate(tg, { callback_query: { id: 'c2', from: OTHER, data: 'cps', message: { chat: { id: 777002 } } } });
  ok(last().includes('Контрагентов пока нет'), 'чужой пользователь не видит наших контрагентов', last().slice(0, 50));
  await handleUpdate(tg, { callback_query: { id: 'c3', from: OTHER, data: `cp:${cpId}`, message: { chat: { id: 777002 } } } });
  ok(last().includes('не найден'), 'по прямой ссылке чужого контрагента тоже не отдаёт');

  console.log('\n── картинки документов ──');
  const html = files.filter((f) => f.filename.endsWith('.html'));
  for (const f of html) {
    const png = path.join(OUT, f.filename.replace(/\.html$/, '.png'));
    try {
      await htmlToPng(fs.readFileSync(path.join(OUT, f.filename), 'utf8'), png);
      console.log('  · ' + path.basename(png));
    } catch (e) { console.log('  ! не отрисовал ' + f.filename + ': ' + e.message); }
  }

  console.log('\nфайлы в ' + OUT + ':');
  files.forEach((f) => console.log(`  ${f.filename} — ${(f.size / 1024).toFixed(1)} КБ`));
  console.log(bad ? `\nне прошло: ${bad}` : '\nбот работает целиком ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ПРОГОН УПАЛ:', e); process.exit(1); });
