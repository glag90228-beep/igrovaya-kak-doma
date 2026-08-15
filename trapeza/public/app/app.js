'use strict';

/*
 * Мини-приложение «Первичка»: экраны и переходы.
 *
 * Без сборщика и без библиотек — файл открывается на телефоне, и каждый
 * лишний килобайт это ожидание на медленной сети. Разметка собирается
 * функцией h(): она кладёт пользовательский текст через textContent, поэтому
 * название контрагента с угловыми скобками не превратится в разметку.
 *
 * Навигация — стек экранов, привязанный к системной кнопке «назад»
 * Telegram: в мессенджере ждут именно её, а не своей стрелки в углу.
 */

const tg = window.Telegram && window.Telegram.WebApp;

// ---------- мелкие помощники ----------

/** h('div', {class:'x'}, 'текст', child) → элемент. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;          // только для своей разметки
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Иконка из спрайта: <svg><use href="#i-…"> */
function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const rub = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => `${rub.format(Number(n) || 0)} ₽`;
/* В сводке копейки только мешают: там важен порядок суммы, а точность
   до копейки нужна в документе, и там она есть. */
const rub0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money0 = (n) => `${rub0.format(Math.round(Number(n) || 0))} ₽`;
const ru = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '')
  ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : (iso || ''));
const todayISO = () => new Date().toISOString().slice(0, 10);

/** «3 документа» / «1 документ» — без этого текст читается коряво. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function haptic(kind = 'light') {
  try { tg.HapticFeedback.impactOccurred(kind); } catch (_) { /* не везде есть */ }
}

let toastTimer = 0;
function toast(text, isError = false) {
  const box = document.getElementById('toast');
  box.textContent = text;
  box.className = `toast${isError ? ' err' : ''}`;
  box.hidden = false;
  requestAnimationFrame(() => box.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.remove('show');
    setTimeout(() => { box.hidden = true; }, 200);
  }, isError ? 5000 : 3000);
}

// ---------- обращения к серверу ----------

const initData = (tg && tg.initData) || '';

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `tma ${initData}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* пусто */ }
  if (!res.ok || data.error) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.payload = data;
    throw err;
  }
  return data;
}

/** Кнопка, которая на время запроса показывает вращение и не нажимается. */
async function withBusy(btn, fn) {
  if (btn.disabled) return undefined;
  const keep = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '';
  btn.append(h('span', { class: 'spinner' }), 'Секунду…');
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
    return undefined;
  } finally {
    btn.disabled = false;
    btn.innerHTML = keep;
  }
}

// ---------- навигация ----------

const app = document.getElementById('app');
const tabsBox = document.getElementById('tabs');

const TABS = [
  { name: 'home', label: 'Главная', icon: 'home' },
  { name: 'docs', label: 'Документы', icon: 'doc' },
  { name: 'cps', label: 'Клиенты', icon: 'users' },
  { name: 'debts', label: 'Долги', icon: 'wallet' },
  { name: 'more', label: 'Ещё', icon: 'more' },
];

let stack = [{ name: 'home', params: {} }];
let cache = {};          // ответ /api/state
const screens = {};      // заполняется ниже

function current() { return stack[stack.length - 1]; }

function go(name, params = {}) {
  stack.push({ name, params });
  render();
}

function back() {
  if (stack.length > 1) { stack.pop(); render(); }
}

function reset(name, params = {}) {
  stack = [{ name, params }];
  render();
}

function syncChrome() {
  const { name } = current();
  const isTab = TABS.some((t) => t.name === name);
  tabsBox.hidden = false;
  for (const btn of tabsBox.children) {
    const active = btn.dataset.name === name;
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  if (!tg) return;
  if (stack.length > 1 || !isTab) tg.BackButton.show(); else tg.BackButton.hide();
}

async function render() {
  const { name, params } = current();
  syncChrome();
  if (tg) tg.MainButton.hide();
  const build = screens[name] || screens.home;
  app.replaceChildren(skeleton());
  try {
    const node = await build(params);
    app.replaceChildren(node);
    app.firstChild && app.firstChild.classList && app.firstChild.classList.add('screen');
    window.scrollTo(0, 0);
  } catch (e) {
    app.replaceChildren(errorScreen(e));
  }
}

function skeleton() {
  return h('div', {},
    h('div', { class: 'skeleton' }, h('div', { class: 'line', style: 'width:55%' }), h('div', { class: 'line', style: 'width:80%' })),
    h('div', { class: 'skeleton' }, h('div', { class: 'line' }), h('div', { class: 'line', style: 'width:70%' })));
}

function errorScreen(e) {
  return h('div', { class: 'empty' },
    h('div', { class: 'icon-box warn' }, icon('warn')),
    h('h2', { text: 'Не получилось загрузить' }),
    h('p', { class: 'small', text: e.message }),
    h('div', { class: 'btn-wrap' }, h('button', { class: 'btn secondary', onclick: () => render() }, 'Повторить')));
}

function empty(iconName, title, text, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'icon-box' }, icon(iconName)),
    h('h2', { text: title }),
    text && h('p', { class: 'small', text }),
    action);
}

/** Строка-ссылка в карточке: иконка, заголовок, пояснение, шеврон. */
function navRow(opts) {
  return h('button', { class: 'row', onclick: () => { haptic(); opts.onclick(); } },
    opts.icon && h('span', { class: `icon-box ${opts.tone || ''}` }, icon(opts.icon)),
    h('span', { class: 'grow' },
      h('div', { class: 'ellipsis', text: opts.title }),
      (opts.sub || opts.badge) && h('div', { class: 'sub-line' },
        opts.sub && h('span', { class: 'small muted nowrap', text: opts.sub }),
        opts.badge && h('span', { class: `badge ${opts.badgeTone || ''}`, text: opts.badge }))),
    opts.right && h('span', { class: `money nowrap ${opts.rightTone || ''}`, text: opts.right }),
    icon('chev', 'chev'));
}

// ---------- экраны ----------

screens.home = async function home() {
  cache = await api('GET', '/api/state');
  const s = cache;
  const box = h('div', {});

  /*
   * Шапка. Сумма — крупнейшее на экране, и это не украшение: человек
   * открывает приложение, чтобы узнать цифру, а не чтобы прочитать меню.
   */
  box.append(h('div', { class: 'hero' },
    h('div', { class: 'greet', text: s.user.name ? `Здравствуйте, ${s.user.name.split(' ')[0]}` : 'Здравствуйте' }),
    h('div', { class: 'sum money', text: money0(s.debts.owedToUs) }),
    h('div', {
      class: 'sub',
      text: s.debts.owedToUs
        ? `должны вам · ${s.counts.debtors} ${plural(s.counts.debtors, 'контрагент', 'контрагента', 'контрагентов')}`
        : 'все рассчитались',
    })));

  // Одно главное действие, крупнее всего остального.
  const cta = h('button', { class: 'cta' },
    h('span', { class: 'cta-ico' }, icon('receipt')),
    h('span', { class: 'grow' },
      h('div', { class: 'cta-t', text: 'Выписать счёт' }),
      h('div', { class: 'cta-s', text: 'с QR — клиент платит камерой банка' })),
    icon('chev', 'chev'));
  cta.onclick = () => { haptic('medium'); go('new', { type: 'sch' }); };
  box.append(cta);

  // Пара «должны нам / должны мы» — одна строка вместо двух экранов.
  // В паре показываем то, чего нет в шапке: свой долг и неоплаченные счета.
  // Повторять крупную цифру мелким шрифтом рядом с ней самой бессмысленно.
  const unpaid = s.unpaid || { count: 0, sum: 0 };
  box.append(h('div', { class: 'stats' },
    h('button', { class: 'stat', onclick: () => { haptic(); go('debts'); } },
      h('div', { class: 'k', text: 'Должны мы' }),
      h('div', { class: `v money ${s.debts.owedByUs ? 'out' : ''}`, text: money0(s.debts.owedByUs) })),
    h('button', { class: 'stat', onclick: () => { haptic(); go('docs'); } },
      h('div', { class: 'k', text: 'Счета не оплачены' }),
      h('div', { class: 'v money', text: money0(unpaid.sum) }))));

  if (!s.orgReady) {
    box.append(h('div', { class: 'banner' }, icon('warn'),
      h('div', {},
        h('div', { text: 'Реквизиты заполнены не полностью' }),
        h('button', {
          class: 'btn ghost', style: 'width:auto;padding:6px 0;min-height:32px',
          onclick: () => go('org'),
        }, 'Заполнить'))));
  }

  // У каждого типа своя иконка: четыре одинаковых листа бумаги не помогают
  // выбрать, а взгляд цепляется за форму раньше, чем прочтёт подпись.
  // Счёт уехал в главное действие наверху — в плитках он был бы вторым
  // приглашением к тому же и размывал бы выбор.
  const types = [
    ['usl', 'doc-check', 'Акт услуг', 'закрывающий документ'],
    ['schdog', 'pen', 'Счёт-договор', 'заменяет договор'],
    ['upd', 'docs2', 'УПД', 'счёт-фактура и акт'],
    ['torg12', 'box', 'ТОРГ-12', 'накладная на товар'],
  ];
  box.append(h('div', { class: 'section-title', text: 'Другие документы' }));
  box.append(h('div', { class: 'tiles' }, types.map(([type, ico, title, sub]) => h('button', {
    class: 'tile', onclick: () => { haptic(); go('new', { type }); },
  },
  h('span', { class: 'icon-box' }, icon(ico)),
  h('span', { class: 't-title', text: title }),
  h('span', { class: 't-sub', text: sub })))));

  const q = s.quota;
  box.append(h('div', { class: 'section-title', text: 'Доступ' }));
  box.append(h('div', { class: 'card' },
    navRow({
      icon: q.paid ? 'star' : 'clock',
      tone: q.paid ? 'ok' : '',
      title: q.paid ? 'Подписка активна' : `Осталось ${q.left} ${plural(q.left, 'документ', 'документа', 'документов')}`,
      sub: q.paid
        ? (s.access.until ? `действует до ${ru(s.access.until)}` : 'без ограничений')
        : `${q.used} из ${q.limit} в этом месяце`,
      onclick: () => go('billing'),
    })));

  box.append(h('div', { class: 'section-title', text: 'Последние документы' }));
  if (!s.docs.length) {
    box.append(h('div', { class: 'card' }, h('div', { class: 'row muted' }, 'Пока ничего не выписано')));
  } else {
    box.append(h('div', { class: 'card' }, s.docs.map((d) => navRow({
      icon: 'doc',
      title: `${d.title} № ${d.number}`,
      sub: ru(d.date),
      right: d.total ? money(d.total) : '',
      onclick: () => go('doc', { id: d.id }),
    }))));
  }
  return box;
};

screens.docs = async function docs() {
  const { docs: list } = await api('GET', '/api/docs');
  const box = h('div', {}, h('h1', { text: 'Документы' }));
  if (!list.length) {
    box.append(empty('doc', 'Журнал пуст',
      'Здесь появятся все выписанные документы — их можно переслать заново или повторить новым номером.',
      h('div', { class: 'btn-wrap' }, h('button', { class: 'btn', onclick: () => go('new', { type: 'sch' }) }, 'Выписать счёт'))));
    return box;
  }
  // Оплачен или нет — то, ради чего в журнал и заходят. Без метки строки
  // отличаются только суммой, и статус приходится помнить в голове.
  const paidBadge = (d) => (d.paidAt ? { badge: 'Оплачен', badgeTone: 'ok' }
    : (['sch', 'schdog'].includes(d.type) ? { badge: 'Ждёт оплаты' } : {}));
  box.append(h('div', { class: 'card' }, list.map((d) => navRow({
    icon: 'doc',
    title: `${d.title} № ${d.number}`,
    sub: ru(d.date),
    ...paidBadge(d),
    right: d.total ? money0(d.total) : '',
    onclick: () => go('doc', { id: d.id }),
  }))));
  return box;
};

screens.doc = async function docScreen({ id }) {
  const { docs: list } = await api('GET', '/api/docs');
  const d = list.find((x) => x.id === Number(id));
  if (!d) return empty('warn', 'Документ не найден', 'Возможно, он был убран из журнала.');

  // Кому выписан — первое, что ищут в карточке. Раньше здесь были только
  // дата и сумма, и понять, чей это документ, было нельзя.
  const cpsList = (await api('GET', '/api/cps')).cps;
  const cpOf = cpsList.find((x) => x.id === d.cpId) || null;

  const box = h('div', {}, h('h1', { text: `${d.title} № ${d.number}` }));
  box.append(h('div', { class: 'card' },
    cpOf ? h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'Кому' }),
      h('span', { class: 'ellipsis', text: cpOf.name })) : null,
    h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'Дата' }), h('span', { text: ru(d.date) })),
    d.total ? h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'Сумма' }),
      h('span', { class: 'money', text: money(d.total) })) : null));

  /*
   * Оплата. В боте отметить её было можно, а в приложении — нет: обработчик
   * на сервере есть, кнопки не было. Для счёта это половина смысла карточки:
   * отметка закрывает долг в журнале и убирает документ из «не оплачено».
   */
  if (['sch', 'schdog'].includes(d.type) && d.total) {
    const paid = Boolean(d.paidAt);
    box.append(h('div', { class: 'section-title', text: 'Оплата' }));
    box.append(h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('span', { class: `icon-box ${paid ? 'ok' : ''}` }, icon(paid ? 'check' : 'clock')),
        h('span', { class: 'grow' },
          h('div', { text: paid ? 'Оплачен' : 'Ждёт оплаты' }),
          h('div', { class: 'small muted', text: paid ? `отмечено ${ru(d.paidAt)}` : 'долг числится за клиентом' })))));
    box.append(h('div', { class: 'btn-wrap' }, h('button', {
      class: paid ? 'btn ghost' : 'btn',
      onclick: (e) => withBusy(e.currentTarget, async () => {
        await api('POST', '/api/doc/paid', { id: d.id, paid: !paid });
        haptic('medium');
        toast(paid ? 'Отметка снята' : 'Отмечено как оплаченный');
        render();
      }),
    }, paid ? 'Снять отметку об оплате' : 'Отметить оплату')));
  }

  if (d.items && d.items.length) {
    box.append(h('div', { class: 'section-title', text: 'Позиции' }));
    box.append(h('div', { class: 'card' }, d.items.map((it) => h('div', { class: 'row' },
      h('span', { class: 'grow' },
        h('div', { class: 'ellipsis', text: it.name }),
        h('div', { class: 'small muted', text: `${it.qty} ${it.unit || 'шт.'} × ${money(it.price)}` })),
      h('span', { class: 'money nowrap', text: money((Number(it.qty) || 0) * (Number(it.price) || 0)) })))));
  }

  // Главное действие на экране одно. Если у счёта не отмечена оплата —
  // главное это она; пересылка файла тогда вторична.
  box.append(h('div', { class: 'btn-wrap' },
    h('button', {
      class: ['sch', 'schdog'].includes(d.type) && d.total && !d.paidAt ? 'btn secondary' : 'btn',
      onclick: (e) => withBusy(e.currentTarget, async () => {
        const r = await api('POST', '/api/doc/resend', { id: d.id });
        toast('Файл отправлен в чат с ботом');
        haptic('medium');
        download(r.file);
      }),
    }, 'Прислать файл заново')));

  // Отправка клиенту на почту — только если она настроена на сервере.
  const st = cache.features ? cache : await api('GET', '/api/state');
  if (st.features && st.features.mail && d.type !== 'akt') {
    const cp = cpOf || {};
    const mailField = field('email', 'Почта получателя', cp.email, {
      type: 'email', placeholder: 'buh@company.ru',
      hint: cp.email ? 'Сохранена у контрагента' : 'Запомню её для этого контрагента',
    });
    box.append(h('div', { class: 'section-title', text: 'Отправить клиенту' }));
    box.append(h('div', { class: 'card' }, mailField));
    box.append(h('div', { class: 'btn-wrap' }, h('button', {
      class: 'btn secondary',
      onclick: (e) => withBusy(e.currentTarget, async () => {
        clearErrors({ mailField });
        const to = mailField.input.value.trim();
        if (!to) { showError(mailField, 'Без адреса отправить некуда'); return; }
        const r = await api('POST', '/api/doc/mail', { id: d.id, email: to });
        toast(`Отправлено на ${r.sent}`);
        haptic('medium');
      }),
    }, 'Отправить на почту')));
  }

  if (d.items && d.items.length) {
    box.append(h('div', { class: 'btn-wrap' },
      h('button', {
        class: 'btn secondary',
        onclick: () => go('new', { type: d.type, cpId: d.cpId, items: d.items }),
      }, 'Повторить новым номером')));
  }
  return box;
};

screens.cps = async function cps() {
  const { cps: list } = await api('GET', '/api/cps');
  const box = h('div', {}, h('h1', { text: 'Контрагенты' }));
  if (!list.length) {
    box.append(empty('users', 'Пока никого нет',
      'Добавьте заказчика или поставщика — реквизиты подставятся в документы автоматически.',
      h('div', { class: 'btn-wrap' }, h('button', { class: 'btn', onclick: () => go('cp', {}) }, 'Добавить контрагента'))));
    return box;
  }
  box.append(h('div', { class: 'card' }, list.map((cp) => navRow({
    icon: 'users',
    title: cp.name,
    sub: cp.inn ? `ИНН ${cp.inn}` : (cp.kind === 'supplier' ? 'поставщик' : 'заказчик'),
    right: cp.balance ? money(Math.abs(cp.balance)) : '',
    onclick: () => go('cp', { id: cp.id }),
  }))));
  box.append(h('div', { class: 'btn-wrap' },
    h('button', { class: 'btn secondary', onclick: () => go('cp', {}) }, 'Добавить контрагента')));
  return box;
};

/** Поле формы с подписью, подсказкой и местом под ошибку. */
function field(name, label, value, opts = {}) {
  const input = h(opts.multiline ? 'textarea' : 'input', {
    id: `f-${name}`, name, value: value || '',
    inputmode: opts.inputmode, placeholder: opts.placeholder,
    type: opts.type || 'text', autocomplete: 'off',
  });
  if (opts.multiline) input.value = value || '';
  const wrap = h('div', { class: 'field' },
    h('label', { for: `f-${name}` }, label, opts.required ? h('span', { class: 'req', text: ' *' }) : null),
    input,
    opts.hint && h('div', { class: 'hint', text: opts.hint }));
  wrap.input = input;
  return wrap;
}

function values(fields) {
  const out = {};
  for (const [key, f] of Object.entries(fields)) out[key] = f.input.value.trim();
  return out;
}

/** Показать ошибку под конкретным полем и увести туда фокус. */
function showError(f, message) {
  f.classList.add('invalid');
  f.querySelectorAll('.err').forEach((n) => n.remove());
  f.append(h('div', { class: 'err' }, icon('warn', 'icon'), h('span', { text: message })));
  f.input.focus();
}
function clearErrors(fields) {
  for (const f of Object.values(fields)) {
    f.classList.remove('invalid');
    f.querySelectorAll('.err').forEach((n) => n.remove());
  }
}

screens.cp = async function cpScreen({ id }) {
  let cp = {};
  if (id) {
    const { cps: list } = await api('GET', '/api/cps');
    cp = list.find((x) => x.id === Number(id)) || {};
  }
  const f = {
    name: field('name', 'Краткое название', cp.name, { required: true, placeholder: 'ООО «Заря»' }),
    full_name: field('full_name', 'Полное наименование', cp.full_name),
    inn: field('inn', 'ИНН', cp.inn, { inputmode: 'numeric', hint: 'Заполним остальное из реестра' }),
    kpp: field('kpp', 'КПП', cp.kpp, { inputmode: 'numeric' }),
    address: field('address', 'Адрес', cp.address),
    email: field('email', 'Почта', cp.email, {
      type: 'email', placeholder: 'buh@company.ru',
      hint: 'Туда уйдут счета и акты, если отправлять из приложения',
    }),
    bank_name: field('bank_name', 'Банк', cp.bank_name),
    bik: field('bik', 'БИК', cp.bik, { inputmode: 'numeric' }),
    acc: field('acc', 'Расчётный счёт', cp.acc, { inputmode: 'numeric' }),
    corr_acc: field('corr_acc', 'Корр. счёт', cp.corr_acc, { inputmode: 'numeric' }),
  };

  const kindSel = h('select', { id: 'f-kind' },
    h('option', { value: 'customer', selected: cp.kind !== 'supplier' }, 'Заказчик — платит нам'),
    h('option', { value: 'supplier', selected: cp.kind === 'supplier' }, 'Поставщик — платим мы'));

  const lookup = h('button', {
    class: 'btn secondary',
    onclick: (e) => withBusy(e.currentTarget, async () => {
      const v = values(f);
      if (!v.inn && !v.bik) { toast('Заполните ИНН или БИК', true); return; }
      const r = await api('POST', '/api/lookup', { inn: v.inn, bik: v.bik });
      if (r.party) {
        f.name.input.value = r.party.name || f.name.input.value;
        f.full_name.input.value = r.party.full_name || '';
        f.kpp.input.value = r.party.kpp || '';
        f.address.input.value = r.party.address || '';
      }
      if (r.bank) {
        f.bank_name.input.value = r.bank.bank_name || '';
        f.corr_acc.input.value = r.bank.corr_acc || '';
      }
      toast('Заполнил из реестра');
      haptic('medium');
    }),
  }, 'Заполнить по ИНН и БИК');

  const box = h('div', {}, h('h1', { text: id ? 'Контрагент' : 'Новый контрагент' }));
  box.append(h('div', { class: 'card' }, f.name, f.full_name,
    h('div', { class: 'field' }, h('label', { for: 'f-kind', text: 'Кто это' }), kindSel)));
  box.append(h('div', { class: 'section-title', text: 'Реквизиты' }));
  box.append(h('div', { class: 'card' }, f.inn, f.kpp, f.address, f.email));
  box.append(h('div', { class: 'btn-wrap' }, lookup));
  box.append(h('div', { class: 'section-title', text: 'Банк' }));
  box.append(h('div', { class: 'card' }, f.bank_name, f.bik, f.acc, f.corr_acc));

  const save = async () => {
    clearErrors(f);
    const v = values(f);
    if (!v.name) { showError(f.name, 'Без названия документ не подписать'); return; }
    await api('POST', '/api/cp', { id: id || 0, ...v, kind: kindSel.value });
    toast(id ? 'Сохранил' : 'Контрагент добавлен');
    haptic('medium');
    back();
  };

  box.append(h('div', { class: 'btn-wrap' },
    h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, save) }, 'Сохранить')));
  return box;
};

screens.org = async function orgScreen() {
  const s = cache.org ? cache : await api('GET', '/api/state');
  const o = s.org || {};
  const f = {
    name: field('name', 'Краткое название', o.name, { required: true, placeholder: 'ИП Иванов И. И.' }),
    full_name: field('full_name', 'Полное наименование', o.full_name),
    inn: field('inn', 'ИНН', o.inn, { inputmode: 'numeric' }),
    kpp: field('kpp', 'КПП', o.kpp, { inputmode: 'numeric', hint: 'У ИП его нет — оставьте пустым' }),
    signer: field('signer', 'Кто подписывает', o.signer, { placeholder: 'И. И. Иванов' }),
    address: field('address', 'Адрес', o.address),
    bank_name: field('bank_name', 'Банк', o.bank_name),
    bik: field('bik', 'БИК', o.bik, { inputmode: 'numeric' }),
    acc: field('acc', 'Расчётный счёт', o.acc, { inputmode: 'numeric', hint: 'Нужен для QR-кода в счёте' }),
    corr_acc: field('corr_acc', 'Корр. счёт', o.corr_acc, { inputmode: 'numeric' }),
  };

  const paste = h('textarea', {
    id: 'f-paste', placeholder: 'Вставьте блок реквизитов из письма или договора целиком',
  });
  const parseBtn = h('button', {
    class: 'btn secondary',
    onclick: (e) => withBusy(e.currentTarget, async () => {
      const text = paste.value.trim();
      if (!text) { toast('Сначала вставьте текст', true); return; }
      const { fields } = await api('POST', '/api/parse', { text });
      let filled = 0;
      for (const [k, v] of Object.entries(fields)) {
        if (f[k] && v) { f[k].input.value = v; filled += 1; }
      }
      toast(filled ? `Разобрал ${filled} ${plural(filled, 'поле', 'поля', 'полей')}` : 'Ничего не нашёл', !filled);
      haptic('medium');
    }),
  }, 'Разобрать текст');

  const box = h('div', {}, h('h1', { text: 'Моя организация' }));
  box.append(h('div', { class: 'banner info' }, icon('help'),
    h('div', { text: 'Эти реквизиты подставляются во все документы. Заполняются один раз.' })));

  box.append(h('div', { class: 'section-title', text: 'Быстрый ввод' }));
  box.append(h('div', { class: 'card' },
    h('div', { class: 'field' }, h('label', { for: 'f-paste', text: 'Вставить блок реквизитов' }), paste)));
  box.append(h('div', { class: 'btn-wrap' }, parseBtn));

  box.append(h('div', { class: 'section-title', text: 'Организация' }));
  box.append(h('div', { class: 'card' }, f.name, f.full_name, f.inn, f.kpp, f.signer, f.address));
  box.append(h('div', { class: 'btn-wrap' }, h('button', {
    class: 'btn secondary',
    onclick: (e) => withBusy(e.currentTarget, async () => {
      const v = values(f);
      if (!v.inn && !v.bik) { toast('Заполните ИНН или БИК', true); return; }
      const r = await api('POST', '/api/lookup', { inn: v.inn, bik: v.bik });
      if (r.party) {
        f.name.input.value = r.party.name || f.name.input.value;
        f.full_name.input.value = r.party.full_name || '';
        f.kpp.input.value = r.party.kpp || '';
        f.address.input.value = r.party.address || '';
        if (r.party.signer) f.signer.input.value = r.party.signer;
      }
      if (r.bank) {
        f.bank_name.input.value = r.bank.bank_name || '';
        f.corr_acc.input.value = r.bank.corr_acc || '';
      }
      toast('Заполнил из реестра');
    }),
  }, 'Заполнить по ИНН и БИК')));

  box.append(h('div', { class: 'section-title', text: 'Банк' }));
  box.append(h('div', { class: 'card' }, f.bank_name, f.bik, f.acc, f.corr_acc));

  box.append(h('div', { class: 'btn-wrap' }, h('button', {
    class: 'btn',
    onclick: (e) => withBusy(e.currentTarget, async () => {
      clearErrors(f);
      const v = values(f);
      if (!v.name) { showError(f.name, 'Укажите, как называется организация'); return; }
      await api('POST', '/api/org', v);
      cache = {};
      toast('Реквизиты сохранены');
      haptic('medium');
      back();
    }),
  }, 'Сохранить')));

  box.append(h('div', { class: 'section-title', text: 'Подпись и печать' }));
  box.append(facsimileCard(s.facsimile));
  return box;
};

/**
 * Уменьшает выбранное фото перед отправкой.
 *
 * Снимок подписи с телефона весит 3–5 МБ, а на документе она занимает
 * полтора сантиметра — гнать мегабайты незачем, да и сервер такое не примет.
 * Ужимаем по длинной стороне до 1400 px прямо в браузере: и загрузка
 * быстрее, и человеку не приходится ничего готовить заранее.
 */
function shrinkImage(file, maxSide = 1400) {
  return new Promise((done, fail) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      // Белый фон под прозрачностью: PNG с альфой на документе даст
      // серый прямоугольник, а нам нужно, чтобы сработало умножение.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        done(canvas.toDataURL('image/png'));
      } catch (e) { fail(new Error('Не смог обработать картинку')); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('Это не картинка')); };
    img.src = url;
  });
}

/**
 * Подпись и печать: загрузка картинкой, предпросмотр и выбор, куда ставить.
 * Файл читаем прямо в браузере и шлём как data-URI — так не нужен ни
 * multipart на сервере, ни отдельное хранилище на диске.
 */
function facsimileCard(state) {
  const card = h('div', { class: 'card' });

  const redraw = (fresh) => {
    const fx = fresh || state;
    card.replaceChildren();

    for (const [kind, label] of [['sign', 'Подпись'], ['stamp', 'Печать']]) {
      const has = fx[kind];
      const file = h('input', {
        type: 'file', accept: 'image/png,image/jpeg,image/webp',
        id: `fx-${kind}`, style: 'display:none',
      });
      file.addEventListener('change', async () => {
        const chosen = file.files && file.files[0];
        if (!chosen) return;
        try {
          const dataUrl = await shrinkImage(chosen);
          const r = await api('POST', '/api/facsimile', { kind, dataUrl });
          toast(`${label} загружена`);
          haptic('medium');
          cache = {};
          redraw(r.facsimile);
        } catch (e) { toast(e.message, true); }
      });

      // Текст ужимается многоточием, а не переносится: иначе строка
      // распухает на две и наезжает на предпросмотр.
      card.append(h('div', { class: 'row' },
        h('span', { class: `icon-box ${has ? 'ok' : ''}` }, icon(has ? 'check' : 'plus')),
        h('span', { class: 'grow' },
          h('div', { class: 'ellipsis', text: label }),
          h('div', {
            class: 'small muted ellipsis',
            text: has ? `${Math.round(has.size / 1024)} КБ` : 'не загружена',
          })),
        // Миниатюра всегда на белом: умножение на тёмном фоне съело бы
        // картинку, а показать надо ровно то, что ляжет на бумагу.
        has && h('img', {
          src: has.preview, alt: `${label} — предпросмотр`,
          style: 'height:34px;width:auto;max-width:58px;flex:none;object-fit:contain;'
            + 'background:#fff;border-radius:6px;padding:2px',
        }),
        file,
        h('button', {
          class: 'btn ghost', style: 'width:auto;flex:none;min-height:44px;padding:0 8px',
          onclick: () => { haptic(); file.click(); },
        }, has ? 'Заменить' : 'Загрузить'),
        has && h('button', {
          class: 'iconbtn danger', style: 'width:38px', 'aria-label': `Убрать: ${label}`,
          onclick: async (e) => {
            e.stopPropagation();
            const r = await api('POST', '/api/facsimile/delete', { kind });
            toast(`${label} убрана`);
            cache = {};
            redraw(r.facsimile);
          },
        }, icon('trash'))));
    }

    const sel = h('select', { id: 'fx-scope' },
      Object.entries(fx.scopes).map(([key, label]) => h('option', {
        value: key, selected: key === fx.scope,
      }, label)));
    sel.addEventListener('change', async () => {
      try {
        const r = await api('POST', '/api/facsimile/scope', { scope: sel.value });
        toast('Сохранил');
        cache = {};
        redraw(r.facsimile);
      } catch (e) { toast(e.message, true); }
    });
    card.append(h('div', { class: 'field' },
      h('label', { for: 'fx-scope', text: 'Ставить' }), sel,
      h('div', {
        class: 'hint',
        text: 'Снимите подпись на белом листе — фон бот уберёт сам. На платёжное '
          + 'поручение и договор факсимиле не ставится: там нужна живая подпись.',
      })));
  };

  redraw();
  return card;
}

screens.debts = async function debts() {
  const { debtors } = await api('GET', '/api/debtors');
  const box = h('div', {}, h('h1', { text: 'Кто сколько должен' }));
  if (!debtors.length) {
    box.append(empty('wallet', 'Долгов нет', 'Как только появятся неоплаченные счета, они окажутся здесь.'));
    return box;
  }
  const them = debtors.filter((d) => d.theyOwe);
  const us = debtors.filter((d) => !d.theyOwe);
  // Цвет суммы тот же, что на главной: зелёная — нам, красная — мы.
  // Одинаково окрашенные столбцы цифр заставляют читать заголовок раздела.
  const block = (title, list, tone) => (list.length ? [
    h('div', { class: 'section-title', text: title }),
    h('div', { class: 'card' }, list.map((d) => navRow({
      icon: 'users',
      title: d.name,
      sub: d.days == null ? '' : `без движения ${d.days} ${plural(d.days, 'день', 'дня', 'дней')}`,
      right: money(d.amount),
      rightTone: tone,
      tone: d.days > 30 ? 'warn' : '',
      onclick: () => go('cp', { id: d.cpId }),
    }))),
  ] : []);
  // append массив не разворачивает — он бы превратился в строку.
  box.append(...block('Должны нам', them, 'in'), ...block('Должны мы', us, 'out'));
  return box;
};

screens.more = async function more() {
  const s = cache.user ? cache : await api('GET', '/api/state');
  const box = h('div', {}, h('h1', { text: 'Ещё' }));
  box.append(h('div', { class: 'card' },
    navRow({ icon: 'office', title: 'Моя организация', sub: (s.org && s.org.name) || 'не заполнена', onclick: () => go('org') }),
    navRow({
      icon: 'star',
      tone: s.quota.paid ? 'ok' : '',
      title: 'Подписка',
      sub: s.quota.paid ? `до ${ru(s.access.until)}` : `${s.quota.left} из ${s.quota.limit} бесплатных`,
      onclick: () => go('billing'),
    })));
  box.append(h('div', { class: 'section-title', text: 'Помощь' }));
  box.append(h('div', { class: 'card' },
    navRow({
      icon: 'help',
      title: 'Как пользоваться',
      sub: 'короткая инструкция в чате',
      onclick: () => { if (tg) tg.close(); },
    })));
  return box;
};

screens.billing = async function billing() {
  const s = await api('GET', '/api/state');
  const box = h('div', {}, h('h1', { text: 'Подписка' }));
  const q = s.quota;

  box.append(h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('span', { class: `icon-box ${q.paid ? 'ok' : ''}` }, icon(q.paid ? 'check' : 'clock')),
      h('span', { class: 'grow' },
        h('div', { text: q.paid ? 'Подписка активна' : 'Бесплатный режим' }),
        h('div', {
          class: 'small muted',
          text: q.paid
            ? `действует до ${ru(s.access.until)}`
            : `выписано ${q.used} из ${q.limit} в этом месяце`,
        })))));

  if (!q.paid) {
    box.append(h('div', { class: 'section-title', text: 'Что даёт подписка' }));
    box.append(h('div', { class: 'card' },
      ['Документы без ограничений', 'Все семь типов документов', 'Автозаполнение по ИНН и БИК', 'Поддержка в чате']
        .map((t) => h('div', { class: 'row' }, h('span', { class: 'icon-box ok' }, icon('check')), h('span', { class: 'grow', text: t })))));

    if (s.payUrl) {
      box.append(h('div', { class: 'btn-wrap' }, h('button', {
        class: 'btn',
        onclick: () => {
          haptic('medium');
          if (tg && tg.openLink) tg.openLink(s.payUrl); else window.open(s.payUrl, '_blank');
        },
      }, 'Оформить подписку')));
      box.append(h('p', { class: 'small muted', style: 'margin:0 16px 12px', text: 'После оплаты вернитесь в чат с ботом и нажмите «Я оплатил».' }));
    }
  }

  // Код доступа виден всегда: по нему и открывают доступ до подключения
  // оплаты, и продлевают уже действующую подписку.
  box.append(h('div', { class: 'section-title', text: 'Код доступа' }));
  const code = field('promo', 'Код', '', { placeholder: 'PRV-A3KD-9MQX' });
  code.input.autocapitalize = 'characters';
  box.append(h('div', { class: 'card' }, code));
  const apply = h('button', { class: 'btn secondary' }, 'Активировать');
  apply.onclick = async () => {
    const value = code.input.value.trim();
    if (!value) { showError(code, 'Введите код.'); return; }
    apply.disabled = true;
    try {
      const r = await api('POST', '/api/promo', { code: value });
      haptic('medium');
      toast(`Код принят: ${r.days} ${plural(r.days, 'день', 'дня', 'дней')} без ограничений`);
      go('billing');
    } catch (e) {
      showError(code, e.message);
    } finally {
      apply.disabled = false;
    }
  };
  box.append(h('div', { class: 'btn-wrap' }, apply));
  box.append(h('p', {
    class: 'small muted',
    style: 'margin:0 16px 12px',
    text: q.paid
      ? 'Если есть ещё один код, дни прибавятся к оплаченным — ничего не сгорит.'
      : 'Код выдаёт поддержка — например, на время знакомства с сервисом.',
  }));
  return box;
};

// ---------- выписка документа ----------

/** Скачивание готового файла: ссылка одноразовая, живёт пять минут. */
function download(file) {
  if (!file || !file.url) return;
  const a = h('a', { href: file.url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
}

screens.new = async function newDoc(params) {
  const TITLES = {
    sch: 'Счёт на оплату', schdog: 'Счёт-договор', usl: 'Акт об оказании услуг',
    upd: 'УПД', torg12: 'Товарная накладная ТОРГ-12',
  };
  const type = TITLES[params.type] ? params.type : 'sch';
  const [{ cps }, { templates }] = await Promise.all([
    api('GET', '/api/cps'),
    api('GET', '/api/templates').catch(() => ({ templates: [] })),
  ]);

  const draft = {
    cpId: Number(params.cpId) || (cps[0] && cps[0].id) || 0,
    date: todayISO(),
    items: (params.items || []).map((it) => ({ ...it })),
  };
  if (!draft.items.length) draft.items.push({ name: '', unit: 'шт.', qty: 1, price: 0 });

  const box = h('div', {}, h('h1', { text: TITLES[type] }));

  if (!cps.length) {
    box.append(empty('users', 'Сначала добавьте контрагента',
      'Документ выписывается на кого-то — укажите заказчика или поставщика.',
      h('div', { class: 'btn-wrap' }, h('button', { class: 'btn', onclick: () => go('cp', {}) }, 'Добавить контрагента'))));
    return box;
  }

  const cpSel = h('select', { id: 'f-cp' },
    cps.map((cp) => h('option', { value: cp.id, selected: cp.id === draft.cpId }, cp.name)));
  const dateInput = h('input', { id: 'f-date', type: 'date', value: draft.date });

  box.append(h('div', { class: 'card' },
    h('div', { class: 'field' }, h('label', { for: 'f-cp', text: 'Кому' }), cpSel),
    h('div', { class: 'field' }, h('label', { for: 'f-date', text: 'Дата' }), dateInput)));

  // --- позиции ---
  const itemsCard = h('div', { class: 'card' });
  const totalEl = h('span', { class: 'money', text: money(0) });

  function recalc() {
    const sum = draft.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
    totalEl.textContent = money(sum);
    if (tg) {
      const ready = sum > 0 && draft.items.some((it) => it.name.trim());
      tg.MainButton.setParams({ text: `Выписать на ${money(sum)}`, is_active: ready });
      if (ready) tg.MainButton.show(); else tg.MainButton.hide();
    }
  }

  function itemRow(it, index) {
    const name = h('input', {
      class: 'name', value: it.name, placeholder: 'Наименование',
      'aria-label': `Наименование позиции ${index + 1}`,
    });
    name.addEventListener('input', () => { it.name = name.value; recalc(); });

    const qty = h('input', { value: it.qty, inputmode: 'decimal', 'aria-label': 'Количество' });
    qty.addEventListener('input', () => { it.qty = Number(qty.value.replace(',', '.')) || 0; recalc(); lineTotal(); });

    const price = h('input', { value: it.price, inputmode: 'decimal', 'aria-label': 'Цена' });
    price.addEventListener('input', () => { it.price = Number(price.value.replace(',', '.')) || 0; recalc(); lineTotal(); });

    const sumEl = h('span', { class: 'line-total money' });
    const lineTotal = () => { sumEl.textContent = money((Number(it.qty) || 0) * (Number(it.price) || 0)); };
    lineTotal();

    const del = h('button', {
      class: 'iconbtn danger', 'aria-label': `Убрать позицию ${index + 1}`,
      onclick: () => {
        draft.items.splice(index, 1);
        if (!draft.items.length) draft.items.push({ name: '', unit: 'шт.', qty: 1, price: 0 });
        drawItems();
        haptic();
      },
    }, icon('trash'));

    return h('div', { class: 'item' },
      h('div', { class: 'top' }, name, del),
      h('div', { class: 'nums' }, qty, h('span', { class: 'x', text: '×' }), price, sumEl));
  }

  function drawItems() {
    itemsCard.replaceChildren(
      ...draft.items.map(itemRow),
      h('div', { class: 'total-row' }, h('span', { text: 'Итого' }), totalEl),
    );
    recalc();
  }

  box.append(h('div', { class: 'section-title', text: 'Позиции' }));
  box.append(itemsCard);
  drawItems();

  box.append(h('div', { class: 'btn-wrap' }, h('button', {
    class: 'btn secondary',
    onclick: () => { draft.items.push({ name: '', unit: 'шт.', qty: 1, price: 0 }); drawItems(); haptic(); },
  }, 'Добавить позицию')));

  if (templates.length) {
    box.append(h('div', { class: 'section-title', text: 'Частые позиции' }));
    box.append(h('div', { class: 'chips' }, templates.slice(0, 8).map((t) => h('button', {
      class: 'chip',
      onclick: () => {
        const blank = draft.items.findIndex((it) => !it.name.trim());
        const row = { name: t.name, unit: t.unit || 'шт.', qty: 1, price: t.price };
        if (blank >= 0) draft.items[blank] = row; else draft.items.push(row);
        drawItems();
        haptic();
      },
    }, icon('plus'), t.name))));
  }

  const issue = async () => {
    const items = draft.items.filter((it) => it.name.trim());
    if (!items.length) { toast('Добавьте хотя бы одну позицию', true); return; }
    try {
      if (tg) tg.MainButton.showProgress();
      const r = await api('POST', '/api/doc', {
        type, cpId: Number(cpSel.value), date: dateInput.value, items,
      });
      haptic('heavy');
      toast(r.sentToChat ? 'Готово — файл отправлен в чат' : 'Документ выписан');
      download(r.file);
      cache = {};
      reset('home');
    } catch (e) {
      if (e.payload && e.payload.reason === 'quota') { toast(e.message, true); go('billing'); return; }
      toast(e.message, true);
    } finally {
      if (tg) tg.MainButton.hideProgress();
    }
  };

  const hasMainButton = Boolean(tg && tg.MainButton && tg.MainButton.setParams);
  if (hasMainButton) {
    tg.MainButton.offClick(issue);
    tg.MainButton.onClick(issue);
  } else {
    // Запасная кнопка для старых клиентов и для открытия вне Telegram.
    // Когда главная кнопка есть, второй такой же на экране быть не должно.
    box.append(h('div', { class: 'btn-wrap' }, h('button', {
      class: 'btn', onclick: (e) => withBusy(e.currentTarget, issue),
    }, 'Выписать документ')));
  }

  return box;
};

// ---------- запуск ----------

function buildTabs() {
  tabsBox.replaceChildren(...TABS.map((t) => h('button', {
    class: 'tab', dataset: { name: t.name }, type: 'button',
    onclick: () => { haptic(); reset(t.name); },
  }, icon(t.icon), h('span', { text: t.label }))));
}

// Вход для снимков экранов (miniapp-preview.js): открыть любой экран без
// нажатий. Ничего не решает и ничего не открывает сверх того, что человек
// и так может нажать сам, — поэтому оставлен и в рабочей сборке.
window.__go = (name, params) => go(name, params || {});

function start() {
  buildTabs();

  if (!tg) {
    app.replaceChildren(empty('warn', 'Откройте из Telegram',
      'Это приложение работает внутри Telegram: оттуда оно получает, кто вы.'));
    tabsBox.hidden = true;
    return;
  }

  tg.ready();
  tg.expand();
  tg.BackButton.onClick(back);
  if (tg.setHeaderColor) { try { tg.setHeaderColor('secondary_bg_color'); } catch (_) { /* старый клиент */ } }
  if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); // чтобы список не закрывал окно

  if (!initData) {
    app.replaceChildren(empty('warn', 'Не удалось вас опознать',
      'Закройте приложение и откройте его заново из чата с ботом.'));
    tabsBox.hidden = true;
    return;
  }

  render();
}

start();
