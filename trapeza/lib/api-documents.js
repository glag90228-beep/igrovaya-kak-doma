'use strict';

const processManager = require('./process-manager');
const expensifyManager = require('./expensify-manager');

// REST API handlers для работы с документами

// POST /api/documents - создать документ
function createDocument(req, res) {
  try {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const { type = 'invoice', title = '', amount = 0, currency = 'RUB', userId } = req.body || {};

    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'userId is required' }));
      return;
    }

    const doc = processManager.createDocument(userId, { type, title, amount, currency });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, document: doc }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// GET /api/documents/:id - получить документ
function getDocument(req, res, docId) {
  try {
    const doc = processManager.getDocument(docId);
    if (!doc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Document not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, document: doc }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// PATCH /api/documents/:id - обновить статус документа
function updateDocument(req, res, docId) {
  try {
    if (req.method !== 'PATCH') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const { status, reason = '', changedBy = 'api' } = req.body || {};

    if (!status) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'status is required' }));
      return;
    }

    const doc = processManager.transitionStatus(docId, status, { reason, changedBy });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, document: doc }));
  } catch (error) {
    if (error.message.includes('Cannot transition')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }
}

// GET /api/documents/:id/history - история изменений
function getHistory(req, res, docId) {
  try {
    const history = processManager.getHistory(docId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, history }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// GET /api/documents - список документов пользователя
function listDocuments(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'userId is required' }));
      return;
    }

    const { docs, total } = processManager.listDocuments(userId, { limit, offset });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, documents: docs, total, limit, offset }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// POST /api/documents/:id/sync-expensify - синхронизировать с Expensify
async function syncExpensify(req, res, docId) {
  try {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const result = await expensifyManager.syncDocument(docId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, expense: result }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// GET /api/documents/:id/expensify-history - история синхронизации с Expensify
function getExpensifyHistory(req, res, docId) {
  try {
    const history = expensifyManager.getSyncHistory(docId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, syncHistory: history }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Маршрутизатор API
function handleDocumentAPI(req, res, pathname) {
  const match = pathname.match(/^\/api\/documents(?:\/(\d+)(?:\/(\w+[-\w]*))?)?$/);
  if (!match) return null;

  const [, docId, subPath] = match;

  // GET /api/documents
  if (!docId && req.method === 'GET') {
    listDocuments(req, res);
    return true;
  }

  // POST /api/documents
  if (!docId && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        req.body = JSON.parse(body);
      } catch {
        req.body = {};
      }
      createDocument(req, res);
    });
    return true;
  }

  // GET /api/documents/:id
  if (docId && !subPath && req.method === 'GET') {
    getDocument(req, res, docId);
    return true;
  }

  // PATCH /api/documents/:id
  if (docId && !subPath && req.method === 'PATCH') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        req.body = JSON.parse(body);
      } catch {
        req.body = {};
      }
      updateDocument(req, res, docId);
    });
    return true;
  }

  // GET /api/documents/:id/history
  if (docId && subPath === 'history' && req.method === 'GET') {
    getHistory(req, res, docId);
    return true;
  }

  // POST /api/documents/:id/sync-expensify
  if (docId && subPath === 'sync-expensify' && req.method === 'POST') {
    syncExpensify(req, res, docId);
    return true;
  }

  // GET /api/documents/:id/expensify-history
  if (docId && subPath === 'expensify-history' && req.method === 'GET') {
    getExpensifyHistory(req, res, docId);
    return true;
  }

  return null;
}

module.exports = {
  handleDocumentAPI,
  createDocument,
  getDocument,
  updateDocument,
  getHistory,
  listDocuments,
  syncExpensify,
  getExpensifyHistory,
};
