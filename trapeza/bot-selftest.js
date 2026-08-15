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

// Основной сценарий выписывает больше 5 документов — чтобы лимит не мешал,
// в нём поднимаем порог; отдельный блок ниже проверяет саму блокировку.
process.env.FREE_DOCS = process.env.FREE_DOCS || '1000';

// Пароли от почты хранятся зашифрованными, и без ключа блок про ящик
// падает не по своей вине. Задаём тестовый ключ, чтобы прогон не зависел
// от того, что оказалось в окружении запускающего.
process.env.MAIL_KEY = process.env.MAIL_KEY || 'selftest-mail-key';

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
  // Настоящий PNG 1×1: приём подписи проверяет байты, а не заявленный тип.
  async downloadFile() {
    return Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
  },
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

/** id пользователя прогона в базе (а не его Telegram-id). */
const fxUserId = () => require('./lib/bot-db').getOrCreateUser(USER.id).id;

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
  ok(last().includes('Первичка'), 'бот поздоровался и показал меню');
  await tap('org.new');
  // Ручной путь: ИНН вводим (справочник в прогоне не подключён — автозаполнения
  // нет), название и остальное набираем сами. Порядок шагов новый:
  // инн → название → полное → КПП → адрес → подписант → БИК → банк → к/с → р/с.
  const ORG = ['183112345678', 'ИП Сарычева М. В.',
    'Индивидуальный предприниматель Сарычева Мария Витальевна', '-',
    'г. Ижевск, ул. Пушкинская, 214', 'М. В. Сарычева',
    '049401601', 'ПАО Сбербанк', '30101810400000000601', '40802810168000012345'];
  for (const v of ORG) await say(v);
  ok(last().includes('сохранена'), 'организация заведена', last().slice(0, 60));
  await tap('org');
  ok(last().includes('049401601'), 'реквизиты организации показываются');

  console.log('\n── контрагент ──');
  await tap('cps');
  await tap('cp.new');
  // Порядок: инн → название → полное → КПП → адрес → тип → договор →
  // сальдо → дата → БИК → банк → к/с → р/с.
  await say('1832012345');                                   // инн (без автозаполнения в прогоне)
  await say('ООО «Заря»');
  await say('Общество с ограниченной ответственностью «Заря»');
  await say('183201001');
  await say('г. Ижевск, ул. Ленина, 1');
  await tap('fb:customer');
  await say('Договор № 5 от 01.02.2026');
  await say('0');
  await say('01.01.2026');
  await say('049401601');
  await say('ПАО Сбербанк');
  await say('30101810400000000601');
  await say('40702810100000098765');
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

  console.log('\n── разбор вставленных реквизитов ──');
  const { parseRequisites, looksLikeBlock } = require('./lib/reqs');
  ok(!looksLikeBlock('7707083893') && looksLikeBlock('ООО Х ИНН 7707083893 р/с 40702810900000012345 БИК 044525225'),
    'блок реквизитов отличается от чистого ИНН');
  const blob = 'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ САРЫЧЕВА МАРИЯ ВИТАЛЬЕВНА ИНН: 183111485159 '
    + 'ОГРНИП: 325180000069852 Расчётный счёт: 40802810468710003890 '
    + 'Банк: БАШКИРСКОЕ ОТДЕЛЕНИЕ N8598 ПАО СБЕРБАНК БИК банка: 048073601 '
    + 'Корсчёт: 30101810300000000601 ИНН банка: 7707083893 КПП банка: 183502001';
  const pr = parseRequisites(blob);
  ok(pr.inn === '183111485159', 'ИНН организации взят, а не ИНН банка', pr.inn);
  ok(pr.kpp === '', 'КПП банка не подставлен как КПП организации', pr.kpp || 'пусто');
  ok(pr.acc === '40802810468710003890', 'расчётный счёт разобран', pr.acc);
  ok(pr.corr_acc === '30101810300000000601', 'корр. счёт разобран (по метке и префиксу 301)', pr.corr_acc);
  ok(pr.bik === '048073601', 'БИК разобран', pr.bik);
  ok(pr.bank_name.includes('СБЕРБАНК'), 'банк не перепутан с «к/с»', pr.bank_name);
  ok(pr.name.startsWith('ИП ') && pr.full_name.startsWith('ИНДИВИДУАЛЬНЫЙ'),
    'наименование отделено от реквизитов и сокращено в «ИП»', pr.name);

  // вставка блока прямо в бота на шаге ИНН — поля должны разложиться, QR появиться
  await tap('cp.new');
  await say(blob);
  ok(last().includes('Тип контрагента'), 'после вставки блока бот пропустил название/адрес/счета');
  const notedBlock = sent.slice(-3).some((m) => m.text.includes('Разобрал реквизиты'));
  ok(notedBlock, 'бот отчитался, что разобрал реквизиты');
  await tap('fb:supplier');
  await say('-'); await say('0'); await say('01.01.2026');
  const pasted = require('./lib/bot-db').listCps(require('./lib/bot-db').getOrCreateUser(USER.id).id)
    .find((c) => c.inn === '183111485159');
  ok(pasted && pasted.acc === '40802810468710003890' && pasted.bik === '048073601',
    'из блока сохранены р/с и БИК — теперь в счёте будет QR', pasted && pasted.acc);

  console.log('\n── автозаполнение по ИНН и БИК ──');
  process.env.DADATA_MOCK = JSON.stringify({
    7707083893: {
      type: 'LEGAL',
      name: { short_with_opf: 'ООО «Ромашка»', full_with_opf: 'Общество с ограниченной ответственностью «Ромашка»' },
      inn: '7707083893', kpp: '770701001',
      address: { unrestricted_value: 'г. Москва, ул. Тверская, 1' },
      management: { name: 'Иванов Иван Иванович' },
      state: { status: 'ACTIVE' },
    },
    '044525225': { name: { payment: 'ПАО Сбербанк' }, correspondent_account: '30101810400000000225', bic: '044525225' },
  });
  const { partyByInn, bankByBik } = require('./lib/dadata');
  const party = await partyByInn('7707083893');
  ok(party.ok && party.fields.name === 'ООО «Ромашка»', 'по ИНН нашлось название', party.ok && party.fields.name);
  ok(party.fields.signer === 'И. И. Иванов', 'директор сокращён в подписанта', party.fields.signer);
  const bank = await bankByBik('044525225');
  ok(bank.ok && bank.fields.corr_acc === '30101810400000000225', 'по БИК подставился корр. счёт');

  await tap('cp.new');
  await say('7707083893');   // ИНН — дальше название/адрес/КПП должны подставиться
  ok(last().includes('Ромашка') || sent[sent.length - 2].text.includes('Ромашка'),
    'бот показал найденную организацию');
  ok(last().includes('Тип контрагента'), 'название, адрес и КПП пропущены — сразу спросил тип');
  await tap('fb:customer');
  await say('-');            // договор
  await say('0');            // сальдо
  await say('05.05.2026');   // дата
  await say('044525225');    // БИК — банк и корр. счёт должны подставиться
  ok(last().includes('счёт контрагента') || last().includes('Расчётный счёт'),
    'банк и корр. счёт пропущены — сразу спросил расчётный счёт', last().slice(0, 50));
  await say('40702810900000099999');
  const roma = require('./lib/bot-db').listCps(require('./lib/bot-db').getOrCreateUser(USER.id).id)
    .find((c) => c.name === 'ООО «Ромашка»');
  ok(roma && roma.kpp === '770701001' && roma.address.includes('Тверская'),
    'контрагент сохранён с подставленными реквизитами', roma && roma.kpp);
  ok(roma && roma.bank_name === 'ПАО Сбербанк' && roma.corr_acc === '30101810400000000225',
    'банк подставился по БИК');
  delete process.env.DADATA_MOCK;

  console.log('\n── дебиторка ──');
  // второй контрагент-поставщик, которому должны мы
  await tap('cp.new');
  await say('1832055555');   // инн
  await say('ООО «Поставка»');
  await say('-'); await say('-'); await say('-'); // полное, КПП, адрес
  await tap('fb:supplier');
  await say('-'); await say('0'); await say('01.02.2026'); // договор, сальдо, дата
  await say('-'); await say('-'); await say('-'); await say('-'); // БИК, банк, к/с, р/с
  const supBtn = button('Внести операцию');
  const supId = Number(String(supBtn).split(':')[1]);
  await tap(`op:${supId}`);
  await say('01.03 приход 30000');

  await tap('debts');
  ok(last().includes('Нам должны') && last().includes('Мы должны'),
    'долги разделены на наши и чужие', last().slice(0, 60));
  // Теперь долг складывается из внесённых руками операций И из выписанных
  // закрывающих документов: акт, УПД и накладная создают его сами.
  // 94 193 − 40 000 + 6 250 со снимка = 60 443 руками, остальное — документы.
  const zaryaDebt = require('./lib/bot-db').balanceOf(fxUserId(), cpId).closing;
  const byDocs = require('./lib/bot-db').listDocs(fxUserId(), 50)
    .filter((d) => ['usl', 'upd', 'torg12'].includes(d.type) && d.cp_id === cpId)
    .reduce((a2, d) => a2 + d.total, 0);
  ok(Math.abs(zaryaDebt - (60443 + byDocs)) < 0.01,
    'долг = операции руками плюс выписанные закрывающие документы',
    `${zaryaDebt} = 60443 + ${byDocs}`);
  ok(norm(last()).includes('Нам должны'), 'заказчик показан в должниках',
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

  console.log('\n── лимит бесплатных документов ──');
  // отдельный пользователь и низкий лимит: 2 бесплатных, третий блокируется
  const LIM = { id: 778001, first_name: 'Лимит', username: 'lim' };
  const limChat = { id: 778001 };
  const limSay = (t) => handleUpdate(tg, { message: { chat: limChat, from: LIM, text: t } });
  const limTap = (d) => handleUpdate(tg, { callback_query: { id: 'l', from: LIM, data: d, message: { chat: limChat } } });
  const limLast = () => {
    for (let i = sent.length - 1; i >= 0; i--) return sent[i].text; return '';
  };
  process.env.FREE_DOCS = '2';
  await limSay('/start');
  await limTap('org.new');
  await limSay('-'); await limSay('ИП Лимит'); await limSay('-'); await limSay('-'); await limSay('-'); await limSay('-');
  await limSay('-'); await limSay('-'); await limSay('-'); await limSay('-'); // БИК, банк, к/с, р/с
  await limTap('cps'); await limTap('cp.new');
  await limSay('-'); await limSay('ООО Клиент'); await limSay('-'); await limSay('-'); await limSay('-');
  await limTap('fb:customer');
  await limSay('-'); await limSay('0'); await limSay('01.01.2026');
  await limSay('-'); await limSay('-'); await limSay('-'); await limSay('-');
  const limCp = Number(String(button('Внести операцию')).split(':')[1]);
  const mk = async () => { await limTap(`d.sch:${limCp}`); await limSay('Услуга; 1; 100'); await limTap('items.done'); await limTap('doc.make'); };
  await mk(); await mk(); // два бесплатных
  const filesBefore = files.length;
  await limTap(`d.sch:${limCp}`); // третий — должен упереться в лимит
  ok(limLast().includes('бесплатных'), 'на третьем документе бот показал лимит', limLast().slice(0, 50));
  ok(files.length === filesBefore, 'третий документ не выпущен без подписки');
  // выдаём подписку — лимит снимается
  require('./lib/billing').grantDays(require('./lib/bot-db').getOrCreateUser(LIM.id).id, 30);
  await mk();
  ok(files.length === filesBefore + 1, 'с подпиской документ выписывается сверх лимита');
  delete process.env.FREE_DOCS;
  process.env.FREE_DOCS = '1000'; // возвращаем высокий порог для остального прогона

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

  // Точный формат Lava Top (сверен по официальному SDK lava-top-sdk).
  const real = lava.parseWebhook({
    eventType: 'payment.success', contractId: 'c-42', status: 'completed',
    amount: 390, currency: 'RUB', buyer: { email: 'Buyer@Mail.RU' },
    product: { title: 'Первичка — месяц' },
  });
  ok(real.ok && real.payment.externalId === 'c-42' && real.payment.paid
    && real.payment.email === 'buyer@mail.ru' && real.payment.amount === 390
    && real.payment.product === 'Первичка — месяц',
    'реальный формат Lava Top (eventType/contractId/buyer.email)',
    real.ok ? `${real.payment.status} ${real.payment.amount}` : real.reason);
  const recur = lava.parseWebhook({
    eventType: 'subscription.recurring.payment.success', contractId: 'c-43',
    amount: 2990, buyer: { email: 'x@y.ru' } });
  ok(recur.ok && recur.payment.paid, 'автопродление подписки Lava — оплачено');
  const declined = lava.parseWebhook({
    eventType: 'payment.failed', contractId: 'c-44', amount: 390, buyer: { email: 'x@y.ru' } });
  ok(declined.ok && !declined.payment.paid, 'событие payment.failed — доступ не выдан');

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
  ok(last().includes('С доступом') || last().includes('Доступов нет'), 'сводка по доступам');
  await say('/admin');
  ok(last().includes('/grant') && last().includes('/code'), 'подсказка по командам владельца');
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

  console.log('\n── коды доступа (выдать подписку бесплатно) ──');
  {
    const OWNER = { id: 999001, first_name: 'Владелец', username: 'owner' };
    process.env.SUPPORT_CHAT_ID = String(OWNER.id);
    const ownerSay = (t) => handleUpdate(tg,
      { message: { chat: { id: OWNER.id }, from: OWNER, text: t } });
    /** Отдельный тестировщик: как раз тот случай, ради которого всё это. */
    const person = (id, username) => {
      const who = { id, first_name: `Тестер ${id}`, username };
      return {
        say: (t) => handleUpdate(tg, { message: { chat: { id }, from: who, text: t } }),
        tap: (d) => handleUpdate(tg,
          { callback_query: { id: 'cb', from: who, data: d, message: { chat: { id } } } }),
        row: () => require('./lib/bot-db').getOrCreateUser(id),
      };
    };
    const CODE_RE = /PRV-[A-Z0-9]{4}-[A-Z0-9]{4}/g;

    await ownerSay('/code 30 2 бета-тест');
    const codes = last().match(CODE_RE) || [];
    ok(codes.length === 2, 'владелец получил сразу два кода', codes.join(' '));
    ok(last().includes('бета-тест'), 'пометка видна в ответе');

    const t1 = person(999002, 'tester_one');
    await t1.say('/start');
    ok(!bill.accessInfo(t1.row().id).active, 'у тестировщика доступа ещё нет');

    // Код прислан как есть — в нижнем регистре и с пробелами вместо дефисов.
    await t1.say(codes[0].toLowerCase().replace(/-/g, ' '));
    const a1 = bill.accessInfo(t1.row().id);
    ok(a1.active && a1.left >= 29, 'код открыл доступ на месяц', `до ${a1.until}`);
    ok(require('./lib/bot-db').quota(t1.row().id).paid, 'лимит бесплатных документов снят');
    ok(last().includes('Код принят'), 'бот подтвердил активацию', last().slice(0, 40));

    await t1.say(codes[0]);
    ok(last().includes('уже активировали'), 'повторно тот же код не проходит', last().slice(0, 40));

    const t2 = person(999003, 'tester_two');
    await t2.say('/start');
    await t2.say(codes[0]);
    ok(last().includes('уже использован'), 'одноразовый код не работает у второго',
      last().slice(0, 40));
    ok(!bill.accessInfo(t2.row().id).active, 'доступ второму не выдан');

    // Кнопка в меню подписки — для тех, кто не станет присылать код текстом.
    await t2.tap('billing');
    ok(Boolean(button('У меня есть код')), 'на экране подписки есть кнопка кода');
    await t2.tap('promo');
    ok(last().includes('PRV-'), 'бот показал, как выглядит код');
    await t2.say('PRV-ZZZZ-ZZZZ');
    ok(last().includes('Такого кода нет'), 'выдуманный код отклонён');
    await t2.tap('promo');
    await t2.say(codes[1]);
    ok(bill.accessInfo(t2.row().id).active, 'второй код открыл доступ второму человеку');

    // Один код на несколько активаций — для вебинара или чата с клиентами.
    await ownerSay('/code 7 1x2 общий');
    const shared = (last().match(CODE_RE) || [])[0];
    ok(Boolean(shared) && last().includes('до 2 активаций'), 'создан код на две активации',
      last().slice(0, 60));
    const t3 = person(999004, 'tester_three');
    const t4 = person(999005, 'tester_four');
    await t3.say('/start'); await t3.say(shared);
    await t4.say('/start'); await t4.say(shared);
    ok(bill.accessInfo(t3.row().id).active && bill.accessInfo(t4.row().id).active,
      'общий код сработал у обоих');
    const t5 = person(999006, 'tester_five');
    await t5.say('/start'); await t5.say(shared);
    ok(!bill.accessInfo(t5.row().id).active, 'третьему общего кода не хватило');
    ok(bill.accessInfo(t3.row().id).left <= 7, 'срок именно тот, что задали', bill.accessInfo(t3.row().id).left);

    // Отключение кода: уже выданный доступ при этом не трогаем.
    await ownerSay('/code 30 1 на отзыв');
    const doomed = (last().match(CODE_RE) || [])[0];
    await ownerSay(`/revoke ${doomed}`);
    ok(last().includes('отключён'), 'код отключается');
    const t6 = person(999007, 'tester_six');
    await t6.say('/start'); await t6.say(doomed);
    ok(last().includes('отключён') && !bill.accessInfo(t6.row().id).active,
      'отключённый код не работает');

    await ownerSay('/codes');
    ok(last().includes('Коды доступа') && last().includes('tester_one'),
      'в списке видно, кто активировал код', last().slice(0, 60));

    // Снятие доступа — чтобы посмотреть на бота глазами неоплатившего.
    await ownerSay(`/ungrant ${999002}`);
    ok(!bill.accessInfo(t1.row().id).active, 'доступ снимается по номеру');
    await ownerSay('/ungrant @tester_two');
    ok(!bill.accessInfo(t2.row().id).active, 'доступ снимается по @имени');
    await ownerSay('/ungrant @никого_нет');
    ok(last().includes('Не нашёл'), 'неизвестное имя — понятный ответ');

    // Свой номер человек узнаёт сам: без него владельцу нечего вводить.
    await t1.say('/id');
    ok(last().includes('999002'), 'команда /id показывает номер', last().slice(0, 30));

    // Посторонний кодов не печатает.
    delete process.env.SUPPORT_CHAT_ID;
    const madeBefore = bill.listCodes(100).length;
    await t1.say('/code 3650 50');
    ok(bill.listCodes(100).length === madeBefore, 'посторонний не может выпустить себе коды');
  }

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

  console.log('\n── вход в мини-приложение ──');
  const { keyboard: kb } = require('./lib/tg');
  const wa = kb([[{ text: 'Открыть', webApp: 'https://app.example.ru' }]]).reply_markup.inline_keyboard[0][0];
  ok(wa.web_app && wa.web_app.url === 'https://app.example.ru' && !wa.callback_data,
    'кнопка мини-приложения собирается как web_app', JSON.stringify(wa));

  const keepUrl = process.env.WEBAPP_URL;
  // Telegram открывает мини-приложения только по https: http-адрес не должен
  // превращаться в кнопку, иначе она у всех выдаёт ошибку.
  process.env.WEBAPP_URL = 'http://app.example.ru';
  await say('/start');
  ok(!JSON.stringify(sent[sent.length - 1].kb).includes('web_app'),
    'по http кнопка приложения не появляется');

  process.env.WEBAPP_URL = 'https://app.example.ru';
  await say('/start');
  ok(JSON.stringify(sent[sent.length - 1].kb).includes('https://app.example.ru'),
    'по https кнопка приложения появляется в меню');

  const menuCalls = [];
  await setup.applySetup({ call: async (m, p) => { menuCalls.push({ m, p }); } }, { log: () => {} });
  const btn = (menuCalls.find((c) => c.m === 'setChatMenuButton') || {}).p;
  ok(btn && btn.menu_button.type === 'web_app' && btn.menu_button.web_app.url === 'https://app.example.ru',
    'кнопка возле поля ввода ведёт в приложение', btn && btn.menu_button.type);

  delete process.env.WEBAPP_URL;
  const plainCalls = [];
  await setup.applySetup({ call: async (m, p) => { plainCalls.push({ m, p }); } }, { log: () => {} });
  const plainBtn = (plainCalls.find((c) => c.m === 'setChatMenuButton') || {}).p;
  ok(plainBtn && plainBtn.menu_button.type === 'commands',
    'без адреса приложения остаётся список команд', plainBtn && plainBtn.menu_button.type);
  if (keepUrl) process.env.WEBAPP_URL = keepUrl;

  console.log('\n── счёт-договор ──');
  {
    const bdb5 = require('./lib/bot-db');
    const uid5 = fxUserId();
    await tap(`cp:${cpId}`);
    const sdBtn = button('Счёт-договор');
    ok(Boolean(sdBtn), 'в карточке контрагента есть счёт-договор', sdBtn);

    const beforeSd = files.length;
    await tap(sdBtn);
    await say('Фуршет на 40 персон; 1; 78000');
    await tap('items.done');
    await tap('doc.make');
    ok(files.length === beforeSd + 1, 'счёт-договор выписан');
    const sdFile = files[files.length - 1];
    ok(sdFile.filename.startsWith('Счет-договор_'), 'имя файла говорит, что это за документ',
      sdFile.filename);

    const saved = bdb5.listDocs(uid5, 1)[0];
    ok(saved.type === 'schdog' && saved.title === 'Счёт-договор',
      'в журнале записан отдельный тип', `${saved.type} / ${saved.title}`);

    // Своя нумерация: счёт-договор № 1 и счёт № 1 — разные документы,
    // их ряды путать нельзя.
    ok(saved.number === '1', 'нумерация у счёта-договора своя, с единицы', saved.number);
    const schCount = bdb5.listDocs(uid5, 99).filter((d) => d.type === 'sch').length;
    ok(schCount > 1, 'при этом обычных счетов уже несколько', schCount);

    const html = require('./lib/schet-dogovor').buildSchetDogovorHtml({
      org: bdb5.getDefaultOrg(uid5), cp: bdb5.getCp(uid5, cpId),
      doc: { number: '1', date: '2026-08-15', items: [{ name: 'Услуга', qty: 1, price: 1000 }] },
    });
    ok(html.includes('акцепт оферты') && html.includes('438'),
      'в документе есть оговорка об акцепте — без неё оплата договором не станет');
    ok((html.match(/<img class="fx fx-sign/g) || []).length <= 1,
      'факсимиле стоит только за нас — за заказчика расписываться нельзя');
    ok(html.includes('Заказчик') && html.includes('подпись / расшифровка'),
      'место для подписи заказчика оставлено');
  }

  console.log('\n── реестр документов ──');
  {
    const ExcelJS = require('exceljs');
    const bdb4 = require('./lib/bot-db');
    const uid4 = fxUserId();

    await tap('docs');
    ok(Boolean(button('Реестр за период')), 'в журнале есть кнопка реестра');
    await tap('reg');
    ok(last().includes('за какой период'), 'бот спрашивает период');

    const beforeReg = files.length;
    await tap('reg.p:year');
    ok(files.length === beforeReg + 1, 'реестр пришёл файлом');
    const regFile = files[files.length - 1];
    ok(regFile.filename.startsWith('Реестр_') && regFile.filename.endsWith('.xlsx'),
      'это Excel с говорящим именем', regFile.filename);
    ok(regFile.caption.includes('Документов:'), 'в подписи есть количество и сумма',
      regFile.caption.slice(0, 60));

    // Читаем файл обратно: важно, что суммы — числа, а не текст,
    // иначе реестр не складывается и им нельзя пользоваться.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(OUT, regFile.filename));
    const sheet = wb.getWorksheet('Реестр');
    ok(Boolean(sheet), 'лист «Реестр» на месте');
    ok(sheet.getCell('A5').value === 'Дата' && sheet.getCell('G5').value === 'Всего',
      'шапка таблицы на месте');
    ok(typeof sheet.getCell('G6').value === 'number', 'суммы записаны числами, а не строками',
      typeof sheet.getCell('G6').value);
    const totalCell = sheet.getCell(`G${sheet.rowCount}`).value;
    ok(totalCell && totalCell.formula && totalCell.formula.startsWith('SUM('),
      'итог — живая формула, пересчитается после фильтрации',
      totalCell && totalCell.formula);
    ok(Boolean(sheet.autoFilter), 'включён автофильтр для сортировки');

    const yearDocs = bdb4.docsBetween(uid4, '2026-01-01', '2026-12-31');
    ok(yearDocs.length > 0 && yearDocs.every((d) => 'cpName' in d),
      'в выборку попали документы с именами контрагентов', yearDocs.length);
    const other = bdb4.docsBetween(uid4, '2020-01-01', '2020-12-31');
    ok(other.length === 0, 'за пустой период документов нет');
  }

  console.log('\n── резервные копии ──');
  {
    const os = require('node:os');
    const dir = path.join(os.tmpdir(), `bk-${process.pid}`);
    process.env.BACKUP_DIR = dir;
    delete require.cache[require.resolve('./backup')];
    const backup = require('./backup');

    const r1 = await backup.makeBackup();
    ok(fs.existsSync(r1.file) && r1.size > 0, 'копия создана', `${Math.round(r1.size / 1024)} КБ`);
    ok(r1.file.endsWith('.db.gz'), 'копия сжата', path.basename(r1.file));

    // Главное: из копии должна открываться рабочая база с теми же данными.
    const { execSync } = require('node:child_process');
    const restored = path.join(dir, 'restored.db');
    execSync(`gunzip -c '${r1.file}' > '${restored}'`);
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(restored);
    ok(d.prepare('PRAGMA integrity_check').get().integrity_check === 'ok',
      'восстановленная база цела');
    const docsIn = d.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
    const cpsIn = d.prepare('SELECT COUNT(*) AS n FROM counterparties').get().n;
    ok(docsIn > 0 && cpsIn > 0, 'в копии есть документы и контрагенты', `${docsIn} и ${cpsIn}`);
    ok(d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n > 5,
      'схема перенеслась целиком');

    ok(backup.list().length === 1, 'копия видна в списке');

    // Проверяем не только количество: «node backup.js --list» печатает дату,
    // и однажды она потерялась по дороге — список падал на живом сервере,
    // хотя сами копии снимались нормально.
    const row = backup.list()[0];
    ok(row.mtime instanceof Date && Number.isFinite(row.mtime.getTime()),
      'у копии в списке есть дата', row.mtime && row.mtime.toISOString());
    ok(row.size > 0 && Number.isFinite(row.mtimeMs), 'размер и время читаются');
    const line = backup.listLine(row);
    ok(line.includes(row.name) && /\d{2}\.\d{2}\.\d{4}/.test(line),
      'строка списка печатается целиком', line.trim());

    // Старые копии удаляются, но последние три остаются при любой настройке:
    // если бот молчал месяц, они — единственное, что есть.
    process.env.BACKUP_KEEP = '0';
    for (let i = 0; i < 4; i += 1) {
      const f = path.join(dir, `trapeza-2020-01-0${i + 1}-1200.db.gz`);
      fs.writeFileSync(f, 'старьё');
      fs.utimesSync(f, new Date('2020-01-01'), new Date('2020-01-01'));
    }
    const before = backup.list().length;
    const removed = backup.prune();
    ok(removed.length > 0, 'старые копии удаляются', `убрано ${removed.length} из ${before}`);
    ok(backup.list().length === 3, 'последние три копии сохраняются всегда',
      backup.list().length);

    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.BACKUP_DIR;
    delete process.env.BACKUP_KEEP;
  }

  console.log('\n── клиент Telegram не вешается ──');
  {
    // Поднимаем свой «Telegram»: настоящий отвечает по-разному, а нам нужно
    // проверить именно поведение клиента на 429 и на молчание.
    const http = require('node:http');
    const { Telegram } = require('./lib/tg');
    let mode = 'slow';
    const fake = http.createServer((req, res) => {
      if (mode === 'silent') return;                       // не отвечаем вовсе
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 429,
        description: 'Too Many Requests', parameters: { retry_after: mode === 'slow' ? 3600 : 1 } }));
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const tgc = new Telegram('test-token');
    tgc.base = `http://127.0.0.1:${fake.address().port}/bot`;

    // Смена имени бота ограничена сутками: Telegram отвечает «подождите час».
    // Раньше клиент честно засыпал — и установка вставала намертво.
    const started = Date.now();
    const err = await tgc.call('setMyName', { name: 'X' }).then(() => null, (e) => e);
    ok(err && err.code === 429 && Date.now() - started < 2000,
      'на «подождите час» клиент не засыпает, а сдаётся сразу', `${Date.now() - started} мс`);
    ok(err && /подождать 60 мин/.test(err.message), 'в ошибке видно, сколько ждать', err.message);

    // Молчащий сервер: без таймаута вызов висел бы вечно.
    mode = 'silent';
    const t0 = Date.now();
    const hung = await tgc.call('getMe', { timeout: 0 }, 3).then(() => null, (e) => e);
    fake.close();
    ok(hung && hung.network, 'молчание сервера — ошибка, а не бесконечное ожидание', hung && hung.message);
    ok(Date.now() - t0 < 60000, 'ожидание ограничено', `${Math.round((Date.now() - t0) / 1000)} с`);
  }

  console.log('\n── защита от второго экземпляра ──');
  {
    const { acquire, alive } = require('./lib/lock');
    const dir = require('node:path').join(require('node:os').tmpdir(), `lock-${process.pid}`);
    const first = acquire('bot-test', dir);
    ok(first.ok, 'первый экземпляр занимает замок');
    const second = acquire('bot-test', dir);
    ok(!second.ok && second.pid === process.pid,
      'второй экземпляр не запускается и знает, кто занял место', second.pid);
    first.release();
    const third = acquire('bot-test', dir);
    ok(third.ok, 'после остановки первого замок свободен');
    third.release();

    // Замок от процесса, которого больше нет, не должен блокировать запуск:
    // иначе после падения бот не поднимется без ручного вмешательства.
    require('node:fs').writeFileSync(require('node:path').join(dir, 'bot-test.lock'), '999999');
    const fourth = acquire('bot-test', dir);
    ok(fourth.ok, 'замок упавшего процесса перехватывается сам');
    fourth.release();
    ok(alive(process.pid) && !alive(999999), 'живой и мёртвый процессы различаются');
    require('node:fs').rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n── счёт, долг и оплата ──');
  {
    const bdb3 = require('./lib/bot-db');
    const uid = fxUserId();
    const org3 = bdb3.getDefaultOrg(uid);
    ok(bdb3.basisOf(org3) === 'closing', 'по умолчанию долг возникает по акту', bdb3.basisOf(org3));

    await tap('org');
    ok(Boolean(button('Долг:')), 'в карточке организации есть настройка основания долга');
    await tap('basis');
    ok(last().includes('становится должен'), 'экран основания долга открывается');

    // Заводим отдельного контрагента, чтобы не мешать прежним подсчётам.
    const before = bdb3.listCps(uid).length;
    const rentId = bdb3.createCp(uid, { name: 'Арендатор ООО «Луч»', kind: 'customer', opening_date: '2026-01-01' });
    ok(bdb3.listCps(uid).length === before + 1, 'контрагент для проверки аренды заведён');

    // Режим «по акту»: счёт долг не создаёт.
    await tap(`d.sch:${rentId}`);
    await say('Аренда, август; 1; 60000');
    await tap('items.done');
    await tap('doc.make');
    ok(bdb3.balanceOf(uid, rentId).closing === 0,
      'в режиме «по акту» счёт долг не создаёт', bdb3.balanceOf(uid, rentId).closing);

    // Режим «по счёту» — субаренда.
    await tap('basis.set:invoice');
    ok(bdb3.basisOf(bdb3.getDefaultOrg(uid)) === 'invoice', 'режим «долг по счёту» сохранён');
    await tap(`d.sch:${rentId}`);
    await say('Аренда, сентябрь; 1; 60000');
    await tap('items.done');
    await tap('doc.make');
    ok(bdb3.balanceOf(uid, rentId).closing === 60000,
      'в режиме «по счёту» счёт создал долг 60 000', bdb3.balanceOf(uid, rentId).closing);
    // Сообщение о проводке уходит подписью к файлу, а не отдельным письмом.
    ok(String((files[files.length - 1] || {}).caption || '').includes('внесён в журнал'),
      'бот сказал, что внёс долг в журнал',
      String((files[files.length - 1] || {}).caption || '').slice(-70));

    const rentDoc = bdb3.listDocs(uid, 1)[0];
    await tap(`doc:${rentDoc.id}`);
    ok(last().includes('не отмечена'), 'в карточке видно, что оплата не отмечена');
    const payBtn = button('Отметить оплаченным');
    ok(Boolean(payBtn), 'есть кнопка отметки оплаты', payBtn);

    await tap(payBtn);
    ok(bdb3.balanceOf(uid, rentId).closing === 0, 'после отметки оплаты долг закрыт',
      bdb3.balanceOf(uid, rentId).closing);
    ok(bdb3.getDoc(uid, rentDoc.id).paid_at, 'дата оплаты записана', bdb3.getDoc(uid, rentDoc.id).paid_at);

    await tap(`doc.unpaid:${rentDoc.id}`);
    ok(bdb3.balanceOf(uid, rentId).closing === 60000, 'отмена оплаты вернула долг');

    // Повторная отметка не должна задваивать проводку.
    await tap(`doc.paid:${rentDoc.id}`);
    await tap(`doc.paid:${rentDoc.id}`);
    ok(bdb3.balanceOf(uid, rentId).closing === 0, 'повторная отметка оплаты не задваивает проводку',
      bdb3.balanceOf(uid, rentId).closing);

    await tap('unpaid');
    ok(last().includes('Не оплачено') || last().includes('Неоплаченных'),
      'экран неоплаченных открывается', last().slice(0, 40));

    // Режим «вручную» — бот в журнал не лезет.
    await tap('basis.set:manual');
    const manId = bdb3.createCp(uid, { name: 'ООО «Ручной учёт»', kind: 'customer', opening_date: '2026-01-01' });
    await tap(`d.usl:${manId}`);
    await say('Услуга; 1; 5000');
    await tap('items.done');
    await tap('doc.make');
    ok(bdb3.balanceOf(uid, manId).closing === 0, 'в режиме «вручную» проводок не появляется',
      bdb3.balanceOf(uid, manId).closing);

    await tap('basis.set:closing');   // возвращаем как было
  }

  console.log('\n── НДС в счёте ──');
  {
    const { vatTotals } = require('./lib/money');
    const bdb2 = require('./lib/bot-db');
    ok(vatTotals([{ qty: 1, price: 100 }], 20, false).total === 120,
      'НДС сверху: 100 + 20% = 120', vatTotals([{ qty: 1, price: 100 }], 20, false).total);
    const inc = vatTotals([{ qty: 1, price: 100 }], 20, true);
    ok(inc.total === 100 && inc.net === 83.33 && inc.vat === 16.67,
      'НДС в том числе: 100 = 83,33 + 16,67', JSON.stringify(inc));
    ok(vatTotals([{ qty: 2, price: 50 }], null, false).vat === null, 'без НДС налог не считается');

    await tap('org');
    const vatBtn = button('НДС:');
    ok(Boolean(vatBtn), 'в карточке организации есть настройка НДС', vatBtn);
    await tap('vat');
    ok(last().includes('НДС в счетах'), 'экран НДС открывается');

    await tap('vat.set:20:0');
    const orgNow = bdb2.getDefaultOrg(fxUserId());
    ok(bdb2.vatOf(orgNow).rate === 20 && bdb2.vatOf(orgNow).gross === false,
      'режим «20% сверху» сохранён', JSON.stringify(bdb2.vatOf(orgNow)));

    // Счёт должен взять ставку сам и посчитать итог с налогом.
    await tap(`d.sch:${cpId}`);
    await say('Услуга с НДС; 1; 1000');
    await tap('items.done');
    ok(norm(last()).includes('НДС 20%: 200,00'), 'в сводке показан налог', norm(last()).slice(-120));
    ok(norm(last()).includes('Всего к оплате: 1 200,00'), 'итог посчитан с налогом сверху');

    const beforeVat = files.length;
    await tap('doc.make');
    ok(files.length === beforeVat + 1, 'счёт с НДС выписан');
    const savedVat = bdb2.listDocs(fxUserId(), 1)[0];
    ok(savedVat.total === 1200, 'в журнал записана сумма с налогом, а не без', savedVat.total);

    // Переопределение ставки для одного документа.
    await tap(`d.sch:${cpId}`);
    await say('Разовая услуга; 1; 500');
    await tap('items.done');
    await tap('doc.vat');
    ok(last().includes('НДС для этого счёта'), 'ставку можно поменять для одного счёта');
    await tap('doc.vat.set:none:0');
    ok(norm(last()).includes('(без НДС)') && norm(last()).includes('500,00'),
      'переопределение сработало — налога в сводке больше нет', norm(last()).slice(-60));
    await tap('doc.make');

    await tap('vat.set:none:0');   // возвращаем как было
  }

  console.log('\n── свой почтовый ящик и отправка ──');
  {
    const net = require('node:net');
    const mailbox = require('./lib/mailbox');
    const uidM = fxUserId();
    // Настоящий SMTP-сервер на localhost: проверяем, что письмо реально
    // уходит с вложением, а не что мы позвали функцию.
    const got = { rcpt: [], data: '', auth: null };
    const smtp = net.createServer((sock) => {
      let inData = false; let body = ''; let expect = null;
      sock.setEncoding('utf8');
      sock.write('220 local ESMTP\r\n');
      sock.on('data', (chunk) => {
        if (inData) {
          body += chunk;
          const end2 = body.indexOf('\r\n.\r\n');
          if (end2 === -1) return;
          got.data = body.slice(0, end2); inData = false; body = '';
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
    await new Promise((res2) => smtp.listen(0, '127.0.0.1', res2));
    const smtpPort = smtp.address().port;

    // Почта должна быть видна из главного меню. Раньше эта кнопка зависела
    // от аргумента, который не передавал ни один вызов, — и не показывалась
    // никогда и никому, хотя вся почта была написана и работала.
    await say('/menu');
    ok(button('Почта') === 'mb', 'почта есть в главном меню', button('Почта'));
    await tap('mb');
    ok(last().includes('Почта для отправки'), 'кнопка открывает экран почты', last().slice(0, 40));

    const schDoc = require('./lib/bot-db').listDocs(uidM, 30).find((x) => x.type === 'sch');
    ok(Boolean(schDoc), 'в журнале есть счёт для отправки');

    // Пока ящик не подключён — кнопки отправки нет.
    await tap(`doc:${schDoc.id}`);
    ok(!button('Отправить на почту') && !button('Отправить на '),
      'без подключённого ящика кнопки отправки нет');

    // Подключение своей корпоративной почты: бот обязан спросить сервер.
    await tap('org');
    ok(Boolean(button('Подключить почту')), 'в организации есть вход в настройку почты');
    await tap('mb.new');
    ok(last().includes('С какого адреса'), 'бот спрашивает адрес');
    await say('не-адрес');
    ok(last().includes('не похоже на адрес'), 'кривой адрес отклонён');
    await say('buh@своядомен.рф');
    ok(last().includes('SMTP-сервера'), 'для своего домена бот спрашивает сервер', last().slice(0, 60));
    await say('не сервер!!');
    ok(last().includes('Не разобрал адрес сервера'), 'мусор вместо сервера отклонён');
    await say(`127.0.0.1:${smtpPort}`);
    ok(last().includes('пришлите пароль'.toLowerCase()) || last().includes('пароль'),
      'бот просит пароль', last().slice(0, 60));
    await say('секретный-пароль');
    // Успех сообщается отдельным письмом, а следом бот показывает экран
    // почты — поэтому смотрим не последнее сообщение, а несколько последних.
    ok(sent.slice(-3).some((m) => m.text.includes('Письмо ушло')),
      'после сохранения бот сам отправил проверочное письмо',
      sent.slice(-3).map((m) => m.text.slice(0, 30)).join(' | '));
    ok(got.rcpt.includes('buh@своядомен.рф'), 'проверочное письмо ушло на свой же адрес', got.rcpt.join());
    ok(got.auth && got.auth.pass === 'секретный-пароль', 'пароль дошёл до сервера');
    ok(Boolean(mailbox.info(uidM).checkedAt), 'ящик помечен проверенным');

    // Пароль не должен светиться ни в интерфейсе, ни в базе.
    ok(!JSON.stringify(mailbox.info(uidM)).includes('секретный-пароль'),
      'пароль не отдаётся наружу');
    ok(!fs.readFileSync(process.env.TRAPEZA_DB || 'data/trapeza.db').includes('секретный-пароль'),
      'пароль в базе хранится зашифрованным');

    // Теперь отправка документа клиенту.
    got.rcpt.length = 0;
    await tap(`doc:${schDoc.id}`);
    const mailBtn = button('Отправить на почту');
    ok(Boolean(mailBtn), 'с подключённым ящиком кнопка появилась', mailBtn);
    await tap(mailBtn);
    ok(last().includes('На какую почту'), 'бот спрашивает адрес получателя');
    await say('buh@zarya.ru');
    ok(last().includes('Отправил'), 'документ отправлен', last().slice(0, 50));
    ok(got.rcpt.includes('buh@zarya.ru'), 'сервер получил адрес клиента', got.rcpt.join());
    ok(/Content-Disposition: attachment/.test(got.data), 'во вложении есть файл');
    ok(/^From: .*своядомен/m.test(got.data) || got.data.includes('buh@'),
      'письмо ушло с адреса клиента, а не с нашего', (/^From:.*/m.exec(got.data) || [''])[0].slice(0, 60));

    const cpNow = require('./lib/bot-db').getCp(uidM, schDoc.cp_id);
    ok(cpNow.email === 'buh@zarya.ru', 'адрес запомнился у контрагента', cpNow.email);

    await tap('mb.del');
    ok(!mailbox.has(uidM), 'почту можно отключить');
    smtp.close();
  }

  console.log('\n── подпись и печать ──');
  const fxLib = require('./lib/facsimile');
  const fxUser = require('./lib/bot-db').getOrCreateUser(USER.id);
  await tap('org');
  ok(Boolean(button('Подпись и печать')), 'в карточке организации есть вход в факсимиле');

  await tap('fx');
  ok(last().includes('Подпись и печать'), 'экран факсимиле открывается');
  ok(last().includes('Ставим'), 'на экране написано, куда ставится факсимиле');

  await tap('fx.add:sign');
  ok(last().includes('Пришлите снимок'), 'бот просит прислать снимок', last().slice(0, 40));
  await say('вот подпись словами');
  ok(last().includes('Жду картинку'), 'на текст вместо картинки бот напоминает, чего ждёт');

  // Блок распознавания счёта выше подменил загрузку на мусорные байты —
  // возвращаем настоящую картинку, иначе проверять нечего.
  tg.downloadFile = async () => Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await handleUpdate(tg, { message: { chat: CHAT, from: USER, photo: [{ file_id: 'sign-1' }] } });
  ok(Boolean(fxLib.get(fxUser.id, 'sign')), 'подпись сохранилась после фото');
  ok(last().includes('Подпись и печать'), 'после загрузки снова показан экран факсимиле');

  const st = require('./lib/bot-db').getState(fxUser.id);
  ok(!st || !st.state, 'состояние ожидания снято — следующее фото пойдёт на распознавание');

  await tap('fx.scope:closing');
  ok(fxLib.scopeOf(fxUser.id) === 'closing', 'режим переключается кнопкой', fxLib.scopeOf(fxUser.id));
  await tap('fx.scope:all');

  // Подпись должна дойти до документа, который выписывает именно бот.
  const beforeFiles = files.length;
  await tap(`d.sch:${cpId}`);
  await say('Проверка факсимиле; 1; 100');
  await tap('items.done');
  await tap('doc.make');
  ok(files.length === beforeFiles + 1, 'счёт с факсимиле выписан', files.length - beforeFiles);

  await tap('fx.del:sign');
  ok(!fxLib.get(fxUser.id, 'sign'), 'подпись убирается кнопкой');

  console.log('\n── изоляция пользователей ──');
  const OTHER = { id: 777002, first_name: 'Чужой', username: 'other' };
  await handleUpdate(tg, { message: { chat: { id: 777002 }, from: OTHER, text: '/start' } });
  await handleUpdate(tg, { callback_query: { id: 'c2', from: OTHER, data: 'cps', message: { chat: { id: 777002 } } } });
  ok(last().includes('Контрагентов пока нет'), 'чужой пользователь не видит наших контрагентов', last().slice(0, 50));
  await handleUpdate(tg, { callback_query: { id: 'c3', from: OTHER, data: `cp:${cpId}`, message: { chat: { id: 777002 } } } });
  ok(last().includes('не найден'), 'по прямой ссылке чужого контрагента тоже не отдаёт');

  console.log('\n── общий браузер для PDF ──');
  const pdf = require('./lib/pdf');
  if (pdf.pdfAvailable()) {
    // Проверяем сам факт переиспользования, а не скорость: сравнение
    // времени на общей машине то проходит, то нет, и ничего не доказывает.
    await pdf.closePdf();
    const launchesBefore = pdf.launches();
    await pdf.htmlToPdf('<h1>раз</h1>');
    await Promise.all([pdf.htmlToPdf('<h1>два</h1>'), pdf.htmlToPdf('<h1>три</h1>')]);
    ok(pdf.launches() === launchesBefore + 1,
      'три документа собраны на одном браузере, а не на трёх',
      `запусков: ${pdf.launches() - launchesBefore}`);
    await pdf.closePdf();
    const t0 = Date.now();
    await pdf.htmlToPdf('<h1>раз</h1>');
    const cold = Date.now() - t0;
    const t1 = Date.now();
    await Promise.all([pdf.htmlToPdf('<h1>два</h1>'), pdf.htmlToPdf('<h1>три</h1>')]);
    const warm = Date.now() - t1;
    ok(warm < cold, 'браузер переиспользуется, а не поднимается заново',
      `холодный старт ${cold} мс, тёплые два ${warm} мс`);
    await pdf.closePdf();
    const buf = await pdf.htmlToPdf('<h1>после закрытия</h1>');
    ok(buf && buf.length > 500, 'после закрытия браузер поднимается заново');
    await pdf.closePdf();
  } else {
    console.log('  ·  Chromium недоступен, проверка пропущена');
  }

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
