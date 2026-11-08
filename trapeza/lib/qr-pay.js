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
 * Предел строки по ГОСТ Р 56042 — 300 байт на всё вместе.
 *
 * Мы про него знали и даже написали в комментарии, что «влезает с запасом», —
 * а не мерили ни разу. Обычный случай: ООО с полным наименованием и банк с
 * полным наименованием дают 493 байта, длинное назначение — 728. Кириллица в
 * UTF-8 занимает два байта на букву, так что до предела здесь очень близко.
 */
const LIMIT = 300;
const bytes = (s) => Buffer.byteLength(s, 'utf8');

/**
 * Организационно-правовая форма словами — в общепринятое сокращение.
 *
 * Это не выдумка и не порча наименования: ООО, ПАО, АО — те самые сокращения,
 * которыми организации называют сами себя в реквизитах. Название банка при
 * этом самое длинное поле строки, а укоротить его иначе нечем: BankName по
 * ГОСТ обязателен, и выбросить его нельзя. Внутри строки, а не только в
 * начале: «Филиал «Центральный» Публичного акционерного общества «Банк»».
 */
const FORMS = [
  [/общества?\s+с\s+ограниченной\s+ответственностью/gi, 'ООО'],
  [/публичн(?:ое|ого)\s+акционерн(?:ое|ого)\s+обществ[ао]/gi, 'ПАО'],
  [/непубличн(?:ое|ого)\s+акционерн(?:ое|ого)\s+обществ[ао]/gi, 'АО'],
  [/акционерн(?:ое|ого)\s+обществ[ао]/gi, 'АО'],
  [/индивидуальн(?:ый|ого)\s+предпринимател[ья]/gi, 'ИП'],
];
const abbr = (s) => FORMS
  .reduce((acc, [re, short]) => acc.replace(re, short), String(s || ''))
  .replace(/\s{2,}/g, ' ')
  .trim();

/**
 * Собирает строку платежа.
 *
 * Когда не влезаем в 300 байт, ужимаемся по очереди — от наименее нужного
 * плательщику к наиболее:
 *
 *   1. PayerName — кто платит, плательщик и так знает; в счёте он написан.
 *   2. KPP — платёж проходит по счёту и БИК, КПП его не определяет.
 *   3. Полное наименование получателя меняем на короткое. Для платежа оно
 *      ничего не решает: счёт и БИК определяют получателя однозначно, —
 *      а занимает больше всех.
 *   4. Организационно-правовую форму в наименованиях пишем сокращением:
 *      «Публичного акционерного общества» → «ПАО». Название банка иначе не
 *      укоротить — BankName по ГОСТ обязателен.
 *
 * Назначение НЕ режем ни при каких обстоятельствах. Обрезанное «Оплата по
 * счёту № 148 от 03.09.20» — это платёж, который получатель не разнесёт по
 * своим счетам, то есть ровно та работа, ради избавления от которой всё и
 * затевалось. Если после всех сокращений строка всё равно длиннее предела,
 * код рисуем: банковские приложения читают и такие, а платёж без QR клиент
 * будет набивать руками — двадцать цифр счёта, и одна не та.
 *
 * @param {object} a.org   получатель (наша организация)
 * @param {number} a.sum   сумма в рублях; 0/пусто — клиент введёт сам
 * @param {string} a.purpose назначение платежа
 */
function payString({ org, sum, purpose, payer }) {
  const build = ({ shortNames, withKpp, withPayer, abbrForms }) => {
    const short = (s) => (abbrForms ? abbr(s) : s);
    const fields = {
      Name: val(short(shortNames ? (org.name || org.full_name) : (org.full_name || org.name))),
      PersonalAcc: digits(org.acc),
      BankName: val(short(org.bank_name)),
      BIC: digits(org.bik),
      CorrespAcc: digits(org.corr_acc),
    };
    for (const k of REQUIRED) {
      if (!fields[k]) throw new Error(`Для платёжного QR не хватает поля ${k}`);
    }
    const extra = {
      PayeeINN: digits(org.inn),
      KPP: withKpp ? digits(org.kpp) : '',
      Sum: Number(sum) > 0 ? String(Math.round(Number(sum) * 100)) : '',
      Purpose: val(purpose),
      PayerName: withPayer ? val(payer) : '',
    };
    const parts = ['ST00012'];
    for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${v}`);
    for (const [k, v] of Object.entries(extra)) if (v) parts.push(`${k}=${v}`);
    return parts.join('|');
  };

  const ladder = [
    { shortNames: false, withKpp: true, withPayer: true },
    { shortNames: false, withKpp: true, withPayer: false },
    { shortNames: false, withKpp: false, withPayer: false },
    { shortNames: true, withKpp: false, withPayer: false },
    { shortNames: true, withKpp: false, withPayer: false, abbrForms: true },
  ];
  let last = '';
  for (const step of ladder) {
    last = build(step);
    if (bytes(last) <= LIMIT) return last;
  }
  return last;
}

/**
 * Готовый SVG платёжного кода или null, если реквизитов не хватает.
 * Уровень коррекции M: на печати код переживает смазанный тонер.
 */
function payQrSvg(args, opts = {}) {
  if (payProblems(args).length) return null;
  const text = payString(args);
  return qrSvg(encodeQr(text, { ecc: opts.ecc || 'M' }), { size: opts.size || 190 });
}

module.exports = { payString, payQrSvg, payProblems };
