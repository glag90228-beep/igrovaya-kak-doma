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

  console.log('\n── три службы открывают базу разом ──');
  {
    /*
     * update.sh перезапускает бота, приложение и приёмник платежей одной
     * командой, и все трое открывают базу в одну секунду. Если предыдущие
     * были убиты и оставили неприбранный WAL, SQLite восстанавливает его под
     * монопольной блокировкой — а опоздавшие получают «database is locked».
     *
     * Ловится это только так: оставить грязный WAL и открыть базу несколькими
     * процессами сразу. Защищает одна строка в db.js — busy_timeout должен
     * стоять ПЕРЕД journal_mode, потому что именно journal_mode и упирается
     * в блокировку. Верните её на прежнее (третье) место — и здесь снова
     * посыплется.
     *
     * Кругов два, и это не перестраховка. Проверка гоночная: с одним кругом
     * сломанный порядок ловился два раза из трёх, а «случайно зелёный»
     * прогон здесь хуже отсутствия проверки — он молча разрешает вернуть
     * ошибку обратно. Два круга по десять процессов промахиваются заметно
     * реже.
     */
    const { spawn, spawnSync } = require('node:child_process');
    const os = require('node:os');
    const fsx = require('node:fs');
    const pathx = require('node:path');
    const DB_MOD = JSON.stringify(pathx.join(__dirname, 'db'));
    const ROUNDS = 2;
    const WRITERS = 10;

    let dirtyOk = 0;
    let crashed = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'trapeza-wal-'));
      const dbFile = pathx.join(dir, 'race.db');

      // Грязный WAL: пишем большую пачку и убиваем себя, не завершив её.
      spawnSync(process.execPath, ['-e', `
        const { db } = require(${DB_MOD});
        db.exec('CREATE TABLE IF NOT EXISTS wal_race(x)');
        const ins = db.prepare('INSERT INTO wal_race(x) VALUES(?)');
        db.exec('BEGIN');
        for (let i = 0; i < 60000; i++) ins.run('строка ' + i);
        db.exec('COMMIT');
        db.exec('BEGIN');
        for (let i = 0; i < 60000; i++) ins.run('вторая пачка ' + i);
        process.kill(process.pid, 'SIGKILL');
      `], { env: { ...process.env, TRAPEZA_DB: dbFile }, stdio: 'ignore' });

      if (fsx.existsSync(`${dbFile}-wal`) && fsx.statSync(`${dbFile}-wal`).size > 100000) dirtyOk += 1;

      const codes = await Promise.all(Array.from({ length: WRITERS }, () => new Promise((resolve) => {
        const p = spawn(process.execPath, ['-e', `require(${DB_MOD})`],
          { env: { ...process.env, TRAPEZA_DB: dbFile }, stdio: 'ignore' });
        p.on('exit', (code) => resolve(code));
      })));
      crashed += codes.filter((c) => c !== 0).length;
      fsx.rmSync(dir, { recursive: true, force: true });
    }

    ok(dirtyOk === ROUNDS, 'неприбранный WAL остался — есть что восстанавливать',
      `${dirtyOk} из ${ROUNDS} кругов`);
    ok(crashed === 0, 'базу открыли все, никто не упал на «database is locked»',
      `упало ${crashed} из ${ROUNDS * WRITERS}`);
  }

  console.log(bad ? `\nофис: ${bad} провала` : '\nофис готов ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
