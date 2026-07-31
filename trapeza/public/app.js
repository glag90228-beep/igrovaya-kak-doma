/* Общие помощники фронтенда «Трапезы». */

/** 13125 -> "13 125,00" */
function money(n) {
  const v = Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const [int, dec] = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '−' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + dec;
}
/** 13125 -> "13 125,00 руб." */
const rub = (n) => money(n) + ' руб.';

/** "2026-07-21" -> "21.07.2026" */
function dateRu(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || '');
}

/** Экранирование пользовательского текста перед вставкой в HTML. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  if (!res.ok) throw new Error((data && data.error) || `Ошибка ${res.status}`);
  return data;
}

const getJSON = (url) => api(url);
const postJSON = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
const putJSON = (url, body) => api(url, { method: 'PUT', body: JSON.stringify(body) });
const delJSON = (url) => api(url, { method: 'DELETE' });

/** Правильное окончание: 1 гость, 2 гостя, 5 гостей */
function plural(n, one, few, many) {
  const m100 = Math.abs(n) % 100;
  const m10 = Math.abs(n) % 10;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}

const WA_SVG = '<svg viewBox="0 0 24 24"><path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.7 1-.9 1.2-.2.2-.3.2-.6.1-1.7-.9-2.9-1.6-4-3.6-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.5s-.7-1.6-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5.1 4.5 1.9.8 2.6.9 3.5.7.6-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.2-.3-.2-.6-.4z"/><path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3.1.8.8-3-.2-.3A8.2 8.2 0 1 1 12 20.2z"/></svg>';
const TG_SVG = '<svg viewBox="0 0 24 24"><path d="M21.9 4.3 18.7 19.4c-.2 1-.9 1.3-1.7.8l-4.7-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.4-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.7 13.1l-4.7-1.5c-1-.3-1-1 .2-1.5l18.4-7.1c.9-.3 1.6.2 1.3 1.3z"/></svg>';

/** Плавающие кнопки WhatsApp/Telegram. */
function renderContactFab(settings, message) {
  const digits = settings.phone_digits || '';
  if (!digits) return;
  const text = encodeURIComponent(message || `Здравствуйте! Пишу с сайта «${settings.brand || 'Трапеза'}».`);
  const el = document.createElement('div');
  el.className = 'contact-fab';
  el.innerHTML = `
    <a class="fab-wa" href="https://wa.me/${digits}?text=${text}" target="_blank" rel="noopener"
       title="Написать в WhatsApp" aria-label="Написать в WhatsApp">${WA_SVG}</a>
    <a class="fab-tg" href="https://t.me/+${digits}" target="_blank" rel="noopener"
       title="Написать в Telegram" aria-label="Написать в Telegram">${TG_SVG}</a>`;
  document.body.appendChild(el);
}

/** Шапка бренда. */
function brandHeader(s) {
  return `
  <div class="brand">
    <div class="wrap brand-inner">
      <div>
        <div class="brand-name">${esc(s.brand || 'Трапеза')}</div>
        <div class="brand-sub">${esc(s.org_name || '')}</div>
      </div>
      <div class="brand-right">
        <a class="brand-phone" href="tel:${esc((s.phone || '').replace(/[^\d+]/g, ''))}">${esc(s.phone || '')}</a>
        <div class="brand-slogan">${esc(s.slogan || '')}</div>
      </div>
    </div>
  </div>`;
}
