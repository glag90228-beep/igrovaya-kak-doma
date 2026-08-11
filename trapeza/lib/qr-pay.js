'use strict';

/**
 * Платёжный QR по ГОСТ Р 56042 — тот самый, который читают камеры банковских
 * приложений. Клиент наводит телефон на счёт и платит, не перенося руками
 * двадцатизначный расчётный счёт.
 *
 * Строка выглядит так:
 *   ST00012|Name=ИП Сарычева М. В.|PersonalAcc=40802…|BankName=ПАО Сбербанк|
 *   BIC=049401601|CorrespAcc=30101…|PayeeINN=…|Sum=2470000|Purpose=…
 *
 * «ST0001» — идентификатор формата, последняя цифра — кодировка: 1 = win-1251,
 * 2 = UTF-8, 3 = KOI8-R. Берём UTF-8. Sum — в копейках целым числом.
 */

const { encodeQr, qrSvg } = require('./qr');

const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

/** Поля, без которых банк строку не примет. */
const REQUIRED = ['Name', 'PersonalAcc', 'BankName', 'BIC', 'CorrespAcc'];

/**
 * Причины, по которым QR ставить нельзя. Пустой массив — можно.
 * Лучше не нарисовать код, чем нарисовать нерабочий: клиент один раз
 * получит ошибку в банке и больше сканировать не станет.
 */
function payProblems({ org }) {
  const out = [];
  if (!org.name && !org.full_name) out.push('нет названия организации');
  if (digits(org.acc).length !== 20) out.push('расчётный счёт должен быть из 20 цифр');
  if (!org.bank_name) out.push('не указан банк');
  if (digits(org.bik).length !== 9) out.push('БИК должен быть из 9 цифр');
  if (digits(org.corr_acc).length !== 20) out.push('корр. счёт должен быть из 20 цифр');
  const inn = digits(org.inn);
  if (inn && inn.length !== 10 && inn.length !== 12) out.push('ИНН должен быть из 10 или 12 цифр');
  return out;
}

/** Значение поля: убираем то, что сломает разбор строки. */
const val = (s) => String(s == null ? '' : s).replace(/[|\r\n]+/g, ' ').trim();

/**
 * Собирает строку платежа.
 * @param {object} a.org   получатель (наша организация)
 * @param {number} a.sum   сумма в рублях; 0/пусто — клиент введёт сам
 * @param {string} a.purpose назначение платежа
 */
function payString({ org, sum, purpose, payer }) {
  const fields = {
    Name: val(org.full_name || org.name),
    PersonalAcc: digits(org.acc),
    BankName: val(org.bank_name),
    BIC: digits(org.bik),
    CorrespAcc: digits(org.corr_acc),
  };
  for (const k of REQUIRED) {
    if (!fields[k]) throw new Error(`Для платёжного QR не хватает поля ${k}`);
  }
  const extra = {
    PayeeINN: digits(org.inn),
    KPP: digits(org.kpp),
    Sum: Number(sum) > 0 ? String(Math.round(Number(sum) * 100)) : '',
    Purpose: val(purpose),
    PayerName: val(payer),
  };
  const parts = ['ST00012'];
  for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${v}`);
  for (const [k, v] of Object.entries(extra)) if (v) parts.push(`${k}=${v}`);
  return parts.join('|');
}

/**
 * Готовый SVG платёжного кода или null, если реквизитов не хватает.
 * Уровень коррекции M: на печати код переживает смазанный тонер,
 * а строка платежа в 300 байт в него влезает с запасом.
 */
function payQrSvg(args, opts = {}) {
  if (payProblems(args).length) return null;
  const text = payString(args);
  return qrSvg(encodeQr(text, { ecc: opts.ecc || 'M' }), { size: opts.size || 190 });
}

module.exports = { payString, payQrSvg, payProblems };
