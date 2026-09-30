'use strict';

const processManager = require('./process-manager');

// Обработчики команд для работы с документами в Telegram

// /bill_create - создать новый документ
async function handleBillCreate(ctx, tg) {
  const userId = ctx.message.from.id;
  const text = ctx.message.text || '';

  // Парсим текст команды: /bill_create [сумма] [описание]
  const match = text.match(/\/bill_create\s*(\d+(?:[.,]\d{2})?)?(?:\s+(.+))?/);
  const amount = match?.[1] ? parseFloat(match[1].replace(',', '.')) : 0;
  const title = match?.[2] || 'Документ';

  try {
    const doc = processManager.createDocument(userId, {
      type: 'invoice',
      title,
      amount,
      currency: 'RUB',
    });

    const reply = `✅ *Документ создан*\n\n`;
    reply += `Код: \`${doc.code}\`\n`;
    reply += `Сумма: *${(doc.amount).toFixed(2)} ₽*\n`;
    reply += `Статус: _${doc.status}_\n\n`;
    reply += `Используйте \`/bill_list\` чтобы увидеть все документы.`;

    await tg.sendMessage(ctx.message.chat.id, reply, { parse_mode: 'Markdown' });
  } catch (error) {
    await tg.sendMessage(ctx.message.chat.id, `❌ Ошибка: ${error.message}`);
  }
}

// /bill_list - список документов пользователя
async function handleBillList(ctx, tg) {
  const userId = ctx.message.from.id;

  try {
    const { docs, total } = processManager.listDocuments(userId, { limit: 10 });

    if (docs.length === 0) {
      await tg.sendMessage(ctx.message.chat.id, '📋 *У вас нет документов*\n\nСоздайте первый документ: `/bill_create`', {
        parse_mode: 'Markdown',
      });
      return;
    }

    let text = `📋 *Ваши документы* (всего: ${total})\n\n`;
    for (const doc of docs) {
      text += `${processManager.getStatusEmoji(doc.status)} \`${doc.code}\`\n`;
      text += `   Сумма: ${(doc.amount).toFixed(2)} ₽ | Статус: _${doc.status}_\n`;
      text += `   ${new Date(doc.created_at).toLocaleDateString('ru-RU')}\n\n`;
    }

    text += `Используйте \`/bill_status {код}\` для подробной информации.`;

    await tg.sendMessage(ctx.message.chat.id, text, { parse_mode: 'Markdown' });
  } catch (error) {
    await tg.sendMessage(ctx.message.chat.id, `❌ Ошибка: ${error.message}`);
  }
}

// /bill_status - статус документа и история
async function handleBillStatus(ctx, tg) {
  const text = ctx.message.text || '';
  const match = text.match(/\/bill_status\s+(\S+)/);
  const code = match?.[1];

  if (!code) {
    await tg.sendMessage(ctx.message.chat.id, `❌ Используйте: \`/bill_status {код}\``, {
      parse_mode: 'Markdown',
    });
    return;
  }

  try {
    const doc = processManager.getDocumentByCode(code);
    if (!doc) {
      await tg.sendMessage(ctx.message.chat.id, `❌ Документ ${code} не найден`);
      return;
    }

    // Проверить, что это документ пользователя
    if (doc.user_id !== ctx.message.from.id) {
      await tg.sendMessage(ctx.message.chat.id, `❌ Доступ запрещён`);
      return;
    }

    const formattedText = processManager.formatForTelegram(doc, true);
    await tg.sendMessage(ctx.message.chat.id, formattedText, { parse_mode: 'Markdown' });
  } catch (error) {
    await tg.sendMessage(ctx.message.chat.id, `❌ Ошибка: ${error.message}`);
  }
}

// Команда для смены статуса (админ)
async function handleTransitionStatus(ctx, tg, isAdmin = false) {
  if (!isAdmin) {
    await tg.sendMessage(ctx.message.chat.id, `❌ Только администраторы могут менять статусы`);
    return;
  }

  const text = ctx.message.text || '';
  const match = text.match(/\/transition\s+(\S+)\s+(\w+)\s*(.*)?/);
  const code = match?.[1];
  const newStatus = match?.[2];
  const reason = match?.[3] || '';

  if (!code || !newStatus) {
    await tg.sendMessage(ctx.message.chat.id, `❌ Используйте: \`/transition {код} {статус} [причина]\``, {
      parse_mode: 'Markdown',
    });
    return;
  }

  try {
    const doc = processManager.getDocumentByCode(code);
    if (!doc) {
      await tg.sendMessage(ctx.message.chat.id, `❌ Документ ${code} не найден`);
      return;
    }

    const updatedDoc = processManager.transitionStatus(doc.id, newStatus, {
      reason,
      changedBy: `${ctx.message.from.username || ctx.message.from.id}`,
    });

    const formattedText = processManager.formatForTelegram(updatedDoc, false);
    await tg.sendMessage(ctx.message.chat.id, formattedText, { parse_mode: 'Markdown' });
  } catch (error) {
    await tg.sendMessage(ctx.message.chat.id, `❌ Ошибка: ${error.message}`);
  }
}

module.exports = {
  handleBillCreate,
  handleBillList,
  handleBillStatus,
  handleTransitionStatus,
};
