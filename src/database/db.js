'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_FILE = process.env.RECONCILIATION_DB
  ? path.resolve(process.env.RECONCILIATION_DB)
  : path.join(__dirname, '../../data', 'reconciliation.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

// Настройки для одновременных записей
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Инициализация схемы
function initDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
}

// Документы
function createDocument(id, { type, status, amount, createdBy, externalId, notes }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO documents(id, type, status, amount, created_at, updated_at, created_by, external_id, notes)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, status || 'draft', amount || 0, now, now, createdBy, externalId || null, notes || '');

  addAuditLog(id, 'created', null, JSON.stringify({ type, status, amount }), createdBy);
  return getDocument(id);
}

function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

function listDocuments({ status, createdBy, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM documents WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (createdBy) {
    sql += ' AND created_by = ?';
    params.push(createdBy);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

function updateDocument(id, { status, amount, notes, updatedBy }) {
  const doc = getDocument(id);
  if (!doc) throw new Error(`Document ${id} not found`);

  const now = new Date().toISOString();
  const updates = [];
  const values = [];

  if (status !== undefined && status !== doc.status) {
    updates.push('status = ?');
    values.push(status);
    addAuditLog(id, 'status_changed', doc.status, status, updatedBy);
  }

  if (amount !== undefined && amount !== doc.amount) {
    updates.push('amount = ?');
    values.push(amount);
    addAuditLog(id, 'updated', doc.amount, amount, updatedBy);
  }

  if (notes !== undefined && notes !== doc.notes) {
    updates.push('notes = ?');
    values.push(notes);
  }

  if (updates.length > 0) {
    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.prepare(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  return getDocument(id);
}

function deleteDocument(id, deletedBy) {
  const doc = getDocument(id);
  if (!doc) throw new Error(`Document ${id} not found`);

  addAuditLog(id, 'deleted', JSON.stringify(doc), null, deletedBy);
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  return true;
}

// Логирование аудита
function addAuditLog(documentId, action, oldValue, newValue, changedBy, ipAddress, userAgent) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_logs(document_id, action, old_value, new_value, changed_by, changed_at, ip_address, user_agent)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(documentId, action, oldValue, newValue, changedBy, now, ipAddress || null, userAgent || null);
}

function getAuditLogs(documentId, { limit = 50, offset = 0 } = {}) {
  return db.prepare(`
    SELECT * FROM audit_logs
    WHERE document_id = ?
    ORDER BY changed_at DESC
    LIMIT ? OFFSET ?
  `).all(documentId, limit, offset);
}

// Метаданные документов
function createMetadata(documentId, { reconciliationStatus, expensifySyncStatus } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO document_metadata(
      document_id, version, reconciliation_status, expensify_sync_status, last_validation_timestamp
    )
    VALUES(?, ?, ?, ?, ?)
  `).run(documentId, 1, reconciliationStatus || 'pending', expensifySyncStatus || 'not_synced', now);

  return getMetadata(documentId);
}

function getMetadata(documentId) {
  const meta = db.prepare('SELECT * FROM document_metadata WHERE document_id = ?').get(documentId);
  if (meta && meta.validation_errors) {
    try {
      meta.validation_errors = JSON.parse(meta.validation_errors);
    } catch (e) {
      meta.validation_errors = [];
    }
  }
  if (meta && meta.tags) {
    try {
      meta.tags = JSON.parse(meta.tags);
    } catch (e) {
      meta.tags = [];
    }
  }
  return meta;
}

function updateMetadata(documentId, updates) {
  const current = getMetadata(documentId);
  if (!current) throw new Error(`Metadata for ${documentId} not found`);

  const now = new Date().toISOString();
  const sqlUpdates = [];
  const values = [];

  if (updates.reconciliationStatus) {
    sqlUpdates.push('reconciliation_status = ?');
    values.push(updates.reconciliationStatus);
  }
  if (updates.reconciliationTimestamp) {
    sqlUpdates.push('reconciliation_timestamp = ?');
    values.push(updates.reconciliationTimestamp);
  }
  if (updates.expensifySyncStatus) {
    sqlUpdates.push('expensify_sync_status = ?');
    values.push(updates.expensifySyncStatus);
  }
  if (updates.expensifySyncTimestamp) {
    sqlUpdates.push('expensify_sync_timestamp = ?');
    values.push(updates.expensifySyncTimestamp);
  }
  if (updates.validationErrors) {
    sqlUpdates.push('validation_errors = ?');
    values.push(JSON.stringify(updates.validationErrors));
  }
  if (updates.lastError) {
    sqlUpdates.push('last_error = ?');
    values.push(updates.lastError);
  }
  if (updates.tags) {
    sqlUpdates.push('tags = ?');
    values.push(JSON.stringify(updates.tags));
  }

  if (updates.incrementProcessingAttempts) {
    sqlUpdates.push('processing_attempts = processing_attempts + 1');
  }

  sqlUpdates.push('last_validation_timestamp = ?');
  values.push(now);
  values.push(documentId);

  db.prepare(`UPDATE document_metadata SET ${sqlUpdates.join(', ')} WHERE document_id = ?`).run(...values);

  return getMetadata(documentId);
}

// Настройки пользователей
function createUserPreferences(userId, { email, phone, language, timezone } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_preferences(user_id, email, phone, language, timezone, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(userId, email || null, phone || null, language || 'ru', timezone || 'UTC', now, now);

  return getUserPreferences(userId);
}

function getUserPreferences(userId) {
  return db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);
}

function updateUserPreferences(userId, updates) {
  const current = getUserPreferences(userId);
  if (!current) throw new Error(`User preferences for ${userId} not found`);

  const now = new Date().toISOString();
  const sqlUpdates = [];
  const values = [];

  if (updates.email !== undefined) {
    sqlUpdates.push('email = ?');
    values.push(updates.email);
  }
  if (updates.phone !== undefined) {
    sqlUpdates.push('phone = ?');
    values.push(updates.phone);
  }
  if (updates.notificationsEnabled !== undefined) {
    sqlUpdates.push('notifications_enabled = ?');
    values.push(updates.notificationsEnabled ? 1 : 0);
  }
  if (updates.notifyOnStatusChange !== undefined) {
    sqlUpdates.push('notify_on_status_change = ?');
    values.push(updates.notifyOnStatusChange ? 1 : 0);
  }
  if (updates.notifyOnDocumentUpdate !== undefined) {
    sqlUpdates.push('notify_on_document_update = ?');
    values.push(updates.notifyOnDocumentUpdate ? 1 : 0);
  }
  if (updates.notifyOnReconciliation !== undefined) {
    sqlUpdates.push('notify_on_reconciliation = ?');
    values.push(updates.notifyOnReconciliation ? 1 : 0);
  }
  if (updates.notifyOnExpensifySync !== undefined) {
    sqlUpdates.push('notify_on_expensify_sync = ?');
    values.push(updates.notifyOnExpensifySync ? 1 : 0);
  }
  if (updates.language !== undefined) {
    sqlUpdates.push('language = ?');
    values.push(updates.language);
  }
  if (updates.timezone !== undefined) {
    sqlUpdates.push('timezone = ?');
    values.push(updates.timezone);
  }

  sqlUpdates.push('updated_at = ?');
  values.push(now);
  values.push(userId);

  db.prepare(`UPDATE user_preferences SET ${sqlUpdates.join(', ')} WHERE user_id = ?`).run(...values);

  return getUserPreferences(userId);
}

// Расходы из Expensify
function createExpense(id, { documentId, expensifyId, amount, currency, category, description, merchant, transactionDate, receiptUrl }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO expenses(
      id, document_id, expensify_id, amount, currency, category, description, merchant,
      transaction_date, receipt_url, status, synced_at, created_at, updated_at
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, documentId || null, expensifyId, amount, currency || 'RUB', category || 'uncategorized',
    description || '', merchant || null, transactionDate, receiptUrl || null, 'unmatched', now, now, now
  );

  return getExpense(id);
}

function getExpense(id) {
  return db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
}

function getExpenseByExpensifyId(expensifyId) {
  return db.prepare('SELECT * FROM expenses WHERE expensify_id = ?').get(expensifyId);
}

function listExpenses({ documentId, status, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM expenses WHERE 1=1';
  const params = [];

  if (documentId) {
    sql += ' AND document_id = ?';
    params.push(documentId);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY transaction_date DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

function updateExpense(id, { documentId, status, matchedAt }) {
  const expense = getExpense(id);
  if (!expense) throw new Error(`Expense ${id} not found`);

  const now = new Date().toISOString();
  const updates = [];
  const values = [];

  if (documentId !== undefined) {
    updates.push('document_id = ?');
    values.push(documentId);
  }
  if (status !== undefined) {
    updates.push('status = ?');
    values.push(status);
  }
  if (matchedAt) {
    updates.push('matched_at = ?');
    values.push(matchedAt);
  }

  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE expenses SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  return getExpense(id);
}

// Транзакции
function runInTransaction(callback) {
  const transaction = db.transaction(callback);
  return transaction();
}

// Инициализация при импорте
initDatabase();

module.exports = {
  db,
  DB_FILE,
  DATA_DIR: path.dirname(DB_FILE),

  // Документы
  createDocument,
  getDocument,
  listDocuments,
  updateDocument,
  deleteDocument,

  // Аудит
  addAuditLog,
  getAuditLogs,

  // Метаданные
  createMetadata,
  getMetadata,
  updateMetadata,

  // Пользователи
  createUserPreferences,
  getUserPreferences,
  updateUserPreferences,

  // Расходы
  createExpense,
  getExpense,
  getExpenseByExpensifyId,
  listExpenses,
  updateExpense,

  // Транзакции
  runInTransaction,
};
