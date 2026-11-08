#!/usr/bin/env bash
# Библиотеки и шрифты берём из соседнего ролика (pervichka-geroy), недостающие стикеры докачиваем из npm (Fluent Emoji 3D, MIT).
set -euo pipefail
cd "$(dirname "$0")"; OUT=$(realpath -m out); mkdir -p "$OUT"
SRC=../pervichka-geroy/out
[ -f "$SRC/gsap.min.js" ] || bash ../pervichka-geroy/fetch.sh
cp "$SRC"/gsap.min.js "$SRC"/three.global.js "$SRC"/unbounded-*.woff2 "$SRC"/manrope-*.woff2 "$SRC"/st-*.webp "$OUT"/ 2>/dev/null || true
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; cd "$TMP"
npm pack -q @lobehub/fluent-emoji-3d@1.1.0 >/dev/null
for p in 1f697:car 1f534:redbtn 23f3:hourglass 1f648:nosee 274c:cross 1f680:rocket 1f91d:hand 1f4ac:chat 1f4c9:chartdown 1f514:bell 1f6d1:stop 1f4a5:boom; do
  tar xzf lobehub-fluent-emoji-3d-1.1.0.tgz "package/assets/${p%%:*}.webp" && cp "package/assets/${p%%:*}.webp" "$OUT/st-${p##*:}.webp"; done
echo готово
