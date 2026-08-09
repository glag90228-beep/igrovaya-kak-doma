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

const PHONE_SVG = '<svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.2.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1l-2.3 2.2z"/></svg>';

/**
 * Плавающие кнопки связи: мессенджер MAX и звонок.
 * Клиенту не показываем, куда именно уходит заявка — только способы связаться с нами.
 */
function renderContactFab(settings) {
  const parts = [];
  if (settings.max_link) {
    parts.push(`<a class="fab-max" href="${esc(settings.max_link)}" target="_blank" rel="noopener"
       title="Написать нам в MAX" aria-label="Написать нам в MAX"><span>MAX</span></a>`);
  }
  const tel = (settings.phone || '').replace(/[^\d+]/g, '');
  if (tel) {
    parts.push(`<a class="fab-call" href="tel:${esc(tel)}"
       title="Позвонить" aria-label="Позвонить нам">${PHONE_SVG}</a>`);
  }
  if (!parts.length) return;
  const el = document.createElement('div');
  el.className = 'contact-fab';
  el.innerHTML = parts.join('');
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
