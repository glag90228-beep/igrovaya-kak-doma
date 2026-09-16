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

  console.log('\n── база ответов по налогам ──');
  {
    const kn = require('./lib/knowledge');
    const ai2 = require('./lib/ai-agent');
    const bdb2 = require('./lib/bot-db');
    const uid2 = bdb2.getOrCreateUser(556001).id;

    /*
     * Главное правило базы: ответ без нормы наружу не выходит. Ссылка на
     * статью — это и есть разница между «бот сказал» и «так написано в
     * законе», и проверять её надо не на глаз, а по всем записям сразу.
     */
    const noSource = kn.ENTRIES.filter((e) => !e.source || !e.source.law || !e.source.article);
    ok(noSource.length === 0, 'у каждой записи есть норма',
      noSource.map((e) => e.id).join(' '));
    const noYears = kn.ENTRIES.filter((e) => !Array.isArray(e.checkedFor) || !e.checkedFor.length);
    ok(noYears.length === 0, 'у каждой записи сказано, на какие годы её проверяли',
      noYears.map((e) => e.id).join(' '));
    const dupe = kn.ENTRIES.map((e) => e.id).filter((v, i, a) => a.indexOf(v) !== i);
    ok(dupe.length === 0, 'имена записей не повторяются', dupe.join(' '));

    // Год из вопроса — и в полной форме, и в разговорной.
    ok(kn.yearFrom('патент в 2027 году') === 2027, 'год четырьмя цифрами');
    ok(kn.yearFrom('расскажи про патент в 26 году') === 2026, 'год двумя цифрами');
    ok(kn.yearFrom('какой лимит на патенте') === null, 'года нет — и не выдумываем');

    // Разные вопросы одной темы ведут к разным записям.
    ok(kn.lookup('какой лимит на патенте').entry.id === 'psn-limit', 'лимит — своя запись');
    ok(kn.lookup('когда подавать заявление на патент').entry.id === 'psn-apply', 'сроки — своя');
    ok(kn.lookup('расскажи про патент').entry.id === 'psn-what', 'общий вопрос — общая запись');
    ok(kn.lookup('как приготовить борщ') === null, 'чужая тема в базу не лезет');

    // Устаревание: год вне проверенных — предупреждение, а не молчаливая ложь.
    const old = kn.lookup('патент в 2031 году');
    ok(old && old.covers === false, 'непроверенный год отмечен', String(old && old.covers));
    ok(/не скажу/.test(kn.render(old)), 'и человек об этом читает, а не догадывается');
    ok(!/не скажу/.test(kn.render(kn.lookup('патент в 2026 году'))),
      'а проверенный год лишней тревогой не пугает');

    // В каждом ответе — норма и оговорка, что это не консультация.
    for (const e of kn.ENTRIES) {
      const out = kn.render({ entry: e, year: null, covers: true });
      if (!/Основание:/.test(out) || !/не консультация/.test(out)) {
        ok(false, `ответ «${e.id}» без нормы или без оговорки`);
      }
    }
    ok(true, 'в каждом ответе базы есть норма и оговорка');

    /*
     * ── база не должна устаревать молча ──
     *
     * Она уже устарела один раз, и молча. ФЗ от 28.11.2025 № 425-ФЗ снизил
     * втрое два порога сразу — НДС на УСН и лимит патента, оба с 60 млн до
     * 20 млн, — а записи продолжали уверенно называть 60 и были помечены
     * «проверено на 2026». То есть сработала ровно та беда, от которой вся
     * эта база и строилась: уверенный ответ с неверным числом и ссылкой на
     * настоящую статью. Такому верят охотнее всего.
     *
     * Здесь не проверка чисел — их знает только источник. Здесь проверка
     * того, что записи не переживут год незаметно.
     */
    const thisYear = new Date().getFullYear();
    const stale = kn.ENTRIES.filter((e) => !e.checkedFor.includes(thisYear));
    ok(stale.length === 0,
      `все записи проверены на ${thisYear} год`,
      stale.length ? `устарели: ${stale.map((e) => e.id).join(', ')}` : '');

    /*
     * Число, которое меняется законом, должно приходить с годом рядом.
     * «Лимит 20 млн» без года — это будущая ошибка: через год он другой, а
     * запись выглядит вечной.
     */
    const suspicious = kn.ENTRIES.filter((e) => /\d+\s*млн/.test(e.answer)
      && !/(20\d{2})\s*год|с\s+1\s+января\s+20\d{2}/.test(e.answer));
    ok(suspicious.length === 0,
      'у каждой суммы в миллионах назван год, к которому она относится',
      suspicious.map((e) => e.id).join(', '));

    /*
     * Ответ не из базы размечается ИНАЧЕ — в этом вся его безопасность.
     * Человек должен видеть с первой строки, проверяли мы это или нет.
     */
    const ext = kn.renderExternal('Ставка такая-то.', 'модель X');
    ok(/нет в моей проверенной базе/.test(ext) || /проверенной базе нет/.test(ext),
      'ответ не из базы прямо помечен', ext.slice(0, 60));
    ok(/модель X/.test(ext), 'и названо, чем отвечали');
    ok(kn.renderExternal(kn.OFFTOPIC, 'модель X') === null,
      'модель сказала «не по теме» — наружу ничего не идёт');
    ok(kn.renderExternal('   ', 'модель X') === null, 'пустой ответ наружу не идёт');

    /*
     * Тумблер. Пока записи не сверены с официальным источником, отвечать
     * моделью на налоговые вопросы нельзя — поэтому по умолчанию выключено.
     */
    const wasTax = process.env.AI_TAX_ANSWERS;
    const wasEn = process.env.AI_ENABLED;
    const wasPr = process.env.AI_PROVIDER;
    delete process.env.AI_TAX_ANSWERS;
    process.env.AI_ENABLED = '1';
    process.env.AI_PROVIDER = 'mock';
    process.env.AI_MOCK = 'Какой-то ответ про НДФЛ.';
    ok(ai2.taxAnswersOn() === false, 'по умолчанию ответы моделью выключены');
    const off = await ai2.answerTax('когда сдавать 6-НДФЛ', uid2);
    ok(off.text === null && off.from === 'off',
      'выключено — модель не спрашивается вовсе', off.from);

    // База отвечает и при выключенном тумблере: её записи мы писали сами.
    const fromBase = await ai2.answerTax('какой лимит на патенте', uid2);
    ok(fromBase.from === 'base' && /Основание/.test(fromBase.text),
      'база отвечает независимо от тумблера', fromBase.from);

    process.env.AI_TAX_ANSWERS = '1';
    const viaModel = await ai2.answerTax('когда сдавать 6-НДФЛ', uid2);
    ok(viaModel.from === 'model' && /проверенной базе нет/.test(viaModel.text),
      'включено — отвечает моделью и честно помечает', viaModel.from);

    if (wasTax === undefined) delete process.env.AI_TAX_ANSWERS; else process.env.AI_TAX_ANSWERS = wasTax;
    if (wasEn === undefined) delete process.env.AI_ENABLED; else process.env.AI_ENABLED = wasEn;
    if (wasPr === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = wasPr;
  }

  console.log('\n── поиск по доверенным источникам ──');
  {
    const se = require('./lib/search');
    const kn2 = require('./lib/knowledge');
    const ai3 = require('./lib/ai-agent');
    const bdb3 = require('./lib/bot-db');
    const uid3 = bdb3.getOrCreateUser(558001).id;

    /*
     * Белый список — главная защита этого модуля, и проверять его надо не
     * на «работает ли», а на подделки. По налоговому вопросу выдачу
     * занимают бухгалтерские блоги: пишут бойко, часто верно и почти всегда
     * без даты. Сослаться на такой хуже, чем не ответить.
     */
    ok(Boolean(se.trustedSource('https://www.nalog.gov.ru/rn77/x')), 'ФНС — свой');
    ok(Boolean(se.trustedSource('https://lk.nalog.gov.ru/a')), 'и его поддомен тоже');
    ok(se.trustedSource('https://buhblog.example/nalog.gov.ru') === null,
      'доверенный домен в ПУТИ чужой ссылки не считается');
    ok(se.trustedSource('https://nalog.gov.ru.evil.example/x') === null,
      'и приклеенный слева к чужому домену — тоже');
    ok(se.trustedSource('https://evil.example/?src=nalog.gov.ru') === null,
      'и спрятанный в параметрах');
    ok(se.trustedSource('не ссылка') === null, 'мусор вместо ссылки не ломает разбор');

    // Выдача Яндекса приходит XML — разбираем её сами, без зависимостей.
    const xml = '<doc><url>https://nalog.gov.ru/a</url><title>Заголовок</title>'
      + '<passage>Первый кусок.</passage><passage>Второй.</passage></doc>'
      + '<doc><url>https://pravo.gov.ru/b</url><headline>Только заголовок</headline></doc>';
    const parsed = se.parseYandexXml(xml);
    ok(parsed.length === 2, 'обе находки разобраны', String(parsed.length));
    ok(parsed[0].snippet.includes('Первый') && parsed[0].snippet.includes('Второй'),
      'куски текста склеены', parsed[0].snippet);
    ok(parsed[1].snippet.includes('Только заголовок'),
      'нет кусков — берём заголовок', parsed[1].snippet);

    // Фильтр выдачи целиком.
    const wasSp = process.env.SEARCH_PROVIDER;
    const wasSm = process.env.SEARCH_MOCK;
    process.env.SEARCH_PROVIDER = 'mock';
    process.env.SEARCH_MOCK = JSON.stringify([
      { url: 'https://buhblog.example/a', title: 'Блог', snippet: 'Сдавайте когда хотите' },
      { url: 'https://www.nalog.gov.ru/x', title: 'ФНС', snippet: 'Не позднее 25-го числа.' },
    ]);
    const res = await se.search('когда сдавать');
    ok(res.ok && res.results.length === 1, 'чужой сайт из выдачи выброшен',
      res.ok ? String(res.results.length) : res.error);
    ok(res.results[0].source === 'ФНС России', 'источник назван по-человечески',
      res.results[0].source);

    process.env.SEARCH_MOCK = JSON.stringify([
      { url: 'https://buhblog.example/a', title: 'Блог', snippet: 'что-то' },
    ]);
    const none = await se.search('когда сдавать');
    ok(none.ok === false, 'одни чужие сайты — считаем, что не нашли', String(none.ok));

    /*
     * Пересказ найденного. Главное правило — не добавлять от себя: именно
     * так рождается ответ, где ссылка настоящая, а утверждение нет. Такому
     * верят охотнее всего.
     */
    ok(/ТОЛЬКО тем, что есть/.test(kn2.SEARCH_SYSTEM),
      'подсказке для пересказа запрещено выдумывать сверх источника');
    ok(kn2.renderFound(kn2.NOT_FOUND, []) === null,
      'модель не нашла ответа в отрывках — наружу ничего не идёт');
    const fnd = kn2.renderFound('Не позднее 25-го.', [
      { source: 'ФНС России', url: 'https://www.nalog.gov.ru/x' },
    ]);
    ok(/https:\/\/www\.nalog\.gov\.ru\/x/.test(fnd), 'в ответе стоит адрес страницы',
      String(fnd).slice(-140));
    ok(/не сверяли/.test(fnd), 'и сказано, что это не наша проверенная запись');

    // Лестница целиком: база → поиск → память модели.
    const keep3 = {};
    for (const k of ['AI_TAX_ANSWERS', 'AI_ENABLED', 'AI_PROVIDER', 'AI_MOCK']) keep3[k] = process.env[k];
    process.env.AI_TAX_ANSWERS = '1';
    process.env.AI_ENABLED = '1';
    process.env.AI_PROVIDER = 'mock';

    process.env.SEARCH_MOCK = JSON.stringify([
      { url: 'https://www.nalog.gov.ru/x', title: 'ФНС', snippet: 'Не позднее 25-го числа.' },
    ]);
    process.env.AI_MOCK = 'Не позднее 25-го числа месяца после отчётного периода.';
    const viaSearch = await ai3.answerTax('когда сдавать 6-НДФЛ', uid3);
    ok(viaSearch.from === 'search', 'чего нет в базе — ищем на официальных сайтах', viaSearch.from);
    ok(/nalog\.gov\.ru/.test(viaSearch.text), 'и в ответе виден сайт, а не «модель»');

    // База всё равно первая: её записи мы писали и сверяли сами.
    const viaBase = await ai3.answerTax('какой лимит на патенте', uid3);
    ok(viaBase.from === 'base', 'что есть в базе — берём из базы, а не из интернета', viaBase.from);

    // Поиск ничего не дал — остаётся память модели, и она помечена иначе.
    process.env.SEARCH_MOCK = JSON.stringify([
      { url: 'https://buhblog.example/a', title: 'Блог', snippet: 'выдумки' },
    ]);
    process.env.AI_MOCK = 'По памяти: ежеквартально.';
    const viaModel2 = await ai3.answerTax('когда сдавать 6-НДФЛ', uid3);
    ok(viaModel2.from === 'model', 'ничего не нашли — отвечаем памятью', viaModel2.from);
    ok(/проверенной базе нет/.test(viaModel2.text) && !/nalog\.gov\.ru/.test(viaModel2.text),
      'и пометка другая: сайта тут нет');

    for (const [k, v] of Object.entries(keep3)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (wasSp === undefined) delete process.env.SEARCH_PROVIDER; else process.env.SEARCH_PROVIDER = wasSp;
    if (wasSm === undefined) delete process.env.SEARCH_MOCK; else process.env.SEARCH_MOCK = wasSm;
  }

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
