'use strict';

/*
 * Повтор исходящего запроса, когда сорвалась связь.
 *
 * На боевом сервере соединение наружу иногда не устанавливается: SYN
 * теряется, и встроенный fetch сдаётся с голым «fetch failed». Второе
 * соединение, как правило, проходит. Без повтора человек получал «помощник
 * не ответил», «не дозвониться до справочника» или «Сетевая ошибка Platega»
 * на ровном месте — хотя площадка была жива.
 *
 * Повторяем внутри того же сигнала, что передал вызывающий: общий срок не
 * растёт, человек ждёт не дольше, чем ждал раньше.
 */

/** Ошибка случилась до того, как запрос ушёл: повторять безопасно. */
const CONNECT_CODES = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH'];

/*
 * Кроме кодов смотрим на syscall. Node перебирает адреса площадки (IPv4 и
 * IPv6) и, если не подключился ни к одному, отдаёт AggregateError с кодом
 * ETIMEDOUT — по коду не отличить от таймаута посреди ответа. А вот syscall
 * у каждой вложенной ошибки — 'connect': значит, до отправки не дошло.
 */
function beforeSend(e, depth = 0) {
  if (!e || depth > 3) return false;
  if (e.isConnect || CONNECT_CODES.includes(e.code)) return true;
  if (e.syscall === 'connect' || e.syscall === 'getaddrinfo') return true;
  if (Array.isArray(e.errors) && e.errors.length) return e.errors.every((x) => beforeSend(x, depth + 1));
  return beforeSend(e.cause, depth + 1);
}

/** Сетевой сбой fetch, а не истёкший срок и не отмена. */
const netFailure = (e) => e instanceof TypeError && e.message === 'fetch failed';

/**
 * fetch с повтором.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.idempotent] запрос только читает — повторять можно
 *   при любом обрыве. Иначе (создание платежа, отправка сообщения) — только
 *   если запрос точно не ушёл: иначе второй платёж или второе сообщение.
 * @param {number} [opts.tries] сколько всего попыток.
 */
async function fetchRetry(url, init = {}, { idempotent = false, tries = 3 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetch(url, init);
    } catch (e) {
      const again = attempt < tries && !(init.signal && init.signal.aborted)
        && (beforeSend(e) || (idempotent && netFailure(e)));
      if (!again) throw e;
      // В журнал — только адрес площадки: в пути у Telegram лежит токен.
      const c = e.cause || e;
      console.warn(`сеть: ${new URL(url).host} — ${c.code || c.message}, повтор ${attempt} из ${tries - 1}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, attempt * 300));
    }
  }
}

module.exports = { fetchRetry, beforeSend, CONNECT_CODES };
