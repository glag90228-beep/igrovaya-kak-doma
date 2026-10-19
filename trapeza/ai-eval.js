'use strict';

/**
 * Замер точности разбора свободного ввода.
 *
 *   node ai-eval.js                  только правила, без сети (работает где угодно)
 *   node ai-eval.js --ai             правила, а что не разобрали — модель, как в бою
 *   node ai-eval.js --model          только модель (чтобы сравнить с правилами)
 *   node ai-eval.js --misses 80      показать больше промахов (по умолчанию 40; --all — все)
 *   node ai-eval.js --intent pay     только фразы с таким ожидаемым намерением
 *   node ai-eval.js --tag числа-словами   только фразы с такой меткой
 *   node ai-eval.js --holdout [1|2]  только «отложенные» фразы (написаны после правил, на них честно)
 *   node ai-eval.js --tuned          только фразы, на которых правила настраивались
 *   node ai-eval.js --json           итог одним JSON — для сравнения «до/после»
 *
 * Зачем он нужен. Разбор фразы — единственное место, где ошибка превращается
 * не в «не понял», а в неверный документ: сумма, клиент, вид бумаги. Пока
 * точность никто не мерил, любая правка регулярки была ставкой вслепую: чинишь
 * «Заре», ломаешь «Три медведя», и узнаёшь об этом от клиента. Набор фраз —
 * ai-phrases.json — это память о таких случаях.
 *
 * Что считается ошибкой, а что — «опасной ошибкой». Не угадал и спросил
 * (пустая сумма, пустой клиент, несколько вариантов клиента) — это промах, но
 * безвредный: человек увидит вопрос. Угадал неверно и пошёл дальше — это
 * опасно, потому что у включённого ассистента такая фраза заканчивается готовым
 * файлом с номером в сквозном ряду. Поэтому опасные ошибки считаются
 * отдельно и порог для них жёстче, чем для общей точности.
 *
 * Запуск с моделью (на сервере, где лежит ключ):
 *
 *   cd /opt/trapeza && node ai-eval.js --ai
 *
 * Ключи читаются из .env рядом со скриптом, в чат и в код они не попадают.
 * База для замера временная: боевую он не открывает. Ответы модели стоят
 * доли копейки за фразу, на весь набор — порядка рубля.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PHRASES_FILE = path.join(__dirname, 'ai-phrases.json');

/**
 * Пороги для прогона «только правила». Их проверяет bot-selftest: правка
 * регулярки, роняющая точность ниже, не пройдёт `npm test`.
 *
 * Выставлены чуть ниже достигнутого — запас на мелкие правки набора, а не на
 * ухудшение разбора. Подняли точность — поднимите и пороги: иначе они
 * перестанут что-либо охранять.
 */
const FLOOR = {
  intent: 0,      // доля верных намерений среди ожидаемых «wired»
  full: 0,        // доля фраз, разобранных безупречно
  sum: 0,         // сумма документа/оплаты верна, когда она ожидалась
  client: 0,      // клиент определён верно (или честно переспрошен)
  dangerMax: 999, // сколько опасных ошибок допустимо
};

// ---------- сравнение полей ----------

const NAME_END = /[аеиоуыэюяйь]+$/;
const key3 = (w) => {
  const x = String(w || '').toLowerCase().replace(/ё/g, 'е');
  const s = x.replace(NAME_END, '') || x;
  return s.slice(0, 3);
};
const words = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Названия позиций совпали: слово в слово по первым трём буквам корня. */
function sameName(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (wa.length !== wb.length) return false;
  return wa.every((w, i) => (w.length <= 3 || wb[i].length <= 3 ? w === wb[i] : key3(w) === key3(wb[i])));
}

const eqNum = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const sumOf = (items) => Math.round((items || []).reduce(
  (s, it) => s + (Number(it.q != null ? it.q : it.qty) || 0) * (Number(it.p != null ? it.p : it.price) || 0), 0) * 100) / 100;

/** Что бот сделает с названным клиентом: тот же путь, что в handleFreeText. */
function resolveClient(ai, cps, who) {
  if (!who) return { kind: 'none' };
  const m = ai.matchCp(cps, who);
  if (m.cp) return { kind: 'one', name: m.cp.name };
  if (m.choices) return { kind: 'choices', names: m.choices.map((c) => c.name) };
  return { kind: 'new', who };
}

function clientOk(exp, r) {
  if (exp === null) return r.kind === 'none';
  if (typeof exp === 'string') return r.kind === 'one' && r.name === exp;
  if (exp.choices) {
    return r.kind === 'choices' && r.names.length === exp.choices.length
      && exp.choices.every((n) => r.names.includes(n));
  }
  if (exp.new) return r.kind === 'new' && words(r.who).map(key3).join(' ') === words(exp.new).map(key3).join(' ');
  return false;
}

const fmtClient = (r) => (!r ? '—' : r.kind === 'none' ? 'не назван'
  : r.kind === 'one' ? r.name : r.kind === 'choices' ? `вопрос: ${r.names.join(' / ')}` : `новый: ${r.who}`);
const fmtExpClient = (c) => (c === null ? 'не назван' : typeof c === 'string' ? c
  : c.choices ? `вопрос: ${c.choices.join(' / ')}` : `новый: ${c.new}`);
const fmtItems = (items, exp) => (items || []).map((it) => {
  const n = exp ? it.n : it.name;
  const q = exp ? it.q : it.qty;
  const p = exp ? it.p : it.price;
  return `${n}×${q}@${p}${it.unit || it.u ? ` ${it.unit || it.u}` : ''}`;
}).join('; ') || '—';

// ---------- оценка одной фразы ----------

/**
 * @returns {{checks:Object, danger:string[], pred:string, intentOk:boolean, full:boolean, text:string}}
 */
function scorePhrase(ai, cps, exp, got) {
  const g = got || { action: 'unknown' };
  const pred = g.action || 'unknown';
  const intentOk = pred === exp.i;
  const checks = {};
  const danger = [];
  const add = (name, ok, e, v) => { checks[name] = { ok: Boolean(ok), exp: e, got: v }; };

  const hasCl = Object.prototype.hasOwnProperty.call(exp, 'c');
  const hasDoc = exp.doc !== undefined;
  let res = { kind: 'none' };
  if (g.who) res = resolveClient(ai, cps, g.who);

  if (hasCl) {
    const ok = intentOk && clientOk(exp.c, res);
    add('client', ok, fmtExpClient(exp.c), fmtClient(res));
    // Неверный клиент опасен только тогда, когда бот пойдёт дальше сам: выбрал
    // одного, хотя ожидался другой/вопрос/новый.
    if (intentOk && !ok && res.kind === 'one' && (exp.i === 'draft' || exp.i === 'pay')) danger.push('client');
  }
  if (hasDoc) {
    const ok = intentOk && g.docType === exp.doc;
    add('doc', ok, exp.doc, g.docType || '—');
    if (!ok && pred === 'draft' && g.docType && exp.i === 'draft') danger.push('doctype');
  }
  if (exp.items !== undefined) {
    const gi = (g.items || []).map((x) => ({ name: x.name, qty: x.qty, price: x.price, unit: x.unit }));
    const sameLen = intentOk && gi.length === exp.items.length;
    add('items.count', sameLen, exp.items.length, gi.length);
    // Позиции сравниваем поэлементно, а в зачёт идёт каждая ожидаемая.
    exp.items.forEach((e, i) => {
      const x = sameLen ? gi[i] : null;
      add(`items.name#${i}`, x && sameName(e.n, x.name), e.n, x ? x.name : '—');
      add(`items.qty#${i}`, x && eqNum(e.q, x.qty), e.q, x ? x.qty : '—');
      add(`items.price#${i}`, x && eqNum(e.p, x.price), e.p, x ? x.price : '—');
      if (e.u) add(`items.unit#${i}`, x && String(x.unit || '').replace(/\.$/, '') === e.u, e.u, x ? x.unit : '—');
    });
    const es = sumOf(exp.items);
    const gs = sumOf(gi);
    const okSum = intentOk && eqNum(es, gs);
    add('sum', okSum, es, gs);
    if (pred === 'draft' && gs > 0 && !eqNum(es, gs)) danger.push('sum');
  }
  if (exp.amount !== undefined) {
    const ga = Number(g.amount) || 0;
    const ok = intentOk && (exp.amount === null ? ga === 0 : eqNum(exp.amount, ga));
    add('sum', ok, exp.amount, ga);
    if (pred === 'pay' && ga > 0 && !(exp.amount !== null && eqNum(exp.amount, ga))) danger.push('sum');
  }
  if (exp.kind !== undefined) add('kind', intentOk && g.kind === exp.kind, exp.kind, g.kind || '—');
  if (exp.prepay !== undefined) add('prepay', intentOk && Boolean(g.prepay) === exp.prepay, exp.prepay, Boolean(g.prepay));
  if (exp.vat !== undefined) {
    add('vat', intentOk && g.vatRate === exp.vat, exp.vat, g.vatRate === undefined ? '—' : g.vatRate);
  }
  if (exp.vatIncl !== undefined) add('vatIncl', intentOk && Boolean(g.priceIncludesVat) === exp.vatIncl, exp.vatIncl, Boolean(g.priceIncludesVat));
  if (exp.date !== undefined) add('date', intentOk && g.date === exp.date, exp.date, g.date || '—');
  if (exp.period !== undefined) {
    const p = g.period || {};
    add('period', intentOk && p.from === exp.period[0] && p.to === exp.period[1], exp.period.join('…'), p.from ? `${p.from}…${p.to}` : '—');
  }

  // Ложное действие: ждали справку или «не понял», а бот готов выписывать/проводить.
  if (!intentOk && (pred === 'draft' || pred === 'pay') && exp.i !== 'draft' && exp.i !== 'pay') danger.push('action');
  if (!intentOk && pred === 'draft' && exp.i === 'pay') danger.push('action');
  if (!intentOk && pred === 'pay' && exp.i === 'draft') danger.push('action');

  const full = intentOk && Object.values(checks).every((c) => c.ok);
  return { checks, danger: [...new Set(danger)], pred, intentOk, full };
}

// ---------- прогон ----------

function loadPhrases() {
  const data = JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf8'));
  return data;
}

/** Фраза уже показана модели как пример — на ней модель честно не проверить. */
const inPrompt = (ai, text) => Boolean(ai.SYSTEM && ai.SYSTEM.includes(`«${text}»`));

/**
 * @param {{mode?:'rules'|'ai'|'model', intent?:string, tag?:string, ai?:object}} opts
 */
async function evaluate(opts = {}) {
  const ai = opts.ai || require('./lib/ai-agent');
  const mode = opts.mode || 'rules';
  const data = loadPhrases();
  const cps = data.clients.map((name, i) => ({ id: i + 1, name }));
  const parseOpts = { today: data.today, clients: data.clients };

  const rows = [];
  let model = { calls: 0, in: 0, out: 0, skippedShots: 0 };
  for (const exp of data.phrases) {
    if (opts.intent && exp.i !== opts.intent) continue;
    if (opts.tag && !(exp.tags || []).includes(opts.tag)) continue;
    if (opts.holdout === true && !exp.holdout) continue;
    if (typeof opts.holdout === 'number' && Number(exp.holdout === true ? 1 : exp.holdout) !== opts.holdout) continue;
    if (opts.holdout === false && exp.holdout) continue;
    if (mode !== 'rules' && inPrompt(ai, exp.t)) { model.skippedShots += 1; continue; }
    let got = null;
    let source = 'правила';
    if (mode === 'rules') {
      got = typeof ai.parseLocal === 'function' ? ai.parseLocal(exp.t, parseOpts) : ai.quickParse(exp.t, parseOpts);
    } else if (typeof ai.analyze === 'function') {
      // eslint-disable-next-line no-await-in-loop
      const r = await ai.analyze(exp.t, { ...parseOpts, model: mode === 'model' ? 'only' : true });
      got = r.intent;
      source = r.source;
      if (r.usage) { model.calls += 1; model.in += r.usage.in || 0; model.out += r.usage.out || 0; }
    } else {
      throw new Error('В этом ai-agent.js нет analyze(): режимы --ai и --model недоступны.');
    }
    rows.push({ exp, got, source, ...scorePhrase(ai, cps, exp, got) });
  }
  return summarize(rows, mode, model);
}

function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : null; }

function summarize(rows, mode, model) {
  const wired = rows.filter((r) => r.exp.wired !== false);
  const byIntent = {};
  const predicted = {};
  for (const r of rows) {
    const k = r.exp.i;
    byIntent[k] = byIntent[k] || { n: 0, ok: 0, wired: r.exp.wired !== false };
    byIntent[k].n += 1;
    if (r.intentOk) byIntent[k].ok += 1;
    predicted[r.pred] = predicted[r.pred] || { n: 0, ok: 0 };
    predicted[r.pred].n += 1;
    if (r.intentOk) predicted[r.pred].ok += 1;
  }
  const fields = {};
  const fieldOf = (name) => name.replace(/#\d+$/, '');
  for (const r of rows) {
    for (const [name, c] of Object.entries(r.checks)) {
      const f = fieldOf(name);
      fields[f] = fields[f] || { n: 0, ok: 0 };
      fields[f].n += 1;
      if (c.ok) fields[f].ok += 1;
    }
  }
  const tags = {};
  for (const r of rows) {
    for (const t of r.exp.tags || []) {
      tags[t] = tags[t] || { n: 0, full: 0 };
      tags[t].n += 1;
      if (r.full) tags[t].full += 1;
    }
  }
  const danger = {};
  let dangerPhrases = 0;
  for (const r of rows) {
    if (r.danger.length) dangerPhrases += 1;
    for (const d of r.danger) danger[d] = (danger[d] || 0) + 1;
  }
  // Покрытие: сколько осмысленных фраз правила взяли сами, не отдав модели.
  const meaningful = rows.filter((r) => r.exp.i !== 'unknown');
  const answered = meaningful.filter((r) => r.got && r.got.action && r.got.action !== 'unknown');
  const sumField = fields.sum || { n: 0, ok: 0 };
  const clField = fields.client || { n: 0, ok: 0 };
  return {
    mode,
    n: rows.length,
    wiredN: wired.length,
    intent: pct(wired.filter((r) => r.intentOk).length, wired.length),
    intentAll: pct(rows.filter((r) => r.intentOk).length, rows.length),
    full: pct(wired.filter((r) => r.full).length, wired.length),
    sum: pct(sumField.ok, sumField.n),
    client: pct(clField.ok, clField.n),
    coverage: pct(answered.length, meaningful.length),
    dangerPhrases,
    danger,
    byIntent,
    predicted,
    fields,
    tags,
    model,
    rows,
  };
}

// ---------- печать ----------

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const fmtPct = (v) => (v == null ? '  —  ' : `${lpad(v.toFixed(1), 5)}%`);

function fmtExp(e) {
  const parts = [e.i];
  if (e.doc) parts.push(e.doc);
  if (Object.prototype.hasOwnProperty.call(e, 'c')) parts.push(fmtExpClient(e.c));
  if (e.items) parts.push(`[${fmtItems(e.items, true)}]`);
  if (e.amount !== undefined) parts.push(`сумма ${e.amount === null ? 'не названа' : e.amount}`);
  if (e.kind && e.kind !== 'Оплата') parts.push(e.kind);
  if (e.prepay) parts.push('предоплата');
  if (e.vat !== undefined) parts.push(`НДС ${e.vat === null ? 'нет' : e.vat}${e.vatIncl ? ' вкл.' : ''}`);
  if (e.date) parts.push(`дата ${e.date}`);
  if (e.period) parts.push(`период ${e.period.join('…')}`);
  return parts.join(' · ');
}

function fmtGot(ai, cps, r) {
  const g = r.got;
  if (!g) return 'правила молчат (ушло бы в модель)';
  const parts = [g.action];
  if (g.docType) parts.push(g.docType);
  if (g.who !== undefined || r.exp.c !== undefined) parts.push(g.who ? fmtClient(resolveClient(ai, cps, g.who)) : 'не назван');
  if (g.items) parts.push(`[${fmtItems(g.items, false)}]`);
  if (g.amount !== undefined) parts.push(`сумма ${g.amount || 'не названа'}`);
  if (g.kind && g.kind !== 'Оплата') parts.push(g.kind);
  if (g.prepay) parts.push('предоплата');
  if (g.vatRate !== undefined) parts.push(`НДС ${g.vatRate === null ? 'нет' : g.vatRate}${g.priceIncludesVat ? ' вкл.' : ''}`);
  if (g.date) parts.push(`дата ${g.date}`);
  if (g.period) parts.push(`период ${g.period.from}…${g.period.to}`);
  return parts.join(' · ');
}

function print(res, { misses = 40, ai } = {}) {
  const data = loadPhrases();
  const cps = data.clients.map((name, i) => ({ id: i + 1, name }));
  const label = { rules: 'только правила (без модели)', ai: 'правила, затем модель (как в бою)', model: 'только модель' }[res.mode];
  console.log(`\nЗамер разбора: ${label}`);
  console.log(`Фраз: ${res.n}, из них с готовым экраном в боте: ${res.wiredN}`);
  if (res.mode !== 'rules') {
    console.log(`Обращений к модели: ${res.model.calls}, токенов ${res.model.in}+${res.model.out}; `
      + `фраз-примеров из подсказки пропущено: ${res.model.skippedShots}`);
  }

  console.log('\nИтог');
  console.log(`  намерение верно       ${fmtPct(res.intent)}   (по фразам с экраном; по всем — ${res.intentAll}%)`);
  console.log(`  разобрано безупречно  ${fmtPct(res.full)}`);
  console.log(`  сумма верна           ${fmtPct(res.sum)}`);
  console.log(`  клиент верен          ${fmtPct(res.client)}   (вопрос «кого вы имели в виду» тоже верный ответ, если ждали его)`);
  console.log(`  правила взяли сами    ${fmtPct(res.coverage)}   (остальное ушло бы в модель)`);
  console.log(`  ОПАСНЫХ ошибок        ${res.dangerPhrases} фраз  ${JSON.stringify(res.danger)}`);

  console.log('\nПо намерениям (ждали / верно / точность; «выдано» — сколько раз выдали это намерение, из них верно)');
  const order = Object.keys(res.byIntent).sort((a, b) => res.byIntent[b].n - res.byIntent[a].n);
  for (const k of order) {
    const b = res.byIntent[k];
    const p = res.predicted[k] || { n: 0, ok: 0 };
    console.log(`  ${pad(k + (b.wired ? '' : '*'), 11)} ${lpad(b.n, 4)} ${lpad(b.ok, 4)} ${fmtPct(pct(b.ok, b.n))}   выдано ${lpad(p.n, 3)}, верно ${lpad(p.ok, 3)} ${fmtPct(pct(p.ok, p.n))}`);
  }
  console.log('  * экрана в боте пока нет: в «намерение верно» не входят');

  console.log('\nПо полям (сколько раз поле ожидалось / сколько раз верно)');
  for (const k of Object.keys(res.fields).sort()) {
    const f = res.fields[k];
    console.log(`  ${pad(k, 12)} ${lpad(f.n, 4)} ${lpad(f.ok, 4)} ${fmtPct(pct(f.ok, f.n))}`);
  }

  console.log('\nПо меткам (доля фраз, разобранных безупречно)');
  for (const k of Object.keys(res.tags).sort((a, b) => res.tags[b].n - res.tags[a].n)) {
    const t = res.tags[k];
    console.log(`  ${pad(k, 26)} ${lpad(t.n, 4)} ${fmtPct(pct(t.full, t.n))}`);
  }

  const bad = res.rows.filter((r) => !r.full);
  const shown = misses === Infinity ? bad : bad.slice(0, misses);
  // Опасные — первыми: с них и надо начинать.
  shown.sort((a, b) => b.danger.length - a.danger.length);
  console.log(`\nПромахи: ${bad.length} из ${res.n}${shown.length < bad.length ? `, показаны ${shown.length} (--misses N или --all)` : ''}`);
  for (const r of shown) {
    const mark = r.danger.length ? `ОПАСНО(${r.danger.join(',')}) ` : '';
    console.log(`\n  ${mark}«${r.exp.t}»`);
    console.log(`    ждали:  ${fmtExp(r.exp)}`);
    console.log(`    вышло:  ${fmtGot(ai, cps, r)}`);
  }
  console.log('');
}

// ---------- запуск из командной строки ----------

function readEnvFile() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      // Уже заданное окружение главнее файла: явный запуск с переменной —
      // это просьба, а не случайность.
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    }
  } catch (_) { /* .env нет — значит ключи пришли из окружения */ }
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const mode = argv.includes('--ai') ? 'ai' : argv.includes('--model') ? 'model' : 'rules';

  // Боевую базу замер не открывает: разбору она нужна только для счётчика
  // расхода, а он здесь не используется.
  process.env.TRAPEZA_DB = path.join(os.tmpdir(), `ai-eval-${process.pid}.db`);
  if (mode !== 'rules') {
    readEnvFile();
    process.env.AI_ENABLED = '1';
  }
  const ai = require('./lib/ai-agent');
  if (mode !== 'rules' && !ai.aiAvailable()) {
    console.error(`Модель недоступна: ${ai.aiHint()}\nКлюч берётся из .env рядом со скриптом или из окружения; в чат его не присылайте.`);
    process.exit(2);
  }
  const hi = argv.indexOf('--holdout');
  const holdout = hi >= 0 ? (/^\d$/.test(argv[hi + 1] || '') ? Number(argv[hi + 1]) : true) : (argv.includes('--tuned') ? false : undefined);
  const res = await evaluate({ mode, ai, intent: arg('--intent'), tag: arg('--tag'), holdout });
  if (argv.includes('--json')) {
    const { rows, ...rest } = res;
    console.log(JSON.stringify(rest, null, 1));
  } else {
    print(res, { misses: argv.includes('--all') ? Infinity : Number(arg('--misses')) || 40, ai });
  }
  for (const f of [process.env.TRAPEZA_DB, `${process.env.TRAPEZA_DB}-wal`, `${process.env.TRAPEZA_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch (_) { /* не создался */ }
  }
}

module.exports = { evaluate, scorePhrase, sameName, FLOOR, loadPhrases };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
