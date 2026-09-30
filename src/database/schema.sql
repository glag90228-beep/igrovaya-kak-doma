-- Основные документы
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                    -- invoice, estimate, act, waybill
  status TEXT NOT NULL DEFAULT 'draft',  -- draft, submitted, approved, rejected, archived
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'RUB',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  external_id TEXT,
  notes TEXT DEFAULT ''
);

-- Лог аудита: все изменения статусов документов
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                  -- created, status_changed, updated, deleted
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT
);

-- Метаданные процесса для каждого документа
CREATE TABLE IF NOT EXISTS document_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  reconciliation_status TEXT DEFAULT 'pending',  -- pending, in_progress, completed, failed
  reconciliation_timestamp TEXT,
  expensify_sync_status TEXT DEFAULT 'not_synced',  -- not_synced, synced, failed
  expensify_sync_timestamp TEXT,
  last_validation_timestamp TEXT,
  validation_errors TEXT,                -- JSON array of errors
  processing_attempts INTEGER DEFAULT 0,
  last_error TEXT,
  tags TEXT DEFAULT ''                   -- JSON array of tags
);

-- Настройки уведомлений пользователей
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  phone TEXT,
  notifications_enabled INTEGER DEFAULT 1,
  notify_on_status_change INTEGER DEFAULT 1,
  notify_on_document_update INTEGER DEFAULT 1,
  notify_on_reconciliation INTEGER DEFAULT 1,
  notify_on_expensify_sync INTEGER DEFAULT 1,
  language TEXT DEFAULT 'ru',            -- ru, en
  timezone TEXT DEFAULT 'UTC',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Синхронизированные расходы из Expensify
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  expensify_id TEXT UNIQUE NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  category TEXT NOT NULL DEFAULT 'uncategorized',
  description TEXT DEFAULT '',
  merchant TEXT,
  transaction_date TEXT NOT NULL,
  receipt_url TEXT,
  status TEXT NOT NULL DEFAULT 'unmatched',  -- unmatched, matched, reconciled, rejected
  matched_at TEXT,
  synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at);
CREATE INDEX IF NOT EXISTS idx_documents_created_by ON documents(created_by);
CREATE INDEX IF NOT EXISTS idx_documents_external_id ON documents(external_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_document ON audit_logs(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_changed_at ON audit_logs(changed_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

CREATE INDEX IF NOT EXISTS idx_metadata_reconciliation_status ON document_metadata(reconciliation_status);
CREATE INDEX IF NOT EXISTS idx_metadata_expensify_sync_status ON document_metadata(expensify_sync_status);

CREATE INDEX IF NOT EXISTS idx_expenses_document ON expenses(document_id);
CREATE INDEX IF NOT EXISTS idx_expenses_expensify_id ON expenses(expensify_id);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_expenses_transaction_date ON expenses(transaction_date);
CREATE INDEX IF NOT EXISTS idx_expenses_matched_at ON expenses(matched_at);
