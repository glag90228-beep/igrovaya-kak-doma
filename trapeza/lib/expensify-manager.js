'use strict';

const https = require('node:https');
const { db } = require('../db');

const EXPENSIFY_API_ENDPOINT = 'https://integrations.expensify.com/Integration-Server/ExpensifyIntegrationServer';

function ensureExpensifyTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expensify_syncs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id        INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      expense_id    TEXT    NOT NULL DEFAULT '',
      status        TEXT    NOT NULL DEFAULT 'pending',
      last_sync     TEXT    NOT NULL,
      error         TEXT    NOT NULL DEFAULT '',
      response      TEXT    NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_exp_doc ON expensify_syncs(doc_id);
  `);
}

class ExpensifyManager {
  constructor(apiToken = '') {
    this.apiToken = apiToken || process.env.EXPENSIFY_API_TOKEN || '';
    ensureExpensifyTable();
  }

  // Отправить расход в Expensify
  async submitExpense(docId, { email, amount, description, merchant = '', date } = {}) {
    if (!this.apiToken) {
      throw new Error('Expensify API token not configured');
    }

    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
    if (!doc) throw new Error(`Document ${docId} not found`);

    const payload = {
      requestType: 'create',
      credentials: {
        email: email || 'default@example.com',
        password: '', // Обычно используется OAuth или API ключ
      },
      inputSettings: {
        type: 'EXPENSE',
        created: date || new Date().toISOString().split('T')[0],
        merchant: merchant || doc.title || 'Transaction',
        amount: Math.round(amount * 100) || Math.round(doc.amount * 100),
        currency: doc.currency || 'RUB',
        comment: description || doc.title,
        category: 'Uncategorized',
      },
    };

    try {
      const response = await this.makeRequest(payload);

      // Сохранить информацию о синхронизации
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO expensify_syncs (doc_id, expense_id, status, last_sync, response)
        VALUES (?, ?, ?, ?, ?)
      `).run(docId, response.expenseID || '', 'synced', now, JSON.stringify(response));

      return {
        success: true,
        expenseId: response.expenseID,
        expense: response,
      };
    } catch (error) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO expensify_syncs (doc_id, status, last_sync, error)
        VALUES (?, ?, ?, ?)
      `).run(docId, 'error', now, error.message);

      throw error;
    }
  }

  // Получить статус расхода
  async getExpenseStatus(expenseId) {
    const payload = {
      requestType: 'get',
      expenseID: expenseId,
    };

    return this.makeRequest(payload);
  }

  // Синхронизировать документ с Expensify
  async syncDocument(docId) {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
    if (!doc) throw new Error(`Document ${docId} not found`);

    const sync = db.prepare('SELECT * FROM expensify_syncs WHERE doc_id = ? LIMIT 1').get(docId);

    if (sync && sync.expense_id) {
      // Обновить существующий расход
      return this.updateExpense(docId, sync.expense_id, doc);
    } else {
      // Создать новый
      return this.submitExpense(docId, {
        description: doc.title,
        amount: doc.amount,
      });
    }
  }

  // Обновить расход в Expensify
  async updateExpense(docId, expenseId, docData) {
    const payload = {
      requestType: 'update',
      expenseID: expenseId,
      inputSettings: {
        amount: Math.round(docData.amount * 100),
        comment: docData.title,
      },
    };

    const response = await this.makeRequest(payload);
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE expensify_syncs
      SET status = 'synced', last_sync = ?, response = ?
      WHERE doc_id = ?
    `).run(now, JSON.stringify(response), docId);

    return response;
  }

  // HTTP запрос к Expensify API
  makeRequest(payload) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const options = {
        hostname: 'integrations.expensify.com',
        path: '/Integration-Server/ExpensifyIntegrationServer',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Authorization': `Bearer ${this.apiToken}`,
        },
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode === 200 || res.statusCode === 201) {
              resolve(parsed);
            } else {
              reject(new Error(`Expensify API error: ${parsed.error || body}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse Expensify response: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // Получить список синхронизаций
  getSyncHistory(docId) {
    return db.prepare(`
      SELECT * FROM expensify_syncs
      WHERE doc_id = ?
      ORDER BY last_sync DESC
    `).all(docId);
  }

  // Проверить, нужна ли синхронизация
  needsSync(docId) {
    const sync = db.prepare('SELECT * FROM expensify_syncs WHERE doc_id = ? LIMIT 1').get(docId);
    if (!sync) return true;

    // Если была ошибка, попробовать ещё раз через час
    if (sync.status === 'error') {
      const lastSync = new Date(sync.last_sync);
      const oneHourAgo = new Date(Date.now() - 3600000);
      return lastSync < oneHourAgo;
    }

    return false;
  }
}

module.exports = new ExpensifyManager();
