'use strict';

/**
 * Сырой звук (PCM) → голосовое для Telegram (OGG/Opus) и WAV для браузера.
 *
 * Зачем это своё. Telegram показывает «пузырь» голосового только для OGG с
 * кодеком Opus (MP3 и M4A уходят обычным аудиофайлом). Gemini же отдаёт
 * синтезированную речь сырым PCM. Перекодировать нужно, а чем — вопрос:
 * ffmpeg на сервере сознательно не ставили, кодировщики Opus для Node — это
 * сторонние пакеты с нативной сборкой.
 *
 * Выход нашёлся в Chromium, который на сервере уже есть ради PDF: в нём
 * встроен кодировщик Opus (WebCodecs AudioEncoder). Он отдаёт голые пакеты,
 * а контейнер OGG — это простая обёртка из страниц с заголовком и CRC, её
 * собираем здесь же. Проверено на Chromium 141 из Playwright.
 *
 * WebCodecs работает только на «защищённой» странице — about:blank ей не
 * годится. Поэтому страница открывается по выдуманному https-адресу, который
 * Playwright отдаёт сам из памяти, в сеть ничего не уходит.
 */

const ENC_URL = 'https://opus-encoder.local/';
const OPUS_RATE = 48000;          // гранулы в OGG/Opus всегда в 48 кГц
const DEFAULT_PRESKIP = 312;      // задержка libopus при кадре 20 мс

/** WAV-заголовок поверх 16-битного моно PCM — его играет любой браузер. */
function pcmToWav(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// CRC страницы OGG — не тот, что в zlib: полином 0x04C11DB7 без отражения.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let k = 0; k < 8; k += 1) r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(buf) {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

function lacing(len) {
  const out = [];
  let n = len;
  while (n >= 255) { out.push(255); n -= 255; }
  out.push(n);   // пакет кратный 255 закрывается нулём — так велит формат
  return out;
}

function page({ packets, granule, serial, seq, flags }) {
  const seg = packets.flatMap((p) => lacing(p.length));
  const head = Buffer.alloc(27 + seg.length);
  head.write('OggS', 0);
  head[4] = 0;
  head[5] = flags;
  head.writeBigInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(seq, 18);
  head[26] = seg.length;
  Buffer.from(seg).copy(head, 27);
  const whole = Buffer.concat([head, ...packets]);
  whole.writeUInt32LE(oggCrc(whole), 22);
  return whole;
}

/**
 * Собрать OGG из пакетов Opus.
 *
 * @param {Buffer[]} packets пакеты в порядке выдачи кодировщика
 * @param {number[]} durations длительность каждого пакета в микросекундах
 * @param {{inputRate:number, samples:number, preskip?:number}} info
 */
function muxOggOpus(packets, durations, { inputRate, samples, preskip = DEFAULT_PRESKIP }) {
  const serial = 0x50455256;   // «PERV» — номер потока, любое постоянное число
  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead', 0);
  opusHead[8] = 1;               // версия
  opusHead[9] = 1;               // каналов
  opusHead.writeUInt16LE(preskip, 10);
  opusHead.writeUInt32LE(inputRate, 12);
  opusHead.writeInt16LE(0, 16);  // усиление
  opusHead[18] = 0;              // раскладка каналов: моно/стерео
  const vendor = Buffer.from('pervichka');
  const opusTags = Buffer.alloc(8 + 4 + vendor.length + 4);
  opusTags.write('OpusTags', 0);
  opusTags.writeUInt32LE(vendor.length, 8);
  vendor.copy(opusTags, 12);
  opusTags.writeUInt32LE(0, 12 + vendor.length);

  const pages = [
    page({ packets: [opusHead], granule: 0, serial, seq: 0, flags: 0x02 }),
    page({ packets: [opusTags], granule: 0, serial, seq: 1, flags: 0 }),
  ];
  // Конец потока — по настоящей длине звука, а не по последнему кадру:
  // кодировщик добивает хвост тишиной, и без этого запись «тянется».
  const end = preskip + Math.round(samples * OPUS_RATE / inputRate);
  let granule = preskip;
  let seq = 2;
  let batch = [];
  let lace = 0;
  const flush = (last) => {
    pages.push(page({
      packets: batch, granule: last ? Math.min(granule, end) : granule, serial, seq, flags: last ? 0x04 : 0,
    }));
    seq += 1; batch = []; lace = 0;
  };
  packets.forEach((p, i) => {
    const need = lacing(p.length).length;
    if (lace + need > 255 || batch.length >= 50) flush(false);
    batch.push(p);
    lace += need;
    granule += Math.round((durations[i] || 20000) * OPUS_RATE / 1e6);
  });
  if (batch.length || pages.length === 2) flush(true);
  else pages[pages.length - 1] = page({ packets: [], granule: end, serial, seq, flags: 0x04 });
  return Buffer.concat(pages);
}

/**
 * Закодировать PCM в Opus внутри Chromium. Возвращает пакеты и задержку.
 * Бросает, если браузера нет или кодировщик недоступен — вызывающий решает,
 * чем заменить (обычно — отправить ответ текстом).
 */
async function encodeOpus(pcm, sampleRate, { bitrate = 32000 } = {}) {
  const { withPage } = require('./pdf');
  return withPage(async (p) => {
    await p.route(`${ENC_URL}**`, (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><title>opus</title>',
    }));
    await p.goto(ENC_URL);
    return p.evaluate(async ({ b64, rate, br }) => {
      if (typeof AudioEncoder === 'undefined') throw new Error('в браузере нет WebCodecs');
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const s16 = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
      const f32 = new Float32Array(s16.length);
      for (let i = 0; i < s16.length; i += 1) f32[i] = s16[i] / 32768;
      const chunks = [];
      let head = null;
      const enc = new AudioEncoder({
        output: (chunk, meta) => {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          chunks.push({ bytes, duration: chunk.duration || 20000 });
          const d = meta && meta.decoderConfig && meta.decoderConfig.description;
          if (d && !head) head = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer);
        },
        error: (e) => { throw e; },
      });
      enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: br });
      enc.encode(new AudioData({
        format: 'f32', sampleRate: rate, numberOfFrames: f32.length, numberOfChannels: 1, timestamp: 0, data: f32,
      }));
      await enc.flush();
      enc.close();
      // Задержку кодировщика берём из его же заголовка, если он его дал.
      let preskip = null;
      if (head && head.length >= 12 && String.fromCharCode(...head.slice(0, 8)) === 'OpusHead') {
        preskip = head[10] | (head[11] << 8);
      }
      let bin = '';
      const lens = [];
      for (const c of chunks) {
        lens.push(c.bytes.length);
        for (let i = 0; i < c.bytes.length; i += 1) bin += String.fromCharCode(c.bytes[i]);
      }
      return { all: btoa(bin), lens, durations: chunks.map((c) => c.duration), preskip };
    }, { b64: pcm.toString('base64'), rate: sampleRate, br: bitrate });
  }).then((r) => {
    const all = Buffer.from(r.all, 'base64');
    const packets = [];
    let at = 0;
    for (const n of r.lens) { packets.push(all.subarray(at, at + n)); at += n; }
    return { packets, durations: r.durations, preskip: r.preskip || DEFAULT_PRESKIP };
  });
}

/** PCM → готовый OGG/Opus для sendVoice. */
async function pcmToOggOpus(pcm, sampleRate) {
  const { packets, durations, preskip } = await encodeOpus(pcm, sampleRate);
  if (!packets.length) throw new Error('кодировщик не вернул звука');
  return muxOggOpus(packets, durations, { inputRate: sampleRate, samples: Math.floor(pcm.length / 2), preskip });
}

module.exports = { pcmToWav, pcmToOggOpus, muxOggOpus, oggCrc, encodeOpus };
