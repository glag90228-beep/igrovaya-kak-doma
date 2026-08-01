'use strict';

// Минимальный клиент Telegram Bot API на встроенном fetch (Node 22).
// Без сторонних библиотек. Умеет long polling и отправку файлов (sendDocument).

class Telegram {
  constructor(token) {
    if (!token) throw new Error('BOT_TOKEN не задан');
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call(method, params = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`TG ${method}: ${data.description || res.status}`);
    return data.result;
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
    const data = await res.json();
    if (!data.ok) throw new Error(`TG sendDocument: ${data.description || res.status}`);
    return data.result;
  }

  /** Показать/скрыть «печатает…» */
  sendChatAction(chatId, action = 'upload_document') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  }
}

// ---- помощники для клавиатур ----

/** Inline-клавиатура из массива рядов [[{text, data}], ...] */
function keyboard(rows) {
  return {
    reply_markup: {
      inline_keyboard: rows.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.data }))),
    },
  };
}

module.exports = { Telegram, keyboard };
