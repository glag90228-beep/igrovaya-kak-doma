'use strict';

const crypto = require('node:crypto');

// Генерация уникальных ID
function generateId(prefix = '') {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  const id = `${timestamp}${random}`;

  return prefix ? `${prefix}-${id}` : id;
}

function generateDocumentId(type = '') {
  const typePrefix = type ? type.substring(0, 3).toUpperCase() : 'DOC';
  return generateId(typePrefix);
}

function generateExpenseId() {
  return generateId('EXP');
}

// Форматирование дат
function formatISO(date = new Date()) {
  return date.toISOString();
}

function parseISO(dateString) {
  return new Date(dateString);
}

function getDateRange(days = 30) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  return {
    start: formatISO(startDate),
    end: formatISO(endDate),
  };
}

// Работа с суммами (копейки)
const kop = (v) => Math.round((Number(v) || 0) * 100) / 100;

function formatMoney(amount, currency = 'RUB') {
  return {
    amount: kop(amount),
    currency,
    formatted: `${kop(amount).toFixed(2)} ${currency}`,
  };
}

function calculateSummary(amounts) {
  return kop(amounts.reduce((sum, a) => kop(sum + kop(a)), 0));
}

// Пагинация
function getPaginationParams(query) {
  const limit = Math.min(Math.max(parseInt(query.limit) || 50, 1), 500);
  const offset = Math.max(parseInt(query.offset) || 0, 0);

  return { limit, offset };
}

function calculatePages(total, limit) {
  return Math.ceil(total / limit);
}

// Проверка статуса документа
const VALID_DOCUMENT_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'archived'];
const VALID_RECONCILIATION_STATUSES = ['pending', 'in_progress', 'completed', 'failed'];
const VALID_SYNC_STATUSES = ['not_synced', 'synced', 'failed'];
const VALID_EXPENSE_STATUSES = ['unmatched', 'matched', 'reconciled', 'rejected'];

function isValidDocumentStatus(status) {
  return VALID_DOCUMENT_STATUSES.includes(status);
}

function isValidReconciliationStatus(status) {
  return VALID_RECONCILIATION_STATUSES.includes(status);
}

function isValidSyncStatus(status) {
  return VALID_SYNC_STATUSES.includes(status);
}

function isValidExpenseStatus(status) {
  return VALID_EXPENSE_STATUSES.includes(status);
}

// Валидация и нормализация данных
function normalizeEmail(email) {
  return email ? email.toLowerCase().trim() : null;
}

function normalizePhone(phone) {
  if (!phone) return null;

  const normalized = phone.replace(/\D/g, '');
  return normalized.length >= 10 ? normalized : null;
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  return {
    lastName: parts[0] || '',
    firstName: parts[1] || '',
    middleName: parts[2] || '',
  };
}

// Проверка INN
function isValidINN(inn) {
  if (!inn || typeof inn !== 'string') return false;

  inn = inn.trim();

  if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;

  if (inn.length === 10) {
    const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8, 0];
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      sum += parseInt(inn[i]) * weights[i];
    }
    const checkDigit = (sum % 11) % 10;
    return checkDigit === parseInt(inn[9]);
  }

  if (inn.length === 12) {
    const weights1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8, 0];
    const weights2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8, 0];

    let sum = 0;
    for (let i = 0; i < 11; i++) {
      sum += parseInt(inn[i]) * weights1[i];
    }
    const checkDigit1 = (sum % 11) % 10;

    if (checkDigit1 !== parseInt(inn[10])) return false;

    sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += parseInt(inn[i]) * weights2[i];
    }
    const checkDigit2 = (sum % 11) % 10;

    return checkDigit2 === parseInt(inn[11]);
  }

  return false;
}

// Безопасное преобразование типов
function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  if (typeof value === 'number') return value !== 0;
  return Boolean(value);
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return isNaN(num) ? fallback : num;
}

function toString(value, fallback = '') {
  return String(value ?? fallback);
}

// Логирование (базовое)
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message };

  if (data) {
    logEntry.data = data;
  }

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev || level === 'error') {
    console.log(JSON.stringify(logEntry));
  }
}

module.exports = {
  generateId,
  generateDocumentId,
  generateExpenseId,

  formatISO,
  parseISO,
  getDateRange,

  kop,
  formatMoney,
  calculateSummary,

  getPaginationParams,
  calculatePages,

  isValidDocumentStatus,
  isValidReconciliationStatus,
  isValidSyncStatus,
  isValidExpenseStatus,
  VALID_DOCUMENT_STATUSES,
  VALID_RECONCILIATION_STATUSES,
  VALID_SYNC_STATUSES,
  VALID_EXPENSE_STATUSES,

  normalizeEmail,
  normalizePhone,
  splitName,
  isValidINN,

  toBoolean,
  toNumber,
  toString,

  log,
};
