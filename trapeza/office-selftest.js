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

  const c = await office.record({ kind: 'crash', where: 'handleUpdate', error: 'boom', userId: 7 });
  ok(c.sent === true, 'падение уходит отдельно от unknown');

  const phrases = office.unknownPhrases();
  ok(phrases.some((p) => p.text === 'сделай магию' && p.n >= 2), 'повторы копятся для обучения');

  const listed = office.list('crash', 5);
  ok(listed.length >= 1 && listed[0].error === 'boom', 'ошибки читаются из журнала');

  console.log(bad ? `\nофис: ${bad} провала` : '\nофис готов ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
