'use strict';

/**
 * Распознавание речи: голосовое сообщение → текст.
 *
 * Зачем это отдельный шаг. Голос — самый быстрый ввод, когда руки заняты
 * товаром или рулём. Расшифровка идёт здесь, а дальше фраза живёт как
 * напечатанная — через ai-agent.understand().
 *
 * Провайдер выбирается переменной SPEECH_PROVIDER, как в lib/vision.js:
 *
 *   gemini — та же модель, что разбирает фразы и читает счета. Ключ
 *            GEMINI_API_KEY, отдельной роли и второго сервиса не нужно;
 *   yandex — Yandex SpeechKit; ключ YANDEX_API_KEY, папка YANDEX_FOLDER_ID
 *            (те же, что для распознавания фото; сервисному аккаунту нужна
 *            роль ai.speechkit-stt.user — ключ сам по себе прав не даёт);
 *   mock   — для прогонов: возвращает SPEECH_MOCK, в сеть не ходит;
 *   не задан — распознавания нет, бот честно об этом говорит.
 *
 * ── Почему появился gemini ──
 *
 * Здесь было написано, что модель звук не принимает вовсе и потому нужен
 * отдельный сервис. Для Anthropic это верно до сих пор: Messages API берёт
 * текст, картинки и PDF, а звук — нет. Для Gemini — уже нет: он принимает
 * запись прямо в generateContent, тем же вызовом, что и снимок счёта.
 *
 * Разница не теоретическая. На боевом сервере SpeechKit молчит, потому что
 * сервисному аккаунту не выдана роль, а Gemini на той же машине работает —
 * это проверено фразами и снимками. Один ключ вместо двух сервисов, и
 * ничего не нужно настраивать в чужой консоли.
 *
 * Платим по-разному, и это стоит знать заранее. SpeechKit считает минуты,
 * Gemini — токены звука (около 25 на секунду), и возвращает их в ответе.
 * Значит расход по нему считается ПО ФАКТУ, а не по нашей прикидке.
 *
 * Telegram присылает голосовые в OGG/Opus, приложение пишет WAV. Оба
 * провайдера берут эти контейнеры напрямую — перекодировать нечем и
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
  if (p === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
  if (p === 'yandex') return Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID);
  return false;
}

function speechHint() {
  const p = PROVIDER();
  if (!p) return 'Распознавание речи не подключено (SPEECH_PROVIDER не задан).';
  if (p === 'gemini') {
    const bad = badKey(process.env.GEMINI_API_KEY);
    if (bad) return bad;
    return 'Нет ключа GEMINI_API_KEY.';
  }
  if (p === 'yandex') {
    const bad = badKey(process.env.YANDEX_API_KEY);
    if (bad) return bad;
    return 'Нет YANDEX_API_KEY или YANDEX_FOLDER_ID.';
  }
  return `Неизвестный провайдер речи: ${p}.`;
}

/**
 * Ключ похож на ключ?
 *
 * Ловим не опечатку, а склейку при копировании. С боевого сервера пришёл
 * ключ, к которому прилипло время сообщения — «…916:49», — и SpeechKit
 * ответил «Unknown api key». По такому ответу человек идёт перевыпускать
 * совершенно рабочий ключ. Двоеточий и пробелов в ключах Яндекса не бывает,
 * и это видно, не отправляя запрос.
 */
function badKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (/[:\s]/.test(k)) {
    return 'В YANDEX_API_KEY попал лишний текст (двоеточие или пробел) — '
      + 'похоже, при копировании прилипло время или перенос строки. Скопируйте ключ заново.';
  }
  if (!/^AQVN/.test(k)) {
    return `YANDEX_API_KEY начинается не с AQVN (а с «${k.slice(0, 4)}») — `
      + 'это, возможно, не API-ключ, а статический ключ доступа или ID.';
  }
  return '';
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
    //
    // Запрет на хранение — обязателен: через бота идут чужие реквизиты и
    // суммы, и «выставь счёт Заре на тридцать тысяч» ничем не отличается от
    // того же текста, набранного руками. Разбор текста и снимков этот
    // заголовок слали давно, распознавание речи — нет, хотя именно оно
    // отправляет наружу живой голос.
    headers: {
      Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
      'x-data-logging-enabled': 'false',
    },
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
    // Тот же запрет на хранение, что и у синхронного пути и у разбора
    // снимков: наружу уходит голос с реквизитами и суммами.
    'x-data-logging-enabled': 'false',
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
 * Расшифровка через Gemini.
 *
 * Звук уходит в тот же generateContent, что фраза и снимок счёта: файл в
 * inline_data, до 20 МБ в запросе — ровно столько же, сколько Telegram
 * отдаёт боту, так что второй границы не появляется.
 *
 * Подсказка короткая и запрещающая. Модель, которую попросили «расшифруй»,
 * охотно добавляет от себя: приписывает «(неразборчиво)», расставляет
 * говорящих, переводит на другой язык, а то и отвечает на услышанное вместо
 * того, чтобы его записать. Для нас это не мелочь: расшифровка идёт дальше
 * в разбор фразы, и лишнее слово превращается в неверный документ.
 *
 * Возвращаем и usage: Gemini считает звук токенами (около 25 на секунду) и
 * сообщает их в ответе. Значит расход считается по факту — как у текста, а
 * не по прикидке «минута стоит столько-то».
 */
async function viaGemini(buffer, kind) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY не задан');
  const baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com')
    .replace(/\/+$/, '');
  const model = process.env.SPEECH_MODEL || process.env.AI_MODEL || 'gemini-3.6-flash';

  // Тип берём по сигнатуре файла, а не по словам отправителя: mime_type в
  // Telegram задаёт он сам, а у видеокружка его нет вовсе.
  const mime = { oggopus: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav' }[kind] || 'audio/ogg';

  const ASK = 'Запиши текстом то, что сказано в этой записи. Русский язык.\n'
    + 'Только сами слова: без пояснений, без кавычек, без пометок вроде '
    + '«неразборчиво», без имён говорящих. Ничего не добавляй от себя и не '
    + 'отвечай на сказанное — только запиши. Если речи нет вовсе, ответь пустой строкой.';

  const res = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: ASK },
          { inline_data: { mime_type: mime, data: buffer.toString('base64') } },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 1200 },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const u = data.usageMetadata || {};
  return {
    text: ((((data.candidates || [])[0] || {}).content || {}).parts || [{}])[0].text || '',
    usage: {
      in: Number(u.promptTokenCount) || 0,
      out: Number(u.candidatesTokenCount) || 0,
      cached: Number(u.cachedContentTokenCount) || 0,
    },
  };
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
   * Gemini разбирает контейнер сам, и делить записи на короткие и длинные
   * не нужно: ни синхронного потолка в 30 секунд, ни отдельного
   * асинхронного метода у него нет. Ограничение одно — 20 МБ на запрос,
   * и оно совпадает с потолком Telegram на скачивание ботом.
   */
  if (PROVIDER() === 'gemini') {
    if (buf.length > 20 * 1024 * 1024) {
      return { ok: false, error: 'Запись слишком длинная — пришлите покороче или напишите текстом.' };
    }
    try {
      const got = await viaGemini(buf, kind);
      const clean = String(got.text || '').trim();
      if (!clean) return { ok: false, error: 'Ничего не расслышал — попробуйте записать ещё раз.' };
      // usage отдаём наверх: по нему бот считает деньги по факту, а не по
      // прикидке «минута стоит столько-то».
      return { ok: true, text: clean.slice(0, 4000), via: 'gemini', usage: got.usage };
    } catch (e) {
      const detail = String(e.message || '');
      const human = /401|403|API key/i.test(detail)
        ? 'Распознавание речи сейчас не работает — напишите, пожалуйста, текстом.'
        : 'Не получилось разобрать запись — попробуйте ещё раз или напишите текстом.';
      return { ok: false, error: human, detail };
    }
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
    /*
     * Человеку — человеческое, подробности — в журнал.
     *
     * Раньше сюда уходило e.message как есть, и пользователь видел в чате
     * «SpeechKit 401: {"error_code":"UNAUTHORIZED"… resource-manager.folder
     * b1g29fch…}». Это не сообщение об ошибке, а кусок внутренностей: он
     * ничего не объясняет тому, кто просто записал голосовое, зато выдаёт
     * наружу устройство нашей системы и номера каталогов.
     *
     * Причину при этом терять нельзя — без неё владелец не узнает, что у
     * ключа нет прав. Поэтому подробность возвращаем отдельным полем: её
     * покажут владельцу и запишут в журнал поддержки, а в чат уйдёт фраза,
     * после которой понятно, что делать.
     */
    const detail = String(e.message || '');
    const human = /Permission ?denied|UNAUTHORIZED|401|403/i.test(detail)
      ? 'Распознавание речи сейчас не работает — напишите, пожалуйста, текстом.'
      : 'Не получилось разобрать запись — попробуйте ещё раз или напишите текстом.';
    return { ok: false, error: human, detail };
  }
}

module.exports = {
  speechAvailable, speechHint, transcribe, sniff, splitJsonStream, parseWav, badKey,
  viaGemini,
  SYNC_LIMIT_SEC, SYNC_LIMIT_BYTES,
};
