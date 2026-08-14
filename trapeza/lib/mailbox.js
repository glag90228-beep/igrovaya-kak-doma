'use strict';

/**
 * Почтовый ящик клиента.
 *
 * Почему письма уходят из ящика клиента, а не из нашего. Если слать всё
 * с одного адреса, получатель видит письмо не от той компании; почтовые
 * серверы проверяют, вправе ли отправитель писать от этого домена, и
 * складывают такие письма в спам; а один ящик на сотню клиентов Яндекс и
 * mail.ru блокируют за рассылку. Плюс юридически отправителем становимся мы,
 * хотя документ чужой.
 *
 * Поэтому клиент один раз подключает свой ящик, и дальше счёт уходит с его
 * настоящего адреса — мы только инструмент.
 *
 * Пароль хранится зашифрованным (lib/crypto-box.js) и наружу не отдаётся
 * никогда: ни в API, ни в интерфейсе, ни в ошибках. Заменить можно,
 * посмотреть — нет.
 */

const { db } = require('../db');
require('./bot-db');                   // таблицы создаёт он, порядок важен
const { seal, open, canEncrypt } = require('./crypto-box');
const { validEmail } = require('./mail');

db.exec(`
  CREATE TABLE IF NOT EXISTS mailboxes (
    user_id    INTEGER PRIMARY KEY,
    host       TEXT NOT NULL,
    port       INTEGER NOT NULL,
    secure     INTEGER NOT NULL DEFAULT 1,
    login      TEXT NOT NULL,
    pass_enc   TEXT NOT NULL,
    from_addr  TEXT NOT NULL,
    from_name  TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
`);

/**
 * Готовые настройки популярных почт: человеку остаётся ввести адрес и
 * пароль приложения, а не разбираться, что такое STARTTLS.
 */
const PRESETS = {
  yandex: { title: 'Яндекс', host: 'smtp.yandex.ru', port: 465, secure: true,
    hint: 'Нужен пароль приложения: id.yandex.ru → Безопасность → Пароли приложений → Почта.' },
  mailru: { title: 'Mail.ru', host: 'smtp.mail.ru', port: 465, secure: true,
    hint: 'Нужен пароль для внешнего приложения: id.mail.ru → Безопасность → Пароли для внешних приложений.' },
  gmail: { title: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false,
    hint: 'Нужен пароль приложения и включённая двухфакторная защита в аккаунте Google.' },
  rambler: { title: 'Рамблер', host: 'smtp.rambler.ru', port: 465, secure: true,
    hint: 'Пароль обычный, от почты.' },
  custom: { title: 'Другой', host: '', port: 465, secure: true,
    hint: 'Понадобятся адрес SMTP-сервера и порт — их даёт ваш почтовый провайдер.' },
};

/** Угадываем поставщика по адресу: одно нажатие вместо выбора из списка. */
function guessPreset(email) {
  const d = String(email || '').split('@')[1] || '';
  if (/yandex|ya\.ru|narod/i.test(d)) return 'yandex';
  if (/mail\.ru|inbox\.ru|list\.ru|bk\.ru|internet\.ru/i.test(d)) return 'mailru';
  if (/gmail|googlemail/i.test(d)) return 'gmail';
  if (/rambler|lenta\.ru|autorambler/i.test(d)) return 'rambler';
  return 'custom';
}

function get(userId) {
  return db.prepare('SELECT * FROM mailboxes WHERE user_id = ?').get(userId) || null;
}

function has(userId) {
  return Boolean(get(userId));
}

/** Что можно показать человеку: всё, кроме пароля. */
function info(userId) {
  const m = get(userId);
  if (!m) return null;
  return {
    host: m.host,
    port: m.port,
    secure: Boolean(m.secure),
    login: m.login,
    from: m.from_addr,
    fromName: m.from_name,
    checkedAt: m.checked_at,
  };
}

/** @returns {{ok:true}|{ok:false, error:string}} */
function save(userId, {
  preset, host, port, secure, login, pass, from, fromName,
}) {
  if (!canEncrypt()) {
    return { ok: false, error: 'на сервере нечем шифровать пароль — не задан MAIL_KEY.' };
  }
  const p = PRESETS[preset] || PRESETS.custom;
  const addr = String(from || login || '').trim().toLowerCase();
  if (!validEmail(addr)) return { ok: false, error: 'Адрес почты выглядит неправильно.' };
  const useHost = String(host || p.host || '').trim();
  if (!useHost) return { ok: false, error: 'Не указан адрес SMTP-сервера.' };
  if (!String(pass || '')) return { ok: false, error: 'Не указан пароль.' };

  db.prepare(`
    INSERT INTO mailboxes(user_id, host, port, secure, login, pass_enc, from_addr, from_name, created_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET host=excluded.host, port=excluded.port,
      secure=excluded.secure, login=excluded.login, pass_enc=excluded.pass_enc,
      from_addr=excluded.from_addr, from_name=excluded.from_name, checked_at=''
  `).run(userId, useHost, Number(port || p.port) || 465,
    (secure == null ? p.secure : Boolean(secure)) ? 1 : 0,
    String(login || addr).trim(), seal(String(pass)), addr,
    String(fromName || '').trim(), new Date().toISOString());
  return { ok: true };
}

function remove(userId) {
  return db.prepare('DELETE FROM mailboxes WHERE user_id = ?').run(userId).changes > 0;
}

function markChecked(userId) {
  db.prepare('UPDATE mailboxes SET checked_at = ? WHERE user_id = ?')
    .run(new Date().toISOString(), userId);
}

/**
 * Настройки для отправки от имени пользователя.
 *
 * Общий серверный ящик подставляется только при SMTP_SHARED=1 — по
 * умолчанию нет: письма всех клиентов с одного адреса это спам-папка,
 * блокировка ящика и мы в роли отправителя чужих документов.
 *
 * @returns {{ok:true, options:object, own:boolean}|{ok:false, reason:string}}
 */
function resolve(userId) {
  const m = get(userId);
  if (m) {
    const pass = open(m.pass_enc);
    if (pass == null) {
      return { ok: false, reason: 'Пароль от ящика не читается — подключите почту заново.' };
    }
    return {
      ok: true,
      own: true,
      options: {
        host: m.host,
        port: m.port,
        secure: Boolean(m.secure),
        user: m.login,
        pass,
        from: m.from_addr,
        fromName: m.from_name,
      },
    };
  }
  if (String(process.env.SMTP_SHARED || '') === '1' && process.env.SMTP_HOST) {
    return { ok: true, own: false, options: {} };   // возьмётся из окружения
  }
  return { ok: false, reason: 'Почта не подключена — подключите свой ящик в разделе «Моя организация».' };
}

module.exports = { PRESETS, guessPreset, get, has, info, save, remove, markChecked, resolve };
