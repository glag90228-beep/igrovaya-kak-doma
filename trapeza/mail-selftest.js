'use strict';

/**
 * Проверка отправки почты.
 *
 * Поднимаем настоящий SMTP-сервер на localhost и разговариваем с ним по
 * протоколу — так проверяется то, что реально уходит в сеть: коды ответов,
 * кодирование кириллицы в заголовках, вложение, экранирование точки.
 * Заглушка вместо сервера здесь бесполезна: ошибаются как раз эти детали.
 *
 *   node mail-selftest.js
 */

require('./selftest-db');   // своя база на прогон — до всего, что тянет db.js
const net = require('node:net');
const mail = require('./lib/mail');

let bad = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg + (cond || extra === undefined ? '' : ' → ' + extra));
  if (!cond) bad += 1;
};

/**
 * Маленький SMTP-сервер: говорит ровно столько, сколько нужно клиенту,
 * и запоминает всё, что получил.
 */
function fakeSmtp(opts = {}) {
  const log = { commands: [], data: '', auth: null, from: null, rcpt: [] };
  const server = net.createServer((sock) => {
    let inData = false;
    let body = '';
    let expect = null;                      // ожидаем логин/пароль в base64

    sock.setEncoding('utf8');
    sock.write('220 test.local ESMTP\r\n');

    sock.on('data', (chunk) => {
      if (inData) {
        body += chunk;
        const end = body.indexOf('\r\n.\r\n');
        if (end === -1) return;
        log.data = body.slice(0, end);
        inData = false;
        body = '';
        sock.write('250 2.0.0 Ok: queued as ABC123\r\n');
        return;
      }
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        log.commands.push(line);
        if (expect) {
          const value = Buffer.from(line, 'base64').toString('utf8');
          if (expect === 'user') { log.auth = { user: value }; expect = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); } else {
            log.auth.pass = value;
            expect = null;
            sock.write(opts.rejectAuth ? '535 5.7.8 Bad credentials\r\n' : '235 2.7.0 Accepted\r\n');
          }
          continue;
        }
        if (/^EHLO/i.test(line)) {
          // Многострочный ответ — клиент обязан дочитать его до конца.
          sock.write('250-test.local greets you\r\n250-SIZE 35882577\r\n250-8BITMIME\r\n');
          sock.write(`250-AUTH ${opts.authMech || 'LOGIN PLAIN'}\r\n250 HELP\r\n`);
        } else if (/^AUTH PLAIN /i.test(line)) {
          const raw = Buffer.from(line.slice(11).trim(), 'base64').toString('utf8').split('\0');
          log.auth = { user: raw[1], pass: raw[2] };
          sock.write(opts.rejectAuth ? '535 5.7.8 Bad credentials\r\n' : '235 2.7.0 Accepted\r\n');
        } else if (/^AUTH LOGIN/i.test(line)) {
          expect = 'user';
          sock.write('334 VXNlcm5hbWU6\r\n');
        } else if (/^MAIL FROM:/i.test(line)) {
          log.from = line.slice(10).replace(/[<>]/g, '').trim();
          sock.write('250 2.1.0 Ok\r\n');
        } else if (/^RCPT TO:/i.test(line)) {
          const who = line.slice(8).replace(/[<>]/g, '').trim();
          log.rcpt.push(who);
          sock.write(opts.rejectRcpt ? '550 5.1.1 No such user\r\n' : '250 2.1.5 Ok\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT/i.test(line)) {
          sock.write('221 2.0.0 Bye\r\n');
          sock.end();
        } else {
          sock.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    sock.on('error', () => {});
  });
  return { server, log };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

/** Достаёт из письма значение заголовка (с учётом переноса на след. строку). */
function header(message, name) {
  const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*)`, 'mi');
  const m = re.exec(message);
  return m ? m[1] : '';
}

async function main() {
  console.log('\n── кодирование заголовков ──');
  ok(mail.encodeHeader('Invoice 12') === 'Invoice 12', 'латиница остаётся как есть');
  const subj = mail.encodeHeader('Счёт на оплату № 1');
  ok(subj.startsWith('=?UTF-8?B?') && !/[А-Яа-яЁё]/.test(subj), 'кириллица закодирована по RFC 2047', subj);
  ok(Buffer.from(subj.replace(/=\?UTF-8\?B\?|\?=/g, ''), 'base64').toString('utf8') === 'Счёт на оплату № 1',
    'закодированная тема разворачивается обратно');
  const longText = 'Очень длинная тема письма про счета акты и накладные для проверки переноса';
  const longSubj = mail.encodeHeader(longText);
  // Считаем целиком строку заголовка — вместе с «Subject: » в начале.
  const subjLines = `Subject: ${longSubj}`.split('\r\n');
  ok(subjLines.every((l) => l.length <= 76), 'длинная тема разбита на строки не длиннее 76 символов',
    Math.max(...subjLines.map((l) => l.length)));
  ok(longSubj.split('\r\n').every((l) => l.trim().length <= 75),
    'каждое кодированное слово укладывается в 75 символов по RFC 2047',
    Math.max(...longSubj.split('\r\n').map((l) => l.trim().length)));
  const back = longSubj.split('\r\n')
    .map((l) => Buffer.from(l.trim().replace(/=\?UTF-8\?B\?|\?=/g, ''), 'base64').toString('utf8'))
    .join('');
  ok(back === longText, 'длинная тема собирается обратно без потерь букв', back.slice(0, 40));

  ok(mail.encodeFilename('invoice.pdf') === 'filename="invoice.pdf"', 'латинское имя файла — как есть');
  const fn = mail.encodeFilename('Счет_1_ООО «Заря».pdf');
  ok(fn.startsWith("filename*=UTF-8''") && !/[А-Яа-яЁё]/.test(fn), 'кириллическое имя файла — по RFC 2231', fn);
  ok(decodeURIComponent(fn.replace("filename*=UTF-8''", '')) === 'Счет_1_ООО «Заря».pdf',
    'имя файла разворачивается обратно');

  console.log('\n── проверка адреса ──');
  ok(mail.validEmail('ivan@mail.ru'), 'обычный адрес принят');
  ok(mail.validEmail('a.b-c+d@sub.domain.co'), 'адрес с точками и плюсом принят');
  ok(!mail.validEmail('ivan@mail'), 'адрес без домена верхнего уровня отклонён');
  ok(!mail.validEmail('ivan mail.ru'), 'адрес без собаки отклонён');
  ok(!mail.validEmail(''), 'пустой адрес отклонён');
  ok(!mail.validEmail(`${'a'.repeat(250)}@mail.ru`), 'слишком длинный адрес отклонён');

  console.log('\n── экранирование точки ──');
  ok(mail.dotStuff('строка\r\n.точка\r\n') === 'строка\r\n..точка\r\n',
    'точка в начале строки удвоена — письмо не оборвётся');
  ok(mail.dotStuff('.начало') === '..начало', 'точка в самом начале тоже удвоена');

  console.log('\n── сборка письма ──');
  const msg = mail.buildMessage({
    from: 'bot@pervichka.ru', fromName: 'Первичка', to: ['client@mail.ru'],
    subject: 'Счёт № 1', text: 'Здравствуйте!\nВо вложении счёт.',
    attachments: [{ filename: 'Счет_1.pdf', content: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' }],
  });
  ok(/^From: =\?UTF-8\?B\?.+ <bot@pervichka\.ru>$/m.test(msg), 'имя отправителя закодировано, адрес — нет',
    header(msg, 'From'));
  ok(header(msg, 'To') === 'client@mail.ru', 'получатель на месте');
  ok(/multipart\/mixed; boundary="/.test(msg), 'письмо собрано как multipart/mixed');
  ok(msg.includes('Content-Disposition: attachment'), 'вложение помечено как вложение');
  ok(msg.includes('Content-Type: application/pdf'), 'тип вложения указан');
  ok(msg.includes(Buffer.from('%PDF-1.4 fake').toString('base64')), 'содержимое вложения закодировано base64');
  const bodyB64 = Buffer.from('Здравствуйте!\nВо вложении счёт.', 'utf8').toString('base64');
  ok(msg.includes(bodyB64), 'текст письма закодирован base64 — кириллица не поедет');
  ok(!/[А-Яа-яЁё]/.test(msg), 'в письме нет сырой кириллицы — только закодированная');
  const bLines = msg.split('\r\n').filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l));
  ok(bLines.every((l) => l.length <= 76), 'строки base64 не длиннее 76 символов',
    Math.max(0, ...bLines.map((l) => l.length)));

  const withHtml = mail.buildMessage({
    from: 'a@b.ru', to: 'c@d.ru', subject: 'Тест', text: 'текст', html: '<b>текст</b>',
  });
  ok(/multipart\/alternative/.test(withHtml), 'при наличии HTML собирается alternative');
  const plain = mail.buildMessage({ from: 'a@b.ru', to: 'c@d.ru', subject: 'Тест', text: 'текст' });
  ok(!/multipart/.test(plain), 'без вложений и HTML — простое письмо без multipart');

  console.log('\n── разговор с сервером ──');
  const { server, log } = fakeSmtp();
  const port = await listen(server);
  const opts = {
    host: '127.0.0.1', port, secure: false, user: 'bot@pervichka.ru', pass: 'сек-рет',
    from: 'bot@pervichka.ru', fromName: 'Первичка', timeout: 5000,
  };
  // STARTTLS наш сервер не предлагает — на localhost поднимать TLS ради
  // проверки протокола незачем, поэтому явно разрешаем открытый канал.
  let res = await mail.sendMail({
    to: 'client@mail.ru', subject: 'Счёт № 1 от ИП Сарычевой',
    text: 'Во вложении счёт.',
    attachments: [{ filename: 'Счет_1_ООО «Заря».pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }],
  }, { ...opts, allowPlain: true });

  ok(res.ok, 'письмо отправлено', res.ok ? res.id : res.error);
  ok(log.from === 'bot@pervichka.ru', 'MAIL FROM с нашим адресом', log.from);
  ok(log.rcpt.join() === 'client@mail.ru', 'RCPT TO с адресом получателя', log.rcpt.join());
  ok(log.auth && log.auth.user === 'bot@pervichka.ru' && log.auth.pass === 'сек-рет',
    'логин и пароль дошли верно, кириллица в пароле не сломалась', JSON.stringify(log.auth));
  ok(log.commands.some((c) => /^EHLO /.test(c)), 'клиент поздоровался EHLO');
  ok(log.commands.some((c) => c === 'QUIT'), 'клиент попрощался');
  ok(/Content-Disposition: attachment/.test(log.data), 'сервер получил вложение');
  ok(/^Subject: =\?UTF-8\?B\?/m.test(log.data), 'тема пришла закодированной');
  ok(!log.data.includes('сек-рет'), 'пароль не попал в тело письма');
  server.close();

  // Вторая ветка входа: сервер умеет только AUTH LOGIN (так делает mail.ru).
  const onlyLogin = fakeSmtp({ authMech: 'LOGIN' });
  const pLogin = await listen(onlyLogin.server);
  res = await mail.sendMail({ to: 'c@d.ru', subject: 'Тест', text: 'текст' },
    { ...opts, port: pLogin, allowPlain: true });
  ok(res.ok, 'вход по AUTH LOGIN тоже работает', res.ok ? '' : res.error);
  ok(onlyLogin.log.auth && onlyLogin.log.auth.pass === 'сек-рет',
    'пароль по AUTH LOGIN дошёл верно');
  ok(onlyLogin.log.commands.includes('AUTH LOGIN'), 'использована именно команда AUTH LOGIN');
  onlyLogin.server.close();

  console.log('\n── ошибки сервера ──');
  const rej = fakeSmtp({ rejectAuth: true });
  const p2 = await listen(rej.server);
  res = await mail.sendMail({ to: 'c@d.ru', subject: 'т', text: 'т' },
    { ...opts, port: p2, allowPlain: true });
  ok(!res.ok && /535/.test(res.error), 'неверный пароль — понятная ошибка', res.error);
  ok(!res.ok && !res.error.includes('сек-рет'), 'пароль не попал в текст ошибки');
  rej.server.close();

  const noUser = fakeSmtp({ rejectRcpt: true });
  const p3 = await listen(noUser.server);
  res = await mail.sendMail({ to: 'c@d.ru', subject: 'т', text: 'т' },
    { ...opts, port: p3, allowPlain: true });
  ok(!res.ok && /550/.test(res.error), 'несуществующий получатель — понятная ошибка', res.error);
  noUser.server.close();

  res = await mail.sendMail({ to: 'не-адрес', subject: 'т', text: 'т' }, { ...opts, allowPlain: true });
  ok(!res.ok && /Неправильный адрес/.test(res.error), 'кривой адрес отсекается до соединения', res.error);

  res = await mail.sendMail({ to: 'c@d.ru', subject: 'т', text: 'т' },
    { ...opts, host: '127.0.0.1', port: 1, allowPlain: true });
  ok(!res.ok && /соединиться/i.test(res.error), 'недоступный сервер — понятная ошибка', res.error);

  // Сервер молчит: клиент не должен зависнуть навсегда.
  const mute = net.createServer(() => {});
  const p4 = await listen(mute);
  const started = Date.now();
  res = await mail.sendMail({ to: 'c@d.ru', subject: 'т', text: 'т' },
    { ...opts, port: p4, timeout: 700, allowPlain: true });
  ok(!res.ok && Date.now() - started < 4000, 'молчащий сервер отваливается по таймауту, а не висит',
    `${Date.now() - started} мс, ${res.error}`);
  mute.close();

  console.log('\n── настройка ──');
  const keep = { ...process.env };
  delete process.env.SMTP_HOST;
  ok(!mail.mailAvailable(), 'без SMTP_HOST отправка считается ненастроенной');
  ok(/SMTP_HOST/.test(mail.mailHint()), 'подсказка объясняет, чего не хватает', mail.mailHint());
  process.env.SMTP_HOST = 'smtp.mail.ru';
  process.env.SMTP_FROM = 'bot@mail.ru';
  ok(mail.mailAvailable(), 'с настройками отправка доступна');
  ok(mail.cfg().port === 587, 'порт по умолчанию — 587 (STARTTLS)', mail.cfg().port);
  process.env.SMTP_SECURE = '1';
  ok(mail.cfg().port === 465 && mail.cfg().secure, 'SMTP_SECURE=1 переключает на 465', mail.cfg().port);
  Object.assign(process.env, keep);

  console.log('\n── Reply-To не пропускает чужие заголовки ──');
  {
    /*
     * Тема проходит через encodeHeader, получатели — через validEmail, и обе
     * проверки не пропускают перевод строки. Reply-To клался в письмо сырым:
     * значение «a@b.ru\r\nBcc: чужой@адрес» давало настоящий Bcc — скрытую
     * копию любого документа кому угодно.
     */
    const build = (replyTo) => mail.buildMessage({
      from: 'me@x.ru', fromName: 'Я', to: 'them@y.ru',
      subject: 'Счёт', text: 'тело', replyTo,
    });
    const evil = build('a@b.ru\r\nBcc: leak@evil.com');
    ok(!/^Bcc:/mi.test(evil), 'подставленный Bcc в письмо не попал');
    ok(!/Reply-To:/i.test(evil), 'и сам испорченный адрес отброшен целиком');
    ok(/Reply-To: otvet@x\.ru/.test(build('otvet@x.ru')),
      'а честный адрес по-прежнему проставляется');
  }

  console.log(bad ? `\nне прошло: ${bad}` : '\nотправка почты работает целиком ✅');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
