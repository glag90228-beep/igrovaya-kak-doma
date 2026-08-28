#!/usr/bin/env bash
#
# Публикация сайта pervichkaru.ru.
#
#   bash deploy/site.sh
#
# Что делает: раскладывает страницу продукта в /var/www/pervichka, собирает
# оферту с политикой, настраивает nginx и перезагружает его. Запускать можно
# сколько угодно раз — повторный запуск просто обновит файлы.
#
# Чего НЕ делает: не выпускает сертификат и не трогает уже написанный конфиг
# nginx. Первое — отдельная команда certbot, она в конце подсказывается.
# Второе — потому что переписать чужую настройку молча значит уронить всё
# остальное, что этот nginx обслуживает.

set -euo pipefail

DOMAIN="${DOMAIN:-pervichkaru.ru}"
ROOT="${ROOT:-/var/www/pervichka}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
CONF="/etc/nginx/sites-available/$DOMAIN"

echo "Сайт:  $DOMAIN"
echo "Папка: $ROOT"
echo "Исходники: $SRC/public/landing"
echo

# ---------- 1. Файлы страницы ----------

mkdir -p "$ROOT"
cp "$SRC/public/landing/index.html"  "$ROOT/"
cp "$SRC/public/landing/robots.txt"  "$ROOT/"
cp "$SRC/public/landing/sitemap.xml" "$ROOT/"
mkdir -p "$ROOT/shots"
cp "$SRC/public/landing/shots/"*.webp "$ROOT/shots/" 2>/dev/null || true

# Второй вариант страницы намеренно не публикуем: две почти одинаковые
# страницы конкурируют в выдаче, и в поиск попадает не та, что нужна.
rm -f "$ROOT/index-v2.html"

echo "Страница разложена: $(ls -1 "$ROOT" | wc -l) файлов в корне, $(ls -1 "$ROOT/shots" 2>/dev/null | wc -l) снимков."

# ---------- 2. Оферта и политика ----------
#
# Сайт продаёт подписку, значит оферта и политика обработки данных на нём
# обязаны быть: политика — по 152-ФЗ, оферта — потому что без неё непонятно,
# за что человек платит и как вернуть деньги. Пока реквизиты не заполнены,
# сборка честно останавливается, и мы говорим об этом вслух, а не тихо
# выкладываем сайт без них.

if node "$SRC/build-legal.js" "$ROOT" >/dev/null 2>&1; then
  echo "Оферта и политика собраны."
else
  echo
  echo "⚠️  Оферта и политика НЕ собраны — не заполнены реквизиты."
  node "$SRC/build-legal.js" "$ROOT" 2>&1 | sed 's/^/    /' || true
  echo "    Заполните их в lib/legal.js → CONFIG и запустите этот скрипт снова."
  #
  # Раз страниц нет — убираем на них ссылки из подвала. Ссылка в никуда
  # хуже её отсутствия: человек нажимает «Оферта» перед оплатой, получает
  # «страница не найдена» и уходит, решив, что тут всё несерьёзно.
  #
  sed -i -E '/href="\/(oferta|politika)\.html"/d' "$ROOT/index.html"
  echo "    Ссылки на них временно убраны из подвала опубликованной страницы."
  echo
fi

chown -R www-data:www-data "$ROOT" 2>/dev/null || true

# ---------- 3. nginx ----------

if [ -f "$CONF" ]; then
  echo "Конфиг nginx уже есть: $CONF — не трогаю."
else
  cat > "$CONF" <<NGINX
# Сайт «Первички». Собран deploy/site.sh.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    root $ROOT;
    index index.html;

    # Место, куда certbot кладёт проверочный файл при выпуске сертификата.
    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / { try_files \$uri \$uri/ =404; }

    # Картинки и снимки экрана не меняются — пусть браузер их запоминает.
    location ~* \.(webp|png|jpg|svg|ico|woff2)\$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Карту сайта и robots отдаём без кэша: правим их чаще, чем раз в месяц.
    location = /robots.txt  { expires -1; }
    location = /sitemap.xml { expires -1; }

    gzip on;
    gzip_types text/html text/css application/javascript application/xml text/plain;
}
NGINX
  ln -sf "$CONF" "/etc/nginx/sites-enabled/$DOMAIN"
  echo "Конфиг nginx написан и включён."
fi

if nginx -t 2>/dev/null; then
  systemctl reload nginx
  echo "nginx перезагружен."
else
  echo
  echo "⚠️  nginx не принял настройки — показываю, что именно:"
  nginx -t 2>&1 | sed 's/^/    /'
  exit 1
fi

# ---------- 4. Что дальше ----------

echo
echo "Проверка изнутри:"
curl -sS -o /dev/null -w '  http://127.0.0.1 → %{http_code}\n' \
  -H "Host: $DOMAIN" http://127.0.0.1/ || true
echo
echo "Если код 200 — сайт отдаётся. Осталось получить сертификат, один раз:"
echo
echo "  certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo
echo "После этого https://$DOMAIN/ откроется без предупреждений,"
echo "а certbot сам добавит перенаправление с http и продление по расписанию."
