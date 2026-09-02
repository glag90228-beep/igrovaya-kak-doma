'use strict';

/**
 * Минимальный клиент IMAP — только чтобы забрать новые письма с вложениями.
 *
 * Нам не нужен полноценный почтовый клиент: нужно войти, посмотреть входящие,
 * скачать письма целиком и пометить обработанные. Это семь команд протокола.
 *
 * Главная тонкость IMAP, на которой ломаются самодельные клиенты, — литералы.
 * Сервер не присылает письмо как строку: он пишет «{4096}» и следом ровно
 * 4096 байт, среди которых сколько угодно переводов строк. Читать ответ
 * построчно нельзя — надо считать байты. Поэтому здесь свой сборщик ответа,
 * а не «разбить по \r\n».
 *
 * Вторая тонкость: письмо это байты, а не текст. Держим Buffer до самого
 * разбора MIME, иначе вложение испортится ещё до того, как мы его увидим.
 */

const tls = require('node:tls');
const net = require('node:net');

const CRLF = '\r\n';

/*
 * Потолок одного ответа сервера.
 *
 * Без него Reader складывал в память всё, что присылал сервер, сколько бы
 * тот ни прислал. Почтовый ящик читает мини-приложение — один процесс на
 * всех, — и любой посторонний, отправивший клиенту письмо с вложением на
 * полсотни мегабайт, заставлял этот процесс держать его целиком. Buffer.concat
 * на каждый кусок делает это ещё и квадратично. MAX_BODY тут не защищает:
 * он про входящие HTTP-запросы, а не про то, что мы сами читаем из сети.
 *
 * Двадцать пять мегабайт — заведомо больше любого счёта или акта, которые
 * присылают контрагенты, и заведомо меньше того, чем можно уронить службу.
 */
const MAX_RESPONSE = 25 * 1024 * 1024;

/**
 * Ошибка человеческим языком.
 *
 * Наружу уходило сообщение исключения как есть, и человек на экране «Входящие»
 * читал «error:0A0000C6:SSL routines:tls_get_more_records:packet length too
 * long» — без единой подсказки, что с этим делать. Такой текст не объясняет
 * ничего никому, кроме того, кто писал протокол.
 *
 * Причина при этом почти всегда одна из трёх: не тот порт, выключенный у
 * провайдера доступ по IMAP или недоступный сервер. О них и говорим, а
 * исходный текст оставляем в скобках — по нему разбирается владелец, если
 * дело окажется в чём-то ещё.
 */
function humanError(e) {
  const raw = String((e && e.message) || 'неизвестная ошибка');
  if (/SSL|TLS|packet length|wrong version/i.test(raw)) {
    return 'Сервер ответил не по тому протоколу — обычно это не тот порт '
      + 'или не то шифрование. Проверьте настройки ящика.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return 'Не нашёл такой почтовый сервер — проверьте адрес.';
  if (/ECONNREFUSED/i.test(raw)) return 'Не удалось соединиться с сервером — проверьте порт.';
  if (/ETIMEDOUT|timeout|истекло/i.test(raw)) return 'Сервер не ответил вовремя. Попробуйте ещё раз.';
  if (/слишком большое/i.test(raw)) return raw;
  return raw;
}

/** Ответ сервера: строки протокола + собранные литералы. */
class Reader {
  constructor(socket, timeout) {
    this.buf = Buffer.alloc(0);
    this.waiting = null;
    this.timeout = timeout;
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (this.buf.length > MAX_RESPONSE) {
        // Рвём соединение, а не просто отказываем: сервер продолжит слать,
        // и память будет расти дальше, пока он не закончит.
        this.buf = Buffer.alloc(0);
        socket.destroy();
        this.fail(new Error('письмо слишком большое — оборвал чтение'));
        return;
      }
      this.check();
    });
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('сервер закрыл соединение')));
  }

  fail(e) {
    if (!this.waiting) return;
    const w = this.waiting;
    this.waiting = null;
    clearTimeout(w.timer);
    w.reject(e);
  }

  /**
   * Ответ закончен, когда встретилась строка «TAG OK|NO|BAD …» вне литерала.
   * Литералы пропускаем по объявленной длине — только так можно понять,
   * где кончается письмо и начинается следующая строка протокола.
   */
  check() {
    if (!this.waiting) return;
    const { tag } = this.waiting;
    let i = 0;
    while (i < this.buf.length) {
      const nl = this.buf.indexOf(CRLF, i);
      if (nl === -1) return;                       // строка ещё не дочитана
      const line = this.buf.slice(i, nl).toString('latin1');
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) {
        const need = nl + 2 + Number(lit[1]);
        if (this.buf.length < need) return;        // ждём тело литерала
        i = need;
        continue;
      }
      if (line.startsWith(`${tag} `)) {
        const done = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 2);
        const w = this.waiting;
        this.waiting = null;
        clearTimeout(w.timer);
        const status = (/^\S+\s+(OK|NO|BAD)/i.exec(line) || [])[1];
        if (!status || status.toUpperCase() !== 'OK') {
          w.reject(new Error(line.replace(`${tag} `, '')));
          return;
        }
        w.resolve(done);
        return;
      }
      i = nl + 2;
    }
  }

  wait(tag) {
    return new Promise((resolve, reject) => {
      this.waiting = {
        tag,
        resolve,
        reject,
        timer: setTimeout(() => this.fail(new Error('почтовый сервер не отвечает')), this.timeout),
      };
      this.check();
    });
  }
}

class Imap {
  constructor({ host, port = 993, secure = true, user, pass, timeout = 30000 }) {
    Object.assign(this, { host, port, secure, user, pass, timeout });
    this.n = 0;
  }

  async connect() {
    this.socket = await new Promise((resolve, reject) => {
      const s = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host })
        : net.connect({ host: this.host, port: this.port });
      const fail = (e) => { s.destroy(); reject(e); };
      s.setTimeout(this.timeout, () => fail(new Error('не удалось соединиться с почтовым сервером')));
      s.once('error', fail);
      s.once(this.secure ? 'secureConnect' : 'connect', () => {
        s.setTimeout(0);
        s.off('error', fail);
        resolve(s);
      });
    });
    this.reader = new Reader(this.socket, this.timeout);
    // Приветствие сервера — строка «* OK …», отдельного тега у неё нет.
    await new Promise((r) => setTimeout(r, 30));
    this.reader.buf = Buffer.alloc(0);
  }

  /** @returns {Promise<Buffer>} весь ответ до завершающей строки */
  send(command) {
    this.n += 1;
    const tag = `a${this.n}`;
    const p = this.reader.wait(tag);
    this.socket.write(`${tag} ${command}${CRLF}`);
    return p;
  }

  async login() {
    // Пароль в кавычках: в нём бывают пробелы, а спецсимволы экранируем.
    const esc = (v) => String(v).replace(/([\\"])/g, '\\$1');
    try {
      await this.send(`LOGIN "${esc(this.user)}" "${esc(this.pass)}"`);
    } catch (e) {
      // Пароль не должен попасть в текст ошибки ни при каких обстоятельствах.
      throw new Error(String(e.message).split(this.pass).join('***'));
    }
  }

  selectInbox() { return this.send('SELECT INBOX'); }

  /**
   * Номера писем: непрочитанные либо все за последние дни.
   * UID устойчивее порядкового номера — он не меняется при удалении писем.
   */
  async searchUids({ unseenOnly = true, sinceDays = 0 } = {}) {
    const parts = [];
    if (unseenOnly) parts.push('UNSEEN');
    if (sinceDays > 0) {
      const d = new Date(Date.now() - sinceDays * 86400000);
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
      parts.push(`SINCE ${d.getDate()}-${mon}-${d.getFullYear()}`);
    }
    const res = await this.send(`UID SEARCH ${parts.join(' ') || 'ALL'}`);
    const line = res.toString('latin1').split(CRLF).find((l) => /^\* SEARCH/i.test(l)) || '';
    return line.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number);
  }

  /** Письмо целиком. PEEK — чтобы не пометить прочитанным раньше времени. */
  async fetchRaw(uid) {
    const res = await this.send(`UID FETCH ${uid} (BODY.PEEK[])`);
    // Тело идёт литералом: «… {12345}\r\n<байты>». Берём объявленную длину.
    const head = res.toString('latin1');
    const m = /\{(\d+)\}\r\n/.exec(head);
    if (!m) return null;
    const start = m.index + m[0].length;
    return res.slice(start, start + Number(m[1]));
  }

  markSeen(uid) { return this.send(`UID STORE ${uid} +FLAGS (\\Seen)`); }

  async logout() {
    try { await this.send('LOGOUT'); } catch (_) { /* прощание не критично */ }
    if (this.socket) this.socket.end();
  }
}

/**
 * Забирает новые письма.
 * @returns {Promise<{ok:true, messages:Array}|{ok:false, error:string}>}
 */
async function fetchNew(config, { limit = 10, unseenOnly = true, sinceDays = 0 } = {}) {
  const client = new Imap(config);
  try {
    await client.connect();
    await client.login();
    await client.selectInbox();
    const uids = await client.searchUids({ unseenOnly, sinceDays });
    // Свежие письма важнее старых: если их много, берём последние.
    const take = uids.slice(-limit).reverse();
    const messages = [];
    for (const uid of take) {
      // eslint-disable-next-line no-await-in-loop
      const raw = await client.fetchRaw(uid);
      if (raw) messages.push({ uid, raw });
    }
    await client.logout();
    return { ok: true, messages, total: uids.length };
  } catch (e) {
    try { await client.logout(); } catch (_) { /* уже мертво */ }
    return { ok: false, error: humanError(e) };
  }
}

module.exports = { Imap, fetchNew };
