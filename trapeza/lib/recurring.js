'use strict';

/**
 * Регулярные документы: «каждый месяц выставлять счёт за аренду».
 *
 * Зачем. У арендодателя, обслуживающей компании, подписчика на услуги
 * документы одни и те же из месяца в месяц: те же позиции, тот же клиент,
 * меняются только номер и дата. Забыть выставить счёт — значит не получить
 * деньги вовремя; выставить дважды — объясняться с бухгалтерией клиента.
 *
 * Как это устроено. Здесь хранится только договорённость: кому, что и
 * какого числа. В нужный день бот приходит с готовым предложением и
 * кнопками «Выписать» и «Пропустить месяц».
 *
 * Почему бот не выписывает сам. Документ забирает номер в сквозном ряду.
 * Лишний счёт нельзя тихо удалить: в нумерации останется дыра, и её придётся
 * объяснять при проверке. Поэтому автоматическим здесь может быть только
 * напоминание, а решение — всегда за человеком. По той же причине никакие
 * письма контрагентам отсюда не уходят: отправку клиенту человек
 * подтверждает отдельно и видит текст.
 */

const { db } = require('../db');

/** День «последнее число месяца» — 30-е и 31-е есть не в каждом месяце. */
const LAST_DAY = 0;

const iso = (d) => d.toISOString().slice(0, 10);

/** Месяц как YYYY-MM. Правило «раз в месяц» проверяется именно по нему:
 *  считать дни от прошлого запуска — верный способ ошибиться на границе. */
const monthKey = (date = new Date()) => iso(date).slice(0, 7);

function isLastDayOfMonth(date) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + 1);
  return next.getMonth() !== date.getMonth();
}

/** Допустимый день: 1–28 или 0 (последнее число). */
function normalizeDay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  if (n === LAST_DAY) return LAST_DAY;
  // 29, 30 и 31 не наступают каждый месяц. Молча сдвигать такой день —
  // это счёт за февраль, выставленный третьего марта.
  return Math.min(28, Math.max(1, Math.round(n)));
}

/** Короткая подпись: в списке она стоит рядом с названием документа,
 *  и «в последний день месяца» вытесняло бы его целиком. */
function dayLabel(day) {
  return day === LAST_DAY ? 'в конце месяца' : `${day}-го числа`;
}

/**
 * В какое число предлагать выписать документ.
 *
 * Обычно это просто day. У аренды иначе: платёж привязан к числу договора
 * (pay_day), а счёт нужен заранее — за lead_days до него. Считаем день
 * здесь, а не при заведении, потому что «за 3 дня до 5-го» — это 2-е, и
 * запомнить готовое число значило бы потерять связь с договором: изменится
 * срок — придётся пересчитывать руками.
 */
function offerDay(rec) {
  if (!rec.pay_day) return rec.day;
  const d = rec.pay_day - (rec.lead_days || 0);
  // Ушли за начало месяца — предлагаем первого: выставить счёт раньше, чем
  // начался месяц, всё равно нельзя, а пропускать платёж нельзя тем более.
  return d < 1 ? 1 : d;
}

/** Срок оплаты этого месяца, ISO. Пусто — если срок не задан. */
function dueDate(rec, date = new Date()) {
  if (!rec.pay_day) return '';
  return `${monthKey(date)}-${String(rec.pay_day).padStart(2, '0')}`;
}

/**
 * Пора ли предлагать.
 *
 * Условие «не раньше дня X», а не «ровно в день X»: если бот был выключен
 * пятого числа, предложение должно прийти шестого, а не пропасть на месяц.
 */
function isDue(rec, date = new Date()) {
  if (!rec.active) return false;
  if (rec.last_offer === monthKey(date)) return false;
  const day = offerDay(rec);
  if (day === LAST_DAY) return isLastDayOfMonth(date);
  return date.getDate() >= day;
}

/**
 * Наступила ли просрочка: срок оплаты прошёл, а этот месяц ещё не отмечен.
 *
 * Сообщаем со следующего дня после срока — «в первый же день неоплаты»,
 * как это и делают вручную. Оплачен ли счёт на самом деле, здесь не видно:
 * это проверяет вызывающий по журналу документов.
 */
function isOverdue(rec, date = new Date()) {
  if (!rec.active || !rec.pay_day) return false;
  if (rec.last_due === monthKey(date)) return false;
  return date.getDate() > rec.pay_day;
}

/**
 * Завести повторение.
 *
 * Текущий месяц сразу считаем отработанным: повторение заводят следом за
 * только что выписанным документом, и предлагать его второй раз в том же
 * месяце — это ровно то задвоение, от которого мы бережём.
 */
function add(userId, {
  cpId, type, items, extra = {}, note = '', day = 1, payDay = 0, leadDays = 0,
}) {
  const pay = payDay ? normalizeDay(payDay) : 0;
  const info = db.prepare(`INSERT INTO recurring(user_id, cp_id, type, day, pay_day, lead_days,
      items, extra, note, active, last_offer, created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`)
    .run(userId, Number(cpId), String(type), normalizeDay(day),
      pay, pay ? Math.min(27, Math.max(0, Math.round(Number(leadDays) || 0))) : 0,
      JSON.stringify(Array.isArray(items) ? items : []),
      JSON.stringify(extra && typeof extra === 'object' ? extra : {}),
      String(note).slice(0, 200), monthKey(), new Date().toISOString());
  return Number(info.lastInsertRowid);
}

const json = (text, fallback) => {
  try { return JSON.parse(text) || fallback; } catch (_) { return fallback; }
};

function parse(row) {
  if (!row) return null;
  // Ставка НДС и статус УПД лежат рядом с позициями: без них повторный
  // документ вышел бы с настройками по умолчанию, а не такой же, как был.
  const rec = {
    ...row,
    items: json(row.items, []),
    extra: json(row.extra, {}),
  };
  rec.offerDay = offerDay(rec);
  rec.dayText = row.pay_day
    ? `${dayLabel(rec.offerDay)} (оплата ${row.pay_day}-го)`
    : dayLabel(row.day);
  return rec;
}

/** Повторения пользователя вместе с именем контрагента. */
function list(userId, { activeOnly = true } = {}) {
  return db.prepare(`SELECT r.*, c.name AS cp_name FROM recurring r
      JOIN counterparties c ON c.id = r.cp_id
      WHERE r.user_id = ?${activeOnly ? ' AND r.active = 1' : ''}
      ORDER BY r.day, r.id`).all(userId).map(parse);
}

function get(userId, id) {
  return parse(db.prepare(`SELECT r.*, c.name AS cp_name FROM recurring r
      JOIN counterparties c ON c.id = r.cp_id
      WHERE r.id = ? AND r.user_id = ?`).get(Number(id), userId));
}

function setDay(userId, id, day) {
  db.prepare('UPDATE recurring SET day = ? WHERE id = ? AND user_id = ?')
    .run(normalizeDay(day), Number(id), userId);
}

function off(userId, id) {
  db.prepare('UPDATE recurring SET active = 0 WHERE id = ? AND user_id = ?').run(Number(id), userId);
}

/**
 * Что предложить сегодня.
 *
 * JOIN с контрагентами не для красоты: удалённый контрагент оставил бы
 * повторение, которое каждый месяц предлагает выписать документ в пустоту.
 */
function due(date = new Date()) {
  return db.prepare(`SELECT r.*, c.name AS cp_name FROM recurring r
      JOIN counterparties c ON c.id = r.cp_id
      WHERE r.active = 1 ORDER BY r.user_id, r.day`)
    .all().map(parse).filter((r) => isDue(r, date));
}

/** Отметить, что за этот месяц предложение отправлено. */
function markOffered(id, date = new Date()) {
  db.prepare('UPDATE recurring SET last_offer = ? WHERE id = ?').run(monthKey(date), Number(id));
}

/**
 * У кого сегодня первый день просрочки.
 *
 * Возвращает только тех, у кого задан срок оплаты и он прошёл. Оплачен ли
 * счёт, здесь не проверяется: журнал документов лежит в другом модуле, и
 * тянуть его сюда значило бы связать расписание с учётом. Вызывающий
 * отсеивает оплаченных сам.
 */
function overdue(date = new Date()) {
  return db.prepare(`SELECT r.*, c.name AS cp_name FROM recurring r
      JOIN counterparties c ON c.id = r.cp_id
      WHERE r.active = 1 AND r.pay_day > 0 ORDER BY r.user_id, r.pay_day`)
    .all().map(parse).filter((r) => isOverdue(r, date));
}

/** Отметить, что о просрочке за этот месяц уже сообщили. */
function markDueNoticed(id, date = new Date()) {
  db.prepare('UPDATE recurring SET last_due = ? WHERE id = ?').run(monthKey(date), Number(id));
}

/** Срок оплаты и предупреждение — вместе, одним вызовом для UI. */
function setSchedule(userId, id, { payDay, leadDays }) {
  const pay = payDay ? normalizeDay(payDay) : 0;
  db.prepare('UPDATE recurring SET pay_day = ?, lead_days = ? WHERE id = ? AND user_id = ?')
    .run(pay, pay ? Math.min(27, Math.max(0, Math.round(Number(leadDays) || 0))) : 0,
      Number(id), userId);
}

module.exports = {
  add, list, get, setDay, setSchedule, off,
  due, markOffered, overdue, markDueNoticed,
  isDue, isOverdue, offerDay, dueDate,
  monthKey, normalizeDay, dayLabel, LAST_DAY,
};
