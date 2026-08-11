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
  ok(files.length === 2, 'акт об оказании услуг сформирован', (files[1] || {}).filename);

  await tap(`d.sch:${cpId}`);
  await say('Канапе ассорти; 20; 650');
  await say('Брускетты ассорти; 15; 780');
  await tap('items.done');
  ok(files.length === 3, 'счёт на оплату сформирован', (files[2] || {}).filename);

  await tap(`d.pp:${cpId}`);
  await say('26496,42');
  await say('Оплата по счёту № 1 от 10.08.2026');
  ok(files.length === 4, 'платёжное поручение сформировано', (files[3] || {}).filename);

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
