'use strict';

/**
 * ZIP своими руками — ровно столько, сколько нужно для Word (DOCX).
 *
 * DOCX — это ZIP с XML внутри. Готовые библиотеки распаковки в проекте есть
 * только транзитивно (jszip приезжает вместе с exceljs), а опираться на
 * чужую зависимость, которую мы не объявляли, значит однажды проснуться с
 * упавшим разбором после обновления exceljs. Формат же простой: каталог в
 * конце файла, у каждой записи метод (0 — как есть, 8 — deflate), а deflate
 * в Node встроен.
 *
 * Защита от «ZIP-бомбы»: распаковка каждой записи ограничена по размеру —
 * договор на десять страниц весит десятки килобайт, а не гигабайты.
 */

const zlib = require('node:zlib');

const MAX_ENTRY = 30 * 1024 * 1024;

/** Прочитать нужные записи. names — какие файлы вернуть (без него — все). */
function readZip(buf, names = null) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  // Конец центрального каталога ищем с хвоста: за ним может быть комментарий.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i -= 1) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('это не ZIP-архив');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw new Error('каталог архива повреждён');
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (names && !names.includes(name)) continue;
    if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) throw new Error('запись архива повреждена');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + compSize);
    if (size > MAX_ENTRY) throw new Error('в архиве слишком большой файл');
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }));
    else throw new Error(`неизвестный метод сжатия ${method}`);
  }
  return out;
}

// CRC-32 для записи: в новых Node есть zlib.crc32, в старых — считаем сами.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
const crc32 = (data) => {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data) >>> 0;
  let c = -1;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

/** Собрать ZIP из {имя: содержимое}. Нужен тестам и выдаче DOCX. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const unxml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

const attr = (xml, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(xml);
  return m ? m[1] : '';
};

/**
 * Автонумерация Word.
 *
 * Номера пунктов «1.», «2.3.» в договоре чаще всего не текст, а нумерация
 * списка: в document.xml у абзаца стоит только ссылка на список и уровень.
 * Без неё договор превращается в кашу абзацев без номеров, и ссылки вида
 * «согласно п. 4.2» перестают на что-то указывать. Восстанавливаем
 * десятичные номера по numbering.xml; маркеры списков — тире.
 */
function numberingOf(xml) {
  if (!xml) return null;
  const abstract = {};
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const lvls = {};
    for (const l of m[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      lvls[l[1]] = {
        fmt: attr((/<w:numFmt\b[^>]*\/>/.exec(l[2]) || [''])[0], 'w:val') || 'decimal',
        text: attr((/<w:lvlText\b[^>]*\/>/.exec(l[2]) || [''])[0], 'w:val'),
        start: Number(attr((/<w:start\b[^>]*\/>/.exec(l[2]) || [''])[0], 'w:val')) || 1,
      };
    }
    abstract[m[1]] = lvls;
  }
  const nums = {};
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const a = attr((/<w:abstractNumId\b[^>]*\/>/.exec(m[2]) || [''])[0], 'w:val');
    if (abstract[a]) nums[m[1]] = abstract[a];
  }
  return nums;
}

/**
 * Текст документа Word по абзацам. Таблицы — ячейки через табуляцию,
 * строка таблицы — абзац.
 */
function docxText(buf) {
  const files = readZip(buf, ['word/document.xml', 'word/numbering.xml']);
  const doc = files.get('word/document.xml');
  if (!doc) throw new Error('в файле нет текста Word (word/document.xml)');
  const xml = doc.toString('utf8');
  const numbering = numberingOf((files.get('word/numbering.xml') || '').toString('utf8'));
  const counters = {};
  const lines = [];
  let row = null;
  // Пустой абзац <w:p/> ищем первым: иначе шаблон «абзац с телом» принял бы
  // его за начало и проглотил следующий абзац целиком.
  for (const tok of xml.matchAll(/<w:tr\b[^>]*>|<\/w:tr>|<w:p\b[^>]*\/>|<w:p\b(?:[^>]*[^/>])?>[\s\S]*?<\/w:p>/g)) {
    const t = tok[0];
    if (t.startsWith('<w:tr')) { row = []; continue; }
    if (t === '</w:tr>') { if (row) lines.push(row.filter(Boolean).join('\t')); row = null; continue; }
    let text = '';
    for (const r of t.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>/g)) {
      if (r[1] !== undefined) text += unxml(r[1]);
      else if (r[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }
    const numId = attr((/<w:numId\b[^>]*\/>/.exec(t) || [''])[0], 'w:val');
    const ilvl = Number(attr((/<w:ilvl\b[^>]*\/>/.exec(t) || [''])[0], 'w:val')) || 0;
    if (numbering && numId && numbering[numId] && text.trim()) {
      const lv = numbering[numId];
      const c = counters[numId] || (counters[numId] = []);
      c[ilvl] = (c[ilvl] == null ? (lv[ilvl] || {}).start || 1 : c[ilvl] + 1);
      c.length = ilvl + 1;
      const def = lv[ilvl] || { fmt: 'decimal', text: '' };
      let prefix = '';
      if (def.fmt === 'bullet') prefix = '— ';
      else if (def.text) {
        prefix = def.text.replace(/%(\d)/g, (_, k) => {
          const i = Number(k) - 1;
          return String(c[i] != null ? c[i] : (lv[i] || {}).start || 1);
        });
        prefix = `${prefix} `;
      }
      text = prefix + text;
    }
    if (row) row.push(text.trim());
    else lines.push(text);
  }
  return lines.join('\n').replace(/[  ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { readZip, makeZip, docxText, crc32 };
