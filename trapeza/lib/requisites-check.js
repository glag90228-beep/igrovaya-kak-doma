'use strict';

/**
 * Проверка банковских и налоговых реквизитов по контрольным суммам.
 *
 * Зачем это в продукте, где всё и так «просто печатает документ»: опечатка в
 * реквизитах — самая дорогая ошибка в счёте. Одна переставленная цифра в
 * расчётном счёте, и платёж уходит в никуда: банк его не проведёт, деньги
 * зависнут на неделю, а виноват будет тот, кто выставил счёт. Ошибка в ИНН
 * делает документ негодным для учёта у контрагента — его бухгалтер вернёт
 * бумагу и попросит переделать.
 *
 * Хорошая новость: и ИНН, и расчётный счёт содержат контрольные разряды.
 * Случайная опечатка ловится арифметикой, без всяких справочников и сети.
 * Это ровно та проверка, которую можно сделать в момент ввода — и не дать
 * человеку выписать счёт, по которому нельзя заплатить.
 *
 * Проверяем только то, что человек заполнил: пустое поле — не ошибка,
 * у иностранного контрагента ИНН может не быть вовсе.
 */

const digitsOnly = (s) => String(s == null ? '' : s).replace(/\D/g, '');

/** Взвешенная сумма по остатку от деления на 11 — как в приказе ФНС. */
function innCheckDigit(digits, weights) {
  const sum = weights.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  return (sum % 11) % 10;
}

/**
 * ИНН: 10 знаков у организации, 12 у предпринимателя и физлица.
 * @returns {{ok:boolean, error?:string}}
 */
function checkInn(value) {
  const d = digitsOnly(value);
  if (!d) return { ok: true };
  if (d.length !== 10 && d.length !== 12) {
    return { ok: false, error: `В ИНН должно быть 10 цифр (организация) или 12 (ИП), а здесь ${d.length}.` };
  }
  if (d.length === 10) {
    const c = innCheckDigit(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]);
    if (c !== Number(d[9])) return { ok: false, error: 'ИНН не сходится по контрольной цифре — проверьте, нет ли опечатки.' };
    return { ok: true };
  }
  const c1 = innCheckDigit(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  const c2 = innCheckDigit(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  if (c1 !== Number(d[10]) || c2 !== Number(d[11])) {
    return { ok: false, error: 'ИНН не сходится по контрольным цифрам — проверьте, нет ли опечатки.' };
  }
  return { ok: true };
}

/** КПП: девять знаков, где пятый и шестой могут быть буквами. */
function checkKpp(value) {
  const v = String(value || '').trim().toUpperCase();
  if (!v) return { ok: true };
  if (!/^\d{4}[\dA-Z]{2}\d{3}$/.test(v)) {
    return { ok: false, error: 'КПП — это девять знаков, например 771501001.' };
  }
  return { ok: true };
}

/** БИК: девять цифр, российские начинаются с 04. */
function checkBik(value) {
  const d = digitsOnly(value);
  if (!d) return { ok: true };
  if (d.length !== 9) return { ok: false, error: `В БИК девять цифр, а здесь ${d.length}.` };
  if (!/^04/.test(d)) return { ok: false, error: 'Российский БИК начинается с 04 — проверьте номер.' };
  return { ok: true };
}

/**
 * Расчётный или корреспондентский счёт — 20 цифр с контрольным разрядом.
 *
 * Считается вместе с банком: для расчётного счёта берутся последние три
 * цифры БИК, для корреспондентского — «0» и 5-6 знаки БИК. Именно поэтому
 * счёт нельзя проверить в отрыве от банка, и именно поэтому проверка ловит
 * подстановку счёта из другого банка — частую ошибку при копировании.
 *
 * @param {string} value счёт
 * @param {string} bik   БИК банка
 * @param {boolean} corr это корреспондентский счёт
 */
function checkAccount(value, bik, corr = false) {
  const acc = digitsOnly(value);
  const b = digitsOnly(bik);
  if (!acc) return { ok: true };
  if (acc.length !== 20) return { ok: false, error: `В номере счёта 20 цифр, а здесь ${acc.length}.` };
  if (b.length !== 9) return { ok: true };          // без БИК проверить нечем

  const prefix = corr ? `0${b.slice(4, 6)}` : b.slice(6, 9);
  const full = prefix + acc;
  const weights = [7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = weights.reduce((s, w, i) => s + ((w * Number(full[i])) % 10), 0);
  if (sum % 10 !== 0) {
    return {
      ok: false,
      error: corr
        ? 'Корр. счёт не сходится с БИК — проверьте обе цифры.'
        : 'Расчётный счёт не сходится с БИК. Обычно это переставленные цифры — платёж по такому счёту не пройдёт.',
    };
  }
  return { ok: true };
}

/**
 * Разом по всем реквизитам организации или контрагента.
 * @returns {Array<{field:string, error:string}>} пустой массив — всё сходится
 */
function checkRequisites(f = {}) {
  const out = [];
  const add = (field, r) => { if (!r.ok) out.push({ field, error: r.error }); };
  add('inn', checkInn(f.inn));
  add('kpp', checkKpp(f.kpp));
  add('bik', checkBik(f.bik));
  add('acc', checkAccount(f.acc, f.bik, false));
  add('corr_acc', checkAccount(f.corr_acc, f.bik, true));
  return out;
}

module.exports = { checkInn, checkKpp, checkBik, checkAccount, checkRequisites, digitsOnly };
