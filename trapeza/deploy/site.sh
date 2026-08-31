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
MINIAPP_PORT="${MINIAPP_PORT:-8790}"   # то же, что у miniapp.js по умолчанию
LAVA_PORT="${LAVA_PORT:-8788}"         # то же, что у lava-webhook.js по умолчанию
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

# ---------- 1а. Сколько документов бесплатно ----------
#
# Страница обещает число, а выдаёт его бот. Разъезжаются они молча: число в
# вёрстке правится руками, FREE_DOCS на сервере — переменной окружения, и
# ничто их не сверяет. Так и вышло: в вёрстке стояло 5, на сервере 50.
# Обещать в рекламе не то, что даёшь, нельзя (ФЗ «О рекламе», ст. 5), причём
# ошибка в любую сторону плоха: меньше обещанного — обман, больше — вы
# раздаёте втрое больше, чем собирались, и не знаете об этом.
#
# Поэтому число берём из бота и подставляем в страницу при публикации.
# Спрашиваем не файл с настройками, а само работающее окружение службы: это
# ровно то, с чем бот считает лимит, независимо от того, задан он в unit-файле,
# в EnvironmentFile или вообще нигде.

BOT_PID="$(systemctl show -p MainPID --value trapeza-bot 2>/dev/null || echo 0)"
FREE=""
if [ "${BOT_PID:-0}" != "0" ] && [ -r "/proc/$BOT_PID/environ" ]; then
  FREE="$(tr '\0' '\n' < "/proc/$BOT_PID/environ" | sed -n 's/^FREE_DOCS=//p' | head -1)"
fi
# Не задано у службы — значит бот берёт своё умолчание (lib/bot-db.js).
[ -z "$FREE" ] && FREE=5

if ! printf '%s' "$FREE" | grep -qE '^[0-9]+$'; then
  echo "⚠️  FREE_DOCS у бота — «$FREE», это не число. Оставляю страницу как есть."
else
  WAS="$(sed -n 's/.*class="[^"]*free-docs[^"]*">\([0-9]\+\)<.*/\1/p' "$ROOT/index.html" | head -1)"
  sed -i -E "s|(class=\"[^\"]*free-docs[^\"]*\">)[0-9]+(<)|\1$FREE\2|g" "$ROOT/index.html"
  N="$(grep -c 'free-docs' "$ROOT/index.html" || true)"
  if [ "$WAS" = "$FREE" ]; then
    echo "Бесплатных документов: $FREE — страница и бот сходятся (мест на странице: $N)."
  else
    echo "Бесплатных документов у бота: $FREE, на странице стояло $WAS — поправил в $N местах."
  fi
fi

# ---------- 2. Оферта и политика ----------
#
# Сайт продаёт подписку, значит оферта и политика обработки данных на нём
# обязаны быть: политика — по 152-ФЗ, оферта — потому что без неё непонятно,
# за что человек платит и как вернуть деньги. Пока реквизиты не заполнены,
# сборка честно останавливается, и мы говорим об этом вслух, а не тихо
# выкладываем сайт без них.

if node "$SRC/build-legal.js" "$ROOT" >/dev/null 2>&1; then
  # Политику по решению владельца пока не публикуем. Генератор остаётся:
  # вернуть страницу — это убрать одну строку здесь и одну в подвале.
  rm -f "$ROOT/politika.html"
  echo "Оферта собрана."
else
  echo
  echo "⚠️  Оферта НЕ собрана — не заполнены реквизиты."
  node "$SRC/build-legal.js" "$ROOT" 2>&1 | sed 's/^/    /' || true
  echo "    Заполните их в lib/legal.js → CONFIG и запустите этот скрипт снова."
  #
  # Раз страниц нет — убираем на них ссылки из подвала. Ссылка в никуда
  # хуже её отсутствия: человек нажимает «Оферта» перед оплатой, получает
  # «страница не найдена» и уходит, решив, что тут всё несерьёзно.
  #
  sed -i -E '/href="\/(oferta|politika)\.html"/d' "$ROOT/index.html"
  echo "    Ссылка на неё временно убрана из подвала опубликованной страницы."
  echo
fi

chown -R www-data:www-data "$ROOT" 2>/dev/null || true

# ---------- 3. nginx ----------

if [ -f "$CONF" ]; then
  # Готовый конфиг не переписываем целиком — в него дописывает certbot, и
  # перезапись снесла бы настройки сертификата. Но и «не трогаю» было
  # неверно: из-за этого новые маршруты никогда не доезжали до серверов, где
  # конфиг уже был. Так и пропала оплата — блок /lava появился в скрипте, а
  # в боевом конфиге его не было, и узнали мы об этом от покупателя.
  #
  # Поэтому дописываем только недостающее и только своё. Место вставки —
  # строка server_name с нашим доменом: она есть в каждом блоке, а после
  # certbot их два (80 и 443), так что маршрут попадёт в оба.
  echo "Конфиг nginx уже есть: $CONF — дописываю недостающее."
  BAK="$CONF.bak.$(date +%F-%H%M%S)"
  cp "$CONF" "$BAK"
  ADDED=0
  # Шаблон учитывает и «location ^~ /lava»: после deploy/nginx-merge.sh
  # маршруты записаны именно так, и без этого сюда добавился бы второй
  # такой же блок — nginx отвергает конфиг с двумя одинаковыми location.
  #
  # /webhook отсюда убран: площадка ходит на /lava, а общий путь /webhook
  # только собирал чужие пробы (их видно в журнале nginx).
  for LOC in lava; do
    if grep -qE "location[[:space:]]+(\^~[[:space:]]*)?/$LOC\b" "$CONF"; then continue; fi
    sed -i "/server_name .*$(echo "$DOMAIN" | sed 's/\./\\./g')/a\\
    location /$LOC {\\
        proxy_pass http://127.0.0.1:$LAVA_PORT;\\
        proxy_set_header Host \$host;\\
        proxy_set_header X-Forwarded-Proto \$scheme;\\
        proxy_set_header X-Real-IP \$remote_addr;\\
    }" "$CONF"
    ADDED=$((ADDED + 1))
    echo "  добавлен маршрут /$LOC → 127.0.0.1:$LAVA_PORT"
  done
  if [ "$ADDED" = "0" ]; then
    echo "  все нужные маршруты уже на месте."
  elif ! nginx -t 2>/dev/null; then
    # Сломать боевой nginx правкой конфига нельзя: откатываемся сразу.
    cp "$BAK" "$CONF"
    echo
    echo "⚠️  После правки nginx не принял конфиг — вернул как было. Что он говорит:"
    nginx -t 2>&1 | sed 's/^/    /'
    echo "    Добавьте маршрут вручную: location /lava { proxy_pass http://127.0.0.1:$LAVA_PORT; }"
    exit 1
  fi
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

    # Мини-приложение на том же домене.
    #
    # Само оно живёт в miniapp.js на порту $MINIAPP_PORT и отдаёт свои файлы с
    # корня, поэтому косая черта в конце proxy_pass обязательна: она срезает
    # префикс /app/. Без неё приложение искало бы свои же файлы по
    # /app/app/app.css и показывало бы пустой экран.
    #
    # Запросы к API идут отдельной веткой: страница обращается к ним по
    # адресу /api/..., без префикса.
    location /app/ {
        proxy_pass http://127.0.0.1:$MINIAPP_PORT/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:$MINIAPP_PORT/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 4m;      # выписка и снимки счетов
    }
    # Документ по временной ссылке: /d/<токен>. Открывает его клиент нашего
    # пользователя, у которого ни Telegram-бота, ни приложения нет, — поэтому
    # адрес отдельный и без подписи. Собирается документ на лету, отсюда и
    # запас по времени: PDF через Chromium это около секунды.
    location /d/ {
        proxy_pass http://127.0.0.1:$MINIAPP_PORT/d/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # Уведомление об оплате от Lava.
    #
    # Без этого блока оплата не работает вовсе, и молча: приёмник
    # (lava-webhook.js) слушает только петлю — снаружи к нему не достучаться,
    # — а nginx на /lava отвечал 404 из общего правила. Площадка исправно
    # присылала уведомление, оно не доходило, деньги списывались, доступ не
    # включался. Именно так и вышло на первой живой покупке.
    #
    # Два пути, потому что приёмник понимает оба, и какой из них прописан в
    # личном кабинете площадки — вопрос настройки, а не кода.
    #
    # proxy_pass без пути в конце — намеренно: адрес запроса уходит как есть,
    # вместе с параметрами (секрет площадка может передавать и в них).
    location /lava {
        proxy_pass http://127.0.0.1:$LAVA_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
    }
    location /webhook {
        proxy_pass http://127.0.0.1:$LAVA_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
    }

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
curl -sS -o /dev/null -w '  сайт          → %{http_code}\n' \
  -H "Host: $DOMAIN" http://127.0.0.1/ || true

# Доходит ли уведомление об оплате до приёмника.
#
# Стучимся заведомо неверным секретом и ждём 401 — это ответ нашего
# приёмника, то есть путь до него проложен. 404 означает, что запрос съел
# nginx и оплата снова не дойдёт; 502 — что приёмник не запущен.
#
# Проверять это обязательно и именно так: раньше маршрута не было вовсе,
# площадка исправно слала уведомления, они упирались в 404 — деньги
# списывались, доступ не включался, и узнали мы об этом от покупателя.
LAVA_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -m 10 -X POST \
  -H "Host: $DOMAIN" -H 'X-Api-Key: заведомо-неверный' \
  -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1/lava 2>/dev/null || echo 000)
case "$LAVA_CODE" in
  401) echo "  оплата /lava  → 401 (так и надо: приёмник ответил, путь проложен)" ;;
  404) echo "  оплата /lava  → 404 ⚠️  запрос не доходит до приёмника — оплата работать не будет" ;;
  502|503) echo "  оплата /lava  → $LAVA_CODE ⚠️  приёмник не отвечает: systemctl status trapeza-lava" ;;
  *)   echo "  оплата /lava  → $LAVA_CODE (ожидался 401 — посмотрите логи trapeza-lava)" ;;
esac
echo
echo "Если код 200 — сайт отдаётся. Осталось получить сертификат, один раз:"
echo
echo "  certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo
echo "После этого https://$DOMAIN/ откроется без предупреждений,"
echo "а certbot сам добавит перенаправление с http и продление по расписанию."
