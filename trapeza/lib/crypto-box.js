'use strict';

/**
 * Шифрование чувствительных значений в базе — сейчас это пароли от почтовых
 * ящиков клиентов.
 *
 * Что это защищает и чего не защищает — важно понимать честно:
 *
 *   защищает: копию базы. Файл `trapeza.db` попал в резервную копию, в чужие
 *             руки, в чат поддержки — паролей в нём нет, только шифротекст;
 *   не защищает: от того, у кого есть доступ к серверу целиком. Ключ лежит
 *             там же, иначе бот не смог бы отправлять почту без участия
 *             человека при каждом старте.
 *
 * Второе — не недоработка, а следствие задачи: письма уходят автоматически,
 * значит ключ должен быть у машины. Уменьшать ущерб от утечки базы — уже
 * много, и это ровно то, ради чего это здесь.
 *
 * Алгоритм AES-256-GCM: он не только скрывает содержимое, но и ловит
 * подмену — расшифровка чужого или испорченного значения не «вернёт мусор»,
 * а честно провалится.
 *
 * Ключ берётся из MAIL_KEY. Если его не задали, выводим из BOT_TOKEN — так
 * работает «из коробки», но у этого удобства есть цена, и она выясняется в
 * худший момент. Утёк токен — его отзывают первым же делом, а вместе с ним
 * становятся нечитаемыми пароли всех подключённых ящиков; вернуть старый
 * токен уже нельзя, и каждому клиенту придётся подключать почту заново.
 * Поэтому о запасном ключе предупреждаем в журнал при первом же обращении.
 */

const crypto = require('node:crypto');

const PREFIX = 'v1';

let warned = false;

/** Чем шифруем сейчас: свой ключ, если задан, иначе запасной из токена. */
function keyMaterial() {
  const explicit = String(process.env.MAIL_KEY || '').trim();
  if (explicit) return `k:${explicit}`;
  const token = String(process.env.BOT_TOKEN || '').trim();
  if (token) {
    /*
     * О запасном ключе говорим вслух — один раз за запуск.
     *
     * Молчаливость тут дорого стоит. Всё работает как ни в чём не бывало, и
     * узнают об этом в самый неподходящий момент: токен утёк, его первым
     * делом отзывают — и вместе с ним становятся нечитаемыми пароли всех
     * подключённых ящиков. Каждому клиенту придётся подключать почту заново,
     * причём выяснится это уже после отзыва, когда вернуть старый токен
     * нельзя.
     */
    if (!warned) {
      warned = true;
      console.warn('⚠️  MAIL_KEY не задан — пароли ящиков зашифрованы ключом из BOT_TOKEN. '
        + 'Отзыв токена сделает их нечитаемыми. Задайте MAIL_KEY: openssl rand -base64 32');
    }
    return `t:${token}`;
  }
  return '';
}

const cache = new Map();
function keyFrom(material) {
  if (!material) return null;
  let k = cache.get(material);
  if (!k) {
    // scrypt, а не «взять первые 32 байта»: так подбор по словарю дорогой,
    // даже если ключом окажется что-то короткое.
    k = crypto.scryptSync(material, 'pervichka-mailbox', 32);
    cache.set(material, k);
  }
  return k;
}

const key = () => keyFrom(keyMaterial());

/**
 * Чем пробуем расшифровать: сначала нынешним ключом, потом прежним.
 *
 * Нужно ради одного перехода — когда MAIL_KEY задают на сервере, где ящики
 * уже подключены. Их пароли зашифрованы ключом из токена, и без этой
 * попытки они разом перестали бы читаться: каждому клиенту пришлось бы
 * подключать почту заново. То есть верный совет «задайте свой ключ»
 * наказывал бы того, кто ему последовал.
 *
 * Перебор здесь безопасен: AES-GCM проверяет метку подлинности, поэтому
 * чужой ключ даёт честный отказ, а не правдоподобный мусор. И порядок
 * важен — сначала нынешний, чтобы уже переведённые записи не трогали
 * запасной ключ лишний раз.
 */
function openMaterials() {
  const now = keyMaterial();
  const token = String(process.env.BOT_TOKEN || '').trim();
  const legacy = token ? `t:${token}` : '';
  const list = [];
  if (now) list.push(now);
  if (legacy && legacy !== now) list.push(legacy);
  return list;
}

const canEncrypt = () => Boolean(key());

/** @returns {string} «v1.iv.tag.данные» в base64url, либо бросает */
function seal(plain) {
  const k = key();
  if (!k) throw new Error('нечем шифровать: задайте MAIL_KEY или BOT_TOKEN');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [PREFIX, iv.toString('base64url'), c.getAuthTag().toString('base64url'),
    data.toString('base64url')].join('.');
}

/**
 * Расшифровать и заодно сказать, каким ключом получилось.
 *
 * @returns {{value: string|null, stale: boolean}} stale — прочитано прежним
 *   ключом, значит запись стоит перешифровать нынешним. Без этого зависимость
 *   от токена осталась бы навсегда, и его отзыв однажды сломал бы всё ровно
 *   так же, как и до перехода.
 */
function openBox(sealed) {
  if (!sealed) return { value: null, stale: false };
  const parts = String(sealed).split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return { value: null, stale: false };
  const list = openMaterials();
  for (let i = 0; i < list.length; i += 1) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(list[i]),
        Buffer.from(parts[1], 'base64url'));
      d.setAuthTag(Buffer.from(parts[2], 'base64url'));
      const v = Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8');
      return { value: v, stale: i > 0 };
    } catch (_) { /* не этот ключ — пробуем следующий */ }
  }
  return { value: null, stale: false };  // подмена, порча или ключ утрачен
}

/** @returns {string|null} null — если ключ утрачен или значение испорчено */
const open = (sealed) => openBox(sealed).value;

module.exports = { seal, open, openBox, canEncrypt };
