# «Первичка — герой» (20,9 с, 1080×1920)

Ролик по образцу PGON: тёмный космос с искрами, свечение-«сцена» внизу, герой в нижней трети,
слова по одному, ключевое — зелёным, 3D-вращение телефона и карточки, счётчик денег.
Заменил первый вариант на Higgsedit (плоские плашки без героя) — тот не годился.

Сцены и времена — в `template.html` (все тексты и цифры сверены с продуктом, суммы помечены «ПРИМЕР»).

## Сборка

```bash
cd trapeza/brand/video/reels/pervichka-geroy
bash build.sh                     # скачает библиотеки (fetch.sh) и соберёт out/index.html
python3 audio.py out/audio.wav    # нужен numpy; бит и эффекты по тем же временам
cd out && npx hyperframes snapshot --at 0.5,3.9,10.4,16.8     # кадры до рендера
npx hyperframes render --quality high --fps 30 --output ../pervichka-geroy.mp4
```

## Свой герой вместо 3D-документа

Положить PNG без фона в `hero/` — `hero1.png` (основная поза), `hero2.png` … — и снова `bash build.sh`.
Промпты для Nano Banana Pro — в документе «Первичка — ролик как у PGON: разбор, герой, промпты».
