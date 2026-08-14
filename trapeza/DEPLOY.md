# Как выложить «Трапезу» в интернет

Коротко: у проекта две части, и от того, что именно нужно, зависит способ размещения.

| Часть | Что делает | Нужен сервер? |
|---|---|---|
| Конструктор заказа (клиент) | клиент выбирает блюда, получает смету | нет, если заявки уходят в Telegram |
| Панель управления + приём заявок | вы правите меню, видите заказы, храните их | **да** |
| Telegram-бот (акты, счета, платёжки) | документы по запросу | **да**, постоянно запущенный |

---

## Вариант 1 (рекомендую). Свой сервер — работает всё

Подойдёт любой недорогой VPS с Node.js 22+. Российские хостинги удобнее: оплата в рублях,
поддержка на русском, нет проблем с доступом (Timeweb, Beget, reg.ru, Selectel и подобные).
Начальные тарифы обычно в пределах нескольких сотен рублей в месяц.

### Шаги

1. **Взять VPS** (Ubuntu 22.04/24.04) и зайти по SSH.

2. **Поставить Node.js 22 и git:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   ```

3. **Скачать проект и запустить:**
   ```bash
   git clone -b claude/estimates-reconciliation-agent-1oisy7 \
     https://github.com/glag90228-beep/igrovaya-kak-doma.git /opt/trapeza
   cd /opt/trapeza/trapeza
   npm install --omit=dev
   npm start          # проверка: должно написать «Трапеза» запущена
   ```

4. **Сделать автозапуск** — создать `/etc/systemd/system/trapeza.service`:
   ```ini
   [Unit]
   Description=Trapeza
   After=network.target

   [Service]
   WorkingDirectory=/opt/trapeza/trapeza
   ExecStart=/usr/bin/node server.js
   Environment=PORT=3000
   Restart=always
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```
   Затем:
   ```bash
   sudo systemctl enable --now trapeza
   sudo systemctl status trapeza
   ```

5. **Привязать адрес.** Проще всего — поддомен основного сайта, например
   `menu.трапеза18.рф`. В панели домена добавить A-запись на IP сервера, затем nginx:
   ```nginx
   server {
     server_name menu.xn--18-6kcaym8cgr.xn--p1ai;   # это menu.трапеза18.рф в punycode
     location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
   }
   ```
   HTTPS — бесплатно: `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx`.

6. **Сменить пароль панели**: `/admin` → «Реквизиты» → «Пароль от панели».

7. **Бот** (когда будет токен) — второй сервис по аналогии, с `ExecStart=/usr/bin/node bot.js`
   и `Environment=BOT_TOKEN=...`.

**Обновление после доработок:** `cd /opt/trapeza && git pull && sudo systemctl restart trapeza`

---

## Вариант 2. Бесплатно, но без панели

Если сервер пока не нужен: выложить **только конструктор** как статическую страницу
(GitHub Pages, хостинг сайта и т. п.). Клиент собирает заказ и отправляет его вам
готовым сообщением в Telegram.

- Плюс: бесплатно, ничего не администрировать.
- Минус: заявки не сохраняются, меню правится только через разработчика,
  панели управления и бота нет.

---

## Кнопка на сайте трапеза18.рф

Готовый код — в файле `site-button.html`. Три варианта:

- **А — плавающая кнопка**: видна всегда, на любой странице, в правом нижнем углу.
  Именно то, что нужно, чтобы кнопка «всегда была».
- **Б — обычная кнопка**: в текст страницы (например, на главной под описанием услуг).
- **В — пункт меню**: обычная ссылка в навигацию сайта.

Что сделать: открыть `site-button.html`, заменить `https://ССЫЛКА-НА-КОНСТРУКТОР`
на реальный адрес и вставить блок в шаблон сайта перед `</body>`.
Кнопка сделана в фирменных цветах, без внешних библиотек, корректно работает на телефоне.

---

## Что подготовить заранее

- Домен/поддомен для конструктора (например, `menu.трапеза18.рф`).
- Доступ к панели управления доменом — добавить A-запись.
- Токен Telegram-бота от @BotFather — для документов и заявок в бот.

---

## Бот «Первичка»: установка одной командой

На чистом Ubuntu 22.04/24.04 от root:

```bash
git clone <репозиторий> /root/trapeza-src
cd /root/trapeza-src/trapeza
bash deploy/install.sh          # первый запуск создаст /opt/trapeza/.env и остановится
nano /opt/trapeza/.env          # вписать BOT_TOKEN и остальное
bash deploy/install.sh          # второй запуск доводит до конца
```

Что делает скрипт: ставит Node 22, заводит системного пользователя `trapeza`,
раскладывает файлы в `/opt/trapeza` (папку `data` не трогает — там боевая база),
ставит зависимости и Chromium для PDF, проверяет токен, накатывает оформление
бота и поднимает две службы systemd.

### Проверка перед запуском

```bash
node bot.js --check          # токен рабочий? не занят ли вебхуком?
node bot.js --drop-webhook   # снять чужой вебхук, если long polling занят
node bot.js --setup          # имя, описания, команды, кнопка меню
```

`--check` отдельно смотрит `getWebhookInfo`: если у бота когда-то был настроен
вебхук, long polling молча не получит ни одного сообщения, и это самая обидная
причина «бот не отвечает».

### Приёмник оплат наружу

Служба слушает `127.0.0.1:8788`. Наружу — только через HTTPS:

```nginx
location /lava {
    proxy_pass http://127.0.0.1:8788/lava;
    proxy_set_header Host $host;
    proxy_set_header X-Api-Key $http_x_api_key;
}
```

В Lava Top указывается `https://ваш-домен/lava`, секрет — тот же, что в
`LAVA_WEBHOOK_SECRET`.

### Логи

```bash
journalctl -u trapeza-bot -f
tail -f /var/log/trapeza/lava.log      # сюда падает тело нераспознанного вебхука
```

### Обновление

```bash
cd /root/trapeza-src && git pull && cd trapeza && bash deploy/install.sh
systemctl restart trapeza-bot trapeza-lava
```

`.env` и `data/` при обновлении не перезаписываются.
