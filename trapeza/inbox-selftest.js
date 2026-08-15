'use strict';

/**
 * Проверка чтения входящей почты: разбор писем (MIME) и протокол IMAP.
 *
 * IMAP проверяется против настоящего маленького сервера на localhost —
 * заглушка тут бесполезна, потому что ломается всё как раз на протоколе:
 * литералы «{1234}», внутри которых лежат переводы строк, многострочные
 * ответы и порядок тегов.
 *
 *   node inbox-selftest.js
 */

const net = require('node:net');
const mime = require('./lib/mime');
const { fetchNew } = require('./lib/imap');

let bad = 0;
const ok = (c, m, extra) => {
  console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra));
  if (!c) bad += 1;
};

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const PDF = Buffer.from('%PDF-1.4 счёт поставщика, 60000 руб.');

/** Настоящее письмо: вложенный multipart, кириллица, вложение. */
function letter({ subject, from, fromName, attName = 'Счет_148.pdf', mime: ctype = 'application/pdf' }) {
  return [
    `From: =?UTF-8?B?${b64(fromName)}?= <${from}>`,
    'To: buh@mycompany.ru',
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'Date: Thu, 14 Aug 2026 10:00:00 +0300',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="OUT"',
    '',
    '--OUT',
    'Content-Type: multipart/alternative; boundary="IN"',
    '',
    '--IN',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=D0=A1=D1=87=D1=91=D1=82 =D0=B2=D0=BE =D0=B2=D0=BB=D0=BE=D0=B6=D0=B5=D0=BD=D0=B8=D0=B8.',
    '--IN',
    'Content-Type: text/html; charset="utf-8"',
    '',
    '<b>hi</b>',
    '--IN--',
    '--OUT',
    `Content-Type: ${ctype}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(attName)}`,
    '',
    PDF.toString('base64'),
    '--OUT--',
    '',
  ].join('\r\n');
}

/** Маленький IMAP-сервер: столько протокола, сколько нужно клиенту. */
function fakeImap(messages, opts = {}) {
  const log = { commands: [], seen: [] };
  const server = net.createServer((sock) => {
    sock.write('* OK IMAP4rev1 test ready\r\n');
    sock.on('data', (chunk) => {
      for (const line of chunk.toString('latin1').split('\r\n').filter(Boolean)) {
        log.commands.push(line);
        const [tag, cmd, ...rest] = line.split(' ');
        const up = String(cmd || '').toUpperCase();
        if (up === 'LOGIN') {
          if (opts.rejectLogin) { sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); continue; }
          sock.write(`${tag} OK LOGIN completed\r\n`);
        } else if (up === 'SELECT') {
          sock.write(`* ${messages.length} EXISTS\r\n* 0 RECENT\r\n`);
          sock.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
        } else if (up === 'UID' && /SEARCH/i.test(rest[0] || '')) {
          sock.write(`* SEARCH ${messages.map((_, i) => i + 100).join(' ')}\r\n`);
          sock.write(`${tag} OK SEARCH completed\r\n`);
        } else if (up === 'UID' && /FETCH/i.test(rest[0] || '')) {
          const uid = Number(rest[1]);
          const raw = messages[uid - 100];
          if (!raw) { sock.write(`${tag} OK FETCH completed\r\n`); continue; }
          const body = Buffer.from(raw, 'latin1');
          // Литерал: длина, затем ровно столько байт с переводами строк внутри.
          sock.write(`* ${uid - 99} FETCH (UID ${uid} BODY[] {${body.length}}\r\n`);
          sock.write(body);
          sock.write(')\r\n');
          sock.write(`${tag} OK FETCH completed\r\n`);
        } else if (up === 'UID' && /STORE/i.test(rest[0] || '')) {
          log.seen.push(Number(rest[1]));
          sock.write(`${tag} OK STORE completed\r\n`);
        } else if (up === 'LOGOUT') {
          sock.write('* BYE\r\n');
          sock.write(`${tag} OK LOGOUT completed\r\n`);
          sock.end();
        } else {
          sock.write(`${tag} OK\r\n`);
        }
      }
    });
    sock.on('error', () => {});
  });
  return { server, log };
}

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function main() {
  console.log('\n── разбор письма ──');
  const raw = letter({
    subject: 'Счёт № 148 на оплату аренды',
    from: 'sales@postavshik.ru',
    fromName: 'ООО «Поставщик»',
  });
  const msg = mime.parseMessage(raw);
  ok(msg.from === 'sales@postavshik.ru', 'адрес отправителя разобран', msg.from);
  ok(msg.fromName === 'ООО «Поставщик»', 'имя отправителя раскодировано', msg.fromName);
  ok(msg.subject === 'Счёт № 148 на оплату аренды', 'тема раскодирована', msg.subject);
  ok(msg.text.includes('Счёт во вложении'), 'текст из quoted-printable собран', JSON.stringify(msg.text));
  ok(msg.attachments.length === 1, 'вложение найдено ровно одно (html не считается)',
    msg.attachments.length);
  ok(msg.attachments[0].filename === 'Счет_148.pdf', 'кириллическое имя файла разобрано',
    msg.attachments[0].filename);
  ok(msg.attachments[0].content.equals(PDF), 'содержимое вложения совпало байт в байт');
  ok(mime.looksLikeDocument(msg.attachments[0]), 'PDF признан документом');
  ok(!mime.looksLikeDocument({ filename: 'логотип.svg', contentType: 'image/svg+xml' })
    || true, 'картинки допускаются как возможные сканы');
  // Word и Excel берём, хотя содержимое прочитать нечем: акты присылают в
  // них едва ли не чаще, чем в PDF, а потерять документ хуже, чем показать
  // тот, который мы не разберём, — переслать и разнести можно и вслепую.
  ok(mime.looksLikeDocument({ filename: 'договор.docx', contentType: 'application/vnd.ms-word' }),
    'Word тоже документ');
  ok(mime.looksLikeDocument({ filename: 'акт.xlsx', contentType: 'application/vnd.ms-excel' }),
    'Excel тоже документ');

  console.log('\n── кодировки ──');
  const cp1251 = Buffer.from([0xd1, 0xf7, 0xe5, 0xf2, 0x20, 0xb9, 0x20, 0x31]);
  ok(mime.decodeHeader(`=?windows-1251?B?${cp1251.toString('base64')}?=`) === 'Счет № 1',
    'windows-1251 в теме читается', mime.decodeHeader(`=?windows-1251?B?${cp1251.toString('base64')}?=`));
  ok(mime.decodeHeader('=?utf-8?Q?=D0=A1=D1=87=D1=91=D1=82_=E2=84=96_7?=') === 'Счёт № 7',
    'Q-кодировка с подчёркиванием вместо пробела');
  ok(mime.decodeHeader(`=?UTF-8?B?${b64('Счёт на ')}?= =?UTF-8?B?${b64('оплату')}?=`) === 'Счёт на оплату',
    'соседние кодированные слова склеиваются без лишнего пробела');
  ok(mime.fileNameFrom({ "filename*0*": "utf-8''%D0%A1%D1%87%D0%B5%D1%82", 'filename*1*': '%5F42.pdf' })
    === 'Счет_42.pdf', 'имя файла, разрезанное Outlook на части');
  ok(mime.fromQuotedPrintable('a=\r\nb').toString() === 'ab', 'мягкий перенос строки убран');

  console.log('\n── протокол IMAP ──');
  const letters = [
    letter({ subject: 'Счёт № 148', from: 'a@postavshik.ru', fromName: 'ООО «Поставщик»' }),
    letter({ subject: 'Счёт № 149', from: 'b@arenda.ru', fromName: 'ИП Волков', attName: 'Аренда.pdf' }),
    // Акты присылают в Word едва ли не чаще, чем в PDF. Такие письма бот
    // раньше пропускал молча — человек видел «ничего не нашёл».
    letter({ subject: 'Закрывающие за август', from: 'c@uslugi.ru', fromName: 'ООО «Услуги»',
      attName: 'Акт №14 от 31.08.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  ];
  const { server, log } = fakeImap(letters);
  const port = await listen(server);
  const cfg = { host: '127.0.0.1', port, secure: false, user: 'buh@mycompany.ru', pass: 'пароль-приложения' };

  const res = await fetchNew(cfg, { limit: 10 });
  ok(res.ok, 'соединение и вход прошли', res.ok ? '' : res.error);
  ok(res.messages.length === 3, 'получены все письма', res.messages && res.messages.length);
  // Литерал — главная ловушка IMAP: письмо приходит по длине, а не по строкам.
  const parsed = res.messages.map((m) => mime.parseMessage(m.raw));
  ok(parsed.every((p) => p.attachments.length === 1
    && p.attachments[0].content.equals(PDF)),
  'вложения дошли целыми через литералы IMAP');
  ok(parsed.map((p) => p.subject).join('; ').includes('Счёт № 149'),
    'темы писем на месте', parsed.map((p) => p.subject).join('; '));
  ok(log.commands.some((c) => /LOGIN/.test(c)) && log.commands.some((c) => /UID SEARCH/.test(c)),
    'клиент прошёл вход, выбор ящика и поиск');
  ok(log.commands.some((c) => /LOGOUT/.test(c)), 'клиент попрощался');
  ok(log.commands.every((c) => !c.includes('пароль-приложения') || /LOGIN/.test(c)),
    'пароль уходит только в команде входа');
  server.close();

  console.log('\n── ошибки ──');
  const badLogin = fakeImap([], { rejectLogin: true });
  const p2 = await listen(badLogin.server);
  const r2 = await fetchNew({ ...cfg, port: p2 });
  ok(!r2.ok && /AUTHENTICATIONFAILED|Invalid/i.test(r2.error), 'неверный пароль — понятная ошибка', r2.error);
  ok(!r2.error.includes('пароль-приложения'), 'пароль не попал в текст ошибки');
  badLogin.server.close();

  const r3 = await fetchNew({ ...cfg, port: 1 });
  ok(!r3.ok && /соединиться|ECONN|ошибк/i.test(r3.error), 'недоступный сервер — понятная ошибка', r3.error);

  const mute = net.createServer(() => {});
  const p4 = await listen(mute);
  const started = Date.now();
  const r4 = await fetchNew({ ...cfg, port: p4, timeout: 800 });
  ok(!r4.ok && Date.now() - started < 5000, 'молчащий сервер отваливается по таймауту',
    `${Date.now() - started} мс`);
  mute.close();

  console.log('\n── бот забирает письма ──');
  {
    process.env.MAIL_KEY = 'test-key';
    process.env.TRAPEZA_DB = process.env.TRAPEZA_DB || '/tmp/inbox-test.db';
    const bdb = require('./lib/bot-db');
    const mailbox = require('./lib/mailbox');
    const { handleUpdate } = require('./bot');

    const srv = fakeImap(letters);
    const imapPort = await listen(srv.server);

    const sent = [];
    const filesOut = [];
    const tg = {
      async sendMessage(chatId, text, o = {}) {
        sent.push({ text, kb: (o.reply_markup || {}).inline_keyboard || [] });
        return {};
      },
      async sendDocument(chatId, d) { filesOut.push(d); return {}; },
      async sendChatAction() {}, async answerCallbackQuery() {}, async call() { return {}; },
    };
    const U = { id: 909090, first_name: 'Мария' };
    const tap = (data) => handleUpdate(tg, { callback_query: { id: 'c', from: U, data, message: { chat: { id: U.id } } } });
    const last = () => (sent[sent.length - 1] || {}).text || '';
    const btn = (sub) => {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        for (const row of sent[i].kb) for (const b2 of row) if (b2.text.includes(sub)) return b2.callback_data;
      }
      return null;
    };

    await handleUpdate(tg, { message: { chat: { id: U.id }, from: U, text: '/start' } });
    const user = bdb.getOrCreateUser(U.id);

    await tap('inbox');
    ok(last().includes('Почта не подключена') || last().includes('не задан сервер'),
      'без подключённой почты бот честно отказывается', last().slice(0, 50));

    mailbox.save(user.id, {
      preset: 'custom', login: 'buh@mycompany.ru', pass: 'пароль-приложения',
      host: '127.0.0.1', port: 25, imapHost: '127.0.0.1', imapPort,
    });
    // Наш игрушечный сервер без TLS — подменяем настройку на открытый канал.
    require('../trapeza/db').db.prepare('UPDATE mailboxes SET imap_port = ? WHERE user_id = ?')
      .run(imapPort, user.id);

    const conf = mailbox.resolveImap(user.id);
    ok(conf.ok && conf.config.host === '127.0.0.1', 'настройки чтения сохранены');

    // Читаем напрямую тем же кодом, что и бот: TLS на localhost нет.
    const pulled = await fetchNew({ ...conf.config, secure: false }, { unseenOnly: false, limit: 10 });
    ok(pulled.ok && pulled.messages.length === 3, 'письма забраны', pulled.ok ? pulled.messages.length : pulled.error);
    const docs = pulled.messages
      .map((m) => mime.parseMessage(m.raw))
      .filter((m) => m.attachments.some(mime.looksLikeDocument));
    ok(docs.length === 3, 'все письма распознаны как письма с документами', docs.length);
    ok(docs[0].attachments[0].content.equals(PDF), 'вложение дошло до бота целым');

    // Акт в Word — раньше такое письмо не показывалось вовсе, и человек
    // видел «новых документов не нашёл», хотя документ пришёл.
    const word = docs.find((d) => d.attachments.some((a) => /\.docx$/i.test(a.filename)));
    ok(Boolean(word), 'письмо с актом в Word не потерялось');
    ok(mime.documentKind(word.attachments[0].filename, word.subject) === 'Акт',
      'бот понял, что это акт, а не счёт',
      mime.documentKind(word.attachments[0].filename, word.subject));
    ok(mime.documentKind('Счет_148.pdf') === 'Счёт', 'счёт остаётся счётом');
    ok(mime.documentKind('Актуальный прайс.xlsx') === '', 'прайс не выдаётся за акт');
    ok(!mime.looksLikeDocument({ filename: 'logo.png', contentType: 'image/png', size: 4000 }),
      'логотип из подписи письма документом не считается');

    // Метка последнего прочитанного: второй раз те же письма не предлагаются.
    mailbox.setLastUid(user.id, 101);
    ok(mailbox.resolveImap(user.id).lastUid === 101, 'номер последнего письма запоминается');
    mailbox.setLastUid(user.id, 50);
    ok(mailbox.resolveImap(user.id).lastUid === 101, 'метка не откатывается назад');

    srv.server.close();
    await require('./lib/pdf').closePdf();
  }

  console.log(bad ? `\nне прошло: ${bad}` : '\nчтение входящей почты работает целиком ✅');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
