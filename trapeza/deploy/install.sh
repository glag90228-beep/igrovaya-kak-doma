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

say "2/6 Подкачка (Chromium для PDF любит память)"
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 4000 ] && [ "$(swapon --show | wc -l)" -eq 0 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Добавлено 2 ГБ подкачки."
else
  echo "Памяти хватает или подкачка уже есть."
fi

say "2b/6 Пользователь и папки"
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

# Дописываем переменные, появившиеся в шаблоне после создания .env
# (например DADATA_TOKEN добавили позже) — иначе их правка ничего не находит.
added=0
while IFS= read -r line; do
  case "$line" in ''|\#*) continue;; esac
  key="${line%%=*}"
  if ! grep -q "^${key}=" .env; then echo "$line" >> .env; added=$((added+1)); fi
done < .env.example
[ "$added" -gt 0 ] && echo "В .env добавлено новых настроек: $added (заполните при необходимости)."

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
cp deploy/trapeza-bot.service deploy/trapeza-lava.service deploy/trapeza-miniapp.service \
   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now trapeza-bot
if grep -q '^LAVA_WEBHOOK_SECRET=.\+' .env; then
  systemctl enable --now trapeza-lava
  systemctl restart trapeza-lava
else
  echo "LAVA_WEBHOOK_SECRET пуст — приёмник оплат не запускаю."
fi
# Мини-приложение полезно и до того, как задан WEBAPP_URL: без адреса оно
# просто никому не показывается, зато уже поднято и готово к https.
systemctl enable --now trapeza-miniapp
systemctl restart trapeza-miniapp

say "Готово"
systemctl --no-pager --lines=5 status trapeza-bot || true
cat <<'TXT'

Дальше:
  • аватар — @BotFather → /setuserpic
  • HTTPS одной командой:  bash deploy/https.sh ваш-домен вашапочта@mail.ru
    после него «/» отдаёт мини-приложение, «/lava» — вебхуки оплат
  • адрес приложения впишите в WEBAPP_URL и повторите  node bot.js --setup
  • логи:  journalctl -u trapeza-bot -f
           tail -f /var/log/trapeza/lava.log
           tail -f /var/log/trapeza/miniapp.log
TXT
