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
  try {
    if (!columns(table).includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  } catch (e) {
    if (e && /duplicate column/i.test(e.message)) return;
    throw e;
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
  addColumn('bot_users', 'ai_enabled', 'INTEGER NOT NULL DEFAULT 1');

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
  addColumn('orgs', 'vat_rate', "TEXT NOT NULL DEFAULT ''");   // '' | '0' | '5' | '7' | '10' | '20' | '22'
  addColumn('orgs', 'vat_gross', 'INTEGER NOT NULL DEFAULT 0'); // 1 — цены уже с НДС
  // ОГРНИП: в УПД есть графа, а поля не было — печаталось пусто.
  addColumn('orgs', 'ogrnip', "TEXT NOT NULL DEFAULT ''");
  /*
   * Налог на профессиональный доход. Вывести этот режим неоткуда: по ИНН
   * видно только, ИП это или организация, а НПД применяют и обычные
   * физлица, и предприниматели. Значит, спрашиваем — но не у каждого, а
   * галочкой в настройках: она нужна ровно для одного, напомнить про чек
   * при отметке оплаты (lib/npd.js).
   */
  addColumn('orgs', 'npd', 'INTEGER NOT NULL DEFAULT 0');

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
  /*
   * Второй документ сделки — тот, что закрыли заодно с первым.
   *
   * Счёт и закрывающий его акт на одну сумму закрываются вместе, но проводка
   * оплаты только одна, на документе-источнике долга. Без этой связи отмена
   * оплаты снимала отметку с него одного, а второй так и оставался
   * «оплаченным» — с долгом, который вернулся, и документом, которого нет
   * в списке «не оплачено».
   */
  addColumn('documents', 'paid_with', 'INTEGER NOT NULL DEFAULT 0');
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
function isAiEnabled(userId) {
  const u = db.prepare('SELECT ai_enabled FROM bot_users WHERE id = ?').get(userId);
  return u ? Boolean(u.ai_enabled !== 0) : true;
}
function setAiEnabled(userId, enabled) {
  db.prepare('UPDATE bot_users SET ai_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
  return Boolean(enabled);
}

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
    'biz_type', 'npd'];
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

/**
 * Незакрытые авансовые счета-фактуры контрагента.
 *
 * «Незакрытые» — те, на которые ещё не сослалась ни одна отгрузка в строке
 * 5б. Ссылка живёт в payload отгрузочного документа, поэтому и ищем по нему:
 * отдельной таблицы связей заводить не стали — на объёмах малого бизнеса это
 * лишняя сущность, которую надо чинить при каждом удалении документа.
 *
 * Порядок — от старых к новым: закрывают предоплаты в порядке получения.
 */
function openAdvances(userId, cpId) {
  const all = db.prepare(`
    SELECT id, number, date, payload FROM documents
     WHERE user_id = ? AND cp_id = ? AND type = 'avans'
     ORDER BY date, id`).all(userId, Number(cpId));
  if (!all.length) return [];

  const used = db.prepare(`
    SELECT payload FROM documents
     WHERE user_id = ? AND cp_id = ? AND type = 'upd'`).all(userId, Number(cpId))
    .map((r) => { try { return JSON.parse(r.payload || '{}').advDoc || ''; } catch (_) { return ''; } })
    .join(' | ');

  return all.filter((a) => !used.includes(`№ ${a.number} `));
}

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
    // И со второго документа сделки, если его закрыли заодно с этим.
    db.prepare("UPDATE documents SET paid_at = '', paid_sum = 0, paid_with = 0 WHERE paid_with = ? AND user_id = ?")
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
  // Какие строки действительно легли: по ним потом предлагаем закрыть счета.
  // Пропущенные повторы туда попадать не должны — их деньги уже в журнале.
  const addedRows = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows || []) {
      const key = String(r && r.key ? r.key : '');
      const cp = key ? getCp(userId, Number(r.cpId)) : null;
      const amount = Math.round(Math.abs(Number(r && r.amount) || 0) * 100) / 100;
      if (!cp || !amount) { skipped += 1; continue; }

      if (!remember.run(userId, key, 0, cp.id, amount, now).changes) { skipped += 1; continue; }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : now.slice(0, 10);
      const doc = String(r.doc || 'Оплата по выписке').slice(0, 120);
      const opId = addOp(userId, cp.id, {
        date, kind: 'Оплата', doc, debit: amount, credit: 0, note: 'банковская выписка',
      });
      link.run(opId, userId, key);
      addedRows.push({ key, opId, cpId: cp.id, amount, date, doc });
      added += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { added, skipped, addedRows };
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

/**
 * Расхождение между тем, как человек работает, и тем, как считается долг.
 *
 * Счета выписаны и не оплачены, а в долгах их не видно — потому что при
 * основании «по отгрузке» долг создаёт акт, УПД или накладная, но не счёт.
 * Так бывает законно, и для учёта это верно: счёт — требование оплаты, а не
 * первичный документ. Но человеку, который работает счетами, это выглядит
 * сломанной цифрой: он выписывает счета, а главное число не шевелится.
 *
 * Живёт здесь, а не в мини-приложении, потому что спрашивают оба: раньше
 * объяснение было только на одном экране, и тот, кто смотрел долги в боте,
 * видел ровно ноль без единого слова.
 *
 * @param {number} owedToUs текущая цифра «нам должны» — только для формулировки
 * @returns {{to:string, count:number, sum:number, zero:boolean}|null}
 */
function basisMismatch(userId, org, owedToUs) {
  // В ручном режиме молчим: человек сам сказал, что журнал ведёт он, и кнопка
  // рядом с подсказкой молча начала бы делать проводки за него.
  const basis = basisOf(org || {});
  if (basis === 'manual') return null;

  /*
   * Берём все документы, чей вид при нынешнем основании обязательства не
   * создаёт, — а не только неоплаченные.
   *
   * Раньше выборка шла по неоплаченным, и подсказка замолкала ровно тогда,
   * когда становилась нужнее всего. Человек загружал выписку, счета
   * помечались оплаченными и выпадали из выборки, а деньги ложились в журнал
   * проводкой. Обязательства по ним нет — счёт его не создавал, — и сальдо
   * уходило в минус: клиент, только что расплатившийся, показывался тем,
   * кому должны мы. Объяснение при этом исчезало.
   *
   * Формально минус здесь не выдумка: деньги, полученные до закрывающего
   * документа, — это аванс, то есть обязательство перед клиентом. Но человеку,
   * который работает счетами, такое объяснение не нужно: ему нужно, чтобы
   * долг считался со счёта. Об этом и говорим.
   */
  const rows = db.prepare(
    'SELECT id, cp_id, type, total, paid_at FROM documents WHERE user_id = ? AND total > 0 AND no_debt = 0',
  ).all(userId);
  const mute = rows.filter((d) => !DEBT_DOCS[basis].includes(d.type));
  if (!mute.length) return null;

  /*
   * Говорим в двух случаях: либо такие документы висят неоплаченными и их
   * не видно в долге, либо по ним уже пришли деньги и сальдо ушло в минус.
   * Молчим, когда ни того, ни другого: у человека просто нет документов,
   * которые его основание не считает, — и лезть с советом незачем.
   */
  const unpaidMute = mute.filter((d) => !d.paid_at);
  const advanceCps = [...new Set(mute.map((d) => d.cp_id))]
    .filter((id) => (balanceOf(userId, id) || {}).closing < 0);
  const speak = unpaidMute.length ? unpaidMute
    : mute.filter((d) => advanceCps.includes(d.cp_id));
  if (!speak.length) return null;
  /*
   * Куда переключать — выводим из самих документов, а не подставляем «по
   * счёту» всегда. Иначе выходил замкнутый круг: у человека уже стоит «по
   * счёту», висит неоплаченный акт, экран советует включить включённое,
   * кнопка ничего не меняет и рапортует «Готово».
   */
  const to = speak.every((d) => DEBT_DOCS.invoice.includes(d.type)) ? 'invoice'
    : (speak.every((d) => DEBT_DOCS.closing.includes(d.type)) ? 'closing' : null);
  if (!to || to === basis) return null;
  return {
    to,
    count: speak.length,
    sum: round2(speak.reduce((a, d) => a + (Number(d.total) || 0), 0)),
    zero: Number(owedToUs || 0) <= 0,
    // Деньги уже пришли, а обязательства по ним нет — сальдо в минусе.
    // Экран говорит об этом иначе: не «их не видно», а «показаны авансом».
    advance: !unpaidMute.length,
  };
}

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
      /*
       * Восстанавливаем ровно ту сумму, что была записана при отметке, и
       * только если она была. Ноль в paid_sum означает «проводки по этому
       * документу нет» — обычно потому, что долг к моменту отметки уже был
       * закрыт оплатой из журнала или из выписки. Подставлять сюда полную
       * сумму документа, как раньше, значило считать одну оплату дважды.
       */
      const paySum = round2(Number(d.paid_sum) || 0);
      // Два разных вопроса, и путать их нельзя. «Оплачен» решает, уместна ли
      // проводка вообще: нет отметки — старую надо убрать. «Есть что
      // восстанавливать» решает, создавать ли недостающую. Держи мы это одним
      // условием, документ с отметкой и нулевой суммой лишался бы законной
      // проводки, пришедшей из выписки.
      const isPaid = should && Boolean(d.paid_at);
      const shouldPay = isPaid && paySum > 0;
      if (shouldPay && !hasOp(d.id, 'Оплата')) {
        if (addOpForDoc(userId, d.cp_id, {
          date: d.paid_at,
          kind: 'Оплата',
          doc: `${title} № ${d.number}`,
          debit: paySum,
        }, d.id)) paid += 1;
      } else if (!isPaid && hasOp(d.id, 'Оплата')) {
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
    }
    /*
     * Записываем всегда, в том числе ноль.
     *
     * Раньше запись стояла внутри условия, и когда долг к моменту отметки был
     * уже закрыт — клиент заплатил вперёд или оплату внесли строкой в журнал,
     * — проводки не появлялось, а paid_sum оставался нулём. Пересчёт видел
     * отметку без проводки и создавал её на ПОЛНУЮ сумму документа: ноль он
     * считал за «графы не было». Оплата удваивалась, сальдо уходило в минус,
     * и приложение сообщало, что это вы должны клиенту, который заплатил.
     *
     * Теперь у графы одно значение: сколько именно записано проводкой по
     * этому документу. Ноль означает «проводки нет», а не «неизвестно», и
     * догадываться пересчёту больше не о чем.
     */
    db.prepare('UPDATE documents SET paid_sum = ? WHERE id = ? AND user_id = ?').run(left, docId, userId);
  }
  return when;
}

function unmarkPaid(userId, docId) {
  const d = getDoc(userId, docId);
  if (!d) return false;
  db.prepare("UPDATE documents SET paid_at = '', paid_sum = 0 WHERE id = ? AND user_id = ?").run(docId, userId);
  db.prepare("UPDATE documents SET paid_at = '', paid_sum = 0, paid_with = 0 WHERE paid_with = ? AND user_id = ?")
    .run(docId, userId);
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

/**
 * Пометить дубли пары прямо на документах и посчитать сделки.
 *
 * Считать сделки одним числом было мало: плитка на главной брала это число,
 * а экран за ней и сводка в боте складывали список сами — и показывали
 * вдвое больше. Человек видел «30 000», нажимал и получал «2 счёта на
 * 60 000». Поэтому теперь отметка живёт на самом документе: у кого стоит
 * `pair`, тот в сумму не идёт, и складывать список может кто угодно.
 *
 * Главный в паре — тот, что создаёт долг: при «долге по отгрузке» это акт,
 * при «долге по счёту» — счёт. Второй его повторяет. В ручном режиме
 * правила нет, и пары не ищем.
 */
/*
 * Насколько далеко друг от друга могут стоять счёт и закрывающий его акт,
 * чтобы считаться одной сделкой.
 *
 * Без этого окна одинаковая сумма склеивала что угодно: у аренды и
 * обслуживания — тех самых дел, ради которых сделаны напоминания, — счёт
 * каждый месяц один и тот же. Неоплаченный январский акт на 50 000 и
 * августовский счёт на 50 000 — это два разных долга, а выглядели одной
 * сделкой, и сводка показывала половину того, что человеку должны.
 *
 * Полтора месяца покрывают обычный порядок «счёт в конце месяца — акт в
 * начале следующего» и любую нормальную отсрочку, но не сводят вместе
 * документы из разных кварталов.
 */
const DEAL_WINDOW_DAYS = 45;

const dayNum = (iso) => {
  const t = Date.parse(`${String(iso || '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / 86400000) : null;
};

function dealTotals(userId, docs) {
  const basis = basisOf(getDefaultOrg(userId) || {});
  const groups = new Map();
  for (const d of docs) {
    delete d.pair;
    const key = `${d.cp_id}|${round2(Number(d.total) || 0)}`;
    if (!groups.has(key)) groups.set(key, { bills: [], closings: [] });
    const g = groups.get(key);
    if (CLOSING_DOCS.includes(d.type)) g.closings.push(d); else g.bills.push(d);
  }
  if (basis !== 'manual') {
    for (const g of groups.values()) {
      // Пару ищем ближайшую по дате: если счетов и актов несколько, склеить
      // январский с августовским, оставив рядом стоящие непарными, — худший
      // из возможных разборов.
      const lead = basis === 'closing' ? g.closings : g.bills;
      const twins = (basis === 'closing' ? g.bills : g.closings)
        .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const taken = new Set();
      for (const l of lead.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
        const ld = dayNum(l.date);
        let best = null;
        let bestGap = Infinity;
        for (const t of twins) {
          if (taken.has(t)) continue;
          const td = dayNum(t.date);
          const gap = ld === null || td === null ? 0 : Math.abs(ld - td);
          if (gap <= DEAL_WINDOW_DAYS && gap < bestGap) { best = t; bestGap = gap; }
        }
        if (best) { taken.add(best); best.pair = true; }
      }
    }
  }
  const counted = docs.filter((d) => !d.pair);
  return {
    docs,
    count: counted.length,
    sum: round2(counted.reduce((s, d) => s + (Number(d.total) || 0), 0)),
  };
}

function unpaidSummary(userId, limit = 200) {
  return dealTotals(userId, unpaidDocs(userId, limit));
}

/**
 * Какие счета закрывают поступления из выписки.
 *
 * Деньги из банка попадают в журнал сами (importBankRows), но документы при
 * этом остаются в списке «не оплачено»: связь «пришло 30 000 от Зари» →
 * «значит, счёт № 7 закрыт» до сих пор человек делал глазами и руками. На
 * полусотне строк это и есть та работа, ради которой заводят бухгалтера.
 *
 * Здесь эта связь только предполагается. Ничего не отмечаем и в журнал не
 * лезем: возвращаем список, который бот показывает одним сообщением, а
 * нажимает человек. Долг, закрытый по ошибке, обнаруживают через месяц —
 * когда клиент не платит, а счёт уже помечен оплаченным.
 *
 * Правила подбора — намеренно осторожные:
 *
 *   • Считаем сделками, а не документами. Счёт и закрывающий его акт на одну
 *     и ту же сумму — это один долг на 30 000, а не два по 30 000; закрывать
 *     их надо вместе, а деньги списывать один раз. Пары ищет dealTotals —
 *     тот же расчёт, что и во всех остальных местах.
 *   • Закрываем только то, что один платёж покрывает целиком, от старых к
 *     новым. Частично оплаченный счёт не предлагаем вовсе: пометка
 *     «оплачен» означала бы, что пришли все деньги.
 *   • Один платёж — один источник. Складывать два поступления, чтобы вместе
 *     они закрыли счёт, не берёмся: угадать, что это оплата по частям, а не
 *     две разные, отсюда нельзя.
 *   • Остаток называем вслух: человеку надо знать, ждёт ли он ещё денег.
 *
 * @param {number} userId
 * @param {Array<{key:string, opId:number, cpId:number, amount:number, date:string, doc:string}>} payments
 * @returns {{deals:Array<object>, leftovers:Array<object>}}
 */
function matchPaymentsToDocs(userId, payments) {
  const deals = [];
  const leftovers = [];
  const spent = new Set();               // документы, уже занятые в этом разборе
  const cache = new Map();

  for (const p of payments || []) {
    const cpId = Number(p && p.cpId) || 0;
    const amount = round2(Math.abs(Number(p && p.amount) || 0));
    if (!cpId || !amount) continue;
    const cp = getCp(userId, cpId);
    if (!cp) continue;

    if (!cache.has(cpId)) {
      const docs = unpaidDocs(userId, 200).filter((d) => d.cp_id === cpId);
      dealTotals(userId, docs);          // расставит pair на вторых документах сделок
      cache.set(cpId, docs);
    }
    const docs = cache.get(cpId);
    const twins = docs.filter((d) => d.pair);

    let left = amount;
    for (const lead of docs.filter((d) => !d.pair)) {
      const total = round2(Number(lead.total) || 0);
      if (spent.has(lead.id) || total <= 0 || total > left) continue;
      const twin = twins.find((t) => !spent.has(t.id) && round2(Number(t.total) || 0) === total);
      spent.add(lead.id);
      if (twin) spent.add(twin.id);
      left = round2(left - total);
      deals.push({
        opId: Number(p.opId) || 0,
        cpId,
        cpName: cp.name,
        date: p.date,
        doc: p.doc || '',
        total,
        leadId: lead.id,
        twinId: twin ? twin.id : 0,
        title: `${lead.title} № ${lead.number}`,
        alsoTitle: twin ? `${twin.title} № ${twin.number}` : '',
      });
    }
    if (left > 0) leftovers.push({ cpId, cpName: cp.name, amount: left });
  }
  return { deals, leftovers };
}

/**
 * Отметить закрытыми счета, которые закрыли поступления из выписки.
 *
 * Деньги на этот момент уже в журнале — их занёс importBankRows отдельной
 * строкой. Поэтому здесь не «добавить оплату», а «переставить» её: сумма
 * сделки уходит из свободной строки выписки в строку, привязанную к
 * документу, и общий итог по клиенту не меняется ни на копейку.
 *
 * Почему именно так, а не проще:
 *
 *   • Просто поставить «оплачено» и не трогать журнал нельзя. Пересчёт
 *     (rebuildDebt) видит документ с отметкой и без привязанной проводки —
 *     и добросовестно создаёт вторую. Одна оплата, посчитанная дважды.
 *   • Просто вызвать markPaid тоже нельзя: он рассчитан на отметку руками,
 *     когда денег в журнале ещё нет, и добавляет проводку поверх той, что
 *     уже пришла из банка. Долг уходит в минус.
 *
 * Номер платёжки сохраняем: в привязанной строке остаётся тот же текст, что
 * был в выписке, — иначе при сверке не найти, каким платежом закрыт счёт.
 *
 * @returns {{docs:number, deals:number}} сколько документов и сделок закрыто
 */
function closeDocsFromBank(userId, deals) {
  /*
   * Владельца операции спрашиваем, а не подразумеваем.
   *
   * opId приходит прямо из тела запроса приложения. leadId проверен getDoc,
   * cpId — getCp, а этот не проверялся ничем: чужой идентификатор в поле
   * молча удалял операцию другого человека и менял его сальдо. Следа не
   * оставалось — строка просто исчезала из журнала, и владелец узнать об
   * этом не мог.
   *
   * Операция принадлежит контрагенту, а контрагент — человеку, поэтому
   * спрашиваем через counterparties, как это делает deleteOp. Условие
   * повторено в трёх запросах намеренно: проверка в одном месте держится
   * только на том, что порядок вызовов никто не переставит.
   */
  const own = 'cp_id IN (SELECT id FROM counterparties WHERE user_id = ?)';
  const cut = db.prepare(`UPDATE operations SET debit = ? WHERE id = ? AND ${own}`);
  const drop = db.prepare(`DELETE FROM operations WHERE id = ? AND ${own}`);
  const amountOf = db.prepare(`SELECT debit FROM operations WHERE id = ? AND ${own}`);
  const mark = db.prepare('UPDATE documents SET paid_at = ?, paid_sum = ? WHERE id = ? AND user_id = ?');
  const markTwin = db.prepare('UPDATE documents SET paid_at = ?, paid_sum = 0 WHERE id = ? AND user_id = ?');
  let docs = 0;
  let done = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const d of deals || []) {
      const lead = getDoc(userId, Number(d.leadId));
      if (!lead || lead.paid_at) continue;
      const when = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date)) ? d.date : todayISO();
      const total = round2(Number(d.total) || 0);

      // Убираем сумму сделки из свободной строки выписки.
      const src = d.opId ? amountOf.get(Number(d.opId), userId) : null;
      let dropped = false;
      if (src) {
        const rest = round2((Number(src.debit) || 0) - total);
        if (rest > 0.004) cut.run(rest, Number(d.opId), userId);
        else { drop.run(Number(d.opId), userId); dropped = true; }
      }
      // И кладём её же строкой, привязанной к документу.
      addOpForDoc(userId, d.cpId, {
        date: when, kind: 'Оплата', doc: d.doc || `${lead.title} № ${lead.number}`, debit: total,
      }, lead.id);
      /*
       * Отметку о загрузке переставляем на новую строку. По ней deleteOp
       * узнаёт, что операция пришла из выписки, и при отмене разрешает
       * загрузить её заново. Оставь мы ссылку на удалённую строку — оплату,
       * отменённую по ошибке, было бы уже не вернуть: файл считается
       * загруженным навсегда.
       */
      if (dropped) {
        const fresh = db.prepare(
          "SELECT id FROM operations WHERE doc_id = ? AND kind = 'Оплата'",
        ).get(lead.id);
        if (fresh) {
          db.prepare('UPDATE bank_imports SET op_id = ? WHERE user_id = ? AND op_id = ?')
            .run(fresh.id, userId, Number(d.opId));
        }
      }

      mark.run(when, total, lead.id, userId);
      docs += 1;
      /*
       * У пары проводки нет и быть не должно — долг создаёт только один
       * документ сделки. Отметка нужна, чтобы второй не висел в «не оплачено»
       * уже в одиночку: без неё он остался бы там без своей половины и пошёл
       * бы в сумму как отдельный долг на те же 30 000.
       *
       * Ссылка на первый — чтобы отмена оплаты сняла отметку с обоих.
       */
      if (d.twinId) {
        markTwin.run(when, Number(d.twinId), userId);
        db.prepare('UPDATE documents SET paid_with = ? WHERE id = ? AND user_id = ?')
          .run(lead.id, Number(d.twinId), userId);
        docs += 1;
      }
      done += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { docs, deals: done };
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

/**
 * Занят ли уже такой номер в этом году у этого вида документа.
 *
 * Уникальный индекс стоит на порядковом номере (seq), а на самом номере —
 * ни на чём: он строка и его разрешено задавать руками. Поэтому «счёт № 3»,
 * выписанный вручную, спокойно уживался со счётом № 3, который через две
 * выписки присвоился сам, и в году оказывалось два документа с одним
 * номером. Индексом это не закрыть: в базах, где повторы уже есть, он
 * попросту не создастся, — поэтому спрашиваем перед записью.
 */
function numberTaken(userId, type, year, number) {
  return Boolean(db.prepare(
    'SELECT id FROM documents WHERE user_id = ? AND type = ? AND year = ? AND number = ? LIMIT 1',
  ).get(userId, type, Number(year), String(number)));
}

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
  getOrCreateUser, setState, getState, clearState, isAiEnabled, setAiEnabled,
  createOrg, updateOrg, saveMyOrg, vatOf, listOrgs, getOrg, getDefaultOrg, setDefaultOrg,
  createCp, updateCp, listCps, getCp, openAdvances,
  addOp, listOps, deleteLastOp, deleteOp, balanceOf, debtors, debtBreakdown, periodBalance, cpForPeriod,
  knownBankKeys, importBankRows,
  DEBT_DOCS, basisOf, makesDebt, basisMismatch, addOpForDoc, opsOfDoc, deleteOpsOfDoc,
  debtByDoc, rebuildDebt, restoreDebt,
  markPaid, unmarkPaid, matchPaymentsToDocs, closeDocsFromBank,
  unpaidDocs, unpaidSummary, dealTotals, docsBetween,
  markBlocked, markActive, isBlocked, reachableUsers, userById, findUserByUsername,
  isSeqTaken, guardSeq, numberTaken,
  nextSeq, saveDoc, listDocs, getDoc, deleteDoc, DOC_TITLES,
  rememberItems, listTemplates, getTemplate, forgetTemplate,
  quota, docsThisMonth, freePerMonth,
};
