'use strict';

/**
 * Разовая починка: у ранних организаций/контрагентов реквизиты попали одной
 * строкой в «Наименование», а отдельные р/с, БИК и к/с остались пустыми —
 * из-за этого в счёте не было платёжного QR.
 *
 * Скрипт находит такие записи, разбирает блок из их наименования на поля
 * и дозаполняет пустое. Уже заполненные поля не трогает.
 *
 *   cd /opt/trapeza && set -a && . ./.env && set +a && node repair-org.js
 */

const { db } = require('./db');
const { parseRequisites, looksLikeBlock } = require('./lib/reqs');

const FIELDS = ['name', 'full_name', 'inn', 'kpp', 'address', 'bank_name', 'bik', 'acc', 'corr_acc'];

function repair(table) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  let fixed = 0;
  for (const r of rows) {
    // Источник — то поле, куда сгрёбся блок (обычно full_name, реже name).
    const src = [r.full_name, r.name].find((t) => looksLikeBlock(t));
    if (!src) continue;
    // Чинить есть смысл, только если банковские поля пустые.
    if (r.acc && r.bik && r.corr_acc) continue;

    const p = parseRequisites(src);
    const next = {};
    for (const k of FIELDS) {
      if (!(k in r)) continue;
      // Наименования чиним, только если в них сам блок; чистое имя не трогаем.
      // Остальное — дозаполняем пустое.
      if (k === 'name' || k === 'full_name') next[k] = looksLikeBlock(r[k]) ? (p[k] || r[k]) : r[k];
      else next[k] = r[k] || p[k] || '';
    }
    const sets = Object.keys(next).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...Object.values(next), r.id);
    fixed += 1;
    console.log(`  ${table} #${r.id}: ${next.name} — р/с ${next.acc || '—'}, БИК ${next.bik || '—'}, к/с ${next.corr_acc || '—'}`);
  }
  return fixed;
}

const a = repair('orgs');
let b = 0;
try { b = repair('counterparties'); } catch (_) { /* нет таблицы — не беда */ }

if (a + b === 0) console.log('Чинить нечего — все реквизиты уже разложены по полям.');
else console.log(`\nГотово: организаций ${a}, контрагентов ${b}. Выпишите счёт заново — QR появится.`);
