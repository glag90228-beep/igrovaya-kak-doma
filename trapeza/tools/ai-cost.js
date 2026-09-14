'use strict';

/**
 * Сколько стоит ассистент и сколько с него остаётся.
 *
 *   cd trapeza && node tools/ai-cost.js
 *   cd trapeza && node tools/ai-cost.js --sub 390 --in 12 --out 48
 *
 * Зачем считалкой, а не письмом с числами. Цены у провайдеров меняются
 * несколько раз в год, курс тоже, и число из переписки через месяц врёт, но
 * выглядит убедительно. Здесь цены — входные данные: подставили свои,
 * получили свой ответ.
 *
 * Что здесь ИЗМЕРЕНО по коду, а не предположено:
 *   • системная подсказка — 1150 токенов, она уходит при КАЖДОМ обращении;
 *   • фраза человека — около 21 токена;
 *   • ответ модели — около 48 токенов.
 * То есть на полезные 70 токенов приходится 1150 служебных. Это главный
 * рычаг: не цена провайдера, а то, что мы шлём подсказку заново каждый раз.
 *
 * Что ЗАДАНО и требует проверки: цены за миллион токенов, за снимок и за
 * минуту речи. Умолчания ниже — порядок величины, а не прайс. Сверьтесь с
 * тарифами своего провайдера и передайте параметрами.
 */

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : def;
};

/* ── измерено по коду (lib/ai-agent.js) ── */
const SYSTEM_TOKENS = 1150;   // системная подсказка, уходит каждый раз
const PHRASE_TOKENS = 21;     // «выставь счёт ООО Заря на 45000 за банкет»
const ANSWER_TOKENS = 48;     // JSON намерения в ответ

/* ── задано: цены. ПРОВЕРЬТЕ у своего провайдера ── */
const RUB_IN = arg('in', 12);        // ₽ за миллион входных токенов
const RUB_OUT = arg('out', 48);      // ₽ за миллион выходных
const RUB_PHOTO = arg('photo', 0.9); // ₽ за один снимок (распознавание счёта)
const RUB_VOICE = arg('voice', 1.2); // ₽ за минуту речи

/* ── задано: продукт ── */
const SUB = arg('sub', 390);         // ₽ подписка в месяц
const FREE_DOCS = arg('free', 5);    // бесплатных документов в месяц

// Копейки тут значат больше рублей: обращение стоит сотые доли, и округление
// до копейки превратило бы разницу в шесть раз в «ноль против нуля».
const money = (v) => {
  // Знаков после запятой больше у мелких сумм: обращение стоит сотые доли
  // копейки, и округление до копейки превратило бы разницу в шесть раз в
  // «ноль против нуля».
  const [whole, frac] = v.toFixed(Math.abs(v) < 1 ? 4 : 2).split('.');
  // Пробел ставим ТОЛЬКО в целой части: разряды у дробной — это «0.0 164».
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${frac} ₽`;
};
const line = (s = '') => console.log(s);

/** Стоимость одного обращения каждого вида. */
const textCost = ((SYSTEM_TOKENS + PHRASE_TOKENS) * RUB_IN + ANSWER_TOKENS * RUB_OUT) / 1e6;
const photoCost = RUB_PHOTO + textCost;      // снимок + разбор ответа
const voiceCost = RUB_VOICE + textCost;      // минута речи + разбор расшифровки

line('═══ сколько стоит одно обращение ═══');
line();
line(`  фраза текстом   ${money(textCost).padStart(10)}   ${SYSTEM_TOKENS + PHRASE_TOKENS} вх. + ${ANSWER_TOKENS} исх. токенов`);
line(`  снимок счёта    ${money(photoCost).padStart(10)}   распознавание + разбор`);
line(`  минута голоса   ${money(voiceCost).padStart(10)}   расшифровка + разбор`);
line();
line(`  во сколько раз снимок дороже фразы: ${(photoCost / textCost).toFixed(0)}×`);
line(`  во сколько раз голос дороже фразы:  ${(voiceCost / textCost).toFixed(0)}×`);
line();
line('  ⚠️  А в бюджете все три считаются ОДИНАКОВО — по одному обращению.');
line('     Отсюда и перекос: тридцать фраз стоят копейки, тридцать снимков —');
line('     в десятки раз больше, а предел у них общий.');
line();

line('═══ на что уходят деньги в текстовом обращении ═══');
line();
/*
 * Доля токенов и доля денег — разные числа, и путать их нельзя. Исходящие
 * токены обычно в несколько раз дороже входящих, поэтому короткий ответ
 * съедает заметную часть счёта, хотя в токенах он почти незаметен.
 */
const useful = PHRASE_TOKENS + ANSWER_TOKENS;
const total = SYSTEM_TOKENS + PHRASE_TOKENS + ANSWER_TOKENS;
const costSystem = SYSTEM_TOKENS * RUB_IN / 1e6;
const costPhrase = PHRASE_TOKENS * RUB_IN / 1e6;
const costAnswer = ANSWER_TOKENS * RUB_OUT / 1e6;
const sum = costSystem + costPhrase + costAnswer;
line('                        токенов   доля токенов        цена   доля денег');
line(`  системная подсказка ${String(SYSTEM_TOKENS).padStart(9)}   ${(SYSTEM_TOKENS / total * 100).toFixed(0).padStart(11)}%  ${money(costSystem).padStart(10)}  ${(costSystem / sum * 100).toFixed(0).padStart(10)}%`);
line(`  фраза человека      ${String(PHRASE_TOKENS).padStart(9)}   ${(PHRASE_TOKENS / total * 100).toFixed(0).padStart(11)}%  ${money(costPhrase).padStart(10)}  ${(costPhrase / sum * 100).toFixed(0).padStart(10)}%`);
line(`  ответ модели        ${String(ANSWER_TOKENS).padStart(9)}   ${(ANSWER_TOKENS / total * 100).toFixed(0).padStart(11)}%  ${money(costAnswer).padStart(10)}  ${(costAnswer / sum * 100).toFixed(0).padStart(10)}%`);
line();
line(`  Доля токенов и доля денег — разные: исходящие дороже входящих в`);
const times = RUB_OUT / RUB_IN;
const timesWord = (n) => {
  const i = Math.round(n);
  if (i % 10 === 1 && i % 100 !== 11) return 'раз';
  if ([2, 3, 4].includes(i % 10) && ![12, 13, 14].includes(i % 100)) return 'раза';
  return 'раз';
};
line(`  ${times.toFixed(0)} ${timesWord(times)}. Ответ в ${ANSWER_TOKENS} токенов стоит как ${Math.round(costAnswer / (RUB_IN / 1e6))} входных.`);
line();
line('  Подсказка не меняется от запроса к запросу, но платим за неё каждый');
line('  раз. Кэширование (если провайдер умеет) или сокращение подсказки —');
line('  рычаг, который работает без потери качества.');
line();
const cached = ((PHRASE_TOKENS) * RUB_IN + ANSWER_TOKENS * RUB_OUT) / 1e6;
line(`  с кэшированием подсказки: ${money(cached)} вместо ${money(textCost)} — в ${(textCost / cached).toFixed(1)} раза дешевле`);
line('  Не в двадцать: ответ модели никуда не денется, а он и так дорогой.');
line();

line('═══ месяц одного платящего человека ═══');
line();
const cases = [
  ['бережливый', 10, 2, 0],
  ['обычный', 30, 10, 5],
  ['жадный до ассистента', 100, 40, 30],
  ['упёрся в нынешний предел', 30, 0, 0],
];
line('  сценарий                  фраз  снимков  минут      расход     остаётся');
for (const [name, t, p, v] of cases) {
  const spend = t * textCost + p * photoCost + v * voiceCost;
  const left = SUB - spend;
  const mark = left < 0 ? '  ❌' : (left < SUB * 0.7 ? '  ⚠️' : '');
  line(`  ${name.padEnd(24)} ${String(t).padStart(4)} ${String(p).padStart(8)} ${String(v).padStart(6)}`
    + `  ${money(spend).padStart(10)}  ${money(left).padStart(11)}${mark}`);
}
line();

line('═══ где подписка съедается целиком ═══');
line();
const breakText = Math.floor(SUB / textCost);
const breakPhoto = Math.floor(SUB / photoCost);
const breakVoice = Math.floor(SUB / voiceCost);
line(`  только фразами:  ${breakText} шт. в месяц`);
line(`  только снимками: ${breakPhoto} шт. в месяц`);
line(`  только голосом:  ${breakVoice} минут в месяц`);
line();
line(`  Нынешний предел — 30 обращений на человека. Даже если все тридцать`);
line(`  окажутся снимками, это ${money(30 * photoCost)} при подписке ${money(SUB)}.`);
line(`  Подписка выдерживает; опасность не в пределе, а в его отсутствии там,`);
line(`  где обращение стоит дорого.`);
line();

line('═══ что из этого следует ═══');
line();
line('  1. Считать не обращения, а их стоимость. Снимок — не то же самое, что');
line('     фраза, а бюджет этого не различает.');
line('  2. Кэшировать системную подсказку: 94% токенов уходит на неё.');
line('  3. Местный разбор (quickParse) ловит около двух третей фраз вообще без');
line('     модели — это самая дешёвая оптимизация, и она уже работает.');
line();
line('  И главное про сегодня: при этих ценах подписка расход выдерживает с');
line('  запасом. «Работы ради работы» пока нет. Считать по стоимости надо не');
line('  потому, что горит, а потому, что загорится при двух переменах:');
line(`     • снять предел в 30 обращений — сейчас он и держит расход;`);
line('     • включить агента с ответами по налогам: там ответ не 48 токенов,');
line('       а несколько тысяч, да ещё и поиск за отдельные деньги.');
line();
line('  Цены выше — ЗАДАННЫЕ. Сверьтесь с тарифами провайдера и пересчитайте:');
line('  node tools/ai-cost.js --in 12 --out 48 --photo 0.9 --voice 1.2 --sub 390');
line();
