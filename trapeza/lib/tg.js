'use strict';

// Минимальный клиент Telegram Bot API на встроенном fetch (Node 22).
// Без сторонних библиотек. Умеет long polling и отправку файлов (sendDocument).

class Telegram {
  constructor(token) {
    if (!token) throw new Error('BOT_TOKEN не задан');
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
  }

  /**
   * Вызов метода API. Ошибку не глотаем, но приводим к разбираемому виду:
   * вызывающему коду важно отличить «пользователь заблокировал бота» (403)
   * от «слишком часто» (429) и от настоящей поломки.
   *
   * На 429 Telegram сам говорит, сколько ждать, — ждём и повторяем.
   */
  async call(method, params = {}, attempt = 0) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) return data.result;

    const code = data.error_code || res.status;
    const retryAfter = ((data.parameters || {}).retry_after) || 0;
    if (code === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, (retryAfter || 1) * 1000));
      return this.call(method, params, attempt + 1);
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
  async sendDocument(chatId, { filename, buffer, caption }) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    form.append('document', new Blob([bytes]), filename);
    const res = await fetch(`${this.base}/sendDocument`, { method: 'POST', body: form });
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
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`);
    if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

// ---- помощники для клавиатур ----

/**
 * Inline-клавиатура из рядов [[{text, data}], ...].
 * Кнопка со ссылкой задаётся полем url вместо data — Telegram не принимает
 * оба поля сразу.
 */
function keyboard(rows) {
  return {
    reply_markup: {
      inline_keyboard: rows.map((row) => row.map((b) => (b.url
        ? { text: b.text, url: b.url }
        : { text: b.text, callback_data: b.data }))),
    },
  };
}

module.exports = { Telegram, keyboard };
