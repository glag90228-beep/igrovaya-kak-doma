'use strict';

/**
 * Вход на сайт: то, что видит человек в боте.
 *
 * Сайт показывает ссылку t.me/<бот>?start=login_<nonce>. Человек открывает её,
 * бот спрашивает «это вы?», и ответ «Да» — единственное место, где личность
 * подтверждается. Всё решение о том, можно ли подтверждать, принимает база
 * (lib/web-auth.js, условия прямо в UPDATE); здесь только слова и кнопки.
 *
 * Про уговор. Главная опасность такого входа — не взлом, а обман: злоумышленник
 * открывает сайт у себя, присылает жертве ссылку «посмотри, что это» и ждёт,
 * что та нажмёт «Да». Поэтому вместо «Да» человеку даны три числа, и верное —
 * то, что крупно написано на экране сайта. Кто не видел экрана, угадывает
 * один раз из трёх, а ошибка отменяет вход навсегда (lib/web-auth.js).
 * Сообщение при этом называет браузер и время и просит не пересылать его.
 */

const webAuth = require('./web-auth');
const { keyboard } = require('./tg');

const NOT_ACTUAL = 'Ссылка устарела. Начните вход на сайте заново.';

/** «14:05» и «17.10» по Москве: как и везде в проекте, пояс сервера значения не имеет. */
function msk(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { time: '', date: '' };
  const part = (opts) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', ...opts });
  return {
    time: part({ hour: '2-digit', minute: '2-digit' }),
    date: part({ day: '2-digit', month: '2-digit' }),
  };
}

/**
 * Только личная переписка. В общем чате «Да» мог бы нажать любой участник, и
 * вход подтвердил бы не тот, кто открывал сайт.
 */
const PRIVATE_ONLY = 'Вход подтверждается только в личной переписке с ботом. Откройте бота и повторите.';
const isGroup = (chat) => Boolean(chat && chat.type && chat.type !== 'private');

/** Человек открыл ссылку входа: показать три числа и спросить, какое на экране сайта. */
async function offer(tg, chat, nonce) {
  const chatId = chat.id;
  if (isGroup(chat)) { await tg.sendMessage(chatId, PRIVATE_ONLY); return; }
  const pre = webAuth.previewLogin(nonce);
  if (!pre) {
    await tg.sendMessage(chatId, NOT_ACTUAL);
    return;
  }
  const when = msk(pre.createdAt);   // когда нажали «Войти» на сайте, а не когда открыли бота
  await tg.sendMessage(chatId,
    '🔐 <b>Вход в Первичку на сайте.</b>\n\n'
    + `Браузер: <b>${pre.shortUa}</b>, время: <b>${when.time}</b> (по Москве).\n\n`
    + 'Если это вы — нажмите число, которое сейчас крупно написано на экране сайта.\n'
    + 'Если вы ничего не нажимали на сайте — нажмите «Нет» и никому не пересылайте это сообщение.',
    keyboard([
      // В данных кнопки — её номер и идентификатор входа, не число и не nonce:
      // по ним нельзя ни угадать ответ, ни выпустить сессию.
      pre.choices.map((n, i) => ({ text: String(n), data: `wl.n${i}:${pre.id}` })),
      [{ text: '❌ Нет', data: `wl.no:${pre.id}` }],
    ]));
}

/** Кнопки под вопросом убираем: решённый вход нажимать повторно незачем. Не вышло — не страшно. */
async function dropButtons(tg, chatId, messageId) {
  if (!messageId) return;
  try {
    await tg.call('editMessageReplyMarkup', {
      chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
    });
  } catch (_) { /* сообщение старое или уже без кнопок */ }
}

/**
 * Нажатие на число или на «Нет».
 * Подтверждает тот, кто нажал: его номер Telegram присылает сам, подделать
 * его из чужого чата нельзя. Любые другие данные кнопки (в том числе от
 * сообщений прежней версии, где было «Да, это я») — «ссылка устарела».
 */
async function answer(tg, chat, user, data, messageId, menu) {
  const chatId = chat.id;
  if (isGroup(chat)) { await tg.sendMessage(chatId, PRIVATE_ONLY); return; }
  const m = /^wl\.(?:n([0-2])|(no)):([0-9a-f]{20})$/.exec(data);
  if (!m) { await tg.sendMessage(chatId, NOT_ACTUAL, menu); return; }
  await dropButtons(tg, chatId, messageId);

  if (m[2]) {
    if (!webAuth.denyLogin(m[3])) { await tg.sendMessage(chatId, NOT_ACTUAL, menu); return; }
    await tg.sendMessage(chatId,
      'Хорошо, вход отклонил.\n\n'
      + 'Если вы ничего не делали на сайте, вам могли прислать эту ссылку с умыслом: '
      + 'не нажимайте числа по чужой просьбе и никому не пересылайте такие сообщения.', menu);
    return;
  }

  const res = webAuth.answerLogin(m[3], Number(m[1]), user.id);
  if (res === 'ok') {
    await tg.sendMessage(chatId,
      '✅ Вход подтверждён. Вернитесь на сайт — он откроется сам, это займёт пару секунд.\n\n'
      + 'Закрыть доступ с любого браузера можно в «Ещё» → «Сеансы на сайте».', menu);
  } else if (res === 'wrong') {
    await tg.sendMessage(chatId,
      '⛔ Число не совпало — вход отменён.\n\n'
      + 'Если вы не начинали вход на сайте, кто-то пытался зайти в ваш аккаунт — '
      + 'ничего не делайте и никому не пересылайте такие сообщения.', menu);
  } else {
    await tg.sendMessage(chatId, NOT_ACTUAL, menu);
  }
}

/** «Сеансы на сайте»: где открыт вход и кнопка закрыть всё. */
async function sessions(tg, chat, user, menu) {
  const chatId = chat.id;
  if (isGroup(chat)) { await tg.sendMessage(chatId, PRIVATE_ONLY); return; }
  const list = webAuth.listSessions(user.id);
  if (!list.length) {
    await tg.sendMessage(chatId,
      'Сейчас вы нигде не вошли на сайте.\n\n'
      + 'Чтобы войти с компьютера, откройте сайт приложения и нажмите «Войти через Telegram».', menu);
    return;
  }
  const lines = list.map((s) => {
    const t = msk(s.lastSeenAt);
    return `• <b>${s.shortUa}</b> — последний раз ${t.date} в ${t.time}`;
  });
  await tg.sendMessage(chatId,
    `🖥 <b>Сеансы на сайте</b> (${list.length}):\n\n${lines.join('\n')}\n\n`
    + 'Не узнаёте браузер — завершите все сеансы и войдите заново.',
    keyboard([
      [{ text: '🚪 Завершить все', data: 'ws.all' }],
      [{ text: '⬅️ Меню', data: 'menu' }],
    ]));
}

/** «Завершить все». */
async function endAll(tg, chat, user, menu) {
  const chatId = chat.id;
  if (isGroup(chat)) { await tg.sendMessage(chatId, PRIVATE_ONLY); return; }
  const n = webAuth.logoutAll(user.id);
  await tg.sendMessage(chatId, n
    ? `Завершил сеансы на сайте: ${n}. Чтобы войти снова, подтвердите вход в боте.`
    : 'Открытых сеансов на сайте не было.', menu);
}

module.exports = { offer, answer, sessions, endAll, NOT_ACTUAL };
