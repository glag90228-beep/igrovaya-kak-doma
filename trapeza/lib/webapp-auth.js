'use strict';

/**
 * Проверка подлинности пользователя мини-приложения Telegram.
 *
 * Мини-апп открывается обычным браузером внутри Telegram, и запросы к нашему
 * API идут из JavaScript — то есть подделать их может кто угодно. Единственное
 * доказательство «это правда пользователь N» — строка initData, которую
 * Telegram кладёт в окно приложения и подписывает ключом, выведенным из токена
 * бота. Проверяем подпись сами, серверу верить нельзя ничему остальному:
 * ни заголовкам, ни переданному в теле tg_id.
 *
 * Порядок проверки (по документации Bot API):
 *   1) из строки убираем hash, остальные пары сортируем по ключу
 *      и склеиваем как «key=value» через перевод строки;
 *   2) секрет = HMAC-SHA256(токен бота) с ключом «WebAppData»;
 *   3) HMAC-SHA256 полученной строки этим секретом должен совпасть с hash.
 *
 * Дополнительно смотрим на возраст: подпись вечна, поэтому перехваченный
 * initData годился бы всегда. Ограничиваем сутками (WEBAPP_TTL, секунды).
 */

const crypto = require('node:crypto');

const DEFAULT_TTL = 24 * 60 * 60; // сутки

/** Секрет выводится из токена один раз на токен — считаем и запоминаем. */
const secretCache = new Map();
function secretKey(token) {
  let key = secretCache.get(token);
  if (!key) {
    key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    secretCache.set(token, key);
  }
  return key;
}

/** Сравнение подписей постоянного времени: длины могут отличаться. */
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Разбирает и проверяет initData.
 *
 * @param {string} initData строка из Telegram.WebApp.initData
 * @param {object} opts { token, ttl, now } — токен бота обязателен
 * @returns {{ok:true, user:object, authDate:number, raw:object}
 *          |{ok:false, reason:string}}
 */
function verifyInitData(initData, opts = {}) {
  const token = opts.token || process.env.BOT_TOKEN || '';
  if (!token) return { ok: false, reason: 'на сервере не задан BOT_TOKEN' };
  if (!initData || typeof initData !== 'string') return { ok: false, reason: 'нет initData' };
  if (initData.length > 8192) return { ok: false, reason: 'initData неправдоподобно длинная' };

  let params;
  try { params = new URLSearchParams(initData); } catch (_) {
    return { ok: false, reason: 'initData не разбирается' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'в initData нет подписи' };

  // Все поля, кроме hash, — в проверочную строку. Поле signature (появилось
  // для сторонней проверки по Ed25519) Telegram тоже подписывает, поэтому
  // убирать его нельзя: строка перестанет сходиться.
  const pairs = [];
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();

  const mine = crypto.createHmac('sha256', secretKey(token))
    .update(pairs.join('\n')).digest('hex');
  if (!sameHash(mine, hash)) return { ok: false, reason: 'подпись не сходится' };

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate) return { ok: false, reason: 'нет auth_date' };
  const ttl = Number(opts.ttl || process.env.WEBAPP_TTL || DEFAULT_TTL);
  const now = Math.floor((opts.now || Date.now()) / 1000);
  // Заглядывать в будущее тоже незачем: расхождение часов больше минуты —
  // повод не доверять, а не молча пропустить.
  if (authDate > now + 60) return { ok: false, reason: 'auth_date из будущего' };
  if (ttl > 0 && now - authDate > ttl) return { ok: false, reason: 'ссылка устарела, откройте приложение заново' };

  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (_) { user = null; }
  if (!user || !Number.isFinite(Number(user.id))) {
    return { ok: false, reason: 'в initData нет пользователя' };
  }

  const raw = {};
  for (const [key, value] of params) raw[key] = value;
  return {
    ok: true,
    authDate,
    user: {
      id: Number(user.id),
      first_name: String(user.first_name || ''),
      last_name: String(user.last_name || ''),
      username: String(user.username || ''),
      language_code: String(user.language_code || ''),
      is_premium: Boolean(user.is_premium),
    },
    raw,
  };
}

/**
 * Достаёт initData из запроса. Класть её в строку адреса не хочется —
 * адреса оседают в логах nginx, — поэтому основной путь заголовок
 * «Authorization: tma <initData>», как советует документация.
 */
function initDataFrom(req) {
  const auth = String((req.headers || {}).authorization || '');
  const m = /^tma\s+(.+)$/i.exec(auth);
  if (m) return m[1];
  const own = (req.headers || {})['x-telegram-init-data'];
  return own ? String(own) : '';
}

module.exports = { verifyInitData, initDataFrom, DEFAULT_TTL };
