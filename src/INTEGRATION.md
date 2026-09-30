# Integration Guide — Database & API Infrastructure

## Архитектура системы

Проект использует **двухуровневую архитектуру**:

### Уровень 1: Trapeza (основной бот)
**Путь**: `trapeza/`
- **База данных**: `data/trapeza.db`
- **Таблицы**: menu_items, orders, order_items, counterparties, operations, settings
- **Бизнес-логика**: bot.js, miniapp.js, lib/
- **API**: Native Node.js http обработчики в lib/api-documents.js

**Используется для**: Основной Telegram-бот для заказов еды, управления меню, обработки платежей.

### Уровень 2: Reconciliation Agent (новая система)
**Путь**: `src/`
- **База данных**: `data/reconciliation.db` (отдельная)
- **Таблицы**: documents, audit_logs, document_metadata, user_preferences, expenses
- **API Framework**: Express.js с middleware
- **Утилиты**: Query builder, validators, helpers

**Используется для**: Управление документами, сверка расходов, синхронизация с Expensify.

## Схемы базы данных

### Trapeza DB (trapeza/db.js)
```
trapeza.db/
├── settings           # Ключ-значение для конфигурации
├── menu_items         # Каталог блюд
├── orders             # Заказы
├── order_items        # Позиции заказов
├── counterparties      # Клиенты и поставщики
├── operations         # Финансовые операции
└── [индексы]
```

### Reconciliation DB (src/database/schema.sql)
```
reconciliation.db/
├── documents                 # Счета, сметы, акты
├── audit_logs               # История изменений
├── document_metadata        # Статус сверки и синхронизации
├── user_preferences         # Настройки уведомлений
├── expenses                 # Расходы из Expensify
└── [индексы]
```

## API структура

### Trapeza API (trapeza/lib)
```javascript
// Использует встроенный Node.js http
const handler = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data }));
};
```

**Маршруты** (в api-documents.js):
- POST /api/documents — создание
- GET /api/documents/:id — получение
- POST /api/documents/:id/status — смена статуса
- и т.д.

### Reconciliation API (src/api)
```javascript
// Использует Express.js с middleware
const app = express();
setupApi(app);

app.post('/documents', validateBody(schema), asyncHandler(async (req, res) => {
  // Обработка с автоматической обработкой ошибок
  res.sendCreated(data);
}));
```

**Преимущества**:
- Встроенная валидация запросов
- Стандартный формат ответов
- Автоматическая обработка ошибок
- Логирование запросов
- Rate limiting
- Authentication/Authorization

## Как компоненты работают вместе

### Сценарий 1: Создание документа в боте
```
Telegram Bot (trapeza/bot.js)
    ↓
lib/bot-documents.js (бизнес-логика)
    ↓
trapeza/db.js (сохранение в trapeza.db)
    ↓
lib/process-manager.js (управление статусом)
```

### Сценарий 2: Синхронизация с Expensify
```
Expensify API
    ↓
lib/expensify-manager.js (получение расходов)
    ↓
src/database/db.js (сохранение в reconciliation.db)
    ↓
src/api (REST API для фронтенда)
```

### Сценарий 3: Система уведомлений
```
Документ получил новый статус
    ↓
trapeza/db (обновление)
    ↓
lib/process-manager.js (проверка событий)
    ↓
src/database/db.js (добавление в audit_logs)
    ↓
src/api (выдача уведомлений через REST)
    ↓
Frontend / Telegram бот
```

## Использование Infrastructure в разных проектах

### Для существующего Trapeza бота
Новая инфраструктура **не требуется** — используется `trapeza/db.js`.

### Для нового Frontend приложения (Dashboard)
```javascript
const { setupApi, asyncHandler } = require('./src/api');
const db = require('./src/database/db');

const app = express();
setupApi(app);

// Маршруты Dashboard'а
app.get('/documents', asyncHandler(async (req, res) => {
  const docs = db.listDocuments({ ...req.query });
  res.sendSuccess(docs);
}));

app.listen(3000);
```

### Для интеграции с внешними сервисами
```javascript
const { ValidationError, NotFoundError } = require('./src/api');

// Внешний сервис вызывает наш API
app.post('/webhooks/expensify', asyncHandler(async (req, res) => {
  const expense = db.createExpense(id, req.body);
  res.sendCreated(expense);
}));
```

## Миграция данных (если требуется)

### Из trapeza.db в reconciliation.db
```javascript
const trapezaDb = require('./trapeza/db');
const reconciliationDb = require('./src/database/db');

// Получение документов из Trapeza
const trapezaDocs = trapezaDb.db.prepare(
  'SELECT * FROM orders WHERE status = ?'
).all('paid');

// Миграция в Reconciliation DB
trapezaDocs.forEach(doc => {
  reconciliationDb.createDocument(generateId(), {
    type: 'invoice',
    status: 'approved',
    amount: doc.total,
    createdBy: doc.user_id,
    externalId: `trapeza-${doc.id}`,
  });
});
```

## Конфигурация окружения

### .env для Trapeza бота
```bash
# Основное
TRAPEZA_DB=/opt/trapeza/data/trapeza.db
BOT_TOKEN=xxx
MINIAPP_URL=https://...

# Почта
SMTP_HOST=...
IMAP_HOST=...
```

### .env для Reconciliation системы
```bash
# БД Reconciliation
RECONCILIATION_DB=/opt/trapeza/data/reconciliation.db

# API
NODE_ENV=production
API_PORT=3000

# Expensify
EXPENSIFY_API_KEY=xxx
EXPENSIFY_WEBHOOK_SECRET=xxx

# Notifications
SLACK_WEBHOOK_URL=xxx
TELEGRAM_BOT_TOKEN=xxx
```

## Безопасность

### Trapeza DB
- Используется **WAL режим** для одновременного доступа (3+ процесса)
- **PRAGMA busy_timeout = 5000** для ожидания блокировки
- **Foreign keys ON** для целостности данных

### Reconciliation DB
- Аналогичные настройки безопасности
- Дополнительно: Request validation, Rate limiting
- Audit logging всех изменений
- IP address отслеживание в audit_logs

## Тестирование

### Unit тесты для Trapeza
```bash
cd trapeza && npm test
# bot-selftest.js, miniapp-selftest.js, documents-selftest.js
```

### Тесты Reconciliation API
```bash
# Будут добавлены в src/tests или src/*-selftest.js
RECONCILIATION_DB=/tmp/test.db node src/example-api.js
```

## Мониторинг и логирование

### Trapeza
- Логи в stdout / файлы системы
- Ошибки в базе данных (operations table)

### Reconciliation
- Структурированные JSON логи
- Audit trail в audit_logs таблице
- Метрики в document_metadata

## Roadmap интеграции

### Фаза 1: ✅ Готово
- [x] Database schema для reconciliation
- [x] CRUD операции
- [x] Audit logging
- [x] Express API middleware

### Фаза 2: В процессе
- [ ] Интеграция с Expensify API
- [ ] Webhook обработчики
- [ ] Email уведомления

### Фаза 3: Планируется
- [ ] Dashboard UI (React/Vue)
- [ ] Импорт документов из Trapeza
- [ ] Автоматическая сверка
- [ ] Отчёты и аналитика

## Вопросы и ответы

**Q: Почему две отдельные БД?**
A: Trapeza работает как независимый бот. Reconciliation система — отдельный сервис. Разделение позволяет:
- Масштабировать независимо
- Разные backup/restore стратегии
- Отсутствие зависимостей

**Q: Можно ли использовать одну БД?**
A: Да, но требует тщательного планирования миграции и может усложнить maintenance.

**Q: Как добавить новую таблицу?**
A: Добавьте CREATE TABLE в src/database/schema.sql, затем функцию в src/database/db.js.

**Q: Как интегрировать с нашей аутентификацией?**
A: Используйте `requireAuth()` middleware в src/api/setupApi.js.
