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

const CONTACT = () => process.env.SUPPORT_CONTACT || '@flowcraft_agent';
const CHAT = () => process.env.SUPPORT_CHAT_ID || '';
const OFERTA = () => process.env.LEGAL_OFERTA_URL || 'https://pervichkaru.ru/terms';
const POLICY = () => process.env.LEGAL_POLICY_URL || 'https://pervichkaru.ru/privacy';
const TARIFFS = () => process.env.LEGAL_TARIFFS_URL || 'https://pervichkaru.ru/tariffs';
const EMAIL = () => process.env.SUPPORT_EMAIL || 'support@pervichkaru.ru';
const CHECK_CODE = 'plat chek';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Строчка со ссылками на оферту и политику — для /help и приветствия. */
function legalLine() {
  return `Пользуясь ботом, вы принимаете <a href="${esc(OFERTA())}">оферту</a> и <a href="${esc(POLICY())}">политику конфиденциальности</a>.`;
}

/** Текст экрана поддержки и кнопки под ним. */
function supportScreen() {
  const canWrite = Boolean(CHAT());
  const contact = CONTACT() || '@flowcraft_agent';
  const email = EMAIL();
  const lines = ['<b>Поддержка «Первичка»</b>', ''];
  lines.push(`💬 <b>Telegram:</b> ${esc(contact)}`);
  lines.push(`✉️ <b>Email:</b> ${esc(email)}`);
  lines.push('');
  if (canWrite) {
    lines.push('Напишите сообщение прямо в чат — я передам его разработчику.');
  }
  lines.push('');
  lines.push(legalLine());
  lines.push('');
  lines.push(`<i>Проверочный код: ${CHECK_CODE}</i>`);

  const rows = [];
  if (canWrite) rows.push([{ text: '✍️ Написать в поддержку', data: 'sup.write' }]);
  if (contact) rows.push([{ text: `💬 Написать в Telegram (${contact})`, url: `https://t.me/${contact.replace(/^@/, '')}` }]);
  rows.push([
    { text: '📄 Оферта', url: OFERTA() },
    { text: '🔒 Конфиденциальность', url: POLICY() },
  ]);
  rows.push([{ text: '⭐ Тарифы и цены', url: TARIFFS() }]);
  rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
  return { text: lines.join('\n'), rows };
}

/** Экран официальных документов и правил. */
function legalScreen() {
  const contact = CONTACT() || '@flowcraft_agent';
  const email = EMAIL();
  const lines = [
    '<b>Официальные документы и тарифы «Первичка»</b>', '',
    '• <b>Пользовательское соглашение:</b> условия предоставления сервиса, тарифы и правила возврата.',
    '• <b>Политика конфиденциальности:</b> порядок сбора и защиты информации пользователей.',
    '• <b>Тарифы:</b> актуальные цены (0 ₽, 349 ₽/мес, 3 490 ₽/год).', '',
    `Контакты: ${esc(contact)} · ${esc(email)}`, '',
    `<i>Проверочный код: ${CHECK_CODE}</i>`,
  ];
  const rows = [
    [{ text: '📄 Пользовательское соглашение', url: OFERTA() }],
    [{ text: '🔒 Политика конфиденциальности', url: POLICY() }],
    [{ text: '⭐ Актуальные тарифы', url: TARIFFS() }],
    [{ text: '💬 Поддержка', data: 'support' }],
    [{ text: '⬅️ Меню', data: 'menu' }],
  ];
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

module.exports = {
  supportScreen, legalScreen, forwardToSupport, legalLine,
  CONTACT, CHAT, OFERTA, POLICY, TARIFFS, EMAIL, CHECK_CODE,
};
