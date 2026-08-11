'use strict';

/**
 * Поддержка и правовые ссылки.
 *
 * Первый же человек, у которого что-то сломается, просто уйдёт, если ему
 * некуда написать. Поэтому кнопка есть всегда, а сообщение уходит владельцу
 * прямо в Telegram — без почты, тикетов и ожидания.
 *
 * Настройка через окружение:
 *   SUPPORT_CHAT_ID  — куда пересылать обращения (ваш личный chat_id);
 *   SUPPORT_CONTACT  — @username для прямой связи, если пересылка не настроена;
 *   LEGAL_OFERTA_URL, LEGAL_POLICY_URL — адреса страниц на сайте.
 */

const CONTACT = () => process.env.SUPPORT_CONTACT || '';
const CHAT = () => process.env.SUPPORT_CHAT_ID || '';
const OFERTA = () => process.env.LEGAL_OFERTA_URL || '';
const POLICY = () => process.env.LEGAL_POLICY_URL || '';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Строчка со ссылками на оферту и политику — для /help и приветствия. */
function legalLine() {
  const parts = [];
  if (OFERTA()) parts.push(`<a href="${esc(OFERTA())}">оферту</a>`);
  if (POLICY()) parts.push(`<a href="${esc(POLICY())}">политику обработки данных</a>`);
  if (!parts.length) return '';
  return `Пользуясь ботом, вы принимаете ${parts.join(' и ')}.`;
}

/** Текст экрана поддержки и кнопки под ним. */
function supportScreen() {
  const canWrite = Boolean(CHAT());
  const lines = ['<b>Поддержка</b>', ''];
  if (canWrite) {
    lines.push('Напишите, что случилось, — сообщение уйдёт напрямую разработчику.');
    lines.push('Если ошибка, приложите к описанию, что вы нажимали до неё.');
  } else if (CONTACT()) {
    lines.push(`Напишите нам: ${esc(CONTACT())}`);
  } else {
    lines.push('Канал поддержки пока не настроен.');
  }
  if (OFERTA() || POLICY()) {
    lines.push('');
    lines.push(legalLine());
  }
  const rows = [];
  if (canWrite) rows.push([{ text: '✍️ Написать в поддержку', data: 'sup.write' }]);
  if (CONTACT()) rows.push([{ text: `💬 ${CONTACT()}`, url: `https://t.me/${CONTACT().replace(/^@/, '')}` }]);
  if (OFERTA()) rows.push([{ text: '📄 Оферта', url: OFERTA() }]);
  if (POLICY()) rows.push([{ text: '🔒 Обработка данных', url: POLICY() }]);
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  return { text: lines.join('\n'), rows };
}

/**
 * Пересылает обращение владельцу. Возвращает false, если пересылка
 * не настроена, — тогда вызывающий код покажет контакт.
 */
async function forwardToSupport(tg, { user, chatId, text }) {
  if (!CHAT()) return false;
  const who = [user.name, user.username ? `@${user.username}` : '', `id ${user.tg_id}`]
    .filter(Boolean).join(' · ');
  await tg.sendMessage(CHAT(),
    `<b>Обращение в поддержку</b>\n${esc(who)}\nchat_id: <code>${esc(chatId)}</code>\n\n${esc(text)}`);
  return true;
}

module.exports = { supportScreen, forwardToSupport, legalLine, CONTACT, CHAT, OFERTA, POLICY };
