'use strict';

// Минимальный клиент Telegram Bot API на встроенном fetch (Node 22).
// Без сторонних библиотек. Умеет long polling и отправку файлов (sendDocument).

/**
 * Сколько готовы ждать по просьбе Telegram, прежде чем сдаться.
 *
 * У 429 бывает очень разный retry_after: на отправке сообщений это секунды,
 * а на смене имени бота Telegram отвечает часами — там жёсткий суточный
 * лимит. Спать столько нельзя: установка вставала намертво на «Оформляю»,
 * без единой строчки в выводе, и выглядело это как зависший сервер.
 */
const MAX_RETRY_WAIT = 20;

/** Ни один запрос не должен висеть вечно: молчащее соединение — не ответ. */
function timeoutFor(params) {
  // Long polling сам ждёт params.timeout секунд — это нормально, добавляем запас.
  const poll = Number(params && params.timeout) || 0;
  return (poll ? poll + 20 : 35) * 1000;
}

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
   * На 429 Telegram сам говорит, сколько ждать, — ждём, если просят
   * по-божески, и честно сдаёмся, если речь о часах.
   */
  async call(method, params = {}, attempt = 0, netTry = 0) {
    let res;
    try {
      res = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutFor(params)),
      });
    } catch (e) {
      /*
       * «fetch failed» — всё, что Node сообщает о любой сетевой беде: не
       * разрешилось имя, отказали в соединении, оборвалось шифрование, лёг
       * прокси. Настоящая причина лежит в e.cause и до журнала не доходила,
       * поэтому в нём оставалась строка, одинаковая для десятка разных
       * поломок, — по ней нельзя было даже понять, куда смотреть.
       */
      const cause = e.cause && (e.cause.code || e.cause.message);

      /*
       * Не достучались до Telegram — пробуем ещё раз.
       *
       * С этого сервера соединение до api.telegram.org устанавливается через
       * раз: одна и та же команда в первый раз падает с UND_ERR_CONNECT_TIMEOUT,
       * во второй проходит. Для российского хостинга это обычное дело, и
       * сдаваться с первой попытки значит терять сообщения на ровном месте —
       * так у владельца пропало уведомление о платеже, пришедшем без привязки.
       *
       * Повторяем ТОЛЬКО отказы на подключении: соединения не случилось,
       * значит запрос до Telegram не дошёл и повтор ничего не задвоит.
       *
       * ECONNRESET и ETIMEDOUT в этом списке были и оказались ошибкой: оба
       * приходят на любой стадии, в том числе когда запрос уже ушёл целиком,
       * Telegram его принял и обработал, а оборвался только ответ. На стенде
       * (сервер дочитывает тело и делает resetAndDestroy) одно сообщение
       * уезжало трижды — то есть человек получал «Оплата получена. Доступ
       * продлён» три раза подряд. Ровно тот случай, который комментарий выше
       * объявлял исключённым, а список молча включал.
       */
      const preSend = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND',
        'EAI_AGAIN'].includes(cause);
      /*
       * Счётчик у сетевого повтора свой.
       *
       * Раньше он был общий с повтором по 429, и два разных лимита делили
       * одно число: после двух пауз «слишком часто» сетевой повтор не
       * срабатывал вовсе — то есть именно при массовой рассылке, когда он
       * нужнее всего. И наоборот, два сетевых захода урезали запас по 429
       * с трёх до одного.
       */
      if (preSend && netTry < 2) {
        // Молчащий повтор — та же слепота, от которой уходили: «моргнуло и
        // со второй попытки прошло» не оставляло следа, и понять по журналу,
        // что сервер отваливается через раз, было нельзя.
        console.warn(`TG ${method}: ${cause}, повтор ${netTry + 1} из 2`);
        await new Promise((r) => setTimeout(r, (netTry + 1) * 1500));
        return this.call(method, params, attempt, netTry + 1);
      }

      const err = new Error(e.name === 'TimeoutError'
        ? `TG ${method}: Telegram не ответил вовремя`
        : `TG ${method}: ${[e.message, cause].filter(Boolean).join(' — ')}`);
      err.network = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (data.ok) return data.result;

    const code = data.error_code || res.status;
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
  async sendDocument(chatId, { filename, buffer, caption }) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
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
