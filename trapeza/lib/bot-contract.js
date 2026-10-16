'use strict';

/**
 * Свой договор и разбор договора — в чате с ботом.
 *
 * Отдельным модулем, а не в bot.js: тот давно перерос шесть тысяч строк, а
 * у договоров своя небольшая машина состояний — «жду файл», «проверь, что
 * я нашёл», «отвечай на вопросы по полям». Помощники бота (клавиатура,
 * меню, отправка файла) приходят параметром — так модуль не тянет bot.js
 * обратно и не создаёт кольца зависимостей.
 *
 * Состояния:
 *   mycon:<scope>     — ждём файл своего договора (scope: id клиента или 0 — для всех);
 *   mycon.ok:<scope>  — шаблон прочитан, ждём «Сохранить»;
 *   ctfile            — прислали файл без контекста, ждём «Разобрать» или «Сделать шаблоном»;
 *   dogx:<cpId>       — выписываем договор по шаблону, спрашиваем поля по очереди.
 */

const bdb = require('./bot-db');
const mc = require('./my-contract');
const cai = require('./contract-ai');
const docService = require('./doc-service');
const office = require('./office');
const { todayISO } = require('./period');

const MAX_FILE = 20 * 1024 * 1024;
const LEVEL_ICON = { high: '🔴', medium: '🟡', low: '🟢' };

module.exports = function contractFlow(h) {
  const { keyboard, esc, mainMenu, ru, sendGenerated, cpMenu, requireQuota, requireOrg, parseAmount, replyVoice } = h;

  const ownerOf = (userId) => {
    const org = bdb.currentOrg(userId);
    return org ? `${org.full_name || org.name}${org.inn ? `, ИНН ${org.inn}` : ''}` : '';
  };
  const scopeName = (userId, scope) => {
    if (!Number(scope)) return 'для всех клиентов';
    const cp = bdb.getCp(userId, Number(scope));
    return cp ? `для «${cp.name}»` : 'для клиента';
  };
  const report = (userId, where, detail) => {
    if (!detail) return;
    Promise.resolve(office.record({ kind: 'ai', where, error: String(detail), userId })).catch(() => {});
  };

  /** Экран «Свой договор» из карточки клиента. */
  async function menu(tg, chatId, user, cpId) {
    const cp = bdb.getCp(user.id, cpId);
    if (!cp) return;
    const own = mc.getOwn(user.id, cpId);
    const all = mc.getOwn(user.id, 0);
    const lines = ['<b>Свой договор</b>', ''];
    if (own) lines.push(`Для «${esc(cp.name)}»: <b>${esc(own.title)}</b> (полей: ${mc.askFields(own).length}).`);
    if (all) lines.push(`Для всех клиентов: <b>${esc(all.title)}</b>${own ? ' — для этого клиента его заменяет свой.' : '.'}`);
    if (!own && !all) {
      lines.push('Пока договор типовой. Пришлите свой — Word, PDF или фото: найду, что в нём меняется '
        + '(клиент, дата, место, сумма), и дальше буду спрашивать только это.');
    }
    const rows = [];
    rows.push([{ text: `📤 ${own ? 'Заменить' : 'Загрузить'} для «${cp.name}»`.slice(0, 60), data: `mc.up:${cp.id}` }]);
    rows.push([{ text: `📤 ${all ? 'Заменить' : 'Загрузить'} для всех клиентов`, data: 'mc.up:0' }]);
    if (own) rows.push([{ text: `🗑 Убрать договор «${cp.name}»`.slice(0, 60), data: `mc.del:${cp.id}` }]);
    if (all) rows.push([{ text: '🗑 Убрать договор для всех', data: 'mc.del:0' }]);
    rows.push([{ text: '📝 Выписать договор', data: `d.dog:${cp.id}` }]);
    if (own || all) rows.push([{ text: '📄 Типовой договор вместо своего', data: `d.dogstd:${cp.id}` }]);
    rows.push([{ text: `⬅️ ${cp.name}`.slice(0, 60), data: `cp:${cp.id}` }]);
    await tg.sendMessage(chatId, lines.join('\n'), keyboard(rows));
  }

  async function askUpload(tg, chatId, user, scope) {
    // Номер клиента приходит из кнопки, а кнопку можно подделать: шаблон не
    // должен ссылаться на чужую карточку, даже если читать её никто не даст.
    if (Number(scope) && !bdb.getCp(user.id, Number(scope))) {
      await tg.sendMessage(chatId, 'Такого клиента нет в вашем справочнике.');
      return;
    }
    bdb.setState(user.id, `mycon:${Number(scope) || 0}`, {});
    await tg.sendMessage(chatId,
      `Пришлите свой договор файлом — Word (DOCX), PDF или фото страниц. Сохраню его ${scopeName(user.id, scope)}.\n\n`
      + '<i>Найду, что меняется от сделки к сделке, — остальное оставлю слово в слово.</i>',
      keyboard([[{ text: '✖️ Отмена', data: 'mc.cancel' }]]));
  }

  /** Достать файл из сообщения: документ или самое крупное фото. */
  async function fileOf(tg, msg) {
    let fileId; let name; let mime; let size;
    if (msg.document) {
      ({ file_id: fileId, file_name: name, mime_type: mime, file_size: size } = msg.document);
    } else if (msg.photo && msg.photo.length) {
      const ph = msg.photo[msg.photo.length - 1];
      fileId = ph.file_id; name = 'фото.jpg'; mime = 'image/jpeg'; size = ph.file_size;
    }
    if (!fileId) return null;
    if (size && size > MAX_FILE) return { error: 'Файл больше 20 МБ — Telegram не отдаст его боту. Сожмите или пришлите PDF.' };
    const buffer = await tg.downloadFile(fileId, MAX_FILE).catch(() => null);
    if (!buffer) return { error: 'Не смог забрать файл из Telegram. Пришлите ещё раз.' };
    return { buffer, name: name || 'договор', mime: mime || '' };
  }

  /** Образец с подставленными значениями из исходника — чтобы проверить глазами. */
  async function samplePdf(user, tpl, cpId) {
    const org = bdb.currentOrg(user.id) || {};
    const cp = (cpId && bdb.getCp(user.id, cpId)) || { name: 'Клиент (подставлю из карточки)' };
    const values = {};
    for (const f of tpl.fields || []) values[f.key] = f.example || '';
    const html = mc.buildHtml({ org, cp, doc: { ...tpl, number: 'ОБРАЗЕЦ', date: todayISO(), values } });
    try {
      const { pdfAvailable, htmlToPdf } = require('./pdf');
      if (pdfAvailable()) return { filename: 'Образец_своего_договора.pdf', buffer: await htmlToPdf(html) };
    } catch (_) { /* ниже — HTML */ }
    return { filename: 'Образец_своего_договора.html', buffer: Buffer.from(html, 'utf8') };
  }

  async function detect(tg, chatId, user, file, scope) {
    await tg.sendMessage(chatId, '📖 Читаю договор — это до минуты…');
    await tg.sendChatAction(chatId, 'typing');
    const got = await cai.detectTemplate(user.id, file, { owner: ownerOf(user.id) });
    if (!got.ok) {
      report(user.id, 'свой договор', got.detail);
      bdb.setState(user.id, `mycon:${scope}`, {});
      await tg.sendMessage(chatId, esc(got.error), keyboard([[{ text: '✖️ Отмена', data: 'mc.cancel' }]]));
      return;
    }
    const tpl = got.template;
    bdb.setState(user.id, `mycon.ok:${scope}`, { tpl });
    const ask = mc.askFields(tpl);
    const lines = [`📎 <b>${esc(tpl.title)}</b> — прочитал.`, ''];
    if (ask.length) {
      lines.push('Буду спрашивать только то, что меняется:');
      for (const f of ask) lines.push(`• ${esc(f.label)}${f.example ? ` <i>(в образце: ${esc(f.example)})</i>` : ''}`);
    } else {
      lines.push('Меняющихся мест, кроме клиента и реквизитов, не нашёл — договор будет одинаковым для всех.');
    }
    lines.push('', 'Сам подставлю: номер и дату договора, клиента и его реквизиты, ваши реквизиты'
      + `${/\{\{price_words\}\}/.test(tpl.body) ? ', сумму прописью' : ''}.`);
    lines.push('', 'Проверьте образец ниже и сохраните.');
    const rows = [];
    if (Number(scope)) rows.push([{ text: `✅ Сохранить ${scopeName(user.id, scope)}`.slice(0, 60), data: `mc.save:${scope}` }]);
    rows.push([{ text: '✅ Сохранить для всех клиентов', data: 'mc.save:0' }]);
    rows.push([{ text: '✖️ Не сохранять', data: 'mc.cancel' }]);
    await tg.sendMessage(chatId, lines.join('\n'));
    const sample = await samplePdf(user, tpl, Number(scope));
    await tg.sendDocument(chatId, {
      filename: sample.filename, buffer: sample.buffer, buttons: rows,
      caption: 'Образец: на месте полей — значения из вашего файла.',
    });
  }

  async function save(tg, chatId, user, scope) {
    const st = bdb.getState(user.id);
    if (!st || !/^mycon\.ok:/.test(st.state) || !st.data || !st.data.tpl) {
      await tg.sendMessage(chatId, 'Этот договор уже сохранён или устарел — пришлите файл ещё раз.', mainMenu());
      return;
    }
    const saved = mc.saveTemplate(user.id, Number(scope) || 0, st.data.tpl);
    bdb.clearState(user.id);
    await tg.sendMessage(chatId,
      `✅ Сохранил «${esc(saved.title)}» ${scopeName(user.id, scope)}. Теперь «📝 Договор» выписывается по нему.`,
      keyboard([[{ text: '⬅️ Меню', data: 'menu' }]]));
  }

  // ── разбор чужого договора ──

  function reviewHtml(r) {
    const L = [`🔎 <b>Разбор: ${esc(r.title)}</b>${r.ref ? ` · ${esc(r.ref)}` : ''}`, ''];
    if (r.summary) L.push(esc(r.summary), '');
    if (r.parties.length) L.push(`<b>Стороны:</b> ${r.parties.map((p) => `${esc(p.role)} — ${esc(p.name)}${p.inn ? ` (ИНН ${esc(p.inn)})` : ''}`).join('; ')}`);
    const row = (t, v) => { if (v) L.push(`<b>${t}:</b> ${esc(v)}`); };
    row('Предмет', r.subject); row('Сумма', r.amount); row('Оплата', r.payment);
    row('Сроки', r.dates); row('Штрафы', r.penalties); row('Расторжение', r.termination);
    if (r.risks.length) {
      L.push('', '<b>Риски:</b>');
      for (const x of r.risks) L.push(`${LEVEL_ICON[x.level] || '🟡'} ${esc(x.text)}${x.fix ? `\n   <i>Как поправить: ${esc(x.fix)}</i>` : ''}`);
    }
    if (r.questions.length) L.push('', '<b>Что уточнить у второй стороны:</b>', ...r.questions.map((q) => `• ${esc(q)}`));
    L.push('', '<i>Это справка, а не юридическое заключение — серьёзные риски покажите юристу. '
      + 'Можно спросить меня по договору: «какой там штраф за отмену?»</i>');
    return L.join('\n').slice(0, 4000);
  }

  async function review(tg, chatId, user, file, { voice = false } = {}) {
    await tg.sendMessage(chatId, '🔎 Разбираю договор — это до минуты…');
    await tg.sendChatAction(chatId, 'typing');
    const got = await cai.reviewContract(user.id, file, { owner: ownerOf(user.id) });
    if (!got.ok) {
      report(user.id, 'разбор договора', got.detail);
      await tg.sendMessage(chatId, esc(got.error), mainMenu());
      return;
    }
    const r = got.review;
    mc.saveReview(user.id, { title: r.title, text: got.text, review: r });
    // Кнопки — по тому, что нашлось: вторая сторона есть в справочнике или нет.
    const org = bdb.currentOrg(user.id) || {};
    const other = r.parties.find((p) => p.inn && p.inn !== org.inn) || r.parties.find((p) => p.name && p.name !== org.name);
    const cps = bdb.listCps(user.id);
    const known = other && other.inn ? cps.find((c) => c.inn === other.inn) : null;
    const rows = [];
    if (known && r.ref) rows.push([{ text: `📝 Вписать договор в карточку «${known.name}»`.slice(0, 60), data: `ct.ref:${known.id}` }]);
    if (!known && other && other.name) rows.push([{ text: `➕ Завести «${other.name}»`.slice(0, 60), data: 'ct.addcp' }]);
    rows.push([{ text: '📎 Сделать этот договор моим шаблоном', data: 'ct.tpl' }]);
    rows.push([{ text: '⬅️ Меню', data: 'menu' }]);
    await tg.sendMessage(chatId, reviewHtml(r), keyboard(rows));
    if (voice && replyVoice) {
      const high = r.risks.filter((x) => x.level === 'high').length;
      await replyVoice(tg, chatId, user, `${r.summary} ${high ? `Серьёзных рисков: ${high} — подробности в сообщении.` : ''}`);
    }
  }

  // ── выписка договора по шаблону ──

  async function startTpl(tg, chatId, user, cp, tpl) {
    if (!(await requireQuota(tg, chatId, user))) return;
    const org = await requireOrg(tg, chatId, user); if (!org) return;
    const ask = mc.askFields(tpl);
    bdb.setState(user.id, `dogx:${cp.id}`, { tplId: tpl.id, i: 0, values: {} });
    await tg.sendMessage(chatId,
      `Договор с <b>${esc(cp.name)}</b> по вашему шаблону «${esc(tpl.title)}». `
      + (ask.length ? `Реквизиты подставлю сам — ${ask.length === 1 ? 'нужен один ответ' : `нужно ответов: ${ask.length}`}.`
        : 'Спрашивать нечего — выписываю.'),
      keyboard([[{ text: '📄 Лучше типовой', data: `d.dogstd:${cp.id}` }]]));
    if (!ask.length) { await finishTpl(tg, chatId, user, cp.id, tpl.id, {}); return; }
    await askField(tg, chatId, ask[0]);
  }

  async function askField(tg, chatId, f) {
    const hint = f.type === 'money' ? ' (числом, руб.)' : f.type === 'date' ? ' (например, 12.05.2026)' : '';
    await tg.sendMessage(chatId, `${esc(f.label)}${hint}:${f.example ? `\n<i>в образце было: ${esc(f.example)}</i>` : ''}`
      + '\n<i>«-» — оставить пустым для ручного заполнения</i>');
  }

  async function finishTpl(tg, chatId, user, cpId, tplId, values) {
    bdb.clearState(user.id);
    await tg.sendChatAction(chatId, 'upload_document');
    const res = await docService.issuePlain(user.id, { type: 'dog', cpId, fields: { tplId, values } });
    if (!res.ok) { await tg.sendMessage(chatId, esc(res.message), mainMenu()); return; }
    const cp = bdb.getCp(user.id, cpId);
    await sendGenerated(tg, chatId, {
      file: res.file,
      caption: `Договор № ${esc(res.doc.number)} от ${ru(res.doc.date)} с <b>${esc(cp.name)}</b> — по вашему шаблону.`,
    });
    const { info, kb } = cpMenu(user.id, cp);
    await tg.sendMessage(chatId, info, kb);
  }

  async function onTplText(tg, chatId, user, state, text) {
    const cpId = Number(state.state.split(':')[1]);
    const d = state.data || {};
    const tpl = mc.getTemplateById(user.id, d.tplId);
    if (!tpl) { bdb.clearState(user.id); await tg.sendMessage(chatId, 'Шаблон пропал — загрузите его заново.', mainMenu()); return; }
    const ask = mc.askFields(tpl);
    const f = ask[d.i];
    const t = String(text).trim();
    if (f && t !== '-') {
      if (f.type === 'money' || f.type === 'number') {
        const n = parseAmount(t);
        if (n == null || n < 0) { await tg.sendMessage(chatId, 'Нужно число, например 150000:'); return; }
        d.values[f.key] = n;
      } else {
        d.values[f.key] = t.slice(0, 500);
      }
    }
    d.i += 1;
    if (d.i < ask.length) {
      bdb.setState(user.id, state.state, d);
      await askField(tg, chatId, ask[d.i]);
      return;
    }
    await finishTpl(tg, chatId, user, cpId, tpl.id, d.values);
  }

  // ── входы из бота ──

  /** Пришёл документ-файл. true — разобрались здесь. */
  async function onFile(tg, chatId, user, msg) {
    const st = bdb.getState(user.id);
    const name = String((msg.document && msg.document.file_name) || '');
    const mime = String((msg.document && msg.document.mime_type) || '');
    if (st && /^mycon:\d+$/.test(st.state)) {
      const file = await fileOf(tg, msg);
      if (!file || file.error) { await tg.sendMessage(chatId, esc((file && file.error) || 'Файла не вижу.')); return true; }
      await detect(tg, chatId, user, file, Number(st.state.split(':')[1]));
      return true;
    }
    // Выписка из банка в PDF — прежний ответ про форматы выписки.
    if (/выписк|statement|vypisk/i.test(name)) return false;
    const kind = cai.fileKind(name, mime);
    if (!['pdf', 'docx', 'doc'].includes(kind)) return false;
    bdb.setState(user.id, 'ctfile', { fileId: msg.document.file_id, name, mime, size: msg.document.file_size || 0 });
    await tg.sendMessage(chatId, `Файл «${esc(name.slice(0, 80))}». Это договор? Что с ним сделать?`, keyboard([
      [{ text: '🔎 Разобрать: риски, сроки, деньги', data: 'ct.rev' }],
      [{ text: '📎 Сделать моим шаблоном договора', data: 'ct.tpl' }],
      [{ text: '✖️ Ничего', data: 'mc.cancel' }],
    ]));
    return true;
  }

  /** Пришло фото. true — это наш договор (ждали шаблон или подписали «договор»). */
  async function onPhoto(tg, chatId, user, msg) {
    const st = bdb.getState(user.id);
    const waiting = st && /^mycon:\d+$/.test(st.state);
    const asked = /договор/i.test(String(msg.caption || ''));
    if (!waiting && !asked) return false;
    const file = await fileOf(tg, msg);
    if (!file || file.error) { await tg.sendMessage(chatId, esc((file && file.error) || 'Фото не вижу.')); return true; }
    if (waiting) await detect(tg, chatId, user, file, Number(st.state.split(':')[1]));
    else await review(tg, chatId, user, file);
    return true;
  }

  /** Текст в одном из наших состояний. true — обработали. */
  async function onText(tg, chatId, user, state, text) {
    if (/^dogx:/.test(state.state)) { await onTplText(tg, chatId, user, state, text); return true; }
    // Файл прислали, кнопки не нажали, а пишут о другом — не держим человека.
    if (state.state === 'ctfile') { bdb.clearState(user.id); return false; }
    if (/^mycon(\.ok)?:/.test(state.state)) {
      await tg.sendMessage(chatId, state.state.startsWith('mycon.ok')
        ? 'Сохранить договор — кнопкой под образцом. Или отмените.'
        : 'Жду файл договора: Word, PDF или фото. Или отмените.',
      keyboard([[{ text: '✖️ Отмена', data: 'mc.cancel' }]]));
      return true;
    }
    return false;
  }

  /** Кнопки mc.* и ct.*. true — наша кнопка. */
  async function onCallback(tg, chatId, user, data) {
    if (data.startsWith('mc.menu:')) { await menu(tg, chatId, user, Number(data.slice(8))); return true; }
    if (data.startsWith('mc.up:')) { await askUpload(tg, chatId, user, Number(data.slice(6))); return true; }
    if (data.startsWith('mc.save:')) { await save(tg, chatId, user, Number(data.slice(8))); return true; }
    if (data.startsWith('mc.del:')) {
      const scope = Number(data.slice(7));
      const gone = mc.removeTemplate(user.id, scope);
      await tg.sendMessage(chatId, gone
        ? `Убрал свой договор ${scopeName(user.id, scope)}. Выписанные по нему договоры остались как были.`
        : 'Такого договора уже нет.', mainMenu());
      return true;
    }
    if (data === 'mc.cancel') {
      bdb.clearState(user.id);
      await tg.sendMessage(chatId, 'Отменил.', mainMenu());
      return true;
    }
    if (data === 'ct.rev' || data === 'ct.tpl') {
      const st = bdb.getState(user.id);
      // ct.tpl из-под разбора: файла в состоянии уже нет — просим прислать снова.
      if (!st || st.state !== 'ctfile' || !st.data || !st.data.fileId) {
        if (data === 'ct.tpl') { await askUpload(tg, chatId, user, 0); return true; }
        await tg.sendMessage(chatId, 'Пришлите файл договора ещё раз.', mainMenu());
        return true;
      }
      const buffer = await tg.downloadFile(st.data.fileId, MAX_FILE).catch(() => null);
      if (!buffer) { await tg.sendMessage(chatId, 'Не смог забрать файл из Telegram. Пришлите ещё раз.'); return true; }
      const file = { buffer, name: st.data.name, mime: st.data.mime };
      bdb.clearState(user.id);
      if (data === 'ct.rev') await review(tg, chatId, user, file);
      else await detect(tg, chatId, user, file, 0);
      return true;
    }
    if (data.startsWith('ct.ref:')) {
      const cpId = Number(data.slice(7));
      const last = mc.getLastContract(user.id);
      const cp = bdb.getCp(user.id, cpId);
      if (!cp || !last || !last.review || !last.review.ref) { await tg.sendMessage(chatId, 'Нечего вписывать.'); return true; }
      bdb.updateCp(user.id, cpId, { contract: last.review.ref.slice(0, 200) });
      await tg.sendMessage(chatId, `Вписал в карточку «${esc(cp.name)}»: <b>${esc(last.review.ref)}</b>. `
        + 'Он встанет основанием в накладные и УПД.', mainMenu());
      return true;
    }
    if (data === 'ct.addcp') {
      const last = mc.getLastContract(user.id);
      const org = bdb.currentOrg(user.id) || {};
      const p = last && last.review && (last.review.parties || []).find((x) => x.name && x.inn !== org.inn && x.name !== org.name);
      if (!p) { await tg.sendMessage(chatId, 'В договоре не нашёл вторую сторону.'); return true; }
      const id = bdb.createCp(user.id, {
        name: p.name.slice(0, 120), inn: p.inn || '', kind: 'customer',
        contract: (last.review.ref || '').slice(0, 200), opening_date: todayISO(),
      });
      const cp = bdb.getCp(user.id, id);
      await tg.sendMessage(chatId, `Завёл «${esc(cp.name)}»${p.inn ? ` (ИНН ${esc(p.inn)})` : ''}. Реквизиты банка допишите в карточке.`);
      const { info, kb } = cpMenu(user.id, cp);
      await tg.sendMessage(chatId, info, kb);
      return true;
    }
    return false;
  }

  return { menu, onFile, onPhoto, onText, onCallback, startTpl, review, reviewHtml };
};
