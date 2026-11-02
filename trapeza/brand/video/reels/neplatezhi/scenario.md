# «Деньги на следующей неделе» (Первичка) — ~30 с

Формат: боль → разгадка «почему» → решение → второе решение (интрига) → оффер → призыв.
Кадры с людьми снимает Higgsfield (постановка, подпись «постановка» в углу),
экраны Первички — настоящие, записаны с работающего приложения (`tools/demo-video.js`).

## Почему эта тема сейчас (проверено 2 ноября 2026)

- Неплатежи малому бизнесу — одна из главных деловых тем года: дебиторка, жалобы
  на задержки оплаты, правительство отчитывается о возврате долгов малому бизнесу.
  Цифры в источниках расходятся (одни пишут «меньше трети», другие «около 60%»),
  поэтому **в ролике цифр нет** — только узнаваемая ситуация.
- Источники: The Moscow Times (рост неплатежей МСП), Рамблер/Финансы и
  finance.mail.ru (возврат долгов малому бизнесу в 2026), investfuture.ru
  (просрочка по платежам растёт второй квартал подряд).

## Что в ролике про продукт — и что из этого правда

| Говорим | Основание |
|---|---|
| Счёт от Первички — с QR-кодом, банк заполняет всё сам | QR по ГОСТ Р 56042 в `lib/schet.js` (нужны реквизиты с корсчётом) |
| Первичка напомнит о долге, отправишь одной кнопкой | бот готовит текст, отправляет человек — так и должно быть |
| Счёт, акт, УПД — в Телеграме | бот и мини-приложение |
| Первые пять документов бесплатно | `FREE_DOCS=5` на сервере |

Не говорим «платят в 3 раза быстрее» и подобного: замеров нет (ФЗ «О рекламе», ст. 5).

## Текст (8 фраз, ~30 с)

1. Ты сделал работу. Клиент сказал «спасибо». А деньги — *«на следующей неделе».
2. И в конце покажу, как напомнить о долге — и ~не испортить отношения.
3. Он тянет не потому, что жадный. Твой счёт просто *неудобно оплатить.
4. Чтобы заплатить по обычному счёту, надо руками перебить шесть реквизитов. Это «потом».
5. А в счёте из Первички — ~QR-код. Клиент наводит камеру банка — всё заполнилось само.
6. Пять секунд — и у него +нет повода тянуть.
7. А если всё-таки забыл — Первичка напишет вежливое напоминание. Ты только жмёшь +«Отправить».
8. Счёт, акт, УПД — прямо в Телеграме. Первые пять — бесплатно. Напиши ~«СЧЁТ» — пришлю ссылку.

## Подача (English, for AI voice)

```
[tired][knowing] Ты сделал работу. Клиент сказал «спасибо». [pause] [dry] А деньги — «на следующей неделе».
[intriguing][quietly] И в конце покажу, как напомнить о долге — и не испортить отношения.
[conspiratorial] Он тянет не потому, что жадный. [punchy] Твой счёт просто неудобно оплатить.
[explaining][slightly annoyed] Чтобы заплатить по обычному счёту, надо руками перебить шесть реквизитов. [beat] Это «потом».
[bright][confident] А в счёте из Первички — QR-код. Клиент наводит камеру банка — всё заполнилось само.
[satisfied] Пять секунд — и у него нет повода тянуть.
[warm][reassuring] А если всё-таки забыл — Первичка напишет вежливое напоминание. Ты только жмёшь «Отправить».
[friendly][upbeat] Счёт, акт, УПД — прямо в Телеграме. Первые пять — бесплатно. Напиши «СЧЁТ» — пришлю ссылку.
```

## Кадры

Генерация: 9:16, по 5 с. Один и тот же герой во всех кадрах — сначала делаем его
портрет и подаём как опорную картинку. Надписи на экранах телефонов AI рисует
криво, поэтому экраны в кадре **пустые и светящиеся**, а текст, чат, QR и
уведомления накладываем при сборке (настоящие, из приложения).

| # | Фраза | Кадр | Источник |
|---|---|---|---|
| 1 | 1 | Ночь, кухня. Девушка-дизайнер за ноутбуком смотрит в телефон, выдыхает, кладёт его экраном вниз. Поверх — сообщение клиента «Спасибо! Оплачу на следующей неделе 🙏» | Higgsfield A |
| 2 | 2 | Тизер: размытый экран телефона с кнопкой «Отправить» и знаком «?» | сборка |
| 3 | 3 | Офис. Мужчина-клиент открывает PDF-счёт на телефоне, морщится | Higgsfield B |
| 4 | 4 | Макро: палец набирает длинный номер счёта, ошибается, стирает. Поверх — 6 реквизитов (БИК, счёт, корсчёт, ИНН, получатель, назначение) складываются в стопку, штамп «ПОТОМ» | Higgsfield C + сборка |
| 5 | 5 | Рука с телефоном наводит камеру на экран ноутбука — щелчок. Поверх — настоящий счёт Первички с QR и форма банка, которая заполняется сама | Higgsfield D + экран |
| 6 | 6 | Таймер «5 сек», уведомление «Поступление 12 000 ₽ · ПРИМЕР». Утро, героиня улыбается | Higgsfield E |
| 7 | 7 | Экран Первички: напоминание должнику, палец жмёт «Отправить» | экран (demo-video) |
| 8 | 8 | Логотип, «первые 5 — бесплатно», комментарий «СЧЁТ» → ссылка в личку; кольцо в кадр 1 | сборка |

### Запросы для Higgsfield (English)

**Герой (портрет-опора):** `Portrait of a Russian woman, 29, freelance graphic designer, dark hair in a loose bun, oversized grey sweater, natural skin, no makeup look, soft window light, realistic photo, 35mm, shallow depth of field, vertical 9:16`

**A — ночь, «на следующей неделе»:** `Night, small home kitchen lit only by a laptop and a phone screen. The woman from the reference sits at the table, reads something on her phone, her face falls, she exhales slowly and places the phone face down on the table. Phone screen is blank glowing white, no text. Slow push-in, cinematic, realistic, muted teal and warm tones, vertical 9:16`

**B — клиент:** `Bright modern office, a man in his 40s in a shirt looks at his phone, scrolls, frowns at the screen, sighs and swipes the app away, puts the phone in his pocket. Phone screen blank, no readable text. Handheld medium shot, realistic, natural light, vertical 9:16`

**C — реквизиты руками:** `Extreme close-up of a thumb typing long numbers on a smartphone keypad, pauses, deletes several digits, types again, impatient. Screen glow, no readable text, shallow depth of field, realistic macro, vertical 9:16`

**D — QR:** `Over-the-shoulder shot: a hand raises a smartphone and points its camera at a laptop screen showing a document with a square code, the phone gives a short vibration, the thumb taps once confidently. Screens blank glowing, no readable text, clean office desk, realistic, vertical 9:16`

**E — оплачено:** `Morning, the same kitchen in warm sunlight. The woman from the reference picks up her buzzing phone, reads the screen, smiles with relief and leans back in her chair. Phone screen blank glowing, no text. Gentle slow camera move, realistic, cinematic, vertical 9:16`

## Сборка

HyperFrames поверх клипов: заголовки сверху, субтитры-караоке, наложения
экранов. Голос — владелец, по тексту выше. Подпись «постановка» на кадрах с людьми,
«ПРИМЕР» на суммах.
