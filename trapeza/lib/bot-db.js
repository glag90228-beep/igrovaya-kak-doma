'use strict';

// Многопользовательский слой для бота: пользователи Telegram, их организации,
// контрагенты и операции. Всё строго изолировано по user_id — пользователь
// никогда не видит чужие данные. Надстройка над существующей базой (db.js).

const { db, computeBalance } = require('../db');

// ---------- миграции (не ломают существующие таблицы) ----------

function columns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function addColumn(table, name, def) {
  if (!columns(table).includes(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id      INTEGER NOT NULL UNIQUE,
      name       TEXT    NOT NULL DEFAULT '',
      username   TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL,
      state      TEXT    NOT NULL DEFAULT '',
      state_data TEXT    NOT NULL DEFAULT '',
      access_until TEXT  NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS orgs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL DEFAULT '',
      full_name  TEXT    NOT NULL DEFAULT '',
      inn        TEXT    NOT NULL DEFAULT '',
      kpp        TEXT    NOT NULL DEFAULT '',
      signer     TEXT    NOT NULL DEFAULT '',
      address    TEXT    NOT NULL DEFAULT '',
      bank_name  TEXT    NOT NULL DEFAULT '',
      bik        TEXT    NOT NULL DEFAULT '',
      acc        TEXT    NOT NULL DEFAULT '',
      corr_acc   TEXT    NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orgs_user ON orgs(user_id);
  `);

  db.exec(`
    -- Выписанные документы. Храним не файл, а данные: файл пересобирается
    -- по требованию, зато «повторить прошлый счёт» получается бесплатно.
    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
      org_id     INTEGER NOT NULL DEFAULT 0,
      cp_id      INTEGER NOT NULL DEFAULT 0,
      type       TEXT    NOT NULL,              -- sch | usl | pp | akt | upd | torg12 | dog
      number     TEXT    NOT NULL DEFAULT '',
      seq        INTEGER NOT NULL DEFAULT 0,    -- порядковый номер внутри года
      year       INTEGER NOT NULL DEFAULT 0,
      date       TEXT    NOT NULL DEFAULT '',
      total      REAL    NOT NULL DEFAULT 0,
      payload    TEXT    NOT NULL DEFAULT '',   -- JSON: позиции, сумма, назначение
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_doc_user ON documents(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_doc_seq  ON documents(user_id, type, year);

    -- Часто повторяющиеся позиции: у малого бизнеса счёт — почти всегда
    -- копия предыдущего, набирать «Канапе ассорти; 20; 650» каждый раз незачем.
    CREATE TABLE IF NOT EXISTS item_templates (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id  INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
      name     TEXT    NOT NULL,
      unit     TEXT    NOT NULL DEFAULT 'шт.',
      price    REAL    NOT NULL DEFAULT 0,
      uses     INTEGER NOT NULL DEFAULT 1,
      used_at  TEXT    NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tpl_uniq ON item_templates(user_id, name);

    -- Строки банковской выписки, уже занесённые в журнал.
    --
    -- Хранить приходится не сами строки, а их ключи: выписку за месяц
    -- выгружают повторно ради последних дней, и без такой памяти каждая
    -- загрузка задваивала бы все прошлые оплаты. Уникальный индекс — не
    -- перестраховка: он держит правило даже тогда, когда приложение
    -- пришлёт одну и ту же строку дважды.
    CREATE TABLE IF NOT EXISTS bank_imports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
      key        TEXT    NOT NULL,             -- дата|направление|сумма|назначение
      op_id      INTEGER NOT NULL DEFAULT 0,
      cp_id      INTEGER NOT NULL DEFAULT 0,
      amount     REAL    NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_uniq ON bank_imports(user_id, key);

    -- Регулярные документы: «каждый месяц счёт за аренду этому клиенту».
    -- Хранится договорённость, а не документ: в нужный день бот приходит
    -- с предложением, а выписывает человек. Подробности — в lib/recurring.js.
    CREATE TABLE IF NOT EXISTS recurring (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
      cp_id      INTEGER NOT NULL,
      type       TEXT    NOT NULL,              -- sch | schdog | usl | upd | torg12
      day        INTEGER NOT NULL DEFAULT 1,    -- 1..28, либо 0 — последнее число
      items      TEXT    NOT NULL DEFAULT '[]', -- JSON позиций
      extra      TEXT    NOT NULL DEFAULT '{}', -- остальные поля документа: НДС, статус УПД
      note       TEXT    NOT NULL DEFAULT '',
      active     INTEGER NOT NULL DEFAULT 1,
      last_offer TEXT    NOT NULL DEFAULT '',   -- YYYY-MM: за какой месяц предлагали
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rec_user ON recurring(user_id, active);
  `);

  /*
   * Чем занимается бизнес. Нужен ровно для одного: подсказать, откуда у
   * этого бизнеса берётся долг, и не заставлять новичка выбирать между
   * «по акту» и «по счёту», не понимая вопроса.
   *
   * На боевом сервере колонку добавляли скриптом поверх файлов, минуя
   * миграции, — поэтому в репозитории её не было, и обновление кода снесло
   * бы правку. Место колонки — здесь.
   */
  addColumn('orgs', 'biz_type', "TEXT NOT NULL DEFAULT ''");

  // Заблокировавшие бота: рассылать им бессмысленно, а каждая попытка —
  // ошибка в логе и лишний запрос.
  addColumn('bot_users', 'blocked_at', "TEXT NOT NULL DEFAULT ''");

  // расширяем контрагентов: владелец + банковские реквизиты (для счёта/платёжки)
  addColumn('counterparties', 'user_id', 'INTEGER');
  addColumn('counterparties', 'address', "TEXT NOT NULL DEFAULT ''");
  addColumn('counterparties', 'bank_name', "TEXT NOT NULL DEFAULT ''");
  addColumn('counterparties', 'bik', "TEXT NOT NULL DEFAULT ''");
  addColumn('counterparties', 'acc', "TEXT NOT NULL DEFAULT ''");
  addColumn('counterparties', 'corr_acc', "TEXT NOT NULL DEFAULT ''");
  // Почта контрагента: чтобы отправлять счёт сразу, не спрашивая каждый раз.
  addColumn('counterparties', 'email', "TEXT NOT NULL DEFAULT ''");

  // Режим НДС организации: спрашивать ставку у каждого счёта — мучение,
  // бухгалтер выписывает их десятками, а система налогообложения меняется
  // раз в год. Храним у организации, у документа можно переопределить.
  addColumn('orgs', 'vat_rate', "TEXT NOT NULL DEFAULT ''");   // '' | '0' | '10' | '20'
  addColumn('orgs', 'vat_gross', 'INTEGER NOT NULL DEFAULT 0'); // 1 — цены уже с НДС
  // ОГРНИП: в УПД есть графа, а поля не было — печаталось пусто.
  addColumn('orgs', 'ogrnip', "TEXT NOT NULL DEFAULT ''");

  /*
   * Из чего возникает долг контрагента — свойство бизнеса, а не общее правило.
   *
   *   closing — из акта, УПД или накладной. Так у подрядчика и в торговле:
   *             счёт лишь просьба заплатить, задолженность даёт реализация.
   *   invoice — из счёта. Так в аренде и субаренде: акт по ГК не обязателен,
   *             его часто не составляют вовсе, а счёт выставляют ежемесячно.
   *   manual  — ничего не создавать, журнал ведётся руками.
   *
   * Выбор один на организацию: смешивать нельзя, иначе долг задвоится —
   * сначала по счёту, потом по акту на ту же сделку.
   */
  addColumn('orgs', 'debt_basis', "TEXT NOT NULL DEFAULT 'closing'");

  // Отметка оплаты документа и связь операции с документом: по ней
  // отменяют проводку и не создают её дважды.
  addColumn('documents', 'paid_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('operations', 'doc_id', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ops_doc ON operations(doc_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cp_user ON counterparties(user_id)');
}

migrate();

// ---------- пользователи и состояние диалога ----------

function getOrCreateUser(tgId, name = '', username = '') {
  let u = db.prepare('SELECT * FROM bot_users WHERE tg_id = ?').get(tgId);
  if (!u) {
    db.prepare('INSERT INTO bot_users(tg_id, name, username, created_at) VALUES(?,?,?,?)')
      .run(tgId, name, username, new Date().toISOString());
    u = db.prepare('SELECT * FROM bot_users WHERE tg_id = ?').get(tgId);
  } else if ((name && name !== u.name) || (username && username !== u.username)) {
    db.prepare('UPDATE bot_users SET name = ?, username = ? WHERE id = ?').run(name, username, u.id);
  }
  return u;
}

function setState(userId, state, data = null) {
  db.prepare('UPDATE bot_users SET state = ?, state_data = ? WHERE id = ?')
    .run(state || '', data == null ? '' : JSON.stringify(data), userId);
}
function getState(userId) {
  const u = db.prepare('SELECT state, state_data FROM bot_users WHERE id = ?').get(userId);
  if (!u) return { state: '', data: {} };
  let data = {};
  try { data = u.state_data ? JSON.parse(u.state_data) : {}; } catch (_) { data = {}; }
  return { state: u.state || '', data };
}
function clearState(userId) { setState(userId, '', null); }

// ---------- организации пользователя ----------

function createOrg(userId, fields) {
  const cols = ['name', 'full_name', 'inn', 'kpp', 'signer', 'address',
    'bank_name', 'bik', 'acc', 'corr_acc', 'ogrnip'];
  const vals = cols.map((c) => fields[c] || '');
  const anyDefault = db.prepare('SELECT COUNT(*) AS n FROM orgs WHERE user_id = ?').get(userId).n;
  const info = db.prepare(`
    INSERT INTO orgs(user_id, ${cols.join(',')}, is_default, created_at)
    VALUES(?, ${cols.map(() => '?').join(',')}, ?, ?)`)
    .run(userId, ...vals, anyDefault === 0 ? 1 : 0, new Date().toISOString());
  return Number(info.lastInsertRowid);
}
/** Режим НДС организации в удобном виде: {rate: number|null, gross: boolean}. */
function vatOf(org) {
  const raw = org && org.vat_rate;
  const rate = raw === '' || raw == null ? null : Number(raw);
  return { rate: Number.isFinite(rate) ? rate : null, gross: Boolean(org && org.vat_gross) };
}

function updateOrg(userId, id, fields) {
  const allowed = ['name', 'full_name', 'inn', 'kpp', 'signer', 'address',
    'bank_name', 'bik', 'acc', 'corr_acc', 'ogrnip', 'vat_rate', 'vat_gross', 'debt_basis',
    'biz_type'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  if (!sets.length) return;
  vals.push(id, userId);
  db.prepare(`UPDATE orgs SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
}
function listOrgs(userId) {
  return db.prepare('SELECT * FROM orgs WHERE user_id = ? ORDER BY is_default DESC, id').all(userId);
}
function getOrg(userId, id) {
  return db.prepare('SELECT * FROM orgs WHERE id = ? AND user_id = ?').get(id, userId);
}
function getDefaultOrg(userId) {
  return db.prepare('SELECT * FROM orgs WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1').get(userId);
}
function setDefaultOrg(userId, id) {
  db.prepare('UPDATE orgs SET is_default = 0 WHERE user_id = ?').run(userId);
  db.prepare('UPDATE orgs SET is_default = 1 WHERE id = ? AND user_id = ?').run(id, userId);
}

/**
 * «Ввести заново» должно ЗАМЕНЯТЬ мою организацию, а не плодить новые.
 * Раньше каждая правка создавала ещё одну организацию, а бот продолжал
 * брать самую первую — поэтому изменения будто не применялись. Теперь
 * обновляем организацию по умолчанию на месте и убираем дубликаты.
 */
function saveMyOrg(userId, fields) {
  const def = getDefaultOrg(userId);
  if (def) {
    updateOrg(userId, def.id, fields);
    db.prepare('DELETE FROM orgs WHERE user_id = ? AND id <> ?').run(userId, def.id);
    db.prepare('UPDATE orgs SET is_default = 1 WHERE id = ?').run(def.id);
    return def.id;
  }
  return createOrg(userId, fields);
}

// ---------- контрагенты пользователя ----------

function createCp(userId, fields) {
  const cols = ['name', 'full_name', 'inn', 'kpp', 'extra', 'kind', 'contract',
    'opening_balance', 'opening_date', 'period_end', 'signer',
    'address', 'bank_name', 'bik', 'acc', 'corr_acc', 'email'];
  const vals = cols.map((c) => (c === 'opening_balance' ? (Number(fields[c]) || 0) : (fields[c] || '')));
  const info = db.prepare(`
    INSERT INTO counterparties(user_id, ${cols.join(',')})
    VALUES(?, ${cols.map(() => '?').join(',')})`).run(userId, ...vals);
  return Number(info.lastInsertRowid);
}
function updateCp(userId, id, fields) {
  const allowed = ['name', 'full_name', 'inn', 'kpp', 'extra', 'kind', 'contract',
    'opening_balance', 'opening_date', 'period_end', 'signer',
    'address', 'bank_name', 'bik', 'acc', 'corr_acc', 'email'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  if (!sets.length) return;
  vals.push(id, userId);
  db.prepare(`UPDATE counterparties SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
}
function listCps(userId) {
  return db.prepare('SELECT * FROM counterparties WHERE user_id = ? ORDER BY id').all(userId);
}
function getCp(userId, id) {
  return db.prepare('SELECT * FROM counterparties WHERE id = ? AND user_id = ?').get(id, userId);
}

// ---------- операции контрагента (с проверкой владельца) ----------

/** @returns {number} id созданной операции — нужен импорту выписки. */
function addOp(userId, cpId, op) {
  const cp = getCp(userId, cpId);
  if (!cp) throw new Error('Контрагент не найден');
  const sort = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS s FROM operations WHERE cp_id = ?').get(cpId).s;
  const info = db.prepare(`INSERT INTO operations(cp_id, date, kind, doc, debit, credit, note, sort)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(cpId, op.date, op.kind || '', op.doc || '', Number(op.debit) || 0, Number(op.credit) || 0,
      op.note || '', sort);
  return Number(info.lastInsertRowid);
}
function listOps(userId, cpId) {
  const cp = getCp(userId, cpId);
  if (!cp) return [];
  return db.prepare('SELECT * FROM operations WHERE cp_id = ? ORDER BY date, sort, id').all(cpId);
}
function deleteLastOp(userId, cpId) {
  const cp = getCp(userId, cpId);
  if (!cp) return false;
  const row = db.prepare('SELECT id FROM operations WHERE cp_id = ? ORDER BY date DESC, sort DESC, id DESC LIMIT 1').get(cpId);
  if (!row) return false;
  db.prepare('DELETE FROM operations WHERE id = ?').run(row.id);
  // Если операция пришла из выписки, забываем и отметку о загрузке: иначе
  // отменённую по ошибке оплату больше не загрузить — строка навсегда
  // числится импортированной.
  db.prepare('DELETE FROM bank_imports WHERE user_id = ? AND op_id = ?').run(userId, row.id);
  return true;
}

// ---------- банковская выписка ----------

/** Какие строки выписки уже заносили: их показываем как загруженные. */
function knownBankKeys(userId, keys) {
  const out = new Set();
  if (!keys || !keys.length) return out;
  const stmt = db.prepare('SELECT 1 AS y FROM bank_imports WHERE user_id = ? AND key = ?');
  for (const k of keys) {
    if (k && stmt.get(userId, String(k))) out.add(String(k));
  }
  return out;
}

/**
 * Занести подтверждённые человеком строки выписки в журнал.
 *
 * Отметка о загрузке ставится первой и в той же транзакции, что и проводка:
 * если строку уже заносили, уникальный индекс не даст вставить отметку, и
 * оплаты не будет. Порядок именно такой, потому что при обратном между
 * двумя запросами помещается второй такой же запрос — и платёж задваивается.
 *
 * @returns {{added: number, skipped: number}}
 */
function importBankRows(userId, rows) {
  const now = new Date().toISOString();
  const remember = db.prepare(
    'INSERT OR IGNORE INTO bank_imports(user_id, key, op_id, cp_id, amount, created_at) VALUES(?,?,?,?,?,?)',
  );
  const link = db.prepare('UPDATE bank_imports SET op_id = ? WHERE user_id = ? AND key = ?');
  let added = 0;
  let skipped = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows || []) {
      const key = String(r && r.key ? r.key : '');
      const cp = key ? getCp(userId, Number(r.cpId)) : null;
      const amount = Math.round(Math.abs(Number(r && r.amount) || 0) * 100) / 100;
      if (!cp || !amount) { skipped += 1; continue; }

      if (!remember.run(userId, key, 0, cp.id, amount, now).changes) { skipped += 1; continue; }
      const opId = addOp(userId, cp.id, {
        date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : now.slice(0, 10),
        kind: 'Оплата',
        doc: String(r.doc || 'Оплата по выписке').slice(0, 120),
        debit: amount,
        credit: 0,
        note: 'банковская выписка',
      });
      link.run(opId, userId, key);
      added += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { added, skipped };
}

// ---------- связь документов с журналом ----------

/**
 * Какие документы создают задолженность при таком основании.
 * Пустой список — режим «вручную»: бот в журнал не лезет.
 */
const DEBT_DOCS = {
  closing: ['usl', 'upd', 'torg12'],
  invoice: ['sch', 'schdog'],
  manual: [],
};

const basisOf = (org) => (DEBT_DOCS[org && org.debt_basis] ? org.debt_basis : 'closing');
const makesDebt = (org, type) => DEBT_DOCS[basisOf(org)].includes(type);

/** Операция, привязанная к документу: по ней можно отменить и не задвоить. */
function addOpForDoc(userId, cpId, op, docId) {
  const cp = getCp(userId, cpId);
  if (!cp) return false;
  const exists = db.prepare(
    'SELECT COUNT(*) AS n FROM operations WHERE doc_id = ? AND kind = ?',
  ).get(docId, op.kind).n;
  if (exists) return false;                    // повторный вызов ничего не портит
  const sort = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS s FROM operations WHERE cp_id = ?').get(cpId).s;
  db.prepare(`INSERT INTO operations(cp_id, date, kind, doc, debit, credit, note, sort, doc_id)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(cpId, op.date, op.kind || '', op.doc || '', Number(op.debit) || 0,
      Number(op.credit) || 0, op.note || '', sort, docId);
  return true;
}

function opsOfDoc(userId, docId) {
  const d = getDoc(userId, docId);
  if (!d) return [];
  return db.prepare('SELECT * FROM operations WHERE doc_id = ? ORDER BY id').all(docId);
}

function deleteOpsOfDoc(userId, docId, kind = null) {
  const d = getDoc(userId, docId);
  if (!d) return 0;
  const info = kind
    ? db.prepare('DELETE FROM operations WHERE doc_id = ? AND kind = ?').run(docId, kind)
    : db.prepare('DELETE FROM operations WHERE doc_id = ?').run(docId);
  return info.changes;
}

/** Отметка оплаты документа + поступление денег в журнал. */
function markPaid(userId, docId, date) {
  const d = getDoc(userId, docId);
  if (!d) return null;
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? date : new Date().toISOString().slice(0, 10);
  db.prepare('UPDATE documents SET paid_at = ? WHERE id = ? AND user_id = ?').run(when, docId, userId);
  // В ручном режиме журнал ведёт человек, и лезть туда нельзя: проводка
  // оплаты без встречной реализации увела бы сальдо в минус — вышло бы,
  // что это мы должны контрагенту. Отметку об оплате при этом сохраняем:
  // она нужна списку «Не оплачено» и живёт отдельно от журнала.
  const org = getDefaultOrg(userId);
  if (basisOf(org || {}) === 'manual') return when;
  if (d.cp_id && d.total) {
    addOpForDoc(userId, d.cp_id, {
      date: when, kind: 'Оплата', doc: `${d.title} № ${d.number}`, debit: d.total,
    }, docId);
  }
  return when;
}

function unmarkPaid(userId, docId) {
  const d = getDoc(userId, docId);
  if (!d) return false;
  db.prepare("UPDATE documents SET paid_at = '' WHERE id = ? AND user_id = ?").run(docId, userId);
  deleteOpsOfDoc(userId, docId, 'Оплата');
  return true;
}

/** Документы за период — для реестра. Имя контрагента подставляем сразу. */
function docsBetween(userId, from, to, cpId = null) {
  const rows = cpId
    ? db.prepare(`SELECT * FROM documents WHERE user_id = ? AND date >= ? AND date <= ?
                    AND cp_id = ? ORDER BY date, id`).all(userId, from, to, cpId)
    : db.prepare(`SELECT * FROM documents WHERE user_id = ? AND date >= ? AND date <= ?
                    ORDER BY date, id`).all(userId, from, to);
  const names = new Map();
  return rows.map(withPayload).map((d) => {
    if (d.cp_id && !names.has(d.cp_id)) {
      const cp = getCp(userId, d.cp_id);
      names.set(d.cp_id, cp ? cp.name : '');
    }
    return { ...d, cpName: d.cp_id ? names.get(d.cp_id) : '' };
  });
}

/** Неоплаченные документы с суммой — то, за чем следят каждый день. */
function unpaidDocs(userId, limit = 50) {
  const rows = db.prepare(`
    SELECT * FROM documents
     WHERE user_id = ? AND paid_at = '' AND total > 0
       AND type IN ('sch','schdog','usl','upd','torg12')
     ORDER BY date, id LIMIT ?`).all(userId, limit);
  return rows.map(withPayload);
}

/** Сальдо по контрагенту (переиспользует computeBalance из db.js) */
function balanceOf(userId, cpId) {
  const cp = getCp(userId, cpId);
  if (!cp) return null;
  const ops = listOps(userId, cpId);
  return { cp, ops, ...computeBalance(cp, ops) };
}

// ---------- заблокировавшие бота ----------

function markBlocked(userId) {
  db.prepare('UPDATE bot_users SET blocked_at = ? WHERE id = ?')
    .run(new Date().toISOString(), userId);
}
function markActive(userId) {
  db.prepare("UPDATE bot_users SET blocked_at = '' WHERE id = ? AND blocked_at <> ''").run(userId);
}
function isBlocked(userId) {
  const u = db.prepare('SELECT blocked_at FROM bot_users WHERE id = ?').get(userId);
  return Boolean(u && u.blocked_at);
}
/**
 * Поиск по @имени. Только для команд владельца: имя в Telegram меняется
 * когда угодно, поэтому оно годится, чтобы найти человека глазами, но не
 * чтобы что-то к нему привязывать — для этого есть tg_id.
 */
function findUserByUsername(username) {
  const clean = String(username || '').replace(/^@/, '').trim().toLowerCase();
  if (!clean) return null;
  return db.prepare('SELECT * FROM bot_users WHERE lower(username) = ?').get(clean) || null;
}

/** Кому имеет смысл писать: для будущих напоминаний и рассылок. */
function reachableUsers() {
  return db.prepare("SELECT * FROM bot_users WHERE blocked_at = ''").all();
}

/** Пользователь по внутреннему id — нужен рассылкам, где есть только user_id. */
function userById(id) {
  return db.prepare('SELECT * FROM bot_users WHERE id = ?').get(Number(id));
}

// ---------- дебиторка ----------

/**
 * Кто сколько должен. Знак сальдо трактуем по типу контрагента:
 * у заказчика положительное сальдо — долг нам, у поставщика — наш долг ему.
 *
 * «Без движения» считаем от даты последней операции, а не от срока оплаты:
 * сроков мы не храним и придумывать их за пользователя не будем. Зато
 * «полгода тишины при долге в 54 тысячи» — сигнал понятный и честный.
 */
function debtors(userId) {
  const today = new Date();
  const out = [];
  for (const cp of listCps(userId)) {
    const b = balanceOf(userId, cp.id);
    if (!b) continue;
    const closing = Math.round(b.closing * 100) / 100;
    if (Math.abs(closing) < 0.005) continue;
    const lastOp = b.ops.length ? b.ops[b.ops.length - 1].date : cp.opening_date;
    const days = lastOp
      ? Math.max(0, Math.floor((today - new Date(lastOp)) / 86400000))
      : null;
    out.push({
      cp,
      amount: Math.abs(closing),
      // нам должны или мы должны
      theyOwe: cp.kind === 'supplier' ? closing < 0 : closing > 0,
      lastOp,
      days,
      ops: b.ops.length,
    });
  }
  // сначала самые крупные долги в нашу пользу
  out.sort((a, b) => (Number(b.theyOwe) - Number(a.theyOwe)) || (b.amount - a.amount));
  return out;
}

// ---------- выписанные документы и сквозная нумерация ----------

const DOC_TITLES = {
  sch: 'Счёт на оплату', schdog: 'Счёт-договор',
  usl: 'Акт об оказании услуг', pp: 'Платёжное поручение',
  akt: 'Акт сверки', upd: 'УПД', torg12: 'Товарная накладная ТОРГ-12',
  dog: 'Договор',
};

/**
 * Следующий номер документа этого типа в этом году.
 * Нумерация у каждого пользователя своя и не зависит от контрагента —
 * так требует практика: сквозной ряд по журналу, а не по клиентам.
 */
function nextSeq(userId, type, year) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS n FROM documents WHERE user_id = ? AND type = ? AND year = ?',
  ).get(userId, type, year);
  return row.n + 1;
}

/**
 * Уникальность номера внутри года — на уровне базы, а не надежды.
 *
 * Номер берётся до сборки файла (он в нём напечатан), а сборка PDF занимает
 * секунду. За эту секунду второй документ — из мини-приложения или второго
 * нажатия — успевает взять тот же номер. Два счёта с одним номером бухгалтеру
 * не объяснишь, поэтому пусть лучше вторая запись честно не пройдёт: код
 * возьмёт следующий номер и пересоберёт файл.
 *
 * В старых базах дубли уже могли появиться — тогда индекс не создастся, и это
 * не повод падать при запуске: остальное продолжает работать.
 */
function guardSeq() {
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_seq_uniq ON documents(user_id, type, year, seq)');
    return true;
  } catch (_) {
    return false;                       // в базе уже есть повторы номеров
  }
}
guardSeq();

/** Не прошла ли запись именно из-за занятого номера. */
const isSeqTaken = (e) => /idx_doc_seq_uniq|UNIQUE constraint failed: documents/i.test(String(e && e.message));

/** Документ сохраняется данными; файл всегда пересобирается заново. */
function saveDoc(userId, { orgId, cpId, type, number, seq, date, total, payload }) {
  const year = Number(String(date).slice(0, 4)) || new Date().getFullYear();
  const info = db.prepare(`
    INSERT INTO documents(user_id, org_id, cp_id, type, number, seq, year, date, total, payload, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    userId, orgId || 0, cpId || 0, type, String(number), Number(seq) || 0, year,
    date || '', Number(total) || 0, payload ? JSON.stringify(payload) : '', new Date().toISOString(),
  );
  return Number(info.lastInsertRowid);
}

function listDocs(userId, limit = 10, cpId = null) {
  const sql = cpId
    ? 'SELECT * FROM documents WHERE user_id = ? AND cp_id = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM documents WHERE user_id = ? ORDER BY id DESC LIMIT ?';
  const rows = cpId
    ? db.prepare(sql).all(userId, cpId, limit)
    : db.prepare(sql).all(userId, limit);
  return rows.map(withPayload);
}

function getDoc(userId, id) {
  const row = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(id, userId);
  return row ? withPayload(row) : null;
}

function withPayload(row) {
  let payload = {};
  try { payload = row.payload ? JSON.parse(row.payload) : {}; } catch (_) { payload = {}; }
  return { ...row, payload, title: DOC_TITLES[row.type] || row.type };
}

/**
 * Удаление документа вместе с его проводками.
 *
 * Без этого удалённый счёт оставлял долг в журнале навсегда: карточки, через
 * которую проводку отменяют, больше нет, а сальдо у контрагента висит. Долг,
 * которого никто не может убрать, — худшее, что может быть в акте сверки.
 */
function deleteDoc(userId, id) {
  // Проводки убираем первыми: deleteOpsOfDoc сверяется с документом, и после
  // его удаления она уже ничего не найдёт.
  if (!getDoc(userId, id)) return false;
  deleteOpsOfDoc(userId, id);
  return db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// ---------- шаблоны позиций ----------

/** Запоминаем позицию: в следующий раз её можно поставить кнопкой. */
function rememberItems(userId, items) {
  const now = new Date().toISOString();
  for (const it of items || []) {
    const name = String(it.name || '').trim();
    if (!name) continue;
    const exists = db.prepare('SELECT id FROM item_templates WHERE user_id = ? AND name = ?')
      .get(userId, name);
    if (exists) {
      db.prepare('UPDATE item_templates SET price = ?, unit = ?, uses = uses + 1, used_at = ? WHERE id = ?')
        .run(Number(it.price) || 0, it.unit || 'шт.', now, exists.id);
    } else {
      db.prepare('INSERT INTO item_templates(user_id, name, unit, price, uses, used_at) VALUES(?,?,?,?,1,?)')
        .run(userId, name, it.unit || 'шт.', Number(it.price) || 0, now);
    }
  }
}

function listTemplates(userId, limit = 8) {
  return db.prepare(
    'SELECT * FROM item_templates WHERE user_id = ? ORDER BY uses DESC, used_at DESC LIMIT ?',
  ).all(userId, limit);
}

function getTemplate(userId, id) {
  return db.prepare('SELECT * FROM item_templates WHERE id = ? AND user_id = ?').get(id, userId);
}

function forgetTemplate(userId, id) {
  db.prepare('DELETE FROM item_templates WHERE id = ? AND user_id = ?').run(id, userId);
}

// ---------- доступ (место под подписку) ----------

// Бесплатно 5 документов в месяц, дальше — подписка. Читаем из окружения
// при каждом вызове, чтобы число/режим можно было менять без перезапуска
// и переопределять в прогоне: FREE_DOCS — сколько бесплатных, ENFORCE_LIMIT=0
// снова открывает всем.
const freePerMonth = () => Number(process.env.FREE_DOCS || 5);
const enforceLimit = () => String(process.env.ENFORCE_LIMIT || '1') !== '0';

function docsThisMonth(userId) {
  const from = new Date().toISOString().slice(0, 7); // ГГГГ-ММ
  return db.prepare(
    "SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND substr(created_at,1,7) = ?",
  ).get(userId, from).n;
}

/** @returns {{allowed:boolean, used:number, left:number, limit:number, paid:boolean}} */
function quota(userId) {
  const limit = freePerMonth();
  const u = db.prepare('SELECT access_until FROM bot_users WHERE id = ?').get(userId) || {};
  const paid = Boolean(u.access_until && u.access_until >= new Date().toISOString().slice(0, 10));
  const used = docsThisMonth(userId);
  const left = Math.max(0, limit - used);
  return {
    allowed: paid || !enforceLimit() || left > 0,
    used, left, limit, paid,
  };
}

module.exports = {
  migrate,
  getOrCreateUser, setState, getState, clearState,
  createOrg, updateOrg, saveMyOrg, vatOf, listOrgs, getOrg, getDefaultOrg, setDefaultOrg,
  createCp, updateCp, listCps, getCp,
  addOp, listOps, deleteLastOp, balanceOf, debtors,
  knownBankKeys, importBankRows,
  DEBT_DOCS, basisOf, makesDebt, addOpForDoc, opsOfDoc, deleteOpsOfDoc,
  markPaid, unmarkPaid, unpaidDocs, docsBetween,
  markBlocked, markActive, isBlocked, reachableUsers, userById, findUserByUsername,
  isSeqTaken, guardSeq,
  nextSeq, saveDoc, listDocs, getDoc, deleteDoc, DOC_TITLES,
  rememberItems, listTemplates, getTemplate, forgetTemplate,
  quota, docsThisMonth, freePerMonth,
};
