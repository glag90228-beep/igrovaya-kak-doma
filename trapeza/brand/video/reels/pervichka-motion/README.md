# «Первичка» — моушен-ролик (Higgsedit, 1080×1920, 32,6 с)

Собран нативным движком Higgsedit в песочнице Higgsfield (`higgsedit build`), без озвучки.
Сцены: счёт за 60 секунд → голосом и готовый счёт с QR → все документы → кто должен →
основание накладной запоминается → 390 ₽ и 5 бесплатных документов → «Напиши боту СЧЁТ».

Основание каждой цифры — в `../za390/scenario.md` и в коде (`lib/qr-pay.js`, `bot.js`, лендинг).
Суммы и клиенты в кадрах помечены «ПРИМЕР». Шрифт — Montserrat 700/800: у остальных
встроенных кириллицы нет (в кадре «квадраты NO GLYPH»).

Пересборка: в песочнице Higgsfield `higgsedit fonts add pervichka Montserrat:800 Montserrat:700`,
затем `higgsedit build pervichka.jsx` и `higgsedit render pervichka --out renders/pervichka-motion.mp4`.
