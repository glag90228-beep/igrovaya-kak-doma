#!/usr/bin/env bash
# Установка «Трапеза Документы» на чистый Ubuntu 22.04/24.04.
# Запускать от root:  bash deploy/install.sh
set -euo pipefail

APP=/opt/trapeza
LOGS=/var/log/trapeza
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/6 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "2/6 Пользователь и папки"
id -u trapeza >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin trapeza
mkdir -p "$APP" "$APP/data" "$LOGS"

say "3/6 Файлы"
# data не трогаем: там боевая база
rsync -a --exclude node_modules --exclude data --exclude .env "$SRC"/ "$APP"/
cd "$APP"

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  say "СОЗДАН $APP/.env — заполните BOT_TOKEN и остальное, потом запустите скрипт снова."
  exit 0
fi
chmod 600 .env

say "4/6 Зависимости"
npm install --omit=dev
# Chromium для PDF: если не ставится, бот будет слать HTML — не критично
npm install playwright >/dev/null 2>&1 && npx playwright install --with-deps chromium || \
  echo "Playwright не встал — документы пойдут в HTML. Можно указать CHROMIUM_PATH в .env."

chown -R trapeza:trapeza "$APP" "$LOGS"

say "5/6 Проверка токена и оформление бота"
set -a; . ./.env; set +a
sudo -u trapeza --preserve-env node bot.js --check
sudo -u trapeza --preserve-env node bot.js --setup

say "6/6 Службы"
cp deploy/trapeza-bot.service deploy/trapeza-lava.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now trapeza-bot
if grep -q '^LAVA_WEBHOOK_SECRET=.\+' .env; then
  systemctl enable --now trapeza-lava
else
  echo "LAVA_WEBHOOK_SECRET пуст — приёмник оплат не запускаю."
fi

say "Готово"
systemctl --no-pager --lines=5 status trapeza-bot || true
cat <<'TXT'

Дальше:
  • аватар — @BotFather → /setuserpic
  • приёмник оплат наружу только по HTTPS: nginx на /lava → 127.0.0.1:8788
  • логи:  journalctl -u trapeza-bot -f   и   tail -f /var/log/trapeza/lava.log
TXT
