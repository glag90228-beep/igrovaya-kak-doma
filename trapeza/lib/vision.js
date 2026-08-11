'use strict';

/**
 * Распознавание присланного счёта или чека.
 *
 * Внутри Node этого не сделать — нужен внешний сервис, поэтому провайдер
 * подключаемый и выбирается переменной окружения VISION_PROVIDER:
 *
 *   anthropic — модель со зрением, сразу отдаёт разобранные поля (точнее);
 *               ключ в ANTHROPIC_API_KEY;
 *   yandex    — Yandex Vision OCR: отдаёт текст, поля вытаскиваем сами
 *               регулярками; ключ в YANDEX_API_KEY, папка в YANDEX_FOLDER_ID;
 *   mock      — для прогонов: берёт ответ из VISION_MOCK;
 *   не задан   — распознавания нет, бот честно об этом говорит.
 *
 * Разбор текста (parseInvoiceText) живёт здесь же и проверяется отдельно:
 * он нужен и для Yandex, и как запасной вариант, если модель вернула текст
 * вместо JSON.
 */

const PROVIDER = () => String(process.env.VISION_PROVIDER || '').toLowerCase();

function visionAvailable() {
  const p = PROVIDER();
  if (p === 'mock') return true;
  if (p === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (p === 'yandex') return Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID);
  return false;
}

function visionHint() {
  const p = PROVIDER();
  if (!p) return 'Распознавание не подключено (VISION_PROVIDER не задан).';
  if (p === 'anthropic') return 'Нет ключа ANTHROPIC_API_KEY.';
  if (p === 'yandex') return 'Нет YANDEX_API_KEY или YANDEX_FOLDER_ID.';
  return `Неизвестный провайдер: ${p}.`;
}

// ─────────────────────────── разбор текста ───────────────────────────

const MONTHS = {
  январ: '01', феврал: '02', март: '03', апрел: '04', ма: '05', июн: '06',
  июл: '07', август: '08', сентябр: '09', октябр: '10', ноябр: '11', декабр: '12',
};

/** «11.08.2026», «11 августа 2026» → ISO. */
function findDate(text) {
  const num = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/.exec(text);
  if (num) {
    const y = num[3].length === 2 ? `20${num[3]}` : num[3];
    return `${y}-${num[2].padStart(2, '0')}-${num[1].padStart(2, '0')}`;
  }
  const word = /(\d{1,2})\s+([а-яё]{3,})\s+(\d{4})/i.exec(text);
  if (word) {
    const key = Object.keys(MONTHS).find((k) => word[2].toLowerCase().startsWith(k));
    if (key) return `${word[3]}-${MONTHS[key]}-${word[1].padStart(2, '0')}`;
  }
  return null;
}

const money = (s) => {
  const v = Number(String(s).replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
};

/**
 * Достаёт из текста счёта то, что нужно для операции.
 * Сумму ищем у слов «всего к оплате» / «итого», а не просто самое большое
 * число: в счёте полно цен за единицу, и максимум легко берётся не оттуда.
 */
function parseInvoiceText(text) {
  const t = String(text || '').replace(/ /g, ' ');
  const out = { date: null, amount: null, docNo: '', inn: '', name: '', kind: 'Приход' };

  out.date = findDate(t);

  const AMOUNT = /(?:всего\s+к\s+оплате|итого\s+к\s+оплате|итого|всего|сумма)\D{0,20}?(\d[\d\s ]*(?:[.,]\d{2})?)/gi;
  let best = null; let m;
  while ((m = AMOUNT.exec(t)) !== null) {
    const v = money(m[1]);
    // берём последнее подходящее: «всего к оплате» обычно ниже «итого»
    if (v != null && v > 0) best = v;
  }
  out.amount = best;

  const no = /(?:счет|счёт|№|N)\s*№?\s*([\w\-/]{1,20})/i.exec(t);
  if (no && /\d/.test(no[1])) out.docNo = no[1];

  const inn = /ИНН\s*(\d{10}|\d{12})/i.exec(t);
  if (inn) out.inn = inn[1];

  const name = /(?:поставщик|исполнитель|получатель)\s*[:\-]?\s*([^\n]{3,80})/i.exec(t);
  if (name) out.name = name[1].trim().replace(/[,;]\s*ИНН.*$/i, '');

  return out;
}

// ─────────────────────────── провайдеры ───────────────────────────

async function viaAnthropic(buffer, mime) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.VISION_MODEL || 'claude-sonnet-5',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } },
          {
            type: 'text',
            text: 'Это фотография российского счёта, акта или чека. Верни только JSON без пояснений:\n'
              + '{"date":"ГГГГ-ММ-ДД или null","amount":число итоговой суммы к оплате или null,'
              + '"docNo":"номер документа или пустая строка","inn":"ИНН поставщика или пустая строка",'
              + '"name":"название поставщика или пустая строка","text":"весь распознанный текст"}\n'
              + 'Сумма — итог к оплате, а не цена за единицу. Если чего-то не видно, ставь null или "".',
          },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = (data.content || []).map((c) => c.text || '').join('');
  return raw;
}

async function viaYandex(buffer, mime) {
  const res = await fetch('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
      'x-folder-id': process.env.YANDEX_FOLDER_ID,
      'x-data-logging-enabled': 'false',
    },
    body: JSON.stringify({
      mimeType: mime, languageCodes: ['ru', 'en'], model: 'page',
      content: buffer.toString('base64'),
    }),
  });
  if (!res.ok) throw new Error(`Yandex ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return ((data.result || {}).textAnnotation || {}).fullText || '';
}

/** Достаём JSON из ответа модели, даже если вокруг него что-то написано. */
function extractJson(raw) {
  const i = raw.indexOf('{'); const j = raw.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(raw.slice(i, j + 1)); } catch (_) { return null; }
}

/**
 * @returns {Promise<{ok:boolean, fields?:object, text?:string, error?:string}>}
 */
async function readInvoice(buffer, mime = 'image/jpeg') {
  if (!visionAvailable()) return { ok: false, error: visionHint() };
  const p = PROVIDER();
  try {
    let raw;
    if (p === 'mock') raw = String(process.env.VISION_MOCK || '');
    else if (p === 'anthropic') raw = await viaAnthropic(buffer, mime);
    else raw = await viaYandex(buffer, mime);

    const json = extractJson(raw);
    // Модель могла вернуть готовые поля — но текст всё равно прогоняем через
    // свой разбор и добираем то, чего в JSON не оказалось.
    const text = (json && json.text) || raw;
    const parsed = parseInvoiceText(text);
    const fields = json
      ? {
        date: json.date || parsed.date,
        amount: Number(json.amount) > 0 ? Math.round(Number(json.amount) * 100) / 100 : parsed.amount,
        docNo: json.docNo || parsed.docNo,
        inn: json.inn || parsed.inn,
        name: json.name || parsed.name,
      }
      : parsed;
    return { ok: true, fields, text: String(text).slice(0, 4000) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { visionAvailable, visionHint, readInvoice, parseInvoiceText, findDate };
