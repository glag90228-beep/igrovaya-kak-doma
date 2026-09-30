# Database Schema & API Infrastructure

Инфраструктура для управления документами, сверок и синхронизации расходов из Expensify.

## Структура

```
src/
├── database/
│   ├── schema.sql          # Схема базы данных
│   └── db.js               # Инициализация и операции с БД
└── api/
    ├── middleware/
    │   ├── errorHandler.js     # Обработка ошибок
    │   ├── validator.js        # Валидация запросов
    │   ├── responseFormatter.js # Форматирование ответов
    │   └── index.js
    ├── utils/
    │   ├── queryBuilder.js      # Построитель SQL запросов
    │   ├── helpers.js           # Вспомогательные функции
    │   └── index.js
    ├── setupApi.js          # Инициализация Express приложения
    └── index.js
```

## База данных

### Таблицы

#### `documents`
Основные документы (счета, сметы, акты, накладные).

```sql
id               TEXT PRIMARY KEY
type             TEXT NOT NULL         -- invoice, estimate, act, waybill
status           TEXT DEFAULT 'draft'  -- draft, submitted, approved, rejected, archived
amount           REAL DEFAULT 0
currency         TEXT DEFAULT 'RUB'
created_at       TEXT NOT NULL
updated_at       TEXT NOT NULL
created_by       TEXT NOT NULL
external_id      TEXT
notes            TEXT
```

#### `audit_logs`
Логирование всех изменений статусов и данных документов.

```sql
id              INTEGER PRIMARY KEY AUTOINCREMENT
document_id     TEXT NOT NULL (FK documents)
action          TEXT NOT NULL         -- created, status_changed, updated, deleted
old_value       TEXT
new_value       TEXT
changed_by      TEXT NOT NULL
changed_at      TEXT NOT NULL
ip_address      TEXT
user_agent      TEXT
```

#### `document_metadata`
Метаданные процесса обработки документов.

```sql
id                      INTEGER PRIMARY KEY AUTOINCREMENT
document_id             TEXT UNIQUE (FK documents)
version                 INTEGER DEFAULT 1
reconciliation_status   TEXT DEFAULT 'pending'     -- pending, in_progress, completed, failed
reconciliation_timestamp TEXT
expensify_sync_status   TEXT DEFAULT 'not_synced'  -- not_synced, synced, failed
expensify_sync_timestamp TEXT
last_validation_timestamp TEXT
validation_errors       TEXT                       -- JSON array
processing_attempts     INTEGER DEFAULT 0
last_error              TEXT
tags                    TEXT                       -- JSON array
```

#### `user_preferences`
Настройки уведомлений пользователей.

```sql
user_id                  TEXT PRIMARY KEY
email                    TEXT
phone                    TEXT
notifications_enabled    INTEGER DEFAULT 1
notify_on_status_change  INTEGER DEFAULT 1
notify_on_document_update INTEGER DEFAULT 1
notify_on_reconciliation INTEGER DEFAULT 1
notify_on_expensify_sync INTEGER DEFAULT 1
language                 TEXT DEFAULT 'ru'
timezone                 TEXT DEFAULT 'UTC'
created_at               TEXT NOT NULL
updated_at               TEXT NOT NULL
```

#### `expenses`
Синхронизированные расходы из Expensify.

```sql
id                  TEXT PRIMARY KEY
document_id         TEXT (FK documents)
expensify_id        TEXT UNIQUE NOT NULL
amount              REAL NOT NULL
currency            TEXT DEFAULT 'RUB'
category            TEXT DEFAULT 'uncategorized'
description         TEXT
merchant            TEXT
transaction_date    TEXT NOT NULL
receipt_url         TEXT
status              TEXT DEFAULT 'unmatched'  -- unmatched, matched, reconciled, rejected
matched_at          TEXT
synced_at           TEXT NOT NULL
created_at          TEXT NOT NULL
updated_at          TEXT NOT NULL
```

## API Инициализация

### Базовый пример

```javascript
const express = require('express');
const { setupApi, asyncHandler } = require('./src/api');
const db = require('./src/database/db');

const app = express();

// Инициализация API
setupApi(app, {
  trustProxy: true,
  enableLogging: true,
  enableCors: true,
  corsOptions: {
    origin: process.env.ALLOWED_ORIGINS || '*',
  },
});

// Маршруты
app.post('/documents', asyncHandler(async (req, res) => {
  const { type, amount, createdBy } = req.body;
  const doc = db.createDocument(crypto.randomUUID(), {
    type,
    amount,
    createdBy,
  });
  res.sendCreated(doc, 'Document created');
}));

app.get('/documents/:id', asyncHandler(async (req, res) => {
  const doc = db.getDocument(req.params.id);
  if (!doc) throw new NotFoundError('Document not found');
  res.sendSuccess(doc);
}));

app.listen(3000, () => console.log('Server running on port 3000'));
```

## Middleware

### Error Handler

Автоматически обрабатывает ошибки и возвращает стандартные ответы.

```javascript
// Выброс ошибки в маршруте
throw new ValidationError('Invalid input', { field: 'email' });
throw new NotFoundError('User not found');
throw new UnauthorizedError('Login required');
throw new ForbiddenError('Insufficient permissions');
throw new ConflictError('Resource already exists');
```

### Validator

Валидация входных данных.

```javascript
const { Schema, validateBody } = require('./src/api/middleware');

const createDocSchema = new Schema({
  type: { type: 'string', required: true, enum: ['invoice', 'estimate', 'act'] },
  amount: { type: 'number', required: true, min: 0 },
  createdBy: { type: 'string', required: true, minLength: 1 },
});

app.post('/documents', 
  validateBody(createDocSchema),
  asyncHandler(async (req, res) => {
    // req.body уже валидирован
  })
);
```

### Response Formatter

Стандартный формат ответов.

```javascript
// Успех
res.sendSuccess(data);
res.sendSuccess(data, 'Custom message');

// С пагинацией
res.sendPaginated(items, total, limit, offset);

// Создание
res.sendCreated(data, 'Created');

// Приятие
res.sendAccepted(data, 'Accepted');

// Пусто
res.sendNoContent();
```

## Утилиты

### Query Builder

```javascript
const { QueryBuilder } = require('./src/api/utils');

const query = new QueryBuilder()
  .table('documents')
  .selectFields('id', 'type', 'amount', 'status')
  .leftJoin('document_metadata', 'document_metadata.document_id = documents.id')
  .where('documents.status = ?', 'approved')
  .andWhere('documents.amount > ?', 1000)
  .orderByField('documents.created_at', 'DESC')
  .limit(50)
  .offset(0);

const { sql, params } = query.build();
const results = db.db.prepare(sql).all(...params);
```

### Helpers

```javascript
const {
  generateDocumentId,
  generateExpenseId,
  formatMoney,
  isValidDocumentStatus,
  isValidINN,
  normalizePhone,
  getPaginationParams,
} = require('./src/api/utils');

const docId = generateDocumentId('invoice');  // INV-xxxxx
const money = formatMoney(1500.50, 'RUB');    // { amount: 1500.50, ... }

const paging = getPaginationParams({ limit: 25, offset: 0 });
```

## Работа с транзакциями

```javascript
const result = db.runInTransaction(() => {
  const doc = db.createDocument(id, { ... });
  const meta = db.createMetadata(id, { ... });
  return { doc, meta };
});
```

## Переменные окружения

```bash
# База данных
RECONCILIATION_DB=/opt/data/reconciliation.db

# API
NODE_ENV=production
ALLOWED_ORIGINS=https://app.example.com
```

## Индексы

Автоматически создаются при инициализации для быстрого поиска:
- `documents.status`
- `documents.created_at`
- `documents.created_by`
- `audit_logs.document_id`
- `audit_logs.changed_at`
- `document_metadata.reconciliation_status`
- `expenses.document_id`
- `expenses.status`
- `expenses.transaction_date`

## Примеры

### Создание документа

```javascript
const doc = db.createDocument('INV-123456', {
  type: 'invoice',
  status: 'draft',
  amount: 5000,
  createdBy: 'user@example.com',
  externalId: 'exp-789',
  notes: 'Invoice for services',
});

// Создание метаданных
const meta = db.createMetadata('INV-123456', {
  reconciliationStatus: 'pending',
  expensifySyncStatus: 'not_synced',
});
```

### Обновление статуса

```javascript
const updated = db.updateDocument('INV-123456', {
  status: 'submitted',
  updatedBy: 'user@example.com',
});

// Просмотр истории
const logs = db.getAuditLogs('INV-123456', { limit: 20 });
```

### Синхронизация расходов

```javascript
// Создание расхода
const expense = db.createExpense('EXP-xxx', {
  expensifyId: 'e-12345',
  amount: 500,
  category: 'meals',
  transactionDate: '2024-01-15',
});

// Привязка к документу
db.updateExpense('EXP-xxx', {
  documentId: 'INV-123456',
  status: 'matched',
  matchedAt: new Date().toISOString(),
});
```

### Получение статистики

```javascript
// Все неопубликованные документы
const drafts = db.listDocuments({ status: 'draft' });

// Документы пользователя
const userDocs = db.listDocuments({ createdBy: 'user@example.com' });

// Несинхронизированные расходы
const unsynced = db.listExpenses({ status: 'unmatched' });
```
