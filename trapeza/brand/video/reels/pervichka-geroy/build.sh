#!/usr/bin/env bash
# Сборка ролика «Первичка — герой».
#   bash build.sh            — свой 3D-персонаж (по умолчанию)
#   положить PNG героя без фона в hero/ (hero1.png, hero2.png …) — соберётся с ним
set -euo pipefail
cd "$(dirname "$0")"
[ -f out/gsap.min.js ] || bash fetch.sh
cp ../engine/mascot3d.js out/
rm -f out/hero*.png
HERO='[]'
if ls hero/hero*.png >/dev/null 2>&1; then
  cp hero/hero*.png out/
  HERO=$(ls hero/hero*.png | sort | xargs -n1 basename | sed 's/.*/"&"/' | paste -sd, | sed 's/^/[/;s/$/]/')
fi
sed "s|__HERO__|$HERO|" template.html > out/index.html
echo "герой: $HERO"
NODE_PATH=$(npm root -g) node ../engine/check.js out/index.html
