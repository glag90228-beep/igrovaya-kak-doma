#!/usr/bin/env bash
#
# Свести конфиги nginx в один и вернуть лендинг на сайт.
#
#   bash /opt/trapeza/deploy/nginx-merge.sh
#
# Зачем. На сервере оказалось два конфига на один домен: pervichkaru.ru
# (только 80-й порт) и trapeza-lava (сертификат и весь боевой трафик). Nginx
# в такой ситуации один из них молча игнорирует — о чём и предупреждал:
# «conflicting server name … ignored». Отсюда две беды сразу.
#
# Первая: правки уходили в мёртвый файл. Маршрут оплаты дописывался в тот
# конфиг, который слушает 80-й порт, а площадка ходит по HTTPS — то есть в
# другой блок. Проверка «путь открыт» отвечала про 80-й порт и вводила в
# заблуждение.
#
# Вторая, заметная людям: в живом конфиге стояло «location / → мини-
# приложение», и по адресу сайта посетитель видел экран приложения вместо
# рекламной страницы. Лендинг лежал на диске и никому не показывался.
#
# Что делает скрипт. Собирает один конфиг со всеми маршрутами обоих, гасит
# лишние, проверяет и — если nginx не принял — возвращает всё как было.
# Заодно приводит в порядок WEBAPP_URL: приложение переезжает из корня в
# /app/, и адрес кнопки в Telegram должен переехать вместе с ним, иначе
# человек нажмёт «Открыть» и попадёт на рекламную страницу.

set -euo pipefail

APP="${APP:-/opt/trapeza}"
DOMAIN="${DOMAIN:-pervichkaru.ru}"
ROOT="${ROOT:-/var/www/pervichka}"
MINIAPP_PORT="${MINIAPP_PORT:-8790}"
LAVA_PORT="${LAVA_PORT:-8788}"
AVAIL=/etc/nginx/sites-available
ENABLED=/etc/nginx/sites-enabled
CONF="$AVAIL/$DOMAIN"
STAMP="$(date +%F-%H%M%S)"
BAKDIR="/root/nginx-merge-$STAMP"

if [ "$(id -u)" != "0" ]; then echo "Нужен root: sudo bash $0"; exit 1; fi

echo "Домен:   $DOMAIN"
echo "Лендинг: $ROOT"
echo "Копии:   $BAKDIR"
echo

# ---------- 1. Что сейчас включено ----------

mkdir -p "$BAKDIR"
cp -a "$ENABLED"/. "$BAKDIR/" 2>/dev/null || true
# grep -R, а не -r: sites-enabled состоит из символических ссылок, и -r
# по ним не идёт — список соперников выходил пустым, а лишний конфиг
# оставался включённым. Ровно это и случилось на боевом сервере.
RIVALS=$(grep -RlE "server_name[[:space:]].*\b$(echo "$DOMAIN" | sed 's/\./\\./g')\b" "$ENABLED" 2>/dev/null || true)
echo "Конфиги, объявляющие этот домен:"
for f in $RIVALS; do echo "  $(basename "$f")"; done
echo

# ---------- 2. Сертификат ----------
#
# Блок 443 пишем, только если сертификат на месте: конфиг со ссылкой на
# несуществующий файл nginx не примет, и сайт ляжет целиком.

LE="/etc/letsencrypt/live/$DOMAIN"
if [ -s "$LE/fullchain.pem" ]; then
  HTTPS=1
  echo "Сертификат найден — собираю конфиг с HTTPS."
else
  HTTPS=0
  echo "Сертификата нет — соберу пока только HTTP, потом запустите certbot."
fi
echo

# ---------- 3. Один конфиг ----------

{
cat <<NGINX
# Сайт «Первички». Один конфиг на домен — собран deploy/nginx-merge.sh.
#
# Про ^~ у наших маршрутов. Без него правило для картинок (~* ниже)
# проверялось бы раньше префиксных, и запрос вида /app/icon.png уходил бы
# на диск вместо приложения — с ответом 404 и без единой подсказки, почему.
# Сейчас таких файлов у приложения нет, но появятся, и искать эту поломку
# пришлось бы долго. ^~ говорит nginx: совпал префикс — регулярки не смотреть.
#
# Всё, что не перехвачено, достаётся общему «/» — то есть лендингу с диска.

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    # Место, куда certbot кладёт проверочный файл при выпуске сертификата.
    # Оно должно остаться доступным по HTTP, иначе продление сертификата
    # однажды тихо перестанет работать.
    location /.well-known/acme-challenge/ { root /var/www/html; }
NGINX

if [ "$HTTPS" = "1" ]; then
cat <<NGINX
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN www.$DOMAIN;

    ssl_certificate     $LE/fullchain.pem;
    ssl_certificate_key $LE/privkey.pem;
NGINX
[ -f /etc/letsencrypt/options-ssl-nginx.conf ] \
  && echo "    include /etc/letsencrypt/options-ssl-nginx.conf;"
[ -f /etc/letsencrypt/ssl-dhparams.pem ] \
  && echo "    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
echo
fi

cat <<NGINX
    root $ROOT;
    index index.html;

    # Уведомление об оплате. Приёмник слушает только петлю, снаружи к нему
    # не достучаться — этот блок единственная дорога к нему.
    location ^~ /lava {
        proxy_pass http://127.0.0.1:$LAVA_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # Мини-приложение. Косая черта в конце proxy_pass обязательна: она
    # срезает префикс /app/, иначе приложение искало бы свои файлы по
    # /app/app/app.css и показывало бы пустой экран.
    location ^~ /app/ {
        proxy_pass http://127.0.0.1:$MINIAPP_PORT/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # Подпись Telegram приезжает в этом заголовке. Без явной передачи
        # nginx его не пропустит, и приложение никого не опознает.
        proxy_set_header Authorization \$http_authorization;
    }
    location ^~ /api/ {
        proxy_pass http://127.0.0.1:$MINIAPP_PORT/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Authorization \$http_authorization;
        client_max_body_size 4m;      # выписка и снимки счетов
    }

    # Документ по временной ссылке: открывает клиент нашего пользователя,
    # у которого ни бота, ни приложения нет. Собирается на лету, отсюда
    # запас по времени.
    location ^~ /d/ {
        proxy_pass http://127.0.0.1:$MINIAPP_PORT/d/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # Всё остальное — лендинг с диска.
    location / { try_files \$uri \$uri/ =404; }

    location ~* \.(webp|png|jpg|svg|ico|woff2)\$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
    location = /robots.txt  { expires -1; }
    location = /sitemap.xml { expires -1; }

    gzip on;
    gzip_types text/html text/css application/javascript application/xml text/plain;
}
NGINX
} > "$CONF.new"

# ---------- 4. Подмена с откатом ----------

mv "$CONF.new" "$CONF"
for f in $RIVALS; do
  [ "$(readlink -f "$f")" = "$(readlink -f "$CONF")" ] && continue
  rm -f "$f"
  echo "Отключил лишний конфиг: $(basename "$f")"
done
ln -sf "$CONF" "$ENABLED/$DOMAIN"

if ! nginx -t 2>/dev/null; then
  echo
  echo "⚠️  nginx не принял новый конфиг — возвращаю всё как было."
  if [ -n "$(ls -A "$BAKDIR" 2>/dev/null)" ]; then
    rm -f "$ENABLED"/*
    cp -a "$BAKDIR"/. "$ENABLED/"
  fi
  nginx -t 2>&1 | sed 's/^/    /'
  exit 1
fi
systemctl reload nginx
echo "Конфиг сведён в один, nginx перезагружен."

# ---------- 5. Адрес приложения ----------
#
# Приложение переехало из корня в /app/. Если в .env остался старый адрес,
# кнопка в Telegram приведёт человека на рекламную страницу вместо
# приложения — и он решит, что бот сломался.

if [ -f "$APP/.env" ]; then
  WAS=$(sed -n 's/^WEBAPP_URL=//p' "$APP/.env" | head -1)
  WANT="https://$DOMAIN/app/"
  if [ "$WAS" != "$WANT" ]; then
    cp "$APP/.env" "$APP/.env.bak.$STAMP"
    sed -i '/^WEBAPP_URL=/d' "$APP/.env"
    echo "WEBAPP_URL=$WANT" >> "$APP/.env"
    echo "Адрес приложения: было «${WAS:-не задано}», стало «$WANT»."
    systemctl restart trapeza-bot trapeza-miniapp
    echo "Бот и приложение перезапущены."
  else
    echo "Адрес приложения уже верный: $WANT"
  fi
fi

# ---------- 6. Проверка ----------
#
# Смотрим глазами постороннего: по HTTPS, снаружи, как зайдёт покупатель.

# Даём службам подняться. Без паузы проверка стреляет через долю секунды
# после перезапуска и показывает 502 у живого приложения — пугая на ровном
# месте и заставляя искать поломку там, где её нет.
sleep 4

echo
echo "Проверка:"
T=$(curl -sS -m 15 "https://$DOMAIN/" 2>/dev/null | grep -oE '<title>[^<]*' | head -1 | cut -c8-)
case "$T" in
  *Telegram*|*ИП\ и\ ООО*) echo "  сайт      → лендинг: «$(echo "$T" | cut -c1-46)…»" ;;
  *документы*) echo "  сайт      → ⚠️  всё ещё приложение, а не лендинг" ;;
  *) echo "  сайт      → «$T»" ;;
esac
A=$(curl -sS -m 15 "https://$DOMAIN/app/" 2>/dev/null | grep -oE '<title>[^<]*' | head -1 | cut -c8-)
echo "  /app/     → «${A:-пусто}»"
echo "  /lava     → $(curl -sS -o /dev/null -w '%{http_code}' -m 10 -X POST \
  -H 'X-Api-Key: заведомо-неверный' -d '{}' "https://$DOMAIN/lava" 2>/dev/null) (нужен 401)"
echo "  /d/…      → $(curl -sS -o /dev/null -w '%{http_code}' -m 15 "https://$DOMAIN/d/проверка" 2>/dev/null) (нужен 404)"
echo
echo "Копии старых конфигов: $BAKDIR"
