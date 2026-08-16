#!/usr/bin/env bash
# HTTPS для приёмника оплат Lava.
#   bash deploy/https.sh bot.example.ru you@mail.ru
# Домен должен уже указывать A-записью на этот сервер.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
[ -z "$DOMAIN" ] && { echo "Укажите домен: bash deploy/https.sh bot.example.ru you@mail.ru"; exit 1; }

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/4 nginx и certbot"
apt-get update -qq
apt-get install -y nginx certbot python3-certbot-nginx

say "2/4 Проверяю, что домен смотрит сюда"
# Сверяем адреса одного семейства: getent hosts отдаёт сначала IPv6, и сравнение
# его с IPv4 сервера всегда ложно «не совпадает».
MY_V4=$(curl -s -4 --max-time 10 https://api.ipify.org || true)
MY_V6=$(curl -s -6 --max-time 10 https://api64.ipify.org || true)
DNS_V4=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)
# ::ffff:1.2.3.4 — это не AAAA, а обычный IPv4 в обёртке IPv6: так getent
# отвечает, когда настоящей AAAA у домена нет. Без фильтра проверка видит
# «AAAA ведёт не туда» на ровном месте и пугает на пустом домене.
DNS_V6=$(getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '$1 !~ /^::ffff:/ {print $1; exit}' || true)
echo "  сервер: IPv4 ${MY_V4:-—}, IPv6 ${MY_V6:-нет}"
echo "  домен:  A ${DNS_V4:-нет}, AAAA ${DNS_V6:-нет}"

problems=''
add() { problems="$problems
  • $1"; }
if [ -z "$DNS_V4" ] && [ -z "$DNS_V6" ]; then
  add "у домена нет ни A, ни AAAA — проверьте DNS"
fi
if [ -n "$MY_V4" ] && [ -n "$DNS_V4" ] && [ "$MY_V4" != "$DNS_V4" ]; then
  add "A-запись ведёт на $DNS_V4, а сервер — $MY_V4"
fi
# Let's Encrypt предпочитает IPv6: неработающая AAAA роняет выпуск даже при верной A.
if [ -n "$DNS_V6" ] && [ -z "$MY_V6" ]; then
  add "есть AAAA ($DNS_V6), но IPv6 на сервере не отвечает — Let's Encrypt пойдёт по IPv6 и не достучится"
fi
if [ -n "$DNS_V6" ] && [ -n "$MY_V6" ] && [ "$DNS_V6" != "$MY_V6" ]; then
  add "AAAA ведёт на $DNS_V6, а IPv6 сервера — $MY_V6"
fi

if [ -n "$problems" ]; then
  echo ""
  echo "⚠️  Сертификат, скорее всего, не выпустится:$problems"
  echo "   Поправьте DNS и подождите обновления записей."
  read -rp "Продолжить всё равно? [y/N] " a; [ "$a" = "y" ] || exit 1
else
  echo "  ✅ домен смотрит на этот сервер"
fi

say "3/4 Конфиг nginx"
cat > /etc/nginx/sites-available/trapeza-lava <<NG
server {
    listen 80;
    server_name $DOMAIN;

    # Приёмник оплат Lava Top.
    location /lava {
        proxy_pass http://127.0.0.1:8788/lava;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Api-Key \$http_x_api_key;
        proxy_set_header Authorization \$http_authorization;
        client_max_body_size 256k;
    }

    # Мини-приложение Telegram: страница и его API.
    # Заголовок Authorization несёт подпись Telegram — его нужно пропустить.
    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Authorization \$http_authorization;
        client_max_body_size 1m;
    }
}
NG
ln -sf /etc/nginx/sites-available/trapeza-lava /etc/nginx/sites-enabled/trapeza-lava
nginx -t && systemctl reload nginx

say "4/4 Сертификат"
if [ -n "$EMAIL" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
else
  certbot --nginx -d "$DOMAIN" --redirect
fi

say "Готово"
echo "Адрес для Lava Top:      https://$DOMAIN/lava"
echo "Мини-приложение:         https://$DOMAIN"
echo "Проверка:                curl https://$DOMAIN/health   → должно ответить ok"
echo ""
echo "Осталось вписать адрес приложения в .env и перезапустить бота:"
echo "  sed -i 's|^WEBAPP_URL=.*|WEBAPP_URL=https://$DOMAIN|' /opt/trapeza/.env"
echo "  systemctl restart trapeza-miniapp trapeza-bot"
echo "  cd /opt/trapeza && sudo -u trapeza --preserve-env node bot.js --setup"
echo ""
echo "Сертификат продлевается сам (systemctl status certbot.timer)."
