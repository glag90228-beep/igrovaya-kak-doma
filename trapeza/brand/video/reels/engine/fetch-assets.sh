#!/usr/bin/env bash
# Скачивает всё, что нужно рендеру рядом с index.html: GSAP, three.js, шрифты, стикеры.
# В Git это не храним: файлы большие и всегда скачиваются заново из npm с точной версией.
#
#   bash engine/fetch-assets.sh mody/out
#
# Анимированные стикеры потом режутся в спрайт-листы: engine/make-sprites.py.
set -euo pipefail
DEST=$(realpath -m "${1:?папка рендера, например mody/out}")
mkdir -p "$DEST"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

take() {  # take <пакет@версия> <путь в архиве> <имя на выходе>
  local tgz
  tgz=$(npm pack -q "$1" 2>/dev/null | tail -1)
  tar xzf "$tgz" "package/$2"
  cp "package/$2" "$DEST/$3"
  rm -rf package
}

npm pack -q gsap@3.12.5 >/dev/null
tar xzf gsap-3.12.5.tgz package/dist/gsap.min.js && cp package/dist/gsap.min.js "$DEST/" && rm -rf package

# three.js подключаем обычным <script>, без сборщика: CommonJS-сборку заворачиваем в функцию
npm pack -q three@0.170.0 >/dev/null
tar xzf three-0.170.0.tgz package/build/three.cjs
{ echo '(function(){var module={exports:{}},exports=module.exports;'; cat package/build/three.cjs; echo ';window.THREE=module.exports;})();'; } > "$DEST/three.global.js"
rm -rf package

for f in cyrillic latin latin-ext; do take @fontsource-variable/manrope@5.1.1 "files/manrope-$f-wght-normal.woff2" "manrope-$f-wght-normal.woff2"; done
for f in cyrillic latin; do for w in 400 700; do take @fontsource/jetbrains-mono@5.1.1 "files/jetbrains-mono-$f-$w-normal.woff2" "jetbrains-mono-$f-$w-normal.woff2"; done; done

# Стикеры Microsoft Fluent Emoji (лицензия MIT). Файлы в пакете названы по кодам символов.
declare -A ST=(
  [puzzle]=1f9e9 [lock]=1f512 [unlock]=1f513 [key]=1f511 [cam]=1f4f9 [shield]=1f6e1-fe0f [mag]=1f50d
  [siren]=1f6a8 [box]=1f4e6 [laptop]=1f4bb [globe]=1f310 [folder]=1f4c1 [warn]=26a0-fe0f [check]=2705
  [gear]=2699-fe0f [file]=1f4c4 [stop]=1f6d1 [plug]=1f50c [robot]=1f916 [toolbox]=1f9f0
)
npm pack -q @lobehub/fluent-emoji-3d@1.1.0 >/dev/null
for n in "${!ST[@]}"; do tar xzf lobehub-fluent-emoji-3d-1.1.0.tgz "package/assets/${ST[$n]}.webp" && cp "package/assets/${ST[$n]}.webp" "$DEST/st-$n.webp"; done
rm -rf package lobehub-fluent-emoji-3d-1.1.0.tgz

# Анимированные лежат в четырёх пакетах по ~165 МБ; качаем по одному и сразу удаляем
declare -A AN=([eye]=1f441-fe0f [eyes]=1f440 [spy]=1f575-fe0f [nosee]=1f648 [bolt]=26a1 [fire]=1f525)
mkdir -p "$DEST/anim-src"
for k in 1 2 3 4; do
  tgz=$(npm pack -q "@lobehub/fluent-emoji-anim-$k@1.0.0" 2>/dev/null | tail -1)
  for n in "${!AN[@]}"; do
    [ -f "$DEST/anim-src/$n.webp" ] && continue
    if tar xzf "$tgz" "package/assets/${AN[$n]}.webp" 2>/dev/null; then cp "package/assets/${AN[$n]}.webp" "$DEST/anim-src/$n.webp"; fi
  done
  rm -rf package "$tgz"
done
for n in "${!AN[@]}"; do [ -f "$DEST/anim-src/$n.webp" ] || echo "нет анимированного стикера: $n (${AN[$n]})" >&2; done
echo "готово: $DEST"
