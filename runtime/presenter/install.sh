#!/usr/bin/env sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  printf '%s\n' '请在连接两只接收器的 Ubuntu 展会电脑运行此安装器。' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '需要 Node.js 22 或更高版本，请安装后重试。' >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '需要 Python 3，请安装后重试。' >&2
  exit 1
fi

presenter_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
presenter_setup="$presenter_script_dir/../../scripts/presenter-setup.mjs"
if [ ! -f "$presenter_setup" ]; then
  printf '%s\n' '安装包不完整：找不到 scripts/presenter-setup.mjs。请完整解压安装包后重试。' >&2
  exit 1
fi
exec node "$presenter_setup" "$@"
