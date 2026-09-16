'use strict';

/**
 * Живая проверка ключей: работает ли распознавание на самом деле.
 *
 *   cd /opt/trapeza && node tools/keys-check.js
 *
 * Проверять «заполнена ли переменная» бессмысленно: заполнить можно чем
 * угодно. Поэтому скрипт делает по одному настоящему обращению к каждому
 * сервису и показывает, что ответили. Это стоит доли копейки: картинка
 * размером в один пиксель и секунда тишины.
 *
 * Код ответа важнее текста ошибки, и мы его переводим:
 *   401 — ключ неверный или не тот;
 *   403 — ключ верный, но прав не хватает (у сервисного аккаунта нет роли);
 *   400 — до сервиса дошли, он спорит с содержимым запроса — для нас это
 *         тоже успех: значит ключ приняли.
 *
 * Ничего не меняет: только читает .env и спрашивает.
 */

const path = require('node:path');

const fs = require('node:fs');

const APP = path.join(__dirname, '..');

/*
 * Читаем .env сами и перекрываем окружение.
 *
 * Встроенный process.loadEnvFile() (как и --env-file) уже заданную
 * переменную не трогает. А в живой сессии она почти наверняка задана: перед
 * этим человек выполнял `set -a && . ./.env` ради curl-проверки. Потом он
 * правит .env, запускает проверку в том же окне — и видит старые ключи.
 * Час уходит на поиски того, чего нет.
 *
 * Здесь проверяется именно файл, поэтому файл и главнее. Расхождение
 * показываем: молча подменять окружение тоже нельзя.
 */
const WATCH = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID',
  'GEMINI_API_KEY', 'GEMINI_BASE_URL',
  'VISION_PROVIDER', 'VISION_MODEL', 'SPEECH_PROVIDER', 'AI_ENABLED', 'AI_MODEL', 'AI_PROVIDER',
  'SEARCH_PROVIDER', 'AI_TAX_ANSWERS', 'PLATEGA_MERCHANT_ID', 'PLATEGA_SECRET', 'PLATEGA_API_URL',
  'SPEECH_MODEL'];
const shadowed = [];
try {
  const raw = fs.readFileSync(path.join(APP, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name] = m;
    const value = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (WATCH.includes(name) && process.env[name] !== undefined && process.env[name] !== value) {
      shadowed.push(name);
    }
    process.env[name] = value;
  }
} catch (_) { /* файла нет — значит переменные пришли из systemd */ }

let done = 0;                       // сколько живых обращений прошло
const ok = (m) => { console.log(`  ✅ ${m}`); done += 1; };
const no = (m) => { console.log(`  ❌ ${m}`); bad += 1; };
const skip = (m) => console.log(`  ·  ${m}`);
let bad = 0;

/**
 * Ключ целиком из латиницы и цифр?
 *
 * При копировании из письма или консоли в него попадает то кириллическая
 * «с», то длинное тире, то неразрывный пробел. В заголовок HTTP такое не
 * помещается вовсе, и ошибка выходит про «ByteString» — по ней никто не
 * догадается, что надо просто перевставить ключ.
 */
function checkAscii(value, name) {
  const bad2 = [...String(value)].find((c) => c.charCodeAt(0) > 126 || c.charCodeAt(0) < 33);
  if (!bad2) return '';
  const code = bad2.charCodeAt(0);
  return `в ${name} попал посторонний символ (${code === 32 ? 'пробел' : `«${bad2}»`}) — `
    + 'скопируйте ключ заново, целиком и без пробелов по краям';
}

/**
 * Что означает код ответа.
 *
 * Тело ответа показываем всегда: коды у сервисов значат разное, и по одному
 * числу диагноз не поставить. Живой пример — SpeechKit вернул 401, а внутри
 * оказался PermissionDenied: по коду это «ключ не тот», по тексту — «роли
 * нет». Скрипт, который печатает только своё толкование, в таком случае
 * отправляет человека чинить не то.
 */
function why(status, body) {
  const tail = String(body || '').replace(/\s+/g, ' ').slice(0, 300);
  if (/Permission ?denied|Permission to/i.test(tail)) {
    return `прав не хватает (${status}). Ответ сервиса:\n      ${tail}`;
  }
  if (status === 401) return `ключ не принят (401). Ответ сервиса:\n      ${tail}`;
  if (status === 403) return `доступ запрещён (403). Ответ сервиса:\n      ${tail}`;
  if (status === 429) return `слишком много запросов или кончилась квота (429).\n      ${tail}`;
  if (status >= 500) return `сервис отвечает ошибкой (${status}).\n      ${tail}`;
  return `${status}. Ответ сервиса:\n      ${tail}`;
}

/**
 * Речь через Gemini — тем же вызовом, что в бою.
 *
 * Шлём секунду тишины настоящим WAV: распознать в ней нечего, и это
 * правильный ответ. Проверяем не текст, а то, что запрос приняли — ключ,
 * модель и формат. Обёртка именно настоящая: Gemini разбирает контейнер
 * сам, и на подделке ответил бы ошибкой формата, а мы решили бы, что дело
 * в ключе.
 */
async function checkSpeechGemini() {
  if (!process.env.GEMINI_API_KEY) { skip('Голос: GEMINI_API_KEY не заполнен'); return; }
  const dirty = checkAscii(process.env.GEMINI_API_KEY, 'GEMINI_API_KEY');
  if (dirty) { no(`Голос: ${dirty}`); return; }
  const model = process.env.SPEECH_MODEL || process.env.AI_MODEL || 'gemini-3.6-flash';
  try {
    /*
     * Настоящий WAV из тишины: у Gemini контейнер разбирается сам, и
     * подсунуть ему что попало нельзя — он ответит ошибкой о формате, и мы
     * решим, что дело в ключе.
     */
    const rate = 16000;
    const pcm = Buffer.alloc(rate * 2);          // секунда тишины
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
    head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
    head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
    const got = await speech.viaGemini(Buffer.concat([head, pcm]), 'wav');
    ok(`Голос: модель ${model} приняла запись`);
    if (got.usage) {
      console.log(`      расход: вход ${got.usage.in} токенов за секунду тишины`);
      console.log('      Звук считается токенами (~25 на секунду) и приходит в ответе —');
      console.log('      значит минуты считаются по факту, а не по цене из настроек.');
    }
  } catch (e) {
    const m = String(e.message || '');
    if (/API key not valid|API_KEY_INVALID/i.test(m)) {
      no('Голос: ключ GEMINI_API_KEY не принят — перевыпустите в Google AI Studio');
    } else if (/403|location is not supported/i.test(m)) {
      no(`Голос: обращение отклонено до проверки ключа.\n      ${m.slice(0, 200)}`);
    } else if (/404|not found/i.test(m)) {
      no(`Голос: модели «${model}» у этого ключа нет.\n      ${m.slice(0, 200)}`);
    } else {
      no(`Голос: ${m.slice(0, 250)}`);
    }
  }
}

/** Секунда тихого тона: настоящий звук, но распознавать в нём нечего. */
function tone(seconds = 1, rate = 16000) {
  const pcm = Buffer.alloc(seconds * rate * 2);
  for (let i = 0; i < seconds * rate; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 1200), i * 2);
  }
  return pcm;
}

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function checkAnthropic(model, what) {
  if (!process.env.ANTHROPIC_API_KEY) { skip(`${what}: ANTHROPIC_API_KEY не заполнен`); return; }
  const dirty = checkAscii(process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY');
  if (dirty) { no(`${what}: ${dirty}`); return; }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } },
            { type: 'text', text: 'Ответь одним словом: ок' },
          ],
        }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    if (res.ok) { ok(`${what}: модель ${model} отвечает`); return; }
    // Отдельно ловим пустой баланс: код тот же 400, а лечится иначе.
    if (/credit balance|insufficient/i.test(body)) {
      no(`${what}: ключ рабочий, но на счету нет средств — пополните баланс в консоли`);
      return;
    }
    if (/model/i.test(body) && res.status === 404) {
      no(`${what}: такой модели нет — проверьте написание «${model}»`);
      return;
    }
    /*
     * 403 у Anthropic — это не «неверный ключ»: на чужой ключ приходит 401
     * (проверено). 403 отдаётся до проверки ключа, на границе, и обычно
     * означает, что обращение пришло оттуда, откуда сервис не работает.
     * Диагноз ставит не скрипт, а текст ответа — печатаем его целиком.
     */
    if (res.status === 403) {
      no(`${what}: обращение отклонено до проверки ключа (403).\n`
        + `      Ответ: ${String(body).replace(/\s+/g, ' ').slice(0, 300)}\n`
        + '      На неверный ключ Anthropic отвечает 401, а не 403, — значит дело не в ключе.\n'
        + '      Чаще всего так отвечают на обращение из страны, где сервис не работает.\n'
        + `      IP этого сервера: ${'проверьте curl -s https://api.ipify.org'}`);
      return;
    }
    no(`${what}: ${why(res.status, body)}`);
  } catch (e) {
    no(`${what}: не достучались — ${e.message}`);
  }
}

/**
 * Разбор фразы через OpenRouter.
 *
 * Проверяем не «принял ли ключ», а то, ради чего всё затевалось: доходит ли
 * до модели наша инструкция и возвращает ли она разбор, которому можно
 * верить. Поэтому шлём настоящую фразу — такую, которую местные регулярки
 * специально не ловят, — и смотрим на ответ глазами того же кода, что стоит
 * в бою (ai.sanitize).
 *
 * Так ловится главная опасность смены модели: ключ рабочий, ответ приходит,
 * а внутри вместо JSON — вежливое «Конечно, вот что я понял…». Бот на таком
 * молча отвечает «не понял», и списать это на модель никто не догадается.
 */
async function checkOpenRouter(model, what) {
  if (!process.env.OPENROUTER_API_KEY) { skip(`${what}: OPENROUTER_API_KEY не заполнен`); return; }
  const dirty = checkAscii(process.env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY');
  if (dirty) { no(`${what}: ${dirty}`); return; }

  const PHRASE = 'надо бы выставить Заре за аренду тридцать тысяч';
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://pervichkaru.ru',
        'X-Title': 'Pervichka App',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0.1,
        messages: [
          { role: 'system', content: ai.SYSTEM },
          { role: 'user', content: PHRASE },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();

    if (!res.ok) {
      // 402 у OpenRouter — пустой баланс. Код редкий, а причина частая.
      if (res.status === 402 || /insufficient|credits?/i.test(body)) {
        no(`${what}: ключ рабочий, но на счету нет средств — пополните баланс OpenRouter`);
        return;
      }
      if (res.status === 404 || /not a valid model|no endpoints/i.test(body)) {
        no(`${what}: модели «${model}» у OpenRouter нет или она недоступна.\n`
          + '      Список рабочих: https://openrouter.ai/models — возьмите id оттуда целиком.\n'
          + `      Ответ: ${String(body).replace(/\s+/g, ' ').slice(0, 200)}`);
        return;
      }
      no(`${what}: ${why(res.status, body)}`);
      return;
    }

    let reply = '';
    try {
      reply = ((JSON.parse(body).choices || [{}])[0].message || {}).content || '';
    } catch (_) { /* разберёмся ниже */ }
    if (!reply) { no(`${what}: модель ответила пусто.\n      ${body.slice(0, 200)}`); return; }

    // Тот же путь, что в бою: вытащить JSON и проверить его на допустимость.
    let intent = null;
    try {
      const m = /\{[\s\S]*\}/.exec(reply);
      intent = ai.sanitize(m ? JSON.parse(m[0]) : null);
    } catch (_) { intent = { action: 'unknown' }; }

    if (intent.action === 'draft') {
      ok(`${what}: модель ${model} разобрала фразу — ${JSON.stringify(intent)}`);
      return;
    }
    if (intent.action === 'unknown') {
      no(`${what}: модель отвечает, но не по инструкции — вместо JSON пришло:\n`
        + `      ${reply.replace(/\s+/g, ' ').slice(0, 200)}\n`
        + '      Ключ и модель рабочие, но такой ответ бот понять не сможет.\n'
        + '      Возьмите модель посильнее в AI_MODEL.');
      return;
    }
    no(`${what}: разбор получился, но не тот — ждали «выписать документ», `
      + `пришло ${JSON.stringify(intent)}`);
  } catch (e) {
    no(`${what}: не достучались — ${e.message}`);
  }
}

/**
 * Куда сервер выходит в интернет.
 *
 * Нужно ровно в одном случае: провайдер ответил 403 до проверки ключа.
 * Тогда вопрос не «тот ли ключ», а «откуда пришло обращение», и адрес —
 * единственное, что на этот вопрос отвечает. Спрашиваем только при отказе,
 * а не при каждом запуске: лишний поход наружу ради строчки в выводе.
 */
async function outboundIp() {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(7000) });
    return res.ok ? (await res.text()).trim() : '';
  } catch (_) { return ''; }
}

/**
 * Разбор фразы через Gemini — тот же вызов, что в lib/ai-agent.js.
 *
 * Проверяем не «принял ли ключ», а весь путь целиком: шлём живую фразу,
 * которую местные регулярки специально не ловят, и смотрим на ответ тем же
 * кодом, что стоит в бою (ai.sanitize). Ключ рабочий, ответ приходит, а
 * внутри вместо JSON вежливое «конечно, вот что я понял» — бот на таком
 * молча говорит «не понял», и догадаться неоткуда.
 */
async function checkGemini(model, what) {
  if (!process.env.GEMINI_API_KEY) { skip(`${what}: GEMINI_API_KEY не заполнен`); return; }
  const dirty = checkAscii(process.env.GEMINI_API_KEY, 'GEMINI_API_KEY');
  if (dirty) { no(`${what}: ${dirty}`); return; }

  const baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const PHRASE = 'надо бы выставить Заре за аренду тридцать тысяч';
  try {
    const res = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: ai.SYSTEM }] },
        contents: [{ parts: [{ text: PHRASE }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1500, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();

    if (!res.ok) {
      /*
       * 403 у Google — это отказ на границе, до всякой проверки ключа: на
       * неверный ключ приходит 400 с «API key not valid». Так отвечают
       * обращению из страны, где сервис не работает, — с российского адреса
       * этим уже встретили Anthropic и OpenRouter.
       */
      if (res.status === 403 || /location is not supported|user location/i.test(body)) {
        const ip = await outboundIp();
        no(`${what}: обращение отклонено до проверки ключа (${res.status}).\n`
          + `      Ответ: ${String(body).replace(/\s+/g, ' ').slice(0, 300)}\n`
          + '      На неверный ключ Google отвечает 400 «API key not valid», а не так, —\n'
          + '      значит дело не в ключе, а в том, откуда пришло обращение.\n'
          + `      Этот сервер выходит с адреса: ${ip || 'узнать не вышло'}\n`
          + '      Рабочий путь с российского адреса — YandexGPT: AI_PROVIDER=yandexgpt');
        return;
      }
      if (/API key not valid|API_KEY_INVALID/i.test(body)) {
        no(`${what}: ключ GEMINI_API_KEY не принят — перевыпустите его в Google AI Studio`);
        return;
      }
      if (res.status === 404 || /is not found|not supported/i.test(body)) {
        no(`${what}: модели «${model}» у этого ключа нет.\n`
          + `      Ответ: ${String(body).replace(/\s+/g, ' ').slice(0, 200)}\n`
          + '      Проверьте написание в AI_MODEL.');
        return;
      }
      if (res.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(body)) {
        no(`${what}: квота исчерпана (429) — подождите или поднимите лимит в консоли Google`);
        return;
      }
      no(`${what}: ${why(res.status, body)}`);
      return;
    }

    let reply = '';
    let usage = null;
    try {
      const data = JSON.parse(body);
      reply = ((((data.candidates || [])[0] || {}).content || {}).parts || [{}])[0].text || '';
      usage = data.usageMetadata || null;
    } catch (_) { /* разберёмся ниже */ }
    if (!reply) { no(`${what}: модель ответила пусто.\n      ${body.slice(0, 200)}`); return; }

    let intent = null;
    try {
      const m = /\{[\s\S]*\}/.exec(reply);
      intent = ai.sanitize(m ? JSON.parse(m[0]) : null);
    } catch (_) { intent = { action: 'unknown' }; }

    if (intent.action === 'draft') {
      ok(`${what}: модель ${model} разобрала фразу — ${JSON.stringify(intent)}`);
      /*
       * Заодно показываем расход: именно по этим полям бот считает копейки,
       * и если провайдер их не вернул, счётчик молча покажет ноль.
       */
      if (usage) {
        const cached = Number(usage.cachedContentTokenCount) || 0;
        console.log(`      расход: вход ${usage.promptTokenCount || 0}, выход `
          + `${usage.candidatesTokenCount || 0}, из кэша ${cached}`
          + (cached ? ' — кэш подсказки работает' : ' — кэш подсказки не включился'));
      } else {
        console.log('      ⚠ расход в ответе не пришёл — счётчик копеек покажет ноль');
      }
      return;
    }
    if (intent.action === 'unknown') {
      no(`${what}: модель отвечает, но не по инструкции — вместо JSON пришло:\n`
        + `      ${reply.replace(/\s+/g, ' ').slice(0, 200)}\n`
        + '      Ключ и модель рабочие, но такой ответ бот понять не сможет.');
      return;
    }
    no(`${what}: разбор получился, но не тот — ждали «выписать документ», `
      + `пришло ${JSON.stringify(intent)}`);
  } catch (e) {
    no(`${what}: не достучались — ${e.message}`);
  }
}

/** Распознавание снимка через Gemini — тем же запросом, что в lib/vision.js. */
async function checkGeminiVision(model) {
  if (!process.env.GEMINI_API_KEY) { skip(`Фото: GEMINI_API_KEY не заполнен`); return; }
  const dirty = checkAscii(process.env.GEMINI_API_KEY, 'GEMINI_API_KEY');
  if (dirty) { no(`Фото: ${dirty}`); return; }
  const baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  try {
    const res = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Ответь одним словом: ок' },
            { inline_data: { mime_type: 'image/png', data: PNG_1PX } },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    if (res.ok) { ok(`Фото: модель ${model} принимает картинки`); return; }
    if (res.status === 403 || /location is not supported|user location/i.test(body)) {
      const ip = await outboundIp();
      no(`Фото: обращение отклонено до проверки ключа (${res.status}).\n`
        + `      Ответ: ${String(body).replace(/\s+/g, ' ').slice(0, 300)}\n`
        + `      Этот сервер выходит с адреса: ${ip || 'узнать не вышло'}\n`
        + '      Рабочий путь с российского адреса — VISION_PROVIDER=yandex');
      return;
    }
    if (/API key not valid|API_KEY_INVALID/i.test(body)) {
      no('Фото: ключ GEMINI_API_KEY не принят — перевыпустите его в Google AI Studio');
      return;
    }
    no(`Фото: ${why(res.status, body)}`);
  } catch (e) {
    no(`Фото: не достучались — ${e.message}`);
  }
}

/**
 * Разбор фразы через YandexGPT — тот же вызов, что в lib/ai-agent.js.
 *
 * Как и у остальных, проверяем не «принял ли ключ», а весь путь: шлём живую
 * фразу, которую местные регулярки специально не ловят, и смотрим на ответ
 * тем же кодом, что стоит в бою.
 */
async function checkYandexGpt(model) {
  const key = process.env.YANDEX_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) { skip('Фразы: YANDEX_API_KEY или YANDEX_FOLDER_ID не заполнен'); return; }
  const dirty = checkAscii(key, 'YANDEX_API_KEY') || checkAscii(folder, 'YANDEX_FOLDER_ID')
    || speech.badKey(key);
  if (dirty) { no(`Фразы: ${dirty}`); return; }

  const uri = String(model).startsWith('gpt://') ? String(model) : `gpt://${folder}/${model}`;
  const PHRASE = 'надо бы выставить Заре за аренду тридцать тысяч';
  try {
    const res = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Api-Key ${key}`,
        'x-folder-id': folder,
        'x-data-logging-enabled': 'false',
      },
      body: JSON.stringify({
        modelUri: uri,
        completionOptions: { stream: false, temperature: 0.1, maxTokens: '400' },
        messages: [
          { role: 'system', text: ai.SYSTEM },
          { role: 'user', text: PHRASE },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();

    if (!res.ok) {
      // Ключ у Яндекса прав не даёт: роль выдаётся отдельно сервисному аккаунту.
      if (/Permission ?denied|Permission to/i.test(body)) {
        no('Фразы: у сервисного аккаунта нет роли ai.languageModels.user в этом каталоге.\n'
          + '      Роль выдаётся тому аккаунту, чьим ключом вы пользуетесь, и в том\n'
          + `      каталоге, что указан в YANDEX_FOLDER_ID (${folder}).\n`
          + `      Ответ: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
        return;
      }
      if (/model|modelUri/i.test(body) && (res.status === 400 || res.status === 404)) {
        no(`Фразы: модель «${uri}» не найдена — проверьте написание AI_MODEL.\n`
          + `      Ответ: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
        return;
      }
      no(`Фразы: ${why(res.status, body)}`);
      return;
    }

    let reply = '';
    try {
      reply = (((JSON.parse(body).result || {}).alternatives || [{}])[0].message || {}).text || '';
    } catch (_) { /* разберёмся ниже */ }
    if (!reply) { no(`Фразы: модель ответила пусто.\n      ${body.slice(0, 200)}`); return; }

    let intent = null;
    try {
      const m = /\{[\s\S]*\}/.exec(reply);
      intent = ai.sanitize(m ? JSON.parse(m[0]) : null);
    } catch (_) { intent = { action: 'unknown' }; }

    if (intent.action === 'draft') {
      ok(`Фразы: модель ${uri.split('/').slice(-2).join('/')} разобрала фразу — ${JSON.stringify(intent)}`);
      return;
    }
    if (intent.action === 'unknown') {
      no('Фразы: модель отвечает, но не по инструкции — вместо JSON пришло:\n'
        + `      ${reply.replace(/\s+/g, ' ').slice(0, 200)}\n`
        + '      Ключ и модель рабочие. Попробуйте модель посильнее:\n'
        + '      AI_MODEL=yandexgpt/latest вместо yandexgpt-lite/latest.');
      return;
    }
    no(`Фразы: разбор получился, но не тот — ждали «выписать документ», пришло ${JSON.stringify(intent)}`);
  } catch (e) {
    no(`Фразы: не достучались — ${e.message}`);
  }
}

/**
 * Разбор фразы через xAI (Grok) — тот же вызов, что в lib/ai-agent.js.
 *
 * Проверяем весь путь, а не наличие ключа: шлём живую фразу и смотрим на
 * ответ тем же кодом, что стоит в бою. Отдельно разобран несуществующий id
 * модели — у xAI набор меняется, и это самая частая причина отказа.
 */
async function checkGrok(model) {
  if (!process.env.XAI_API_KEY) { skip('Фразы: XAI_API_KEY не заполнен'); return; }
  if (!model) {
    no('Фразы: не задан AI_MODEL. Список моделей:\n'
      + '      curl -H "Authorization: Bearer $XAI_API_KEY" https://api.x.ai/v1/models');
    return;
  }
  const dirty = checkAscii(process.env.XAI_API_KEY, 'XAI_API_KEY');
  if (dirty) { no(`Фразы: ${dirty}`); return; }

  const PHRASE = 'надо бы выставить Заре за аренду тридцать тысяч';
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0.1,
        messages: [
          { role: 'system', content: ai.SYSTEM },
          { role: 'user', content: PHRASE },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();

    if (!res.ok) {
      if (res.status === 404 || /model/i.test(body)) {
        no(`Фразы: модели «${model}» у xAI нет.\n`
          + '      Список: curl -H "Authorization: Bearer $XAI_API_KEY" https://api.x.ai/v1/models\n'
          + `      Ответ: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
        return;
      }
      if (res.status === 403) {
        no('Фразы: обращение отклонено до проверки ключа (403).\n'
          + `      Ответ: ${body.replace(/\s+/g, ' ').slice(0, 200)}\n`
          + '      Так отвечают на обращение оттуда, где сервис не работает.');
        return;
      }
      no(`Фразы: ${why(res.status, body)}`);
      return;
    }

    let reply = '';
    try { reply = ((JSON.parse(body).choices || [{}])[0].message || {}).content || ''; } catch (_) { /* ниже */ }
    if (!reply) { no(`Фразы: модель ответила пусто.\n      ${body.slice(0, 200)}`); return; }

    let intent = null;
    try {
      const m = /\{[\s\S]*\}/.exec(reply);
      intent = ai.sanitize(m ? JSON.parse(m[0]) : null);
    } catch (_) { intent = { action: 'unknown' }; }

    if (intent.action === 'draft') { ok(`Фразы: модель ${model} разобрала фразу — ${JSON.stringify(intent)}`); return; }
    if (intent.action === 'unknown') {
      no('Фразы: модель отвечает, но не по инструкции — вместо JSON пришло:\n'
        + `      ${reply.replace(/\s+/g, ' ').slice(0, 200)}`);
      return;
    }
    no(`Фразы: разбор получился, но не тот — ждали «выписать документ», пришло ${JSON.stringify(intent)}`);
  } catch (e) {
    no(`Фразы: не достучались — ${e.message}`);
  }
}

/** Распознавание картинки через OpenRouter — тот же вызов, что в lib/vision.js. */
async function checkOpenRouterVision(model) {
  if (!process.env.OPENROUTER_API_KEY) { skip('Фото: OPENROUTER_API_KEY не заполнен'); return; }
  const dirty = checkAscii(process.env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY');
  if (dirty) { no(`Фото: ${dirty}`); return; }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://pervichkaru.ru',
        'X-Title': 'Pervichka App',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Ответь одним словом: ок' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1PX}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    if (res.ok) { ok(`Фото: модель ${model} принимает картинки`); return; }
    if (res.status === 402 || /insufficient|credits?/i.test(body)) {
      no('Фото: ключ рабочий, но на счету нет средств — пополните баланс OpenRouter');
      return;
    }
    if (res.status === 404 || /not a valid model|no endpoints/i.test(body)) {
      no(`Фото: модели «${model}» у OpenRouter нет или она недоступна.\n`
        + '      Список: https://openrouter.ai/models — нужна с пометкой про картинки.\n'
        + `      Ответ: ${String(body).replace(/\s+/g, ' ').slice(0, 200)}`);
      return;
    }
    // Модель без зрения отвечает не 404, а спором про содержимое запроса.
    if (/image|vision|modality/i.test(body)) {
      no(`Фото: модель «${model}» картинки не принимает — возьмите ту, что умеет смотреть.\n`
        + `      Ответ: ${String(body).replace(/\s+/g, ' ').slice(0, 200)}`);
      return;
    }
    no(`Фото: ${why(res.status, body)}`);
  } catch (e) {
    no(`Фото: не достучались — ${e.message}`);
  }
}

/** Распознавание картинки Яндексом — тот же вызов, что в lib/vision.js. */
async function checkYandexVision() {
  const key = process.env.YANDEX_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) { skip('Фото: YANDEX_API_KEY или YANDEX_FOLDER_ID не заполнен'); return; }
  const dirty = checkAscii(key, 'YANDEX_API_KEY') || checkAscii(folder, 'YANDEX_FOLDER_ID')
    || speech.badKey(key);
  if (dirty) { no(`Фото: ${dirty}`); return; }
  try {
    const res = await fetch('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${key}`,
        'x-folder-id': folder,
        'x-data-logging-enabled': 'false',
      },
      body: JSON.stringify({
        mimeType: 'image/png', languageCodes: ['ru', 'en'], model: 'page', content: PNG_1PX,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    if (res.ok) { ok('Фото: Yandex Vision принял ключ (в пикселе текста нет — так и надо)'); return; }
    if (/Permission ?denied|Permission to/i.test(body)) {
      no('Фото: у сервисного аккаунта нет роли ai.vision.user в этом каталоге.\n'
        + `      Ответ: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
      return;
    }
    no(`Фото: ${why(res.status, body)}`);
  } catch (e) {
    no(`Фото: не достучались — ${e.message}`);
  }
}

async function checkSpeech() {
  const key = process.env.YANDEX_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) { skip('Голос: YANDEX_API_KEY или YANDEX_FOLDER_ID не заполнен'); return; }
  const dirty = checkAscii(key, 'YANDEX_API_KEY') || checkAscii(folder, 'YANDEX_FOLDER_ID')
    || speech.badKey(key);
  if (dirty) { no(`Голос: ${dirty}`); return; }
  try {
    const res = await fetch(
      'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?lang=ru-RU&topic=general&format=lpcm&sampleRateHertz=16000',
      {
        method: 'POST',
        headers: { Authorization: `Api-Key ${key}` },
        body: tone(),
        signal: AbortSignal.timeout(60000),
      },
    );
    const body = await res.text();
    if (res.ok) {
      // В тоне слов нет, и пустой результат — это правильный ответ.
      ok('Голос: SpeechKit принял ключ и распознал запись (слов в тоне нет — так и надо)');
      return;
    }
    /*
     * Коду верить нельзя: с боевого сервера пришёл 401, а внутри тела —
     * PermissionDenied, то есть ключ приняли, но роли у аккаунта нет. По
     * одному числу это читается как «ключ не тот», и человек идёт
     * перевыпускать рабочий ключ. Поэтому смотрим в текст.
     */
    if (/Permission ?denied|Permission to/i.test(body)) {
      const folder = (/resource-manager\.folder (\S+?)[,\]]/.exec(body) || [])[1];
      no('Голос: у сервисного аккаунта нет прав на распознавание речи.\n'
        + `      Каталог из ответа: ${folder || 'не разобрал'}\n`
        + '      Проверьте две вещи:\n'
        + '      1) роль ai.speechkit-stt.user выдана ТОМУ аккаунту, чьим API-ключом\n'
        + '         вы пользуетесь (легко перепутать, если аккаунтов несколько);\n'
        + '      2) роль выдана в ТОМ каталоге, что указан выше и в YANDEX_FOLDER_ID.');
      return;
    }
    no(`Голос: ${why(res.status, body)}`);
  } catch (e) {
    no(`Голос: не достучались — ${e.message}`);
  }
}

/**
 * Второй метод распознавания — для длинных записей.
 *
 * Проверять надо оба, и вот почему. Быстрый метод обходится одним ключом и
 * каталога не спрашивает; длинный ходит в другой сервис, с заголовком
 * x-folder-id, и требует роли в этом каталоге. Пока проверялся только
 * быстрый, отчёт показывал «голос — готово», а голосовые длиннее
 * тридцати секунд падали с PermissionDenied — и человек в приложении видел
 * ошибку там, где диагностика клялась, что всё хорошо.
 */
async function checkSpeechLong() {
  const key = process.env.YANDEX_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) return;                       // о нехватке сказал быстрый метод
  try {
    const res = await fetch('https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${key}`,
        'x-folder-id': folder,
      },
      body: JSON.stringify({
        content: tone().toString('base64'),
        recognitionModel: {
          model: 'general',
          audioFormat: { rawAudio: { audioEncoding: 'LINEAR16_PCM', sampleRateHertz: 16000, audioChannelCount: 1 } },
          languageRestriction: { restrictionType: 'WHITELIST', languageCode: ['ru-RU'] },
        },
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    if (res.ok) { ok('Голос длинный: задание принято (так и надо)'); return; }
    if (/Permission ?denied|Permission to/i.test(body)) {
      const f = (/resource-manager\.folder (\S+?)[,\]]/.exec(body) || [])[1];
      no('Голос длинный: нет прав на распознавание длинных записей.\n'
        + `      Каталог из ответа: ${f || 'не разобрал'}, в .env указан: ${folder}\n`
        + '      Роль ai.speechkit-stt.user нужна тому аккаунту, чьим ключом вы\n'
        + '      пользуетесь, и в том каталоге, что стоит в YANDEX_FOLDER_ID.\n'
        + '      Короткие записи при этом работают — они каталога не спрашивают.');
      return;
    }
    no(`Голос длинный: ${why(res.status, body)}`);
  } catch (e) {
    no(`Голос длинный: не достучались — ${e.message}`);
  }
}

// Подключаем до вывода: ai-agent тянет базу, а она печатает предупреждение
// про экспериментальный SQLite — пусть оно будет до отчёта, а не внутри него.
const vision = require(path.join(APP, 'lib/vision'));
const speech = require(path.join(APP, 'lib/speech'));
const ai = require(path.join(APP, 'lib/ai-agent'));
const searchLib = require(path.join(APP, 'lib/search'));
const platega = require(path.join(APP, 'lib/platega'));

(async () => {
  if (shadowed.length) {
    console.log('\n  ⚠ В этой сессии остались старые значения из прошлого запуска:');
    console.log(`      ${shadowed.join(', ')}`);
    console.log('      Проверяю по файлу .env — он главнее. Но службы и другие');
    console.log('      команды в этом же окне возьмут старое: откройте новое');
    console.log('      подключение или выполните  exec bash');
  }

  console.log('\n── что включено в .env ──');
  console.log(`  фото  : ${process.env.VISION_PROVIDER || 'не задан'}`
    + `  модель ${process.env.VISION_MODEL || 'claude-sonnet-5'}`);
  console.log(`  голос : ${process.env.SPEECH_PROVIDER || 'не задан'}`);
  console.log(`  фразы : ${process.env.AI_ENABLED === '1' ? 'включены' : 'выключены (AI_ENABLED не 1)'}`
    + `  модель ${process.env.AI_MODEL || ai.MODEL_DEFAULT}`);

  console.log('\n── модули видят настройки ──');
  /*
   * Выключенное намеренно — не поломка. Раньше скрипт считал ошибкой и то,
   * что человек сознательно не включал, всегда завершался ненулевым кодом,
   * и «Не в порядке: 3» переставало что-либо значить.
   */
  const state = (avail, hint, off, name) => {
    if (avail) ok(`${name} — готово`);
    else if (off) skip(`${name} — выключено намеренно`);
    else no(`${name} — ${hint}`);
  };
  state(vision.visionAvailable(), vision.visionHint(), !process.env.VISION_PROVIDER, 'фото');
  state(speech.speechAvailable(), speech.speechHint(), !process.env.SPEECH_PROVIDER, 'голос');
  state(ai.aiAvailable(), ai.aiHint(), process.env.AI_ENABLED !== '1', 'фразы');

  console.log('\n── живые обращения к сервисам ──');

  // Спрашиваем ровно тот сервис, который выбран в .env. Раньше скрипт
  // всегда ломился в Anthropic и показывал его отказ даже там, где
  // распознавание давно переключено на Яндекс.
  /*
   * Умолчания здесь — те же, что в самих модулях, а не «не задан».
   *
   * Раньше при пустом VISION_PROVIDER проверка говорила «распознавание
   * выключено» и ничего не спрашивала. А lib/vision.js при пустой
   * переменной берёт gemini и с ключом работает — то есть бот распознавал
   * снимки, а проверка уверяла, что распознавания нет. Расхождение между
   * инструментом и кодом хуже отсутствия инструмента: ему верят.
   */
  const vp = String(process.env.VISION_PROVIDER || 'gemini').toLowerCase();
  if (vp === 'anthropic') await checkAnthropic(process.env.VISION_MODEL || 'claude-sonnet-5', 'Фото');
  else if (vp === 'openrouter') {
    await checkOpenRouterVision(process.env.VISION_MODEL || 'anthropic/claude-sonnet-4.5');
  } else if (vp === 'yandex') await checkYandexVision();
  else if (vp === 'gemini') await checkGeminiVision(process.env.VISION_MODEL || 'gemini-3.6-flash');
  else skip(`Фото: провайдер ${vp} — этой проверкой не покрыт`);

  const ap = String(process.env.AI_PROVIDER || 'gemini').toLowerCase();
  if (process.env.AI_ENABLED !== '1') skip('Фразы: AI_ENABLED не 1 — свободный ввод выключен');
  else if (ap === 'yandexgpt') await checkYandexGpt(process.env.AI_MODEL || ai.MODEL_DEFAULT);
  else if (ap === 'grok') await checkGrok(String(process.env.AI_MODEL || '').trim());
  else if (ap === 'anthropic') await checkAnthropic(process.env.AI_MODEL || ai.MODEL_DEFAULT, 'Фразы');
  else if (ap === 'openrouter') await checkOpenRouter(process.env.AI_MODEL || ai.MODEL_DEFAULT, 'Фразы');
  else if (ap === 'gemini') await checkGemini(process.env.AI_MODEL || 'gemini-3.6-flash', 'Фразы');
  else skip(`Фразы: провайдер ${ap} — этой проверкой не покрыт`);

  /*
   * Приём оплаты. Проверяем не «заполнены ли переменные», а принимает ли их
   * площадка: ключ можно перевыпустить и забыть обновить, и узнать об этом
   * на первом настоящем платеже — то есть на чужих деньгах.
   *
   * Спрашиваем несуществующую транзакцию. Это ничего не создаёт и ничего не
   * стоит, а ответ говорит ровно то, что нужно:
   *   401/403 — ключи не приняты, платежи работать не будут;
   *   404     — ключи приняты, просто такой транзакции нет. Это успех.
   */
  if (!platega.isConfigured()) {
    skip('Оплата: PLATEGA_MERCHANT_ID или PLATEGA_SECRET не заполнены — кнопка СБП не показывается');
  } else {
    const dirtyM = checkAscii(process.env.PLATEGA_MERCHANT_ID, 'PLATEGA_MERCHANT_ID');
    const dirtyS = checkAscii(process.env.PLATEGA_SECRET, 'PLATEGA_SECRET');
    if (dirtyM || dirtyS) no(`Оплата: ${dirtyM || dirtyS}`);
    else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(String(process.env.PLATEGA_MERCHANT_ID).trim())) {
      no('Оплата: PLATEGA_MERCHANT_ID не похож на UUID из кабинета '
        + '(вида 7b7ed2b3-16a7-49da-8076-b2f63498858b) — проверьте, что скопирован целиком');
    } else {
      const base = (process.env.PLATEGA_API_URL || 'https://app.platega.io').replace(/\/+$/, '');
      const probe = '00000000-0000-4000-8000-000000000000';
      try {
        const res = await fetch(`${base}/transaction/${probe}`, {
          method: 'GET',
          headers: {
            'X-MerchantId': String(process.env.PLATEGA_MERCHANT_ID).trim(),
            'X-Secret': String(process.env.PLATEGA_SECRET).trim(),
          },
          signal: AbortSignal.timeout(30000),
        });
        const body = await res.text();
        if (res.status === 401 || res.status === 403) {
          no(`Оплата: площадка не приняла ключи (${res.status}).\n`
            + `      Ответ: ${String(body).replace(/\s+/g, ' ').slice(0, 200)}\n`
            + '      Перевыпустите API-ключ в кабинете my.platega.io и впишите в .env.\n'
            + '      Он показывается целиком только один раз — сразу после перевыпуска.');
        } else if (res.status === 404 || res.ok) {
          ok('Оплата: Platega приняла ключи');
          console.log(`      Колбэк должен быть настроен на https://<ваш домен>/platega`);
        } else {
          no(`Оплата: ${why(res.status, body)}`);
        }
      } catch (e) {
        no(`Оплата: не достучались до Platega — ${e.message}`);
      }
    }
  }

  /*
   * Поиск по официальным сайтам. Проверять его надо живым запросом: из среды
   * разработки сайты ФНС недоступны, и весь модуль написан по документации.
   */
  const sep = String(process.env.SEARCH_PROVIDER || '').toLowerCase();
  if (!sep) skip('Поиск: SEARCH_PROVIDER не задан — ответы только из базы и по памяти модели');
  else if (!searchLib.searchAvailable()) no(`Поиск: ${searchLib.searchHint()}`);
  else {
    const r = await searchLib.search('фиксированные страховые взносы ИП срок уплаты', 3)
      .catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) {
      ok(`Поиск: нашлось ${r.results.length} на доверенных сайтах`);
      for (const one of r.results) console.log(`      ${one.source}: ${one.url}`);
    } else if (r.filtered) {
      no(`Поиск: выдача пришла (${r.filtered} шт.), но доверенных сайтов в ней нет.\n`
        + '      Это не поломка: значит по такому запросу ФНС и Минфин наверх не попали.\n'
        + '      Проверьте другим вопросом — модуль работает, отбор строгий намеренно.');
    } else {
      no(`Поиск: ${r.error}`);
    }
  }

  const sp = String(process.env.SPEECH_PROVIDER || '').toLowerCase();
  if (sp === 'yandex') { await checkSpeech(); await checkSpeechLong(); }
  else if (sp === 'gemini') await checkSpeechGemini();
  else skip('Голос: SPEECH_PROVIDER не задан — распознавание речи выключено');

  console.log(`\n${'='.repeat(52)}`);
  if (bad) console.log(`Не в порядке: ${bad}. Поправьте .env и запустите снова.`);
  else if (!done) console.log('Проверять нечего: всё распознавание выключено в .env.');
  else console.log('Всё отвечает. Присылайте боту голосовое и фото — должно работать.');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ПРОВЕРКА УПАЛА:', e.message); process.exit(1); });
