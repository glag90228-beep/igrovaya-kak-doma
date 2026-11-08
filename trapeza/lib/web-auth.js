'use strict';

/**
 * Вход в приложение с обычного сайта — без Telegram WebApp.
 *
 * Внутри Telegram человека узнаёт подпись initData. В обычном браузере её
 * нет, а пароли заводить не хочется: их забывают, подбирают и сливают.
 * Поэтому личность подтверждает сам Telegram, как при входе по QR в
 * мессенджерах:
 *
 *   1. сайт просит одноразовый вход (`startLogin`) и получает случайный
 *      nonce — он живёт пять минут и лежит у браузера;
 *   2. человек открывает бота по ссылке с этим nonce и выбирает число с экрана
 *      сайта (`answerLogin`, подробнее ниже) — бот знает, кто нажал, потому что Telegram сам
 *      присылает его номер;
 *   3. сайт спрашивает «подтвердили?» (`checkLogin`) и получает сессию —
 *      один раз.
 *
 * Сверка числа. Одного «Да» мало: злоумышленник открывает сайт у себя, шлёт
 * жертве ссылку входа, и та нажимает «Да», не понимая, чей это вход. Поэтому
 * на экране сайта показано двузначное число (`code`), а в боте человеку даны
 * три числа в случайном порядке — верное и два ложных. Выбрать надо то, что на
 * экране. Тот, кто пришёл по чужой ссылке, числа не видел и угадывает с
 * вероятностью 1 из 3; неверный выбор отклоняет вход навсегда — второй
 * попытки нет. Число не секрет от браузера и не лежит ни в ссылке, ни в QR:
 * QR могут сфотографировать, а число видно только на экране.
 *
 * Что здесь принципиально:
 *   • В базе нет ни nonce, ни токена сессии — только SHA-256 от них. Копия
 *     базы (бэкап, лог SQL) не даёт войти: хэш обратно не раскрутить, а
 *     секреты в 192–256 бит не подбираются, так что соль и медленный хэш
 *     тут не нужны.
 *   • Вход использует один раз и атомарно: выдача сессии и пометка «использован»
 *     — одна транзакция. Два одновременных опроса не получат по сессии.
 *   • Бот и мини-приложение — разные процессы с одной базой. Состояние входа
 *     поэтому лежит в таблице, а не в памяти.
 *
 * Чего здесь нет: пароля, «запомнить меня» на год и входа без подтверждения
 * в боте. Сессия живёт тридцать дней и не продлевается — раз в месяц войти
 * заново дешевле, чем разбирать украденную вечную.
 */

const crypto = require('node:crypto');
const { db } = require('../db');
require('./bot-db');   // таблица bot_users должна существовать до наших внешних ключей

const LOGIN_TTL_MS = 5 * 60 * 1000;                  // сколько ждём подтверждения в боте
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;     // сколько живёт сессия
const SESSION_MAX_AGE = Math.floor(SESSION_TTL_MS / 1000);
const TOUCH_EVERY_MS = 60 * 1000;                    // как часто обновляем «был в сети»
const MAX_SESSIONS_PER_USER = 20;                    // больше двадцати браузеров не нужно
const MAX_PENDING_LOGINS = 3000;                     // потолок ожидающих входов на весь сервер
const COOKIE = 'pv_sid';

const NONCE_RE = /^[A-Za-z0-9_-]{32}$/;              // 24 байта в base64url
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;              // 32 байта в base64url
const LOGIN_ID_RE = /^[0-9a-f]{20}$/;                // начало SHA-256 от nonce, 80 бит

/**
 * Миграция по образцу bot-db: таблица создаётся с нужными колонками, а у базы,
 * где она уже была без них, колонки добавляются. Старые строки живут как жили:
 * ожидающий вход без числа (code = 0) боту просто не предлагается — он живёт
 * пять минут, и человек начнёт заново.
 */
function migrate(d = db) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS web_logins (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nonce_hash TEXT    NOT NULL UNIQUE,           -- SHA-256 от nonce, сам nonce не храним
      created_at TEXT    NOT NULL,
      expires_at TEXT    NOT NULL,
      user_id    INTEGER,                           -- кто подтвердил; пока никто — NULL
      confirmed  INTEGER NOT NULL DEFAULT 0,
      denied     INTEGER NOT NULL DEFAULT 0,
      used       INTEGER NOT NULL DEFAULT 0,        -- сессия по этому входу уже выдана
      ip         TEXT    NOT NULL DEFAULT '',
      ua         TEXT    NOT NULL DEFAULT '',
      code       INTEGER NOT NULL DEFAULT 0,        -- число с экрана сайта, 10–99
      choices    TEXT    NOT NULL DEFAULT ''        -- три числа на кнопках бота, через запятую
    );
    CREATE INDEX IF NOT EXISTS idx_weblogin_exp ON web_logins(expires_at);

    CREATE TABLE IF NOT EXISTS web_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash   TEXT    NOT NULL UNIQUE,         -- SHA-256 от токена из cookie
      user_id      INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
      created_at   TEXT    NOT NULL,
      expires_at   TEXT    NOT NULL,
      last_seen_at TEXT    NOT NULL,
      ua           TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_websess_user ON web_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_websess_exp ON web_sessions(expires_at);
  `);
  const have = d.prepare('PRAGMA table_info(web_logins)').all().map((c) => c.name);
  if (!have.includes('code')) d.exec('ALTER TABLE web_logins ADD COLUMN code INTEGER NOT NULL DEFAULT 0');
  if (!have.includes('choices')) d.exec("ALTER TABLE web_logins ADD COLUMN choices TEXT NOT NULL DEFAULT ''");
}
migrate();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** Заголовок User-Agent приходит от кого угодно: режем длину и управляющие знаки. */
function cleanUa(ua) {
  // eslint-disable-next-line no-control-regex
  return String(ua || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
}

/**
 * «Chrome, Windows» вместо строки в сто знаков.
 *
 * Человеку в боте нужно узнать свой браузер, а не прочитать User-Agent. Словарь
 * закрытый, поэтому в сообщение с HTML-разметкой попадают только наши слова,
 * а не чужой текст.
 */
function shortUa(ua) {
  const s = String(ua || '');
  let browser = '';
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/YaBrowser\//.test(s)) browser = 'Яндекс Браузер';
  else if (/SamsungBrowser\//.test(s)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  let os = '';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/Android/.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iPhone';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'Mac';
  else if (/CrOS/.test(s)) os = 'Chromebook';
  else if (/Linux|X11/.test(s)) os = 'Linux';
  return [browser, os].filter(Boolean).join(', ') || 'неизвестный браузер';
}

// ---------- ограничение частоты ----------

/**
 * Окно «не больше N за T», отдельно на ключ. Хранится в памяти: пережить
 * перезапуск счётчику не нужно, а таблица ради него была бы лишней.
 * Карта ограничена — иначе поток новых ключей раздувал бы её без предела
 * (то же правило, что у tooOften в miniapp.js).
 */
function makeLimiter(limit, windowMs, maxKeys = 20000) {
  const seen = new Map();
  const hit = (key) => {
    const now = Date.now();
    const rec = seen.get(key);
    if (!rec || now - rec.since > windowMs) {
      if (seen.size >= maxKeys) {
        // Самые старые окна — в начале карты: снимаем ровно столько, сколько лишних.
        let extra = seen.size - maxKeys + 1;
        for (const k of seen.keys()) { seen.delete(k); extra -= 1; if (extra <= 0) break; }
      }
      seen.set(key, { since: now, n: 1 });
      return false;
    }
    rec.n += 1;
    return rec.n > limit;
  };
  hit.reset = () => seen.clear();
  return hit;
}

/** Старт входа: десять в десять минут с одного адреса. */
const startTooOften = makeLimiter(10, 10 * 60 * 1000);
/** Опрос: не чаще раза в секунду на один вход (ключ — хэш nonce). */
const checkTooOften = makeLimiter(1, 1000);
/** Опрос с одного адреса в целом: запас на несколько вкладок, но не на перебор. */
const checkIpTooOften = makeLimiter(120, 60 * 1000);

function resetLimits() { startTooOften.reset(); checkTooOften.reset(); checkIpTooOften.reset(); }

// ---------- вход ----------

/** Число 10–99 из криптографического генератора: Math.random для проверки личности не годится. */
const randomCode = () => crypto.randomInt(10, 100);

/** Кнопки бота: верное число и два ложных, все разные, в случайном порядке. */
function makeChoices(code) {
  const set = new Set([code]);
  while (set.size < 3) set.add(randomCode());
  const list = [...set];
  for (let i = list.length - 1; i > 0; i -= 1) {       // тасование Фишера — Йетса
    const j = crypto.randomInt(0, i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * Завести одноразовый вход.
 *
 * @returns {{nonce:string, code:number, expiresAt:string}|{busy:true}}
 *   busy — на сервере уже слишком много ожидающих входов (поток со многих
 *   адресов); честнее отказать, чем раздувать таблицу.
 */
function startLogin({ ip = '', ua = '' } = {}) {
  purgeExpiredLogins();
  const pending = db.prepare(
    'SELECT COUNT(*) AS n FROM web_logins WHERE confirmed = 0 AND denied = 0 AND expires_at > ?',
  ).get(iso()).n;
  if (pending >= MAX_PENDING_LOGINS) return { busy: true };

  const nonce = crypto.randomBytes(24).toString('base64url');
  const code = randomCode();
  const expiresAt = iso(Date.now() + LOGIN_TTL_MS);
  db.prepare(
    'INSERT INTO web_logins (nonce_hash, created_at, expires_at, ip, ua, code) VALUES (?,?,?,?,?,?)',
  ).run(sha(nonce), iso(), expiresAt, String(ip).slice(0, 64), cleanUa(ua), code);
  return { nonce, code, expiresAt };
}

/**
 * Бот открыл ссылку входа: что показать человеку.
 *
 * Отдаём короткий идентификатор (начало хэша), а не сам nonce: nonce — это
 * то, что выпускает сессию, и он должен оставаться только у браузера, а в
 * callback_data кнопок идёт идентификатор. Из него nonce не восстановить.
 *
 * Числа на кнопках выбираются при первом показе и запоминаются. Повторное
 * открытие той же ссылки показывает те же кнопки в том же порядке: иначе
 * можно было бы открывать ссылку заново, пока верное число не окажется там,
 * где его хочется нажать.
 */
function previewLogin(nonce) {
  if (!NONCE_RE.test(String(nonce || ''))) return null;
  let row = db.prepare('SELECT * FROM web_logins WHERE nonce_hash = ?').get(sha(nonce));
  if (!row || row.confirmed || row.denied || row.used || row.expires_at <= iso()) return null;
  if (row.code < 10) return null;       // вход, заведённый до сверки чисел: показывать нечего
  if (!row.choices) {
    // Условие в UPDATE: два одновременных открытия не перезапишут друг друга.
    db.prepare("UPDATE web_logins SET choices = ? WHERE id = ? AND choices = ''")
      .run(makeChoices(row.code).join(','), row.id);
    row = db.prepare('SELECT * FROM web_logins WHERE id = ?').get(row.id);
  }
  return {
    id: row.nonce_hash.slice(0, 20),
    ua: row.ua,
    shortUa: shortUa(row.ua),
    createdAt: row.created_at,
    choices: row.choices.split(',').map(Number),
  };
}

/** Ждёт ли вход ответа по этому идентификатору — для кнопок бота. */
function pendingById(id) {
  if (!LOGIN_ID_RE.test(String(id || ''))) return null;
  const row = db.prepare(
    `SELECT * FROM web_logins WHERE substr(nonce_hash, 1, 20) = ?
       AND confirmed = 0 AND denied = 0 AND used = 0 AND expires_at > ?`,
  ).get(id, iso());
  return row || null;
}

/**
 * Человек нажал на кнопку с числом.
 *
 * Верное число подтверждает вход, неверное отклоняет его навсегда — второй
 * попытки нет, иначе три кнопки перебирались бы за три нажатия. Решение, как и
 * в confirmLogin, принимает сам UPDATE: условие «ещё не решён и не истёк» стоит
 * в нём, а не в проверке перед ним, и два нажатия подряд не дадут двух решений.
 *
 * @param {string} id идентификатор входа из кнопки
 * @param {number} index номер кнопки (0–2): в данных кнопки идёт номер, а не
 *   число, чтобы из них нельзя было прочитать верный ответ
 * @returns {'ok'|'wrong'|'stale'}
 */
function answerLogin(id, index, userId) {
  if (!LOGIN_ID_RE.test(String(id || ''))) return 'stale';
  if (!Number.isInteger(index) || index < 0 || index > 2 || !Number.isInteger(userId)) return 'stale';
  const row = pendingById(id);
  if (!row || row.code < 10 || !row.choices) return 'stale';
  const picked = Number(row.choices.split(',')[index]);
  if (picked === row.code) return confirmLogin(id, userId) ? 'ok' : 'stale';
  return denyLogin(id) ? 'wrong' : 'stale';
}

/**
 * Подтвердить вход, не спрашивая число. Бот сюда не ходит — он зовёт
 * answerLogin. Нужна самой проверке, а тестам — чтобы изобразить уже
 * подтверждённый вход.
 *
 * Пишет user_id только в ещё не решённый и не истёкший вход:
 * условия стоят в самом UPDATE, а не в проверке перед ним, поэтому два
 * нажатия подряд не подтвердят вход дважды и не переписывают подтвердившего.
 */
function confirmLogin(id, userId) {
  if (!LOGIN_ID_RE.test(String(id || '')) || !Number.isInteger(userId)) return false;
  return db.prepare(
    `UPDATE web_logins SET user_id = ?, confirmed = 1
      WHERE substr(nonce_hash, 1, 20) = ? AND confirmed = 0 AND denied = 0
        AND used = 0 AND expires_at > ?`,
  ).run(userId, id, iso()).changes === 1;
}

/** «Нет». Отклонённый вход подтвердить уже нельзя. */
function denyLogin(id) {
  if (!LOGIN_ID_RE.test(String(id || ''))) return false;
  return db.prepare(
    `UPDATE web_logins SET denied = 1
      WHERE substr(nonce_hash, 1, 20) = ? AND confirmed = 0 AND denied = 0
        AND used = 0 AND expires_at > ?`,
  ).run(id, iso()).changes === 1;
}

/**
 * Опрос с сайта.
 *
 * @returns {{status:'wait'}|{status:'denied'}|{status:'expired'}|{status:'gone'}
 *          |{status:'ok', token:string, userId:number}}
 *   gone — такого входа нет или сессия по нему уже выдана; одно и то же слово,
 *   чтобы не подсказывать постороннему, был ли такой nonce.
 */
function checkLogin(nonce, { ua = '' } = {}) {
  if (!NONCE_RE.test(String(nonce || ''))) return { status: 'gone' };
  const hash = sha(nonce);
  // IMMEDIATE: пишущая транзакция берёт блокировку сразу, и второй
  // одновременный опрос ждёт, а не читает то же «не использован».
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM web_logins WHERE nonce_hash = ?').get(hash);
    if (!row || row.used) { db.exec('COMMIT'); return { status: 'gone' }; }
    if (row.denied) { db.exec('COMMIT'); return { status: 'denied' }; }
    if (row.expires_at <= iso()) { db.exec('COMMIT'); return { status: 'expired' }; }
    if (!row.confirmed || !row.user_id) { db.exec('COMMIT'); return { status: 'wait' }; }

    const marked = db.prepare('UPDATE web_logins SET used = 1 WHERE id = ? AND used = 0').run(row.id);
    if (marked.changes !== 1) { db.exec('COMMIT'); return { status: 'gone' }; }

    const token = crypto.randomBytes(32).toString('base64url');
    const now = iso();
    db.prepare(
      `INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ua)
       VALUES (?,?,?,?,?,?)`,
    ).run(sha(token), row.user_id, now, iso(Date.now() + SESSION_TTL_MS), now, cleanUa(ua || row.ua));
    // Старые сессии сверх потолка уходят: забытый браузер не должен копиться вечно.
    db.prepare(
      `DELETE FROM web_sessions WHERE user_id = ? AND id NOT IN
         (SELECT id FROM web_sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(row.user_id, row.user_id, MAX_SESSIONS_PER_USER);
    db.exec('COMMIT');
    return { status: 'ok', token, userId: row.user_id };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* транзакция уже закрыта */ }
    throw e;
  }
}

// ---------- сессии ----------

/**
 * Кто стоит за токеном — или null. Причину не называем: просроченный,
 * отозванный и выдуманный токены снаружи выглядят одинаково.
 */
function sessionFor(token) {
  const t = String(token || '');
  if (!TOKEN_RE.test(t)) return null;
  const row = db.prepare('SELECT * FROM web_sessions WHERE token_hash = ?').get(sha(t));
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= iso(now)) {
    db.prepare('DELETE FROM web_sessions WHERE id = ?').run(row.id);
    return null;
  }
  // «Был в сети» пишем не на каждый запрос: приложение шлёт их десятками,
  // а писать в базу ради минутной точности незачем.
  if (now - Date.parse(row.last_seen_at) > TOUCH_EVERY_MS) {
    db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?').run(iso(now), row.id);
  }
  return { id: row.id, userId: row.user_id, ua: row.ua };
}

/** Выйти из этого браузера. */
function logoutToken(token) {
  const t = String(token || '');
  if (!TOKEN_RE.test(t)) return 0;
  return db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(sha(t)).changes;
}

/** Выйти везде. Заодно гасим входы, которые человек успел подтвердить, но сайт ещё не забрал. */
function logoutAll(userId) {
  const n = db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId).changes;
  db.prepare('UPDATE web_logins SET used = 1 WHERE user_id = ? AND used = 0').run(userId);
  return n;
}

/** Живые сессии человека: для экрана «Сеансы на сайте» в боте. */
function listSessions(userId) {
  return db.prepare(
    `SELECT id, ua, created_at, last_seen_at, expires_at FROM web_sessions
      WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
  ).all(userId, iso()).map((r) => ({
    id: r.id, ua: r.ua, shortUa: shortUa(r.ua),
    createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
  }));
}

/** Уборка: просроченные входы (с запасом, чтобы «время вышло» ещё отвечалось) и сессии. */
function purgeExpiredLogins() {
  return db.prepare('DELETE FROM web_logins WHERE expires_at < ?').run(iso(Date.now() - 10 * 60 * 1000)).changes;
}
function purge() {
  const logins = purgeExpiredLogins();
  const sessions = db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(iso()).changes;
  return { logins, sessions };
}

// ---------- cookie ----------

/** Токен из заголовка Cookie — или пустая строка. Чужие cookie не трогаем. */
function tokenFromCookie(header) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) {
      const v = part.slice(i + 1).trim();
      return TOKEN_RE.test(v) ? v : '';
    }
  }
  return '';
}

/**
 * Set-Cookie для сессии.
 *   HttpOnly — страница (а значит и чужой скрипт на ней) токена не прочтёт;
 *   Secure   — по голому http он не уйдёт; выключается только явно, для разработки;
 *   SameSite=Lax — чужой сайт не может отправить запрос с нашей cookie (это
 *   первый рубеж от CSRF, второй — заголовок и Origin в miniapp.js).
 */
function setCookie(token, { secure = true } = {}) {
  return `${COOKIE}=${token}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}
function clearCookie({ secure = true } = {}) {
  return `${COOKIE}=; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=0`;
}

module.exports = {
  LOGIN_TTL_MS, SESSION_TTL_MS, SESSION_MAX_AGE, COOKIE, NONCE_RE, TOKEN_RE, LOGIN_ID_RE,
  startLogin, previewLogin, pendingById, confirmLogin, answerLogin, denyLogin, checkLogin, migrate,
  sessionFor, logoutToken, logoutAll, listSessions, purge,
  tokenFromCookie, setCookie, clearCookie,
  shortUa, cleanUa, sha,
  startTooOften, checkTooOften, checkIpTooOften, resetLimits,
};
