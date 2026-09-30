'use strict';

const { db } = require('../db');

// Состояния документа: DRAFT → SENT → SIGNED → PAID
const STATES = {
  DRAFT: 'draft',
  SENT: 'sent',
  SIGNED: 'signed',
  PAID: 'paid',
};

// Допустимые переходы
const VALID_TRANSITIONS = {
  [STATES.DRAFT]: [STATES.SENT],
  [STATES.SENT]: [STATES.SIGNED],
  [STATES.SIGNED]: [STATES.PAID],
  [STATES.PAID]: [],
};

// События при смене статуса
const STATUS_EVENTS = {
  [STATES.SENT]: 'document:sent',
  [STATES.SIGNED]: 'document:signed',
  [STATES.PAID]: 'document:paid',
};

// Таблица для аудита
function ensureDocumentTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT    NOT NULL UNIQUE,
      user_id     INTEGER NOT NULL,
      type        TEXT    NOT NULL DEFAULT 'invoice',
      title       TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT 'draft',
      amount      REAL    NOT NULL DEFAULT 0,
      currency    TEXT    NOT NULL DEFAULT 'RUB',
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      status_from TEXT    NOT NULL,
      status_to   TEXT    NOT NULL,
      changed_by  TEXT    NOT NULL DEFAULT 'system',
      reason      TEXT    NOT NULL DEFAULT '',
      timestamp   TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_docs_user ON documents(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_docs_status ON documents(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_hist_doc ON document_history(doc_id, timestamp);
  `);
}

class ProcessManager {
  constructor() {
    ensureDocumentTables();
    this.listeners = new Map();
  }

  // Создать документ
  createDocument(userId, { code, type = 'invoice', title = '', amount = 0, currency = 'RUB' } = {}) {
    const now = new Date().toISOString();
    const docCode = code || `doc_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const stmt = db.prepare(`
      INSERT INTO documents (user_id, code, type, title, status, amount, currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(userId, docCode, type, title, STATES.DRAFT, amount, currency, now, now);
    return this.getDocument(result.lastInsertRowid);
  }

  // Получить документ по ID
  getDocument(id) {
    return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  }

  // Получить документ по коду
  getDocumentByCode(code) {
    return db.prepare('SELECT * FROM documents WHERE code = ?').get(code);
  }

  // Список документов пользователя
  listDocuments(userId, { limit = 50, offset = 0 } = {}) {
    const docs = db.prepare(`
      SELECT * FROM documents
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset);

    const total = db.prepare('SELECT COUNT(*) as count FROM documents WHERE user_id = ?').get(userId).count;
    return { docs, total };
  }

  // Проверить возможность перехода
  isValidTransition(fromStatus, toStatus) {
    return VALID_TRANSITIONS[fromStatus]?.includes(toStatus) || false;
  }

  // Переход статуса
  transitionStatus(docId, newStatus, { reason = '', changedBy = 'system' } = {}) {
    const doc = this.getDocument(docId);
    if (!doc) throw new Error(`Document ${docId} not found`);

    if (!this.isValidTransition(doc.status, newStatus)) {
      throw new Error(`Cannot transition from ${doc.status} to ${newStatus}`);
    }

    const now = new Date().toISOString();

    // Сохранить историю
    db.prepare(`
      INSERT INTO document_history (doc_id, status_from, status_to, changed_by, reason, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(docId, doc.status, newStatus, changedBy, reason, now);

    // Обновить статус документа
    db.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?')
      .run(newStatus, now, docId);

    // Вызвать слушателей события
    const eventName = STATUS_EVENTS[newStatus];
    if (eventName) {
      this.emit(eventName, { docId, docCode: doc.code, newStatus, oldStatus: doc.status });
    }

    return this.getDocument(docId);
  }

  // История изменений статуса
  getHistory(docId) {
    return db.prepare(`
      SELECT * FROM document_history
      WHERE doc_id = ?
      ORDER BY timestamp DESC
    `).all(docId);
  }

  // Слушатель событий
  on(eventName, callback) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, []);
    }
    this.listeners.get(eventName).push(callback);
  }

  // Вызвать события
  emit(eventName, data) {
    const callbacks = this.listeners.get(eventName) || [];
    for (const cb of callbacks) {
      try {
        cb(data);
      } catch (e) {
        console.error(`Error in ${eventName} listener:`, e);
      }
    }
  }

  // Получить информацию для Telegram
  formatForTelegram(doc, includeHistory = false) {
    let text = `📄 *Документ ${doc.code}*\n\n`;
    text += `Статус: _${this.getStatusEmoji(doc.status)} ${doc.status}_\n`;
    text += `Тип: _${doc.type}_\n`;
    text += `Сумма: *${(doc.amount || 0).toFixed(2)} ${doc.currency}*\n`;
    if (doc.title) text += `Описание: _${doc.title}_\n`;
    text += `Создан: _${new Date(doc.created_at).toLocaleString('ru-RU')}_\n`;

    if (includeHistory) {
      const history = this.getHistory(doc.id);
      if (history.length > 0) {
        text += `\n📋 *История:*\n`;
        for (const h of history) {
          text += `• ${new Date(h.timestamp).toLocaleString('ru-RU')} `;
          text += `_${h.status_from}_ → _${h.status_to}_`;
          if (h.reason) text += ` (${h.reason})`;
          text += `\n`;
        }
      }
    }

    return text;
  }

  getStatusEmoji(status) {
    const emojis = {
      [STATES.DRAFT]: '📝',
      [STATES.SENT]: '📤',
      [STATES.SIGNED]: '✅',
      [STATES.PAID]: '💰',
    };
    return emojis[status] || '❓';
  }
}

module.exports = new ProcessManager();
