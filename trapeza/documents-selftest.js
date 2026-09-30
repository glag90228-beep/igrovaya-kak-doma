#!/usr/bin/env node
'use strict';

const processManager = require('./lib/process-manager');
const apiDocuments = require('./lib/api-documents');
const botDocuments = require('./lib/bot-documents');
const expensifyManager = require('./lib/expensify-manager');
const { db } = require('./db');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}`);
    console.error(`   ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Тесты ProcessManager
console.log('\n📄 ProcessManager tests\n');

test('Создание документа', () => {
  const doc = processManager.createDocument(1, {
    type: 'invoice',
    title: 'Test Invoice',
    amount: 100,
    currency: 'RUB',
  });
  assert(doc, 'Документ должен быть создан');
  assert(doc.id, 'Документ должен иметь ID');
  assert(doc.status === 'draft', 'Статус должен быть draft');
  assert(doc.amount === 100, 'Сумма должна быть 100');
});

test('Получение документа по ID', () => {
  const created = processManager.createDocument(2, { title: 'Test' });
  const retrieved = processManager.getDocument(created.id);
  assert(retrieved, 'Документ должен быть найден');
  assert(retrieved.id === created.id, 'ID должны совпадать');
});

test('Получение документа по коду', () => {
  const created = processManager.createDocument(3, { code: 'test_doc_123', title: 'Test' });
  const retrieved = processManager.getDocumentByCode('test_doc_123');
  assert(retrieved, 'Документ должен быть найден по коду');
  assert(retrieved.id === created.id, 'ID должны совпадать');
});

test('Список документов пользователя', () => {
  const userId = 100;
  processManager.createDocument(userId, { title: 'Doc1' });
  processManager.createDocument(userId, { title: 'Doc2' });

  const { docs, total } = processManager.listDocuments(userId);
  assert(docs.length >= 2, 'Должно быть минимум 2 документа');
  assert(total >= 2, 'Total должно быть >= 2');
});

test('Переход статуса: draft -> sent', () => {
  const doc = processManager.createDocument(4, { title: 'Test' });
  assert(processManager.isValidTransition('draft', 'sent'), 'Переход должен быть валидным');

  const updated = processManager.transitionStatus(doc.id, 'sent', { reason: 'Manual update' });
  assert(updated.status === 'sent', 'Статус должен измениться на sent');
});

test('Переход статуса: sent -> signed', () => {
  const doc = processManager.createDocument(5, { title: 'Test' });
  processManager.transitionStatus(doc.id, 'sent');
  const updated = processManager.transitionStatus(doc.id, 'signed', { reason: 'Signed by client' });
  assert(updated.status === 'signed', 'Статус должен измениться на signed');
});

test('Переход статуса: signed -> paid', () => {
  const doc = processManager.createDocument(6, { title: 'Test' });
  processManager.transitionStatus(doc.id, 'sent');
  processManager.transitionStatus(doc.id, 'signed');
  const updated = processManager.transitionStatus(doc.id, 'paid', { reason: 'Payment received' });
  assert(updated.status === 'paid', 'Статус должен измениться на paid');
});

test('Невалидный переход статуса выбрасывает ошибку', () => {
  assert(!processManager.isValidTransition('signed', 'draft'), 'Назад в draft невозможно');
  assert(!processManager.isValidTransition('paid', 'sent'), 'Из paid невозможно вернуться в sent');
});

test('Ошибка при переходе из текущего состояния', () => {
  const doc = processManager.createDocument(7, { title: 'Test' });
  try {
    processManager.transitionStatus(doc.id, 'signed'); // Прыгаем через sent
    throw new Error('Должна быть ошибка');
  } catch (e) {
    assert(e.message.includes('Cannot transition'), 'Должна быть ошибка о невалидном переходе');
  }
});

test('История изменений статуса', () => {
  const doc = processManager.createDocument(8, { title: 'Test' });
  processManager.transitionStatus(doc.id, 'sent', { reason: 'Sent to client' });
  processManager.transitionStatus(doc.id, 'signed', { reason: 'Signed' });

  const history = processManager.getHistory(doc.id);
  assert(history.length === 2, 'Должно быть 2 записи в истории');
  assert(history[0].status_from === 'sent', 'Первая запись от sent');
  assert(history[0].status_to === 'signed', 'Первая запись в signed');
});

test('Форматирование для Telegram', () => {
  const doc = processManager.createDocument(9, { title: 'Invoice #123', amount: 500 });
  const text = processManager.formatForTelegram(doc);
  assert(text.includes(doc.code), 'Текст должен содержать код');
  assert(text.includes('500'), 'Текст должен содержать сумму');
  assert(text.includes('draft'), 'Текст должен содержать статус');
});

// Тесты Expensify Manager
console.log('\n🔄 ExpensifyManager tests\n');

test('Инициализация Expensify Manager', () => {
  const manager = require('./lib/expensify-manager');
  assert(manager, 'Менеджер должен быть инициализирован');
});

test('Проверка, нужна ли синхронизация для нового документа', () => {
  const doc = processManager.createDocument(50, { title: 'Expense', amount: 250 });
  const needs = expensifyManager.needsSync(doc.id);
  assert(needs === true, 'Новый документ должен быть синхронизирован');
});

test('История синхронизации', () => {
  const doc = processManager.createDocument(51, { title: 'Expense' });
  const history = expensifyManager.getSyncHistory(doc.id);
  assert(Array.isArray(history), 'История должна быть массивом');
});

// Тесты API
console.log('\n🌐 API Documents tests\n');

test('Функция listDocuments существует', () => {
  assert(typeof apiDocuments.listDocuments === 'function', 'Функция должна существовать');
});

test('Функция createDocument существует', () => {
  assert(typeof apiDocuments.createDocument === 'function', 'Функция должна существовать');
});

test('Функция getDocument существует', () => {
  assert(typeof apiDocuments.getDocument === 'function', 'Функция должна существовать');
});

test('Функция updateDocument существует', () => {
  assert(typeof apiDocuments.updateDocument === 'function', 'Функция должна существовать');
});

test('Функция getHistory существует', () => {
  assert(typeof apiDocuments.getHistory === 'function', 'Функция должна существовать');
});

// Тесты Telegram handlers
console.log('\n🤖 Telegram Handlers tests\n');

test('handleBillCreate существует', () => {
  assert(typeof botDocuments.handleBillCreate === 'function', 'Функция должна существовать');
});

test('handleBillList существует', () => {
  assert(typeof botDocuments.handleBillList === 'function', 'Функция должна существовать');
});

test('handleBillStatus существует', () => {
  assert(typeof botDocuments.handleBillStatus === 'function', 'Функция должна существовать');
});

test('handleTransitionStatus существует', () => {
  assert(typeof botDocuments.handleTransitionStatus === 'function', 'Функция должна существовать');
});

// Итоги
console.log(`\n${'='.repeat(50)}`);
console.log(`\n✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`📊 Total: ${passed + failed}\n`);

process.exit(failed > 0 ? 1 : 0);
