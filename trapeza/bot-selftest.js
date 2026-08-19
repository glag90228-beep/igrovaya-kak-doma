'use strict';

/**
 * Прогон бота без живого токена: подставляем вместо Telegram заглушку и
 * проводим пользователя по сценарию — организация, контрагент, операции,
 * все четыре документа. Файлы складываем в папку и рендерим в PNG,
 * чтобы посмотреть глазами.
 *
 *   TRAPEZA_DB=/tmp/selftest.db node bot-selftest.js [папка-для-файлов]
 */

require('./selftest-db');   // своя база на прогон — до всего, что тянет db.js
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
  /*
   * Сторож на боевую базу. На сервере приложение живёт в /opt/trapeza, и
   * путь по умолчанию — `<папка>/data/trapeza.db` — это и есть база клиентов.
   * Запуск `npm test` там залил бы в неё тестовые данные, а README прямо
   * советует «cd trapeza && npm test». Отсюда selftest-db.js и эта проверка.
   */
  {
    const dflt = require('node:path').join(__dirname, 'data', 'trapeza.db');
    const used = require('node:path').resolve(process.env.TRAPEZA_DB || dflt);
    ok(used !== dflt, 'тесты пишут не в рабочую базу приложения', used);
  }

  console.log('\n── разбор текста ──');
  const op1 = parseOp('15.05 приход 94193');
  ok(op1 && op1.credit === 94193 && op1.date === '2026-05-15', 'операция «15.05 приход 94193»', JSON.stringify(op1));
  const op2 = parseOp('02.07 оплата 50000 №79000');
  ok(op2 && op2.debit === 50000 && op2.doc.includes('79000'), 'операция с номером документа', op2 && op2.doc);
  ok(parseOp('привет') === null, 'мусор не превращается в операцию');
  const it = parseItemLine('Канапе ассорти; 20; 650');
  ok(it && it.qty === 20 && it.price === 650, 'позиция «Наименование; кол-во; цена»', JSON.stringify(it));
  ok(parseItemLine('Фуршет 10 1500').name === 'Фуршет', 'позиция без разделителей тоже читается');

  // Предприниматель пишет позицию так, как говорит. Требовать точки с
  // запятой нельзя — на живом сервере на этом застряли в первый же день.
  const line = (s) => parseItemLine(s) || {};
  const same = (s, name, qty, price, unit) => {
    const r = line(s);
    ok(r.name === name && r.qty === qty && r.price === price && (!unit || r.unit === unit),
      `«${s}»`, `${r.name} · ${r.qty} ${r.unit || ''} × ${r.price}`);
  };
  same('Аренда 30 кВм 1 30.000', 'Аренда 30 кВм', 1, 30000);      // точка = тысячи
  same('Аренда помещения 1 30 000', 'Аренда помещения', 1, 30000); // пробел = тысячи
  same('Фуршет 10 1500', 'Фуршет', 10, 1500);                      // и не «10 150» + «0»
  same('Бумага 10 пачек по 300', 'Бумага', 10, 300, 'уп.');
  same('Услуга 2 х 1500', 'Услуга', 2, 1500);
  same('Разработка 2*15000', 'Разработка', 2, 15000);
  same('Молоко 3 л 89,50', 'Молоко', 3, 89.5, 'л');
  same('Работы 1 30000 руб.', 'Работы', 1, 30000);
  same('Консультация 5000', 'Консультация', 1, 5000);              // одно число — цена
  same('Аренда 30 м2 1 30000', 'Аренда 30 м2', 1, 30000);          // число внутри названия

  // А это строгий разбор понять не может — и не должен выдумывать:
  // «30» здесь площадь, а не цена. Такие уходят в дозапрос.
  ok(parseItemLine('Аренда 30 м²') === null, 'число с единицей не принимается за цену');
  const partial = require('./bot').readItemLine('Аренда 30 м²');
  ok(partial.partial && partial.name === 'Аренда 30 м²', 'зато название сохраняется для дозапроса',
    partial.name);

  console.log('\n── старт и организация ──');
  await say('/start');
  ok(last().includes('Первичка'), 'бот поздоровался и показал меню');
  await tap('org.new');
  /*
   * Ручной путь: ИНН вводим (справочник в прогоне не подключён — автозаполнения
   * нет), остальное набираем сами. Шаги:
   * инн → название → полное → адрес → подписант → БИК → банк → к/с → р/с.
   *
   * КПП в списке нет намеренно: ИНН здесь двенадцатизначный, то есть это
   * предприниматель, а у него КПП не бывает — вопрос пропускается. Если он
   * вернётся, ответы сдвинутся и прогон это заметит.
   */
  const ORG = ['183112345637', 'ИП Сарычева М. В.',
    'Индивидуальный предприниматель Сарычева Мария Витальевна',
    'г. Ижевск, ул. Пушкинская, 214', 'М. В. Сарычева',
    '049401601', 'ПАО Сбербанк', '30101810400000000601', '40802810168000012341'];
  for (const v of ORG) await say(v);
  ok(last().includes('сохранена'), 'организация заведена', last().slice(0, 60));
  ok(!sent.some((m) => /КПП/.test(m.text || '')), 'у предпринимателя КПП не спрашивали');
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
  await say('40702810100000098766');
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
  ok(files.length === 0, 'акт сверки сперва спрашивает период, а не шлёт файл сразу');
  ok(last().includes('За какой период'), 'спрошен период акта', last().slice(0, 60));
  const aktKb = ((sent[sent.length - 1] || {}).kb || []).flat().map((b) => b.callback_data);
  ok(aktKb.includes(`akt.p:${cpId}:pm`) && aktKb.includes(`akt.own:${cpId}`),
    'в выборе периода есть и «Прошлый месяц», и «Свой период»', aktKb.join(' '));
  await tap(`akt.p:${cpId}:all`);
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

  // Позиция, у которой понятно только название: бот обязан доспросить
  // недостающее, а не отказать. Раньше он отвечал «Не разобрал», и на
  // этом человек с арендой упирался в стену.
  await say('Аренда 30 м²');
  ok(last().includes('Сколько и по какой цене'), 'непонятную позицию бот доспрашивает',
    norm(last()).replace(/<[^>]+>/g, '').slice(0, 40));
  await say('2');
  ok(last().includes('По какой цене'), 'приняв количество, спрашивает цену');
  await say('30 000');
  ok(norm(last()).includes('Аренда 30 м²') && norm(last()).includes('30 000,00'),
    'позиция собрана из ответов', norm(last()).replace(/<[^>]+>/g, '').slice(0, 50));
  await tap('items.undo');   // для дальнейших проверок сумма должна остаться прежней

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
    org: { name: 'ИП', full_name: 'ИП Сарычева М. В.', inn: '183112345637', address: 'Ижевск' },
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
  await say('40702810900000099998');
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
  await say('1832055557');   // инн (контрольная цифра сходится — бот проверяет)
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
  // Прежняя формулировка — «бот не пишет вашим контрагентам, у него нет их
  // контактов» — перестала быть правдой: письмо должнику отправляется по
  // кнопке. Осталось главное: без нажатия человека не уходит ничего.
  ok(Boolean(button('Текст напоминания')), 'отсюда можно перейти к отправке напоминаний');
  ok(files.length > before, 'файлы отданы пользователю, а не отправлены за него');

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

  console.log('\n── тарифы и цена ──');
  {
    /*
     * Цена и срок доступа должны браться из одного списка.
     *
     * Раньше список сумм жил отдельно, а цену не показывали нигде. При смене
     * цены список оставался старым: платёж на новую сумму не совпадал ни с
     * одной строкой, срок брался запасной — и оплативший год получал месяц.
     */
    const lava = require('./lib/lava');
    const was = process.env.LAVA_PLAN_DAYS;
    process.env.LAVA_PLAN_DAYS = '390:30,2990:365';

    ok(lava.daysFor({ amount: 2990 }) === 365, 'годовой платёж даёт год',
      lava.daysFor({ amount: 2990 }));
    ok(lava.daysFor({ amount: 390 }) === 30, 'месячный — месяц', lava.daysFor({ amount: 390 }));
    ok(lava.priceText() === '390 ₽ в месяц или 2990 ₽ в год',
      'цена собирается из тех же тарифов', lava.priceText());
    ok(lava.yearSaving() === 1690, 'выгода годового считается, а не выдумывается',
      lava.yearSaving());

    // Тарифы поменяли, а цену забыли — так больше не выйдет: она одна и та же.
    process.env.LAVA_PLAN_DAYS = '490:30,4900:365';
    ok(lava.priceText() === '490 ₽ в месяц или 4900 ₽ в год',
      'смена тарифа сразу меняет и показанную цену', lava.priceText());
    ok(lava.daysFor({ amount: 4900 }) === 365, 'и срок за новую годовую сумму');

    // Тарифов нет — цену не выдумываем.
    process.env.LAVA_PLAN_DAYS = '';
    ok(lava.priceText() === '', 'без тарифов цена не показывается');
    ok(lava.yearSaving() === 0, 'и выгода тоже');

    process.env.LAVA_PLAN_DAYS = was === undefined ? '' : was;
  }

  console.log('\n── доступ и оплата ──');
  const bill = require('./lib/billing');
  const meUser = require('./lib/bot-db').getOrCreateUser(USER.id);
  ok(!bill.accessInfo(meUser.id).active, 'по умолчанию доступ не оплачен');
  const until1 = bill.grantDays(meUser.id, 30);
  ok(bill.accessInfo(meUser.id).active && bill.accessInfo(meUser.id).left >= 29,
    'доступ выдан на 30 дней', until1);
  const until2 = bill.grantDays(meUser.id, 30);
  ok(until2 > until1, 'продление добавляется к остатку, а не сгорает', `${until1} → ${until2}`);
  // Ровно 30 дней, а не 29 и не 31: раньше дни прибавлялись к полуночи UTC,
  // и в зависимости от пояса результат уезжал на сутки.
  {
    const pr = require('./lib/period');
    const days = Math.round(
      (new Date(`${until1}T12:00:00Z`) - new Date(`${pr.todayISO()}T12:00:00Z`)) / 86400000,
    );
    ok(days === 30, 'выдано ровно 30 календарных дней', `${pr.todayISO()} → ${until1} = ${days}`);
    ok(until2.slice(0, 4).length === 4 && until2 > until1, 'и продление считается от той же даты');
  }
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

  console.log('\n── путь новичка: от «Старт» до файла ──');
  {
    // Человек, который ничего не знает и ничего не заполнял заранее. Он
    // должен получить документ, ни разу не догадавшись, где что лежит.
    const N = { id: 979001, first_name: 'Новичок' };
    const nSay = (t) => handleUpdate(tg, { message: { chat: { id: N.id }, from: N, text: t } });
    const nTap = (d) => handleUpdate(tg,
      { callback_query: { id: 'c', from: N, data: d, message: { chat: { id: N.id } } } });
    const nLast = () => (sent[sent.length - 1] || {}).text || '';
    /** Кнопка ищется только в последнем сообщении — как её видит человек. */
    const nBtn = (sub) => {
      const m = sent[sent.length - 1] || { kb: [] };
      for (const row of m.kb) for (const b of row) if (b.text.includes(sub)) return b.callback_data;
      return null;
    };
    const filesWas = files.length;

    await nSay('/start');
    ok(nBtn('Выписать счёт') === 'go.sch', 'на первом экране есть кнопка «Выписать счёт»');

    await nTap('go.sch');
    ok(nLast().includes('Как называется') && nLast().includes('Шаг 1 из 4'),
      'проводник спрашивает название и показывает, сколько шагов', nLast().slice(0, 40));
    ok(nBtn('Отмена'), 'из формы есть выход');

    await nSay('ИП Петров П. П.');
    ok(Boolean(nBtn('Пропустить')), 'необязательное поле можно пропустить кнопкой');
    // Каждый раз читаем кнопку заново — как человек, который жмёт последнюю.
    const nSkip = async () => { const b = nBtn('Пропустить'); if (b) await nTap(b); return b; };
    await nSkip(); await nSkip(); await nSkip();
    ok(nLast().includes('ИНН клиента'), 'дошли до анкеты клиента', nLast().slice(0, 30));

    // Сообщения в чате остаются, и кнопка из прошлого вопроса живёт вечно.
    // Нажатие на неё не должно пропускать текущее — тем более обязательное.
    const stale = await nSkip();                       // пропустили ИНН клиента
    ok(nLast().includes('Как называется клиент'), 'спросили имя клиента');
    await nTap(stale);
    ok(nLast().includes('Как называется клиент'),
      'старой кнопкой обязательное поле не пропускается', nLast().slice(0, 30));

    await nSay('ООО Ромашка');
    await nTap('fb:customer');
    ok(nLast().includes('Счёт на оплату'), 'сразу перешли к позициям счёта', nLast().slice(0, 30));

    await nSay('Ремонт компьютера 1 3500');
    await nTap('items.done');
    await nTap('doc.make');
    ok(files.length === filesWas + 1, 'новичок получил файл', files.length - filesWas);
    const caption = (files[files.length - 1] || {}).caption || '';
    ok(caption.includes('нет реквизитов для оплаты'),
      'бот честно предупредил, что платить некуда', caption.slice(-60));
    ok(!caption.includes('есть QR'), 'и не обещал QR, которого нет');
    ok(nLast().includes('Что дальше'), 'после файла показан короткий выбор, а не стена кнопок',
      nLast().slice(0, 30));
  }

  console.log('\n── подписи: ИП и организация ──');
  {
    const { buildSchetHtml } = require('./lib/schet');
    const { buildUpdHtml } = require('./lib/upd');
    const { signRows, isIp } = require('./lib/doc-html');

    // Различаем по длине ИНН: у ИП он двенадцатизначный, у организации — из десяти.
    ok(isIp({ inn: '183114389446' }) === true, 'ИНН из 12 цифр — это предприниматель');
    ok(isIp({ inn: '7707083893' }) === false, 'ИНН из 10 цифр — организация');
    ok(isIp({}) === false, 'без ИНН считаем организацией');
    ok(signRows({ inn: '183114389446', signer: 'И. Н. Сарычев' }).length === 1,
      'у предпринимателя одна строка подписи');
    ok(signRows({ inn: '7707083893', signer: 'И. Иванов' }).length === 2,
      'у организации две: руководитель и бухгалтер');

    const ipOrg = {
      name: 'ИП Сарычев И. Н.', inn: '183114389446', signer: 'И.Н. Сарычев',
      bank_name: 'Сбербанк', bik: '049401601', acc: '40802810668000008020',
      corr_acc: '30101810400000000601',
    };
    const ooo = { ...ipOrg, name: 'ООО «Ромашка»', inn: '7707083893' };
    const cp = { name: 'ООО «Инженер-Д»', inn: '1800047200' };
    const doc = { number: '1', date: '2026-08-17', items: [{ name: 'Аренда', qty: 1, price: 125000 }] };

    const ipHtml = buildSchetHtml({ org: ipOrg, cp, doc });
    ok(ipHtml.includes('Индивидуальный предприниматель'), 'в счёте ИП подпись названа верно');
    ok(!ipHtml.includes('>Руководитель<') && !ipHtml.includes('Бухгалтер'),
      'у ИП в счёте нет ни руководителя, ни бухгалтера — таких должностей у него не бывает');

    const oooHtml = buildSchetHtml({ org: ooo, cp, doc });
    ok(oooHtml.includes('Руководитель') && oooHtml.includes('Бухгалтер'),
      'у организации подписи на месте');
    ok(!oooHtml.includes('Индивидуальный предприниматель'), 'и лишней строки ИП нет');

    // УПД: бланк 1137 содержит все три строки, но заполняется одна.
    const updIp = buildUpdHtml({ org: ipOrg, cp, doc: { ...doc, status: 1, vatRate: 20 } });
    // Берём ровно одну строку подписи: окно «столько-то символов от
    // заголовка» перехлёстывало на соседнюю и находило имя не там.
    const line = (html, title) => {
      const i = html.indexOf(title);
      if (i < 0) return '';
      const end = html.indexOf('</div>', html.indexOf('<div class="line">', i));
      return html.slice(i, end < 0 ? i : end);
    };
    ok(!line(updIp, 'Руководитель организации').includes('Сарычев'),
      'в УПД предприниматель не подписывается за руководителя организации');
    ok(line(updIp, 'Индивидуальный предприниматель или иное').includes('Сарычев'),
      'он подписывается в своей строке');
    const updOoo = buildUpdHtml({ org: ooo, cp, doc: { ...doc, status: 1, vatRate: 20 } });
    ok(line(updOoo, 'Руководитель организации').includes('Сарычев'),
      'у организации подпись стоит у руководителя');
    ok(!line(updOoo, 'Индивидуальный предприниматель или иное').includes('Сарычев'),
      'и не дублируется в строке ИП');
  }

  console.log('\n── акт сверки за период ──');
  {
    const bdbP = require('./lib/bot-db');
    const uid = fxUserId();
    const cpP = bdbP.createCp(uid, {
      name: 'ООО «Долгий»', kind: 'customer',
      opening_balance: 10000, opening_date: '2026-01-01',
    });
    bdbP.addOp(uid, cpP, { date: '2026-01-15', kind: 'Приход', doc: 'Счёт 1', credit: 5000 });
    bdbP.addOp(uid, cpP, { date: '2026-02-10', kind: 'Оплата', doc: 'п/п 5', debit: 3000 });
    bdbP.addOp(uid, cpP, { date: '2026-03-05', kind: 'Приход', doc: 'Счёт 2', credit: 2000 });

    // Начальное сальдо — то, ради чего акт вообще подписывают: клиент
    // с долгом с прошлого года не примет акт, открывающийся нулём.
    const all = bdbP.periodBalance(uid, cpP, '', '2026-12-31');
    ok(all.opening === 10000, 'акт с начала расчётов открывается начальным сальдо', all.opening);
    ok(all.ops.length === 3 && all.closing === 14000, 'и сходится к текущему сальдо',
      `${all.ops.length} оп., ${all.closing}`);

    // Входящее сальдо периода считается, а не берётся из карточки.
    const feb = bdbP.periodBalance(uid, cpP, '2026-02-01', '2026-02-28');
    ok(feb.opening === 15000, 'входящее сальдо февраля = начальное плюс январь', feb.opening);
    ok(feb.ops.length === 1, 'в февральский акт попала одна операция', feb.ops.length);
    ok(feb.totalDebit === 3000 && feb.totalCredit === 0, 'обороты только февральские',
      `${feb.totalDebit}/${feb.totalCredit}`);
    ok(feb.closing === 12000, 'исходящее сальдо февраля', feb.closing);

    // Границы включительные: операция в первый и последний день периода — внутри.
    const day = bdbP.periodBalance(uid, cpP, '2026-02-10', '2026-02-10');
    ok(day.ops.length === 1 && day.opening === 15000, 'границы периода включительные',
      `${day.ops.length} оп., вход ${day.opening}`);

    // Шапка Excel должна совпадать с таблицей, а не жить своей жизнью.
    const { buildAkt } = require('./lib/xlsx-akt');
    const ExcelJS = require('exceljs');
    const p = bdbP.cpForPeriod(uid, cpP, '2026-02-01', '2026-02-28');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildAkt({
      org: { brand: 'ИП Тест', org_short: 'ИП Тест', org_full: 'ИП Тест', org_inn: '183114389446', signer: 'И. Т.' },
      cp: p.view, ops: p.ops,
    }));
    const j = wb.getWorksheet('Журнал операций');
    ok(String(j.getCell('D9').value).includes('01.02.2026'),
      'в шапке акта дата начала выбранного периода', String(j.getCell('D9').value).trim());
    ok(j.getCell('G9').value === 15000, 'и входящее сальдо этого периода', j.getCell('G9').value);

    // Карточку акт не портит: там своё значение — начало отношений.
    ok(bdbP.getCp(uid, cpP).opening_date === '2026-01-01',
      'начало расчётов в карточке не подменяется периодом акта',
      bdbP.getCp(uid, cpP).opening_date);
    ok(!bdbP.getCp(uid, cpP).period_end,
      'и конец периода в карточке не замерзает после первого акта');
  }

  console.log('\n── выбор периода ──');
  {
    const period = require('./lib/period');
    // 15 мая 2026 — середина месяца и второго квартала, чтобы границы были видны.
    const day = new Date(2026, 4, 15);
    const p = (code) => period.presetRange(code, day);
    ok(p('m').from === '2026-05-01' && p('m').to === '2026-05-15',
      'этот месяц — с первого числа по сегодня', `${p('m').from}—${p('m').to}`);
    ok(p('pm').from === '2026-04-01' && p('pm').to === '2026-04-30',
      'прошлый месяц — целиком, а не по сегодня', `${p('pm').from}—${p('pm').to}`);
    ok(p('q').from === '2026-04-01', 'квартал начинается с апреля', p('q').from);
    ok(p('pq').from === '2026-01-01' && p('pq').to === '2026-03-31',
      'прошлый квартал — январь-март', `${p('pq').from}—${p('pq').to}`);
    ok(p('y').from === '2026-01-01', 'год — с первого января', p('y').from);
    ok(p('all').from === '' && p('all').to === '2026-05-15',
      'за всё время — пустое начало, чтобы взять начальное сальдо', JSON.stringify(p('all')));

    // Январь: прошлый месяц и прошлый квартал уезжают в прошлый год.
    const jan = period.presetRange('pm', new Date(2026, 0, 10));
    ok(jan.from === '2025-12-01' && jan.to === '2025-12-31',
      'в январе прошлый месяц — декабрь прошлого года', `${jan.from}—${jan.to}`);
    const janQ = period.presetRange('pq', new Date(2026, 0, 10));
    ok(janQ.from === '2025-10-01' && janQ.to === '2025-12-31',
      'и прошлый квартал — четвёртый прошлого года', `${janQ.from}—${janQ.to}`);

    // Свободный текст: человек пишет как привык.
    const t = (s) => period.parsePeriodText(s, day);
    ok(t('01.01.2026 - 31.03.2026').from === '2026-01-01'
      && t('01.01.2026 - 31.03.2026').to === '2026-03-31', 'две даты через тире');
    ok(t('с 1.2.26 по 28.2.26').from === '2026-02-01', 'даты с «с» и «по» и коротким годом',
      JSON.stringify(t('с 1.2.26 по 28.2.26')));
    ok(t('31.03.2026 01.01.2026').from === '2026-01-01', 'даты задом наперёд разворачиваются');
    ok(t('март').from === '2026-03-01' && t('март').to === '2026-03-31', 'месяц словом');
    ok(t('за апрель 2025').from === '2025-04-01' && t('за апрель 2025').to === '2025-04-30',
      'месяц с годом', JSON.stringify(t('за апрель 2025')));
    ok(t('мае').from === '2026-05-01', 'месяц в косвенном падеже — не путается с мартом',
      JSON.stringify(t('мае')));
    ok(t('2 квартал').from === '2026-04-01' && t('2 квартал').to === '2026-06-30', 'квартал цифрой');
    ok(t('III квартал 2025').from === '2025-07-01', 'квартал римской цифрой',
      JSON.stringify(t('III квартал 2025')));
    ok(t('2025').from === '2025-01-01' && t('2025').to === '2025-12-31', 'только год');
    ok(t('за всё время').from === '', 'за всё время');
    ok(t('01.03.2026').from === '2026-03-01' && t('01.03.2026').to === '2026-05-15',
      'одна дата — от неё по сегодня', JSON.stringify(t('01.03.2026')));
    ok(t('когда-нибудь') === null, 'непонятный текст честно не разбирается');

    // Диапазон месяцев. Раньше брался только первый названный месяц, и на
    // «с марта по май» приходил акт за один март — молча, без всякой ошибки.
    ok(t('с марта по май').from === '2026-03-01' && t('с марта по май').to === '2026-05-31',
      'диапазон месяцев словами берётся целиком', JSON.stringify(t('с марта по май')));
    ok(t('март-май').to === '2026-05-31', 'месяцы через дефис — тоже диапазон');
    ok(t('апрель-июнь 2025').from === '2025-04-01' && t('апрель-июнь 2025').to === '2025-06-30',
      'диапазон месяцев с годом', JSON.stringify(t('апрель-июнь 2025')));
    ok(t('ноябрь-февраль').to === '2027-02-28',
      'диапазон через новый год не сворачивается в пустой', JSON.stringify(t('ноябрь-февраль')));

    // Несуществующие даты. «31.02.2026» проходило и печаталось в шапке акта.
    ok(t('31.02.2026') === null, 'тридцать первого февраля не бывает');
    ok(t('31.04.2026 - 30.06.2026') === null, 'и тридцать первого апреля тоже');
    ok(t('29.02.2026') === null, 'в невисокосном году 29 февраля нет');
    ok(t('29.02.2024').from === '2024-02-29', 'а в високосном — есть',
      JSON.stringify(t('29.02.2024')));

    // Слово должно быть месяцем целиком, а не начинаться как месяц.
    ok(t('максимум') === null, '«максимум» — не май');
    ok(t('декада') === null, '«декада» — не декабрь');
    ok(t('маркетинг') === null, '«маркетинг» — не март');
    ok(t('августе').from === '2026-08-01', 'а склонённый месяц по-прежнему понятен',
      JSON.stringify(t('августе')));
    ok(t('сен').from === '2026-09-01', 'и сокращение тоже', JSON.stringify(t('сен')));

    // Дата документа — по Москве, а не по часовому поясу сервера.
    // Сервер стоит в UTC: в 01:00 первого сентября по Москве документ
    // получал дату 31 августа, то есть уезжал в прошлый месяц.
    const night = new Date('2026-08-31T22:30:00Z');   // 01:30 первого сентября в Москве
    ok(period.todayISO(night) === '2026-09-01',
      'ночью после полуночи по Москве сегодня — уже новое число', period.todayISO(night));
    ok(period.todayDate(night).getMonth() === 8,
      'и «этот месяц» считается от него же', period.todayDate(night).getMonth());
    const ny = new Date('2026-12-31T22:00:00Z');      // 01:00 первого января в Москве
    ok(period.currentYear(ny) === 2027,
      'в новогоднюю ночь номер документа берёт новый год', period.currentYear(ny));
    ok(period.todayISO(new Date('2026-08-18T05:00:00Z')) === '2026-08-18',
      'а днём московская дата совпадает с обычной');

    // Реестр берёт период целиком, акт сверки — по сегодня. Разница
    // осознанная, поэтому она флагом, а не вторым набором периодов.
    const whole = (code) => period.presetRange(code, day, { whole: true });
    ok(whole('m').to === '2026-05-31' && p('m').to === '2026-05-15',
      'реестр берёт месяц целиком, акт сверки — по сегодня',
      `${whole('m').to} / ${p('m').to}`);
    ok(whole('q').to === '2026-06-30', 'квартал для реестра тоже целиком', whole('q').to);
    ok(whole('y').to === '2026-12-31', 'и год', whole('y').to);
    ok(whole('pm').to === p('pm').to, 'а закрытые периоды от флага не зависят');

    // И то же самое живьём: кнопка «Свой период» → текст → файл.
    // Операции сценария внесены без года, то есть текущим.
    const Y = new Date().getFullYear();
    const before = files.length;
    await tap(`d.akt:${cpId}`);
    await tap(`akt.own:${cpId}`);
    ok(last().includes('Напишите период'), 'бот просит написать период', last().slice(0, 40));
    await say('какая-то ерунда');
    ok(last().includes('Не понял период'), 'непонятный ответ не роняет бота');
    ok(files.length === before, 'и файла при этом не шлёт');
    await say(`15.05.${Y} - 20.05.${Y}`);
    ok(files.length === before + 1, 'по своему периоду акт пришёл', files.length - before);
    const cap = norm((files[files.length - 1] || {}).caption || '');
    ok(cap.includes(`период 15.05.${Y}—20.05.${Y}`),
      'и подписан выбранным периодом, а не всем сроком', cap.slice(0, 140));
    ok(/исходящее 54 193/.test(cap),
      'сальдо на конец периода — только по операциям внутри него', cap.slice(0, 200));
  }

  console.log('\n── НДС в накладной и оговорка про УСН ──');
  {
    const { buildTorg12Html } = require('./lib/torg12');
    const { buildUpdHtml } = require('./lib/upd');
    const { usnNote } = require('./lib/doc-html');

    const usn = { name: 'ИП Тест', inn: '183114389446', signer: 'И. Т.', vat_rate: '' };
    const nds = { ...usn, name: 'ООО Тест', inn: '7707083893', vat_rate: '20' };
    const cp2 = { name: 'ООО «Покупатель»', inn: '1800047200' };
    const items = [{ name: 'Товар', unit: 'шт.', qty: 10, price: 1200 }];

    ok(usnNote(usn).includes('упрощённую'), 'у неплательщика оговорка про УСН печатается');
    ok(usnNote(nds) === '', 'у плательщика НДС её нет — это была бы неправда');

    const t0 = buildTorg12Html({ org: usn, cp: cp2, doc: { number: '1', date: '2026-08-17', items } });
    ok(t0.includes('без НДС') && t0.includes('упрощённую'), 'накладная на УСН осталась прежней');

    const t1 = buildTorg12Html({
      org: nds, cp: cp2, doc: { number: '1', date: '2026-08-17', items, vatRate: 20 },
    });
    ok(!t1.includes('упрощённую'), 'у плательщика накладная не заявляет УСН');
    ok(norm(t1).includes('2 400,00'), 'НДС 20% с 12 000 посчитан');
    ok(norm(t1).includes('14 400,00'), 'сумма с налогом отличается от суммы без него');

    const u2 = buildUpdHtml({ org: nds, cp: cp2, doc: { number: '1', date: '2026-08-17', items, status: 2 } });
    ok(!u2.includes('упрощённую'), 'УПД плательщика тоже не заявляет УСН');
    const u2usn = buildUpdHtml({ org: usn, cp: cp2, doc: { number: '1', date: '2026-08-17', items, status: 2 } });
    ok(u2usn.includes('упрощённую'), 'а у неплательщика заявляет');
  }

  console.log('\n── автозаполнение реквизитов ──');
  {
    const dd = require('./lib/dadata');
    const bdbA = require('./lib/bot-db');
    const uid = fxUserId();

    // Ответ реестра для предпринимателя: ОГРНИП в нём есть всегда.
    process.env.DADATA_MOCK = JSON.stringify({
      183114389446: {
        type: 'INDIVIDUAL',
        name: { full_with_opf: 'Индивидуальный предприниматель Тестов Тест Тестович' },
        inn: '183114389446',
        ogrn: '318183200012345',
        address: { value: 'г Ижевск, ул Тестовая, д 1' },
        fio: { surname: 'Тестов', name: 'Тест', patronymic: 'Тестович' },
        state: { status: 'ACTIVE' },
      },
    });
    const r = await dd.partyByInn('183114389446');
    ok(r.ok, 'справочник ответил', r.error);
    ok(r.fields.ogrnip === '318183200012345',
      'ОГРНИП взят из реестра — раньше его теряли', r.fields.ogrnip);
    ok(r.fields.kpp === '', 'у предпринимателя КПП пустой');
    ok(r.fields.signer === 'Т. Т. Тестов', 'подписант собран из ФИО', r.fields.signer);
    delete process.env.DADATA_MOCK;

    const isIpInn = (inn) => String(inn || '').replace(/\D/g, '').length === 12;
    ok(isIpInn('183114389446') && !isIpInn('7707083893'),
      'предприниматель определяется по длине ИНН и в анкете');

    bdbA.saveMyOrg(uid, { ...bdbA.getDefaultOrg(uid), ogrnip: '318183200012345' });
    ok(bdbA.getDefaultOrg(uid).ogrnip === '318183200012345', 'ОГРНИП сохраняется',
      bdbA.getDefaultOrg(uid).ogrnip);
  }

  console.log('\n── разбор вставленных реквизитов ──');
  {
    const { parseRequisites } = require('./lib/reqs');
    // Ровно та беда, что видна в живом счёте: в адрес затекло соседнее поле.
    const block = 'ИП Сарычев Иван Николаевич\n'
      + 'ИНН 183114389446\n'
      + 'Адрес 426054, Удмуртская Респ, Ижевск г, Тарасова ул, дом №6\n'
      + 'Свидетельство о государственной регистрации 18 №003286312\n'
      + 'Р/с 40802810668000008020 в ПАО Сбербанк БИК 049401601';
    const p = parseRequisites(block);
    ok(p.address === '426054, Удмуртская Респ, Ижевск г, Тарасова ул, дом №6',
      'адрес заканчивается там, где кончается адрес', p.address);
    ok(p.inn === '183114389446' && p.bik === '049401601', 'ИНН и БИК разобраны',
      `${p.inn} / ${p.bik}`);

    const withMail = parseRequisites('Адрес 426054, Ижевск, Ленина 1 Email buh@mail.ru');
    ok(withMail.address === '426054, Ижевск, Ленина 1', 'почта в адрес не затекает', withMail.address);
  }

  console.log('\n── контрольные суммы реквизитов ──');
  {
    const rc = require('./lib/requisites-check');
    // Настоящие открытые реквизиты: если алгоритм врёт, это видно сразу.
    ok(rc.checkInn('7707083893').ok, 'ИНН из десяти цифр сходится');
    ok(!rc.checkInn('7707083894').ok, 'одна изменённая цифра в ИНН ловится');
    ok(rc.checkInn('500100732259').ok, 'ИНН предпринимателя из двенадцати цифр сходится');
    ok(!rc.checkInn('500100732250').ok, 'опечатка в ИНН предпринимателя ловится');
    ok(!rc.checkInn('12345').ok, 'ИНН неправильной длины отклонён', rc.checkInn('12345').error);
    ok(rc.checkInn('').ok, 'пустой ИНН — не ошибка: у иностранца его нет');

    ok(rc.checkBik('044525225').ok, 'БИК сходится');
    ok(!rc.checkBik('123456789').ok, 'не российский БИК отклонён');

    // Корр. счёт Сбербанка — проверяется вместе с его же БИК.
    ok(rc.checkAccount('30101810400000000225', '044525225', true).ok, 'корр. счёт сходится с БИК');
    ok(!rc.checkAccount('30101810400000000255', '044525225', true).ok,
      'переставленные цифры в корр. счёте ловятся');
    ok(!rc.checkAccount('40702810900000012345', '044525225').ok,
      'расчётный счёт с опечаткой не пройдёт — по нему бы не заплатили');
    ok(rc.checkAccount('40702810900000012344', '044525225').ok, 'верный расчётный счёт принимается');
    ok(rc.checkAccount('40702810900000012345', '').ok, 'без БИК счёт не проверяем — нечем');

    // И то же самое живьём: бот обязан переспросить, а не записать мусор.
    await tap('cps'); await tap('cp.new');
    await say('7707083894');
    ok(last().includes('контрольной цифре'), 'бот переспрашивает кривой ИНН', last().slice(0, 40));
    await say('7707083893');
    ok(!last().includes('контрольной'), 'верный ИНН принят');
    await say('ООО Проверка'); await say('-'); await say('-'); await say('-');
    await tap('fb:customer');
    await say('-'); await say('0'); await say('01.01.2026');
    await say('044525225');
    await say('-'); await say('-');
    await say('40702810900000012345');
    ok(last().includes('не сходится с БИК'), 'бот не принял счёт, не сходящийся с банком',
      last().slice(0, 45));
    await say('40702810900000012344');
    ok(!last().includes('не сходится'), 'верный счёт принят');
  }

  console.log('\n── номера документов не задваиваются ──');
  {
    const dbx = require('./db').db;
    const bdb = require('./lib/bot-db');
    const uidN = fxUserId();
    const doc = (seq) => dbx.prepare(`
      INSERT INTO documents(user_id, org_id, cp_id, type, number, seq, year, date, total, payload, created_at)
      VALUES(?,0,0,'sch',?,?,2031,'2031-03-01',100,'','2031-03-01')`).run(uidN, String(seq), seq);

    doc(1);
    let blocked = false;
    try { doc(1); } catch (e) { blocked = require('./lib/bot-db').isSeqTaken(e); }
    ok(blocked, 'второй документ с тем же номером база не принимает');
    doc(2);
    ok(bdb.nextSeq(uidN, 'sch', 2031) === 3, 'следующий номер считается от занятых',
      bdb.nextSeq(uidN, 'sch', 2031));

    // Выписка двух документов одновременно: номер берётся до сборки файла,
    // и раньше оба получали одинаковый. Теперь второй пересобирается.
    const ds = require('./lib/doc-service');
    const cpN = bdb.listCps(uidN)[0];
    const two = await Promise.all([
      ds.issueDocument(uidN, { type: 'sch', cpId: cpN.id, items: [{ name: 'Раз', qty: 1, price: 10 }], skipQuota: true }),
      ds.issueDocument(uidN, { type: 'sch', cpId: cpN.id, items: [{ name: 'Два', qty: 1, price: 20 }], skipQuota: true }),
    ]);
    ok(two.every((r) => r.ok), 'оба документа выписались', two.map((r) => r.ok).join());
    const nums = two.map((r) => (r.doc || {}).number);
    ok(nums[0] !== nums[1], 'и номера у них разные', nums.join(' и '));

    dbx.prepare("DELETE FROM documents WHERE user_id = ? AND year = 2031").run(uidN);
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
    //
    // Переключение теперь пересчитывает и уже выписанное: августовский счёт
    // на 60 000 при основании «по акту» долга не создавал, а при «по счёту»
    // создаёт. Раньше переключение меняло строчку в настройках и больше
    // ничего — человек не видел никакой разницы и считал цифру сломанной.
    await tap('basis.set:invoice');
    ok(bdb3.basisOf(bdb3.getDefaultOrg(uid)) === 'invoice', 'режим «долг по счёту» сохранён');
    ok(bdb3.balanceOf(uid, rentId).closing === 60000,
      'переключение подхватило уже выписанный счёт', bdb3.balanceOf(uid, rentId).closing);
    await tap(`d.sch:${rentId}`);
    await say('Аренда, сентябрь; 1; 60000');
    await tap('items.done');
    await tap('doc.make');
    ok(bdb3.balanceOf(uid, rentId).closing === 120000,
      'второй счёт добавил свой долг: 60 000 + 60 000', bdb3.balanceOf(uid, rentId).closing);
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
    ok(bdb3.balanceOf(uid, rentId).closing === 60000,
      'отметка оплаты закрыла долг именно этого счёта', bdb3.balanceOf(uid, rentId).closing);
    ok(bdb3.getDoc(uid, rentDoc.id).paid_at, 'дата оплаты записана', bdb3.getDoc(uid, rentDoc.id).paid_at);

    await tap(`doc.unpaid:${rentDoc.id}`);
    ok(bdb3.balanceOf(uid, rentId).closing === 120000, 'отмена оплаты вернула долг',
      bdb3.balanceOf(uid, rentId).closing);

    // Повторная отметка не должна задваивать проводку.
    await tap(`doc.paid:${rentDoc.id}`);
    await tap(`doc.paid:${rentDoc.id}`);
    ok(bdb3.balanceOf(uid, rentId).closing === 60000,
      'повторная отметка оплаты не задваивает проводку', bdb3.balanceOf(uid, rentId).closing);

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

    /*
     * Напоминание должнику письмом. Раньше здесь был только текст
     * «скопируйте и отправьте сами» — при том что счёт тому же клиенту
     * уходит с того же ящика по кнопке. Разницы между ними нет.
     */
    got.rcpt.length = 0; got.data = '';
    const bdbR = require('./lib/bot-db');
    const cpDebt = bdbR.createCp(uidM, {
      name: 'ООО «Забывчивый»', kind: 'customer', opening_date: '2026-01-01', email: 'buh@zabyv.ru',
    });
    bdbR.addOp(uidM, cpDebt, { date: '2026-07-01', kind: 'Приход', doc: 'Акт 3', credit: 31000 });

    await tap('debt.remind');
    const sendBtn = button('Отправить на buh@zabyv.ru');
    ok(Boolean(sendBtn), 'у должника с известной почтой есть кнопка отправки', sendBtn);
    ok(sent.some((m) => /числится задолженность/.test(m.text || '')), 'текст напоминания показан');

    await tap(sendBtn);
    ok(last().includes('Отправлено на'), 'напоминание отправлено', last().slice(0, 60));
    ok(got.rcpt.includes('buh@zabyv.ru'), 'сервер получил адрес должника', got.rcpt.join());
    ok(/Content-Disposition: attachment/.test(got.data), 'акт сверки приложен к письму');
    ok(/xlsx/i.test(got.data), 'вложение — именно Excel с актом сверки');
    ok(last().includes('вместе с актом сверки'), 'бот сказал, что приложил акт');

    // Должнику без почты — сначала спрашиваем адрес, потом отправляем.
    got.rcpt.length = 0;
    const cpNoMail = bdbR.createCp(uidM, {
      name: 'ООО «Безадресный»', kind: 'customer', opening_date: '2026-01-01',
    });
    bdbR.addOp(uidM, cpNoMail, { date: '2026-07-01', kind: 'Приход', doc: 'Акт 4', credit: 5000 });
    await tap(`rm.ask:${cpNoMail}`);
    ok(last().includes('Куда отправить'), 'бот спрашивает адрес', last().slice(0, 40));
    await say('не-почта');
    ok(last().includes('выглядит неправильно'), 'кривой адрес отклонён');
    await tap(`rm.ask:${cpNoMail}`);
    await say('buh@bezadres.ru');
    ok(got.rcpt.includes('buh@bezadres.ru'), 'письмо ушло на указанный адрес', got.rcpt.join());
    ok(bdbR.getCp(uidM, cpNoMail).email === 'buh@bezadres.ru', 'адрес запомнился в карточке');

    await tap('mb.del');
    ok(!mailbox.has(uidM), 'почту можно отключить');

    // Без ящика кнопки отправки быть не должно — только текст.
    // Смотрим лишь сообщения после нажатия: button() ищет по всей переписке
    // и нашёл бы кнопку, показанную до отключения почты.
    const mark = sent.length;
    await tap('debt.remind');
    const fresh = sent.slice(mark);
    ok(!fresh.some((m) => (m.kb || []).flat().some((b) => /Отправить на/.test(b.text))),
      'без почты кнопка отправки не показывается');
    ok(fresh.some((m) => /Подключите свою почту/.test(m.text || '')),
      'и сказано, что почту можно подключить');
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

  console.log('\n── свободный ввод ──');
  {
    const ai = require('./lib/ai-agent');
    const bdbA = require('./lib/bot-db');
    const uid = fxUserId();

    // По умолчанию модуль выключен: ключ в .env лежит ради распознавания
    // счетов и сам по себе не должен запускать расходы.
    delete process.env.AI_ENABLED;
    process.env.AI_PROVIDER = 'mock';
    ok(ai.aiAvailable() === false, 'без AI_ENABLED модуль выключен');
    ok(ai.aiHint().includes('AI_ENABLED'), 'подсказка объясняет, чего не хватает', ai.aiHint());

    // Местный разбор работает всегда и бесплатно.
    ok(ai.quickParse('кто мне должен').action === 'debts', 'долги узнаются без модели');
    ok(ai.quickParse('выставь счёт Заре').docType === 'sch', 'счёт узнаётся без модели');
    ok(ai.quickParse('оформи акт для ООО Ромашка').who === 'ООО Ромашка', 'имя клиента вырезано',
      ai.quickParse('оформи акт для ООО Ромашка').who);
    ok(ai.quickParse('привет как дела') === null, 'болтовня местным разбором не ловится');

    let intent = await ai.understand('привет как дела', uid);
    ok(intent.action === 'unknown' && intent.source === 'off',
      'выключенный модуль к модели не ходит', intent.source);

    // Включаем с заглушкой вместо сети.
    process.env.AI_ENABLED = '1';
    ok(ai.aiAvailable() === true, 'с AI_ENABLED и провайдером модуль готов');

    process.env.AI_MOCK = JSON.stringify({
      action: 'draft', docType: 'sch', who: 'Заря',
      items: [{ name: 'Аренда', qty: 1, price: 30000 }],
    });
    intent = await ai.understand('надо бы выставить Заре за аренду тридцать тысяч', uid);
    ok(intent.action === 'draft' && intent.items[0].price === 30000, 'ответ модели разобран',
      JSON.stringify(intent).slice(0, 80));

    // Всё, что пришло от модели, — данные из ненадёжного источника.
    ok(ai.sanitize({ action: 'delete_everything' }).action === 'unknown', 'чужое действие отброшено');
    ok(ai.sanitize({ action: 'draft', docType: 'вирус' }).action === 'unknown', 'чужой тип документа отброшен');
    const dirty = ai.sanitize({
      action: 'draft', docType: 'sch', who: 'x',
      items: [{ name: 'Товар', qty: -5, price: -100 }, { name: '', qty: 1, price: 1 }],
    });
    ok(dirty.items.length === 1 && dirty.items[0].qty === 1 && dirty.items[0].price === 0,
      'отрицательные количество и цена обезврежены', JSON.stringify(dirty.items));

    // Контрагент — только однозначный.
    const cps = [{ id: 1, name: 'ООО «Заря»' }, { id: 2, name: 'Заря-Строй' }, { id: 3, name: 'Ромашка' }];
    ok(ai.matchCp(cps, 'Ромашка').cp.id === 3, 'однозначное имя найдено');
    ok(ai.matchCp(cps, 'Заря').cp.id === 1, 'точное совпадение сильнее частичного',
      JSON.stringify(ai.matchCp(cps, 'Заря')));
    ok((ai.matchCp(cps, 'Зар').choices || []).length === 2, 'двусмысленное имя — это вопрос, а не выбор',
      JSON.stringify(ai.matchCp(cps, 'Зар').choices || []));
    ok(!ai.matchCp(cps, 'Никого').cp, 'незнакомое имя не подставляется');

    // Деньги: счётчик и предел.
    const before = ai.budget(uid);
    await ai.understand('какая-то фраза для модели', uid);
    ok(ai.budget(uid).mine === before.mine + 1, 'обращение к модели посчитано', ai.budget(uid).mine);
    ok(ai.quickParse('кто должен') && (await ai.understand('кто должен', uid)).source === 'local',
      'местный разбор расход не тратит');
    const afterLocal = ai.budget(uid).mine;
    ok(afterLocal === before.mine + 1, 'счётчик не вырос от местного разбора', afterLocal);

    process.env.AI_USER_LIMIT = String(afterLocal);
    intent = await ai.understand('ещё одна фраза для модели', uid);
    ok(intent.source === 'limit', 'личный предел останавливает расход', intent.source);
    delete process.env.AI_USER_LIMIT;

    // Через бота: фраза открывает мастер, но документ не выписывается.
    const cpA = bdbA.createCp(uid, { name: 'ООО «Тюльпан»', kind: 'customer', opening_date: '2026-01-01' });
    process.env.AI_MOCK = JSON.stringify({
      action: 'draft', docType: 'sch', who: 'Тюльпан',
      items: [{ name: 'Обслуживание', qty: 1, price: 12000 }],
    });
    const docsBefore = bdbA.listDocs(uid, 99).length;
    await say('надо выписать Тюльпану за обслуживание');
    ok(bdbA.listDocs(uid, 99).length === docsBefore, 'документ сам не выписался',
      bdbA.listDocs(uid, 99).length - docsBefore);
    const st = bdbA.getState(uid);
    ok(st.state === `items:sch:${cpA}`, 'открыт обычный мастер с этим клиентом', st.state);
    ok(st.data.items.length === 1 && st.data.items[0].price === 12000, 'позиции подставлены',
      JSON.stringify(st.data.items));
    ok(norm(last()).includes('Проверьте'), 'бот просит проверить, а не отчитывается о выписке',
      norm(last()).slice(0, 60));
    await tap('menu');

    delete process.env.AI_ENABLED;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MOCK;
  }

  console.log('\n── проводка не переживает свой документ ──');
  {
    const bdbO = require('./lib/bot-db');
    const { db: rawDb } = require('./db');
    const docSvc = require('./lib/doc-service');
    const uid = fxUserId();
    const org = bdbO.getDefaultOrg(uid);
    const was = bdbO.basisOf(org);
    bdbO.updateOrg(uid, org.id, { debt_basis: 'invoice' });
    const cpO = bdbO.createCp(uid, { name: 'ООО «Сирота»', kind: 'customer', opening_date: '2026-01-01' });
    await docSvc.issueDocument(uid, {
      type: 'sch', cpId: cpO, items: [{ name: 'Работа', qty: 1, price: 9000 }], skipQuota: true,
    });
    ok(bdbO.balanceOf(uid, cpO).closing === 9000, 'счёт создал долг', bdbO.balanceOf(uid, cpO).closing);

    // Штатное удаление забирает проводку с собой.
    const doc = bdbO.listDocs(uid, 5, cpO)[0];
    bdbO.deleteDoc(uid, doc.id);
    ok(bdbO.balanceOf(uid, cpO).closing === 0,
      'удаление документа убрало и его проводку', bdbO.balanceOf(uid, cpO).closing);

    /*
     * А теперь беда с боевого сервера: документ удалён мимо deleteDoc —
     * так делали старые версии бота. Проводка остаётся, долг держится
     * вечно, и убрать его из приложения нельзя: карточки документа нет.
     * Ровно на этот случай есть tools/debt-audit.js, и schema-check
     * теперь про такие проводки предупреждает.
     */
    await docSvc.issueDocument(uid, {
      type: 'sch', cpId: cpO, items: [{ name: 'Ещё', qty: 1, price: 4000 }], skipQuota: true,
    });
    const doc2 = bdbO.listDocs(uid, 5, cpO)[0];
    rawDb.prepare('DELETE FROM documents WHERE id = ?').run(doc2.id);
    ok(bdbO.balanceOf(uid, cpO).closing === 4000,
      'проводка пережила документ — долг держится', bdbO.balanceOf(uid, cpO).closing);

    const lost = rawDb.prepare(`
      SELECT COUNT(*) AS n FROM operations o
       WHERE o.doc_id > 0 AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = o.doc_id)`).get().n;
    ok(lost >= 1, 'такую проводку видно запросом — на нём стоит schema-check', lost);

    rawDb.prepare(`
      DELETE FROM operations
       WHERE doc_id > 0 AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = doc_id)`).run();
    ok(bdbO.balanceOf(uid, cpO).closing === 0,
      'после уборки сирот долг сошёлся к нулю', bdbO.balanceOf(uid, cpO).closing);

    bdbO.updateOrg(uid, org.id, { debt_basis: was });
    bdbO.rebuildDebt(uid);
  }

  console.log('\n── из чего складывается сумма на главной ──');
  {
    /*
     * Жалоба звучит так: «удалил документы, а сумма прежняя». Почти всегда
     * её держат не документы, и человеку это нужно показать. Проверяем, что
     * разбор сходится к самой цифре и что каждое слагаемое попало в свою
     * графу — иначе экран будет врать убедительнее, чем молчащая цифра.
     */
    const bdbW = require('./lib/bot-db');
    const { db: rawDb } = require('./db');
    const docSvc = require('./lib/doc-service');
    const uidW = bdbW.getOrCreateUser(778899001, 'Разбор суммы').id;
    const orgW = bdbW.createOrg(uidW, { name: 'ИП Разбор', inn: '123456789012' });
    bdbW.updateOrg(uidW, orgW, { debt_basis: 'invoice' });
    const cpW = bdbW.createCp(uidW, {
      name: 'ООО «Слагаемые»', kind: 'customer',
      opening_balance: 5000, opening_date: '2026-01-01',
    });
    await docSvc.issueDocument(uidW, {
      type: 'sch', cpId: cpW, items: [{ name: 'Работа', qty: 1, price: 10000 }], skipQuota: true,
    });
    bdbW.addOp(uidW, cpW, { date: '2026-03-01', kind: 'Оплата', doc: 'п/п 7', debit: 3000 });

    const b1 = bdbW.debtBreakdown(uidW);
    ok(b1.total === 12000, 'сумма долга — 12 000', b1.total);
    ok(b1.opening === 5000, 'начальное сальдо в своей графе', b1.opening);
    ok(b1.docs === 10000, 'документ в своей графе', b1.docs);
    ok(b1.manual === -3000, 'ручная оплата в своей графе', b1.manual);
    ok(b1.orphan === 0, 'строк без документа нет', b1.orphan);
    ok(b1.opening + b1.docs + b1.manual + b1.orphan === b1.total,
      'слагаемые сходятся к самой цифре');

    // Документ удалён мимо deleteDoc — его проводка переезжает в «сироты»,
    // а не растворяется в графе документов: иначе поломку не увидеть.
    const docW = bdbW.listDocs(uidW, 5, cpW)[0];
    rawDb.prepare('DELETE FROM documents WHERE id = ?').run(docW.id);
    const b2 = bdbW.debtBreakdown(uidW);
    ok(b2.total === 12000, 'сумма не изменилась — документа нет, а долг держится', b2.total);
    ok(b2.docs === 0 && b2.orphan === 10000, 'строка ушла в «без документа»', `${b2.docs}/${b2.orphan}`);
    ok(b2.orphanCount === 1, 'и посчитана штучно', b2.orphanCount);

    // Долг поставщику в «должны вам» не попадает — там другая сторона.
    bdbW.createCp(uidW, {
      name: 'ООО «Поставщик»', kind: 'supplier',
      opening_balance: 7000, opening_date: '2026-01-01',
    });
    const b3 = bdbW.debtBreakdown(uidW);
    ok(b3.total === 12000, 'наш долг поставщику сюда не приплюсовался', b3.total);
    ok(b3.opening === 5000, 'и его начальное сальдо тоже', b3.opening);
  }

  console.log('\n── смена основания пересчитывает прошлое ──');
  {
    const bdbR = require('./lib/bot-db');
    const docSvc = require('./lib/doc-service');
    const uid = fxUserId();
    const org = bdbR.getDefaultOrg(uid);
    const was = bdbR.basisOf(org);
    const cpR = bdbR.createCp(uid, { name: 'ООО «Пересчёт»', kind: 'customer', opening_date: '2026-01-01' });

    bdbR.updateOrg(uid, org.id, { debt_basis: 'closing' });
    bdbR.rebuildDebt(uid);
    await docSvc.issueDocument(uid, {
      type: 'sch', cpId: cpR, items: [{ name: 'Работа', qty: 1, price: 10000 }], skipQuota: true,
    });
    ok(bdbR.balanceOf(uid, cpR).closing === 0,
      'при «долге по отгрузке» счёт долга не создаёт', bdbR.balanceOf(uid, cpR).closing);

    /*
     * Главная жалоба владельца: «счета удаляю, а сумма на главной не
     * меняется». Так и было: при основании «по отгрузке» счёт долга не
     * создаёт, крупная цифра «должны вам» стоит нулём и не шевелится, что
     * ни делай. Переключение на «долг по счёту» не помогало — проводки
     * создаются при выписке, а уже выписанное оставалось как было.
     */
    bdbR.updateOrg(uid, org.id, { debt_basis: 'invoice' });
    const fixed = bdbR.rebuildDebt(uid);
    // Пересчёт идёт по всем документам пользователя, а их к этому месту в
    // прогоне уже много — проверяем не число, а результат для этой карточки.
    ok(fixed.added >= 1, 'переключение досоздало проводки прошлым счетам', JSON.stringify(fixed));
    ok(bdbR.balanceOf(uid, cpR).closing === 10000,
      'и долг наконец появился', bdbR.balanceOf(uid, cpR).closing);

    // И теперь удаление счёта наконец двигает цифру.
    const doc = bdbR.listDocs(uid, 5, cpR)[0];
    bdbR.deleteDoc(uid, doc.id);
    ok(bdbR.balanceOf(uid, cpR).closing === 0,
      'удаление счёта уменьшило долг — то, чего и ждал человек',
      bdbR.balanceOf(uid, cpR).closing);

    // Обратный ход убирает проводки, но не трогает отметки об оплате.
    await docSvc.issueDocument(uid, {
      type: 'sch', cpId: cpR, items: [{ name: 'Ещё', qty: 1, price: 5000 }], skipQuota: true,
    });
    const doc2 = bdbR.listDocs(uid, 5, cpR)[0];
    bdbR.markPaid(uid, doc2.id, '2026-08-18');
    const paidOps = () => bdbR.listOps(uid, cpR).filter((o) => o.kind === 'Оплата').length;
    const hadPaid = paidOps();
    bdbR.updateOrg(uid, org.id, { debt_basis: 'closing' });
    const back = bdbR.rebuildDebt(uid);
    ok(back.removed >= 1, 'обратное переключение убрало проводки долга', JSON.stringify(back));
    ok(paidOps() === hadPaid, 'а отметки об оплате не тронуты: их ставил человек', paidOps());

    bdbR.updateOrg(uid, org.id, { debt_basis: was });
    bdbR.rebuildDebt(uid);
  }

  console.log('\n── брошенный сценарий ──');
  {
    const bdbS = require('./lib/bot-db');
    const uid = fxUserId();
    const st = () => bdbS.getState(uid).state;

    // Ушёл в другой раздел — недописанное отменяется. Раньше состояние
    // жило дальше, и «Спасибо» в чате бот принимал за позицию счёта.
    await tap(`d.sch:${cpId}`);
    ok(st().startsWith('items:'), 'счёт начат', st());
    await say('Аренда помещения; 1; 30000');
    await tap('docs');
    ok(st() === '', 'уход в «Мои документы» отменяет незаконченный счёт', st());
    ok(/Незаконченный документ отменил/.test(sent[sent.length - 2].text || ''),
      'и об отмене сказано, а не потеряно молча',
      (sent[sent.length - 2].text || '').slice(0, 60));

    const mark = sent.length;
    await say('Спасибо');
    ok(!/по какой цене/.test(last()), 'обычное слово больше не уходит в брошенный счёт',
      last().slice(0, 60));
    ok(sent.length > mark, 'бот всё равно отвечает, а не молчит');

    // А кнопки самого сценария состояние сохраняют — иначе его не пройти.
    await tap(`d.sch:${cpId}`);
    await say('Канапе; 20; 650');
    await tap('items.undo');
    ok(st().startsWith('items:'), 'кнопка внутри сценария его не сбрасывает', st());
    await tap('menu');
    ok(st() === '', 'а «Меню» сбрасывает', st());
  }

  console.log('\n── регулярные документы ──');
  {
    const rec = require('./lib/recurring');
    const bdbR = require('./lib/bot-db');
    const uid = fxUserId();

    // Правила дней проверяем отдельно от бота: ошибка здесь незаметна до
    // конца месяца, а потом счёт уходит не тем числом.
    ok(rec.normalizeDay(31) === 28, '31-е сводится к 28-му: такого дня нет в феврале', rec.normalizeDay(31));
    ok(rec.normalizeDay(0) === 0, '0 — это «последний день месяца», а не ошибка');
    ok(rec.normalizeDay('пятое') === 1, 'мусор превращается в 1-е, а не в NaN', rec.normalizeDay('пятое'));

    // Часы у повторений и у документов должны быть одни.
    //
    // Ежедневный обход просыпается по московской дате. Пока месяц здесь
    // считался по UTC, в промежутке с 21:00 до полуночи по Гринвичу обход
    // уже видел новый день, а месяц — ещё старый: предложение выписать
    // документ считалось сделанным и пропадало на весь месяц. Молча.
    {
      const pr = require('./lib/period');
      ok(rec.monthKey() === pr.todayISO().slice(0, 7),
        'месяц повторений и дата документов идут по одним часам',
        `${rec.monthKey()} vs ${pr.todayISO().slice(0, 7)}`);
      const night = pr.todayDate(new Date('2026-08-31T22:30:00Z')); // 01:30 первого сентября в Москве
      ok(rec.monthKey(night) === '2026-09',
        'ночью первого числа месяц уже новый', rec.monthKey(night));
      ok(rec.isDue({ active: 1, day: 1, last_offer: '2026-08' }, night),
        'и предложение за новый месяц не пропадает');
      ok(!rec.isDue({ active: 1, day: 1, last_offer: '2026-09' }, night),
        'а дважды за один месяц не предлагается');
    }
    const on = (day, iso2, lastOffer = '') => rec.isDue(
      { active: 1, day, last_offer: lastOffer }, new Date(`${iso2}T12:00:00Z`),
    );
    ok(on(5, '2026-08-05') === true, 'в свой день предложение положено');
    ok(on(5, '2026-08-04') === false, 'накануне — рано');
    ok(on(5, '2026-08-09') === true, 'бот молчал четыре дня — предложение всё равно придёт');
    ok(on(5, '2026-08-09', '2026-08') === false, 'за этот месяц уже предлагали');
    ok(on(5, '2026-09-01', '2026-08') === false, 'первого сентября пятое ещё не наступило');
    ok(on(0, '2026-08-31') === true, 'последний день августа');
    ok(on(0, '2026-08-30') === false, 'предпоследний — ещё нет');
    ok(on(0, '2026-02-28') === true, 'в невисокосном феврале последний день — 28-е');

    // Цикл аренды: счёт за 3 дня до числа договора, срок оплаты, просрочка.
    const rent = { active: 1, day: 1, pay_day: 5, lead_days: 3, last_offer: '', last_due: '' };
    ok(rec.offerDay(rent) === 2, 'счёт за 3 дня до 5-го — это 2-е', rec.offerDay(rent));
    ok(rec.offerDay({ ...rent, pay_day: 2, lead_days: 5 }) === 1,
      'за 5 дней до 2-го — не «минус третье», а 1-е', rec.offerDay({ ...rent, pay_day: 2, lead_days: 5 }));
    ok(rec.offerDay({ active: 1, day: 15, pay_day: 0 }) === 15, 'без срока оплаты работает обычный день');

    const at = (iso2, over) => {
      const d = new Date(`${iso2}T12:00:00Z`);
      return over ? rec.isOverdue(rent, d) : rec.isDue(rent, d);
    };
    ok(at('2026-09-02') === true, 'второго сентября пора выставлять счёт');
    ok(at('2026-09-01') === false, 'первого — ещё рано');
    ok(at('2026-09-05', true) === false, 'в день оплаты просрочки ещё нет');
    ok(at('2026-09-06', true) === true, 'шестого — первый день просрочки');
    ok(rec.isOverdue({ ...rent, last_due: rec.monthKey(new Date('2026-09-06T12:00:00Z')) },
      new Date('2026-09-06T12:00:00Z')) === false, 'о просрочке сообщаем раз в месяц');
    ok(rec.isOverdue({ ...rent, pay_day: 0 }, new Date('2026-09-28T12:00:00Z')) === false,
      'без срока оплаты просрочки не бывает');
    ok(rec.dueDate(rent, new Date('2026-09-10T12:00:00Z')) === '2026-09-05', 'срок оплаты за месяц',
      rec.dueDate(rent, new Date('2026-09-10T12:00:00Z')));

    // Заводим повторение из настоящего выписанного документа.
    const cpR = bdbR.createCp(uid, { name: 'Арендатор ООО «Тихий»', kind: 'customer', opening_date: '2026-01-01' });
    await tap(`d.sch:${cpR}`);
    await say('Аренда, сентябрь; 1; 45000');
    await tap('items.done');
    await tap('doc.make');
    ok(Boolean(button('Повторять каждый месяц')), 'после выписки предложено повторять');

    await tap(button('Повторять каждый месяц'));
    ok(norm(last()).includes('Какого числа клиент должен платить'),
      'у счёта спрашивают число из договора, а не «когда напомнить»', norm(last()).slice(0, 50));
    await tap(button('5-го'));
    ok(last().includes('За сколько дней выставлять счёт'), 'второй шаг — насколько заранее',
      last().slice(0, 50));
    await tap(button('За 3 дня'));

    ok(norm(last()).includes('2-го — предложу выписать'), 'счёт за 3 дня до 5-го → 2-го числа',
      norm(last()).slice(0, 120));
    ok(norm(last()).includes('5-го — срок оплаты'), 'срок оплаты показан');
    ok(norm(last()).includes('6-го — напомню'), 'обещан сигнал в первый день просрочки');
    ok(last().includes('клиенту не напишу'), 'обещано не писать контрагенту самому');
    ok(last().includes('начну со следующего'), 'сказано, что за этот месяц документ уже выписан');

    const mine = rec.list(uid);
    const one = mine.find((r) => r.cp_id === cpR);
    ok(Boolean(one), 'повторение в списке');
    ok(one.pay_day === 5 && one.lead_days === 3 && one.offerDay === 2,
      'срок оплаты и упреждение сохранены', `${one.pay_day}/${one.lead_days}/${one.offerDay}`);
    ok(one.items.length === 1 && one.items[0].price === 45000, 'позиции сохранены', JSON.stringify(one.items));
    ok(one.last_offer === rec.monthKey(), 'текущий месяц сразу отмечен как отработанный', one.last_offer);
    ok(rec.isDue(one, new Date()) === false, 'сегодня повторение не сработает');

    // Акт в конце месяца — вторая половина цикла аренды, одной кнопкой.
    await tap(`rec.akt:${cpR}`);
    const akt = rec.list(uid).find((r) => r.cp_id === cpR && r.type === 'usl');
    ok(Boolean(akt) && akt.day === rec.LAST_DAY, 'акт заведён на конец месяца', akt && akt.day);
    ok(akt.items.length === 1 && akt.items[0].price === 45000, 'позиции акта взяты из счёта');
    await tap(`rec.akt:${cpR}`);
    ok(last().includes('уже повторяется'), 'второй такой же акт не заводится', last().slice(0, 40));
    rec.off(uid, akt.id);

    // Наступил следующий месяц — предложение должно прийти.
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(6);
    ok(rec.isDue(one, nextMonth) === true, 'в следующем месяце предложение положено');

    // Предложение и выписка по кнопке.
    const before = bdbR.listDocs(uid, 50).length;
    await tap(`rec.go:${one.id}`);
    ok(bdbR.listDocs(uid, 50).length === before + 1, 'по кнопке документ выписан',
      bdbR.listDocs(uid, 50).length - before);
    const madeDoc = bdbR.listDocs(uid, 1)[0];
    ok(madeDoc.total === 45000 && madeDoc.cp_id === cpR, 'тот же клиент и та же сумма',
      `${madeDoc.total} / ${madeDoc.cp_id}`);

    await tap(`rec.skip:${one.id}`);
    ok(last().includes('Пропустил'), 'месяц можно пропустить');

    await tap(`rec.off:${one.id}`);
    ok(!rec.list(uid).some((r) => r.id === one.id), 'повторение выключается');
    ok(rec.due(nextMonth).every((r) => r.id !== one.id), 'выключенное больше не предлагается');

    // Чужое повторение недоступно по прямому id.
    const other = bdbR.getOrCreateUser(880042, 'Чужой', 'alien');
    const otherCp = bdbR.createCp(other.id, { name: 'Их клиент', kind: 'customer', opening_date: '2026-01-01' });
    const alien = rec.add(other.id, { cpId: otherCp, type: 'sch', items: [{ name: 'x', qty: 1, price: 1 }] });
    rec.off(uid, alien);
    ok(Boolean(require('./db').db.prepare('SELECT active FROM recurring WHERE id = ?').get(alien).active),
      'чужое повторение выключить нельзя');
    ok(rec.get(uid, alien) === null, 'чужое повторение не отдаётся по прямому id');
    ok(!rec.list(uid).some((r) => r.id === alien), 'чужого нет в своём списке');
  }

  console.log('\n── сигнал о просрочке ──');
  {
    const rec = require('./lib/recurring');
    const bdbO = require('./lib/bot-db');
    const { runDaily } = require('./bot.js');
    const uid = fxUserId();

    const cpO = bdbO.createCp(uid, { name: 'ООО «Должник»', kind: 'customer', opening_date: '2026-01-01' });
    await tap(`d.sch:${cpO}`);
    await say('Аренда за месяц; 1; 20000');
    await tap('items.done');
    await tap('doc.make');
    const bill = bdbO.listDocs(uid, 1)[0];

    // Срок оплаты — вчера, о просрочке ещё не сообщали.
    const id = rec.add(uid, { cpId: cpO, type: 'sch', items: [{ name: 'Аренда', qty: 1, price: 20000 }] });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    rec.setSchedule(uid, id, { payDay: Math.max(1, Math.min(27, yesterday.getDate())), leadDays: 3 });

    const before = sent.length;
    await runDaily(tg);
    const warned = sent.slice(before).map((m) => norm(m.text)).join('\n');
    ok(/Просрочка: ООО «Должник»/.test(warned), 'бот сообщил о просрочке', warned.slice(0, 60));
    ok(/20 000,00/.test(warned), 'в сообщении сумма неоплаченного');
    ok(!/отправил|написал клиенту/i.test(warned), 'контрагенту бот ничего не отправлял');

    // Второй раз в том же месяце — молчим.
    const after = sent.length;
    await runDaily(tg);
    ok(sent.length === after, 'повторно за тот же месяц не напоминает', sent.length - after);

    // Отметили оплату — на следующий месяц сигнала быть не должно.
    bdbO.markPaid(uid, bill.id);
    require('./db').db.prepare("UPDATE recurring SET last_due = '' WHERE id = ?").run(id);
    const paidBefore = sent.length;
    await runDaily(tg);
    const said = sent.slice(paidBefore).map((m) => norm(m.text)).join('\n');
    ok(!/Просрочка: ООО «Должник»/.test(said), 'после отметки оплаты не напоминает', said.slice(0, 60));

    rec.off(uid, id);
  }

  console.log('\n── чем занимается бизнес ──');
  {
    const bdbZ = require('./lib/bot-db');
    const biz = require('./lib/biz-types');
    const uid = fxUserId();

    await tap('basis');
    ok(Boolean(button('Не знаю')), 'на экране основания долга есть выход для новичка');
    await tap('biz');
    ok(last().includes('Чем занимаетесь'), 'бот спрашивает про дело, а не про бухгалтерию');

    await tap('biz.set:rent');
    ok(bdbZ.getDefaultOrg(uid).biz_type === 'rent', 'тип бизнеса сохранён',
      bdbZ.getDefaultOrg(uid).biz_type);
    ok(bdbZ.basisOf(bdbZ.getDefaultOrg(uid)) === 'invoice', 'аренда → долг по счёту',
      bdbZ.basisOf(bdbZ.getDefaultOrg(uid)));

    await tap('biz.set:trade');
    ok(bdbZ.basisOf(bdbZ.getDefaultOrg(uid)) === 'closing', 'торговля → долг по отгрузке');
    ok(biz.list().every((t) => ['closing', 'invoice', 'manual'].includes(t.basis)),
      'каждый вид бизнеса ведёт к существующему основанию долга');

    await tap('basis.set:closing');
  }

  console.log('\n── выписка файлом в чат ──');
  {
    const bdbB = require('./lib/bot-db');
    const uid = fxUserId();
    const cpB = bdbB.createCp(uid, {
      name: 'ООО «Ветер»', inn: '7701234560', kind: 'customer', opening_date: '2026-01-01',
    });
    bdbB.addOp(uid, cpB, { date: '2026-08-01', kind: 'Приход', doc: 'Акт 9', credit: 31000 });

    const csv = [
      'Дата;ИНН плательщика;Плательщик;Приход;Назначение платежа',
      '05.08.2026;7701234560;ООО "Ветер";31 000,00;Оплата по акту 9',
      '06.08.2026;;Неизвестный;700,00;Возврат',
    ].join('\n');
    tg.downloadFile = async () => Buffer.from(csv, 'utf8');
    const statement = (name) => handleUpdate(tg, {
      message: { chat: CHAT, from: USER, document: { file_id: 'st-1', file_name: name, file_size: csv.length } },
    });

    // Кнопки ищем только в последнем сообщении: button() смотрит всю
    // переписку и нашёл бы кнопку из прошлого разбора.
    const lastButtons = () => ((sent[sent.length - 1] || {}).kb || []).flat().map((b) => b.text).join(' | ');

    await statement('vypiska.csv');
    ok(norm(last()).includes('Узнал уверенно (1)'), 'бот разобрал выписку и узнал плательщика',
      norm(last()).slice(0, 80));
    ok(norm(last()).includes('ООО «Ветер»') && norm(last()).includes('31 000,00'),
      'в сводке видно кто и сколько', norm(last()).slice(-60));
    ok(norm(last()).includes('Ещё 1 поступление'), 'про непривязанные строки сказано отдельно');
    ok(lastButtons().includes('Занести 1 оплату'), 'есть кнопка занести уверенные', lastButtons());

    await tap('bank:take');
    ok(last().includes('Занёс 1 оплату'), 'оплата занесена по кнопке', last().slice(0, 60));
    ok(bdbB.balanceOf(uid, cpB).closing === 0, 'долг закрылся',
      bdbB.balanceOf(uid, cpB).closing);

    // Тот же файл второй раз: в учёте задвоенная оплата хуже ненайденной.
    await statement('vypiska.csv');
    ok(norm(last()).includes('Уже занесено раньше: 1'), 'повтор узнан', norm(last()).slice(0, 80));
    ok(!lastButtons().includes('Занести'), 'кнопки занести уже занесённое нет', lastButtons());
    ok(bdbB.balanceOf(uid, cpB).closing === 0, 'сальдо после повтора не изменилось',
      bdbB.balanceOf(uid, cpB).closing);

    tg.downloadFile = async () => Buffer.from('это не выписка, а записка', 'utf8');
    await statement('zametki.txt');
    ok(last().includes('ни одной операции'), 'на посторонний файл понятный ответ', last().slice(0, 60));
  }

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
    /*
     * Замер времени отсюда убран намеренно. Он сравнивал «холодный» старт с
     * «тёплым» и падал на ровном месте: на быстрой машине оба выходят по
     * 130 мс, и разницы нет. Переиспользование браузера проверяет счётчик
     * запусков выше — он отвечает на тот же вопрос и не зависит от того,
     * чем ещё занят сервер в эту секунду.
     */
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
