'use strict';

/**
 * Факсимиле: подпись и печать на документах.
 *
 * Бухгалтер отправляет клиенту счёт, который уже выглядит подписанным, —
 * иначе документ приходится печатать, подписывать, сканировать и слать
 * заново. Здесь хранение картинок и их наложение на готовый документ.
 *
 * Две вещи, которые решают, будет это выглядеть прилично или нет:
 *
 * 1. Подпись почти всегда снята телефоном с белого листа, то есть приходит
 *    непрозрачный белый прямоугольник. Вырезать фон по-настоящему нечем
 *    (сторонних библиотек в проекте нет), но и не требуется: в печати
 *    работает mix-blend-mode: multiply — белое становится невидимым, а
 *    тёмные штрихи остаются. Заодно поднимаем контраст, чтобы серая
 *    бумага не превращалась в грязное пятно.
 *
 * 2. Печать должна лежать поверх подписи и слегка левее, как в жизни, и
 *    не должна разъезжать вёрстку — поэтому обе картинки абсолютные и
 *    висят над линией подписи, не занимая места в потоке.
 *
 * Правовая сторона: факсимиле на счёте и акте — обычная практика, но
 * это не электронная подпись. На документах, где закон требует
 * собственноручной подписи, ставить его нельзя, поэтому есть режим
 * «только закрывающие» и полное выключение.
 */

const { db } = require('../db');

// Колонка fx_scope живёт в bot_users, а её создаёт bot-db при загрузке.
// Требуем его явно: иначе модуль, подключённый первым, упадёт на ALTER.
require('./bot-db');

const KINDS = ['sign', 'stamp'];
const MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 1024 * 1024; // 1 МБ: подписи столько не нужно, а память бережёт

/** Куда ставить факсимиле. */
const SCOPES = {
  all: 'на все документы',
  closing: 'только на закрывающие (акт, УПД, ТОРГ-12)',
  off: 'никуда — документы без факсимиле',
};

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS facsimile (
      user_id    INTEGER NOT NULL,
      kind       TEXT    NOT NULL,          -- sign | stamp
      mime       TEXT    NOT NULL,
      bytes      BLOB    NOT NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
  `);
  const cols = db.prepare('PRAGMA table_info(bot_users)').all().map((c) => c.name);
  if (!cols.includes('fx_scope')) {
    db.exec("ALTER TABLE bot_users ADD COLUMN fx_scope TEXT NOT NULL DEFAULT 'all'");
  }
}
migrate();

/** @returns {{ok:true}|{ok:false, error:string}} */
function save(userId, kind, buffer, mime) {
  if (!KINDS.includes(kind)) return { ok: false, error: 'Неизвестный вид изображения.' };
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!bytes.length) return { ok: false, error: 'Пустой файл.' };
  if (bytes.length > MAX_BYTES) {
    return { ok: false, error: `Файл больше ${Math.round(MAX_BYTES / 1024)} КБ — пришлите поменьше.` };
  }
  // Тип определяем ТОЛЬКО по байтам. Заявленному типу доверять нельзя:
  // и браузер, и Telegram передают его со слов отправителя, а короткий
  // мусор с подписью «image/png» иначе попал бы в документ как картинка.
  const type = sniff(bytes);
  if (!type) {
    return { ok: false, error: 'Нужна картинка PNG, JPEG или WebP — этот файл не похож ни на одну из них.' };
  }
  db.prepare(`
    INSERT INTO facsimile(user_id, kind, mime, bytes, created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id, kind) DO UPDATE SET mime = excluded.mime,
      bytes = excluded.bytes, created_at = excluded.created_at
  `).run(userId, kind, type, bytes, new Date().toISOString());
  return { ok: true, mime: type, size: bytes.length };
}

/**
 * Тип определяем по самим байтам, а не по заявленному mime: браузер и
 * Telegram присылают что угодно, а в документ пойдёт то, что внутри.
 */
function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function get(userId, kind) {
  return db.prepare('SELECT * FROM facsimile WHERE user_id = ? AND kind = ?').get(userId, kind) || null;
}

function remove(userId, kind) {
  const info = db.prepare('DELETE FROM facsimile WHERE user_id = ? AND kind = ?').run(userId, kind);
  return info.changes > 0;
}

function scopeOf(userId) {
  const row = db.prepare('SELECT fx_scope FROM bot_users WHERE id = ?').get(userId);
  const s = row && row.fx_scope;
  return SCOPES[s] ? s : 'all';
}

function setScope(userId, scope) {
  if (!SCOPES[scope]) return false;
  db.prepare('UPDATE bot_users SET fx_scope = ? WHERE id = ?').run(scope, userId);
  return true;
}

const dataUri = (row) => `data:${row.mime};base64,${Buffer.from(row.bytes).toString('base64')}`;

/**
 * Документы, на которые факсимиле не ставится ни при каких настройках:
 * платёжку подписывают в банке живой подписью, а факсимиле на договоре
 * по статье 160 ГК действительно только если стороны заранее об этом
 * договорились письменно — по умолчанию так считать нельзя.
 */
const NEVER = ['pp', 'dog'];

/** Ставится ли факсимиле на документ такого типа. */
function appliesTo(scope, docType) {
  if (NEVER.includes(docType)) return false;
  if (scope === 'off') return false;
  if (scope === 'closing') return ['usl', 'upd', 'torg12'].includes(docType);
  return true;
}

/**
 * Готовит картинки для шаблона документа.
 * @returns {{sign?:string, stamp?:string}} data-URI, пустой объект — не ставим
 */
function forDocument(userId, docType) {
  if (!appliesTo(scopeOf(userId), docType)) return {};
  const out = {};
  const sign = get(userId, 'sign');
  const stamp = get(userId, 'stamp');
  if (sign) out.sign = dataUri(sign);
  if (stamp) out.stamp = dataUri(stamp);
  return out;
}

module.exports = {
  KINDS, MIMES, MAX_BYTES, SCOPES,
  save, get, remove, scopeOf, setScope, forDocument, appliesTo, dataUri, sniff,
};
