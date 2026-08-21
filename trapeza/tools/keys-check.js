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

const APP = path.join(__dirname, '..');
// Node 22 умеет читать .env сам. Под systemd переменные уже в окружении,
// поэтому отсутствие файла — не ошибка.
try { process.loadEnvFile(path.join(APP, '.env')); } catch (_) { /* значит уже в окружении */ }

const ok = (m) => console.log(`  ✅ ${m}`);
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
  if (/PermissionDenied|Permission to/i.test(tail)) {
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

async function checkSpeech() {
  const key = process.env.YANDEX_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) { skip('Голос: YANDEX_API_KEY или YANDEX_FOLDER_ID не заполнен'); return; }
  const dirty = checkAscii(key, 'YANDEX_API_KEY') || checkAscii(folder, 'YANDEX_FOLDER_ID');
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
    if (/PermissionDenied|Permission to/i.test(body)) {
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
  console.log('\n── что включено в .env ──');
  console.log(`  фото  : ${process.env.VISION_PROVIDER || 'не задан'}`
    + `  модель ${process.env.VISION_MODEL || 'claude-sonnet-5'}`);
  console.log(`  голос : ${process.env.SPEECH_PROVIDER || 'не задан'}`);
  console.log(`  фразы : ${process.env.AI_ENABLED === '1' ? 'включены' : 'выключены (AI_ENABLED не 1)'}`
    + `  модель ${process.env.AI_MODEL || ai.MODEL_DEFAULT}`);

  console.log('\n── модули видят настройки ──');
  if (vision.visionAvailable()) ok('фото — готово'); else no(`фото — ${vision.visionHint()}`);
  if (speech.speechAvailable()) ok('голос — готово'); else no(`голос — ${speech.speechHint()}`);
  if (ai.aiAvailable()) ok('фразы — готово'); else no(`фразы — ${ai.aiHint()}`);

  console.log('\n── живые обращения к сервисам ──');
  await checkAnthropic(process.env.VISION_MODEL || 'claude-sonnet-5', 'Фото');
  const aiModel = process.env.AI_MODEL || ai.MODEL_DEFAULT;
  if (aiModel === (process.env.VISION_MODEL || 'claude-sonnet-5')) {
    skip('Фразы: та же модель и тот же ключ — проверено выше');
  } else {
    await checkAnthropic(aiModel, 'Фразы');
  }
  await checkSpeech();

  console.log(`\n${'='.repeat(52)}`);
  console.log(bad
    ? `Не в порядке: ${bad}. Поправьте .env и запустите снова.`
    : 'Всё отвечает. Присылайте боту голосовое и фото — должно работать.');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ПРОВЕРКА УПАЛА:', e.message); process.exit(1); });
