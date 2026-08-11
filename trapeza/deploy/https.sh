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
MY_IP=$(curl -s https://api.ipify.org || true)
DNS_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -n "$MY_IP" ] && [ -n "$DNS_IP" ] && [ "$MY_IP" != "$DNS_IP" ]; then
  echo "⚠️  $DOMAIN указывает на $DNS_IP, а сервер — $MY_IP."
  echo "   Поправьте A-запись и подождите обновления DNS, иначе сертификат не выпустится."
  read -rp "Продолжить всё равно? [y/N] " a; [ "$a" = "y" ] || exit 1
fi

say "3/4 Конфиг nginx"
cat > /etc/nginx/sites-available/trapeza-lava <<NG
server {
    listen 80;
    server_name $DOMAIN;

    # Наружу открыт только приёмник вебхуков — больше ничего.
    location /lava {
        proxy_pass http://127.0.0.1:8788/lava;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Api-Key \$http_x_api_key;
        proxy_set_header Authorization \$http_authorization;
        client_max_body_size 256k;
    }
    location /health {
        proxy_pass http://127.0.0.1:8788/health;
    }
    location / { return 404; }
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
echo "Адрес для Lava Top:  https://$DOMAIN/lava"
echo "Проверка:            curl https://$DOMAIN/health   → должно ответить ok"
echo "Сертификат продлевается сам (systemctl status certbot.timer)."
