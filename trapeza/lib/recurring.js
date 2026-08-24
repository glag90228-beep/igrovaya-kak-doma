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

/*
 * Повторяющаяся операция журнала — второй вид правила, рядом с документами.
 *
 * Зачем отдельно. Выписка из банка закрывает ту часть, где двигались деньги.
 * Но сальдо двигает и то, чего в банке не видно никогда: взаимозачёт по
 * подписанному акту, ежемесячное списание задолженности, фиксированное
 * начисление. Такую строку человек обязан помнить сам — и однажды забудет,
 * а сальдо разъедется незаметно, до ближайшей сверки.
 *
 * Почему здесь бот вносит сам, а документ — нет. Документ забирает номер в
 * сквозном ряду и уходит контрагенту; лишний счёт не отменить бесследно.
 * Строка журнала внутренняя, её видит только владелец, и отмена убирает её
 * вместе со следом в сальдо. Поэтому правило работает само, но каждый раз
 * говорит об этом и даёт отменить в одно касание.
 *
 * Счётчик обязателен по той же причине. «Гашу долг пятью частями» — это
 * ровно пять раз, а не «каждый месяц навсегда»: правило, пережившее свой
 * долг, начнёт списывать то, чего уже нет.
 */
const OP_TYPE = 'op';
const isOp = (rec) => Boolean(rec) && rec.type === OP_TYPE;

/*
 * Календарь здесь московский, тот же, что у документов (lib/period.js).
 *
 * Раньше месяц брался через toISOString(), то есть по UTC, а день месяца —
 * через getDate(), то есть по поясу сервера. Две разные шкалы в одном
 * условии: ежедневный обход просыпается в московскую полночь, а месяц в
 * этот момент по UTC ещё прошлый — предложение выписать документ считалось
 * уже сделанным и пропадало на весь месяц. Молча.
 */
const { iso, todayDate } = require('./period');

/** Месяц как YYYY-MM. Правило «раз в месяц» проверяется именно по нему:
 *  считать дни от прошлого запуска — верный способ ошибиться на границе. */
const monthKey = (date = todayDate()) => iso(date).slice(0, 7);

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
function dueDate(rec, date = todayDate()) {
  if (!rec.pay_day) return '';
  return `${monthKey(date)}-${String(rec.pay_day).padStart(2, '0')}`;
}

/**
 * Пора ли предлагать.
 *
 * Условие «не раньше дня X», а не «ровно в день X»: если бот был выключен
 * пятого числа, предложение должно прийти шестого, а не пропасть на месяц.
 */
function isDue(rec, date = todayDate()) {
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
function isOverdue(rec, date = todayDate()) {
  if (!rec.active || !rec.pay_day) return false;
  if (rec.last_due === monthKey(date)) return false;
  return date.getDate() > rec.pay_day;
}

/**
 * Прошёл ли уже в этом месяце день, на который заводят напоминание.
 *
 * Нужно, чтобы решить, ждать ли первого напоминания в этом месяце или в
 * следующем. Сравнение нестрогое: если правило заводят прямо в свой день,
 * напоминать через минуту о том, что человек сейчас настраивает, незачем.
 */
function dayPassed(day, date = todayDate()) {
  const d = normalizeDay(day);
  return d === LAST_DAY ? isLastDayOfMonth(date) : date.getDate() >= d;
}

/**
 * Завести повторение.
 *
 * offeredThisMonth — считать ли текущий месяц отработанным. По умолчанию да:
 * повторение обычно заводят следом за только что выписанным документом, и
 * предлагать его второй раз в том же месяце — то самое задвоение, от
 * которого мы бережём.
 *
 * Но есть и другой путь — напоминание заводят «с нуля», ничего не выписав
 * (кнопка после выбора вида деятельности). Там отметка задним числом
 * означала бы, что бот пообещал напомнить 24-го и промолчал до следующего
 * месяца. Такой вызов передаёт сюда результат dayPassed().
 */
function add(userId, {
  cpId, type, items, extra = {}, note = '', day = 1, payDay = 0, leadDays = 0,
  offeredThisMonth = true,
}) {
  const pay = payDay ? normalizeDay(payDay) : 0;
  const info = db.prepare(`INSERT INTO recurring(user_id, cp_id, type, day, pay_day, lead_days,
      items, extra, note, active, last_offer, created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`)
    .run(userId, Number(cpId), String(type), normalizeDay(day),
      pay, pay ? Math.min(27, Math.max(0, Math.round(Number(leadDays) || 0))) : 0,
      JSON.stringify(Array.isArray(items) ? items : []),
      JSON.stringify(extra && typeof extra === 'object' ? extra : {}),
      String(note).slice(0, 200), offeredThisMonth ? monthKey() : '', new Date().toISOString());
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
  if (isOp(rec)) {
    const e = rec.extra;
    rec.op = {
      kind: e.opKind === 'Приход' ? 'Приход' : 'Оплата',
      amount: Math.round((Number(e.amount) || 0) * 100) / 100,
      note: String(e.note || ''),
      times: Math.max(0, Math.round(Number(e.times) || 0)),   // 0 — без конца
      done: Math.max(0, Math.round(Number(e.done) || 0)),
      mailSelf: Boolean(e.mailSelf),
    };
    rec.op.left = rec.op.times ? Math.max(0, rec.op.times - rec.op.done) : 0;
  }
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

/**
 * Отметить, что операция по правилу проведена.
 *
 * Счётчик и месяц двигаем одной записью: если отметить месяц, а счётчик
 * забыть, правило будет вносить строку вечно; если наоборот — внесёт её
 * дважды в один месяц при перезапуске обхода.
 *
 * Дойдя до конца, правило выключается само. Пять частей долга — это пять
 * раз; шестая строка списала бы то, чего уже нет.
 *
 * @param {number} step +1 при проведении, −1 при отмене
 * @returns {{done:number, left:number, finished:boolean}|null}
 */
function bumpOp(userId, id, step = 1, date = todayDate()) {
  const rec = get(userId, id);
  if (!isOp(rec)) return null;
  const done = Math.max(0, rec.op.done + step);
  const extra = { ...rec.extra, done };
  const finished = rec.op.times > 0 && done >= rec.op.times;
  db.prepare('UPDATE recurring SET extra = ?, last_offer = ?, active = ? WHERE id = ? AND user_id = ?')
    .run(JSON.stringify(extra), step > 0 ? monthKey(date) : '', finished ? 0 : 1, Number(id), userId);
  return { done, left: rec.op.times ? Math.max(0, rec.op.times - done) : 0, finished };
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
function due(date = todayDate()) {
  return db.prepare(`SELECT r.*, c.name AS cp_name FROM recurring r
      JOIN counterparties c ON c.id = r.cp_id
      WHERE r.active = 1 ORDER BY r.user_id, r.day`)
    .all().map(parse).filter((r) => isDue(r, date));
}

/**
 * Отметить, что за этот месяц предложение отправлено.
 *
 * Владельца проверяем, как и во всех остальных действиях над повторением:
 * эту отметку ставит и кнопка «Пропустить» из чата, а номер правила в ней
 * виден любому. Без проверки посторонний мог отключить чужое напоминание
 * на месяц — и человек не выставил бы счёт за аренду, не поняв почему.
 */
function markOffered(userId, id, date = todayDate()) {
  db.prepare('UPDATE recurring SET last_offer = ? WHERE id = ? AND user_id = ?')
    .run(monthKey(date), Number(id), userId);
}

/**
 * У кого сегодня первый день просрочки.
 *
 * Возвращает только тех, у кого задан срок оплаты и он прошёл. Оплачен ли
 * счёт, здесь не проверяется: журнал документов лежит в другом модуле, и
 * тянуть его сюда значило бы связать расписание с учётом. Вызывающий
 * отсеивает оплаченных сам.
 */
function overdue(date = todayDate()) {
  return db.prepare(`SELECT r.*, c.name AS cp_name FROM recurring r
      JOIN counterparties c ON c.id = r.cp_id
      WHERE r.active = 1 AND r.pay_day > 0 ORDER BY r.user_id, r.pay_day`)
    .all().map(parse).filter((r) => isOverdue(r, date));
}

/** Отметить, что о просрочке за этот месяц уже сообщили. */
function markDueNoticed(id, date = todayDate()) {
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
  isDue, isOverdue, offerDay, dueDate, dayPassed,
  OP_TYPE, isOp, bumpOp,
  monthKey, normalizeDay, dayLabel, LAST_DAY,
};
