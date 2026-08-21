'use strict';

// Многопользовательский слой для бота: пользователи Telegram, их организации,
// контрагенты и операции. Всё строго изолировано по user_id — пользователь
// никогда не видит чужие данные. Надстройка над существующей базой (db.js).

const { db, computeBalance } = require('../db');
const { round2 } = require('./money');

// «Сегодня» — по Москве, а не по поясу сервера (пояснение в lib/period.js).
const { todayISO, currentYear } = require('./period');

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
   * Цикл аренды: счёт заранее, оплата к числу договора, сигнал о просрочке.
   *
   *   pay_day   — число, к которому арендатор платит (из договора);
   *   lead_days — за сколько дней до него предложить выставить счёт;
   *   last_due  — YYYY-MM: за какой месяц уже сообщали о просрочке.
   *
   * Без pay_day повторение просто привязано к числу месяца (day). С ним
   * появляется срок оплаты, а значит и первый день просрочки — то, чего
   * иначе неоткуда взять: в счёте даты платежа нет.
   */
  addColumn('recurring', 'pay_day', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('recurring', 'lead_days', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('recurring', 'last_due', "TEXT NOT NULL DEFAULT ''");

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
  // Человек отменил проводку долга по этому документу руками. Без такой
  // отметки пересчёт основания создавал её заново: он видит, что проводки
  // нет, и считает это упущением, — а это было решение человека.
  addColumn('documents', 'no_debt', 'INTEGER NOT NULL DEFAULT 0');
  // Сколько денег закрыла отметка «оплачено». Не всегда вся сумма документа:
  // если часть уже внесли руками, дописывать полную — значит увести сальдо
  // в минус. Ноль означает «отметки не было» или «поставлена до этой графы»,
  // и тогда в дело идёт полная сумма, как и было раньше.
  addColumn('documents', 'paid_sum', 'REAL NOT NULL DEFAULT 0');
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
  return row ? deleteOp(userId, row.id) : false;
}

/**
 * Убрать одну операцию — любую, а не только последнюю.
 *
 * В боте отменяют последнюю, и этого мало: сумму на главной держат четыре
 * строки, внесённые руками полгода назад, и чтобы добраться до второй,
 * приходилось сносить все. В приложении их видно списком и смахивается
 * нужная.
 */
function deleteOp(userId, opId) {
  const row = db.prepare(`
    SELECT o.id, o.kind, o.doc_id FROM operations o
      JOIN counterparties c ON c.id = o.cp_id
     WHERE o.id = ? AND c.user_id = ?`).get(Number(opId), userId);
  if (!row) return false;
  db.prepare('DELETE FROM operations WHERE id = ?').run(row.id);
  /*
   * Проводка пришла из документа — значит, отменили не строку в журнале, а
   * решение по документу, и хранить это надо на нём. Иначе ближайший
   * пересчёт вернёт проводку: он не отличает «ещё не создали» от «человек
   * убрал». Отмену видно в карточке документа, и оттуда же её можно снять.
   *
   * Оплата и реализация — две стороны одной пары, поэтому и отменяются
   * по-разному: убрали реализацию — документ выходит из долга целиком;
   * убрали оплату — снимается отметка «оплачено», иначе пересчёт впишет
   * её обратно, ведь отметка на документе осталась.
   */
  if (row.doc_id && row.kind === 'Реализация') {
    db.prepare('UPDATE documents SET no_debt = 1 WHERE id = ? AND user_id = ?').run(row.doc_id, userId);
    // Оплату этого документа забираем сразу же: одна без другой оставляет
    // сальдо в минусе — выходит, что это мы должны клиенту. Отметку
    // «оплачено» не трогаем, она вернётся вместе с долгом.
    deleteOpsOfDoc(userId, row.doc_id, 'Оплата');
  }
  if (row.doc_id && row.kind === 'Оплата') {
    db.prepare("UPDATE documents SET paid_at = '', paid_sum = 0 WHERE id = ? AND user_id = ?")
      .run(row.doc_id, userId);
  }
  // Если операция пришла из выписки, забываем и отметку о загрузке: иначе
  // отменённую по ошибке оплату больше не загрузить — строка навсегда
  // числится импортированной.
  db.prepare('DELETE FROM bank_imports WHERE user_id = ? AND op_id = ?').run(userId, row.id);
  return true;
}

/**
 * Сверка за период: входящее сальдо, операции внутри, исходящее сальдо.
 *
 * Так акт сверки и устроен по смыслу: «на начало периода за вами столько,
 * за период было то-то, на конец — столько». Раньше в акт шли все операции
 * за всю историю, а в шапке стоял период — и начиная со второго акта шапка
 * противоречила таблице.
 *
 * Входящее сальдо считается, а не хранится: это начальное сальдо
 * контрагента плюс всё, что случилось до начала периода. Хранить его
 * отдельно значило бы держать число, которое разъедется с журналом при
 * первой же правке задним числом.
 *
 * @param {string} from ISO-дата начала (включительно)
 * @param {string} to ISO-дата конца (включительно)
 */
function periodBalance(userId, cpId, from, to) {
  const cp = getCp(userId, cpId);
  if (!cp) return null;
  const all = listOps(userId, cpId);

  let opening = Number(cp.opening_balance) || 0;
  const inside = [];
  for (const op of all) {
    const d = String(op.date || '');
    if (from && d < from) {
      // Округляем на каждом шаге: иначе входящее сальдо длинного периода
      // накапливает двоичную погрешность так же, как накапливало сальдо
      // карточки — 1.0000000000000007 вместо рубля.
      opening = round2(opening + round2(op.credit) - round2(op.debit));
    } else if (!to || d <= to) {
      inside.push(op);
    }
  }
  const totalDebit = inside.reduce((s, o) => round2(s + round2(o.debit)), 0);
  const totalCredit = inside.reduce((s, o) => round2(s + round2(o.credit)), 0);
  return {
    cp,
    ops: inside,
    opening: round2(opening),
    totalDebit,
    totalCredit,
    closing: round2(opening + totalCredit - totalDebit),
    from: from || cp.opening_date || '',
    to: to || todayISO(),
  };
}

/**
 * Контрагент «как на период»: тот же объект, но с сальдо и датами периода.
 *
 * Шаблон акта читает opening_balance, opening_date и period_end прямо из
 * контрагента. Подменяя их копией, мы получаем правильный акт без правки
 * шаблона — и не трогаем саму карточку, где эти поля значат другое:
 * начало отношений, а не начало выбранного периода.
 */
function cpForPeriod(userId, cpId, from, to) {
  const b = periodBalance(userId, cpId, from, to);
  if (!b) return null;
  return {
    ...b,
    view: {
      ...b.cp, opening_balance: b.opening, opening_date: b.from, period_end: b.to,
    },
  };
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

/**
 * Привести журнал в соответствие с выбранным основанием долга.
 *
 * Смена основания раньше меняла одну строчку в настройках и больше ничего.
 * Человек, который работает счетами, переключался на «долг по счёту» — и не
 * видел никакой разницы: проводки создаются в момент выписки документа, а
 * уже выписанные счета так и оставались без них. Главная цифра «должны вам»
 * стояла нулём, сколько бы счетов он ни выставил.
 *
 * Здесь мы досоздаём проводки тем документам, которые теперь создают долг,
 * и убираем у тех, которые перестали.
 *
 * Оплата ходит с реализацией в паре, и вести её надо тем же правилом, что в
 * markPaid: проводка «Оплата» есть ровно у того документа, который создаёт
 * долг и отмечен оплаченным. Пока пересчёт трогал одну реализацию, пары
 * рвались в обе стороны. Арендодатель с четырьмя счетами, три из которых
 * оплачены, переключался на «долг по счёту» и получал 200 000 вместо 50 000:
 * реализации создались всем четырём, а оплат не было ни одной. Подрядчик,
 * наоборот, уходил в минус — оплата по акту оставалась, а её реализацию
 * пересчёт снимал, и приложение сообщало, что это он должен клиенту.
 *
 * Документы, у которых человек отменил проводку руками (no_debt), не трогаем:
 * его решение — не то же самое, что «мы ещё не создали».
 */
function rebuildDebt(userId) {
  const org = getDefaultOrg(userId);
  const types = DEBT_DOCS[basisOf(org || {})];
  const docs = db.prepare(
    'SELECT id, cp_id, type, date, total, number, paid_at, paid_sum, no_debt FROM documents WHERE user_id = ? AND total > 0',
  ).all(userId);

  let added = 0;
  let removed = 0;
  let paid = 0;                            // сколько строк оплаты поправили
  const hasOp = (docId, kind) => db.prepare(
    'SELECT COUNT(*) AS n FROM operations WHERE doc_id = ? AND kind = ?',
  ).get(docId, kind).n > 0;

  // Одной транзакцией: на середине пересчёта журнал показывал бы долг
  // наполовину по старому правилу, наполовину по новому.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const d of docs) {
      if (!d.cp_id) continue;
      const title = DOC_TITLES[d.type] || d.type;
      const should = types.includes(d.type) && !d.no_debt;

      if (should && !hasOp(d.id, 'Реализация')) {
        if (addOpForDoc(userId, d.cp_id, {
          date: d.date, kind: 'Реализация', doc: `${title} № ${d.number}`, credit: d.total,
        }, d.id)) added += 1;
      } else if (!should && hasOp(d.id, 'Реализация')) {
        removed += deleteOpsOfDoc(userId, d.id, 'Реализация');
      }

      /*
       * Оплату держим в паре с реализацией — и на ту же сумму, что была
       * записана при отметке (paid_sum). Полная сумма документа годится
       * только для старых отметок, поставленных до появления этой графы:
       * если оплата была частичной, пересчёт вернул бы её полной и увёл
       * сальдо в минус.
       *
       * Движение по оплатам считаем отдельно и показываем человеку: раньше
       * пересчёт мог молча снять оплату на 30 000 и отчитаться «ничего не
       * менял» — сальдо уезжало, а сообщение говорило обратное.
       */
      const shouldPay = should && Boolean(d.paid_at);
      if (shouldPay && !hasOp(d.id, 'Оплата')) {
        if (addOpForDoc(userId, d.cp_id, {
          date: d.paid_at,
          kind: 'Оплата',
          doc: `${title} № ${d.number}`,
          debit: round2(Number(d.paid_sum) || Number(d.total)),
        }, d.id)) paid += 1;
      } else if (!shouldPay && hasOp(d.id, 'Оплата')) {
        paid += deleteOpsOfDoc(userId, d.id, 'Оплата');
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { added, removed, paid };
}

/**
 * Вернуть документ в долг после отмены проводки руками.
 *
 * Без этого отмена была дорогой в один конец: флаг no_debt ставился, а снять
 * его было нечем — документ навсегда выпадал из долга, продолжая при этом
 * числиться в «Ждут оплаты». Кнопка «Вернуть в долг» — обратный ход, и
 * пересчёт восстанавливает пару целиком, включая оплату.
 */
function restoreDebt(userId, docId) {
  const d = getDoc(userId, docId);
  if (!d) return false;
  db.prepare('UPDATE documents SET no_debt = 0 WHERE id = ? AND user_id = ?').run(docId, userId);
  rebuildDebt(userId);
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
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? date : todayISO();
  db.prepare('UPDATE documents SET paid_at = ? WHERE id = ? AND user_id = ?').run(when, docId, userId);
  // В ручном режиме журнал ведёт человек, и лезть туда нельзя: проводка
  // оплаты без встречной реализации увела бы сальдо в минус — вышло бы,
  // что это мы должны контрагенту. Отметку об оплате при этом сохраняем:
  // она нужна списку «Не оплачено» и живёт отдельно от журнала.
  const org = getDefaultOrg(userId);
  if (basisOf(org || {}) === 'manual') return when;
  /*
   * Проводку оплаты делаем только по тому документу, который создаёт долг.
   *
   * Иначе одна оплата попадала в журнал дважды. При основании «по счёту»
   * долг создаёт счёт; человек отмечает оплаченным и счёт, и закрывающий
   * его акт — оба с суммой 30 000, — и сальдо уходит в минус: выходит, что
   * это мы должны клиенту, который просто заплатил один раз.
   *
   * Отметку «оплачено» при этом сохраняем для обоих: она нужна списку
   * «не оплачено» и живёт отдельно от журнала.
   */
  /*
   * И только на ту сумму, которая по этому клиенту ещё не закрыта.
   *
   * Человек вносит частичную оплату руками — «пришло 20 000 из 50 000», —
   * а потом жмёт «оплачен», имея в виду «остальное тоже пришло». Полная
   * сумма поверх частичной давала −20 000: приложение объявляло, что это
   * мы должны клиенту, который просто доплатил. Берём меньшее из суммы
   * документа и текущего долга; аванс клиента точно так же уменьшает то,
   * что осталось закрыть.
   */
  if (d.cp_id && d.total && !d.no_debt && makesDebt(org || {}, d.type)) {
    const bal = balanceOf(userId, d.cp_id);
    const left = round2(Math.min(Number(d.total), Math.max(0, bal ? bal.closing : 0)));
    if (left > 0) {
      addOpForDoc(userId, d.cp_id, {
        date: when, kind: 'Оплата', doc: `${d.title} № ${d.number}`, debit: left,
      }, docId);
      db.prepare('UPDATE documents SET paid_sum = ? WHERE id = ? AND user_id = ?').run(left, docId, userId);
    }
  }
  return when;
}

function unmarkPaid(userId, docId) {
  const d = getDoc(userId, docId);
  if (!d) return false;
  db.prepare("UPDATE documents SET paid_at = '', paid_sum = 0 WHERE id = ? AND user_id = ?").run(docId, userId);
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

/**
 * Сколько денег ждём — одним числом, без задвоения по одной сделке.
 *
 * Список неоплаченных показываем целиком: человек хочет видеть оба документа.
 * А вот складывать их нельзя. На одну сделку выписывают счёт и закрывающий
 * его акт на те же 30 000 — markPaid прямо пишет, что это обычное дело, — и
 * в сводке выходило 60 000. Считаем сделками: у одного контрагента счёт и
 * закрывающий документ на одну и ту же сумму — это одна сделка, а не две.
 *
 * Число берут и плитка на главной, и сводка в боте, и напоминание: пока
 * каждый считал сам, они расходились между собой.
 */
const CLOSING_DOCS = ['usl', 'upd', 'torg12'];
function dealTotals(docs) {
  const deals = new Map();
  for (const d of docs) {
    const key = `${d.cp_id}|${round2(Number(d.total) || 0)}`;
    const g = deals.get(key) || { total: round2(Number(d.total) || 0), bill: 0, close: 0 };
    if (CLOSING_DOCS.includes(d.type)) g.close += 1; else g.bill += 1;
    deals.set(key, g);
  }
  let count = 0;
  let sum = 0;
  for (const g of deals.values()) {
    const n = g.bill && g.close ? Math.max(g.bill, g.close) : g.bill + g.close;
    count += n;
    sum = round2(sum + n * g.total);
  }
  return { count, sum };
}

function unpaidSummary(userId, limit = 200) {
  const docs = unpaidDocs(userId, limit);
  return { docs, ...dealTotals(docs) };
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

/**
 * Из чего складывается сумма «должны вам».
 *
 * Самая частая жалоба: «удалил документы, а сумма на главной прежняя».
 * Обычно это не поломка — цифру держит начальное сальдо из карточки или
 * проводка, внесённая руками: документы к ним отношения не имеют. Но по
 * экрану этого не видно, и человек справедливо считает, что число мёртвое.
 * Поэтому раскладываем его по источникам прямо в приложении, а не в
 * консольном скрипте, до которого клиенту не добраться.
 *
 * Четвёртый источник — поломка: проводка есть, а её документа уже нет.
 * Такие оставляли старые версии бота; убрать их из приложения нельзя,
 * поэтому показываем отдельной строкой и зовём tools/debt-audit.js.
 *
 * Считаем только сторону «должны вам»: наверху стоит именно эта цифра.
 * Сирот при этом две породы — те, что сидят в самой сумме (orphanCount), и
 * те, что висят у остальных контрагентов (orphanOther). Складывать их в один
 * счётчик нельзя: экран сказал бы «три операции держат 3 000», хотя эти
 * 3 000 держит одна, а две другие гасят друг друга у совсем другого клиента.
 *
 * Слагаемые берём не из самих проводок, а из того, насколько каждая сдвинула
 * сальдо: computeBalance округляет после каждого шага, и повторять его
 * арифметику отдельной формулой — значит однажды разойтись с ней на копейку.
 * Разница соседних значений в колонке сальдо сходится к итогу всегда, какое
 * бы округление ни применялось внутри.
 */
function debtBreakdown(userId) {
  const lost = new Set(db.prepare(`
    SELECT o.id FROM operations o
      JOIN counterparties c ON c.id = o.cp_id
     WHERE c.user_id = ?
       AND o.doc_id IS NOT NULL AND o.doc_id > 0
       AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = o.doc_id)`)
    .all(userId).map((r) => r.id));

  const sum = { opening: 0, docs: 0, manual: 0, orphan: 0 };
  let total = 0;
  let counted = 0;                         // сирот попало в саму сумму
  for (const d of debtors(userId)) {
    if (!d.theyOwe) continue;              // «должны вам» — только эта сторона
    const b = balanceOf(userId, d.cp.id);
    if (!b || !b.rows) continue;
    // У поставщика знак читается наоборот — тот же разворот, что в debtors().
    const sgn = b.closing < 0 ? -1 : 1;
    // Начальное сальдо — это первая точка колонки: сальдо до первой операции.
    let prev = b.rows.length
      ? round2(b.rows[0].balance - (round2(Number(b.rows[0].credit) || 0) - round2(Number(b.rows[0].debit) || 0)))
      : b.closing;
    sum.opening = round2(sum.opening + sgn * prev);
    for (const row of b.rows) {
      const v = round2(sgn * (row.balance - prev));
      prev = row.balance;
      if (lost.has(row.id)) { sum.orphan = round2(sum.orphan + v); counted += 1; }
      else if (row.doc_id) sum.docs = round2(sum.docs + v);
      else sum.manual = round2(sum.manual + v);
    }
    total = round2(total + d.amount);
  }
  return { total, ...sum, orphanCount: counted, orphanOther: lost.size - counted };
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
  const year = Number(String(date).slice(0, 4)) || currentYear();
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
/**
 * Сколько долга висит на каждом документе списка — одним запросом.
 *
 * Нужно, чтобы честно сказать перед удалением, изменится сальдо или нет.
 * Долг создают не все документы: при основании «по отгрузке» счёт проводку
 * не делает, и удаление такого счёта сальдо не трогает. Раньше приложение
 * обещало обратное — «долг по нему тоже снимется» — и человек справедливо
 * считал, что удаление сломано.
 */
function debtByDoc(userId, ids) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = db.prepare(`
    SELECT o.doc_id AS id, COUNT(*) AS n,
           ROUND(SUM(o.credit) - SUM(o.debit), 2) AS delta
      FROM operations o
      JOIN counterparties c ON c.id = o.cp_id
     WHERE c.user_id = ? AND o.doc_id IN (${list.map(() => '?').join(',')})
     GROUP BY o.doc_id`).all(userId, ...list);
  return new Map(rows.map((r) => [r.id, { ops: r.n, delta: Number(r.delta) || 0 }]));
}

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
  /*
   * Месяц — московский, как и даты документов, и считаем по дате документа,
   * а не по времени записи в базу. created_at пишется в UTC: документ,
   * выписанный первого числа в час ночи, попадал в квоту прошлого месяца,
   * хотя на самом документе стоит первое число нового.
   */
  const month = todayISO().slice(0, 7);
  return db.prepare(
    'SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND substr(date,1,7) = ?',
  ).get(userId, month).n;
}

/** @returns {{allowed:boolean, used:number, left:number, limit:number, paid:boolean}} */
function quota(userId) {
  const limit = freePerMonth();
  const u = db.prepare('SELECT access_until FROM bot_users WHERE id = ?').get(userId) || {};
  const paid = Boolean(u.access_until && u.access_until >= todayISO());
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
  addOp, listOps, deleteLastOp, deleteOp, balanceOf, debtors, debtBreakdown, periodBalance, cpForPeriod,
  knownBankKeys, importBankRows,
  DEBT_DOCS, basisOf, makesDebt, addOpForDoc, opsOfDoc, deleteOpsOfDoc,
  debtByDoc, rebuildDebt, restoreDebt,
  markPaid, unmarkPaid, unpaidDocs, unpaidSummary, dealTotals, docsBetween,
  markBlocked, markActive, isBlocked, reachableUsers, userById, findUserByUsername,
  isSeqTaken, guardSeq,
  nextSeq, saveDoc, listDocs, getDoc, deleteDoc, DOC_TITLES,
  rememberItems, listTemplates, getTemplate, forgetTemplate,
  quota, docsThisMonth, freePerMonth,
};
