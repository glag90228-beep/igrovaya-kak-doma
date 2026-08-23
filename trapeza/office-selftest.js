'use strict';

require('./selftest-db');
process.env.SUPPORT_CHAT_ID = '999001';

const office = require('./lib/office');
const { quickParse } = require('./lib/ai-agent');

let bad = 0;
const ok = (c, m, extra) => {
  console.log((c ? '  ✅ ' : '  ❌ ') + m + (c || extra === undefined ? '' : ' → ' + extra));
  if (!c) bad += 1;
};

(async () => {
  console.log('\n── regex, что уже работает без ИИ ──');
  const cases = [
    ['кто должен', 'debts'],
    ['кто мне должен', 'debts'],
    ['долги', 'debts'],
    ['что не оплачено', 'unpaid'],
    ['ждут оплаты', 'unpaid'],
    ['акт сверки с Зарей', 'akt'],
    ['свериться', 'akt'],
    ['документы', 'docs'],
    ['мои реквизиты', 'org'],
    ['подписка', 'billing'],
    ['сколько стоит', 'billing'],
    ['каждый месяц', 'recurring'],
    ['выставь счёт Заре', 'draft'],
    ['оформи акт для ООО Ромашка', 'draft'],
    ['когда платить взносы', 'outofscope'],
    ['помощь', 'help'],
  ];
  for (const [phrase, action] of cases) {
    const got = quickParse(phrase);
    ok(got && got.action === action, `«${phrase}» → ${action}`, got && got.action);
  }
  ok(quickParse('выставь счёт Заре').who === 'Заре', 'имя клиента из фразы');
  ok(quickParse('надо счёт Заре') == null, 'без глагола выписки regex молчит');
  ok(quickParse('привет') == null, 'мусор не разбирается');

  console.log('\n── журнал офиса ──');
  const sent = [];
  office.attach(async (chat, text) => { sent.push({ chat, text }); });

  const a = await office.record({ kind: 'unknown', where: 'bot', text: 'сделай магию', userId: 7 });
  ok(a.sent === true, 'первое неизвестное ушло в офис');
  ok(sent[0].chat === '999001', 'чат офиса = SUPPORT_CHAT_ID');
  ok(sent[0].text.includes('сделай магию'), 'фраза в письме');

  const b = await office.record({ kind: 'unknown', where: 'bot', text: 'сделай магию', userId: 8 });
  ok(b.sent === false && b.skipped === 'dup', 'та же фраза за час не спамит', b.skipped);

  /*
   * Разные фразы глушить нельзя — ради них журнал и заведён. Раньше проверка
   * повтора стояла после вставки записи и находила саму себя, поэтому любая
   * вторая фраза в течение часа считалась дублем и до офиса не доходила.
   */
  const before = sent.length;
  await office.record({ kind: 'unknown', where: 'bot', text: 'посчитай зарплату', userId: 9 });
  await office.record({ kind: 'unknown', where: 'bot', text: 'где мой счёт', userId: 10 });
  ok(sent.length === before + 2, 'разные фразы доходят до офиса', `${sent.length - before} из 2`);

  const c = await office.record({ kind: 'crash', where: 'handleUpdate', error: 'boom', userId: 7 });
  ok(c.sent === true, 'падение уходит отдельно от unknown');

  /*
   * У падения текст пуст, и старая проверка повтора («есть текст И такой же
   * текст уже был») его не ловила вовсе: одна и та же ошибка уходила в чат
   * двадцать раз в час, пока не срабатывал общий стоп-кран.
   */
  const crashBefore = sent.length;
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await office.record({ kind: 'crash', where: 'handleUpdate', error: 'boom', userId: 7 });
  }
  ok(sent.length === crashBefore, 'та же ошибка десять раз — ни одного лишнего сообщения',
    `лишних: ${sent.length - crashBefore}`);
  const other = await office.record({ kind: 'crash', where: 'handleUpdate', error: 'бах', userId: 7 });
  ok(other.sent === true, 'а другая ошибка того же вида — доходит');

  // Обработчик ошибки не должен падать сам, чем бы в него ни бросили.
  office.attach(async () => { throw null; });
  const thrown = await office.record({ kind: 'other', where: 'bot', text: 'что угодно' });
  ok(thrown.sent === false && thrown.id > 0, 'бросили не объект — record устоял', thrown.skipped);
  office.attach(async (chat, text) => { sent.push({ chat, text }); });

  const phrases = office.unknownPhrases();
  ok(phrases.some((p) => p.text === 'сделай магию' && p.n >= 2), 'повторы копятся для обучения');

  const listed = office.list('crash', 20);
  ok(listed.some((r) => r.error === 'boom'), 'ошибки читаются из журнала');
  // Заглушённые повторы всё равно ложатся в журнал: в чат они не идут, но
  // «сколько раз это упало» — как раз то, ради чего журнал читают.
  ok(listed.filter((r) => r.error === 'boom').length === 11,
    'заглушённые повторы всё равно записаны',
    String(listed.filter((r) => r.error === 'boom').length));

  console.log(bad ? `\nофис: ${bad} провала` : '\nофис готов ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
