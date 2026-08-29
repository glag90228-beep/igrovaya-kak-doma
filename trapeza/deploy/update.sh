#!/usr/bin/env bash
#
# Обновление боевого сервера.
#
#   bash /opt/trapeza/deploy/update.sh
#
# Забирает свежий код из ветки, раскладывает в /opt/trapeza, прогоняет
# проверки и — только если они прошли — перезапускает службы.
#
# Порядок именно такой: проверки до перезапуска. Упавший прогон обрывает
# работу, и на боевом остаётся прежняя версия. Файлы к этому моменту уже
# лежат на диске, но запущенные процессы держат старый код в памяти, так
# что до перезапуска ничего не меняется.

set -euo pipefail

BRANCH="${BRANCH:-claude/estimates-reconciliation-agent-1oisy7}"
REPO="${REPO:-https://github.com/glag90228-beep/igrovaya-kak-doma.git}"
SRC="${SRC:-/root/trapeza-src}"
APP="${APP:-/opt/trapeza}"
OWNER="${OWNER:-trapeza}"
SERVICES="${SERVICES:-trapeza-bot trapeza-miniapp trapeza-lava}"

echo "Ветка:  $BRANCH"
echo "Сервер: $APP"
echo

# ---------- 1. Свежий код ----------
#
# Клон живёт отдельно от рабочей папки: в /opt/trapeza лежат .env, база и
# node_modules, которых в репозитории нет и быть не должно.

if ! git -C "$SRC" remote -v 2>/dev/null | grep -q igrovaya-kak-doma; then
  echo "Клона нет или он от другого репозитория — забираю заново."
  rm -rf "$SRC"
  git clone --quiet "$REPO" "$SRC"
fi
git -C "$SRC" fetch --quiet origin "$BRANCH"
git -C "$SRC" reset --quiet --hard "origin/$BRANCH"
echo "Забрал: $(git -C "$SRC" log --oneline -1)"

# ---------- 2. Файлы ----------
#
# Копируем содержимое, а не папку целиком: .env, data/ и node_modules
# в репозитории отсутствуют, значит и перезаписать их нечем.

cp -r "$SRC/trapeza/." "$APP/"
chown -R "$OWNER:$OWNER" "$APP" 2>/dev/null || true
echo "Разложил в $APP"

# Зависимости ставим, только если список изменился: npm install на каждом
# обновлении — это минута ожидания на ровном месте.
if ! cmp -s "$SRC/trapeza/package-lock.json" "$APP/.package-lock.deployed" 2>/dev/null; then
  echo "Список зависимостей изменился — доустанавливаю."
  (cd "$APP" && npm install --omit=dev --no-audit --no-fund >/dev/null)
  cp "$SRC/trapeza/package-lock.json" "$APP/.package-lock.deployed"
fi

# ---------- 3. Проверки ----------

echo
echo "Прогоняю проверки — это около двух минут."
if ! (cd "$APP" && npm test); then
  echo
  echo "⚠️  ПРОВЕРКИ НЕ ПРОШЛИ. Службы НЕ перезапущены, на сервере работает"
  echo "    прежняя версия. Пришлите вывод выше — разберёмся, что сломалось."
  exit 1
fi

# ---------- 4. Перезапуск ----------

# shellcheck disable=SC2086
systemctl restart $SERVICES
sleep 2
# shellcheck disable=SC2086
systemctl --no-pager --lines=0 status $SERVICES | grep -E "^●|Active:" || true

echo
echo "Готово. Что стоит посмотреть глазами:"
echo "  • откройте приложение — заставка, потом главный экран;"
echo "  • «Ждут оплаты» — сумма вверху должна сходиться со списком;"
echo "  • карточку клиента — там повторяющаяся операция и акт сверки."
echo
echo "Сайт обновляется отдельно:  bash $APP/deploy/site.sh"
