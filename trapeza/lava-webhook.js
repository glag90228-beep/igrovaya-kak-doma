'use strict';

/**
 * Приёмник вебхуков Lava Top.
 *
 *   LAVA_WEBHOOK_SECRET=… BOT_TOKEN=… node lava-webhook.js
 *
 * Слушает POST на /lava и /webhook. Lava Top шлёт вебхук с заголовком
 * X-Api-Key, равным вашему API-ключу, — его и сверяем (secretOk). Тело
 * плоское: eventType, contractId, buyer.email, amount, currency, product.
 * Покупатель опознаётся по email (Telegram-id Lava не передаёт), поэтому
 * рабочий путь привязки — «Я оплатил» в боте с вводом почты с кассы.
 *
 * Наружу выставлять только по HTTPS (nginx перед этим портом).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const bdb = require('./lib/bot-db');
const billing = require('./lib/billing');
const { parseWebhook, daysFor, secretOk, hmacOk } = require('./lib/lava');
const { Telegram } = require('./lib/tg');

const PORT = Number(process.env.LAVA_PORT || 8788);
const LOG = path.join(__dirname, 'data', 'lava-webhook.log');
const MAX_BODY = 256 * 1024;

const tg = process.env.BOT_TOKEN ? new Telegram(process.env.BOT_TOKEN) : null;

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
  } catch (_) { /* лог не критичен */ }
}

/**
 * Обрабатывает разобранный платёж: записывает, привязывает к пользователю
 * и продлевает доступ. Возвращает текст для лога.
 */
async function handlePayment(p) {
  const days = daysFor(p);
  let user = null;
  if (p.tgId) {
    try { user = bdb.getOrCreateUser(p.tgId); } catch (_) { user = null; }
  }

  const { duplicate, payment, id } = billing.recordPayment({
    externalId: p.externalId, provider: 'lava', userId: user ? user.id : 0,
    email: p.email, amount: p.amount, currency: p.currency, days,
    status: p.status, raw: p.raw,
  });
  if (duplicate) return `повтор ${p.externalId} — пропущен`;

  if (!p.paid) return `платёж ${p.externalId} со статусом «${p.status}» — записан, доступ не выдан`;
  if (days < 1) {
    return `платёж ${p.externalId} на ${p.amount} — сумма не в тарифах, доступ не выдан`;
  }

  if (!user) {
    return `платёж ${p.externalId} без Telegram-id — ждёт, пока владелец почты ${p.email || '—'} заберёт его в боте`;
  }

  billing.attachPayment(id || payment.id, user.id);
  const until = billing.grantDays(user.id, days);
  if (tg) {
    try {
      await tg.sendMessage(user.tg_id,
        `✅ Оплата получена. Доступ продлён до <b>${until.split('-').reverse().join('.')}</b>.\n`
        + 'Спасибо! Если что-то не так — напишите в поддержку.');
    } catch (e) {
      if (e && e.blocked) bdb.markBlocked(user.id);
      log('не смог уведомить', user.tg_id, e.message);
    }
  }
  return `платёж ${p.externalId}: ${p.amount} ${p.currency} → ${days} дн., доступ до ${until}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const done = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };

  if (req.method === 'GET' && url.pathname === '/health') return done(200, 'ok');
  if (req.method !== 'POST') return done(405, 'only POST');
  if (url.pathname !== '/lava' && url.pathname !== '/webhook') return done(404, 'not found');

  const clientIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`принят запрос от ${clientIp} на ${url.pathname}`);

  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
  });
  req.on('end', async () => {
    if (tooBig) return done(413, 'too large');

    const given = req.headers['x-api-key']
      || req.headers['x-signature']
      || req.headers['x-hook-signature']
      || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      || url.searchParams.get('token')
      || url.searchParams.get('secret')
      || url.searchParams.get('key');

    if (!secretOk(given) && !hmacOk(given, body)) {
      log(`отказ: неверный секрет | от ${clientIp} | путь ${url.pathname} | секрет: ${given ? `длина ${given.length}` : 'не передан'}`);
      return done(401, 'bad secret');
    }

    let json;
    try { json = JSON.parse(body || '{}'); } catch (_) {
      log('не JSON:', body.slice(0, 500));
      return done(400, 'bad json');
    }

    const parsed = parseWebhook(json);
    if (!parsed.ok) {
      log('НЕ РАЗОБРАЛ вебхук:', parsed.reason, '| тело:', JSON.stringify(json).slice(0, 2000));
      return done(200, 'stored');
    }

    try {
      log(await handlePayment(parsed.payment));
    } catch (e) {
      log('ошибка обработки:', e.message);
      return done(500, 'error');
    }
    return done(200, 'ok');
  });
  return undefined;
});


if (require.main === module) {
  if (!process.env.LAVA_WEBHOOK_SECRET) {
    console.error('Не задан LAVA_WEBHOOK_SECRET — без него приёмник откажет всем.');
    process.exit(1);
  }
  // Только петля: наружу вебхуки принимает nginx по HTTPS.
  const host = process.env.LAVA_HOST || '127.0.0.1';
  server.listen(PORT, host, () => log(`Приёмник Lava слушает ${host}:${PORT}/lava`));
}

module.exports = { server, handlePayment };
