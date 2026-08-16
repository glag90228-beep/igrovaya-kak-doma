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
 * Пора ли предлагать.
 *
 * Условие «не раньше дня X», а не «ровно в день X»: если бот был выключен
 * пятого числа, предложение должно прийти шестого, а не пропасть на месяц.
 */
function isDue(rec, date = new Date()) {
  if (!rec.active) return false;
  if (rec.last_offer === monthKey(date)) return false;
  if (rec.day === LAST_DAY) return isLastDayOfMonth(date);
  return date.getDate() >= rec.day;
}

/**
 * Завести повторение.
 *
 * Текущий месяц сразу считаем отработанным: повторение заводят следом за
 * только что выписанным документом, и предлагать его второй раз в том же
 * месяце — это ровно то задвоение, от которого мы бережём.
 */
function add(userId, { cpId, type, items, extra = {}, note = '', day = 1 }) {
  const info = db.prepare(`INSERT INTO recurring(user_id, cp_id, type, day, items, extra, note,
      active, last_offer, created_at) VALUES(?,?,?,?,?,?,?,1,?,?)`)
    .run(userId, Number(cpId), String(type), normalizeDay(day),
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
  return {
    ...row,
    items: json(row.items, []),
    extra: json(row.extra, {}),
    dayText: dayLabel(row.day),
  };
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

module.exports = {
  add, list, get, setDay, off, due, markOffered,
  isDue, monthKey, normalizeDay, dayLabel, LAST_DAY,
};
