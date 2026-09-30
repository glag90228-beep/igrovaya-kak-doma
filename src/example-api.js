'use strict';

/**
 * Пример использования Database schema & API Infrastructure
 *
 * Запуск: RECONCILIATION_DB=/tmp/test.db node src/example-api.js
 */

const express = require('express');
const crypto = require('node:crypto');
const {
  setupApi,
  asyncHandler,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
} = require('./api');
const { Schema, validateBody } = require('./api/middleware');
const {
  generateDocumentId,
  generateExpenseId,
  getPaginationParams,
  isValidDocumentStatus,
  kop,
} = require('./api/utils');
const db = require('./database/db');

const app = express();

// Инициализация API с middleware
setupApi(app, {
  trustProxy: false,
  enableLogging: true,
  enableCors: true,
});

// Валидационные схемы
const createDocSchema = new Schema({
  type: { type: 'string', required: true, enum: ['invoice', 'estimate', 'act', 'waybill'] },
  amount: { type: 'number', required: true, min: 0 },
  createdBy: { type: 'string', required: true, minLength: 1 },
  notes: { type: 'string' },
});

const updateDocSchema = new Schema({
  status: {
    type: 'string',
    enum: ['draft', 'submitted', 'approved', 'rejected', 'archived'],
  },
  amount: { type: 'number', min: 0 },
});

// ===== Маршруты документов =====

// Создание документа
app.post('/documents', validateBody(createDocSchema), asyncHandler(async (req, res) => {
  const { type, amount, createdBy, notes } = req.body;
  const docId = generateDocumentId(type);

  const doc = db.createDocument(docId, {
    type,
    status: 'draft',
    amount,
    createdBy,
    notes,
  });

  // Создание метаданных
  db.createMetadata(docId);

  res.sendCreated(doc, 'Document created successfully');
}));

// Получение документа
app.get('/documents/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = db.getDocument(id);

  if (!doc) {
    throw new NotFoundError(`Document ${id} not found`);
  }

  const meta = db.getMetadata(id);
  const logs = db.getAuditLogs(id, { limit: 10 });

  res.sendSuccess({
    ...doc,
    metadata: meta,
    recentChanges: logs,
  });
}));

// Список документов
app.get('/documents', asyncHandler(async (req, res) => {
  const { limit, offset } = getPaginationParams(req.query);
  const { status, createdBy } = req.query;

  const docs = db.listDocuments({
    status,
    createdBy,
    limit,
    offset,
  });

  // Подсчет всего
  let countSql = 'SELECT COUNT(*) as total FROM documents WHERE 1=1';
  const countParams = [];

  if (status) {
    countSql += ' AND status = ?';
    countParams.push(status);
  }
  if (createdBy) {
    countSql += ' AND created_by = ?';
    countParams.push(createdBy);
  }

  const { total } = db.db.prepare(countSql).get(...countParams);

  res.sendPaginated(docs, total, limit, offset);
}));

// Обновление документа
app.patch('/documents/:id', validateBody(updateDocSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, amount } = req.body;

  const doc = db.getDocument(id);
  if (!doc) {
    throw new NotFoundError(`Document ${id} not found`);
  }

  if (status && !isValidDocumentStatus(status)) {
    throw new ValidationError('Invalid status', { status });
  }

  const updated = db.updateDocument(id, {
    status,
    amount,
    updatedBy: req.query.updatedBy || 'api',
  });

  res.sendSuccess(updated, 'Document updated');
}));

// Удаление документа
app.delete('/documents/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const doc = db.getDocument(id);
  if (!doc) {
    throw new NotFoundError(`Document ${id} not found`);
  }

  db.deleteDocument(id, req.query.deletedBy || 'api');

  res.sendNoContent();
}));

// ===== Маршруты для логов аудита =====

app.get('/documents/:id/audit', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const doc = db.getDocument(id);
  if (!doc) {
    throw new NotFoundError(`Document ${id} not found`);
  }

  const { limit, offset } = getPaginationParams(req.query);
  const logs = db.getAuditLogs(id, { limit, offset });

  res.sendSuccess({
    documentId: id,
    logs,
    total: logs.length, // В реальном приложении нужен отдельный COUNT
  });
}));

// ===== Маршруты метаданных =====

app.get('/documents/:id/metadata', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const meta = db.getMetadata(id);
  if (!meta) {
    throw new NotFoundError(`Metadata for document ${id} not found`);
  }

  res.sendSuccess(meta);
}));

app.patch('/documents/:id/metadata', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    reconciliationStatus,
    expensifySyncStatus,
    validationErrors,
    tags,
  } = req.body;

  const meta = db.getMetadata(id);
  if (!meta) {
    throw new NotFoundError(`Metadata for document ${id} not found`);
  }

  const updated = db.updateMetadata(id, {
    reconciliationStatus,
    expensifySyncStatus,
    validationErrors,
    tags,
    reconciliationTimestamp: new Date().toISOString(),
  });

  res.sendSuccess(updated, 'Metadata updated');
}));

// ===== Маршруты расходов =====

// Создание расхода
app.post('/expenses', asyncHandler(async (req, res) => {
  const {
    expensifyId,
    documentId,
    amount,
    category,
    description,
    merchant,
    transactionDate,
  } = req.body;

  // Проверка на дубликат
  const existing = db.getExpenseByExpensifyId(expensifyId);
  if (existing) {
    throw new ValidationError('Expense already exists', { expensifyId });
  }

  const expenseId = generateExpenseId();
  const expense = db.createExpense(expenseId, {
    expensifyId,
    documentId,
    amount,
    category,
    description,
    merchant,
    transactionDate,
  });

  res.sendCreated(expense);
}));

// Получение расхода
app.get('/expenses/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const expense = db.getExpense(id);

  if (!expense) {
    throw new NotFoundError(`Expense ${id} not found`);
  }

  res.sendSuccess(expense);
}));

// Список расходов
app.get('/expenses', asyncHandler(async (req, res) => {
  const { limit, offset } = getPaginationParams(req.query);
  const { documentId, status } = req.query;

  const expenses = db.listExpenses({
    documentId,
    status,
    limit,
    offset,
  });

  // Подсчет сумм
  let totalSql = 'SELECT SUM(amount) as total FROM expenses WHERE 1=1';
  const totalParams = [];

  if (documentId) {
    totalSql += ' AND document_id = ?';
    totalParams.push(documentId);
  }
  if (status) {
    totalSql += ' AND status = ?';
    totalParams.push(status);
  }

  const result = db.db.prepare(totalSql).get(...totalParams);
  const totalAmount = kop(result.total || 0);

  res.sendSuccess({
    expenses,
    summary: {
      count: expenses.length,
      totalAmount,
      averageAmount: kop(totalAmount / Math.max(expenses.length, 1)),
    },
  });
}));

// Привязка расхода к документу
app.patch('/expenses/:id/match', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { documentId } = req.body;

  const expense = db.getExpense(id);
  if (!expense) {
    throw new NotFoundError(`Expense ${id} not found`);
  }

  const doc = db.getDocument(documentId);
  if (!doc) {
    throw new NotFoundError(`Document ${documentId} not found`);
  }

  const updated = db.updateExpense(id, {
    documentId,
    status: 'matched',
    matchedAt: new Date().toISOString(),
  });

  res.sendSuccess(updated, 'Expense matched with document');
}));

// ===== Маршруты настроек пользователя =====

app.post('/users/:userId/preferences', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { email, phone, language, timezone } = req.body;

  const prefs = db.createUserPreferences(userId, {
    email,
    phone,
    language,
    timezone,
  });

  res.sendCreated(prefs);
}));

app.get('/users/:userId/preferences', asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const prefs = db.getUserPreferences(userId);
  if (!prefs) {
    throw new NotFoundError(`Preferences for user ${userId} not found`);
  }

  res.sendSuccess(prefs);
}));

app.patch('/users/:userId/preferences', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const updates = req.body;

  const prefs = db.getUserPreferences(userId);
  if (!prefs) {
    throw new NotFoundError(`Preferences for user ${userId} not found`);
  }

  const updated = db.updateUserPreferences(userId, updates);
  res.sendSuccess(updated, 'Preferences updated');
}));

// ===== Health check =====

app.get('/health', (req, res) => {
  res.sendSuccess({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: db.DB_FILE,
  });
});

// ===== Запуск сервера =====

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`✓ API server running on http://localhost:${PORT}`);
  console.log(`✓ Database: ${db.DB_FILE}`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  POST   /documents                    - Create document');
  console.log('  GET    /documents                    - List documents (with pagination)');
  console.log('  GET    /documents/:id                - Get document');
  console.log('  PATCH  /documents/:id                - Update document');
  console.log('  DELETE /documents/:id                - Delete document');
  console.log('  GET    /documents/:id/audit          - Get audit logs');
  console.log('  GET    /documents/:id/metadata       - Get metadata');
  console.log('  PATCH  /documents/:id/metadata       - Update metadata');
  console.log('  POST   /expenses                     - Create expense');
  console.log('  GET    /expenses                     - List expenses');
  console.log('  GET    /expenses/:id                 - Get expense');
  console.log('  PATCH  /expenses/:id/match           - Match expense to document');
  console.log('  POST   /users/:userId/preferences    - Create user preferences');
  console.log('  GET    /users/:userId/preferences    - Get user preferences');
  console.log('  PATCH  /users/:userId/preferences    - Update user preferences');
  console.log('  GET    /health                       - Health check');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;
