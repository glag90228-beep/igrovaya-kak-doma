#!/usr/bin/env bash
# Закрепляет версии пакетов, которые прописывает `ruflo init`.
#
# Зачем: по умолчанию ruflo пишет себя как `ruflo@latest` — и в .mcp.json,
# и в хуках, и во всех примерах в .claude/commands. Значит при каждом запуске с
# npm тянется свежая версия, какая бы она ни оказалась. Для проекта с боевой
# базой клиентов это неприемлемо: обновление должно быть решением человека, а не
# побочным эффектом старта сессии.
#
#   bash .claude/pin-ruflo.sh            # закрепить версии из таблицы ниже
#   bash .claude/pin-ruflo.sh 3.39.0     # перевести сам ruflo на другую версию
#
# Прогонять заново после `ruflo init upgrade` — он возвращает `@latest`.
set -euo pipefail

# Версия самого ruflo. Первым аргументом её можно заменить, не правя файл.
PIN="${1:-3.38.12}"

# Что на что закрепляем. Первые три — три имени одного и того же выпуска
# (тонкая обёртка, зонтичный пакет и сама реализация), поэтому версия у них
# общая. Остальные — отдельные проекты со своей нумерацией: их версии живут
# здесь, и менять их нужно осознанно, сверившись с `npm view <пакет> version`.
PINS=(
  "ruflo=${PIN}"
  "claude-flow=${PIN}"
  "@claude-flow/cli=${PIN}"
  "agentdb=3.0.0-alpha.20"
  "flow-nexus=0.1.128"
  "agentic-jujutsu=2.3.6"
)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WHERE=(.claude .claude-flow .agents .mcp.json CLAUDE.md)

# Разделитель sed — «#», потому что в «@claude-flow/cli» есть косая черта.
# Версией считаем любой следующий за «@» токен (latest, alpha, 3.0.0-alpha.20) —
# так скрипт годится и для смены одной закреплённой версии на другую.
for entry in "${PINS[@]}"; do
  pkg="${entry%%=*}"
  ver="${entry#*=}"
  # Себя самого пропускаем: иначе первый же прогон перепишет `ruflo@latest`
  # в комментариях выше и объяснение перестанет читаться.
  grep -rlF --binary-files=without-match --exclude=pin-ruflo.sh \
    "${pkg}@" "${WHERE[@]}" 2>/dev/null \
    | while IFS= read -r f; do
        sed -i -E "s#${pkg}@[0-9A-Za-z][0-9A-Za-z.+-]*#${pkg}@${ver}#g" "$f"
      done
  echo "  ${pkg}@${ver}"
done

# «|| true» обязателен: когда закреплять больше нечего, grep возвращает 1,
# и из-за set -e скрипт молча падал бы ровно на успешном прогоне.
left="$(grep -rhoE --exclude=pin-ruflo.sh '[@a-zA-Z0-9._/-]+@latest' \
  "${WHERE[@]}" 2>/dev/null | wc -l || true)"
echo "Готово. Осталось упоминаний @latest: ${left}."
