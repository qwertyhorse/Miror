#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
mirror_command="${1:-start}"
case "$mirror_command" in
  start|stop|prepare|doctor|check) ;;
  *) echo "用法：bash scripts/launch-mac.sh start|stop|prepare|doctor" >&2; exit 2 ;;
esac
mirror_node=""
for candidate in "$(command -v node || true)" \
  /opt/homebrew/bin/node /usr/local/bin/node \
  "$HOME/.volta/bin/node" \
  "$HOME/.nvm/versions/node/"*/bin/node \
  "$HOME/Library/Application Support/fnm/node-versions/"*/installation/bin/node \
  "$HOME/.local/share/fnm/node-versions/"*/installation/bin/node \
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
  if [ -x "$candidate" ] && "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
    mirror_node="$candidate"
    break
  fi
done
if [ -z "$mirror_node" ]; then
  echo "请先安装 Node.js 22.13 或更新版本（建议 24），然后重新打开。" >&2
  exit 1
fi
export PATH="$(dirname -- "$mirror_node"):$PATH"
if [ "$mirror_command" = "stop" ]; then
  exec "$mirror_node" scripts/lan-managed.mjs stop
fi
mirror_npm=()
if command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
  mirror_npm=("$(command -v npm)")
elif [ -f tools/npm/bin/npm-cli.js ]; then
  mirror_npm=("$mirror_node" "tools/npm/bin/npm-cli.js")
else
  echo "缺少包内 npm。请重新解压完整交付包，或安装包含 npm 的 Node.js。" >&2
  exit 1
fi
if [ "$mirror_command" = "doctor" ] || [ "$mirror_command" = "check" ]; then
  mirror_node_version=$("$mirror_node" --version)
  mirror_npm_version=$("${mirror_npm[@]}" --version)
  echo "Node：$mirror_node ($mirror_node_version)"
  echo "npm：${mirror_npm[*]} ($mirror_npm_version)"
  exit 0
fi
if [ "$mirror_command" = "start" ]; then
  "$mirror_node" scripts/lan-managed.mjs preflight
fi
if [ ! -f node_modules/tsx/dist/loader.mjs ] || [ ! -f node_modules/selfsigned/index.js ]; then
  "${mirror_npm[@]}" ci --omit=dev --no-audit --no-fund
fi
"$mirror_node" scripts/setup.mjs
if [ "$mirror_command" = "prepare" ]; then
  echo "运行依赖、环境与证书已准备好。"
  exit 0
fi
"$mirror_node" scripts/lan-managed.mjs start
/usr/bin/open 'http://xuminghong.local:10601/'
