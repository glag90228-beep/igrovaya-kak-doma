#!/usr/bin/env bash
# Сборка ролика «Первичка — демо». Нужны: ../pervichka-geroy/out (библиотеки, шрифты), hero/ оттуда же, shots/ из ../pervichka-reklama.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p out
[ -f ../pervichka-geroy/out/gsap.min.js ] || bash ../pervichka-geroy/fetch.sh
cp ../pervichka-geroy/out/{gsap.min.js,unbounded-*.woff2,manrope-*.woff2,st-*.webp} out/
cp ../pervichka-geroy/hero/hero*.png out/
cp ../pervichka-reklama/shots/*.png out/
cp ../za390/qr.svg out/
python3 build.py
NODE_PATH=$(npm root -g) node ../engine/check.js out/index.html
