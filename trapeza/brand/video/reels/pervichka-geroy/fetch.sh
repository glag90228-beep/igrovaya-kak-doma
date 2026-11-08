#!/usr/bin/env bash
# Скачивает в out/ только то, что нужно этому ролику: GSAP, three.js, шрифты и несколько стикеров.
# (Общий engine/fetch-assets.sh тянет ещё ~660 МБ анимированных стикеров — здесь они не нужны.)
set -euo pipefail
cd "$(dirname "$0")"; OUT=$(realpath -m out); mkdir -p "$OUT"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; cd "$TMP"
take() { local tgz; tgz=$(npm pack -q "$1" 2>/dev/null | tail -1); tar xzf "$tgz" "package/$2"; cp "package/$2" "$OUT/$3"; rm -rf package; }
take gsap@3.12.5 dist/gsap.min.js gsap.min.js
npm pack -q three@0.170.0 >/dev/null; tar xzf three-0.170.0.tgz package/build/three.cjs
{ echo '(function(){var module={exports:{}},exports=module.exports;'; cat package/build/three.cjs; echo ';window.THREE=module.exports;})();'; } > "$OUT/three.global.js"; rm -rf package
for f in cyrillic latin; do take @fontsource-variable/unbounded@5.2.5 "files/unbounded-$f-wght-normal.woff2" "unbounded-$f-wght-normal.woff2"; done
for f in cyrillic latin; do take @fontsource-variable/manrope@5.1.1 "files/manrope-$f-wght-normal.woff2" "manrope-$f-wght-normal.woff2"; done
npm pack -q @lobehub/fluent-emoji-3d@1.1.0 >/dev/null
for p in 1fa99:coin 1f9fe:receipt 1f4f1:phone 2705:check 1f4b8:money 1f399-fe0f:mic 1f4c4:file 1f648:nosee; do
  tar xzf lobehub-fluent-emoji-3d-1.1.0.tgz "package/assets/${p%%:*}.webp" && cp "package/assets/${p%%:*}.webp" "$OUT/st-${p##*:}.webp"; done
echo готово
