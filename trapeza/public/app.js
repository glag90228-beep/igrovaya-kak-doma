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

const TG_SVG ='<svg viewBox="0 0 24 24"><path d="M21.9 4.3 18.7 19.4c-.2 1-.9 1.3-1.7.8l-4.7-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.4-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.7 13.1l-4.7-1.5c-1-.3-1-1 .2-1.5l18.4-7.1c.9-.3 1.6.2 1.3 1.3z"/></svg>';

/** Плавающая кнопка Telegram. */
function renderContactFab(settings) {
  const digits = settings.phone_digits || '';
  if (!digits) return;
  const el = document.createElement('div');
  el.className = 'contact-fab';
  el.innerHTML = `
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
