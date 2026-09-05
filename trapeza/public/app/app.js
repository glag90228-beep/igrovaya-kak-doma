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

// Момент запуска: от него считается, сколько заставке осталось висеть.
const START = performance.now();

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
/*
 * Дата в ISO по местному времени телефона. Через toISOString() было бы
 * короче, но она переводит в UTC: в Москве 1 августа в 00:30 «сегодня»
 * превращалось в 31 июля, и период уезжал на день назад.
 */
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayISO = () => isoDate(new Date());

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
// Напоминание про чек «Моего налога»: сервер сказал его показать после
// отметки оплаты, а рисует карточка документа при следующей перерисовке.
let pendingCheque = null;
const screens = {};      // заполняется ниже

function current() { return stack[stack.length - 1]; }

function go(name, params = {}) {
  stack.push({ name, params });
  render();
}

/*
 * Куда возвращаться, если в стопке ничего нет.
 *
 * Часть экранов открывается через reset — например, карточка клиента сразу
 * после внесения оплаты. Стопка при этом схлопывается в один элемент, а
 * кнопка «Назад» в шапке остаётся видимой (экран-то не вкладка) и не делает
 * ничего. Со стороны это просто сломанная кнопка. Поэтому у каждого такого
 * экрана есть родитель, и назад всегда есть куда.
 */
const PARENT = {
  cp: 'cps', op: 'cps', doc: 'docs', new: 'docs', other: 'docs', why: 'home',
  letter: 'inbox', inbox: 'more', mail: 'more', bank: 'more', org: 'more',
  billing: 'more', support: 'more', help: 'more', vat: 'more', basis: 'more',
  recurring: 'more', reminders: 'more', registry: 'docs', akt: 'docs',
  unpaid: 'home', scan: 'docs', ops: 'cps', ask: 'home', bankclose: 'debts',
};

function back() {
  if (stack.length > 1) { stack.pop(); render(); return; }
  const { name } = current();
  if (TABS.some((t) => t.name === name)) return;   // вкладка — возвращаться некуда
  reset(PARENT[name] || 'home');
}

function reset(name, params = {}) {
  stack = [{ name, params }];
  render();
}

async function afterIssue() {
  cache = {};
  const st = await api('GET', '/api/state');
  cache = st;
  reset(st.bizType ? 'home' : 'basis');
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
  dropSplash();
}

/**
 * Убрать заставку, когда первый экран отрисован.
 *
 * Два условия сразу: экран готов И заставка показалась целиком. Только по
 * готовности данных нельзя — на быстрой сети знак мигнёт и пропадёт, это
 * выглядит дёрганием, а не оформлением. Только по времени тоже нельзя —
 * на медленной сети человек досмотрит анимацию и упрётся в пустой экран.
 *
 * Отсчёт ведём от загрузки страницы, а не от вызова: к этому моменту
 * анимация уже идёт, и ждать надо ровно остаток.
 */
// Перечисление (4 × 95 мс) + знак (700 мс) + уход (320 мс). Считается тем же
// способом, что и задержки в app.css: если поменяете --w там, поправьте здесь.
const SPLASH_MS = 1400;
function dropSplash() {
  const el = document.getElementById('splash');
  if (!el || el.classList.contains('gone')) return;
  const left = Math.max(0, SPLASH_MS - (performance.now() - START));
  setTimeout(() => el.classList.add('gone'), left);
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

/*
 * Кто кому должен по сальдо контрагента.
 *
 * У поставщика знак читается наоборот: его «приход» — это наш долг. Правило
 * то же, что на сервере в debtors(); держать его в двух местах приходится,
 * но расходиться им нельзя — иначе экран покажет зелёным то, что человек
 * должен сам.
 */
const owesUs = (cp) => (cp.kind === 'supplier' ? cp.balance < 0 : cp.balance > 0);
const balanceTone = (cp) => (!cp.balance ? '' : (owesUs(cp) ? 'in' : 'out'));

/** Строка-ссылка в карточке: иконка, заголовок, пояснение, шеврон. */
/*
 * Что сказать после удаления документа.
 *
 * Раньше говорили просто «удалён», и человек шёл смотреть на долг клиента.
 * Долг создаёт не всякий документ: при основании «по отгрузке» счёт проводки
 * не делает, и сальдо после его удаления не меняется — законно, но со
 * стороны неотличимо от поломки. Поэтому говорим прямо.
 */
function deletedText(d, r) {
  const head = `${d.title} № ${d.number} удалён`;
  if (r && Number(r.delta)) return `${head}. Долг изменился на ${money(Math.abs(r.delta))}`;
  return `${head}. Сальдо клиента не изменилось — проводки у него не было`;
}

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
  const sumBtn = h('button', { class: 'tap' },
    h('div', { class: 'sum money', text: money0(s.debts.owedToUs) }),
    h('div', {
      class: 'sub',
      text: s.debts.owedToUs
        ? `должны вам · ${s.counts.debtors} ${plural(s.counts.debtors, 'контрагент', 'контрагента', 'контрагентов')}`
        : 'все рассчитались',
    }),
    // Главная жалоба: «удалил документы, а сумма прежняя». Чаще всего её
    // держит начальное сальдо или ручная проводка — и об этом надо сказать
    // там же, где стоит цифра, а не в переписке с поддержкой.
    s.debts.owedToUs ? h('div', { class: 'why', text: 'Из чего эта сумма →' }) : null);
  sumBtn.onclick = () => { haptic(); go('why'); };

  box.append(h('div', { class: 'hero' },
    h('div', { class: 'greet', text: s.user.name ? `Здравствуйте, ${s.user.name.split(' ')[0]}` : 'Здравствуйте' }),
    sumBtn));

  // Спросить словами — рядом с главным действием, а не в «Ещё»: это второй
  // способ сделать то же самое, и прятать его вглубь бессмысленно.
  const askRow = h('button', { class: 'row' },
    h('span', { class: 'icon-box' }, icon('mic')),
    h('span', { class: 'grow' },
      h('div', { text: 'Спросить словами' }),
      h('div', { class: 'small muted', text: 'голосом или текстом — про документы и долги' })),
    icon('chev', 'chev'));
  askRow.onclick = () => { haptic(); go('ask'); };
  box.append(h('div', { class: 'card' }, askRow));

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
    // «Ждут оплаты», а не «Счета»: при основании «по отгрузке» в этой
    // плитке стоят акты и накладные — счёт долга там не создаёт.
    h('button', { class: 'stat', onclick: () => { haptic(); go('unpaid'); } },
      h('div', { class: 'k', text: 'Ждут оплаты' }),
      h('div', { class: 'v money', text: money0(unpaid.sum) }))));

  /*
   * Крупная цифра сверху — ноль, а неоплаченные счета есть.
   *
   * Так бывает законно: при основании «долг по отгрузке» долг создают акт,
   * УПД и накладная, а счёт — нет. Но человеку, который работает счетами,
   * это выглядит как сломанная цифра: он выписывает и удаляет счета, а
   * главное число не шевелится. Поэтому говорим причину прямо здесь и даём
   * исправить в одно нажатие — с пересчётом уже выписанного.
   */
  if (s.basisMismatch) {
    const m = s.basisMismatch;
    // Куда переключать — говорит сервер, по самим документам. Кнопка «по
    // счетам» у того, у кого счета уже включены, ничего не меняла и
    // рапортовала «Готово» — замкнутый круг вместо помощи.
    const toBill = m.to === 'invoice';
    const fix = h('button', { class: 'btn' }, toBill ? 'Считать долг по счетам' : 'Считать долг по актам');
    fix.onclick = () => withBusy(fix, async () => {
      const r = await api('POST', '/api/basis', { basis: m.to });
      haptic('medium');
      const f = r.fixed || {};
      toast(f.added
        ? `Пересчитал: долг появился по ${f.added} ${plural(f.added, 'документу', 'документам', 'документам')}`
        : (f.paid ? `Пересчитал журнал: поправлено строк оплаты — ${f.paid}` : 'Готово'));
      cache = {};
      reset('home');
    });
    const what = toBill ? ['счёт', 'счёта', 'счетов'] : ['документ', 'документа', 'документов'];
    box.append(h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('span', { class: 'icon-box warn' }, icon('warn')),
        h('span', { class: 'grow' },
          h('div', { text: toBill ? 'Долг считается по актам, а не по счетам'
            : 'Долг считается по счетам, а не по актам' }),
          /*
           * Три формулировки на три разных состояния.
           *
           * «Сверху ноль» годится, только когда там действительно ноль.
           * Когда долг есть, но не тот, — «их не видно». А после загрузки
           * выписки положение третье и самое пугающее: деньги пришли, счета
           * помечены оплаченными, обязательства по ним не возникало — и
           * клиент, который расплатился, показан тем, кому должны мы. Формально
           * это аванс, но человеку, работающему счетами, нужно не объяснение
           * термина, а кнопка.
           */
          h('div', { class: 'small muted', text: (m.advance
            ? `Деньги по ним уже пришли, а обязательства не возникло — поэтому ${m.count} `
            : (m.zero === false
              ? `Поэтому в долгах их не видно: ${m.count} `
              : `Поэтому сверху ноль, хотя ${m.count} `))
            + `${plural(m.count, ...what)} на ${money0(m.sum)} `
            + (m.advance ? 'показаны авансом, будто должны вы. ' : 'не оплачены. ')
            + (toBill
              ? 'Если для вас долг возникает со счёта — переключите, я пересчитаю прошлые.'
              : 'Если для вас долг возникает с акта — переключите, я пересчитаю прошлые.') }))),
      h('div', { class: 'btn-wrap' }, fix)));
  }

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
    ['pp', 'wallet', 'Платёжка', 'форма 0401060 для банка'],
    ['dog', 'pen', 'Договор', 'условия на бумаге'],
  ];
  box.append(h('div', { class: 'section-title', text: 'Другие документы' }));
  const OTHER = ['pp', 'dog'];   // набираются полями, а не позициями
  box.append(h('div', { class: 'tiles' }, types.map(([type, ico, title, sub]) => h('button', {
    class: 'tile',
    onclick: () => { haptic(); go(OTHER.includes(type) ? 'other' : 'new', { type }); },
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

/*
 * Из чего складывается «должны вам».
 *
 * Экран отвечает на один вопрос, который задают чаще всего: почему цифра не
 * шевелится, когда документы удаляются. Ответ почти всегда в том, что её
 * держат не документы, — и пока это не сказано вслух, число выглядит мёртвым.
 */
screens.why = async function why() {
  const b = await api('GET', '/api/debts/why');
  const box = h('div', {}, h('h1', { text: 'Из чего эта сумма' }));
  box.append(h('div', { class: 'hero' }, h('div', { class: 'sum money', text: money0(b.total) })));

  const parts = [
    ['Начальное сальдо', b.opening, 'долг, который был до бота — из карточек контрагентов', 'cps'],
    ['Документы', b.docs, 'акты, УПД, накладные и счета — уходит вместе с документом', 'docs'],
    ['Внесено руками', b.manual, 'операции из журнала и банковской выписки', 'debts'],
  ].filter(([, v]) => v);

  const lost = (b.orphanCount || 0) + (b.orphanOther || 0);
  if (!parts.length && !lost) {
    box.append(empty('wallet', 'Никто не должен', 'Все расчёты сошлись.'));
    return box;
  }

  if (parts.length) {
    box.append(h('div', { class: 'card' }, parts.map(([title, v, sub, screen]) => navRow({
      icon: 'wallet', title, sub, right: money(v), onclick: () => go(screen),
    }))));

    // Слово «удалил» звучит в каждой жалобе, поэтому объясняем именно его.
    box.append(h('div', { class: 'card' }, h('div', { class: 'row muted small' },
      'Удаление документа снимает только его строку. Начальное сальдо правится '
      + 'в карточке контрагента, ручные операции — в журнале.')));
  }

  if (lost) {
    // Сирот, сидящих в самой сумме, и сирот у остальных контрагентов
    // называем врозь: одним числом вышло бы «три операции держат 3 000»,
    // хотя держит одна, а две другие гасят друг друга у другого клиента.
    // Считаем держащими только тех, кто действительно что-то держит: две
    // операции, гасящие друг друга, дали бы «0,00 ₽ держат 2 операции».
    const held = b.orphan ? b.orphanCount : 0;
    const rest = lost - held;
    const here = held
      ? `${money(b.orphan)} в этой сумме держат ${held} `
        + `${plural(held, 'операция', 'операции', 'операций')}`
      : 'На саму сумму они не влияют, но в журнале есть';
    const other = rest
      ? `${held ? '. Ещё' : ':'} ${rest} `
        + `${plural(rest, 'такая операция', 'такие операции', 'таких операций')}`
      : '';
    box.append(h('div', { class: 'card' }, h('div', { class: 'row' },
      h('span', { class: 'icon-box warn' }, icon('warn')),
      h('span', { class: 'grow' },
        h('div', { text: 'Строки без документа' }),
        h('div', { class: 'small muted', text: `${here}${other}. Они остались от документов, `
          + 'удалённых старой версией бота. Из приложения их не убрать — напишите в поддержку.' }))),
    h('div', { class: 'btn-wrap' },
      h('button', { class: 'btn secondary', onclick: () => { haptic(); go('support'); } },
        'Написать в поддержку'))));
  }
  return box;
};

screens.docs = async function docs({ cp } = {}) {
  // Сервер умеет отдавать журнал по одному клиенту — в приложении этим
  // никто не пользовался, хотя из его карточки это первое, что нужно.
  const { docs: list } = await api('GET', `/api/docs${cp ? `?cp=${cp}` : ''}`);
  // Режим НДС нужен, чтобы решить, показывать ли счета-фактуры. Кэш может
  // быть пуст, если на этот экран пришли сразу по ссылке.
  const st = cache.org ? cache : await api('GET', '/api/state');
  const box = h('div', {}, h('h1', { text: 'Документы' }));
  if (!list.length) {
    /*
     * Пустой журнал — не значит «денег нет». Оплаты и приходы вносят руками,
     * и они живут отдельно от документов: человек видел здесь пустоту и
     * тупик, хотя за клиентами числились суммы. Поэтому второй выход —
     * в журнал операций.
     */
    box.append(empty('doc', 'Документов пока нет',
      'Здесь появятся выписанные документы — их можно переслать заново или повторить '
      + 'новым номером. Оплаты и приходы вносятся отдельно, в журнале операций.',
      h('div', { class: 'btn-wrap' },
        h('button', { class: 'btn', onclick: () => { haptic('medium'); go('new', { type: 'sch', cpId: cp }); } },
          'Выписать счёт'),
        h('button', {
          class: 'btn secondary',
          onclick: () => { haptic(); go(cp ? 'ops' : 'cps', cp ? { cpId: cp } : {}); },
        }, 'Внести оплату или приход'))));
    return box;
  }
  // Оплачен или нет — то, ради чего в журнал и заходят. Без метки строки
  // отличаются только суммой, и статус приходится помнить в голове.
  const paidBadge = (d) => (d.paidAt ? { badge: 'Оплачен', badgeTone: 'ok' }
    : (['sch', 'schdog', 'usl', 'upd', 'torg12'].includes(d.type) ? { badge: 'Ждёт оплаты' } : {}));
  box.append(h('div', { class: 'btn-wrap' },
    h('button', { class: 'btn', onclick: () => { haptic('medium'); go('new', { type: 'sch' }); } },
      'Выписать документ')));
  /*
   * Счета-фактуры — отдельным рядом и только плательщику НДС. Кнопка, ведущая
   * к отказу, хуже отсутствующей: человек решит, что сломано, а не что нельзя.
   */
  if (cp && st.org && st.org.vat_rate && !Number(st.org.npd)) {
    box.append(h('div', { class: 'btn-wrap' },
      h('button', { class: 'btn secondary', onclick: () => { haptic('medium'); go('avans', { cpId: cp }); } },
        'СФ на аванс'),
      h('button', { class: 'btn secondary', onclick: () => { haptic('medium'); go('ksf', { cpId: cp }); } },
        'Корректировка')));
  }

  box.append(h('div', { class: 'card' }, list.map((d) => swipeToDelete(
    navRow({
      icon: 'doc',
      title: `${d.title} № ${d.number}`,
      sub: ru(d.date),
      ...paidBadge(d),
      right: d.total ? money0(d.total) : '',
      onclick: () => go('doc', { id: d.id }),
    }),
    {
      label: `Удалить ${d.title} № ${d.number}`,
      onDelete: async () => {
        const r = await api('POST', '/api/doc/delete', { id: d.id });
        haptic('medium');
        toast(deletedText(d, r));
        render();
      },
    },
  ))));
  return box;
};

/**
 * Смахивание влево — «Удалить», как в списках на iPhone.
 *
 * Две вещи делают жест безопасным. Во-первых, удаляет не сам свайп, а
 * появившаяся кнопка: смахнуть можно случайно, пролистывая, а документ
 * уходит вместе с проводкой и долгом, и вернуть его нечем. Во-вторых,
 * вертикальное движение отдаётся странице — иначе список перестал бы
 * прокручиваться на телефоне.
 *
 * @param {HTMLElement} row строка, которую двигаем
 * @param {{label: string, onDelete: Function}} opts
 */
function swipeToDelete(row, opts) {
  const WIDTH = 92;                     // ширина кнопки под строкой
  const del = h('button', {
    class: 'swipe-del', type: 'button', 'aria-label': opts.label,
    onclick: (e) => {
      e.stopPropagation();
      withBusy(e.currentTarget, opts.onDelete);
    },
  }, icon('trash'));

  const wrap = h('div', { class: 'swipe' }, del, row);
  row.classList.add('swipe-face');

  let x0 = 0; let y0 = 0; let dx = 0;
  let axis = '';                        // '', 'x' или 'y' — решается один раз за жест
  let open = false;

  const put = (v, animate) => {
    row.style.transition = animate ? 'transform .18s ease' : '';
    row.style.transform = `translateX(${v}px)`;
  };
  const close = () => { open = false; put(0, true); };

  row.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; dx = 0; axis = '';
    row.style.transition = '';
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    const mx = t.clientX - x0;
    const my = t.clientY - y0;
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    }
    if (axis !== 'x') return;           // это прокрутка списка, не наше дело
    // Тянуть влево можно до ширины кнопки, вправо — только закрывая.
    dx = Math.max(-WIDTH, Math.min(0, (open ? -WIDTH : 0) + mx));
    put(dx, false);
  }, { passive: true });

  row.addEventListener('touchend', () => {
    if (axis !== 'x') return;
    // Порог — половина кнопки: иначе строка застревает в промежуточном
    // положении, где непонятно, открыта она или нет.
    open = dx < -WIDTH / 2;
    put(open ? -WIDTH : 0, true);
    if (open) haptic();
  });

  // Нажатие по строке в открытом состоянии — сначала закрыть, а не открыть
  // карточку: иначе жест выглядит как случайное срабатывание.
  row.addEventListener('click', (e) => {
    if (open) { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);

  return wrap;
}

screens.doc = async function docScreen({ id }) {
  const { docs: list } = await api('GET', '/api/docs');
  const d = list.find((x) => x.id === Number(id));
  if (!d) return empty('warn', 'Документ не найден', 'Возможно, он был убран из журнала.');

  // Кому выписан — первое, что ищут в карточке. Раньше здесь были только
  // дата и сумма, и понять, чей это документ, было нельзя.
  const cpsList = (await api('GET', '/api/cps')).cps;
  const cpOf = cpsList.find((x) => x.id === d.cpId) || null;

  const box = h('div', {}, h('h1', { text: `${d.title} № ${d.number}` }));

  /*
   * Напоминание про чек «Моего налога». Живёт до следующего перерисовывания
   * экрана: сообщением-всплывашкой его бы закрыли не читая, а в карточке оно
   * остаётся на виду ровно столько, сколько человек здесь находится.
   */
  if (pendingCheque) {
    const note = pendingCheque;
    pendingCheque = null;
    box.append(h('div', { class: 'banner info' }, icon('receipt'),
      h('div', {},
        h('div', { style: 'white-space:pre-line', text: note.text }),
        h('button', {
          class: 'btn secondary',
          style: 'margin-top:10px',
          onclick: () => openOutside(note.url),
        }, 'Открыть «Мой налог»'))));
  }
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
  if (['sch', 'schdog', 'usl', 'upd', 'torg12'].includes(d.type) && d.total) {
    const paid = Boolean(d.paidAt);
    box.append(h('div', { class: 'section-title', text: 'Оплата' }));
    box.append(h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('span', { class: `icon-box ${paid ? 'ok' : ''}` }, icon(paid ? 'check' : 'clock')),
        h('span', { class: 'grow' },
          h('div', { text: paid ? 'Оплачен' : 'Ждёт оплаты' }),
          h('div', {
            class: 'small muted',
            text: paid ? `отмечено ${ru(d.paidAt)}`
              : (d.noDebt ? 'долг по этому документу отменён вручную' : 'долг числится за клиентом'),
          })))));
    // Отмену проводки надо уметь отменить: без этой кнопки документ навсегда
    // выпадал из долга, продолжая числиться в ожидающих оплаты.
    if (d.noDebt) {
      box.append(h('div', { class: 'btn-wrap' }, h('button', {
        class: 'btn secondary',
        onclick: (e) => withBusy(e.currentTarget, async () => {
          await api('POST', '/api/doc/debt', { id: d.id });
          haptic('medium');
          toast('Документ вернулся в долг');
          render();
        }),
      }, 'Вернуть в долг')));
    }
    box.append(h('div', { class: 'btn-wrap' }, h('button', {
      class: paid ? 'btn ghost' : 'btn',
      onclick: (e) => withBusy(e.currentTarget, async () => {
        const r = await api('POST', '/api/doc/paid', { id: d.id, paid: !paid });
        haptic('medium');
        toast(paid ? 'Отметка снята' : 'Отмечено как оплаченный');
        // Самозанятому именно сейчас надо выдать чек: счёт и акт доход не
        // закрывают. Момент единственный — деньги переводом приходят молча,
        // документ уже выписан, и всё выглядит законченным.
        if (r && r.npd) pendingCheque = r.npd;
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

  /*
   * Штампы на копии. Акт сверки сюда не попадает: он приходит таблицей
   * Excel, а не бланком, и штамповать в нём нечего.
   *
   * Состояние живёт прямо здесь, а не в базе: штамп — это свойство копии,
   * которую сейчас печатают, а не самого документа. Один и тот же счёт
   * сегодня уходит клиенту со штампом «Оплачено», а завтра подшивается
   * без него.
   */
  const stamp = { paid: false, copy: false };
  if (d.type !== 'akt') {
    const chip = (key, label) => {
      const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false' }, label);
      b.onclick = () => {
        stamp[key] = !stamp[key];
        b.setAttribute('aria-pressed', String(stamp[key]));
        haptic('light');
      };
      return b;
    };
    const chips = [chip('copy', 'Копия')];
    // «Оплачено» предлагаем только тогда, когда оплата отмечена в журнале.
    // Штамп — это утверждение о деньгах, и придумывать его нельзя.
    if (d.paidAt) chips.unshift(chip('paid', `Оплачено ${ru(d.paidAt)}`));
    box.append(h('div', { class: 'section-title', text: 'Штамп на копии' }));
    box.append(h('div', { class: 'chips' }, chips));
    if (!d.paidAt && ['sch', 'schdog', 'usl', 'upd', 'torg12'].includes(d.type) && d.total) {
      box.append(h('p', {
        class: 'small muted',
        style: 'margin:-4px 18px 8px',
        text: 'Штамп «Оплачено» появится здесь, когда вы отметите оплату.',
      }));
    }
  }

  /*
   * Ссылка на документ.
   *
   * Счёт клиенту чаще отправляют в переписке, чем почтой, а файл в переписке
   * живёт плохо: на телефоне открывается через раз, в общем чате теряется, а
   * после правки у получателя остаётся старая бумага. По ссылке документ
   * собирается заново в момент открытия — и всегда свежий.
   *
   * Ссылка временная и её можно отозвать: кто её получил, тот и видит
   * реквизиты с суммами, поэтому лежать в чужом чате вечно она не должна.
   */
  {
    const info = await api('GET', `/api/doc/link?id=${d.id}`);
    const linkBox = h('div', {});
    const drawLink = (links) => {
      linkBox.textContent = '';
      if (!links.length) {
        linkBox.append(h('p', {
          class: 'small muted',
          style: 'margin:0 18px 8px',
          text: `Короткий адрес на этот документ — отправить клиенту в переписку. `
            + `Действует ${info.days} ${plural(info.days, 'день', 'дня', 'дней')}, отозвать можно в любой момент.`,
        }));
        linkBox.append(h('div', { class: 'btn-wrap' }, h('button', {
          class: 'btn secondary',
          onclick: (e) => withBusy(e.currentTarget, async () => {
            const r = await api('POST', '/api/doc/link', { id: d.id, stamp });
            haptic('medium');
            drawLink([r.link]);
          }),
        }, 'Сделать ссылку')));
        return;
      }
      const one = links[0];
      const box2 = h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('span', { class: 'grow ellipsis small', text: one.url })),
        h('div', { class: 'row' },
          h('span', { class: 'grow muted small', text: `Действует до ${ru(one.expiresAt.slice(0, 10))}` }),
          h('span', {
            class: 'small muted',
            text: one.opens ? `открывали ${one.opens} ${plural(one.opens, 'раз', 'раза', 'раз')}` : 'ещё не открывали',
          })));
      linkBox.append(box2);
      linkBox.append(h('div', { class: 'btn-wrap' },
        h('button', {
          class: 'btn secondary',
          onclick: () => shareToTelegram(one.url,
            `${d.title} № ${d.number} от ${ru(d.date)}`),
        }, 'Отправить в Telegram'),
        h('button', {
          class: 'btn ghost',
          onclick: async (e) => {
            try {
              await navigator.clipboard.writeText(one.url);
              haptic('medium');
              toast('Ссылка скопирована');
            } catch (_) {
              // Буфер даёт не всякий браузер. Выделяем — скопирует руками.
              toast('Скопируйте адрес вручную', true);
              e.currentTarget.blur();
            }
          },
        }, 'Скопировать'),
        h('button', {
          class: 'btn ghost',
          onclick: (e) => withBusy(e.currentTarget, async () => {
            await api('POST', '/api/doc/link/revoke', { id: d.id });
            haptic('medium');
            toast('Ссылка больше не работает');
            drawLink([]);
          }),
        }, 'Отозвать')));
    };
    if (info.available) {
      box.append(h('div', { class: 'section-title', text: 'Ссылка на документ' }));
      drawLink(info.links || []);
      box.append(linkBox);
    }
  }

  // Главное действие на экране одно. Если у счёта не отмечена оплата —
  // главное это она; пересылка файла тогда вторична.
  box.append(h('div', { class: 'btn-wrap' },
    h('button', {
      class: ['sch', 'schdog', 'usl', 'upd', 'torg12'].includes(d.type) && d.total && !d.paidAt ? 'btn secondary' : 'btn',
      onclick: (e) => withBusy(e.currentTarget, async () => {
        const r = await api('POST', '/api/doc/resend', { id: d.id, stamp });
        toast('Файл отправлен в чат с ботом');
        haptic('medium');
        download(r.file);
      }),
    }, 'Прислать файл заново')));

  /*
   * Исправление — только у счёта-фактуры (УПД со статусом 1).
   *
   * Пересобирает тот же документ по текущим данным: поправили ИНН клиента в
   * карточке — исправление выйдет с верным. Номер и дата остаются прежними.
   * Для изменения стоимости по договорённости это не годится: там
   * корректировочный, и это другой документ.
   */
  if (d.type === 'upd' && d.status === 1) {
    box.append(h('div', { class: 'btn-wrap' },
      h('button', {
        class: 'btn secondary',
        onclick: (e) => withBusy(e.currentTarget, async () => {
          try {
            const r = await api('POST', '/api/doc/fix', { id: d.id });
            haptic('medium');
            toast(`Исправление № ${r.no} готово`);
            download(r.file);
          } catch (err) { toast(err.message, true); }
        }),
      }, d.fixNo ? `Исправление № ${d.fixNo + 1}` : 'Выставить исправление')));
    box.append(h('p', { class: 'small muted', style: 'margin:4px 18px',
      text: 'Номер и дата счёта-фактуры не изменятся — так и должно быть. '
        + 'Если меняется стоимость по договорённости, нужен корректировочный.' }));
  }

  /*
   * Отправка клиенту на почту — если она настроена на сервере.
   *
   * Акт сверки отсюда исключался, потому что не умел пересобираться: он
   * строится из журнала операций, а не из позиций. Теперь умеет, а
   * отправляют его чаще прочего — сверка нужна не себе, а контрагенту.
   */
  const st = cache.features ? cache : await api('GET', '/api/state');
  if (st.features && st.features.mail) {
    const cp = cpOf || {};
    const mailField = field('email', 'Почта получателя', cp.email, {
      type: 'email', placeholder: 'buh@company.ru',
      hint: cp.email ? 'Сохранена у контрагента' : 'Запомню её для этого контрагента',
    });
    box.append(h('div', { class: 'section-title', text: 'Отправить клиенту' }));
    if (d.type === 'akt') {
      box.append(h('p', { class: 'small muted', style: 'margin:0 18px 8px',
        text: 'В письме будет просьба сверить и ответить: подписать, если сходится, '
          + 'или назвать строку, если нет.' }));
    }
    box.append(h('div', { class: 'card' }, mailField));
    box.append(h('div', { class: 'btn-wrap' }, h('button', {
      class: 'btn secondary',
      onclick: (e) => withBusy(e.currentTarget, async () => {
        clearErrors({ mailField });
        const to = mailField.input.value.trim();
        if (!to) { showError(mailField, 'Без адреса отправить некуда'); return; }
        const r = await api('POST', '/api/doc/mail', { id: d.id, email: to, stamp });
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

    /*
     * Повторение заводится отсюда: позиции уже проверены человеком, остаётся
     * назвать число. 29–31 в списке нет — таких чисел нет в каждом месяце.
     *
     * У счёта спрашиваем не «когда напомнить», а число из договора: платят
     * к нему, счёт нужен заранее, а на следующий день после срока — сигнал
     * о просрочке. Одно число задаёт весь цикл.
     */
    const isBill = ['sch', 'schdog'].includes(d.type);
    const panel = h('div', { hidden: true });

    const save = (body, done) => withBusy(done, async () => {
      const r = await api('POST', '/api/recurring', { docId: d.id, ...body });
      haptic('medium');
      toast(r.payDay ? `Счёт ${r.offerDay}-го, оплата ${r.payDay}-го` : `Напомню ${r.dayText}`);
      go('recurring');
    });

    const dayRows = (onPick, label) => h('div', { class: 'card' },
      [1, 5, 10, 15, 20, 25, 0].map((day) => h('button', {
        class: 'row',
        onclick: (e) => onPick(day, e.currentTarget),
      },
      h('span', { class: 'icon-box' }, icon('clock')),
      h('span', { class: 'grow', text: label(day) }))));

    if (isBill) {
      const lead = h('div', { hidden: true });
      panel.append(
        h('div', { class: 'section-title', text: 'Какого числа клиент платит по договору' }),
        dayRows((day, btn) => {
          if (!day) { save({ day: 0 }, btn); return; }
          // Второй шаг вместо готового ответа: «за 3 дня» — обычай, а не
          // правило, и в договоре может стоять другой срок.
          lead.replaceChildren(
            h('div', { class: 'section-title', text: `Оплата ${day}-го. Выставлять счёт` }),
            h('div', { class: 'card' }, [3, 5, 7, 0].map((days) => h('button', {
              class: 'row',
              onclick: (e) => save({ payDay: day, leadDays: days }, e.currentTarget),
            },
            h('span', { class: 'icon-box' }, icon('send')),
            h('span', { class: 'grow', text: days ? `за ${days} ${plural(days, 'день', 'дня', 'дней')}` : 'в день оплаты' })))));
          lead.hidden = false;
          lead.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          haptic();
        }, (day) => (day ? `${day}-го числа` : 'В последний день месяца')),
        lead,
      );
    } else {
      panel.append(
        h('div', { class: 'section-title', text: 'Какого числа напоминать' }),
        dayRows((day, btn) => save({ day }, btn),
          (day) => (day ? `${day}-го числа` : 'В последний день месяца')),
      );
    }

    const repeat = h('button', { class: 'btn ghost' }, 'Повторять каждый месяц');
    repeat.onclick = () => {
      panel.hidden = !panel.hidden;
      haptic();
    };
    box.append(h('div', { class: 'btn-wrap' }, repeat), panel);
  }

  /*
   * Удаление — с подтверждением в две ступени, без модального окна.
   * Документ уходит вместе со своей проводкой, и вернуть его нельзя:
   * спрашиваем прямо, а не прячем предупреждение мелким шрифтом.
   */
  const del = h('button', { class: 'btn danger' }, 'Удалить документ');
  del.onclick = () => {
    const sure = h('button', { class: 'btn danger' }, 'Да, удалить безвозвратно');
    sure.onclick = () => withBusy(sure, async () => {
      const r = await api('POST', '/api/doc/delete', { id: d.id });
      haptic('medium');
      toast(deletedText(d, r));
      reset('docs');
    });
    del.replaceWith(h('div', {},
      h('p', { class: 'small muted', style: 'margin:0 6px 10px', text: d.debt
        ? `Документ исчезнет из журнала вместе со своей проводкой: долг клиента изменится на ${money(Math.abs(d.debt))}.`
        : 'Документ исчезнет из журнала. Проводки у него нет — сальдо клиента не изменится.' }),
      sure));
  };
  box.append(h('div', { class: 'btn-wrap' }, del));
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
    // Сумма без знака непонятна: в списке рядом стоят и должники, и те,
    // кому должны мы, а цифра у обоих выглядела одинаково.
    rightTone: balanceTone(cp),
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

screens.cp = async function cpScreen({ id, name }) {
  let cp = {};
  if (id) {
    const { cps: list } = await api('GET', '/api/cps');
    cp = list.find((x) => x.id === Number(id)) || {};
  } else if (name) {
    // Имя, названное в чате. Подставляем как заготовку — заводит запись
    // всё равно человек, нажав «Сохранить».
    cp = { name: String(name) };
  }
  const f = {
    name: field('name', 'Краткое название', cp.name, { required: true, placeholder: 'ООО «Заря»' }),
    full_name: field('full_name', 'Полное наименование', cp.full_name),
    inn: field('inn', 'ИНН', cp.inn, { inputmode: 'numeric', hint: 'Заполним остальное из реестра' }),
    kpp: field('kpp', 'КПП', cp.kpp, { inputmode: 'numeric' }),
    address: field('address', 'Адрес', cp.address),
    opening_balance: field('opening_balance', 'Начальное сальдо, ₽', cp.opening_balance || '', {
      inputmode: 'decimal',
      hint: 'Сколько числилось за клиентом, когда начали вести расчёты. 0 — если с нуля',
    }),
    opening_date: field('opening_date', 'На какую дату', cp.opening_date || '', {
      type: 'date', hint: 'С неё начинается акт сверки',
    }),
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

  // То же самое, но без нажатия: дописали ИНН — поля заполнились.
  autoLookup(f, (r) => {
    if (r.party) {
      if (!f.name.input.value) f.name.input.value = r.party.name || '';
      f.full_name.input.value = r.party.full_name || f.full_name.input.value;
      f.kpp.input.value = r.party.kpp || f.kpp.input.value;
      f.address.input.value = r.party.address || f.address.input.value;
      toast(`Нашёл: ${r.party.name}`);
    }
    if (r.bank) {
      f.bank_name.input.value = r.bank.bank_name || f.bank_name.input.value;
      f.corr_acc.input.value = r.bank.corr_acc || f.corr_acc.input.value;
      toast(`Банк: ${r.bank.bank_name}`);
    }
  });

  const box = h('div', {}, h('h1', { text: id ? cp.name || 'Клиент' : 'Новый клиент' }));

  /*
   * Действия по клиенту — сверху, перед полями. В карточку заходят, чтобы
   * выписать счёт, внести оплату или собрать акт сверки, а реквизиты правят
   * раз в жизни. Раньше здесь были только поля, и всё это жило в боте.
   */
  /*
   * Строка сальдо ведёт к начальному сальдо — по ней и тыкают.
   *
   * Раньше это был мёртвый div: выглядел как соседние строки, стоял первым
   * в карточке и на нажатие не отвечал ничем. Человек, которому нужно
   * выставить долг «с прошлого года», жмёт именно на цифру — а поля для
   * него лежат экраном ниже, за реквизитами и почтой, и найти их нельзя.
   */
  const openingHint = () => {
    const v = Number(cp.opening_balance) || 0;
    if (!v) return 'Задать начальное сальдо';
    return `Начали с ${money(Math.abs(v))}${cp.opening_date ? ` на ${ru(cp.opening_date)}` : ''}`;
  };
  const gotoOpening = () => {
    const el = f.opening_balance.input;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // preventScroll — иначе браузер дёрнет экран второй раз, поверх плавного.
    setTimeout(() => el.focus({ preventScroll: true }), 350);
  };

  if (id) {
    /*
     * Сумма стоит отдельной строкой, а не справа от заголовка.
     *
     * Справа ей не хватало места: подпись «Начали с 105 691,30 ₽ на
     * 01.08.2026» шире половины экрана, и шестизначная сумма налезала на
     * слова «Должен нам». А это главная цифра карточки — ради неё сюда и
     * заходят, ей и место построчнее.
     */
    const balanceRow = h('button', { class: 'row balance' },
      h('span', { class: 'grow' },
        h('div', { class: 'ellipsis muted small',
          text: cp.balance ? (owesUs(cp) ? 'Должен нам' : 'Должны мы') : 'Сальдо' }),
        h('div', { class: `v money ${balanceTone(cp)}`, text: money(Math.abs(cp.balance || 0)) }),
        h('div', { class: 'hint', text: openingHint() })),
      icon('chev', 'chev'));
    balanceRow.onclick = () => { haptic(); gotoOpening(); };

    box.append(h('div', { class: 'card' },
      balanceRow,
      navRow({ icon: 'list', title: 'Журнал операций', sub: 'внесённое руками и из выписки',
        onclick: () => go('ops', { cpId: id }) }),
      navRow({ icon: 'receipt', title: 'Выписать счёт', onclick: () => go('new', { type: 'sch', cpId: id }) }),
      navRow({ icon: 'wallet', title: 'Внести оплату или приход', onclick: () => go('op', { cpId: id }) }),
      navRow({ icon: 'doc', title: 'Акт сверки', sub: 'таблица операций в Excel',
        onclick: async () => {
          try {
            const r = await api('GET', `/api/akt?cp=${id}`);
            toast('Акт сверки готов');
            download(r.file);
          } catch (e) { toast(e.message, true); }
        } }),
      navRow({ icon: 'docs2', title: 'Документы клиента', onclick: () => go('docs', { cp: id }) })));
    box.append(h('div', { class: 'section-title', text: 'Реквизиты' }));
  }

  box.append(h('div', { class: 'card' }, f.name, f.full_name,
    h('div', { class: 'field' }, h('label', { for: 'f-kind', text: 'Кто это' }), kindSel)));
  if (!id) box.append(h('div', { class: 'section-title', text: 'Реквизиты' }));
  box.append(h('div', { class: 'card' }, f.inn, f.kpp, f.address, f.email));

  /*
   * Начальное сальдо. Без него акт сверки открывается нулём, и клиент,
   * у которого долг тянется с прошлого года, такой акт не подпишет.
   * В боте это спрашивали при заведении, в приложении задать было негде.
   */
  box.append(h('div', { class: 'section-title', text: 'С чего начинаем расчёты' }));
  box.append(h('div', { class: 'card' }, f.opening_balance, f.opening_date));
  box.append(h('div', { class: 'btn-wrap' }, lookup));
  box.append(h('div', { class: 'section-title', text: 'Банк' }));
  box.append(h('div', { class: 'card' }, f.bank_name, f.bik, f.acc, f.corr_acc));

  const save = async () => {
    clearErrors(f);
    const v = values(f);
    if (!v.name) { showError(f.name, 'Без названия документ не подписать'); return; }
    await api('POST', '/api/cp', {
      id: id || 0, ...v, kind: kindSel.value,
      opening_balance: f.opening_balance.input.value.trim(),
      opening_date: f.opening_date.input.value,
    });
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
    ogrnip: field('ogrnip', 'ОГРНИП', o.ogrnip, { inputmode: 'numeric', hint: 'Подставится по ИНН; печатается в УПД' }),
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

  /*
   * У предпринимателя нет КПП, у организации нет ОГРНИП. Показывать оба
   * поля всем значит просить человека решать, что из этого про него, —
   * а он впишет наугад. Определяем по длине ИНН и прячем лишнее.
   */
  const ipFields = () => {
    const ip = String(f.inn.input.value || '').replace(/\D/g, '').length === 12;
    f.kpp.hidden = ip;
    f.ogrnip.hidden = !ip;
  };
  f.inn.input.addEventListener('input', ipFields);
  ipFields();

  autoLookup(f, (r) => {
    if (r.party) {
      if (!f.name.input.value) f.name.input.value = r.party.name || '';
      f.full_name.input.value = r.party.full_name || f.full_name.input.value;
      f.kpp.input.value = r.party.kpp || f.kpp.input.value;
      f.address.input.value = r.party.address || f.address.input.value;
      if (r.party.ogrnip) f.ogrnip.input.value = r.party.ogrnip;
      if (r.party.signer && !f.signer.input.value) f.signer.input.value = r.party.signer;
      ipFields();
      toast(`Нашёл: ${r.party.name}`);
    }
    if (r.bank) {
      f.bank_name.input.value = r.bank.bank_name || f.bank_name.input.value;
      f.corr_acc.input.value = r.bank.corr_acc || f.corr_acc.input.value;
      toast(`Банк: ${r.bank.bank_name}`);
    }
  });

  const box = h('div', {}, h('h1', { text: 'Моя организация' }));
  box.append(h('div', { class: 'banner info' }, icon('help'),
    h('div', { text: 'Эти реквизиты подставляются во все документы. Заполняются один раз.' })));

  box.append(h('div', { class: 'section-title', text: 'Быстрый ввод' }));
  box.append(h('div', { class: 'card' },
    h('div', { class: 'field' }, h('label', { for: 'f-paste', text: 'Вставить блок реквизитов' }), paste)));
  box.append(h('div', { class: 'btn-wrap' }, parseBtn));

  box.append(h('div', { class: 'section-title', text: 'Организация' }));
  box.append(h('div', { class: 'card' }, f.name, f.full_name, f.inn, f.kpp, f.ogrnip, f.signer, f.address));
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
        // ОГРНИП раньше не подставлялся ниоткуда: поле было, в УПД
        // печаталось, и всегда пустовало.
        if (r.party.ogrnip) f.ogrnip.input.value = r.party.ogrnip;
        if (r.party.signer) f.signer.input.value = r.party.signer;
        ipFields();
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
/** Примерный вес data-URI в байтах — считать по длине дешевле, чем декодировать. */
const dataUrlBytes = (url) => Math.ceil((url.length - url.indexOf(',') - 1) * 0.75);

/**
 * Закодировать холст, проверив, что браузер послушался.
 *
 * toDataURL при незнакомом типе молча отдаёт PNG. Без этой проверки мы бы
 * считали, что отправляем WebP на 400 КБ, а отправляли бы PNG на 2,5 МБ —
 * ровно та ошибка, из-за которой не грузилась печать.
 */
function encodeCanvas(canvas, type, quality) {
  const url = canvas.toDataURL(type, quality);
  return url.startsWith(`data:${type}`) ? url : null;
}

/**
 * Уменьшить картинку и уложиться в отведённый вес.
 *
 * Раньше здесь всегда был PNG. Для подписи на белом листе это работало —
 * такой снимок сжимается хорошо, — а фотография печати весила 2,5 МБ при
 * пределе в 1 МБ, и человек видел отказ, ничего не сделав неправильно.
 * PNG хорош для рисунков, а тут всегда фотография: берём WebP, затем JPEG,
 * и только если браузер не умеет ни того, ни другого — PNG.
 *
 * Прозрачность заливаем белым в любом случае: на документе факсимиле
 * ложится умножением, где белое становится невидимым.
 */
function shrinkImage(file, maxSide = 1400, maxBytes = 900 * 1024) {
  return new Promise((done, fail) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      const render = (side) => {
        const scale = Math.min(1, side / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };

      try {
        let best = null;
        // Сначала качество, потом размер: замыленная печать читается хуже
        // мелкой, поэтому уменьшаем сторону только когда сжатие не помогло.
        for (const side of [maxSide, Math.round(maxSide * 0.72), Math.round(maxSide * 0.5)]) {
          render(side);
          for (const [type, q] of [
            ['image/webp', 0.95], ['image/webp', 0.85], ['image/webp', 0.7],
            ['image/jpeg', 0.9], ['image/jpeg', 0.75],
          ]) {
            const out = encodeCanvas(canvas, type, q);
            if (!out) continue;                 // формат браузеру незнаком
            best = out;
            if (dataUrlBytes(out) <= maxBytes) { done(out); return; }
          }
        }
        // Ни WebP, ни JPEG — старый браузер. PNG хотя бы попробуем.
        render(Math.round(maxSide * 0.5));
        const png = best || canvas.toDataURL('image/png');
        if (dataUrlBytes(png) <= maxBytes) { done(png); return; }
        fail(new Error('Снимок слишком тяжёлый. Сфотографируйте ближе или обрежьте лишнее.'));
      } catch (e) {
        fail(new Error('Не смог обработать картинку'));
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('Это не картинка')); };
    img.src = url;
  });
}

/**
 * Подставить реквизиты из реестра, как только ИНН или БИК дописан.
 *
 * В боте это происходит само — там ИНН это отдельный шаг. В приложении
 * рядом стояла кнопка «Заполнить по ИНН и БИК», и человек, который её не
 * заметил, набирал название и адрес руками, хотя они есть в реестре.
 *
 * Срабатывает при уходе из поля, а не на каждый набранный символ: иначе
 * на каждую цифру уходил бы запрос в справочник. И только когда поле
 * дописано до правильной длины — 10 или 12 цифр у ИНН, 9 у БИКа.
 *
 * @param {object} f поля формы
 * @param {Function} apply что сделать с ответом
 */
function autoLookup(f, apply) {
  let last = '';
  const run = async (kind) => {
    const inn = String(f.inn.input.value || '').replace(/\D/g, '');
    const bik = String((f.bik && f.bik.input.value) || '').replace(/\D/g, '');
    const okInn = inn.length === 10 || inn.length === 12;
    const okBik = bik.length === 9;
    if (kind === 'inn' && !okInn) return;
    if (kind === 'bik' && !okBik) return;
    const key = `${kind}:${kind === 'inn' ? inn : bik}`;
    if (key === last) return;                 // тот же номер — не дёргаем справочник
    last = key;
    try {
      const r = await api('POST', '/api/lookup',
        kind === 'inn' ? { inn } : { bik });
      apply(r);
      haptic();
    } catch (_) {
      // Молча: человек мог просто ошибиться цифрой, а кнопка рядом никуда
      // не делась. Ругаться на ввод, который он ещё правит, — навязчиво.
    }
  };
  f.inn.input.addEventListener('change', () => run('inn'));
  if (f.bik) f.bik.input.addEventListener('change', () => run('bik'));
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
          // Сервер принимает факсимиле до 1 МБ — оставляем запас на служебные
          // байты запроса, чтобы отказ не приходил из-за пары килобайт.
          const dataUrl = await shrinkImage(chosen, 1400, 900 * 1024);
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
    box.append(empty('wallet', 'Долгов нет',
      'Как только появятся долги по актам или счетам — зависит от вашего дела.'));
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
  if (them.length) {
    // Акты сверки всем сразу: в боте это одна кнопка, а в приложении
    // приходилось заходить в каждого клиента по очереди.
    box.append(h('div', { class: 'btn-wrap' }, h('button', {
      class: 'btn',
      onclick: (e) => withBusy(e.currentTarget, async () => {
        const r = await api('GET', '/api/akt/all');
        haptic('medium');
        toast(`${r.count} ${plural(r.count, 'акт', 'акта', 'актов')} сверки — в чате с ботом`);
      }),
    }, `Акты сверки всем должникам (${them.length})`)));
    box.append(h('div', { class: 'btn-wrap', style: 'padding-top:0' }, h('button', {
      class: 'btn secondary', onclick: () => go('reminders'),
    }, 'Текст напоминания должникам')));
    box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
      text: 'Файлы и тексты бот присылает вам — вашим клиентам он не пишет.' }));
  }
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
  box.append(h('div', { class: 'section-title', text: 'Работа' }));
  box.append(h('div', { class: 'card' },
    navRow({
      icon: 'mail',
      tone: s.mailbox ? 'ok' : '',
      title: 'Почта',
      sub: s.mailbox ? s.mailbox.from : 'ящик не подключён',
      onclick: () => go('mail'),
    }),
    navRow({
      icon: 'clock',
      title: 'Ждут оплаты',
      sub: s.unpaid && s.unpaid.count
        ? `${s.unpaid.count} ${plural(s.unpaid.count, 'счёт', 'счёта', 'счетов')} на ${money0(s.unpaid.sum)}`
        : 'всё оплачено',
      onclick: () => go('unpaid'),
    }),
    navRow({
      icon: 'doc-check',
      title: 'Акт сверки',
      sub: 'таблица операций с клиентом в Excel',
      onclick: () => go('akt'),
    }),
    navRow({
      icon: 'docs2',
      title: 'Реестр документов',
      sub: 'выгрузка за период в Excel',
      onclick: () => go('registry'),
    }),
    navRow({
      icon: 'box',
      title: 'Выписка из банка',
      sub: 'отметить оплаты по выгрузке',
      onclick: () => go('bank'),
    }),
    navRow({
      icon: 'repeat',
      title: 'Каждый месяц',
      sub: s.recurring
        ? `${s.recurring} ${plural(s.recurring, 'документ', 'документа', 'документов')} на повторе`
        : 'счета и акты по расписанию',
      onclick: () => go('recurring'),
    }),
    navRow({
      icon: 'search',
      title: 'Снимок счёта',
      sub: 'сфотографировать и разобрать',
      onclick: () => go('scan'),
    })));

  box.append(h('div', { class: 'section-title', text: 'Настройки учёта' }));
  box.append(h('div', { class: 'card' },
    navRow({
      icon: 'receipt',
      title: 'НДС',
      sub: vatLabel(s.org),
      onclick: () => go('vat'),
    }),
    navRow({
      icon: 'receipt',
      title: 'Самозанятость',
      sub: s.org && Number(s.org.npd)
        ? 'напомню про чек в «Моём налоге»' : 'если платите налог на профдоход',
      onclick: () => go('npd'),
    }),
    navRow({
      icon: 'wallet',
      title: 'Чем занимаетесь',
      sub: (() => {
        const t = (s.bizTypes || []).find((x) => x.key === s.bizType);
        const basis = BASIS_LABEL[s.debtBasis] || '';
        return t ? `${t.name}${basis ? ` · ${basis}` : ''}` : 'чтобы долги считались верно';
      })(),
      onclick: () => go('basis'),
    })));

  box.append(h('div', { class: 'section-title', text: 'Помощник' }));
  box.append(h('div', { class: 'card' },
    navRow({
      icon: 'bot',
      tone: s.aiEnabled !== false ? 'ok' : '',
      title: 'ИИ-ассистент',
      sub: s.aiEnabled !== false
        ? 'понимает фразы, фото счетов и голосовые'
        : 'выключен — только ручной ввод',
      onclick: async () => {
        haptic('medium');
        const next = !(s.aiEnabled !== false);
        try {
          await api('POST', '/api/user/ai', { enabled: next });
          s.aiEnabled = next;
          toast(next ? 'ИИ-ассистент включён' : 'ИИ-ассистент выключен');
          go('more');
        } catch (e) { toast(e.message, true); }
      },
    })));

  box.append(h('div', { class: 'section-title', text: 'Помощь' }));
  box.append(h('div', { class: 'card' },
    navRow({
      icon: 'help',
      title: 'Как пользоваться',
      sub: 'короткая инструкция',
      onclick: () => go('help'),
    }),
    navRow({
      icon: 'send',
      title: 'Написать в поддержку',
      sub: 'ответим в чате с ботом',
      onclick: () => go('support'),
    })));
  return box;
};

/** Человеческое название режима НДС — то же, что в боте. */
function vatLabel(org) {
  if (!org || !org.vat_rate) return 'без НДС';
  return `${org.vat_rate}%${org.vat_rate === '0' ? '' : (org.vat_gross ? ', цены с НДС' : ', сверху')}`;
}

const BASIS_LABEL = {
  closing: 'по акту, УПД или накладной',
  invoice: 'по выставленному счёту',
  manual: 'не считать — журнал веду сам',
};

/* ---------- почта ---------- */

/**
 * Почта клиента: с какого адреса уходят документы.
 *
 * Экрана долго не было вовсе — обработчики на сервере есть с самого начала,
 * а в приложении подключить ящик было нельзя. Половина ежедневной работы
 * бухгалтера это почта, и держать её только в боте неправильно.
 */
screens.mail = async function mail() {
  const s = await api('GET', '/api/state');
  const box = h('div', {}, h('h1', { text: 'Почта' }));
  const mb = s.mailbox;

  if (mb) {
    box.append(h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('span', { class: `icon-box ${mb.checkedAt ? 'ok' : ''}` }, icon(mb.checkedAt ? 'check' : 'clock')),
        h('span', { class: 'grow' },
          h('div', { class: 'ellipsis', text: mb.from }),
          h('div', { class: 'small muted', text: mb.checkedAt ? 'проверена, письма уходят' : 'ещё не проверена' }))),
      h('div', { class: 'row' },
        h('span', { class: 'grow muted', text: 'Сервер' }),
        h('span', { class: 'small', text: `${mb.host}:${mb.port}` }))));

    if (mb.canRead) {
      box.append(h('div', { class: 'btn-wrap' }, h('button', {
        class: 'btn', onclick: () => { haptic('medium'); go('inbox'); },
      }, 'Посмотреть входящие')));
    }

    box.append(h('div', { class: 'btn-wrap' }, h('button', {
      class: 'btn secondary',
      onclick: (e) => withBusy(e.currentTarget, async () => {
        const r = await api('POST', '/api/mailbox/test');
        toast(`Письмо ушло на ${r.sent} — проверьте ящик`);
        render();
      }),
    }, 'Отправить проверочное письмо')));

    box.append(h('div', { class: 'btn-wrap' },
      h('button', { class: 'btn ghost', onclick: () => go('mail.new') }, 'Подключить другой ящик'),
      h('button', {
        class: 'btn danger',
        onclick: (e) => withBusy(e.currentTarget, async () => {
          await api('POST', '/api/mailbox/delete');
          toast('Почта отключена');
          render();
        }),
      }, 'Отключить почту')));
    return box;
  }

  box.append(h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('span', { class: 'icon-box' }, icon('mail')),
      h('span', { class: 'grow' },
        h('div', { text: 'Ящик не подключён' }),
        h('div', { class: 'small muted', text: 'документы придётся пересылать вручную' })))));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Подключите свой ящик — и счета будут уходить клиентам с вашего адреса. '
      + 'С чужого адреса письма попадают в спам, а получатель видит незнакомого отправителя.' }));
  box.append(h('div', { class: 'btn-wrap' },
    h('button', { class: 'btn', onclick: () => go('mail.new') }, 'Подключить ящик')));
  return box;
};

/** Подключение ящика: адрес, пароль и — для своего домена — сервер. */
screens['mail.new'] = async function mailNew() {
  const box = h('div', {}, h('h1', { text: 'Подключить почту' }));

  const email = field('email', 'Адрес почты', '', { type: 'email', placeholder: 'buh@yandex.ru', required: true });
  const pass = field('pass', 'Пароль', '', { type: 'password', required: true,
    hint: 'У Яндекса и Mail.ru нужен пароль приложения, а не обычный от почты' });
  const host = field('host', 'Сервер SMTP', '', { placeholder: 'smtp.вашдомен.ру',
    hint: 'Только для своего домена — у известных сервисов подставлю сам' });
  const imap = field('imapHost', 'Сервер IMAP', '', { placeholder: 'imap.вашдомен.ру',
    hint: 'Нужен, чтобы читать входящие. Можно оставить пустым' });
  const fromName = field('fromName', 'Имя отправителя', '', { placeholder: 'ООО «Ромашка»' });

  // Ссылка на страницу пароля появляется, как только понятен сервис:
  // описание пути по меню устаревает раньше, чем мы выпускаем обновление.
  const linkBox = h('div', { class: 'btn-wrap', style: 'display:none' });
  const link = h('a', { class: 'btn secondary', target: '_blank', rel: 'noopener' }, 'Где взять пароль');
  linkBox.append(link);
  const PASS_URL = {
    yandex: 'https://id.yandex.ru/security/app-passwords',
    mailru: 'https://account.mail.ru/user/2-step-auth/passwords',
    gmail: 'https://myaccount.google.com/apppasswords',
    rambler: 'https://mail.rambler.ru/settings/mailapps',
  };
  const guess = (addr) => {
    const d = String(addr).split('@')[1] || '';
    if (/yandex|ya\.ru|narod/i.test(d)) return 'yandex';
    if (/mail\.ru|inbox\.ru|list\.ru|bk\.ru|internet\.ru/i.test(d)) return 'mailru';
    if (/gmail|googlemail/i.test(d)) return 'gmail';
    if (/rambler|lenta\.ru/i.test(d)) return 'rambler';
    return 'custom';
  };
  email.input.addEventListener('input', () => {
    const p = guess(email.input.value);
    host.style.display = p === 'custom' ? '' : 'none';
    imap.style.display = p === 'custom' ? '' : 'none';
    if (PASS_URL[p]) { link.href = PASS_URL[p]; linkBox.style.display = ''; } else { linkBox.style.display = 'none'; }
  });
  host.style.display = 'none';
  imap.style.display = 'none';

  box.append(h('div', { class: 'card' }, email, pass, host, imap, fromName));
  box.append(linkBox);
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Пароль хранится в зашифрованном виде и нигде не показывается. '
      + 'Сразу после сохранения я отправлю проверочное письмо вам же.' }));

  const save = h('button', { class: 'btn' }, 'Подключить и проверить');
  save.onclick = () => withBusy(save, async () => {
    clearErrors({ email, pass });
    if (!email.input.value.trim()) { showError(email, 'Без адреса не обойтись'); return; }
    if (!pass.input.value) { showError(pass, 'Нужен пароль'); return; }
    let r;
    try {
      r = await api('POST', '/api/mailbox', {
        email: email.input.value.trim(),
        pass: pass.input.value,
        host: host.input.value.trim(),
        imapHost: imap.input.value.trim(),
        fromName: fromName.input.value.trim(),
      });
    } catch (e) {
      // Ящик сохранён, но письмо не ушло — почти всегда это пароль.
      // Показываем ошибку у поля пароля, а не общим красным всплытием:
      // так видно, что исправлять.
      if (e.payload && e.payload.saved) {
        showError(pass, e.message);
        return;
      }
      throw e;
    }
    haptic('medium');
    toast(r.sent ? `Письмо ушло на ${r.sent} — проверьте ящик` : 'Почта подключена');
    reset('mail');
  });
  box.append(h('div', { class: 'btn-wrap' }, save));
  return box;
};

/** Входящие письма с документами. */
screens.inbox = async function inbox() {
  const box = h('div', {}, h('h1', { text: 'Входящие' }));
  let r;
  try {
    r = await api('GET', '/api/inbox');
  } catch (e) {
    box.append(empty('warn', 'Не смог прочитать почту', e.message,
      h('div', { class: 'btn-wrap' }, h('button', { class: 'btn secondary', onclick: () => go('mail') }, 'Настройки почты'))));
    return box;
  }
  if (!r.letters.length) {
    box.append(empty('mail', 'Новых документов нет',
      `Просмотрел ${r.looked} ${plural(r.looked, 'письмо', 'письма', 'писем')} за две недели. `
      + 'Ищу вложения: счета, акты, УПД, накладные — PDF, Word, Excel и сканы.'));
    return box;
  }
  box.append(h('div', { class: 'card' }, r.letters.map((l) => navRow({
    icon: 'mail',
    title: l.files.map((f) => f.kind).filter(Boolean).join(', ') || 'Документ',
    sub: l.fromName || l.from,
    badge: l.cp ? l.cp.name : '',
    onclick: () => go('letter', { uid: l.uid, data: l }),
  }))));
  return box;
};

/** Карточка письма: что внутри и что с этим сделать. */
screens.letter = async function letter({ data }) {
  const l = data || {};
  const box = h('div', {}, h('h1', { text: l.subject || 'Письмо' }));
  box.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'От кого' }),
      h('span', { class: 'ellipsis', text: l.fromName || l.from })),
    h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'Адрес' }),
      h('span', { class: 'small ellipsis', text: l.from }))));

  box.append(h('div', { class: 'section-title', text: 'Вложения' }));
  box.append(h('div', { class: 'card' }, (l.files || []).map((f) => h('div', { class: 'row' },
    h('span', { class: 'icon-box' }, icon('doc')),
    h('span', { class: 'grow' },
      h('div', { class: 'ellipsis', text: f.name }),
      h('div', { class: 'small muted', text: `${f.kind || 'документ'} · ${Math.round(f.size / 1024)} КБ` }))))));

  if (l.cp) {
    // Контрагент здесь угадан по заголовку письма, а он подделывается
    // тривиально — ни SPF, ни DKIM не проверяются. Поддельный счёт от
    // знакомого поставщика — самая частая схема обмана в малом бизнесе, и
    // молчаливо подставленное имя работало на неё. Кнопку не убираем: почти
    // всегда письмо настоящее. Но говорим правду.
    if (l.cp.guessed) {
      box.append(h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('span', { class: 'icon-box warn' }, icon('warn')),
          h('span', { class: 'grow' },
            h('div', { text: 'Отправителя я не проверяю' }),
            h('div', { class: 'small muted',
              text: 'Адрес в письме подделать несложно. Перед оплатой сверьте счёт и '
                + 'реквизиты — особенно если они изменились с прошлого раза.' })))));
    }
    box.append(h('div', { class: 'btn-wrap' }, h('button', {
      class: 'btn', onclick: () => go('op', { cpId: l.cp.id, doc: l.subject }),
    }, `Внести операцию по ${l.cp.name}`)));
  }
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Сам файл лежит у вас в почте — бот его не хранит. Здесь видно, что пришло, '
      + 'и можно сразу занести сумму в журнал.' }));
  return box;
};

/* ---------- НДС и основание долга ---------- */

/** Ставка НДС организации. */
screens.vat = async function vat() {
  const s = await api('GET', '/api/state');
  const org = s.org || {};
  const cur = org.vat_rate === '' || org.vat_rate == null ? null : String(org.vat_rate);
  const gross = Boolean(org.vat_gross);
  const box = h('div', {}, h('h1', { text: 'НДС' }));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Ставка подставляется во все счета. У отдельного счёта её можно поменять.' }));

  /*
   * Самозанятому говорим до кнопок, а не после.
   *
   * Экраны «Самозанятость» и «НДС» независимы, и ставка поверх включённого
   * НПД ставилась беспрепятственно. Счёт-фактура с выделенным налогом от
   * неплательщика обязывает его уплатить этот НДС в бюджет (п. 5 ст. 173 НК),
   * а заказчик вычет всё равно не получит.
   */
  if (Number(org.npd)) {
    box.append(h('p', { class: 'small', style: 'margin:8px 18px; color:var(--warn, #b26a00)',
      text: '⚠️ У вас включена самозанятость. Плательщик НПД не может быть плательщиком '
        + 'НДС — оставьте «Без НДС». Если с НПД снялись, выключите галочку в разделе '
        + '«Самозанятость».' }));
  }

  const pick = async (rate, isGross) => {
    await api('POST', '/api/vat', { rate, gross: isGross });
    haptic('medium');
    toast('Сохранено');
    back();
  };
  const opt = (title, sub, active, onclick) => h('button', { class: 'row', onclick },
    h('span', { class: `icon-box ${active ? 'ok' : ''}` }, icon(active ? 'check' : 'receipt')),
    h('span', { class: 'grow' },
      h('div', { text: title }),
      h('div', { class: 'small muted', text: sub })));

  box.append(h('div', { class: 'card' },
    opt('Без НДС', 'упрощёнка до 20 млн, патент, самозанятость', cur === null, () => pick(null, false)),
    opt('22% сверху', 'общая ставка с 2026, цены без налога', cur === '22' && !gross, () => pick(22, false)),
    opt('22% в том числе', 'общая ставка, цены уже с налогом', cur === '22' && gross, () => pick(22, true)),
    // Ставка привязана к дате отгрузки, а не к дате договора: с 1 января 2026
    // отгрузка идёт по 22% независимо от того, когда договор подписан. Прежняя
    // подсказка «старые договоры» толкала выбрать 20% там, где нужна 22%, —
    // это уже налоговая ошибка, а не описка.
    opt('20% сверху', 'для документов за 2025 год и правок к ним', cur === '20' && !gross, () => pick(20, false)),
    opt('20% в том числе', 'то же, цены с налогом', cur === '20' && gross, () => pick(20, true)),
    opt('10% сверху', 'льготная ставка', cur === '10' && !gross, () => pick(10, false)),
    opt('10% в том числе', 'льготная, цены с налогом', cur === '10' && gross, () => pick(10, true)),
    // У пониженных ставок УСН тоже две формы: расчётные 5/105 и 7/107 — это
    // п. 4 ст. 164 НК. Была одна кнопка «сверху», и продавец с ценами,
    // включающими налог, не мог выписать верный документ из приложения
    // вообще: ставка сюда приходит только из этой настройки.
    opt('5% сверху', 'пониженная для упрощёнки, цены без налога', cur === '5' && !gross, () => pick(5, false)),
    opt('5% в том числе', 'пониженная, цены уже с налогом', cur === '5' && gross, () => pick(5, true)),
    opt('7% сверху', 'пониженная для упрощёнки, цены без налога', cur === '7' && !gross, () => pick(7, false)),
    opt('7% в том числе', 'пониженная, цены уже с налогом', cur === '7' && gross, () => pick(7, true)),
    opt('0%', 'экспорт и особые случаи', cur === '0', () => pick(0, false))));
  return box;
};

/**
 * Самозанятость. Одна галочка, и та не про документы.
 *
 * Спрашиваем прямо, потому что вывести режим неоткуда: по ИНН видно только,
 * ИП это или организация, а НПД применяют и физлица, и предприниматели.
 */
screens.npd = async function npdScreen() {
  const s = await api('GET', '/api/state');
  const on = Boolean(s.org && Number(s.org.npd));
  const box = h('div', {}, h('h1', { text: 'Налог на профессиональный доход' }));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Если вы самозанятый или ИП на НПД, счёт и акт сами по себе доход не закрывают — '
      + 'его закрывает чек из «Моего налога». Включите, и после каждой отметки об оплате '
      + 'я напомню его выдать.' }));

  const pick = async (value) => {
    await api('POST', '/api/npd', { on: value });
    haptic('medium');
    toast('Сохранено');
    back();
  };
  const opt = (value, title, sub) => h('button', { class: 'row', onclick: () => pick(value) },
    h('span', { class: `icon-box ${on === value ? 'ok' : ''}` },
      icon(on === value ? 'check' : 'receipt')),
    h('span', { class: 'grow' },
      h('div', { text: title }),
      h('div', { class: 'small muted', text: sub })));

  box.append(h('div', { class: 'card' },
    opt(true, 'Применяю НПД', 'самозанятый или ИП на НПД'),
    opt(false, 'Не применяю', 'УСН, патент, общая система')));

  box.append(h('p', { class: 'small muted', style: 'margin:12px 18px',
    text: 'Сам чек не выписываю и выписывать не буду: это заявление в налоговую от вашего '
      + 'имени, его делаете вы.' }));
  box.append(h('div', { class: 'btn-wrap' }, h('button', {
    class: 'btn secondary',
    onclick: () => openOutside('https://lknpd.nalog.ru/'),
  }, 'Открыть «Мой налог»')));
  return box;
};

/** Из чего возникает долг контрагента. */
screens.basis = async function basis() {
  const s = await api('GET', '/api/state');
  const box = h('div', {}, h('h1', { text: s.bizType ? 'Откуда берётся долг' : 'Чем занимаетесь' }));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Это про устройство вашего дела, а не про настройку. Выбор один на организацию: '
      + 'иначе долг задвоится — сначала по счёту, потом по акту на ту же сделку.' }));

  const pick = async (value) => {
    await api('POST', '/api/basis', { basis: value });
    haptic('medium');
    toast('Сохранено');
    back();
  };
  const opt = (value, title, sub) => h('button', { class: 'row', onclick: () => pick(value) },
    h('span', { class: `icon-box ${s.debtBasis === value ? 'ok' : ''}` },
      icon(s.debtBasis === value ? 'check' : 'wallet')),
    h('span', { class: 'grow' },
      h('div', { text: title }),
      h('div', { class: 'small muted', text: sub })));

  box.append(h('div', { class: 'card' },
    opt('closing', 'По акту, УПД или накладной', 'подряд, услуги, торговля: счёт лишь просьба заплатить'),
    opt('invoice', 'По выставленному счёту', 'аренда и субаренда: акта по закону может не быть'),
    opt('manual', 'Не считать', 'журнал веду сам')));

  // Выход для того, кто не знает ответа. Это единственная настройка, где
  // человек может застрять: вопрос бухгалтерский, а пришёл он выставить счёт.
  box.append(h('div', { class: 'section-title', text: 'Не знаете, что выбрать?' }));
  box.append(h('div', { class: 'card' }, (s.bizTypes || []).map((t) => h('button', {
    class: 'row',
    onclick: (e) => withBusy(e.currentTarget, async () => {
      const r = await api('POST', '/api/biztype', { key: t.key });
      haptic('medium');
      toast(r.why || 'Сохранено');
      back();
    }),
  },
  h('span', { class: `icon-box ${s.bizType === t.key ? 'ok' : ''}` },
    icon(s.bizType === t.key ? 'check' : 'office')),
  h('span', { class: 'grow' },
    h('div', { text: t.name }),
    h('div', { class: 'small muted', text: t.hint }))))));
  return box;
};

/**
 * Регулярные документы.
 *
 * Только список и выключение: заводятся они на карточке уже выписанного
 * документа, где позиции проверены человеком. Ничего не выписывается само —
 * бот приносит предложение с кнопкой.
 */
screens.recurring = async function recurringScreen() {
  const { items } = await api('GET', '/api/recurring');
  const box = h('div', {}, h('h1', { text: 'Каждый месяц' }));
  if (!items.length) {
    box.append(empty('repeat', 'Пока ничего не повторяется',
      'Откройте выписанный счёт или акт и нажмите «Повторять каждый месяц» — '
      + 'в нужный день бот напомнит и предложит выписать такой же.'));
    return box;
  }
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: items.some((r) => r.isOp)
      ? 'Документы сами не выписываются и клиенту бот не пишет: в нужный день придёт '
        + 'предложение с кнопкой. Операции журнала бот вносит сам — они внутренние, '
        + 'никуда не уходят, — но каждый раз сообщает и даёт отменить.'
      : 'Ничего не выписывается само и клиенту бот не пишет: в нужный день '
        + 'придёт предложение с кнопкой.' }));

  for (const r of items) {
    const card = h('div', { class: 'card' });
    // Заголовок строки — имя клиента: по нему её и узнают. Название документа
    // уходит вниз, иначе оно съедает ширину и обрывает как раз имя.
    card.append(h('div', { class: 'row' },
      h('span', { class: 'icon-box' }, icon('repeat')),
      h('span', { class: 'grow' },
        h('div', { class: 'ellipsis', text: r.cpName }),
        h('div', { class: 'small muted ellipsis', text: r.title })),
      // Без копеек: сумма здесь для узнавания, а не для сверки.
      h('span', { class: 'money nowrap', text: money0(r.total) }),
      h('button', {
        class: 'row-act',
        'aria-label': `Перестать напоминать: ${r.title} для ${r.cpName}`,
        onclick: (e) => withBusy(e.currentTarget, async () => {
          await api('POST', '/api/recurring/off', { id: r.id });
          haptic('medium');
          toast('Больше напоминать не буду');
          render();
        }),
      }, icon('trash'))));

    /*
     * Календарь цикла целиком, а не одна дата. Человек настраивает аренду
     * одним числом из договора, но следит бот за тремя событиями — и если
     * не показать все, напоминание о просрочке придёт неожиданно и будет
     * выглядеть ошибкой.
     */
    /*
     * У операции журнала цикл другой и говорить о нём надо иначе: её бот
     * вносит сам. Умолчать об этом нельзя — человек должен понимать, откуда
     * в журнале возьмётся строка, которую он не заводил.
     */
    const steps = r.isOp
      ? [[r.dayText, 'внесу в журнал сам'],
        ...(r.op && r.op.times
          ? [['осталось', `${r.op.left} из ${r.op.times} — потом выключится`]] : []),
        ...(r.op && r.op.mailSelf ? [['после', 'пришлю вам акт сверки на почту']] : [])]
      : r.payDay
        ? [[`${r.offerDay}-го`, 'выставить счёт'],
          [`${r.payDay}-го`, 'срок оплаты по договору'],
          [`${r.payDay + 1}-го`, 'напомню, если денег нет']]
        : [[r.dayText, 'выписать документ']];
    card.append(h('div', { class: 'plan' }, steps.map(([when, what]) => h('div', { class: 'plan-row' },
      h('span', { class: 'plan-when', text: when }),
      h('span', { class: 'plan-what', text: what })))));
    box.append(card);
  }
  return box;
};

/* ---------- операции и неоплаченные ---------- */

/** Внести приход или оплату в журнал контрагента. */
screens.op = async function op({ cpId, doc }) {
  const { cps } = await api('GET', '/api/cps');
  const cp = cps.find((c) => c.id === Number(cpId));
  if (!cp) return empty('warn', 'Клиент не найден');

  const box = h('div', {}, h('h1', { text: 'Операция' }));
  let kind = 'payment';
  const amount = field('amount', 'Сумма, ₽', '', { inputmode: 'decimal', required: true });
  const date = field('date', 'Дата', todayISO(), { type: 'date' });
  const docF = field('doc', 'Основание', doc || '', { placeholder: 'Счёт № 12 или Оплата' });

  const btn = (val, text) => {
    const b = h('button', { class: `btn ${kind === val ? '' : 'secondary'}`, style: 'flex:1' }, text);
    b.onclick = () => {
      kind = val;
      for (const x of picker.children) x.className = 'btn secondary';
      b.className = 'btn';
      haptic();
    };
    return b;
  };
  const picker = h('div', { class: 'btn-wrap', style: 'display:flex;gap:10px' });
  picker.append(btn('payment', 'Оплата'), btn('income', 'Приход'));

  box.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'Клиент' }),
      h('span', { class: 'ellipsis', text: cp.name }))));
  box.append(picker);
  box.append(h('div', { class: 'card' }, amount, date, docF));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Оплата уменьшает долг клиента, приход — увеличивает.' }));

  const save = h('button', { class: 'btn' }, 'Внести в журнал');
  save.onclick = () => withBusy(save, async () => {
    clearErrors({ amount });
    const sum = Number(String(amount.input.value).replace(/\s/g, '').replace(',', '.'));
    if (!sum) { showError(amount, 'Укажите сумму'); return; }
    await api('POST', '/api/op', {
      cpId: cp.id, amount: sum, kind, date: date.input.value, doc: docF.input.value.trim(),
    });
    haptic('medium');
    toast('Записано в журнал');
    reset('cp', { id: cp.id });
  });
  box.append(h('div', { class: 'btn-wrap' }, save));
  return box;
};

/*
 * Журнал операций контрагента.
 *
 * До сих пор внесённое руками можно было только добавить: увидеть строки и
 * убрать лишнюю было негде — в боте отменялась лишь последняя. А именно эти
 * строки чаще всего и держат сумму на главной, из-за которой «удаляю
 * документы, а цифра стоит». Поэтому здесь они видны все и смахиваются.
 */
screens.ops = async function opsScreen({ cpId }) {
  const j = await api('GET', `/api/ops?cp=${cpId}`);
  const box = h('div', {}, h('h1', { text: 'Журнал операций' }));
  box.append(h('div', { class: 'hero' },
    h('div', { class: 'greet', text: j.cp.name }),
    h('div', { class: 'sum money', text: money0(Math.abs(j.closing)) }),
    h('div', { class: 'sub', text: j.closing ? 'текущее сальдо' : 'расчёты сошлись' })));

  const add = h('button', { class: 'btn' }, 'Внести оплату или приход');
  add.onclick = () => { haptic('medium'); go('op', { cpId }); };
  box.append(h('div', { class: 'btn-wrap' }, add));

  if (j.opening) {
    box.append(h('div', { class: 'card' }, navRow({
      icon: 'clock',
      title: 'Начальное сальдо',
      sub: j.openingDate ? `на ${ru(j.openingDate)}` : 'до начала расчётов',
      right: money(j.opening),
      // Строка не из журнала: правится в карточке, а не смахиванием.
      onclick: () => go('cp', { id: cpId }),
    })));
  }

  if (!j.ops.length) {
    box.append(empty('list', 'Операций нет',
      j.opening
        ? 'Сальдо держит начальное значение из карточки клиента.'
        : 'Здесь появятся оплаты и приходы — внесённые руками и из выписки.'));
    return box;
  }

  const rows = j.ops.map((o) => {
    const row = navRow({
      icon: o.delta > 0 ? 'plus' : 'minus',
      title: o.kind || (o.delta > 0 ? 'Приход' : 'Оплата'),
      sub: [ru(o.date), o.doc, o.fromDoc ? 'из документа' : ''].filter(Boolean).join(' · '),
      right: money(Math.abs(o.delta)),
      rightTone: o.delta > 0 ? 'in' : 'out',
      onclick: () => {},
    });
    // Строки, пришедшие из документа, отсюда не трогаем: их снимает сам
    // документ, а убрать проводку в обход него — значит развести журнал с
    // тем, что напечатано на бумаге.
    if (o.fromDoc) return row;
    return swipeToDelete(row, {
      label: 'Убрать операцию',
      onDelete: async () => {
        const r = await api('POST', '/api/op/delete', { id: o.id, cpId });
        haptic('medium');
        toast(`Убрано. Сальдо: ${money(Math.abs(r.balance))}`);
        render();                        // перерисовать, не теряя дорогу назад
      },
    });
  });
  box.append(h('div', { class: 'card' }, rows));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Смахните строку влево, чтобы убрать. Строки из документов убираются вместе с документом.' }));
  return box;
};

/*
 * Запись голоса в браузере.
 *
 * MediaRecorder не годится: он отдаёт WebM (в Safari — MP4), а распознавание
 * ни того, ни другого не принимает, и перекодировать нечем — ffmpeg на
 * сервере нет. Поэтому пишем звук сами через Web Audio и собираем WAV: его
 * принимают все, а заголовок у WAV — сорок четыре байта.
 *
 * Сразу к 16 кГц моно: речи этого хватает с запасом, а байтов выходит втрое
 * меньше — тридцать секунд укладываются в мегабайт и уходят «быстрым»
 * методом распознавания, который отвечает сразу.
 */
const REC_RATE = 16000;
const REC_MAX_SEC = 30;

async function recordWav(onTick) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let total = 0;
  const step = Math.max(1, Math.round(ctx.sampleRate / REC_RATE));

  node.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const out = new Int16Array(Math.floor(input.length / step));
    for (let i = 0; i < out.length; i += 1) {
      // Усредняем группу отсчётов, а не берём каждый третий: прореживание
      // без усреднения даёт скрежет на шипящих, и слова теряются.
      let sum = 0;
      for (let k = 0; k < step; k += 1) sum += input[i * step + k] || 0;
      const v = Math.max(-1, Math.min(1, sum / step));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    chunks.push(out);
    total += out.length;
    if (onTick) onTick(total / REC_RATE);
  };
  src.connect(node);
  node.connect(ctx.destination);

  const stop = async () => {
    node.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});

    const pcm = new Int16Array(total);
    let at = 0;
    for (const c of chunks) { pcm.set(c, at); at += c.length; }

    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buf);
    const put = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
    put(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); put(8, 'WAVE');
    put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, REC_RATE, true);
    view.setUint32(28, REC_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    put(36, 'data'); view.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);

    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { audio: btoa(bin), seconds: Math.round(total / REC_RATE) };
  };

  return { stop };
}

/*
 * Переписка с агентом.
 *
 * Рамки объявлены первой же строкой, до того как человек начал печатать:
 * бот работает с документами и расчётами и не ведёт налоги. Узнать это
 * после третьего вопроса про взносы — обидно; узнать сразу — честно.
 *
 * Агент ничего не выписывает сам. Он понимает фразу и открывает нужный
 * экран с заполненными полями — кнопку жмёт человек. Документ забирает
 * номер в сквозном ряду, и лишний счёт нельзя тихо удалить.
 */
const ASK_GO = {
  debts: ['Открыть долги', 'debts'],
  unpaid: ['Кто не заплатил', 'unpaid'],
  docs: ['Открыть документы', 'docs'],
  cps: ['Открыть контрагентов', 'cps'],
  org: ['Открыть реквизиты', 'org'],
  recurring: ['Открыть повторения', 'recurring'],
  billing: ['Открыть подписку', 'billing'],
  akt: ['Собрать акт сверки', 'akt'],
};

screens.ask = async function ask() {
  const box = h('div', {}, h('h1', { text: 'Спросить' }));
  const log = h('div', { class: 'chat' });

  /* Вносит проводку и показывает, что получилось, с отменой в одно нажатие. */
  const doPay = async (cpId, cpName, amount, kind) => {
    try {
      const res = await api('POST', '/api/pay', { cpId, amount, kind });
      haptic('heavy');
      const undo = h('button', { class: 'btn secondary' }, 'Отменить проводку');
      undo.onclick = async () => {
        await api('POST', '/api/op/delete', { id: res.id, cpId });
        haptic('medium');
        say('bot', 'Проводка убрана.');
      };
      const left = Number(res.balance) || 0;
      say('bot', `Внёс: ${res.kind} ${money(res.sum)} по «${res.cpName}». `
        + (left > 0 ? `Остаток долга ${money(left)}.`
          : left < 0 ? `Переплата ${money(Math.abs(left))}.` : 'Расчёты закрыты.'), undo);
    } catch (e) { say('bot', e.message); }
  };

  const say = (who, text, action) => {
    const bubble = h('div', { class: `bubble ${who}` }, h('div', { text }));
    if (action) bubble.append(h('div', { class: 'btn-wrap' }, action));
    log.append(bubble);
    /*
     * Прокручиваем страницу до конца, а не scrollIntoView по пузырю.
     * Для браузера пузырь «виден», если попал в окно, — а его закрывает
     * строка ввода, которая приклеена поверх. Отступ снизу у ленты как раз
     * на её высоту, поэтому конец страницы — это и есть нужное место.
     */
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    });
  };

  say('bot', 'Я помогаю с документами и расчётами: счета, акты, УПД, накладные, '
    + 'договоры и платёжки, кто сколько должен, акт сверки.\n\n'
    + 'Налоги, взносы, КУДиР, отчётность и зарплату не веду — у меня нет доступа '
    + 'к вашему банку и кассе, а ошибиться в этом дорого.\n\n'
    + 'Скажите или напишите, что нужно. Например: «выставь счёт Заре на 30 тысяч за аренду».');

  const field = h('input', { class: 'ask-input', type: 'text', placeholder: 'Что нужно сделать?',
    enterkeyhint: 'send', autocomplete: 'off' });

  // Асинхронный: оплату ассистент вносит сам, а это обращение к серверу.
  const answer = async (r) => {
    if (r.heard) say('me', r.heard);
    if (r.error) { say('bot', r.error); return; }

    if (r.action === 'draft') {
      const open = (extra) => () => {
        haptic('medium');
        go('new', {
          type: r.docType,
          items: r.items || [],
          vatRate: r.vatRate,
          priceIncludesVat: r.priceIncludesVat,
          ...extra,
        });
      };

      // Несколько похожих — спрашиваем, кого именно, а не берём наугад.
      if (r.cpChoices && r.cpChoices.length) {
        const box2 = h('div', { class: 'btn-wrap' },
          r.cpChoices.map((c) => h('button', { class: 'btn secondary', onclick: open({ cpId: c.id }) }, c.name)));
        say('bot', `Кого именно вы имели в виду — «${r.who}»? `
          + (r.auto ? 'Выберите — и выпишу.'
            : 'Выберите — покажу документ на проверку, сам я ничего не выписываю.'), box2);
        return;
      }
      // Названного клиента нет: заводить молча нельзя, но и промолчать плохо.
      if (r.cpMissing) {
        const add = h('button', { class: 'btn' }, `Завести «${r.who}»`);
        add.onclick = () => { haptic('medium'); go('cp', { name: r.who }); };
        // Обещание «сам я ничего не выписываю» повторяем и здесь: оно должно
        // звучать на каждой ветке, а не только когда всё сошлось.
        say('bot', `Клиента «${r.who}» у вас пока нет. Могу завести — имя подставлю, `
          + 'останется ИНН и реквизиты.'
          + (r.auto ? '' : ' А сам я ничего не выписываю — документ выпустите вы кнопкой.'), add);
        return;
      }
      /*
       * Включённый ассистент доводит до файла сам, выключенный — открывает
       * форму с кнопкой. В этом и весь смысл тумблера; текст поэтому зависит
       * от режима, а не прибит гвоздями.
       */
      if (r.auto && r.cpId && (r.items || []).length) {
        try {
          const payload = {
            type: r.docType, cpId: r.cpId, date: todayISO(),
            items: r.items,
          };
          if (r.vatRate !== undefined) {
            payload.vatRate = r.vatRate;
            payload.priceIncludesVat = Boolean(r.priceIncludesVat);
          }
          const made = await api('POST', '/api/doc', payload);
          haptic('heavy');
          const openDoc = h('button', { class: 'btn secondary' }, 'Открыть документ');
          openDoc.onclick = () => { haptic(); download(made.file); };
          say('bot', `Выписал: ${made.doc.title} № ${made.doc.number} для «${r.cpName}» `
            + `на ${money(made.total)}. Файл в чате с ботом; отсюда — кнопкой ниже. `
            + 'Ненужное удаляется из журнала смахиванием.', openDoc);
          download(made.file);
        } catch (e) { say('bot', e.message); }
        return;
      }
      const btn = h('button', { class: 'btn' }, 'Заполнить документ');
      btn.onclick = open(r.cpId ? { cpId: r.cpId } : {});
      say('bot', r.cpName
        ? `Готовлю документ для «${r.cpName}». Проверьте поля и нажмите выпуск`
          + (r.auto ? '.' : ' — сам я ничего не выписываю.')
        : 'Готовлю документ. Клиента выберете на следующем экране.', btn);
      return;
    }
    /*
     * Оплата — ассистент вносит её сам, а не отправляет в карточку клиента.
     * Ровно то, ради чего его и включают.
     */
    if (r.action === 'pay') {
      if (r.cpChoices && r.cpChoices.length) {
        const pick = h('div', { class: 'btn-wrap' }, r.cpChoices.map((c) => h('button', {
          class: 'btn secondary',
          onclick: () => doPay(c.id, c.name, r.amount, r.kind),
        }, c.name)));
        say('bot', `По кому вносим — «${r.who}»?`, pick);
        return;
      }
      if (r.cpMissing || !r.cpId) {
        say('bot', r.who
          ? `Клиента «${r.who}» у вас нет — по кому вносить оплату, непонятно.`
          : 'По кому вносим? Назовите клиента, например «проведи оплату по Заре 50000».');
        return;
      }
      if (!r.amount) {
        const owed = Number(r.balance) || 0;
        if (owed <= 0) {
          say('bot', `За «${r.cpName}» долга сейчас нет. Назовите сумму — «оплата 50000».`);
          return;
        }
        const yes = h('button', { class: 'btn' }, `Внести ${money(owed)}`);
        yes.onclick = () => doPay(r.cpId, r.cpName, owed, r.kind);
        say('bot', `За «${r.cpName}» числится ${money(owed)}. Внести эту сумму?`, yes);
        return;
      }
      if (!r.auto) {
        const go2 = h('button', { class: 'btn' }, `Внести ${money(r.amount)}`);
        go2.onclick = () => doPay(r.cpId, r.cpName, r.amount, r.kind);
        say('bot', `Подготовил: ${r.kind} ${money(r.amount)} по «${r.cpName}». `
          + 'Сам я ничего не провожу — нажмите, и внесу.', go2);
        return;
      }
      await doPay(r.cpId, r.cpName, r.amount, r.kind);
      return;
    }
    if (r.action === 'outofscope') {
      say('bot', 'Это не моя работа: налоги, взносы, отчётность и зарплату я не веду — '
        + 'нет доступа к банку и кассе, а подскажу неверно — платить штраф вам.\n\n'
        + 'Спросите про документы, долги или сверку.');
      return;
    }
    const known = ASK_GO[r.action];
    if (known) {
      const btn = h('button', { class: 'btn' }, known[0]);
      btn.onclick = () => { haptic('medium'); go(known[1]); };
      say('bot', 'Понял.', btn);
      return;
    }
    if (r.source === 'limit') {
      say('bot', 'Разбор фраз на этот месяц исчерпан. Кнопки и команды работают как обычно.');
      return;
    }
    if (r.source === 'off') {
      say('bot', 'Свободный ввод сейчас выключен — пользуйтесь кнопками, они умеют всё то же самое.');
      return;
    }
    // Отказ разбора — не то же самое, что «не понял». Раньше этой ветки не
    // было, и человек с истёкшим ключом весь месяц правил формулировки,
    // считая, что бот его не понимает.
    if (r.source === 'error') {
      say('bot', 'Разбор фраз сейчас не отвечает — это у меня, а не у вас. '
        + 'Кнопки работают как обычно.');
      return;
    }
    say('bot', 'Не понял. Скажите иначе — например: «кто мне должен» или «выставь счёт Заре на 30 тысяч».');
  };

  const send = async () => {
    const text = field.value.trim();
    if (!text) return;
    field.value = '';
    try { await answer(await api('POST', '/api/ask', { text })); } catch (e) { say('bot', e.message); }
  };
  field.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };

  const mic = h('button', { class: 'mic', 'aria-label': 'Записать голосом' }, icon('mic'));
  let rec = null;
  mic.onclick = async () => {
    if (rec) {
      const r = rec; rec = null;
      mic.classList.remove('on');
      mic.replaceChildren(icon('mic'));
      const { audio, seconds } = await r.stop();
      if (!seconds) { say('bot', 'Запись пустая — кажется, микрофон не слышит.'); return; }
      say('bot', '🎧 Слушаю…');
      try { await answer(await api('POST', '/api/ask/voice', { audio, seconds })); } catch (e) { say('bot', e.message); }
      return;
    }
    try {
      haptic('medium');
      mic.classList.add('on');
      rec = await recordWav((sec) => {
        mic.replaceChildren(h('span', { class: 'rec-sec', text: String(Math.floor(sec)) }));
        // Больше тридцати секунд «быстрый» метод не берёт, и ждать
        // распознавания пришлось бы вдвое дольше самой записи.
        if (sec >= REC_MAX_SEC) mic.click();
      });
    } catch (_) {
      rec = null;
      mic.classList.remove('on');
      mic.replaceChildren(icon('mic'));
      say('bot', 'Не дали доступ к микрофону. Напишите текстом — пойму так же.');
    }
  };

  const sendBtn = h('button', { class: 'mic send', 'aria-label': 'Отправить' }, icon('send'));
  sendBtn.onclick = send;

  box.append(log, h('div', { class: 'ask-bar' }, field, mic, sendBtn));
  return box;
};

/** Счета, по которым не отметили оплату. */
screens.unpaid = async function unpaid() {
  const { docs: list, count, sum } = await api('GET', '/api/unpaid');
  const box = h('div', {}, h('h1', { text: 'Ждут оплаты' }));
  if (!list.length) {
    box.append(empty('check', 'Всё оплачено', 'Здесь появятся счета, по которым не отмечена оплата.'));
    return box;
  }
  /*
   * Сумму и счётчик берём с сервера, а не складываем список.
   * На одну сделку выписывают счёт и закрывающий его акт — складывая
   * оба, экран показывал вдвое больше плитки, с которой на него пришли.
   */
  box.append(h('div', { class: 'hero' },
    h('div', { class: 'sum money', text: money0(sum) }),
    // Счётчик считает сделки, а строк ниже больше: подпись обязана это
    // сказать, иначе «2 документа» над тремя строками выглядит ошибкой.
    h('div', {
      class: 'sub',
      text: `${count} ${plural(count, 'сделка', 'сделки', 'сделок')} `
        + `${plural(count, 'ждёт', 'ждут', 'ждут')} оплаты`
        + (list.length > count
          ? ` · ${list.length} ${plural(list.length, 'документ', 'документа', 'документов')}` : ''),
    })));
  box.append(h('div', { class: 'card' }, list.map((d) => navRow({
    icon: 'clock',
    title: `${d.title} № ${d.number}`,
    // Второй документ сделки показываем, но помечаем: иначе непонятно,
    // почему пять строк складываются в сумму четырёх.
    sub: d.pair ? `${ru(d.date)} · та же сделка` : ru(d.date),
    right: money0(d.total),
    rightTone: d.pair ? 'muted' : '',
    onclick: () => go('doc', { id: d.id }),
  }))));
  return box;
};

/** Реестр всех документов за период — файлом в Excel. */
/**
 * Как пользоваться.
 *
 * Раньше этот пункт просто закрывал приложение и высаживал человека в чат
 * искать сообщение бота. Инструкция должна быть там, где возник вопрос.
 */
screens.help = async function help() {
  const s = cache.quota ? cache : await api('GET', '/api/state');
  const box = h('div', {}, h('h1', { text: 'Как пользоваться' }));

  const step = (n, title, text) => h('div', { class: 'row' },
    h('span', { class: 'icon-box' }, h('span', { class: 'num', style: 'font-weight:700', text: String(n) })),
    h('span', { class: 'grow' },
      h('div', { text: title }),
      h('div', { class: 'small muted', text })));

  box.append(h('div', { class: 'section-title', text: 'С чего начать' }));
  box.append(h('div', { class: 'card' },
    step(1, 'Заполните свою организацию', 'Введите ИНН — название и адрес подставятся сами. '
      + 'Банк и счёт нужны, чтобы в счёте появился QR: клиент платит камерой.'),
    step(2, 'Добавьте клиента', 'Тоже по ИНН. Реквизиты и почта запомнятся.'),
    step(3, 'Нажмите «Выписать счёт»',
      'Позиции запоминаются. Акт, УПД, накладная, договор и платёжка — плитками ниже. Сверка — в «Ещё».')));

  box.append(h('div', { class: 'section-title', text: 'Полезно знать' }));
  box.append(h('div', { class: 'card' },
    navRow({ icon: 'wallet', title: 'Долг считается сам', sub: 'по акту или по счёту — зависит от вашего дела', onclick: () => go('basis') }),
    navRow({ icon: 'box', title: 'Оплаты — из выписки банка', sub: 'не отмечать каждую руками', onclick: () => go('bank') }),
    navRow({ icon: 'repeat', title: 'Одинаковые документы — по расписанию', sub: 'бот напомнит, выпишете кнопкой', onclick: () => go('recurring') }),
    navRow({ icon: 'pen', title: 'Подпись и печать', sub: 'ложатся на документ снимком', onclick: () => go('org') })));

  box.append(h('div', { class: 'section-title', text: 'Порядок в документах' }));
  box.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('span', { class: 'grow' },
      h('div', { text: 'Номера бот ведёт сам' }),
      h('div', { class: 'small muted', text: 'сквозным рядом по годам, отдельно на каждый тип. '
        + 'Перед выпуском номер и дату можно поправить.' }))),
    h('div', { class: 'row' }, h('span', { class: 'grow' },
      h('div', { text: 'Файл пересобирается по данным' }),
      h('div', { class: 'small muted', text: 'поэтому документ можно выслать заново или повторить '
        + 'новым номером даже спустя месяцы.' }))),
    h('div', { class: 'row' }, h('span', { class: 'grow' },
      h('div', { text: 'Вашим клиентам бот не пишет' }),
      h('div', { class: 'small muted', text: 'напоминания и акты приходят вам — отправляете вы сами.' })))));

  box.append(h('div', { class: 'section-title', text: 'Сколько осталось' }));
  box.append(h('div', { class: 'card' }, h('div', { class: 'row' },
    h('span', { class: `icon-box ${s.quota.paid ? 'ok' : ''}` }, icon(s.quota.paid ? 'check' : 'clock')),
    h('span', { class: 'grow' },
      h('div', { text: s.quota.paid ? 'Подписка активна' : `${s.quota.left} из ${s.quota.limit} бесплатных` }),
      h('div', { class: 'small muted', text: s.quota.paid ? `до ${ru(s.access.until)}` : 'в этом месяце' })))));

  box.append(h('div', { class: 'btn-wrap' }, h('button', {
    class: 'btn secondary', onclick: () => go('support'),
  }, 'Остались вопросы — напишите нам')));
  return box;
};

/**
 * Акт сверки: выбор клиента.
 *
 * Раньше акт жил только внутри карточки клиента, и найти его снаружи было
 * нельзя — приходилось знать, что он там. Документ, которым закрывают
 * квартал, не должен требовать знания, где он спрятан.
 */
screens.akt = async function aktScreen() {
  const { cps: list } = await api('GET', '/api/cps');
  const box = h('div', {}, h('h1', { text: 'Акт сверки' }));
  if (!list.length) {
    box.append(empty('users', 'Клиентов пока нет', 'Сверять не с кем — сначала добавьте клиента.',
      h('div', { class: 'btn-wrap' }, h('button', { class: 'btn', onclick: () => go('cp', {}) }, 'Добавить клиента'))));
    return box;
  }

  /*
   * Период выбирается здесь. Раньше конец периода запоминался в карточке
   * при первом акте и больше не менялся: второй акт печатал в шапке старую
   * дату, а в таблицу складывал всё по сегодняшний день.
   */
  const now = new Date();
  const iso = isoDate;
  const from = field('from', 'С какой даты', '', { type: 'date' });
  const to = field('to', 'По какую', iso(now), { type: 'date' });

  const setRange = (a, b) => {
    from.input.value = a;
    to.input.value = b;
    haptic();
  };
  // Набор периодов тот же, что кнопками в боте (lib/period.js), чтобы
  // «прошлый месяц» значил одно и то же и там, и здесь.
  const qm = Math.floor(now.getMonth() / 3) * 3;
  const quarterStart = new Date(now.getFullYear(), qm, 1);
  const chips = h('div', { class: 'chips' },
    h('button', { class: 'chip', onclick: () => setRange(iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)) }, 'Этот месяц'),
    h('button', { class: 'chip', onclick: () => setRange(iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))) }, 'Прошлый месяц'),
    h('button', { class: 'chip', onclick: () => setRange(iso(quarterStart), iso(now)) }, 'Квартал'),
    h('button', { class: 'chip', onclick: () => setRange(iso(new Date(now.getFullYear(), qm - 3, 1)), iso(new Date(now.getFullYear(), qm, 0))) }, 'Прошлый квартал'),
    h('button', { class: 'chip', onclick: () => setRange(`${now.getFullYear()}-01-01`, iso(now)) }, 'Год'),
    h('button', { class: 'chip', onclick: () => setRange('', iso(now)) }, 'За всё время'));

  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Excel с журналом операций и сальдо придёт в чат с ботом. Пустая дата начала — '
      + 'от начала расчётов, с начальным сальдо из карточки клиента.' }));
  box.append(h('div', { class: 'section-title', text: 'Период' }));
  box.append(h('div', { class: 'card' }, from, to), chips);

  box.append(h('div', { class: 'section-title', text: 'С кем сверяемся' }));
  const sorted = [...list].sort((a, b) => Math.abs(b.balance || 0) - Math.abs(a.balance || 0));
  box.append(h('div', { class: 'card' }, sorted.map((c) => navRow({
    icon: 'users',
    title: c.name,
    sub: c.balance ? (owesUs(c) ? 'должен нам' : 'должны мы') : 'расчёты закрыты',
    right: c.balance ? money0(Math.abs(c.balance)) : '',
    rightTone: balanceTone(c),
    onclick: async () => {
      try {
        const q = new URLSearchParams({ cp: String(c.id) });
        if (from.input.value) q.set('from', from.input.value);
        if (to.input.value) q.set('to', to.input.value);
        const r = await api('GET', `/api/akt?${q}`);
        haptic('medium');
        toast(`Сальдо на конец: ${money0(Math.abs(r.closing))} · операций ${r.ops}`);
        download(r.file);
      } catch (e) { toast(e.message, true); }
    },
  }))));
  return box;
};

screens.registry = async function registry() {
  const now = new Date();
  const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const box = h('div', {}, h('h1', { text: 'Реестр документов' }));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Таблица всех выписанных документов за период — с суммами, контрагентами и итогом. '
      + 'Открывается в Excel, годится для сдачи бухгалтеру.' }));
  const from = field('from', 'С какого числа', first, { type: 'date' });
  const to = field('to', 'По какое', todayISO(), { type: 'date' });
  box.append(h('div', { class: 'card' }, from, to));

  const make = h('button', { class: 'btn' }, 'Собрать реестр');
  make.onclick = () => withBusy(make, async () => {
    const r = await api('GET', `/api/registry?from=${from.input.value}&to=${to.input.value}`);
    if (!r.count) { toast('За этот период документов нет', true); return; }
    haptic('medium');
    toast(`${r.count} ${plural(r.count, 'документ', 'документа', 'документов')} на ${money0(r.total)}`);
    download(r.file);
  });
  box.append(h('div', { class: 'btn-wrap' }, make));
  return box;
};

/* ---------- платёжка и договор ---------- */

/**
 * Документы, которые набираются не позициями, а парой полей.
 *
 * Платёжку выписывают поставщику, чтобы отдать в банк; договор — чтобы
 * закрепить условия. В боте это было с самого начала, в приложении не было
 * вовсе, и половина типов документов оставалась недоступна.
 */
screens.other = async function other({ type, cpId }) {
  const isPp = type === 'pp';
  const { cps } = await api('GET', '/api/cps');
  if (!cps.length) {
    return empty('users', 'Сначала добавьте клиента',
      'Документ выписывается на кого-то — без второй стороны его не собрать.',
      h('div', { class: 'btn-wrap' }, h('button', { class: 'btn', onclick: () => go('cp', {}) }, 'Добавить клиента')));
  }

  const box = h('div', {}, h('h1', { text: isPp ? 'Платёжное поручение' : 'Договор' }));
  const who = h('select', { id: 'f-cp' }, cps.map((c) => h('option', {
    value: c.id, selected: Number(cpId) === c.id,
  }, c.name)));
  const date = field('date', 'Дата', todayISO(), { type: 'date' });
  const num = field('number', 'Номер', '', { placeholder: 'подставлю сам' });

  const fields = isPp
    ? {
      amount: field('amount', 'Сумма, ₽', '', { inputmode: 'decimal', required: true }),
      purpose: field('purpose', 'Назначение платежа', '', {
        multiline: true, required: true,
        placeholder: 'Оплата по счёту № 12 от 01.08.2026, в том числе НДС 22%',
      }),
    }
    : {
      subject: field('subject', 'Предмет договора', '', {
        multiline: true, required: true,
        placeholder: 'услуги по организации фуршетного обслуживания',
      }),
      amount: field('amount', 'Сумма договора, ₽', '', {
        inputmode: 'decimal', hint: 'Ноль — если платим по счетам',
      }),
      term: field('term', 'Действует до', '', { placeholder: '31.12.2026' }),
    };

  box.append(h('div', { class: 'card' },
    h('div', { class: 'field' },
      h('label', { for: 'f-cp', text: isPp ? 'Получатель платежа' : 'Вторая сторона' }), who),
    date, num));
  box.append(h('div', { class: 'card' }, Object.values(fields)));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: isPp
      ? 'Форма 0401060 — та, что принимает банк. Ваши реквизиты и реквизиты получателя подставятся сами.'
      : 'Простой договор на услуги: реквизиты обеих сторон, предмет, сумма и срок. Подпись и печать не ставятся — договор подписывают живой рукой.' }));

  const make = h('button', { class: 'btn' }, 'Выписать');
  make.onclick = () => withBusy(make, async () => {
    clearErrors(fields);
    const amount = Number(String((fields.amount.input.value) || '').replace(/\s/g, '').replace(',', '.')) || 0;
    if (isPp && !amount) { showError(fields.amount, 'Укажите сумму'); return; }
    if (isPp && !fields.purpose.input.value.trim()) { showError(fields.purpose, 'Банк не примет платёж без назначения'); return; }
    if (!isPp && !fields.subject.input.value.trim()) { showError(fields.subject, 'Без предмета договор не собрать'); return; }
    const r = await api('POST', '/api/doc/other', {
      type,
      cpId: Number(who.value),
      date: date.input.value,
      number: num.input.value.trim(),
      amount,
      purpose: isPp ? fields.purpose.input.value.trim() : '',
      subject: isPp ? '' : fields.subject.input.value.trim(),
      term: isPp ? '' : fields.term.input.value.trim(),
    });
    haptic('medium');
    toast('Готово — файл в чате с ботом');
    download(r.file);
    await afterIssue();
  });
  box.append(h('div', { class: 'btn-wrap' }, make));
  return box;
};

/* ---------- напоминания должникам ---------- */

/**
 * Готовый текст для каждого должника.
 *
 * Писать контрагентам сами мы не будем: согласия на это они не давали, а
 * адресов у нас нет. Отдаём текст — человек отправит его от своего имени.
 */
screens.reminders = async function reminders() {
  const { reminders: list, canMail } = await api('GET', '/api/reminders');
  const box = h('div', {}, h('h1', { text: 'Напомнить о долге' }));
  if (!list.length) {
    box.append(empty('check', 'Должников нет', 'Некому напоминать — все рассчитались.'));
    return box;
  }
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: canMail
      ? 'Текст можно поправить и отправить с вашей почты — вместе с актом сверки. '
        + 'Или скопировать и отправить как удобно.'
      : 'Скопируйте текст и отправьте должнику сами. Чтобы отправлять письмом '
        + 'прямо отсюда, подключите свою почту в разделе «Ещё».' }));

  for (const r of list) {
    const card = h('div', { class: 'card' });
    card.append(h('div', { class: 'row' },
      h('span', { class: 'icon-box' }, icon('users')),
      h('span', { class: 'grow' },
        h('div', { class: 'ellipsis', text: r.name }),
        h('div', { class: 'small muted', text: 'должен нам' })),
      h('span', { class: 'money in nowrap', text: money0(r.amount) })));

    /*
     * Текст правится прямо здесь. Готовая формулировка подходит не всякому
     * клиенту: с одним говорят строже, с другим мягче, а с третьим уже
     * договорились по телефону. Отправлять чужими словами то, что испортит
     * отношения с плательщиком, — плохая услуга.
     */
    const text = h('textarea', { class: 'remind-text', id: `rm-${r.cpId}` });
    text.value = r.text;
    // Высота по содержимому: письмо, обрезанное на полуслове, не перечитают,
    // а перечитать его — весь смысл этого экрана.
    const grow = () => { text.style.height = 'auto'; text.style.height = `${text.scrollHeight}px`; };
    text.addEventListener('input', grow);
    requestAnimationFrame(grow);
    card.append(h('div', { class: 'field' },
      h('label', { for: `rm-${r.cpId}`, text: 'Текст письма' }), text));

    const copy = h('button', { class: 'btn secondary' }, 'Скопировать');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text.value);
        haptic('medium');
        toast('Текст скопирован');
      } catch (_) {
        toast('Скопируйте вручную — браузер не дал доступ к буферу', true);
      }
    };

    if (!canMail) {
      box.append(card, h('div', { class: 'btn-wrap' }, copy));
      continue;
    }

    const mail = field('to', 'Почта клиента', r.email, {
      type: 'email', placeholder: 'buh@company.ru',
      hint: r.email ? 'Сохранена в карточке клиента' : 'Запомню её для этого клиента',
    });
    card.append(mail);

    const send = h('button', { class: 'btn' }, 'Отправить с моей почты');
    send.onclick = (e) => withBusy(e.currentTarget, async () => {
      clearErrors({ mail });
      const to = mail.input.value.trim();
      if (!to) { showError(mail, 'Некуда отправлять — укажите почту'); return; }
      const res = await api('POST', '/api/reminder/mail', {
        cpId: r.cpId, email: to, text: text.value,
      });
      haptic('medium');
      toast(res.withAkt ? `Отправлено на ${res.sent} вместе с актом сверки` : `Отправлено на ${res.sent}`);
    });

    box.append(card, h('div', { class: 'btn-wrap' }, send),
      h('div', { class: 'btn-wrap', style: 'padding-top:0' }, copy));
  }
  return box;
};

/* ---------- поддержка ---------- */

screens.support = async function support() {
  const box = h('div', {}, h('h1', { text: 'Поддержка' }));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Опишите, что случилось. Ответим в чате с ботом — там же, где приходят документы.' }));
  const text = field('text', 'Сообщение', '', {
    multiline: true, required: true,
    placeholder: 'Например: счёт выписался без QR-кода, хотя банк заполнен',
  });
  box.append(h('div', { class: 'card' }, text));
  const send = h('button', { class: 'btn' }, 'Отправить');
  send.onclick = () => withBusy(send, async () => {
    clearErrors({ text });
    if (text.input.value.trim().length < 5) { showError(text, 'Пары слов мало — опишите подробнее'); return; }
    const r = await api('POST', '/api/support', { text: text.input.value.trim() });
    haptic('medium');
    toast(r.sent ? 'Отправлено — ответим в чате' : 'Поддержка сейчас недоступна, напишите боту');
    back();
  });
  box.append(h('div', { class: 'btn-wrap' }, send));
  return box;
};

/* ---------- снимок счёта ---------- */

/**
 * Фотография счёта от поставщика: распознаём сумму и дату, чтобы не
 * перебивать их руками. Работает, только если подключён внешний сервис —
 * и об этом говорим прямо, а не молчим.
 */
/**
 * Загрузка банковской выписки.
 *
 * Экран показывает найденные поступления и то, кому они, по нашему мнению,
 * относятся, — но ничего не заносит сам. Галочки проставлены только там, где
 * клиент угадан уверенно; остальное человек либо выбирает руками, либо
 * оставляет как есть. Автоматически закрытый не тот долг обнаруживается
 * через месяц и стоит дороже, чем минута на проверку.
 */
screens.bank = async function bankScreen() {
  const box = h('div', {}, h('h1', { text: 'Выписка из банка' }));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Выгрузите выписку в интернет-банке и пришлите файл: 1С «Клиент-Банк», OFX '
      + 'или CSV. Найду поступления, покажу, от кого они, — отметите нужные, и они '
      + 'попадут в журнал как оплаты.' }));

  const cps = (await api('GET', '/api/cps')).cps || [];
  const input = h('input', {
    type: 'file',
    accept: '.csv,.txt,.ofx,.qfx,text/csv,text/plain',
    style: 'display:none',
  });
  const pick = h('button', { class: 'btn' }, 'Выбрать файл выписки');
  const result = h('div', {});
  pick.onclick = () => input.click();

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 1.4 * 1024 * 1024) {
      result.replaceChildren(h('div', { class: 'banner' }, icon('warn'),
        h('div', { text: 'Файл больше 1,4 МБ. Выгрузите выписку за месяц, а не за год.' })));
      return;
    }
    result.replaceChildren(h('div', { class: 'boot' }, h('span', { class: 'spinner' }), 'Читаю выписку…'));
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('Не удалось прочитать файл.'));
        fr.readAsDataURL(file);        // байты как есть: кодировку разберёт сервер
      });
      const r = await api('POST', '/api/bank/parse', { dataUrl });
      result.replaceChildren(bankRows(r, cps));
      haptic('medium');
    } catch (e) {
      result.replaceChildren(h('div', { class: 'banner' }, icon('warn'), h('div', { text: e.message })));
    }
  });

  box.append(h('div', { class: 'btn-wrap' }, pick), input, result);
  return box;
};

/** Разобранная выписка: список поступлений с выбором клиента. */
function bankRows(r, cps) {
  const box = h('div', {});
  const fresh = r.rows.filter((t) => !t.known);

  const sum = fresh.reduce((a, t) => a + t.amount, 0);
  box.append(h('div', { class: 'hero' },
    h('div', { class: 'sum money in', text: money0(sum) }),
    // «Найдено», а не «занесено»: крупная зелёная сумма иначе читается как
    // итог операции, хотя в журнал попадёт только отмеченное ниже.
    h('div', { class: 'sub',
      text: `найдено ${fresh.length} ${plural(fresh.length, 'поступление', 'поступления', 'поступлений')}`
        + ` · разобрано строк ${r.total}`
        + (r.outgoing ? `, списаний ${r.outgoing}` : '')
        + (r.rows.length - fresh.length ? `, уже загружено ${r.rows.length - fresh.length}` : '') })));

  if (!fresh.length) {
    box.append(empty('check', 'Новых поступлений нет',
      'Все строки этой выписки уже занесены в журнал — повторно они не пройдут.'));
    return box;
  }

  const chosen = new Map();          // key → cpId
  const card = h('div', { class: 'card' });
  const save = h('button', { class: 'btn' }, 'Занести оплаты');

  const relabel = () => {
    const n = chosen.size;
    save.textContent = n
      ? `Занести ${n} ${plural(n, 'оплату', 'оплаты', 'оплат')}`
      : 'Выберите клиентов';
    save.disabled = !n;
  };

  for (const t of fresh) {
    // Предполагаемого клиента ставим первым в списке и подписываем: строка
    // сама его не выберет, но искать его среди полусотни имён не придётся.
    const order = t.cp
      ? [...cps.filter((c) => c.id === t.cp.id), ...cps.filter((c) => c.id !== t.cp.id)]
      : cps;
    const sel = h('select', {},
      h('option', { value: '', text: '— не заносить —' }),
      order.map((c) => h('option', {
        value: String(c.id),
        text: t.cp && c.id === t.cp.id && t.confidence < 60 ? `${c.name} — похоже` : c.name,
      })));
    // Уверенное совпадение отмечаем сразу, сомнительное показываем, но не
    // выбираем: молча угаданный клиент — это и есть ошибочная проводка.
    if (t.cp && t.confidence >= 60) {
      sel.value = String(t.cp.id);
      chosen.set(t.key, t.cp.id);
    }
    sel.onchange = () => {
      if (sel.value) chosen.set(t.key, Number(sel.value));
      else chosen.delete(t.key);
      relabel();
      haptic();
    };

    card.append(h('div', { class: 'pay' },
      h('div', { class: 'row' },
        h('span', { class: 'grow' },
          h('div', { class: 'ellipsis', text: t.name || 'без названия' }),
          h('div', { class: 'sub-line' },
            h('span', { class: 'small muted nowrap', text: ru(t.date) }),
            // Кого именно предлагаем — видно в списке ниже, поэтому здесь
            // только повод присмотреться, без имени: оно всё равно не
            // помещается в строку и обрывается многоточием.
            t.cp && t.confidence < 60 && h('span', { class: 'badge', text: 'проверьте клиента' }),
            // Ничья и «никого не нашли» — разные вещи, и раньше выглядели
            // одинаково: бот обещал «выберите нужного в приложении», а
            // приложение показывало «клиент не найден» и полный список.
            !t.cp && t.ambiguous && h('span', { class: 'badge', text: 'совпал с двумя' }),
            !t.cp && !t.ambiguous && h('span', { class: 'badge', text: 'клиент не найден' }))),
        h('span', { class: 'money in nowrap', text: money(t.amount) })),
      t.purpose && h('div', { class: 'pay-note small muted', text: t.purpose }),
      !t.cp && t.ambiguous && (t.rivals || []).length && h('div', {
        class: 'pay-note small muted',
        text: `Похоже сразу на двоих: ${(t.rivals || []).join(' и ')}. Выберите нужного.`,
      }),
      h('div', { class: 'pay-pick' }, sel)));
  }
  relabel();

  save.onclick = () => withBusy(save, async () => {
    const rows = fresh.filter((t) => chosen.has(t.key)).map((t) => ({
      key: t.key, cpId: chosen.get(t.key), amount: t.amount, date: t.date,
      doc: t.doc ? `Оплата, п/п № ${t.doc}` : 'Оплата по выписке',
    }));
    if (!rows.length) { toast('Не выбран ни один клиент', true); return; }
    const res = await api('POST', '/api/bank/import', { rows });
    haptic('medium');
    toast(res.added
      ? `Занесено ${res.added} ${plural(res.added, 'оплата', 'оплаты', 'оплат')}`
      : 'Ничего не занесено');
    /*
     * Деньги в журнале, но счета всё ещё висят в «не оплачено». Связь
     * «пришло 30 000 от Зари — значит, счёт № 7 закрыт» видна из сумм, и
     * незачем заставлять человека проходить её руками по одному документу.
     *
     * Показываем и ждём нажатия: закрыть долг за человека нельзя. Ошибку
     * заметят через месяц, когда клиент не заплатит, а счёт уже помечен.
     */
    if (Array.isArray(res.deals) && res.deals.length) {
      reset('bankclose', { deals: res.deals, leftovers: res.leftovers || [] });
      return;
    }
    reset('debts');
  });
  box.append(card, h('div', { class: 'btn-wrap' }, save));
  return box;
}

/**
 * Второй шаг после выписки: какие счета закрыли пришедшие деньги.
 *
 * Отдельным экраном, а не галочками рядом с оплатами: это другое решение.
 * Первое — «эти деньги пришли», второе — «и они закрывают вот эти счета».
 * Смешав их в один список, мы бы получили нажатие, после которого человек
 * не знает точно, что именно подтвердил.
 *
 * Экран строится из того, что уже посчитал сервер: заново он ничего не
 * подбирает. Человек подтверждает ровно тот список, который видит.
 */
screens.bankclose = async function bankClose(params) {
  const deals = Array.isArray(params.deals) ? params.deals : [];
  const leftovers = Array.isArray(params.leftovers) ? params.leftovers : [];
  const box = h('div', {}, h('h1', { text: 'Эти счета закрыты' }));
  if (!deals.length) {
    box.append(empty('check', 'Нечего закрывать',
      'Пришедшие деньги не закрыли ни одного счёта целиком.'));
    return box;
  }
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px 12px',
    text: 'Деньги уже в журнале. Осталось снять счета с ожидания — проверьте и подтвердите.' }));

  /*
   * Строки не нажимаются: это список на подтверждение, а не меню. Поэтому
   * обычный div, а не navRow — тот рисует стрелку, а стрелка обещает
   * переход, которого не будет.
   */
  const line = (ic, title, sub, right, tone) => h('div', { class: 'row' },
    h('span', { class: `icon-box ${tone || ''}` }, icon(ic)),
    h('span', { class: 'grow' },
      h('div', { class: 'ellipsis', text: title }),
      sub && h('div', { class: 'sub-line' }, h('span', { class: 'small muted', text: sub }))),
    h('span', { class: 'money nowrap', text: right }));

  box.append(h('div', { class: 'card' }, deals.map((d) => line(
    'doc-check', d.title,
    d.alsoTitle ? `${d.cpName} · и ${d.alsoTitle} — та же сделка` : d.cpName,
    money0(d.total), 'ok'))));
  if (leftovers.length) {
    box.append(h('div', { class: 'section-title', text: 'Не легло ни на один счёт' }));
    box.append(h('div', { class: 'card' }, leftovers.map((l) => line(
      'wallet', l.cpName, 'счёт не выписан или оплата частичная', money0(l.amount)))));
  }

  const docs = deals.reduce((n, d) => n + (d.twinId ? 2 : 1), 0);
  const done = h('button', { class: 'btn' }, `Отметить оплаченными (${docs})`);
  done.onclick = () => withBusy(done, async () => {
    const res = await api('POST', '/api/bank/close', { deals });
    haptic('medium');
    toast(res.docs
      ? `Отмечено ${res.docs} ${plural(res.docs, 'документ', 'документа', 'документов')}`
      : 'Ничего не отмечено');
    // Через выписку закрывают сразу пачку, и про чек тут забывают вернее
    // всего: человек ничего не выписывал, он просто прислал файл.
    if (res && res.npd) pendingCheque = res.npd;
    reset('debts');
  });
  const skip = h('button', { class: 'btn ghost' }, 'Не сейчас');
  skip.onclick = () => reset('debts');
  box.append(h('div', { class: 'btn-wrap' }, done), h('div', { class: 'btn-wrap' }, skip));
  return box;
};

screens.scan = async function scan() {
  const box = h('div', {}, h('h1', { text: 'Снимок счёта' }));
  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: 'Сфотографируйте счёт от поставщика — вытащу сумму, дату и номер и предложу '
      + 'внести операцию. Сам файл никуда не сохраняется.' }));

  const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' });
  const pick = h('button', { class: 'btn' }, 'Выбрать снимок');
  const result = h('div', {});
  pick.onclick = () => input.click();

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    result.replaceChildren(h('div', { class: 'boot' }, h('span', { class: 'spinner' }), 'Распознаю…'));
    try {
      // Распознаванию нужнее разрешение, чем факсимиле, но и тело запроса
      // ограничено двумя мегабайтами — берём с запасом.
      const dataUrl = await shrinkImage(file, 1600, 1400 * 1024);
      const r = await api('POST', '/api/scan', { dataUrl });
      const f = r.fields || {};
      result.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'Сумма' }),
          h('span', { class: 'money', text: f.amount ? money(f.amount) : 'не разобрал' })),
        h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'Дата' }),
          h('span', { text: f.date ? ru(f.date) : 'не разобрал' })),
        h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'Номер' }),
          h('span', { text: f.docNo || '—' })),
        h('div', { class: 'row' }, h('span', { class: 'grow muted', text: 'Кто' }),
          h('span', { class: 'ellipsis', text: (r.cp && r.cp.name) || f.name || 'не опознан' }))));
      if (r.cp && f.amount) {
        result.append(h('div', { class: 'btn-wrap' }, h('button', {
          class: 'btn',
          onclick: () => go('op', { cpId: r.cp.id, doc: f.docNo ? `Счёт № ${f.docNo}` : 'Счёт' }),
        }, 'Внести операцию')));
      }
      haptic('medium');
    } catch (e) {
      result.replaceChildren(h('div', { class: 'banner' }, icon('warn'), h('div', { text: e.message })));
    }
  });

  box.append(h('div', { class: 'btn-wrap' }, pick), input, result);
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
      ['Документы без ограничений', 'Счета, акты, УПД, накладные, договоры и платёжки', 'Автозаполнение по ИНН и БИК', 'Поддержка в чате']
        .map((t) => h('div', { class: 'row' }, h('span', { class: 'icon-box ok' }, icon('check')), h('span', { class: 'grow', text: t })))));

    /*
     * Цена — до кнопки, а не после перехода на оплату. Раньше её не было
     * нигде: ни в боте, ни здесь, — и человек узнавал стоимость, только
     * уйдя на сторонний сайт. Берётся из тарифов, по которым считается срок
     * доступа, поэтому разойтись с реальной ценой не может.
     */
    /*
     * Тарифы строками, а не фразой.
     *
     * Раньше здесь стояло «390 ₽ в месяц или 2990 ₽ в год» одной строкой,
     * и справа значок выгоды. На узком экране фраза рвалась посреди числа:
     * «2990» на одной строке, «₽ в год» на другой. Число, оторванное от
     * знака рубля, читается как ошибка — а это цена, по ней принимают
     * решение. Теперь у каждого срока своя строка: слева название, справа
     * сумма, которую не разлучить переносом.
     */
    const list = (s.price && s.price.plans) || [];
    if (list.length) {
      box.append(h('div', { class: 'section-title', text: 'Сколько стоит' }));
      box.append(h('div', { class: 'card' }, list.map((p) => {
        const best = s.price.saving > 0 && p.days >= 350;
        return h('div', { class: 'row' },
          h('span', { class: 'grow' },
            h('div', { text: p.title }),
            best ? h('div', { class: 'small ok', text: `выгода ${money0(s.price.saving)} за год` }) : null),
          h('span', { class: 'price money nowrap', text: money0(p.amount) }));
      })));
    } else if (s.price && s.price.text) {
      // Тарифов списком нет — показываем как есть, но не выдумываем цену.
      box.append(h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'grow', text: s.price.text }))));
    }

    if (s.payUrl) {
      box.append(h('div', { class: 'btn-wrap' }, h('button', {
        class: 'btn',
        onclick: () => {
          haptic('medium');
          if (tg && tg.openLink) tg.openLink(s.payUrl); else window.open(s.payUrl, '_blank');
        },
      }, 'Оформить подписку')));

      /*
       * «Я оплатил» прямо здесь. Раньше приложение отправляло человека
       * обратно в чат — он платил и упирался в надпись «вернитесь в бота».
       * Платёж не привязывается к аккаунту сам: платят из браузера, и
       * связать оплату с человеком можно только по почте, которую он там
       * указал.
       */
      const paid = field('paidmail', 'Почта, указанная при оплате', '', {
        type: 'email', placeholder: 'vy@mail.ru',
        hint: 'По ней найду ваш платёж и включу подписку',
      });
      const claim = h('button', { class: 'btn secondary' }, 'Я оплатил');
      const claimBox = h('div', { hidden: true }, h('div', { class: 'card' }, paid),
        h('div', { class: 'btn-wrap' }, h('button', {
          class: 'btn',
          onclick: (e) => withBusy(e.currentTarget, async () => {
            clearErrors({ paid });
            const mail = paid.input.value.trim();
            if (!mail) { showError(paid, 'Без адреса платёж не найти'); return; }
            const r = await api('POST', '/api/pay/claim', { email: mail });
            haptic('medium');
            toast(`Нашёл ${r.found} ${plural(r.found, 'оплату', 'оплаты', 'оплат')} — доступ до ${ru(r.until)}`);
            render();
          }),
        }, 'Найти мой платёж')));
      claim.onclick = () => { claimBox.hidden = !claimBox.hidden; haptic(); };
      box.append(h('div', { class: 'btn-wrap', style: 'padding-top:0' }, claim), claimBox);
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
/*
 * Отдать файл человеку.
 *
 * Обычная ссылка с download внутри Telegram не работает: встроенный браузер
 * блокирует скачивания, которые страница начинает сама. Нажатие выглядело
 * как «кнопка не работает» — так и было с реестром и актом сверки.
 *
 * Поэтому по порядку: родное окно загрузки Telegram, если оно есть; иначе
 * открыть ссылку во внешнем браузере; и только в обычном вебе — ссылка.
 */
function download(file) {
  if (!file || !file.url) return;
  const url = file.url.startsWith('http') ? file.url : window.location.origin + file.url;
  if (tg && typeof tg.downloadFile === 'function') {
    try { tg.downloadFile({ url, file_name: file.name }); return; } catch (_) { /* ниже */ }
  }
  if (tg && typeof tg.openLink === 'function') { tg.openLink(url); return; }
  const a = h('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * Отправить ссылку в Telegram — выбрать чат и переслать.
 *
 * openTelegramLink, а не openLink: первый открывает выбор чата внутри
 * приложения, второй уводит в браузер, где та же ссылка просто снова
 * попросит открыть Telegram. Если ни того, ни другого нет (открыли в
 * обычном вебе), остаётся обычный переход.
 */
/**
 * Открыть внешний адрес. Внутри Telegram — его же средствами: обычный
 * window.open в мини-приложении открывает пустую вкладку и всё.
 */
function openOutside(url) {
  if (tg && typeof tg.openLink === 'function') { tg.openLink(url); return; }
  window.open(url, '_blank');
}

function shareToTelegram(url, text) {
  const share = `https://t.me/share/url?url=${encodeURIComponent(url)}`
    + `&text=${encodeURIComponent(text || '')}`;
  haptic('medium');
  if (tg && typeof tg.openTelegramLink === 'function') { tg.openTelegramLink(share); return; }
  if (tg && typeof tg.openLink === 'function') { tg.openLink(share); return; }
  window.open(share, '_blank');
}

/*
 * ---------- счета-фактуры: аванс и корректировка ----------
 *
 * Отдельными экранами, а не строкой в общем мастере: у аванса нет позиций, у
 * корректировки строки парные «было/стало». Ни то, ни другое обычной таблицей
 * позиций не набирается.
 */

/** Счёт-фактура на полученную предоплату. */
screens.avans = async function avansScreen(params) {
  const s = await api('GET', '/api/state');
  const org = s.org || {};
  const rate = org.vat_rate ? Number(org.vat_rate) : null;
  const box = h('div', {}, h('h1', { text: 'Счёт-фактура на аванс' }));

  // Неплательщику этот документ не положен — говорим прямо, а не показываем
  // форму, которая закончится отказом.
  if (rate == null || Number(org.npd)) {
    box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
      text: Number(org.npd)
        ? 'Самозанятый не выставляет счета-фактуры: он не плательщик НДС (422-ФЗ).'
        : 'Счёт-фактура выставляется со ставкой НДС, а у вас выбрано «без НДС».' }));
    box.append(h('div', { class: 'btn-wrap' },
      h('button', { class: 'btn', onclick: () => go(Number(org.npd) ? 'npd' : 'vat') }, 'Открыть настройку')));
    return box;
  }

  const { cps } = await api('GET', '/api/cps');
  const cpSel = h('select', { id: 'a-cp' },
    cps.map((c) => h('option', { value: c.id, selected: c.id === Number(params.cpId) }, c.name)));
  const sum = field('sum', 'Получено, ₽', '', { inputmode: 'decimal', required: true,
    hint: 'Введите сумму целиком, как пришла: налог в ней уже сидит' });
  const payDoc = field('payDoc', 'Платёжное поручение', '', {
    placeholder: '№ 55 от 01.09.2026',
    hint: 'Обязательный реквизит: по нему налоговая свяжет счёт-фактуру с деньгами',
  });
  const subject = field('subject', 'За что', '', { placeholder: 'Монтаж по договору № 7' });

  // Налог показываем сразу, пока человек печатает: ошибку видно там, где её
  // ещё можно исправить, а не в готовом документе.
  const calc = h('p', { class: 'small muted', style: 'margin:4px 18px' });
  const recalc = () => {
    const v = Number(String(sum.input.value).replace(',', '.')) || 0;
    const vat = v > 0 ? Math.round((v * rate) / (100 + rate) * 100) / 100 : 0;
    calc.textContent = v > 0
      ? `Расчётная ставка ${rate}/${100 + rate}: налог ${money(vat)} из ${money(v)}`
      : `Ставка ${rate}% — налог выделю расчётным путём, ${rate}/${100 + rate}`;
  };
  sum.input.oninput = recalc;
  recalc();

  box.append(h('div', { class: 'card' },
    h('div', { class: 'field' }, h('label', { for: 'a-cp', text: 'От кого' }), cpSel),
    sum, payDoc, subject));
  box.append(calc);

  const btn = h('button', { class: 'btn' }, 'Выписать');
  btn.onclick = () => withBusy(btn, async () => {
    try {
      const r = await api('POST', '/api/doc/avans', {
        cpId: Number(cpSel.value),
        sum: Number(String(sum.input.value).replace(',', '.')),
        payDoc: payDoc.input.value,
        subject: subject.input.value,
      });
      haptic('heavy');
      toast(`Выписан № ${r.doc.number}, налог ${money(r.vat)}`);
      download(r.file);
      go('docs');
    } catch (e) { toast(e.message, true); }
  });
  box.append(h('div', { class: 'btn-wrap' }, btn));
  return box;
};

/** Корректировочный счёт-фактура: выбрать исходный, ввести новые строки. */
screens.ksf = async function ksfScreen(params) {
  const box = h('div', {}, h('h1', { text: 'Корректировочный счёт-фактура' }));
  const { docs } = await api('GET', `/api/doc/correctable?cpId=${Number(params.cpId) || 0}`);

  if (!docs.length) {
    box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
      text: 'Корректировать нечего: по этому клиенту нет ни одного счёта-фактуры. '
        + 'Корректировочный выставляют к уже выданному, когда стороны договорились '
        + 'об изменении стоимости.' }));
    return box;
  }

  // Шаг 1 — какой документ правим.
  if (!params.baseId) {
    box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
      text: 'К какому счёту-фактуре корректировка?' }));
    box.append(h('div', { class: 'card' }, docs.map((d) => navRow({
      icon: 'doc',
      title: `№ ${d.number} от ${ru(d.date)}`,
      sub: money(d.total),
      onclick: () => go('ksf', { cpId: params.cpId, baseId: d.id }),
    }))));
    return box;
  }

  // Шаг 2 — новые значения, строка в строку.
  const base = docs.find((d) => d.id === Number(params.baseId));
  if (!base) { box.append(h('p', { class: 'small muted', text: 'Документ не найден.' })); return box; }

  box.append(h('p', { class: 'small muted', style: 'margin:0 18px',
    text: `К счёту-фактуре № ${base.number} от ${ru(base.date)}. Укажите, что стало — `
      + 'строки идут в том же порядке.' }));

  // Идентификаторы полей — по номеру строки: в названии позиции бывают
  // пробелы и кавычки, а из них выходит невалидный id.
  const rows = base.items.map((it, i) => ({
    it,
    q: field(`ksfq${i}`, `${it.name} — количество`, it.qty, { inputmode: 'decimal' }),
    pr: field(`ksfp${i}`, `${it.name} — цена`, it.price, { inputmode: 'decimal' }),
  }));
  const card = h('div', { class: 'card' });
  for (const r of rows) {
    card.append(h('p', { class: 'small muted', style: 'margin:10px 14px 0',
      text: `Было: ${r.it.qty} × ${money(r.it.price)}` }));
    card.append(r.q, r.pr);
  }
  box.append(card);

  const reason = field('reason', 'Основание изменения', '', {
    required: true, placeholder: 'Соглашение № 3 от 04.09.2026',
    hint: 'Без основания корректировочный недействителен',
  });
  box.append(h('div', { class: 'card' }, reason));

  const btn = h('button', { class: 'btn' }, 'Выписать корректировочный');
  btn.onclick = () => withBusy(btn, async () => {
    try {
      const r = await api('POST', '/api/doc/ksf', {
        baseId: base.id,
        reason: reason.input.value,
        lines: rows.map((x) => ({
          name: x.it.name,
          qty: Number(String(x.q.input.value).replace(',', '.')),
          price: Number(String(x.pr.input.value).replace(',', '.')),
        })),
      });
      haptic('heavy');
      const up = (r.up || {}).total || 0;
      const down = (r.down || {}).total || 0;
      toast(up ? `Увеличение ${money(up)}` : `Уменьшение ${money(down)}`);
      download(r.file);
      go('docs');
    } catch (e) { toast(e.message, true); }
  });
  box.append(h('div', { class: 'btn-wrap' }, btn));
  box.append(h('p', { class: 'small muted', style: 'margin:8px 18px',
    text: 'Увеличение попадёт в книгу продаж, уменьшение — в книгу покупок: это ваш вычет.' }));
  return box;
};

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
    /*
     * Первого из списка подставляем, ТОЛЬКО если он там один.
     *
     * Раньше подставлялся всегда: экран, открытый без cpId, молча выбирал
     * cps[0]. Из чата это выглядело так — бот пишет «Готовлю документ для
     * „Заря“», а в поле «Кому» стоит совсем другая фирма, и человек этого не
     * ждёт и не перепроверяет. Когда клиент один, выбирать не из чего;
     * когда их несколько — пусть лучше поле будет пустым и потребует ответа.
     */
    cpId: Number(params.cpId) || (cps.length === 1 ? cps[0].id : 0),
    date: todayISO(),
    items: (params.items || []).map((it) => ({ ...it })),
    // Ставка, названную во фразе («…с НДС 22%»), доносим до выпуска. Не
    // передали — поля не будет вовсе, и документ возьмёт ставку организации:
    // отсутствие ключа и null означают разное.
    vatRate: params.vatRate,
    priceIncludesVat: params.priceIncludesVat,
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
    draft.cpId ? [] : [h('option', { value: '', selected: true }, '— выберите клиента —')],
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
    if (!Number(cpSel.value)) { toast('Выберите, кому выписываем', true); cpSel.focus(); return; }
    try {
      if (tg) tg.MainButton.showProgress();
      const payload = { type, cpId: Number(cpSel.value), date: dateInput.value, items };
      if (draft.vatRate !== undefined) {
        payload.vatRate = draft.vatRate;
        payload.priceIncludesVat = Boolean(draft.priceIncludesVat);
      }
      const r = await api('POST', '/api/doc', payload);
      haptic('heavy');
      toast(r.sentToChat ? 'Готово — файл отправлен в чат' : 'Документ выписан');
      download(r.file);
      await afterIssue();
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

/*
 * Назад пальцем от левого края.
 *
 * Так возвращаются во всех телефонах, и руке это привычнее, чем тянуться к
 * шапке. Начало жеста ограничено полосой у края: строки списков смахиваются
 * влево для удаления, и если ловить движение по всему экрану, одно будет
 * мешать другому. Порог по горизонтали больше вертикального разброса —
 * иначе прокрутка списка иногда уводила бы с экрана.
 */
function edgeSwipeBack() {
  const EDGE = 28;          // откуда считаем жест краевым
  const NEED = 70;          // сколько надо протянуть
  let x0 = 0;
  let y0 = 0;
  let live = false;

  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    live = t.clientX <= EDGE;
    x0 = t.clientX;
    y0 = t.clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!live) return;
    const t = e.touches[0];
    if (Math.abs(t.clientY - y0) > Math.abs(t.clientX - x0)) live = false;   // это прокрутка
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!live) return;
    live = false;
    const t = e.changedTouches[0];
    if (t.clientX - x0 >= NEED && Math.abs(t.clientY - y0) < NEED) { haptic(); back(); }
  }, { passive: true });
}

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
    dropSplash();            // иначе заставка останется висеть поверх ответа
    return;
  }

  tg.ready();
  tg.expand();
  tg.BackButton.onClick(back);
  edgeSwipeBack();
  if (tg.setHeaderColor) { try { tg.setHeaderColor('secondary_bg_color'); } catch (_) { /* старый клиент */ } }
  if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); // чтобы список не закрывал окно

  if (!initData) {
    app.replaceChildren(empty('warn', 'Не удалось вас опознать',
      'Закройте приложение и откройте его заново из чата с ботом.'));
    tabsBox.hidden = true;
    dropSplash();            // иначе заставка останется висеть поверх ответа
    return;
  }

  render();
}

start();
