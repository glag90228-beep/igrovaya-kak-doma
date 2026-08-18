#!/usr/bin/env bash
# Закрепляет версию ruflo во всём, что создаёт `ruflo init`.
#
# Зачем: по умолчанию ruflo прописывает себя как `ruflo@latest` — и в .mcp.json,
# и в хуках, и во всех примерах в .claude/commands. Значит при каждом запуске с
# npm тянется свежая версия, какая бы она ни оказалась. Для проекта с боевой
# базой клиентов это неприемлемо: обновление должно быть решением человека, а не
# побочным эффектом старта сессии.
#
#   bash .claude/pin-ruflo.sh            # закрепить версию из PIN ниже
#   bash .claude/pin-ruflo.sh 3.39.0     # перейти на другую версию
#
# Прогонять заново после `ruflo init upgrade` — он возвращает `@latest`.
set -euo pipefail

PIN="${1:-3.38.12}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WHERE=(.claude .claude-flow .agents .mcp.json CLAUDE.md)

# Три имени одного и того же выпуска: тонкая обёртка, зонтичный пакет и сама
# реализация. Версия у них общая, поэтому закрепляем одним числом.
#
# Разделитель sed — «#», потому что в «@claude-flow/cli» есть косая черта.
# Версией считаем любой следующий за «@» токен (latest, alpha, 3.38.12) —
# так скрипт годится и для смены одной закреплённой версии на другую.
for pkg in 'ruflo' 'claude-flow' '@claude-flow/cli'; do
  # Себя самого пропускаем: иначе первый же прогон перепишет `ruflo@latest`
  # в комментариях выше и объяснение перестанет читаться.
  grep -rlF --binary-files=without-match --exclude=pin-ruflo.sh \
    "${pkg}@" "${WHERE[@]}" 2>/dev/null \
    | while IFS= read -r f; do
        sed -i -E "s#${pkg}@[0-9A-Za-z][0-9A-Za-z.+-]*#${pkg}@${PIN}#g" "$f"
      done
done

# «|| true» обязателен: когда закреплять больше нечего, grep возвращает 1,
# и из-за set -e скрипт молча падал бы ровно на успешном прогоне.
left="$(grep -rhoE --exclude=pin-ruflo.sh '(ruflo|claude-flow)@latest' \
  "${WHERE[@]}" 2>/dev/null | wc -l || true)"
echo "Версия ruflo закреплена: ${PIN}. Осталось незакреплённых упоминаний: ${left}."
echo "Пакеты agentdb, flow-nexus и agentic-jujutsu не трогаем — это отдельные"
echo "проекты со своей нумерацией, и в исполняемых путях их нет."
