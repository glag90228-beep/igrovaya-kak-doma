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
 * Ключ берётся из MAIL_KEY. Если его не задали, выводим из BOT_TOKEN —
 * так работает «из коробки», но при смене токена старые записи перестанут
 * читаться, о чём и написано в подсказке.
 */

const crypto = require('node:crypto');

const PREFIX = 'v1';

function keyMaterial() {
  const explicit = String(process.env.MAIL_KEY || '').trim();
  if (explicit) return `k:${explicit}`;
  const token = String(process.env.BOT_TOKEN || '').trim();
  if (token) return `t:${token}`;
  return '';
}

const cache = new Map();
function key() {
  const material = keyMaterial();
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

/** @returns {string|null} null — если ключ сменился или значение испорчено */
function open(sealed) {
  const k = key();
  if (!k || !sealed) return null;
  const parts = String(sealed).split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(parts[1], 'base64url'));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8');
  } catch (_) {
    return null;                       // подмена, порча или другой ключ
  }
}

module.exports = { seal, open, canEncrypt };
