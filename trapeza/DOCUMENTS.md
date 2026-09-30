# Управление документами — ProcessManager + Expensify

Система управления документами (счета, акты, платёжные поручения) с отслеживанием статусов и интеграцией Expensify.

## Компоненты

### ProcessManager (`lib/process-manager.js`)

Управление жизненным циклом документов:
- **Состояния**: `draft` → `sent` → `signed` → `paid`
- **Методы**:
  - `createDocument(userId, options)` — создать документ
  - `getDocument(id)` — получить по ID
  - `getDocumentByCode(code)` — получить по коду
  - `listDocuments(userId, options)` — список документов пользователя
  - `transitionStatus(docId, newStatus, options)` — смена статуса
  - `getHistory(docId)` — история изменений
  - `isValidTransition(from, to)` — проверка возможности перехода
  - `on(eventName, callback)` — подписка на события
  - `formatForTelegram(doc, includeHistory)` — форматирование для Telegram

### ExpensifyManager (`lib/expensify-manager.js`)

Синхронизация с приложением расходов Expensify:
- **Методы**:
  - `submitExpense(docId, options)` — отправить расход в Expensify
  - `syncDocument(docId)` — синхронизировать документ
  - `updateExpense(docId, expenseId, docData)` — обновить расход
  - `getSyncHistory(docId)` — история синхронизаций
  - `needsSync(docId)` — нужна ли синхронизация

### Telegram Handlers (`lib/bot-documents.js`)

Команды бота для работы с документами:
- `/bill_create [сумма] [описание]` — создать документ
- `/bill_list` — список документов пользователя
- `/bill_status {код}` — статус и история документа
- `/transition {код} {статус} [причина]` — изменить статус (админ)

### REST API (`lib/api-documents.js`)

HTTP endpoints для работы с документами:

```
POST   /api/documents              — создать документ
GET    /api/documents              — список документов (фильтр по userId)
GET    /api/documents/:id          — получить документ
PATCH  /api/documents/:id          — изменить статус
GET    /api/documents/:id/history  — история изменений
POST   /api/documents/:id/sync-expensify    — синхронизировать с Expensify
GET    /api/documents/:id/expensify-history — история синхронизации
```

## База данных

Таблицы:
- **documents** — основные данные документов
- **document_history** — аудит изменений статусов
- **expensify_syncs** — история синхронизаций с Expensify

## Примеры использования

### Создание документа

```javascript
const processManager = require('./lib/process-manager');

const doc = processManager.createDocument(userId, {
  type: 'invoice',
  title: 'Счёт №123',
  amount: 5000,
  currency: 'RUB',
});
// → { id: 1, code: 'doc_123_1234567890_abc123def', status: 'draft', ... }
```

### Смена статуса с событием

```javascript
// Подписаться на событие
processManager.on('document:sent', ({ docId, docCode }) => {
  console.log(`Документ ${docCode} отправлен`);
});

// Изменить статус
processManager.transitionStatus(docId, 'sent', {
  reason: 'Отправлено контрагенту',
  changedBy: 'user_123',
});
```

### Синхронизация с Expensify

```javascript
const expensifyManager = require('./lib/expensify-manager');

// Отправить расход
const result = await expensifyManager.submitExpense(docId, {
  email: 'user@example.com',
  amount: 5000,
  description: 'Счёт №123',
  merchant: 'ООО Первичка',
});

// История синхронизаций
const syncs = expensifyManager.getSyncHistory(docId);
```

### Telegram команды

```
/bill_create 5000 Счёт за доставку
→ ✅ Документ создан
  Код: doc_123_1234567890_abc123def
  Сумма: 5000.00 ₽
  Статус: draft

/bill_list
→ 📋 Ваши документы (всего: 3)
  📝 doc_123_456
     Сумма: 5000.00 ₽ | Статус: draft
     30.09.2026

/bill_status doc_123_456
→ 📄 Документ doc_123_456
  Статус: 📝 draft
  Тип: invoice
  Сумма: 5000.00 RUB
  Создан: 30.09.2026 14:35:22
```

### API примеры

```bash
# Создать документ
curl -X POST http://localhost:3000/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 123,
    "type": "invoice",
    "title": "Счёт №123",
    "amount": 5000,
    "currency": "RUB"
  }'

# Получить документ
curl http://localhost:3000/api/documents/1

# Изменить статус
curl -X PATCH http://localhost:3000/api/documents/1 \
  -H "Content-Type: application/json" \
  -d '{
    "status": "sent",
    "reason": "Отправлено контрагенту",
    "changedBy": "api"
  }'

# История изменений
curl http://localhost:3000/api/documents/1/history

# Синхронизировать с Expensify
curl -X POST http://localhost:3000/api/documents/1/sync-expensify

# История синхронизации
curl http://localhost:3000/api/documents/1/expensify-history
```

## Конфигурация

### Переменные окружения

- `EXPENSIFY_API_TOKEN` — API ключ Expensify
- `TRAPEZA_DB` — путь к БД (по умолчанию `trapeza/data/trapeza.db`)

### События ProcessManager

- `document:sent` — документ отправлен
- `document:signed` — документ подписан
- `document:paid` — документ оплачен

## Тестирование

```bash
cd trapeza
npm test  # запустить все тесты
TRAPEZA_DB=/tmp/test.db node documents-selftest.js  # тесты документов
```

## Интеграция с существующим кодом

### В bot.js

```javascript
const { handleBillCreate, handleBillList, handleBillStatus } = require('./lib/bot-documents');

// В обработчике команд
if (text.startsWith('/bill_create')) {
  await handleBillCreate(ctx, tg);
} else if (text.startsWith('/bill_list')) {
  await handleBillList(ctx, tg);
} else if (text.startsWith('/bill_status')) {
  await handleBillStatus(ctx, tg);
}
```

### В server.js

```javascript
const { handleDocumentAPI } = require('./lib/api-documents');

// В обработчике HTTP запросов
const apiResult = handleDocumentAPI(req, res, pathname);
if (apiResult) return; // обработано
```

## Аудит и логирование

Все изменения статусов логируются в таблице `document_history`:
- Кто изменил (email или username)
- Когда (timestamp)
- Причина (reason)
- Старый и новый статусы

История доступна через API и Telegram команды.
