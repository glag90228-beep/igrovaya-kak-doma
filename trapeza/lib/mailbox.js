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

const dns = require('node:dns').promises;
const net = require('node:net');

const { db } = require('../db');
require('./bot-db');                   // таблицы создаёт он, порядок важен
const { seal, openBox, canEncrypt } = require('./crypto-box');
const { validEmail } = require('./mail');

/*
 * Куда разрешено ходить за почтой.
 *
 * Адрес сервера человек вводит сам — по-другому нельзя, ящики у всех разные.
 * Но без проверки это готовый сканер: подставив 127.0.0.1 и перебирая порты,
 * посторонний по разнице ответа («соединение отвергнуто» за 4 мс против
 * «сервер не отвечает» за 3 с) вычислял, что крутится на нашей машине, а
 * ответившая строкой служба возвращала ему свой баннер прямо в ошибке API.
 *
 * Поэтому: только почтовые порты и только внешние адреса.
 */
const MAIL_PORTS = new Set([25, 143, 465, 587, 993, 2525]);

/** Внутренний ли адрес: петля, частные сети, link-local, свои IPv6. */
function isPrivateIp(ip) {
  const v = String(ip || '');
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 10 || a === 127 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)   // CGNAT
      || a >= 224;                            // multicast и выше
  }
  const low = v.toLowerCase().replace(/^\[|\]$/g, '');
  if (low === '::1' || low === '::' || low.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(low)) return true;          // уникальные локальные
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);      // IPv4 в обёртке IPv6
  return m ? isPrivateIp(m[1]) : false;
}

/**
 * Пускать ли к этому серверу. Резолвим имя: проверять одну лишь строку
 * бессмысленно — «localtest.me» и свой домен с записью на 127.0.0.1 обойдут
 * любой список запрещённых слов.
 *
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
async function hostAllowed(host, port) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return { ok: false, error: 'Не указан адрес почтового сервера.' };
  /*
   * Калитка только для прогонов: inbox-selftest поднимает игрушечные SMTP и
   * IMAP на 127.0.0.1 со случайным портом. В окружении боевого сервера этой
   * переменной нет и быть не должно — с ней проверка выключается целиком.
   */
  if (process.env.MAIL_ALLOW_LOCAL === '1') return { ok: true };
  if (port != null && !MAIL_PORTS.has(Number(port))) {
    return { ok: false, error: `Порт ${port} для почты не используется. Обычно это 465, 587 или 993.` };
  }
  if (net.isIP(h)) {
    return isPrivateIp(h)
      ? { ok: false, error: 'Это адрес внутренней сети — почтовый сервер должен быть внешним.' }
      : { ok: true };
  }
  let addrs = [];
  try {
    addrs = await dns.lookup(h, { all: true });
  } catch (_) {
    return { ok: false, error: `Не нашёл сервер ${host} — проверьте адрес.` };
  }
  if (!addrs.length) return { ok: false, error: `Не нашёл сервер ${host} — проверьте адрес.` };
  if (addrs.some((a) => isPrivateIp(a.address))) {
    return { ok: false, error: 'Этот адрес ведёт во внутреннюю сеть — почтовый сервер должен быть внешним.' };
  }
  return { ok: true };
}

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

// Чтение входящих добавили позже — дописываем колонки к существующим ящикам.
for (const [name, def] of [['imap_host', "TEXT NOT NULL DEFAULT ''"],
  ['imap_port', 'INTEGER NOT NULL DEFAULT 993'],
  ['last_uid', 'INTEGER NOT NULL DEFAULT 0']]) {
  const cols = db.prepare('PRAGMA table_info(mailboxes)').all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE mailboxes ADD COLUMN ${name} ${def}`);
}

/**
 * Готовые настройки популярных почт: человеку остаётся ввести адрес и
 * пароль приложения, а не разбираться, что такое STARTTLS.
 */
/*
 * Пути к паролям даём ссылкой, а не описанием меню.
 *
 * Почтовые сервисы переставляют настройки чаще, чем выходят наши обновления:
 * инструкция «id.mail.ru → Безопасность → Пароли для внешних приложений»
 * привела живого клиента на страницу VK ID, где такого пункта нет вовсе.
 * Прямая ссылка ведёт куда надо независимо от того, как сегодня называются
 * разделы, и открывается одним нажатием прямо из чата.
 */
const PRESETS = {
  yandex: { title: 'Яндекс', host: 'smtp.yandex.ru', port: 465, secure: true,
    imapHost: 'imap.yandex.ru', imapPort: 993,
    passUrl: 'https://id.yandex.ru/security/app-passwords',
    hint: 'Обычный пароль от почты не подойдёт — Яндекс его для программ закрыл. '
      + 'Нужен пароль приложения: по кнопке ниже → «Создать пароль» → выберите «Почта».' },
  mailru: { title: 'Mail.ru', host: 'smtp.mail.ru', port: 465, secure: true,
    imapHost: 'imap.mail.ru', imapPort: 993,
    passUrl: 'https://account.mail.ru/user/2-step-auth/passwords',
    hint: 'Обычный пароль от почты не подойдёт. Нужен пароль для внешнего приложения: '
      + 'по кнопке ниже → «Добавить» → название любое. Если попросит включить '
      + 'двухфакторную защиту — включите, без неё Mail.ru пароли не выдаёт.' },
  gmail: { title: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false,
    imapHost: 'imap.gmail.com', imapPort: 993,
    passUrl: 'https://myaccount.google.com/apppasswords',
    hint: 'Нужен пароль приложения. Он доступен только при включённой '
      + 'двухфакторной защите аккаунта Google.' },
  rambler: { title: 'Рамблер', host: 'smtp.rambler.ru', port: 465, secure: true,
    imapHost: 'imap.rambler.ru', imapPort: 993,
    passUrl: 'https://mail.rambler.ru/settings/mailapps',
    hint: 'Пароль обычный, от почты. Но в настройках нужно разрешить доступ '
      + 'почтовым программам — кнопка ниже.' },
  custom: { title: 'Другой', host: '', port: 465, secure: true,
    imapHost: '', imapPort: 993, passUrl: '',
    hint: 'Пароль тот же, что и от почты. Если провайдер требует отдельный пароль '
      + 'для почтовых программ — возьмите его в своей панели управления.' },
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
    imapHost: m.imap_host,
    imapPort: m.imap_port,
    canRead: Boolean(m.imap_host),
  };
}

/**
 * Асинхронный, потому что адрес сервера приходится резолвить: строку
 * проверять бесполезно, имя может указывать куда угодно, в том числе внутрь.
 *
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
async function save(userId, {
  preset, host, port, secure, login, pass, from, fromName, imapHost, imapPort,
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

  const usePort = Number(port || p.port) || 465;
  const useImap = String(imapHost || p.imapHost || '').trim();
  const useImapPort = Number(imapPort || p.imapPort) || 993;
  const okSmtp = await hostAllowed(useHost, usePort);
  if (!okSmtp.ok) return okSmtp;
  if (useImap) {
    const okImap = await hostAllowed(useImap, useImapPort);
    if (!okImap.ok) return okImap;
  }

  db.prepare(`
    INSERT INTO mailboxes(user_id, host, port, secure, login, pass_enc, from_addr,
                          from_name, imap_host, imap_port, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET host=excluded.host, port=excluded.port,
      secure=excluded.secure, login=excluded.login, pass_enc=excluded.pass_enc,
      from_addr=excluded.from_addr, from_name=excluded.from_name,
      imap_host=excluded.imap_host, imap_port=excluded.imap_port, checked_at=''
  `).run(userId, useHost, usePort,
    (secure == null ? p.secure : Boolean(secure)) ? 1 : 0,
    String(login || addr).trim(), seal(String(pass)), addr,
    String(fromName || '').trim(),
    useImap, useImapPort,
    new Date().toISOString());
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
/*
 * Пароль из записи — с тихим переходом на новый ключ.
 *
 * Когда на сервере с уже подключёнными ящиками задают свой MAIL_KEY, старые
 * пароли зашифрованы ключом из токена. Расшифровка их всё равно прочитает
 * (crypto-box пробует и прежний ключ), но оставлять запись в старом виде
 * нельзя: тогда отзыв токена однажды сломает всё ровно так же, как и до
 * перехода. Поэтому прочитанное прежним ключом сразу перекладываем нынешним.
 *
 * Неудача перешифровки не мешает работе: пароль мы уже прочитали, письмо
 * уйдёт, а перевод повторится при следующем обращении.
 */
function passOf(m) {
  const got = openBox(m.pass_enc);
  if (got.value != null && got.stale && canEncrypt()) {
    try {
      db.prepare('UPDATE mailboxes SET pass_enc = ? WHERE user_id = ?')
        .run(seal(got.value), m.user_id);
    } catch (_) { /* перевести не вышло — прочитать всё равно смогли */ }
  }
  return got.value;
}

function resolve(userId) {
  const m = get(userId);
  if (m) {
    const pass = passOf(m);
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

/**
 * Настройки для чтения входящих. Отдельно от отправки: сервер другой,
 * и у своего домена IMAP может быть не поднят вовсе.
 */
function resolveImap(userId) {
  const m = get(userId);
  if (!m) return { ok: false, reason: 'Почта не подключена.' };
  if (!m.imap_host) {
    return { ok: false, reason: 'Для этого ящика не задан сервер входящей почты (IMAP).' };
  }
  const pass = passOf(m);
  if (pass == null) return { ok: false, reason: 'Пароль от ящика не читается — подключите почту заново.' };
  return {
    ok: true,
    config: { host: m.imap_host, port: m.imap_port || 993, secure: true, user: m.login, pass },
    lastUid: m.last_uid || 0,
  };
}

function setLastUid(userId, uid) {
  db.prepare('UPDATE mailboxes SET last_uid = ? WHERE user_id = ? AND last_uid < ?')
    .run(Number(uid) || 0, userId, Number(uid) || 0);
}

module.exports = {
  PRESETS, guessPreset, get, has, info, save, remove, markChecked, resolve,
  resolveImap, setLastUid,
};
