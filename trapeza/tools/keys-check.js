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
  'VISION_PROVIDER', 'VISION_MODEL', 'SPEECH_PROVIDER', 'AI_ENABLED', 'AI_MODEL', 'AI_PROVIDER'];
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

// Подключаем до вывода: ai-agent тянет базу, а она печатает предупреждение
// про экспериментальный SQLite — пусть оно будет до отчёта, а не внутри него.
const vision = require(path.join(APP, 'lib/vision'));
const speech = require(path.join(APP, 'lib/speech'));
const ai = require(path.join(APP, 'lib/ai-agent'));

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
  const vp = String(process.env.VISION_PROVIDER || '').toLowerCase();
  if (vp === 'anthropic') await checkAnthropic(process.env.VISION_MODEL || 'claude-sonnet-5', 'Фото');
  else if (vp === 'openrouter') {
    await checkOpenRouterVision(process.env.VISION_MODEL || 'anthropic/claude-sonnet-4.5');
  } else if (vp === 'yandex') await checkYandexVision();
  else skip('Фото: VISION_PROVIDER не задан — распознавание выключено');

  const ap = String(process.env.AI_PROVIDER || 'yandexgpt').toLowerCase();
  if (process.env.AI_ENABLED !== '1') skip('Фразы: AI_ENABLED не 1 — свободный ввод выключен');
  else if (ap === 'yandexgpt') await checkYandexGpt(process.env.AI_MODEL || ai.MODEL_DEFAULT);
  else if (ap === 'grok') await checkGrok(String(process.env.AI_MODEL || '').trim());
  else if (ap === 'anthropic') await checkAnthropic(process.env.AI_MODEL || ai.MODEL_DEFAULT, 'Фразы');
  else if (ap === 'openrouter') await checkOpenRouter(process.env.AI_MODEL || ai.MODEL_DEFAULT, 'Фразы');
  else skip(`Фразы: провайдер ${ap} — этой проверкой не покрыт`);

  const sp = String(process.env.SPEECH_PROVIDER || '').toLowerCase();
  if (sp === 'yandex') await checkSpeech();
  else skip('Голос: SPEECH_PROVIDER не задан — распознавание речи выключено');

  console.log(`\n${'='.repeat(52)}`);
  if (bad) console.log(`Не в порядке: ${bad}. Поправьте .env и запустите снова.`);
  else if (!done) console.log('Проверять нечего: всё распознавание выключено в .env.');
  else console.log('Всё отвечает. Присылайте боту голосовое и фото — должно работать.');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ПРОВЕРКА УПАЛА:', e.message); process.exit(1); });
