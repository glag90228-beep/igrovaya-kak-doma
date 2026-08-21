'use strict';

/**
 * План работ в Excel — тот, по которому идёт разработка.
 *
 *   cd trapeza && node tools/planner.js             → selftest-out/План.xlsx
 *   cd trapeza && node tools/planner.js /путь.xlsx  → куда скажете
 *
 * Зачем файлом, а не списком в переписке. Список в чате живёт до следующего
 * сообщения: в нём не отметить сделанное, не отсортировать по блоку, не
 * показать подрядчику. Здесь же обычная таблица — со фильтром, выпадающим
 * статусом и итогом часов, — её можно вести самому и открыть на телефоне.
 *
 * План собирается кодом, а не рисуется руками, по той же причине, по которой
 * так сделаны акт сверки и реестр: файл пересобирается одной командой, и
 * спорить о том, какая версия свежая, не приходится. Правьте таблицу здесь
 * и пересоберите — либо ведите статусы прямо в Excel, файл в git не попадает
 * (selftest-out/ в .gitignore).
 *
 * Состояние в столбце «Статус» — на день сборки. «Готово» стоит только у
 * того, что действительно лежит в коде и покрыто прогоном.
 */

const path = require('node:path');
const fs = require('node:fs');
const ExcelJS = require('exceljs');

const BLUE = 'FF2E3A8C';
const CREAM = 'FFF4F6FC';
const SAND = 'FFE3E8F8';
const WARN = 'FFFDF3D8';

const OUT = process.argv[2]
  || path.join(__dirname, '..', 'selftest-out', 'План.xlsx');

/* ─────────────────────────── содержание ─────────────────────────── */

/**
 * Задачи. Поля: блок, задача, зачем, агент, файлы, часы, зависит, статус.
 *
 * «Зачем» — не украшение. Задача без причины первой же уходит в долгий
 * ящик, и через месяц никто не помнит, зачем её заводили.
 */
const TASKS = [
  // ── Голос ──
  ['Голос', 'Разведка: контракт SpeechKit и поля Telegram',
    'Писать код по выдуманному контракту API — переделывать дважды',
    'researcher', '—', 3, '', 'В работе'],
  ['Голос', 'lib/speech.js — распознавание речи',
    'Голосовое сообщение самый быстрый ввод, когда руки заняты',
    'coder', 'lib/speech.js', 6, 'Разведка', 'Ждёт'],
  ['Голос', 'Учёт минут и лимиты',
    'Речь дороже текста; без предела один человек съест месячный бюджет',
    'coder', 'lib/speech.js', 3, 'lib/speech.js', 'Ждёт'],
  ['Голос', 'Ветка msg.voice в боте',
    'Скачать → распознать → understand() → тот же мастер, что и для текста',
    'coder', 'bot.js', 4, 'lib/speech.js', 'Ждёт'],
  ['Голос', 'Показать распознанное до действия',
    'Человек должен увидеть, что бот услышал, прежде чем тот заполнит счёт',
    'coder', 'bot.js', 2, 'Ветка msg.voice', 'Ждёт'],
  ['Голос', 'Прогон с провайдером mock',
    'Тишина, длинная запись, отказ сервиса, чужой язык — всё без сети и денег',
    'tester', 'bot-selftest.js', 4, 'Ветка msg.voice', 'Ждёт'],
  ['Голос', 'Красная команда по голосу',
    'Инъекция голосом, чужой file_id, файл на 20 МБ, оборванная загрузка',
    'security-auditor', 'redteam-selftest.js', 3, 'Ветка msg.voice', 'Ждёт'],
  ['Голос', 'README и .env.example',
    'Новые переменные без описания — это чужой сервер, который никто не поднимет',
    'coder', 'README.md, .env.example', 2, 'lib/speech.js', 'Ждёт'],

  // ── Агент в приложении ──
  ['Агент в приложении', 'POST /api/ask — свободный ввод',
    'Сейчас understand() зовут только из бота: в приложении агента нет вовсе',
    'backend-dev', 'miniapp.js', 4, '', 'Ждёт'],
  ['Агент в приложении', 'Экран «Спросить»',
    'Строка ввода и ответ намерением: то же, что в боте, но не выходя из окна',
    'mobile-dev', 'public/app/app.js', 5, 'POST /api/ask', 'Ждёт'],
  ['Агент в приложении', 'Запись голоса в приложении',
    'MediaRecorder отдаёт webm/opus; ехать он должен в тот же lib/speech.js',
    'mobile-dev', 'public/app/app.js, miniapp.js', 6, 'lib/speech.js, Экран «Спросить»', 'Ждёт'],
  ['Агент в приложении', 'Прогоны: HTTP и браузерный',
    'Экран без прогона живёт до первой правки соседнего экрана',
    'tester', 'miniapp-selftest.js, app-selftest.js', 4, 'Экран «Спросить»', 'Ждёт'],

  // ── Фото ──
  ['Фото', 'Разбор фото без предварительной команды',
    'Сейчас фото понимают только внутри сценариев; присланное «просто так» пропадает',
    'coder', 'bot.js', 3, '', 'Ждёт'],
  ['Фото', 'Фото из приложения тем же путём',
    'Два разных пути к одному распознаванию разойдутся на первой же правке',
    'mobile-dev', 'miniapp.js, public/app/app.js', 4, 'Разбор фото без команды', 'Ждёт'],
  ['Фото', 'Прогон обоих путей',
    'Провайдер mock уже есть в lib/vision.js — сеть и деньги не нужны',
    'tester', 'bot-selftest.js, miniapp-selftest.js', 3, 'Фото из приложения', 'Ждёт'],

  // ── Видео ──
  ['Видео', 'Решение: ставить ли ffmpeg на сервер',
    'Без него из видео не достать ни звук, ни кадры. Это плюс сервисный пакет на сервере',
    'владелец', '—', 0, '', 'Решение'],
  ['Видео', 'video_note → звук → распознавание',
    'Кружочек это почти всегда голос: разбираем как голосовое',
    'coder', 'lib/media.js, bot.js', 6, 'Решение по ffmpeg, lib/speech.js', 'Заморожено'],
  ['Видео', 'video → кадры → зрение',
    'Счёт, снятый видео вместо фото: берём 1–3 кадра и отдаём в lib/vision.js',
    'coder', 'lib/media.js, bot.js', 6, 'Решение по ffmpeg', 'Заморожено'],
  ['Видео', 'Отказ на большой файл',
    'Telegram отдаёт боту не всё; молчание вместо ответа человек считает поломкой',
    'coder', 'bot.js', 2, 'video_note → звук', 'Заморожено'],
  ['Видео', 'Прогоны по видео',
    'Короткий ролик в репозитории держать нельзя — собираем его в прогоне',
    'tester', 'bot-selftest.js', 4, 'video → кадры', 'Заморожено'],

  // ── Деньги и надёжность ──
  ['Деньги', 'Единый бюджет на распознавание',
    'Три счётчика в трёх модулях разойдутся; предел должен быть один на всё',
    'system-architect', 'lib/ai-agent.js, lib/speech.js, lib/vision.js', 5, 'lib/speech.js', 'Ждёт'],
  ['Деньги', 'Показать расход владельцу',
    'Платит владелец бота, а видит расход сейчас только он же в базе',
    'coder', 'bot.js, miniapp.js', 3, 'Единый бюджет', 'Ждёт'],
  ['Проверка', 'Обзор всего контура распознавания',
    'Три входа в одну модель — место, где легче всего потерять деньги и данные',
    'reviewer', '—', 4, 'Все блоки', 'Ждёт'],
];

/** Вопросы, на которые отвечает владелец: без них часть плана не двигается. */
const DECISIONS = [
  ['Чем распознавать речь',
    'Yandex SpeechKit — рекомендую',
    'Ключ YANDEX_API_KEY и папка уже нужны для распознавания фото, второй '
    + 'сервис заводить не придётся. Сервер стоит в России, и оплата рублями.'],
  ['Ставить ли ffmpeg на сервер',
    'Пока нет',
    'Без ffmpeg видео не разобрать вовсе. Но голос закрывает почти тот же '
    + 'случай и обходится без него — предлагаю сначала голос, видео потом.'],
  ['Предел расхода в месяц',
    'Назвать сумму',
    'Сейчас предел стоит в обращениях (1000 в месяц на всех, 30 на человека). '
    + 'Речь считается минутами, и её надо ограничить отдельно.'],
  ['Голос в мини-приложении',
    'Нужен или хватит бота',
    'В боте голосовое отправляется одной кнопкой и уже привычно. В приложении '
    + 'это отдельная работа с записью звука в браузере.'],
];

/** Что уже работает — чтобы план читался от точки, а не с чистого листа. */
const DONE = [
  ['Фото счёта → операция', 'lib/vision.js', 'провайдеры anthropic / yandex / mock'],
  ['Свободный ввод текстом в боте', 'lib/ai-agent.js', 'understand() → намерение'],
  ['Бесплатный разбор регулярками', 'lib/ai-agent.js', 'к модели идём, только если не справились сами'],
  ['Пределы расхода на модель', 'lib/ai-agent.js', 'AI_MONTHLY_LIMIT и AI_USER_LIMIT'],
  ['Проверка ответа модели', 'lib/ai-agent.js', 'sanitize(): чужие действия и суммы не проходят'],
  ['Скачивание файлов из Telegram', 'lib/tg.js', 'downloadFile() с потолком по размеру'],
  ['Документ сам не выписывается', 'bot.js', 'агент только открывает мастер, кнопку жмёт человек'],
];

/* ─────────────────────────── оформление ─────────────────────────── */

function box(cell) {
  cell.border = {
    top: { style: 'thin', color: { argb: 'FFC3C9DC' } },
    left: { style: 'thin', color: { argb: 'FFC3C9DC' } },
    bottom: { style: 'thin', color: { argb: 'FFC3C9DC' } },
    right: { style: 'thin', color: { argb: 'FFC3C9DC' } },
  };
}

function header(sheet, titles, widths) {
  sheet.columns = titles.map((t, i) => ({ header: t, width: widths[i] }));
  const row = sheet.getRow(1);
  row.height = 26;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    box(cell);
  });
}

function planSheet(wb) {
  const s = wb.addWorksheet('План', { views: [{ state: 'frozen', ySplit: 1 }] });
  header(s,
    ['№', 'Блок', 'Задача', 'Зачем', 'Агент', 'Файлы', 'Часы', 'Зависит от', 'Статус'],
    [5, 20, 42, 52, 18, 34, 8, 30, 14]);

  TASKS.forEach((t, i) => {
    const r = s.addRow([i + 1, t[0], t[1], t[2], t[3], t[4], t[5] || null, t[6], t[7]]);
    r.alignment = { vertical: 'top', wrapText: true };
    if (i % 2) r.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } }; });
    // Замороженное и требующее решения помечаем цветом: в длинной таблице
    // такие строки иначе теряются и всплывают, когда уже поздно.
    if (t[7] === 'Заморожено' || t[7] === 'Решение') {
      r.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARN } };
    }
    r.eachCell(box);
    r.getCell(7).numFmt = '0';
    // Выпадающий список: план ведут в самом файле, а не пересобирают ради
    // одной галочки.
    r.getCell(9).dataValidation = {
      type: 'list', allowBlank: false,
      formulae: ['"Ждёт,В работе,Готово,Заморожено,Решение,Отменено"'],
    };
  });

  const last = s.rowCount;
  const total = s.addRow(['', '', 'Итого', '', '', '', { formula: `SUM(G2:G${last})` }, '', '']);
  total.font = { bold: true };
  total.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
    box(c);
  });
  s.autoFilter = { from: 'A1', to: `I${last}` };
  return s;
}

function decisionsSheet(wb) {
  const s = wb.addWorksheet('Решения', { views: [{ state: 'frozen', ySplit: 1 }] });
  header(s, ['Вопрос', 'Предложение', 'Почему так', 'Ваш ответ'], [34, 26, 62, 22]);
  for (const d of DECISIONS) {
    const r = s.addRow([d[0], d[1], d[2], '']);
    r.alignment = { vertical: 'top', wrapText: true };
    r.eachCell(box);
    r.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARN } };
  }
  return s;
}

function doneSheet(wb) {
  const s = wb.addWorksheet('Уже работает', { views: [{ state: 'frozen', ySplit: 1 }] });
  header(s, ['Что', 'Где', 'Подробности'], [40, 26, 60]);
  for (const d of DONE) {
    const r = s.addRow(d);
    r.alignment = { vertical: 'top', wrapText: true };
    r.eachCell(box);
  }
  return s;
}

async function build(out) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Первичка';
  wb.created = new Date();
  planSheet(wb);
  decisionsSheet(wb);
  doneSheet(wb);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await wb.xlsx.writeFile(out);
  return out;
}

if (require.main === module) {
  build(OUT).then((f) => {
    const hours = TASKS.reduce((s, t) => s + (t[5] || 0), 0);
    const open = TASKS.filter((t) => t[7] === 'Ждёт').length;
    console.log(`План собран: ${f}`);
    console.log(`Задач: ${TASKS.length}, из них ждут работы ${open}. Часов: ${hours}.`);
    console.log(`Вопросов владельцу: ${DECISIONS.length} — лист «Решения».`);
  }).catch((e) => { console.error('Не собрался:', e.message); process.exit(1); });
}

module.exports = { build, TASKS, DECISIONS, DONE };
