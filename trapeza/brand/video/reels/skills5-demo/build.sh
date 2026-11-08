#!/usr/bin/env bash
# Сборка «5 скиллов» — демо. Нужны: ../pervichka-geroy/out (библиотеки, шрифты) и hero/ оттуда же.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p out
[ -f out/jbm-latin-400.woff2 ] || bash fetch.sh
cp ../pervichka-geroy/hero/hero*.png out/
python3 build.py
NODE_PATH=$(npm root -g) node ../engine/check.js out/index.html
