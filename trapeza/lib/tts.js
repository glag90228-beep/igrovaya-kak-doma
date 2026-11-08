'use strict';

/**
 * Синтез речи: ответ помощника → голос.
 *
 * Зачем. Распознавание у нас было давно, а отвечал бот только текстом:
 * человек за рулём или с товаром в руках спрашивал голосом и должен был
 * доставать телефон, чтобы прочитать ответ. Разговор получался в одну
 * сторону.
 *
 * Провайдер — TTS_PROVIDER:
 *   gemini — по умолчанию, если есть GEMINI_API_KEY. Тот же ключ, что
 *            разбирает фразы и голос, второго сервиса не нужно. Интонацию
 *            задаём словами («живо и дружелюбно») — это и было главной
 *            жалобой на синтезированный голос: читает ровно, как робот;
 *   yandex — SpeechKit, YANDEX_API_KEY (сервисному аккаунту нужна роль
 *            ai.speechkit-tts.user — как и для распознавания, ключ сам по
 *            себе прав не даёт);
 *   mock   — для прогонов, в сеть не ходит;
 *   off    — выключено.
 *
 * Форматы. Telegram рисует голосовое только для OGG/Opus. SpeechKit отдаёт
 * его сразу; Gemini — сырой PCM, и его мы кодируем в Opus через Chromium
 * (lib/ogg-opus.js). Браузеру мини-приложения хватает WAV.
 *
 * Деньги. Gemini считает звук токенами (около 25 в секунду) и возвращает их
 * в ответе — платим по факту, по цене AI_KOP_TTS_OUT. SpeechKit берёт за
 * символы — AI_KOP_TTS_CHARS за тысячу. Оба идут в общий кошелёк ИИ
 * (ai-agent: budget/spend), отдельного крана нет.
 */

const { fetchRetry } = require('./net-retry');
const { pcmToWav, pcmToOggOpus } = require('./ogg-opus');

const MAX_CHARS = () => Number(process.env.TTS_MAX_CHARS || 700);
const MODEL_FALLBACK = 'gemini-2.5-flash-preview-tts';
const STYLE_DEFAULT = 'Прочитай по-русски живо и дружелюбно, с естественной интонацией, '
  + 'как внимательный помощник, в спокойном темпе';

function provider() {
  const p = String(process.env.TTS_PROVIDER || '').toLowerCase();
  if (p) return p;
  return process.env.GEMINI_API_KEY ? 'gemini' : 'off';
}

function ttsAvailable() {
  const p = provider();
  if (p === 'mock') return true;
  if (p === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
  if (p === 'yandex') return Boolean(process.env.YANDEX_API_KEY);
  return false;
}

/**
 * Текст, который не стыдно прочитать вслух.
 *
 * Ответы бота сделаны для глаз: HTML-разметка, эмодзи, «₽», «№». Синтез
 * читает их буквально («знак рубля», «эмодзи галочка») или спотыкается.
 * Длинное режем по концу предложения: минутный монолог никто не дослушает,
 * а платим за каждую секунду.
 */
function speakable(text, max = MAX_CHARS()) {
  let s = String(text || '')
    .replace(/<br\s*\/?>/gi, '. ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/[*_`#>|•·]+/g, ' ')
    .replace(/(\d)\s*₽/g, '$1 руб.')
    .replace(/₽/g, 'руб.')
    .replace(/№\s*/g, 'номер ')
    // Перенос строки — граница фразы, но точку ставим, только если её нет:
    // иначе выходит «Готово!.» и синтез делает лишнюю паузу.
    .replace(/([^.!?…:;,])\s*\n+\s*/g, '$1. ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`).trim();
}

// ── Gemini ──

const baseUrl = () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
let modelCache = { name: '', at: 0 };

/**
 * Какой моделью синтезировать.
 *
 * Модели речи у Google выходят и переименовываются чаще, чем мы выкладываем
 * код (из «preview» в постоянные, новые поколения). Зашитое имя однажды
 * перестанет отвечать, и голос молча пропадёт. Поэтому, если TTS_MODEL не
 * задан, спрашиваем у API список и берём самую свежую flash-модель с «tts»
 * в имени. Ответ помним шесть часов.
 */
async function geminiModel() {
  if (process.env.TTS_MODEL) return process.env.TTS_MODEL;
  if (modelCache.name && Date.now() - modelCache.at < 6 * 3600 * 1000) return modelCache.name;
  let name = MODEL_FALLBACK;
  try {
    const res = await fetchRetry(`${baseUrl()}/v1beta/models?pageSize=1000`, {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(15000),
    }, { idempotent: true });
    if (res.ok) {
      const list = ((await res.json()).models || [])
        .filter((m) => /tts/i.test(m.name || '')
          && (m.supportedGenerationMethods || ['generateContent']).includes('generateContent'))
        .map((m) => String(m.name).replace(/^models\//, ''));
      const ver = (n) => (n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1] * 1;
      const rank = (n) => ver(n) * 10 + (/flash/.test(n) ? 2 : 0) + (/preview/.test(n) ? 0 : 1);
      list.sort((a, b) => rank(b) - rank(a));
      if (list.length) name = list[0];
    }
  } catch (_) { /* остаёмся на запасном имени */ }
  modelCache = { name, at: Date.now() };
  return name;
}

async function viaGemini(text) {
  const model = await geminiModel();
  const style = process.env.TTS_STYLE || STYLE_DEFAULT;
  const res = await fetchRetry(`${baseUrl()}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${style}:\n${text}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.TTS_VOICE || 'Sulafat' } } },
      },
    }),
    signal: AbortSignal.timeout(60000),
  }, { idempotent: true });
  if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const parts = ((((data.candidates || [])[0] || {}).content || {}).parts || []);
  const inline = parts.map((p) => p.inlineData || p.inline_data).find((d) => d && d.data);
  if (!inline) throw new Error('Gemini TTS не вернул звука');
  const mime = String(inline.mimeType || inline.mime_type || '');
  const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
  const u = data.usageMetadata || {};
  return {
    pcm: Buffer.from(inline.data, 'base64'),
    rate,
    usage: { in: Number(u.promptTokenCount) || 0, out: 0, cached: 0 },
    ttsTokens: Number(u.candidatesTokenCount) || 0,
    model,
  };
}

// ── SpeechKit ──

async function viaYandex(text, format) {
  const body = new URLSearchParams({
    text, lang: 'ru-RU', voice: process.env.TTS_VOICE || 'alena', emotion: 'good', speed: '1.0',
    format: format === 'ogg' ? 'oggopus' : 'lpcm',
  });
  if (format !== 'ogg') body.set('sampleRateHertz', '48000');
  if (process.env.YANDEX_FOLDER_ID) body.set('folderId', process.env.YANDEX_FOLDER_ID);
  const res = await fetchRetry('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
    method: 'POST',
    // Запрет на хранение — как у распознавания: в ответах помощника суммы
    // и имена клиентов.
    headers: { Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`, 'x-data-logging-enabled': 'false' },
    body,
    signal: AbortSignal.timeout(60000),
  }, { idempotent: true });
  if (!res.ok) throw new Error(`SpeechKit TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return format === 'ogg' ? { ogg: buf } : { pcm: buf, rate: 48000 };
}

/**
 * Озвучить текст.
 *
 * @param {string} text что сказать (разметку уберём сами)
 * @param {{format?: 'ogg'|'wav'}} [opts] ogg — для Telegram, wav — для браузера
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mime?:string, format?:string,
 *   seconds?:number, spent?:object, error?:string}>}
 *   spent — готовый аргумент для ai.spend(userId, spent)
 */
async function synthesize(text, { format = 'ogg' } = {}) {
  const say = speakable(text);
  if (!say) return { ok: false, error: 'нечего озвучивать' };
  if (!ttsAvailable()) return { ok: false, error: 'синтез речи не подключён' };
  const p = provider();
  try {
    if (p === 'mock') {
      const pcm = Buffer.alloc(24000 * 0.2 * 2);
      return format === 'ogg'
        ? { ok: true, buffer: Buffer.from(`OggS mock:${say}`), mime: 'audio/ogg', format: 'ogg', seconds: 1, spent: { ttsChars: say.length }, text: say }
        : { ok: true, buffer: pcmToWav(pcm, 24000), mime: 'audio/wav', format: 'wav', seconds: 0.2, spent: { ttsChars: say.length }, text: say };
    }
    if (p === 'yandex') {
      const got = await viaYandex(say, format);
      const spent = { ttsChars: say.length };
      if (got.ogg) return { ok: true, buffer: got.ogg, mime: 'audio/ogg', format: 'ogg', seconds: 0, spent, text: say };
      return {
        ok: true, buffer: pcmToWav(got.pcm, got.rate), mime: 'audio/wav', format: 'wav',
        seconds: got.pcm.length / 2 / got.rate, spent, text: say,
      };
    }
    // gemini
    const got = await viaGemini(say);
    const spent = { usage: got.usage, ttsTokens: got.ttsTokens };
    const seconds = got.pcm.length / 2 / got.rate;
    if (format === 'ogg') {
      try {
        const ogg = await pcmToOggOpus(got.pcm, got.rate);
        return { ok: true, buffer: ogg, mime: 'audio/ogg', format: 'ogg', seconds, spent, text: say };
      } catch (e) {
        // Звук уже оплачен — не выбрасываем: вызывающий решит, отдать ли
        // его файлом или ответить текстом.
        return {
          ok: true, buffer: pcmToWav(got.pcm, got.rate), mime: 'audio/wav', format: 'wav',
          seconds, spent, text: say, oggError: e.message,
        };
      }
    }
    return { ok: true, buffer: pcmToWav(got.pcm, got.rate), mime: 'audio/wav', format: 'wav', seconds, spent, text: say };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { synthesize, ttsAvailable, speakable, provider, geminiModel, _resetModelCache: () => { modelCache = { name: '', at: 0 }; } };
