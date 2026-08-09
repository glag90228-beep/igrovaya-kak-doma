'use strict';

// Уведомление о новой заявке в Telegram-бот.
// Клиент об этом не знает: он просто оставляет заявку на сайте,
// а менеджеру приходит готовое сообщение со сметой и ссылкой.

const { formatMoney, formatRub } = require('./money');

// Адрес Telegram API. Меняется только для тестов и работы через прокси.
const API = (process.env.TG_API || 'https://api.telegram.org').replace(/\/+$/, '');
const api = (token, method) => `${API}/bot${token.trim()}/${method}`;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const dateRu = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)
  ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : (iso || ''));

/** Текст сообщения о заявке */
function orderMessage(order, totals, settings, link, kind = 'new') {
  const L = [];
  L.push(kind === 'edit'
    ? `<b>✏️ Заявка № ${order.number} изменена клиентом</b>`
    : `<b>🔔 Новая заявка № ${order.number}</b>`);
  L.push('');
  L.push(`<b>${esc(order.client_name || 'Без имени')}</b>`);
  if (order.phone) L.push(`☎ ${esc(order.phone)}`);
  if (order.event_date) L.push(`📅 ${dateRu(order.event_date)}`);
  if (order.place) L.push(`📍 ${esc(order.place)}`);
  L.push(`👥 гостей: ${order.guests}`);
  L.push('');
  L.push('<b>Меню:</b>');
  order.items.forEach((it, i) => {
    L.push(it.price_tbd
      ? `${i + 1}. ${esc(it.name)} — ${it.qty} шт. (цена уточняется)`
      : `${i + 1}. ${esc(it.name)} — ${it.qty} × ${formatMoney(it.price)} = ${formatMoney(it.qty * it.price)}`);
  });
  L.push('');
  L.push(`Итого по меню: ${formatMoney(totals.menuTotal)} руб.`);
  if (totals.transport) L.push(`Транспорт: ${formatMoney(totals.transport)} руб.`);
  L.push(`<b>Всего: ${formatRub(totals.grandTotal)}</b>`);
  if (order.comment) { L.push(''); L.push(`💬 ${esc(order.comment)}`); }
  if (link) { L.push(''); L.push(`Смета: ${link}`); }
  return L.join('\n');
}

/**
 * Отправляет заявку в Telegram. Ошибки не роняют заказ — только пишем в лог:
 * заявка в любом случае уже сохранена в базе и видна в панели.
 */
async function notifyOrder({ order, totals, settings, link, kind }) {
  const token = (settings.tg_bot_token || process.env.BOT_TOKEN || '').trim();
  const chatId = (settings.tg_chat_id || process.env.TG_CHAT_ID || '').trim();
  if (!token || !chatId) return { ok: false, skipped: 'не заданы токен бота или чат' };

  try {
    const res = await fetch(api(token, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: orderMessage(order, totals, settings, link, kind),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
    return { ok: true };
  } catch (e) {
    console.error('Не удалось отправить заявку в Telegram:', e.message);
    return { ok: false, error: e.message };
  }
}

/** Проверка бота из панели: кто он и какие чаты ему писали */
async function checkBot(token) {
  const t = (token || '').trim();
  if (!t) throw new Error('Токен не задан');
  const me = await fetch(api(t, 'getMe')).then((r) => r.json());
  if (!me.ok) throw new Error(me.description || 'Токен не подошёл');

  const upd = await fetch(api(t, 'getUpdates?limit=20')).then((r) => r.json());
  const chats = [];
  if (upd.ok) {
    for (const u of upd.result || []) {
      const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
      if (c && !chats.some((x) => x.id === c.id)) {
        chats.push({
          id: c.id,
          title: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '',
          type: c.type,
        });
      }
    }
  }
  return { username: me.result.username, name: me.result.first_name, chats };
}

module.exports = { notifyOrder, checkBot, orderMessage, api };
