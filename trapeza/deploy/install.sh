#!/usr/bin/env bash
# Установка «Первичка» на чистый Ubuntu 22.04/24.04.
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
command -v rsync >/dev/null 2>&1 || apt-get install -y rsync

# --delete нужен, чтобы папка на сервере в точности совпадала с репозиторием.
# Без него удалённые и посторонние файлы остаются навсегда: именно так на
# сервере оказался чужой код, которого нет в git, и понять по папке, что
# именно работает, стало нельзя.
#
# data, node_modules и .env защищены дважды. Исключение из передачи по правилам
# rsync и так спасает файл от удаления, но цена ошибки здесь — боевая база
# с данными клиентов, поэтому то же самое сказано ещё и явным protect.
rsync -a --delete \
  --filter='protect data' --filter='protect node_modules' --filter='protect .env' \
  --exclude node_modules --exclude data --exclude .env "$SRC"/ "$APP"/
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
# Chromium для PDF.
#
# Каталог задаём явно. По умолчанию Playwright кладёт браузер в домашнюю
# папку того, кто запускал установку (обычно /root), а службы работают от
# пользователя trapeza и с ProtectHome=true туда не попадут. Браузер вроде
# бы стоит, а документы уходят клиентам в HTML — и понять это можно только
# по жалобе.
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
npm install playwright >/dev/null 2>&1 && npx playwright install --with-deps chromium || \
  echo "Playwright не встал — документы пойдут в HTML. Можно указать CHROMIUM_PATH в .env."
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

chown -R trapeza:trapeza "$APP" "$LOGS"

# Проверяем не наличие файлов, а сам рендер: только он отвечает на вопрос,
# получит ли клиент PDF.
if PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers sudo -u trapeza --preserve-env=PLAYWRIGHT_BROWSERS_PATH \
     node -e "require('./lib/pdf').htmlToPdf('<b>тест</b>').then(b=>{if(b.length<1000)throw new Error('пусто');process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})" 2>/dev/null; then
  echo "PDF работает ✅"
else
  echo "⚠️  PDF не собирается — документы пойдут в HTML. Проверьте: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node -e \"require('./lib/pdf').htmlToPdf('<b>x</b>')\""
fi

set -a; . ./.env; set +a

say "5/6 Службы"
mkdir -p /var/backups/trapeza
chown trapeza:trapeza /var/backups/trapeza
cp deploy/trapeza-bot.service deploy/trapeza-lava.service deploy/trapeza-miniapp.service \
   deploy/trapeza-backup.service deploy/trapeza-backup.timer /etc/systemd/system/
systemctl daemon-reload
# Именно restart, а не «enable --now»: у запущенной службы --now ничего не
# делает, и после обновления файлов в памяти остаётся прежний код.
systemctl enable trapeza-bot
systemctl restart trapeza-bot
if grep -q '^LAVA_WEBHOOK_SECRET=.\+' .env; then
  systemctl enable trapeza-lava
  systemctl restart trapeza-lava
else
  echo "LAVA_WEBHOOK_SECRET пуст — приёмник оплат не запускаю."
fi
# Мини-приложение полезно и до того, как задан WEBAPP_URL: без адреса оно
# просто никому не показывается, зато уже поднято и готово к https.
systemctl enable trapeza-miniapp
systemctl restart trapeza-miniapp
# Ежедневная резервная копия базы. Первую снимаем сразу: без неё до ночи
# данные клиентов существуют в единственном экземпляре.
systemctl enable --now trapeza-backup.timer
systemctl start trapeza-backup.service || echo "⚠️  Первая копия не снялась — проверьте /var/log/trapeza/backup.log"

# Оформление идёт последним и под таймером — намеренно.
#
# Имя, описание и список команд это косметика, а перезапуск служб — суть
# обновления. Когда оформление шло раньше, установка однажды встала на нём
# на пять минут (Telegram ограничивает смену имени бота и просит подождать
# часами), и до перезапуска дело не дошло: на сервере остался старый код.
# Теперь наоборот — сначала работающий бот, потом красота, и в любом
# случае не дольше двух минут на шаг.
say "6/6 Проверка токена и оформление бота"
timeout 60 sudo -u trapeza --preserve-env node bot.js --check || \
  echo "⚠️  Не достучался до Telegram — бот уже перезапущен, проверьте лог."
# Фигурные скобки обязательны: без них вторая строка — отдельная команда,
# и подсказка «повторите» печаталась бы даже после успешного оформления.
timeout 120 sudo -u trapeza --preserve-env node bot.js --setup || {
  echo "⚠️  Оформление не применилось (сеть или ограничение частоты). Повторить:"
  echo "     cd /opt/trapeza && set -a && . ./.env && set +a && node bot.js --setup"
}

say "Готово"
for u in trapeza-bot trapeza-lava trapeza-miniapp trapeza-backup.timer; do
  printf '  %-18s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || echo 'не запущена')"
done
echo ""
echo "Свежий лог бота:  tail -n 5 /var/log/trapeza/bot.log"
cat <<'TXT'

Дальше:
  • аватар — @BotFather → /setuserpic
  • HTTPS одной командой:  bash deploy/https.sh ваш-домен вашапочта@mail.ru
    после него «/» отдаёт мини-приложение, «/lava» — вебхуки оплат
  • адрес приложения впишите в WEBAPP_URL и повторите оформление:
    cd /opt/trapeza && set -a && . ./.env && set +a && node bot.js --setup
  • резервные копии:  node backup.js --list   (лежат в /var/backups/trapeza)
    восстановление:   systemctl stop trapeza-bot trapeza-miniapp
                      gunzip -c /var/backups/trapeza/ИМЯ.db.gz > /opt/trapeza/data/trapeza.db
                      chown trapeza:trapeza /opt/trapeza/data/trapeza.db
                      systemctl start trapeza-bot trapeza-miniapp
  • логи:  journalctl -u trapeza-bot -f
           tail -f /var/log/trapeza/lava.log
           tail -f /var/log/trapeza/miniapp.log
TXT
