#!/usr/bin/env bash
# Шрифт кода (JetBrains Mono) и стикер-щит докачиваем из npm; остальное — из соседнего ролика pervichka-geroy.
set -euo pipefail
cd "$(dirname "$0")"; OUT=$(realpath -m out); mkdir -p "$OUT"
SRC=../pervichka-geroy/out
[ -f "$SRC/gsap.min.js" ] || bash ../pervichka-geroy/fetch.sh
cp "$SRC"/gsap.min.js "$SRC"/unbounded-*.woff2 "$SRC"/manrope-*.woff2 "$SRC"/st-check.webp "$SRC"/st-coin.webp "$OUT"/
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; cd "$TMP"
take() { local tgz; tgz=$(npm pack -q "$1" 2>/dev/null | tail -1); tar xzf "$tgz" "package/$2"; cp "package/$2" "$OUT/$3"; rm -rf package; }
for w in 400 700; do for f in cyrillic latin; do take @fontsource/jetbrains-mono@5.1.1 "files/jetbrains-mono-$f-$w-normal.woff2" "jbm-$f-$w.woff2"; done; done
npm pack -q @lobehub/fluent-emoji-3d@1.1.0 >/dev/null
for p in 1f6e1-fe0f:shield 1f50d:mag 1f501:loop 1f9f9:broom 1f680:rocket; do tar xzf lobehub-fluent-emoji-3d-1.1.0.tgz "package/assets/${p%%:*}.webp" && cp "package/assets/${p%%:*}.webp" "$OUT/st-${p##*:}.webp"; done
echo готово
