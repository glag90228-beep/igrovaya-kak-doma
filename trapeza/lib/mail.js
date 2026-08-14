'use strict';

/**
 * Отправка почты: свой минимальный SMTP-клиент.
 *
 * Зачем свой. В проекте нет сторонних библиотек — ни для Telegram, ни для
 * QR-кода, — и почта не повод их заводить: нам нужно ровно одно письмо с
 * одним вложением, а это полторы страницы протокола, описанного в RFC 5321.
 * Взамен получаем понятные ошибки («сервер не принял пароль») вместо стека
 * чужой библиотеки и ноль обновлений безопасности в зависимостях.
 *
 * Что здесь сделано и почему именно так:
 *
 *   • Кириллица. Тема письма и имя файла обязаны быть закодированы: в
 *     заголовки нельзя класть байты выше ASCII. Тема — по RFC 2047
 *     (=?UTF-8?B?…?=), имя вложения — по RFC 2231 (filename*=UTF-8''…),
 *     иначе у получателя будет «=?utf-8?B?0J...» или «Ð¡Ñ‡ÐµÑ‚.pdf».
 *   • Тело и вложение — base64 строками по 76 символов. Так письмо
 *     переживёт любой почтовый сервер, не разбираясь в 8BITMIME.
 *   • Точка в начале строки удваивается: одинокая точка завершает данные,
 *     и без этого письмо можно оборвать содержимым (RFC 5321, 4.5.2).
 *   • Пароль в сообщениях об ошибке не появляется никогда.
 *
 * Настройки — из окружения:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_FROM_NAME
 *   SMTP_SECURE=1 — сразу TLS (порт 465); иначе STARTTLS (587).
 */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const CRLF = '\r\n';

function cfg() {
  const port = Number(process.env.SMTP_PORT || 0);
  return {
    host: String(process.env.SMTP_HOST || '').trim(),
    port: port || (String(process.env.SMTP_SECURE || '') === '1' ? 465 : 587),
    user: String(process.env.SMTP_USER || '').trim(),
    pass: String(process.env.SMTP_PASS || ''),
    from: String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim(),
    fromName: String(process.env.SMTP_FROM_NAME || '').trim(),
    secure: String(process.env.SMTP_SECURE || '') === '1' || port === 465,
    timeout: Number(process.env.SMTP_TIMEOUT || 20000),
  };
}

function mailAvailable() {
  const c = cfg();
  return Boolean(c.host && c.from);
}

function mailHint() {
  const c = cfg();
  if (!c.host) return 'Не задан SMTP_HOST — отправка почты выключена.';
  if (!c.from) return 'Не задан SMTP_FROM — не с какого адреса отправлять.';
  return `Отправка через ${c.host}:${c.port} от ${c.from}`;
}

// ---------- кодирование ----------

/** Разбивает base64 на строки по 76 символов, как требует MIME. */
const wrap76 = (s) => (s.match(/.{1,76}/g) || []).join(CRLF);

/**
 * Заголовок с кириллицей — по RFC 2047. Чистый ASCII оставляем как есть:
 * так письмо читаемее в исходнике и меньше шансов на чужую ошибку разбора.
 */
function encodeHeader(text) {
  const s = String(text == null ? '' : text);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;

  // RFC 2047 ограничивает кодированное слово 75 символами ВМЕСТЕ с обёрткой
  // «=?UTF-8?B?…?=» (12 символов). Считать надо байты, а не буквы: кириллица
  // занимает по два, и резать по символам — верный способ получить слишком
  // длинную строку. 36 байт → 48 символов base64 → 60 всего, и остаётся
  // место под «Subject: » в начале первой строки.
  const words = [];
  let chunk = '';
  for (const ch of s) {                    // по символам, а не по байтам:
    if (Buffer.byteLength(chunk + ch, 'utf8') > 36) { words.push(chunk); chunk = ''; }
    chunk += ch;                           // буква не должна разорваться
  }
  if (chunk) words.push(chunk);

  return words
    .map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`)
    .join(`${CRLF} `);
}

/** Имя файла с кириллицей — по RFC 2231. */
function encodeFilename(name) {
  const s = String(name || 'file');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s) && !/["\\]/.test(s)) return `filename="${s}"`;
  return `filename*=UTF-8''${encodeURIComponent(s)}`;
}

/** Адрес с именем: «Иван <i@mail.ru>»; имя кодируем, адрес — нет. */
function addr(email, name) {
  return name ? `${encodeHeader(name)} <${email}>` : email;
}

const RE_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-zA-Z\u0430-\u044f]{2,}$/u;

/** Проверка адреса: строгая ровно настолько, чтобы отсечь опечатки. */
function validEmail(v) {
  const s = String(v == null ? '' : v).trim();
  return s.length <= 254 && RE_EMAIL.test(s);
}

/**
 * Собирает письмо целиком (RFC 5322 + MIME).
 * @returns {string} текст письма без завершающей точки
 */
function buildMessage({
  from, fromName, to, subject, text, html, attachments = [], replyTo,
}) {
  const boundary = `--=_${crypto.randomBytes(12).toString('hex')}`;
  const altBoundary = `--=_alt_${crypto.randomBytes(8).toString('hex')}`;
  const hasFiles = attachments.length > 0;

  const head = [
    `From: ${addr(from, fromName)}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${String(from).split('@')[1] || 'localhost'}>`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  const b64 = (s) => wrap76(Buffer.from(String(s), 'utf8').toString('base64'));

  const textPart = [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text || ''),
  ].join(CRLF);

  const htmlPart = html ? [
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
  ].join(CRLF) : null;

  // Тело: либо один текст, либо text+html в alternative.
  const bodyPart = htmlPart
    ? [
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`, textPart,
      `--${altBoundary}`, htmlPart,
      `--${altBoundary}--`,
    ].join(CRLF)
    : textPart;

  if (!hasFiles) return `${head.join(CRLF)}${CRLF}${bodyPart}${CRLF}`;

  const files = attachments.map((a) => [
    `Content-Type: ${a.contentType || 'application/octet-stream'}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; ${encodeFilename(a.filename)}`,
    '',
    wrap76(Buffer.from(a.content).toString('base64')),
  ].join(CRLF));

  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`, bodyPart,
    ...files.flatMap((f) => [`--${boundary}`, f]),
    `--${boundary}--`,
    '',
  ].join(CRLF);
}

/** Точка в начале строки удваивается — иначе она оборвёт передачу данных. */
const dotStuff = (s) => s.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');

// ---------- разговор с сервером ----------

/**
 * Обёртка над сокетом: команда → ожидаемый код ответа.
 * Многострочные ответы («250-PIPELINING») дочитываются до строки «250 ».
 */
function conversation(socket, timeout) {
  let buf = '';
  let pending = null;

  /** Ответ дочитан, когда последняя завершённая строка вида «250 текст». */
  const flush = () => {
    if (!pending || !buf.endsWith(CRLF)) return;
    const lines = buf.split(CRLF);
    const last = lines[lines.length - 2];
    if (!last || !/^\d{3} /.test(last)) return;   // ещё многострочный ответ
    const text = buf;
    buf = '';
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.resolve({ code: Number(last.slice(0, 3)), text });
  };

  const fail = (e) => {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.reject(e);
  };

  const onData = (chunk) => { buf += chunk; flush(); };
  const onError = (e) => fail(e);
  const onClose = () => fail(new Error('сервер закрыл соединение'));

  socket.setEncoding('utf8');
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  const read = () => new Promise((resolve, reject) => {
    pending = {
      resolve,
      reject,
      timer: setTimeout(() => fail(new Error('почтовый сервер не отвечает')), timeout),
    };
    flush();                          // вдруг ответ уже целиком в буфере
  });

  /** @param expect ожидаемый код; при другом — понятная ошибка */
  const say = async (line, expect) => {
    if (line !== null) socket.write(line + CRLF);
    const res = await read();
    if (expect && res.code !== expect) {
      const clean = res.text.trim().split(CRLF)[0];
      const err = new Error(`SMTP ${res.code}: ${clean}`);
      err.code = res.code;
      throw err;
    }
    return res;
  };

  const detach = () => {
    socket.off('data', onData);
    socket.off('error', onError);
    socket.off('close', onClose);
  };

  return { say, read, detach };
}

function connect({ host, port, secure, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    const fail = (e) => { socket.destroy(); reject(e); };
    socket.setTimeout(timeout, () => fail(new Error('превышено время ожидания сервера')));
    socket.once('error', fail);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.setTimeout(0);
      socket.off('error', fail);
      resolve(socket);
    });
  });
}

/**
 * Отправляет письмо.
 *
 * @param {{to:string|string[], subject:string, text?:string, html?:string,
 *          attachments?:Array<{filename:string, content:Buffer, contentType?:string}>,
 *          replyTo?:string}} letter
 * @returns {Promise<{ok:true, id:string}|{ok:false, error:string}>}
 */
async function sendMail(letter, options = {}) {
  const c = { ...cfg(), ...options };
  if (!c.host) return { ok: false, error: 'Отправка почты не настроена (SMTP_HOST).' };
  if (!c.from) return { ok: false, error: 'Не задан адрес отправителя (SMTP_FROM).' };

  const rcpts = (Array.isArray(letter.to) ? letter.to : [letter.to]).map((x) => String(x).trim());
  const bad = rcpts.find((x) => !validEmail(x));
  if (bad) return { ok: false, error: `Неправильный адрес: ${bad}` };

  let socket;
  try {
    socket = await connect(c);
  } catch (e) {
    return { ok: false, error: `Не соединиться с ${c.host}:${c.port} — ${e.message}` };
  }

  let talk = conversation(socket, c.timeout);
  const ehloName = (c.from.split('@')[1] || 'localhost');

  try {
    await talk.say(null, 220);
    let hello = await talk.say(`EHLO ${ehloName}`, 250);

    if (!c.secure) {
      // Пароль в открытом канале уходить не должен. Исключение — петля
      // localhost: там трафик наружу не выходит, и на ней гоняются прогоны.
      const loopback = ['127.0.0.1', '::1', 'localhost'].includes(c.host);
      const mayGoPlain = c.allowPlain === true || loopback;
      if (!/STARTTLS/i.test(hello.text) && !mayGoPlain) {
        throw new Error('сервер не предлагает STARTTLS — отправлять пароль в открытом виде нельзя');
      }
      if (/STARTTLS/i.test(hello.text)) {
        await talk.say('STARTTLS', 220);
        talk.detach();
        socket = await new Promise((resolve, reject) => {
          const s = tls.connect({ socket, servername: c.host }, () => resolve(s));
          s.once('error', reject);
        });
        talk = conversation(socket, c.timeout);
        // Всё, что сервер объявил до шифрования, доверия не заслуживает —
        // список возможностей читаем заново уже по защищённому каналу.
        hello = await talk.say(`EHLO ${ehloName}`, 250);
      }
    }

    if (c.user) {
      if (/AUTH[^\r\n]*\bPLAIN\b/i.test(hello.text)) {
        const token = Buffer.from(`\0${c.user}\0${c.pass}`, 'utf8').toString('base64');
        await talk.say(`AUTH PLAIN ${token}`, 235);
      } else if (/AUTH[^\r\n]*\bLOGIN\b/i.test(hello.text)) {
        await talk.say('AUTH LOGIN', 334);
        await talk.say(Buffer.from(c.user, 'utf8').toString('base64'), 334);
        await talk.say(Buffer.from(c.pass, 'utf8').toString('base64'), 235);
      } else {
        throw new Error('сервер не поддерживает вход по паролю (AUTH PLAIN/LOGIN)');
      }
    }

    await talk.say(`MAIL FROM:<${c.from}>`, 250);
    for (const to of rcpts) {
      // eslint-disable-next-line no-await-in-loop
      await talk.say(`RCPT TO:<${to}>`, 250);
    }
    await talk.say('DATA', 354);

    const message = buildMessage({
      from: c.from, fromName: c.fromName, to: rcpts, ...letter,
    });
    socket.write(dotStuff(message));
    if (!message.endsWith(CRLF)) socket.write(CRLF);
    const done = await talk.say('.', 250);

    try { await talk.say('QUIT'); } catch (_) { /* прощание не критично */ }
    socket.end();
    return { ok: true, id: (/\b(\S+@\S+|queued as \S+|ok[:= ]\S+)/i.exec(done.text) || [])[1] || 'отправлено' };
  } catch (e) {
    socket.destroy();
    // Пароль в текст ошибки попасть не должен ни при каких обстоятельствах.
    const safe = String(e.message).split(c.pass || '\u0000').join('***');
    return { ok: false, error: safe };
  }
}

module.exports = {
  sendMail, buildMessage, mailAvailable, mailHint, validEmail,
  encodeHeader, encodeFilename, dotStuff, cfg,
};
