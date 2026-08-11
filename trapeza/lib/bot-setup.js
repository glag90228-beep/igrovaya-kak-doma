'use strict';

/**
 * Оформление бота: имя, описания, список команд, кнопка меню.
 *
 * Всё это BotFather позволяет натыкать руками, но тогда оно живёт только
 * в его памяти: при переносе на другой токен или после чужой правки
 * восстановить нечем. Здесь оформление лежит в репозитории и
 * накатывается одной командой:
 *
 *   BOT_TOKEN=… node bot.js --setup
 *
 * Руками в BotFather остаётся только аватар (/setuserpic) — API его не ставит.
 */

// Ограничения Telegram: имя 64, короткое описание 120, описание 512.
const NAME = 'Трапеза Документы';

const SHORT = 'Счета, акты, УПД и платёжки прямо в чате. Реквизиты вводятся один раз.';

const DESCRIPTION =
  'Бот выписывает документы за минуту, без бухгалтерской программы.\n\n'
  + '• Счёт на оплату с QR — клиент платит, наведя камеру банка\n'
  + '• Акт об оказании услуг, УПД, накладная ТОРГ-12, договор\n'
  + '• Акт сверки в Excel и подсказка, кто сколько должен\n\n'
  + 'Реквизиты своей организации и контрагентов вводятся один раз. '
  + 'Номера бот ведёт сам, частые позиции запоминает.\n\n'
  + 'Нажмите «Начать».';

const COMMANDS = [
  { command: 'start', description: 'Главное меню' },
  { command: 'org', description: 'Моя организация и реквизиты' },
  { command: 'cps', description: 'Контрагенты' },
  { command: 'debts', description: 'Кто сколько должен' },
  { command: 'docs', description: 'Выписанные документы' },
  { command: 'help', description: 'Как пользоваться' },
  { command: 'support', description: 'Написать в поддержку' },
  { command: 'cancel', description: 'Отменить текущий шаг' },
];

const LIMITS = { name: 64, short: 120, description: 512, command: 32, commandDescription: 256 };

/** Проверяем до отправки: Telegram отвечает на нарушения невнятной ошибкой. */
function checkSetup() {
  const bad = [];
  if (NAME.length > LIMITS.name) bad.push(`имя длиннее ${LIMITS.name}`);
  if (SHORT.length > LIMITS.short) bad.push(`короткое описание ${SHORT.length} > ${LIMITS.short}`);
  if (DESCRIPTION.length > LIMITS.description) {
    bad.push(`описание ${DESCRIPTION.length} > ${LIMITS.description}`);
  }
  const seen = new Set();
  for (const c of COMMANDS) {
    if (!/^[a-z0-9_]{1,32}$/.test(c.command)) bad.push(`команда «${c.command}»: только a-z, 0-9 и _`);
    if (seen.has(c.command)) bad.push(`команда «${c.command}» повторяется`);
    seen.add(c.command);
    if (c.description.length > LIMITS.commandDescription) bad.push(`описание «${c.command}» слишком длинное`);
    if (!c.description) bad.push(`у «${c.command}» нет описания`);
  }
  return bad;
}

/**
 * Накатывает оформление. Ошибки по каждому пункту собираем, а не роняем всё:
 * setMyName у свежесозданного бота может отбиться ограничением частоты,
 * и это не повод не выставить команды.
 */
async function applySetup(tg, { log = console.log } = {}) {
  const problems = checkSetup();
  if (problems.length) throw new Error(`Оформление не проходит проверку:\n- ${problems.join('\n- ')}`);

  const steps = [
    ['имя', () => tg.call('setMyName', { name: NAME })],
    ['короткое описание', () => tg.call('setMyShortDescription', { short_description: SHORT })],
    ['описание', () => tg.call('setMyDescription', { description: DESCRIPTION })],
    ['команды', () => tg.call('setMyCommands', { commands: COMMANDS })],
    ['кнопка меню', () => tg.call('setChatMenuButton', { menu_button: { type: 'commands' } })],
  ];

  const failed = [];
  for (const [what, run] of steps) {
    try { await run(); log(`  ✅ ${what}`); } catch (e) {
      failed.push(`${what}: ${e.message}`);
      log(`  ⚠️ ${what} — ${e.message}`);
    }
  }
  log(failed.length
    ? `\nЧасть не применилась (${failed.length}). Обычно это ограничение частоты — повторите через минуту.`
    : '\nОформление применено. Осталось поставить аватар: @BotFather → /setuserpic.');
  return { failed };
}

module.exports = { NAME, SHORT, DESCRIPTION, COMMANDS, LIMITS, checkSetup, applySetup };
