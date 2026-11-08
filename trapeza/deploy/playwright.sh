#!/usr/bin/env bash
#
# Chromium для сборки PDF.
#
#   bash /opt/trapeza/deploy/playwright.sh
#
# Без него документы уходят клиенту HTML-файлом. Это рабочий запасной путь —
# файл открывается в браузере и печатается, — но бухгалтерия ждёт PDF, и
# счёт в виде .html выглядит самоделкой.
#
# Скрипт можно запускать повторно: он проверяет, что уже стоит, и доделывает
# недостающее.
#
# Почему браузер не в package.json. Playwright тянет за собой ~400 МБ и
# качает браузер на каждой установке зависимостей. lib/pdf.js рассчитан на
# его отсутствие и молча переходит на HTML, поэтому браузер ставится отдельно
# и только там, где он нужен, — на сервере.

set -euo pipefail

APP="${APP:-/opt/trapeza}"
OWNER="${OWNER:-trapeza}"
SERVICES="${SERVICES:-trapeza-bot trapeza-miniapp trapeza-lava}"

# Версия закреплена: обновление браузера меняет вёрстку документов, и
# случиться это должно тогда, когда мы к этому готовы, а не при очередном
# запуске скрипта.
VERSION="${PLAYWRIGHT_VERSION:-1.56.1}"

# Браузер кладём в общую папку, а не в ~/.cache того, кто запустил скрипт.
# Запускает root, а работают службы под пользователем trapeza — из чужого
# домашнего каталога он бы их не увидел.
BROWSERS="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS"

if [ "$(id -u)" != "0" ]; then
  echo "Нужен root: sudo bash $0"
  exit 1
fi

echo "Playwright:  $VERSION"
echo "Браузер в:   $BROWSERS"
echo "Службы:      $SERVICES"
echo

# ---------- 1. Место на диске ----------
#
# Браузер со всеми библиотеками — около гигабайта. Кончившееся посреди
# установки место оставляет распакованный наполовину Chromium, который
# запускается и падает: диагностировать это потом дороже, чем проверить сейчас.

FREE_MB=$(df -Pk / | awk 'NR==2 {print int($4/1024)}')
if [ "$FREE_MB" -lt 1500 ]; then
  echo "На диске свободно ${FREE_MB} МБ, нужно хотя бы 1500."
  echo "Освободите место (du -sh /var/log/* /var/backups/* | sort -h | tail) и запустите снова."
  exit 1
fi
echo "Свободно на диске: ${FREE_MB} МБ — хватает."

# ---------- 2. Пакет ----------
#
# Ставим глобально, а не в зависимости проекта: обновление кода (update.sh)
# переустанавливает зависимости и снесло бы браузер вместе с ними.
#
# Проверяем наличие по прямому пути, а не через require('playwright'): пакет
# лежит в глобальной папке модулей, а она в обычный поиск Node не входит —
# require его не находит, даже когда он установлен.

NPM_ROOT="$(npm root -g)"
PW_DIR="$NPM_ROOT/playwright"
echo "Глобальные модули: $NPM_ROOT"

HAVE=""
[ -f "$PW_DIR/package.json" ] && HAVE="$(node -p "require('$PW_DIR/package.json').version" 2>/dev/null || true)"

if [ "$HAVE" = "$VERSION" ]; then
  echo "Пакет playwright@$VERSION уже стоит."
else
  [ -n "$HAVE" ] && echo "Стоит playwright@$HAVE, нужен $VERSION — переустанавливаю."
  echo "Ставлю пакет playwright@$VERSION…"
  # SKIP_BROWSER_DOWNLOAD — чтобы установка пакета не качала браузер втихую
  # в стороннюю папку. Браузер ставим следующим шагом, явно и туда, куда решили.
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g --no-audit --no-fund "playwright@$VERSION" >/dev/null
fi

if [ ! -f "$PW_DIR/package.json" ]; then
  echo "После установки пакет не нашёлся в $PW_DIR — дальше идти незачем."
  exit 1
fi

# ---------- 3. Браузер и системные библиотеки ----------
#
# --with-deps сам ставит десяток библиотек, без которых Chromium не стартует
# (шрифты, звук, графика). На системах без apt эта часть не отработает —
# тогда пробуем поставить только браузер и честно об этом говорим.

echo "Ставлю Chromium (это несколько минут)…"
if ! playwright install --with-deps chromium; then
  echo "⚠️  Системные библиотеки поставить не вышло — пробую только браузер."
  playwright install chromium
fi

# Службы работают не под root: без прав на чтение браузер для них
# не существует.
chmod -R a+rX "$BROWSERS" 2>/dev/null || true

# ---------- 4. Адреса для служб ----------
#
# Две переменные, и обе нужны:
#   PLAYWRIGHT_DIR          — где лежит сам пакет (глобальную папку модулей
#                             Node сам не ищет, см. шаг 2);
#   PLAYWRIGHT_BROWSERS_PATH— где лежит браузер.
#
# Пишем отдельным файлом-дополнением, а не правим сами unit-файлы: свои
# настройки службы остаются нетронутыми, а дополнение удаляется одной
# командой, если понадобится откатиться.

for svc in $SERVICES; do
  dir="/etc/systemd/system/${svc}.service.d"
  mkdir -p "$dir"
  cat > "$dir/playwright.conf" <<CONF
[Service]
Environment=PLAYWRIGHT_DIR=$PW_DIR
Environment=PLAYWRIGHT_BROWSERS_PATH=$BROWSERS
CONF
done
systemctl daemon-reload
echo "Прописал адреса службам: $SERVICES"

# ---------- 5. Проверка ----------
#
# Главный шаг. «Команда отработала» и «документ собирается» — разные вещи:
# браузер может встать и не запуститься из-за нехватки библиотеки, прав или
# памяти. Поэтому собираем настоящий PDF от имени той учётной записи, под
# которой работают службы, и смотрим на первые байты файла.

echo
echo "Собираю пробный документ от имени $OWNER…"
CHECK=$(cat <<'JS'
const { pdfAvailable, htmlToPdf, closePdf } = require(process.env.APP + '/lib/pdf');
(async () => {
  if (!pdfAvailable()) { console.log('НЕТ: пакет playwright не находится из ' + process.env.APP); process.exit(2); }
  const buf = await htmlToPdf('<h1>Проверка</h1><p>Кириллица: Ёжик съел щуку.</p>');
  await closePdf();
  console.log(buf.slice(0, 4).toString() === '%PDF'
    ? 'ДА: PDF собран, ' + Math.round(buf.length / 1024) + ' КБ'
    : 'НЕТ: получилось что-то, но это не PDF');
})().catch((e) => { console.log('НЕТ: ' + e.message); process.exit(3); });
JS
)

if sudo -u "$OWNER" env "APP=$APP" "PLAYWRIGHT_DIR=$PW_DIR" \
     "PLAYWRIGHT_BROWSERS_PATH=$BROWSERS" node -e "$CHECK"; then
  echo
  systemctl restart $SERVICES
  sleep 2
  systemctl --no-pager --lines=0 status $SERVICES | grep -E "^●|Active:" || true
  echo
  echo "Готово. Выпишите любой счёт — придёт .pdf вместо .html."
else
  echo
  echo "⚠️  Браузер поставился, но документ не собрался. Службы НЕ перезапущены —"
  echo "    бот работает как раньше, отдаёт HTML. Пришлите вывод выше."
  exit 1
fi
