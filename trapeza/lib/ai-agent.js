'use strict';

/**
 * Свободный ввод: «кто должен», «выставь счёт Заре на 30 тысяч за аренду».
 *
 * Что здесь есть и чего здесь нет
 * ------------------------------
 * Модуль превращает фразу в намерение. Он **никогда ничего не выписывает
 * сам**: самое большее — открывает обычный мастер с заполненными полями,
 * дальше человек нажимает ту же кнопку, что и всегда.
 *
 * Так сделано не из осторожности вообще, а по конкретной причине: документ
 * забирает номер в сквозном ряду. Лишний счёт нельзя тихо удалить — в
 * нумерации останется дыра, и объяснять её придётся при проверке. Модель,
 * которая ошиблась контрагентом или суммой, стоит дороже, чем сэкономленное
 * нажатие. По той же причине контрагент ищется точным совпадением: «Заря»
 * не должна молча превратиться в «Заря-Строй».
 *
 * Деньги
 * ------
 * Вызовы модели платные, и платит владелец бота, а не пользователь. Поэтому:
 *
 *   AI_ENABLED=1        — без этого модуль выключен, даже если ключ есть.
 *                         Ключ в .env часто лежит ради распознавания счетов;
 *                         он не должен сам по себе включать расходы.
 *   AI_MONTHLY_LIMIT    — предел обращений к модели в месяц на всех
 *                         (по умолчанию 1000). Кончился — бот честно
 *                         говорит, что понимает только команды.
 *   AI_USER_LIMIT       — предел на одного пользователя в месяц (30):
 *                         один человек не должен съесть общий лимит.
 *
 * Сначала фраза разбирается локально, регулярками, — это бесплатно и
 * мгновенно, и покрывает большую часть обращений. К модели идём, только
 * если местный разбор не справился.
 */

const { db } = require('../db');

const MODEL_DEFAULT = 'claude-haiku-4-5-20251001';   // разбор фразы — простая задача
const LIMIT_ALL = () => Number(process.env.AI_MONTHLY_LIMIT || 1000);
const LIMIT_USER = () => Number(process.env.AI_USER_LIMIT || 30);

const PROVIDER = () => String(process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const enabled = () => process.env.AI_ENABLED === '1';

/** Готов ли модуль обращаться к модели. */
function aiAvailable() {
  if (!enabled()) return false;
  const p = PROVIDER();
  if (p === 'mock') return true;                      // для прогонов, без сети
  if (p === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (p === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  return false;
}

function aiHint() {
  if (!enabled()) return 'Свободный ввод выключен (AI_ENABLED не равен 1).';
  const p = PROVIDER();
  if (p === 'anthropic') return 'Нет ключа ANTHROPIC_API_KEY.';
  if (p === 'openai') return 'Нет ключа OPENAI_API_KEY.';
  return `Неизвестный провайдер: ${p}.`;
}

// ---------- расход ----------

const monthKey = () => new Date().toISOString().slice(0, 7);

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      month   TEXT    NOT NULL,
      user_id INTEGER NOT NULL,          -- 0 — общий счётчик за месяц
      calls   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (month, user_id)
    );
  `);
}
migrate();

const callsOf = (userId) => {
  const row = db.prepare('SELECT calls FROM ai_usage WHERE month = ? AND user_id = ?')
    .get(monthKey(), userId);
  return row ? row.calls : 0;
};

/** Сколько обращений осталось: общий предел и личный. */
function budget(userId) {
  const all = callsOf(0);
  const mine = callsOf(userId);
  return {
    all, mine,
    limitAll: LIMIT_ALL(),
    limitUser: LIMIT_USER(),
    left: Math.max(0, Math.min(LIMIT_ALL() - all, LIMIT_USER() - mine)),
  };
}

/**
 * Занять одно обращение.
 *
 * Счётчик увеличивается до вызова модели, а не после: неудачный запрос всё
 * равно оплачен, и считать только успешные — способ незаметно выйти за
 * предел в несколько раз при сетевых сбоях.
 */
function spend(userId) {
  const bump = db.prepare(`INSERT INTO ai_usage(month, user_id, calls) VALUES(?,?,1)
      ON CONFLICT(month, user_id) DO UPDATE SET calls = calls + 1`);
  bump.run(monthKey(), 0);
  bump.run(monthKey(), userId);
}

// ---------- местный разбор, без модели ----------

const CANCEL = /^(отмена|стоп|хватит)$/i;

const DOC_WORDS = {
  'счёт': 'sch', 'счет': 'sch', 'акт': 'usl', 'упд': 'upd',
  'накладную': 'torg12', 'накладная': 'torg12',
};

const QUICK = [
  { re: /^(?:кто\s+(?:мне\s+)?должен|долги|задолженност|дебиторк|сальдо)/i, intent: () => ({ action: 'debts' }) },
  { re: /^(?:что\s+умеешь|помощь|команды|help)$/i, intent: () => ({ action: 'help' }) },
  { re: /^(?:не\s*оплачен|кто\s+не\s+заплатил|ждут\s+оплаты)/i, intent: () => ({ action: 'unpaid' }) },
  {
    // «выставь счёт Заре», «оформи акт для ООО Ромашка».
    // Окончание глагола — [а-яё], а не \w: \w в JavaScript кириллицу не
    // видит, и «выставь» по нему не дочитывается.
    re: /^(?:выстав|выпиш|созда|оформ)[а-яё]*\s+(счёт|счет|акт|упд|накладную|накладная)\s*(?:для\s+|на\s+имя\s+)?(.*)$/i,
    intent: (m) => ({ action: 'draft', docType: DOC_WORDS[m[1].toLowerCase()], who: m[2].trim() }),
  },
];

function quickParse(text) {
  const t = String(text || '').trim();
  if (!t || CANCEL.test(t)) return null;
  for (const q of QUICK) {
    const m = q.re.exec(t);
    if (m) return q.intent(m);
  }
  return null;
}

/**
 * Найти контрагента по имени из фразы.
 *
 * Точное совпадение сильнее частичного, а несколько частичных — это
 * неопределённость, а не повод выбрать первого: выписать документ не тому
 * клиенту хуже, чем переспросить.
 *
 * @returns {{cp}|{choices}|{}} один контрагент, список кандидатов или пусто
 */
function matchCp(cps, name) {
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w && !/^(ооо|оао|зао|пао|ип|ао)$/.test(w)).join(' ');
  const want = norm(name);
  if (!want) return {};
  const exact = cps.filter((c) => norm(c.name) === want);
  if (exact.length === 1) return { cp: exact[0] };
  const part = cps.filter((c) => norm(c.name).includes(want) || want.includes(norm(c.name)));
  if (part.length === 1) return { cp: part[0] };
  if (part.length > 1) return { choices: part.slice(0, 8) };
  return {};
}

// ---------- модель ----------

const SYSTEM = `Ты разбираешь фразы пользователя бухгалтерского бота и отвечаешь ТОЛЬКО JSON.

Возможные ответы:
{"action":"debts"}                                    — спрашивают про долги
{"action":"unpaid"}                                   — спрашивают про неоплаченные счета
{"action":"draft","docType":"sch|usl|upd|torg12|schdog","who":"имя клиента","items":[{"name":"...","qty":1,"price":1000}]}
{"action":"help"}                                     — просят подсказку
{"action":"unknown"}                                  — непонятно

Правила:
- docType: счёт — sch, счёт-договор — schdog, акт — usl, УПД — upd, накладная — torg12.
- Суммы возвращай числом в рублях: «30 тысяч» → 30000, «1,5 млн» → 1500000.
- Если позиции не названы, верни items: [].
- Никогда не придумывай имя клиента, которого нет во фразе: оставь who пустым.
- Только JSON, без пояснений и без разметки.`;

async function callModel(text) {
  const p = PROVIDER();
  if (p === 'mock') return String(process.env.AI_MOCK || '{"action":"unknown"}');

  const model = process.env.AI_MODEL || MODEL_DEFAULT;
  // Ответ — одна строка JSON: держать потолок высоким незачем, а лишние
  // токены оплачены.
  const maxTokens = Number(process.env.AI_MAX_TOKENS || 400);
  const signal = AbortSignal.timeout(20000);

  if (p === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: SYSTEM,
        messages: [{ role: 'user', content: String(text).slice(0, 1000) }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    return (data.content || []).map((c) => c.text || '').join('');
  }

  if (p === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: String(text).slice(0, 1000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    return ((data.choices || [{}])[0].message || {}).content || '';
  }

  throw new Error('Нет провайдера');
}

const extractJson = (raw) => {
  const i = String(raw).indexOf('{');
  const j = String(raw).lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(String(raw).slice(i, j + 1)); } catch (_) { return null; }
};

const DOC_TYPES = new Set(['sch', 'schdog', 'usl', 'upd', 'torg12']);

/**
 * Привести ответ модели к тому, чему можно верить.
 *
 * Всё, что придёт от модели, — это данные из ненадёжного источника: их
 * задаёт текст пользователя. Поэтому здесь не «разбор», а проверка: чужое
 * действие, неизвестный тип документа, отрицательная цена не проходят.
 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return { action: 'unknown' };
  const action = String(raw.action || '');
  if (['debts', 'unpaid', 'help'].includes(action)) return { action };
  if (action !== 'draft') return { action: 'unknown' };
  if (!DOC_TYPES.has(raw.docType)) return { action: 'unknown' };

  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 20).map((it) => ({
    name: String((it && it.name) || '').trim().slice(0, 200),
    qty: Math.min(100000, Math.max(0, Number((it && it.qty) || 0))) || 1,
    price: Math.min(1e9, Math.max(0, Number((it && it.price) || 0))),
  })).filter((it) => it.name);

  return { action: 'draft', docType: raw.docType, who: String(raw.who || '').trim().slice(0, 200), items };
}

/**
 * Понять фразу.
 *
 * @param {string} text фраза пользователя
 * @param {number} userId кому считать расход
 * @returns {Promise<object>} намерение; {action:'unknown'} — не поняли
 */
async function understand(text, userId) {
  const quick = quickParse(text);
  if (quick) return { ...quick, source: 'local' };       // бесплатно
  if (!aiAvailable()) return { action: 'unknown', source: 'off' };

  const left = budget(userId);
  if (left.left <= 0) return { action: 'unknown', source: 'limit' };

  spend(userId);
  try {
    return { ...sanitize(extractJson(await callModel(text))), source: 'model' };
  } catch (e) {
    return { action: 'unknown', source: 'error', error: e.message };
  }
}

module.exports = {
  understand, quickParse, sanitize, matchCp, budget, spend,
  aiAvailable, aiHint, MODEL_DEFAULT,
};
