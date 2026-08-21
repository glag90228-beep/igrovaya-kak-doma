'use strict';

/**
 * Распознавание речи: голосовое сообщение → текст.
 *
 * Зачем отдельный сервис. Голос — самый быстрый ввод, когда руки заняты
 * товаром или рулём. Но модель, которая понимает фразы (lib/ai-agent.js) и
 * читает счета (lib/vision.js), звук не принимает вовсе: Anthropic Messages
 * API берёт только текст, картинки и PDF. Поэтому расшифровка — отдельный
 * шаг и отдельный провайдер, а всё остальное дальше идёт как обычно, через
 * ai-agent.understand().
 *
 * Провайдер выбирается переменной SPEECH_PROVIDER, как в lib/vision.js:
 *
 *   yandex — Yandex SpeechKit; ключ YANDEX_API_KEY, папка YANDEX_FOLDER_ID
 *            (те же, что для распознавания фото; сервисному аккаунту нужна
 *            роль ai.speechkit-stt.user — ключ сам по себе прав не даёт);
 *   mock   — для прогонов: возвращает SPEECH_MOCK, в сеть не ходит;
 *   не задан — распознавания нет, бот честно об этом говорит.
 *
 * Почему именно SpeechKit. Telegram присылает голосовые в OGG/Opus, и
 * SpeechKit принимает этот контейнер напрямую — перекодировать нечем и
 * незачем, ffmpeg на сервере не нужен.
 *
 * Два метода вместо одного. Синхронный отвечает сразу, но берёт не больше
 * 30 секунд и 1 МБ. Голосовые бывают длиннее, поэтому длинные уходят в
 * асинхронный: он принимает файл в теле запроса и распознаёт до четырёх
 * часов, но ответа приходится ждать — примерно 10 секунд на минуту записи.
 */

const SYNC_LIMIT_SEC = 30;              // потолок синхронного метода
const SYNC_LIMIT_BYTES = 1024 * 1024;   // и его же потолок по размеру
const POLL_MS = 2000;                   // как часто спрашивать готовность
const POLL_TIMEOUT_MS = 180000;         // и сколько всего ждать

const PROVIDER = () => String(process.env.SPEECH_PROVIDER || '').toLowerCase();

function speechAvailable() {
  const p = PROVIDER();
  if (p === 'mock') return true;
  if (p === 'yandex') return Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID);
  return false;
}

function speechHint() {
  const p = PROVIDER();
  if (!p) return 'Распознавание речи не подключено (SPEECH_PROVIDER не задан).';
  if (p === 'yandex') return 'Нет YANDEX_API_KEY или YANDEX_FOLDER_ID.';
  return `Неизвестный провайдер речи: ${p}.`;
}

/**
 * Формат — по сигнатуре файла, а не по mime_type из Telegram.
 *
 * mime_type там задаёт отправитель («as defined by sender»), у видеокружка
 * его нет вовсе, а ошибиться нельзя: SpeechKit разбирает контейнер сам и на
 * неверно объявленном формате отвечает невнятной ошибкой.
 */
function sniff(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS') return 'oggopus';
  if (b.length >= 8 && b.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (b.length >= 3 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return 'mp3';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'RIFF') return 'wav';
  return '';
}

/**
 * Разобрать WAV: где начинается звук и с какой частотой он записан.
 *
 * Нужно, потому что из браузера голос приходит именно WAV. MediaRecorder
 * отдал бы WebM, а его SpeechKit не принимает ни в одном методе, и
 * перекодировать нечем — ffmpeg на сервере нет. Поэтому приложение пишет
 * звук само и собирает WAV, а мы снимаем с него заголовок: синхронному
 * методу нужен чистый поток PCM (format=lpcm).
 *
 * @returns {{rate:number, pcm:Buffer}|null} null — это не разборный WAV
 */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    return null;
  }
  let rate = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) rate = buf.readUInt32LE(body + 4);
    if (id === 'data') {
      // Длину из заголовка не берём на веру: у записи «на лету» её иногда
      // не проставляют вовсе, и тогда там ноль. Читаем до конца файла.
      const end = size && body + size <= buf.length ? body + size : buf.length;
      return rate ? { rate, pcm: buf.subarray(body, end) } : null;
    }
    pos = body + size + (size % 2);      // куски выровнены по чётному байту
  }
  return null;
}

/** Синхронное распознавание: до 30 секунд, ответ сразу. */
async function yandexSync(buffer, params = 'format=oggopus') {
  const url = `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?lang=ru-RU&topic=general&${params}`;
  const res = await fetch(url, {
    method: 'POST',
    // Папку не передаём намеренно: у ключа сервисного аккаунта она своя, а
    // явный folderId документация велит слать только пользовательскому.
    headers: { Authorization: `Api-Key ${process.env.YANDEX_API_KEY}` },
    body: buffer,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SpeechKit ${res.status}: ${text.slice(0, 200)}`);
  try { return String(JSON.parse(text).result || ''); } catch (_) { return ''; }
}

/**
 * Ответ асинхронного метода — не один JSON и не массив, а склеенные подряд
 * объекты: по одному на каждый распознанный кусок. JSON.parse на всём теле
 * падает, поэтому разбираем по балансу скобок.
 */
function splitJsonStream(body) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth += 1; }
    else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(body.slice(start, i + 1))); } catch (_) { /* пропускаем битый кусок */ }
        start = -1;
      }
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Асинхронное распознавание: файл в теле, до четырёх часов записи. */
async function yandexAsync(buffer, kind) {
  const container = { oggopus: 'OGG_OPUS', mp3: 'MP3', wav: 'WAV' }[kind] || 'OGG_OPUS';
  const head = {
    'Content-Type': 'application/json',
    Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
    'x-folder-id': process.env.YANDEX_FOLDER_ID,
  };

  const started = await fetch('https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync', {
    method: 'POST',
    headers: head,
    body: JSON.stringify({
      content: buffer.toString('base64'),
      recognitionModel: {
        model: 'general',
        audioFormat: { containerAudio: { containerAudioType: container } },
        languageRestriction: { restrictionType: 'WHITELIST', languageCode: ['ru-RU'] },
        textNormalization: { textNormalization: 'TEXT_NORMALIZATION_ENABLED' },
      },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!started.ok) throw new Error(`SpeechKit ${started.status}: ${(await started.text()).slice(0, 200)}`);
  const op = await started.json();
  if (!op.id) throw new Error('SpeechKit не вернул номер задания');

  const until = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > until) throw new Error('Распознавание не закончилось за три минуты');
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
    // eslint-disable-next-line no-await-in-loop
    const st = await fetch(`https://operation.api.cloud.yandex.net/operations/${op.id}`, {
      headers: { Authorization: `Api-Key ${process.env.YANDEX_API_KEY}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!st.ok) throw new Error(`SpeechKit ${st.status}`);
    // eslint-disable-next-line no-await-in-loop
    const state = await st.json();
    if (state.error) throw new Error(String(state.error.message || 'ошибка распознавания'));
    if (state.done) break;
  }

  const got = await fetch(`https://stt.api.cloud.yandex.net/stt/v3/getRecognition?operation_id=${op.id}`, {
    headers: { Authorization: `Api-Key ${process.env.YANDEX_API_KEY}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!got.ok) throw new Error(`SpeechKit ${got.status}: ${(await got.text()).slice(0, 200)}`);

  // Берём финальные куски. Уточнённый вариант (finalRefinement) точнее —
  // числа в нём приведены к цифрам, — поэтому он вытесняет черновой.
  const parts = [];
  for (const obj of splitJsonStream(await got.text())) {
    const r = obj.result || {};
    const fin = r.finalRefinement && r.finalRefinement.normalizedText;
    const alt = ((fin || r.final || {}).alternatives || [])[0];
    if (!alt || !alt.text) continue;
    if (fin && parts.length) parts[parts.length - 1] = alt.text;
    else parts.push(alt.text);
  }
  return parts.join(' ').trim();
}

/**
 * Расшифровать запись.
 *
 * @param {Buffer} buffer байты файла как их прислал Telegram
 * @param {number} seconds длительность из сообщения; 0 — неизвестна
 * @returns {Promise<{ok:boolean, text?:string, error?:string, via?:string}>}
 */
async function transcribe(buffer, seconds = 0) {
  if (!speechAvailable()) return { ok: false, error: speechHint() };
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) return { ok: false, error: 'Пустая запись — распознавать нечего.' };

  if (PROVIDER() === 'mock') {
    return { ok: true, text: String(process.env.SPEECH_MOCK || ''), via: 'mock' };
  }

  const kind = sniff(buf);
  if (kind === 'mp4') {
    // Видео не разбираем: чтобы достать звук, нужен ffmpeg на сервере.
    return { ok: false, error: 'Видео я пока не разбираю — пришлите голосовое сообщение.' };
  }

  /*
   * Куда отправить. Длительность из сообщения задаёт отправитель, и верить
   * ей нельзя; размер файла мы знаем точно. Поэтому в синхронный метод
   * пускаем, только когда оба признака укладываются в его потолок, — на
   * границе дешевле подождать, чем получить отказ и остаться без ответа.
   */
  const short = buf.length <= SYNC_LIMIT_BYTES
    && (seconds ? seconds <= SYNC_LIMIT_SEC : buf.length <= SYNC_LIMIT_BYTES / 4);

  // WAV из приложения: снимаем заголовок и отправляем чистый PCM. Так путь
  // короче — синхронный метод отвечает сразу, без ожидания задания.
  const wav = kind === 'wav' ? parseWav(buf) : null;

  try {
    let text;
    if (wav && wav.pcm.length <= SYNC_LIMIT_BYTES) {
      text = await yandexSync(wav.pcm, `format=lpcm&sampleRateHertz=${wav.rate}`);
    } else if (short && kind === 'oggopus') {
      text = await yandexSync(buf);
    } else {
      text = await yandexAsync(buf, kind);
    }
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, error: 'Ничего не расслышал — попробуйте записать ещё раз.' };
    const via = wav ? 'lpcm' : (short && kind === 'oggopus' ? 'sync' : 'async');
    return { ok: true, text: clean.slice(0, 4000), via };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  speechAvailable, speechHint, transcribe, sniff, splitJsonStream, parseWav,
  SYNC_LIMIT_SEC, SYNC_LIMIT_BYTES,
};
