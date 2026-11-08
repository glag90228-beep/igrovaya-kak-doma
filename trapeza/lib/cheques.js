'use strict';

/**
 * Чеки самозанятого: что надо пробить и что уже пробито.
 *
 * Зачем. Напоминание про чек (lib/npd.js) приходило один раз, в момент
 * отметки оплаты, и сообщение уезжало вверх по чату. Через неделю никто уже
 * не помнил, пробит чек или нет, а срок по закону жёсткий: при оплате на счёт
 * чек нужен до 9-го числа следующего месяца (422-ФЗ, ст. 14). Здесь
 * напоминание получает память: «ждёт чека» живёт, пока человек не отметит
 * его, и всплывает в утренней сводке и на главной экрана приложения.
 *
 * Чего не делаем. Чек за человека не формируем и в «Мой налог» не ходим:
 * официального открытого API у нас нет, а партнёрский доступ и ключи — решение
 * владельца продукта, не код. Мы готовим данные для чека, которые остаётся
 * ввести руками, и запоминаем, что чек пробит (по желанию — с его ссылкой).
 *
 * Одна запись на каждое поступление денег, а не на документ. Чек самозанятый
 * обязан пробить на каждый полученный платёж: аванс, часть суммы, оплату в два
 * приёма — по каждому отдельно и на его сумму. Раньше запись была одна на
 * документ и на всю его сумму, и частичная оплата, аванс и платёж без документа
 * чеков не давали вовсе (а «Оплатил» после частичной называл полную сумму, хотя
 * часть денег уже была учтена). Теперь запись привязана к проводке «Оплата»
 * (`op_id`) и создаётся сама в момент её появления (`recordIncome` из
 * lib/bot-db.js), с какого бы экрана деньги ни вносили. Повторное «Оплатил»
 * новой проводки не делает, поэтому и второй записи не заводит.
 *
 * Снятие проводки снимает ожидание чека по ней; уже пробитый чек не трогаем —
 * он есть в налоговой, и стереть его у себя значило бы потерять след.
 */

const { db } = require('../db');
const bdb = require('./bot-db');
const npd = require('./npd');

db.exec(`
  CREATE TABLE IF NOT EXISTS npd_cheques (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
    org_id     INTEGER NOT NULL DEFAULT 0,
    doc_id     INTEGER NOT NULL DEFAULT 0,   -- за какой документ пришли деньги (0 — свободная оплата)
    cp_id      INTEGER NOT NULL DEFAULT 0,
    amount     REAL    NOT NULL DEFAULT 0,
    service    TEXT    NOT NULL DEFAULT '',  -- наименование для чека
    buyer_inn  TEXT    NOT NULL DEFAULT '',
    buyer_name TEXT    NOT NULL DEFAULT '',
    paid_at    TEXT    NOT NULL DEFAULT '',  -- когда пришли деньги
    due        TEXT    NOT NULL DEFAULT '',  -- до какого числа пробить
    status     TEXT    NOT NULL DEFAULT 'open',   -- open | done
    link       TEXT    NOT NULL DEFAULT '',  -- ссылка на чек, если человек её дал
    number     TEXT    NOT NULL DEFAULT '',  -- номер чека из этой ссылки
    done_at    TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cheq_user ON npd_cheques(user_id, status);
`);

/*
 * Миграция к чекам «по проводке».
 *
 * op_id — проводка «Оплата», по которой надо чек. notified — сказали ли уже
 * человеку (старым записям — да: он о них знает). Уникальность раньше стояла на
 * документе, а у документа теперь может быть несколько платежей, поэтому
 * старый индекс снимаем и ставим уникальность на проводку. Записи старого вида
 * (op_id = 0) остаются как есть — к проводке привязываем те, у которых она есть.
 */
{
  const cols = db.prepare('PRAGMA table_info(npd_cheques)').all().map((c) => c.name);
  if (!cols.includes('op_id')) db.exec('ALTER TABLE npd_cheques ADD COLUMN op_id INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('notified')) db.exec('ALTER TABLE npd_cheques ADD COLUMN notified INTEGER NOT NULL DEFAULT 1');
  db.exec(`
    DROP INDEX IF EXISTS idx_cheq_doc;
    CREATE INDEX IF NOT EXISTS idx_cheq_doc2 ON npd_cheques(user_id, doc_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cheq_op ON npd_cheques(user_id, op_id) WHERE op_id > 0;
    UPDATE npd_cheques SET op_id = COALESCE((
        SELECT MIN(o.id) FROM operations o WHERE o.doc_id = npd_cheques.doc_id AND o.kind = 'Оплата'), 0)
      WHERE op_id = 0 AND doc_id > 0;
  `);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const digits = (s) => String(s || '').replace(/\D/g, '');

/**
 * Ссылка на чек из «Моего налога».
 *
 * Принимаем только адрес самого сервиса. Ссылка потом показывается как
 * кликабельная в карточке документа, и произвольный адрес, вставленный в
 * поле «чек», превратил бы её в способ увести человека на чужой сайт.
 * Настоящий вид — https://lknpd.nalog.ru/api/v1/receipt/<ИНН>/<номер>/print,
 * номер — предпоследний отрезок пути.
 *
 * @returns {{link:string, number:string}|null}
 */
function parseLink(text) {
  const m = /https:\/\/lknpd\.nalog\.ru\/[^\s<>"']+/i.exec(String(text || ''));
  if (!m) return null;
  let url;
  try { url = new URL(m[0].replace(/[.,;)]+$/, '')); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'lknpd.nalog.ru') return null;
  const seg = url.pathname.split('/').filter(Boolean);
  const at = seg.indexOf('receipt');
  // …/receipt/<ИНН>/<номер>[/print|/json]
  const number = at >= 0 && seg[at + 2] ? seg[at + 2] : '';
  return { link: url.toString().slice(0, 300), number: number.slice(0, 40) };
}

/** Наименование для чека: одна позиция — она сама, несколько — первая и пометка. */
function serviceName(doc) {
  const items = (doc.payload && doc.payload.items) || [];
  const first = items[0] && String(items[0].name || '').trim();
  // Название документа в предложном падеже не склонить, а «по счёт на оплату» — ошибка в чеке.
  const tail = `по документу № ${doc.number}`;
  if (items.length === 1 && first) return first.slice(0, 200);
  if (first) return `${first} и др. ${tail}`.slice(0, 200);
  return `Услуги ${tail}`.slice(0, 200);
}

/** Наименование для чека по свободной оплате (без документа). */
function freeServiceName(op) {
  const note = String(op.doc || '').trim();
  const generic = !note || /^(оплата|предоплата|оплата по выписке)$/i.test(note);
  if (/предоплат/i.test(`${op.note} ${op.doc}`)) return 'Услуги (предоплата)';
  return generic ? 'Услуги' : `Услуги — ${note}`.slice(0, 200);
}

/**
 * Записать «надо пробить чек» по поступлению — проводке «Оплата».
 *
 * Чек нужен на каждый полученный платёж и на его сумму: частичную оплату, оплату
 * частями, аванс, платёж из выписки. Молчит, если это не поступление (не
 * «Оплата», нет суммы, поставщик — это наша оплата ему), если фирма проводки не
 * на НПД, и если запись по этой проводке уже есть.
 *
 * Фирма берётся из самой проводки, а не выбранная сейчас — как и везде, где
 * деньги привязаны к фирме (иначе при переключённой фирме чек терялся).
 *
 * @returns {object|null} запись (новая или уже существующая — `existed`) либо null
 */
function recordIncome(userId, opId) {
  const op = db.prepare(`
    SELECT o.*, c.kind AS cp_kind FROM operations o
      JOIN counterparties c ON c.id = o.cp_id
     WHERE o.id = ? AND c.user_id = ?`).get(Number(opId), userId);
  if (!op || op.kind !== 'Оплата' || !(Number(op.debit) > 0) || op.cp_kind === 'supplier') return null;
  const org = bdb.getOrg(userId, op.org_id) || bdb.currentOrg(userId);
  if (!npd.isNpd(org)) return null;
  const old = db.prepare('SELECT * FROM npd_cheques WHERE user_id = ? AND op_id = ?').get(userId, op.id);
  if (old) return { ...old, existed: true };

  const doc = op.doc_id ? bdb.getDoc(userId, op.doc_id) : null;
  const cp = bdb.getCp(userId, op.cp_id);
  const inn = digits(cp && cp.inn);
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(op.date)) ? op.date : new Date().toISOString().slice(0, 10);
  const info = db.prepare(`INSERT INTO npd_cheques(user_id, org_id, doc_id, cp_id, amount, service,
      buyer_inn, buyer_name, paid_at, due, status, created_at, op_id, notified) VALUES(?,?,?,?,?,?,?,?,?,?,'open',?,?,0)`)
    .run(userId, Number(org.id) || 0, doc ? doc.id : 0, cp ? cp.id : 0, round2(op.debit),
      doc ? serviceName(doc) : freeServiceName(op),
      inn.length === 10 || inn.length === 12 ? inn : '', cp ? String(cp.full_name || cp.name || '') : '',
      when, npd.chequeDue(when), new Date().toISOString(), op.id);
  return get(userId, Number(info.lastInsertRowid));
}

/**
 * Чек по документу, оплату которого отметили, но проводки в журнале не вышло.
 *
 * Бывает, когда документ долга не создаёт (счёт при долге «по акту», ручной
 * режим, отменённый вручную долг): «Оплатил» только ставит отметку, а деньги
 * самозанятый получил, и чек ему всё равно нужен. Записей по проводке тут нет,
 * поэтому запись одна на документ и на его сумму, как раньше. Повторная отметка
 * второй записи не заводит.
 *
 * @returns {object|null}
 */
function recordForDoc(userId, docId) {
  const doc = bdb.getDoc(userId, Number(docId));
  if (!doc || !(Number(doc.total) > 0)) return null;
  const org = bdb.orgOfDoc(userId, doc);
  if (!npd.isNpd(org)) return null;
  const old = db.prepare('SELECT * FROM npd_cheques WHERE user_id = ? AND doc_id = ? AND op_id = 0').get(userId, doc.id);
  if (old) return { ...old, existed: true };
  const cp = doc.cp_id ? bdb.getCp(userId, doc.cp_id) : null;
  const inn = digits(cp && cp.inn);
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(doc.paid_at)) ? doc.paid_at : doc.date;
  const info = db.prepare(`INSERT INTO npd_cheques(user_id, org_id, doc_id, cp_id, amount, service,
      buyer_inn, buyer_name, paid_at, due, status, created_at, op_id, notified) VALUES(?,?,?,?,?,?,?,?,?,?,'open',?,0,0)`)
    .run(userId, Number(org.id) || 0, doc.id, cp ? cp.id : 0, round2(doc.total), serviceName(doc),
      inn.length === 10 || inn.length === 12 ? inn : '', cp ? String(cp.full_name || cp.name || '') : '',
      when, npd.chequeDue(when), new Date().toISOString());
  return get(userId, Number(info.lastInsertRowid));
}

/**
 * Чеки по оплате документа — для тех, кто спрашивает «есть ли ожидание чека по
 * этому документу». Каждая проводка «Оплата» документа уже имеет запись (её
 * завёл recordIncome в момент появления проводки); здесь подстраховка для
 * проводок, появившихся мимо него, а если проводок нет вовсе, — запись по
 * документу (recordForDoc). Экраны сами эту функцию не вызывают.
 *
 * @returns {object|null} первая запись по документу
 */
function owe(userId, docId) {
  const doc = bdb.getDoc(userId, Number(docId));
  if (!doc) return null;
  const ops = db.prepare("SELECT id FROM operations WHERE doc_id = ? AND kind = 'Оплата' ORDER BY id").all(doc.id);
  let first = null;
  for (const o of ops) {
    const c = recordIncome(userId, o.id);
    if (c && !first) first = c;
  }
  return first || recordForDoc(userId, doc.id);
}

/** Несколько документов сразу. Возвращает только новые записи. */
function oweMany(userId, docIds) {
  const out = [];
  for (const id of docIds || []) {
    const c = owe(userId, id);
    if (c && !c.existed) out.push(c);
  }
  return out;
}

/**
 * Записи, о которых человеку ещё не говорили, — и пометка, что теперь сказали.
 *
 * Запись заводится в момент появления проводки, с любого экрана, а сказать об
 * этом надо там, где человек сейчас: экран, который внёс деньги, забирает
 * новые записи и показывает напоминание. Забрал — второй раз не покажет.
 */
function takeFresh(userId) {
  const rows = db.prepare("SELECT * FROM npd_cheques WHERE user_id = ? AND status = 'open' AND notified = 0 ORDER BY id")
    .all(userId);
  if (rows.length) {
    db.prepare("UPDATE npd_cheques SET notified = 1 WHERE user_id = ? AND status = 'open' AND notified = 0").run(userId);
  }
  return rows;
}

function get(userId, id) {
  return db.prepare('SELECT * FROM npd_cheques WHERE id = ? AND user_id = ?').get(Number(id), userId) || null;
}

/**
 * Чек по документу для карточки. Платежей может быть несколько — показываем тот,
 * что ещё не пробит (он срочнее), иначе последний пробитый.
 */
function forDoc(userId, docId) {
  return db.prepare(`SELECT * FROM npd_cheques WHERE user_id = ? AND doc_id = ?
      ORDER BY (status = 'open') DESC, id DESC LIMIT 1`).get(userId, Number(docId)) || null;
}

/** Непробитые — самые срочные первыми. */
function open(userId) {
  return db.prepare(`SELECT ch.*, c.name AS cp_name FROM npd_cheques ch
      LEFT JOIN counterparties c ON c.id = ch.cp_id
      WHERE ch.user_id = ? AND ch.status = 'open' ORDER BY ch.due, ch.id`).all(userId);
}

function openCount(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM npd_cheques WHERE user_id = ? AND status = 'open'").get(userId).n;
}

/**
 * Отметить чек пробитым. Ссылка необязательна: многие просто нажимают
 * «пробил», и требовать от них большего значило бы сделать отметку
 * неудобнее, чем пробить чек.
 * @returns {object|null} запись, либо null — чужая или несуществующая
 */
function markDone(userId, id, linkText = '', at = new Date().toISOString()) {
  const row = get(userId, id);
  if (!row) return null;
  const parsed = linkText ? parseLink(linkText) : null;
  db.prepare(`UPDATE npd_cheques SET status = 'done', done_at = CASE WHEN done_at = '' THEN ? ELSE done_at END,
      link = ?, number = ? WHERE id = ? AND user_id = ?`)
    .run(at, parsed ? parsed.link : row.link, parsed ? parsed.number : row.number, row.id, userId);
  return get(userId, id);
}

/** Приложить ссылку к уже отмеченному чеку. false — ссылка не та. */
function attachLink(userId, id, linkText) {
  const row = get(userId, id);
  const parsed = parseLink(linkText);
  if (!row || !parsed) return false;
  db.prepare('UPDATE npd_cheques SET link = ?, number = ? WHERE id = ? AND user_id = ?')
    .run(parsed.link, parsed.number, row.id, userId);
  return true;
}

/**
 * Оплату сняли — ждать чека не от чего. Пробитый чек не трогаем: он уже есть
 * в налоговой, и стереть его у себя значило бы потерять след.
 *
 * Снимает ожидание по проводкам (opIds) и по старым записям документа без
 * проводки (docId, op_id = 0).
 */
function cancelFor(userId, { opIds = [], docId = 0 } = {}) {
  let n = 0;
  for (const id of opIds) {
    n += db.prepare("DELETE FROM npd_cheques WHERE user_id = ? AND op_id = ? AND status = 'open'")
      .run(userId, Number(id)).changes;
  }
  if (docId) {
    n += db.prepare("DELETE FROM npd_cheques WHERE user_id = ? AND doc_id = ? AND op_id = 0 AND status = 'open'")
      .run(userId, Number(docId)).changes;
  }
  return n;
}

const rub = (n) => `${new Intl.NumberFormat('ru-RU').format(round2(n)).replace(/[  ]/g, ' ')} ₽`;
const ru = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

/**
 * Готовые данные для чека — текстом и по полям. В «Моём налоге» вводят ровно
 * это: тип покупателя, ИНН и название (для организации и ИП), наименование,
 * сумму.
 */
function details(row) {
  const inn = String(row.buyer_inn || '');
  let buyer = 'физическое лицо (ИНН не нужен)';
  if (inn.length === 10) buyer = `организация, ИНН ${inn}`;
  else if (inn.length === 12) buyer = `ИП, ИНН ${inn} (если это физлицо — ИНН в чеке не нужен)`;
  return {
    service: row.service,
    amount: round2(row.amount),
    amountText: rub(row.amount),
    buyer,
    buyerInn: inn,
    buyerName: row.buyer_name || '',
    due: row.due,
    dueText: ru(row.due),
    paidText: ru(row.paid_at),
  };
}

/** Текст напоминания (без разметки: бот сам экранирует, приложение показывает как есть). */
function reminderText(row, cpName = '') {
  const d = details(row);
  const who = cpName || row.buyer_name;
  return `Пробейте чек в «Мой налог» на ${d.amountText}${who ? ` для ${who}` : ''}.\n\n`
    + 'Данные для чека:\n'
    + `• Наименование: ${d.service}\n`
    + `• Сумма: ${d.amountText}\n`
    + `• Покупатель: ${d.buyer}\n`
    + (d.buyerName && d.buyerInn ? `• Название покупателя: ${d.buyerName}\n` : '')
    + (d.dueText ? `\nПри оплате переводом на счёт чек нужен до ${d.dueText} — это 9-е число месяца, `
      + 'следующего за оплатой (422-ФЗ, ст. 14).' : '');
}

module.exports = {
  parseLink, serviceName, recordIncome, recordForDoc, owe, oweMany, takeFresh, get, forDoc, open, openCount,
  markDone, attachLink, cancelFor, details, reminderText, rub, LK_URL: npd.LK_URL,
};
