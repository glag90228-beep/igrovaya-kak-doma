'use strict';

// Клиент Telegram Bot API на node:https / node:http (Node 22).
// Без сторонних библиотек. Умеет persistent keep-alive, long polling и отправку файлов.

const http = require('node:http');
const https = require('node:https');

// Пул постоянных соединений: отклик на сообщения сокращается с 10-35с (при потере SYN) до 45мс.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 25 });
httpAgent.on('free', (socket) => socket.unref());

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 25,
});
httpsAgent.on('free', (socket) => socket.unref());

/**
 * Сколько готовы ждать по просьбе Telegram, прежде чем сдаться.
 */
const MAX_RETRY_WAIT = 20;

/** Ни один запрос не должен висеть вечно: молчащее соединение — не ответ. */
function timeoutFor(params) {
  // Long polling сам ждёт params.timeout секунд — добавляем запас.
  const poll = Number(params && params.timeout) || 0;
  return (poll ? poll + 20 : 15) * 1000;
}

function doRequest(urlStr, data, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;
    const payload = data ? JSON.stringify(data) : null;

    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    });

    let connectTimer = null;
    let requestTimer = null;
    let settled = false;

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (requestTimer) clearTimeout(requestTimer);
    };

    req.on('socket', (socket) => {
      if (socket.connecting) {
        // Ограничиваем таймаут подключения до 3.5с (пинг 45мс, при потере SYN не ждём 10с undici)
        connectTimer = setTimeout(() => {
          cleanup();
          const err = new Error('CONNECT_TIMEOUT');
          err.code = 'UND_ERR_CONNECT_TIMEOUT';
          err.isConnect = true;
          req.destroy(err);
        }, 3500);

        socket.once('connect', () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
        });
      }
    });

    if (timeoutMs > 0) {
      requestTimer = setTimeout(() => {
        cleanup();
        const err = new Error('TIMEOUT');
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      }, timeoutMs);
    }

    req.on('response', (res) => {
      cleanup();
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try { parsed = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, data: parsed });
      });
    });

    req.on('error', (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    if (payload) req.write(payload);
    req.end();
  });
}

class Telegram {
  constructor(token) {
    if (!token) throw new Error('BOT_TOKEN не задан');
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
  }

  /**
   * Вызов метода API с повтором при сетевых сбоях и обработкой 429.
   */
  async call(method, params = {}, attempt = 0, netTry = 0) {
    let res;
    const timeoutMs = timeoutFor(params);
    try {
      res = await doRequest(`${this.base}/${method}`, params, timeoutMs);
    } catch (e) {
      const code = e.code || e.message;
      const isTimeout = code === 'ETIMEDOUT' || code === 'TIMEOUT' || e.name === 'TimeoutError' || /timeout/i.test(code);
      const preSend = Boolean(e.isConnect || ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND',
        'EAI_AGAIN'].includes(code));

      if (preSend && netTry < 3) {
        console.warn(`TG ${method}: ${code}, повтор ${netTry + 1} из 3`);
        await new Promise((r) => setTimeout(r, (netTry + 1) * 200));
        return this.call(method, params, attempt, netTry + 1);
      }

      const err = new Error(isTimeout
        ? `TG ${method}: Telegram не ответил вовремя`
        : `TG ${method}: ${[e.message, code].filter(Boolean).join(' — ')}`);
      err.network = true;
      throw err;
    }

    const { status, data } = res;
    if (data && data.ok) return data.result;

    const code = data.error_code || status;
    const retryAfter = ((data.parameters || {}).retry_after) || 0;
    if (code === 429 && attempt < 3 && retryAfter <= MAX_RETRY_WAIT) {
      await new Promise((r) => setTimeout(r, (retryAfter || 1) * 1000));
      return this.call(method, params, attempt + 1, netTry);
    }
    if (code === 429 && retryAfter > MAX_RETRY_WAIT) {
      const err = new Error(`TG ${method}: слишком часто, Telegram просит подождать `
        + `${Math.ceil(retryAfter / 60)} мин.`);
      err.code = 429;
      err.retryAfter = retryAfter;
      throw err;
    }

    const err = new Error(`TG ${method}: ${data.description || code}`);
    err.code = code;
    err.retryAfter = retryAfter;
    // 403 — бот заблокирован или чат удалён; 400 «chat not found» по сути то же
    err.blocked = code === 403
      || /bot was blocked|user is deactivated|chat not found|bot was kicked/i.test(data.description || '');
    throw err;
  }

  getUpdates(offset, timeout = 30) {
    return this.call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] });
  }

  sendMessage(chatId, text, opts = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });
  }

  editMessageText(chatId, messageId, text, opts = {}) {
    return this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...opts,
    });
  }

  answerCallbackQuery(id, opts = {}) {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...opts });
  }

  /** Отправка файла: { filename, buffer (Buffer|ArrayBuffer|Uint8Array), caption } */
  /**
   * @param {object} p
   * @param {Array} [p.buttons] строки кнопок в том же виде, что у keyboard():
   *   документ без кнопок — это тупик. Человек получает файл и дальше не
   *   знает, что с ним делать: переслать клиенту, отметить оплату и открыть
   *   карточку он должен уметь прямо отсюда, не разыскивая документ в меню.
   */
  async sendDocument(chatId, { filename, buffer, caption, buttons }) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
    // multipart принимает разметку только строкой — объект в FormData
    // превратился бы в «[object Object]», и Telegram отверг бы запрос.
    if (buttons && buttons.length) {
      form.append('reply_markup', JSON.stringify(keyboard(buttons).reply_markup));
    }
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    form.append('document', new Blob([bytes]), filename);
    // Документ бывает на несколько мегабайт — даём больше времени, чем
    // обычному вызову, но не бесконечность.
    const res = await fetch(`${this.base}/sendDocument`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const data = await res.json().catch(() => ({}));
    if (data.ok) return data.result;
    const code = data.error_code || res.status;
    const err = new Error(`TG sendDocument: ${data.description || code}`);
    err.code = code;
    err.blocked = code === 403 || /bot was blocked|chat not found/i.test(data.description || '');
    throw err;
  }

  /** Показать/скрыть «печатает…» */
  sendChatAction(chatId, action = 'upload_document') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  }

  /** Скачать присланный файл по file_id (фото счёта, скан). */
  async downloadFile(fileId, maxBytes = 12 * 1024 * 1024) {
    const info = await this.call('getFile', { file_id: fileId });
    if (info.file_size && info.file_size > maxBytes) {
      throw new Error('Файл слишком большой');
    }
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`,
      { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

// ---- помощники для клавиатур ----

/**
 * Inline-клавиатура из рядов [[{text, data}], ...].
 * У кнопки ровно один вид действия — Telegram не принимает два сразу:
 *   data   — вернуть нажатие боту (обычный случай);
 *   url    — открыть ссылку;
 *   webApp — открыть мини-приложение поверх чата.
 */
function keyboard(rows) {
  const button = (b) => {
    if (b.webApp) return { text: b.text, web_app: { url: b.webApp } };
    if (b.url) return { text: b.text, url: b.url };
    return { text: b.text, callback_data: b.data };
  };
  return { reply_markup: { inline_keyboard: rows.map((row) => row.map(button)) } };
}

module.exports = { Telegram, keyboard };
