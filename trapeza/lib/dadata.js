'use strict';

/**
 * Заполнение реквизитов по ИНН и БИК — чтобы не набирать их руками.
 *
 * Для российского бизнеса всё это лежит в открытых реестрах: по ИНН —
 * название, КПП, адрес, руководитель; по БИК — банк и корреспондентский
 * счёт. Это надёжнее распознавания фото: данные из реестра, а не с бумаги.
 *
 * Источник — DaData (suggestions API). Бесплатного тарифа (10 000 запросов
 * в день) хватает с огромным запасом. Ключ кладётся в DADATA_TOKEN.
 * Без ключа справочник просто выключен, и формы работают как раньше — руками.
 *
 * Внутри Node запрос к DaData не проверить (нет сети из среды сборки),
 * поэтому провайдер подключаемый: DADATA_TOKEN — боевой, mock — для прогонов.
 */

const PARTY_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const BANK_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/bank';

const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

function dadataAvailable() {
  return Boolean(process.env.DADATA_TOKEN) || process.env.DADATA_MOCK != null;
}

/** ИНН: 10 цифр у организации, 12 у ИП/физлица. */
function validInn(inn) {
  const d = digits(inn);
  return d.length === 10 || d.length === 12;
}
function validBik(bik) {
  return digits(bik).length === 9;
}

async function query(url, value) {
  // Мок для прогонов: возвращает заранее подготовленный ответ по значению.
  if (process.env.DADATA_MOCK != null) {
    let map = {};
    try { map = JSON.parse(process.env.DADATA_MOCK || '{}'); } catch (_) { map = {}; }
    const hit = map[digits(value)];
    return hit ? { suggestions: [{ data: hit }] } : { suggestions: [] };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Token ${process.env.DADATA_TOKEN}`,
    },
    body: JSON.stringify({ query: digits(value), count: 1 }),
  });
  if (!res.ok) throw new Error(`DaData ${res.status}`);
  return res.json();
}

/** Достаёт из ответа DaData реквизиты организации/ИП. */
function mapParty(data) {
  if (!data) return null;
  const name = data.name || {};
  const isIp = (data.type === 'INDIVIDUAL') || /^ИП|индивидуальн/i.test(name.full_with_opf || '');
  // подписант: у ООО — директор, у ИП — сам предприниматель
  let signer = '';
  const fio = (data.management && data.management.name)
    || (data.fio && [data.fio.surname, data.fio.name, data.fio.patronymic].filter(Boolean).join(' '));
  if (fio) {
    const parts = String(fio).trim().split(/\s+/);
    // «Иванов Иван Иванович» → «И. И. Иванов»
    signer = parts.length >= 3
      ? `${parts[1][0]}. ${parts[2][0]}. ${parts[0]}`
      : fio;
  }
  return {
    name: name.short_with_opf || name.short || name.full_with_opf || '',
    full_name: name.full_with_opf || name.full || name.short_with_opf || '',
    inn: data.inn || '',
    kpp: data.kpp || '',
    address: (data.address && (data.address.unrestricted_value || data.address.value)) || '',
    signer,
    isIp,
    status: (data.state && data.state.status) || '', // ACTIVE / LIQUIDATED …
  };
}

function mapBank(data) {
  if (!data) return null;
  const name = data.name || {};
  return {
    bank_name: name.payment || name.short || name.full || '',
    corr_acc: data.correspondent_account || '',
    bik: data.bic || '',
    swift: data.swift || '',
  };
}

/**
 * @returns {Promise<{ok:boolean, fields?:object, warn?:string, error?:string}>}
 */
async function partyByInn(inn) {
  if (!dadataAvailable()) return { ok: false, error: 'справочник не подключён' };
  if (!validInn(inn)) return { ok: false, error: 'ИНН должен быть из 10 или 12 цифр' };
  try {
    const r = await query(PARTY_URL, inn);
    const data = (r.suggestions && r.suggestions[0] && r.suggestions[0].data) || null;
    const fields = mapParty(data);
    if (!fields || !fields.name) return { ok: false, error: 'по этому ИНН ничего не нашлось' };
    const warn = fields.status && fields.status !== 'ACTIVE'
      ? 'по реестру организация не действует — проверьте ИНН' : '';
    return { ok: true, fields, warn };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function bankByBik(bik) {
  if (!dadataAvailable()) return { ok: false, error: 'справочник не подключён' };
  if (!validBik(bik)) return { ok: false, error: 'БИК должен быть из 9 цифр' };
  try {
    const r = await query(BANK_URL, bik);
    const data = (r.suggestions && r.suggestions[0] && r.suggestions[0].data) || null;
    const fields = mapBank(data);
    if (!fields || !fields.bank_name) return { ok: false, error: 'банк по БИК не найден' };
    return { ok: true, fields };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  dadataAvailable, validInn, validBik, partyByInn, bankByBik, mapParty, mapBank,
};
