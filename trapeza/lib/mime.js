'use strict';

/**
 * Разбор почтового письма (RFC 5322 + MIME).
 *
 * Нужен, чтобы достать из входящего письма вложенный счёт. Библиотеки не
 * берём по той же причине, что и в остальном проекте, — но здесь есть и
 * вторая: русские письма приходят в трёх кодировках сразу, и важно самим
 * контролировать, что именно происходит с текстом.
 *
 * Что обязательно должно работать, иначе разбор бесполезен:
 *
 *   • Тема и имя файла в кодированных словах (=?UTF-8?B?…?= и =?…?Q?…?=).
 *     Половина российских отправителей шлёт windows-1251, а не UTF-8.
 *   • Имя файла, разрезанное на части по RFC 2231
 *     (filename*0*=…; filename*1*=…) — так делает Outlook.
 *   • Вложенные multipart: письмо с текстом, картинкой в подписи и
 *     счётом — это multipart/mixed внутри которого multipart/alternative.
 *   • quoted-printable с переносами «=\r\n» посреди слова.
 *
 * Всё это встречается в первом же десятке настоящих писем.
 */

/** Декодирование байтов с учётом кодировки; windows-1251 обязателен. */
function decodeText(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(cs).decode(buf);
  } catch (_) {
    try { return new TextDecoder('utf-8').decode(buf); } catch (__) { return buf.toString('latin1'); }
  }
}

/** quoted-printable → байты. */
function fromQuotedPrintable(text) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '=') { out.push(ch.charCodeAt(0) & 0xff); continue; }
    const next = s.slice(i + 1, i + 3);
    if (/^\r\n|^\n/.test(s.slice(i + 1))) {          // мягкий перенос строки
      i += s[i + 1] === '\r' ? 2 : 1;
      continue;
    }
    if (/^[0-9a-f]{2}$/i.test(next)) { out.push(parseInt(next, 16)); i += 2; continue; }
    out.push(0x3d);
  }
  return Buffer.from(out);
}

/**
 * Кодированные слова в заголовке: =?charset?B|Q?data?=
 * Соседние слова склеиваются без пробела — так требует RFC 2047,
 * иначе длинная тема развалится на куски с лишними пробелами.
 */
function decodeHeader(value) {
  const s = String(value == null ? '' : value);
  const re = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s*)/g;
  let out = '';
  let last = 0;
  let prevWasWord = false;
  let m = re.exec(s);
  while (m) {
    const before = s.slice(last, m.index);
    if (before) { out += before; prevWasWord = false; }
    const raw = m[2].toUpperCase() === 'B'
      ? Buffer.from(m[3], 'base64')
      : fromQuotedPrintable(m[3].replace(/_/g, ' '));
    out += decodeText(raw, m[1]);
    // Пробел между двумя кодированными словами — разделитель, а не текст.
    const gap = m[4] || '';
    last = m.index + m[0].length;
    const nextIsWord = /^=\?/.test(s.slice(last));
    if (gap && !(prevWasWord && nextIsWord) && !nextIsWord) out += gap;
    prevWasWord = true;
    m = re.exec(s);
  }
  out += s.slice(last);
  return out;
}

/** Разбирает блок заголовков; развёрнутые на несколько строк — склеивает. */
function parseHeaders(block) {
  const headers = {};
  const lines = String(block).split(/\r?\n/);
  let current = '';
  const push = (line) => {
    const i = line.indexOf(':');
    if (i === -1) return;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${val}` : val;
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) { current += ` ${line.trim()}`; continue; }
    if (current) push(current);
    current = line;
  }
  if (current) push(current);
  return headers;
}

/** «text/plain; charset="utf-8"» → { type, params } */
function parseTyped(value) {
  const s = String(value || '');
  const [head, ...rest] = s.split(';');
  const params = {};
  for (const part of rest) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    let v = part.slice(i + 1).trim().replace(/^"|"$/g, '');
    params[k] = v;
  }
  return { type: head.trim().toLowerCase(), params };
}

/**
 * Имя файла из Content-Disposition/Content-Type с учётом RFC 2231:
 * filename*=UTF-8''… и разрезанного filename*0*=…; filename*1*=…
 */
function fileNameFrom(params) {
  const keys = Object.keys(params);
  const parts = keys.filter((k) => /^(file)?name\*\d+\*?$/.test(k))
    .sort((a, b) => Number((/\d+/.exec(a) || [0])[0]) - Number((/\d+/.exec(b) || [0])[0]));
  if (parts.length) {
    const joined = parts.map((k) => params[k]).join('');
    return decodeExtended(joined);
  }
  for (const k of ['filename*', 'name*']) {
    if (params[k]) return decodeExtended(params[k]);
  }
  for (const k of ['filename', 'name']) {
    if (params[k]) return decodeHeader(params[k]);
  }
  return '';
}

/** UTF-8''%D0%A1%D1%87… либо просто процентная запись. */
function decodeExtended(v) {
  const s = String(v);
  const m = /^([^']*)'([^']*)'(.*)$/.exec(s);
  const raw = m ? m[3] : s;
  const cs = m ? m[1] : 'utf-8';
  const bytes = Buffer.from(raw.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return decodeText(bytes, cs);
}

/** Тело части → Buffer с учётом Content-Transfer-Encoding. */
function decodeBody(raw, encoding) {
  const enc = String(encoding || '7bit').toLowerCase();
  if (enc === 'base64') return Buffer.from(String(raw).replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return fromQuotedPrintable(raw);
  return Buffer.from(raw, 'latin1');
}

/** Рекурсивно разбирает часть письма. */
function parsePart(raw, out, depth = 0) {
  if (depth > 8) return;                       // защита от письма-матрёшки
  const split = raw.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const at = raw.indexOf(split);
  const head = at === -1 ? raw : raw.slice(0, at);
  const body = at === -1 ? '' : raw.slice(at + split.length);
  const h = parseHeaders(head);
  const ct = parseTyped(h['content-type'] || 'text/plain');
  const cd = parseTyped(h['content-disposition'] || '');
  const name = fileNameFrom({ ...ct.params, ...cd.params });

  if (ct.type.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) return;
    const marker = `--${boundary}`;
    const chunks = body.split(marker);
    for (const chunk of chunks.slice(1)) {
      if (/^--/.test(chunk)) break;            // закрывающая граница
      parsePart(chunk.replace(/^\r?\n/, ''), out, depth + 1);
    }
    return;
  }

  const content = decodeBody(body, h['content-transfer-encoding']);
  const isAttachment = cd.type === 'attachment' || Boolean(name);
  if (isAttachment) {
    out.attachments.push({
      filename: name || 'файл',
      contentType: ct.type,
      size: content.length,
      content,
    });
    return;
  }
  if (ct.type === 'text/plain' && !out.text) out.text = decodeText(content, ct.params.charset);
  if (ct.type === 'text/html' && !out.html) out.html = decodeText(content, ct.params.charset);
}

/**
 * Разбирает письмо целиком.
 * @param {Buffer|string} raw сырое письмо (заголовки + тело)
 * @returns {{from:string, fromName:string, subject:string, date:string,
 *            text:string, html:string, attachments:Array}}
 */
function parseMessage(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const out = { text: '', html: '', attachments: [] };
  parsePart(s, out);

  const at = s.indexOf('\r\n\r\n') >= 0 ? s.indexOf('\r\n\r\n') : s.indexOf('\n\n');
  const h = parseHeaders(at === -1 ? s : s.slice(0, at));
  const fromRaw = decodeHeader(h.from || '');
  const addr = (/<([^>]+)>/.exec(fromRaw) || [])[1] || fromRaw.trim();

  return {
    ...out,
    from: String(addr).trim().toLowerCase(),
    fromName: fromRaw.replace(/<[^>]*>/, '').replace(/^"|"$/g, '').trim(),
    subject: decodeHeader(h.subject || ''),
    date: h.date || '',
    messageId: h['message-id'] || '',
  };
}

/** Похоже ли вложение на счёт или акт — по типу и имени файла. */
function looksLikeDocument(att) {
  const name = String(att.filename || '').toLowerCase();
  const type = String(att.contentType || '').toLowerCase();
  if (/^image\//.test(type)) return true;
  if (type === 'application/pdf' || /\.pdf$/.test(name)) return true;
  if (/\.(jpe?g|png|webp|heic)$/.test(name)) return true;
  // Excel и Word тоже присылают, но распознать их нечем — не предлагаем.
  return false;
}

module.exports = {
  parseMessage, decodeHeader, parseHeaders, parseTyped,
  fileNameFrom, decodeBody, fromQuotedPrintable, decodeText, looksLikeDocument,
};
