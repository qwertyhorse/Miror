#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
service_name='miror-preview.service'
preview_url='http://xuxin.local:10101/'

fail() {
  printf '\n启动失败：%s\n' "$1" >&2
  if [[ -t 0 ]]; then
    read -r -p '按回车关闭窗口……' || true
  fi
  exit 1
}

trap 'fail "请检查后台服务状态：systemctl --user status miror-preview.service"' ERR

if [[ "$(systemctl --user show "$service_name" --property=WorkingDirectory --value)" != "$project_dir" ]]; then
  fail '后台服务的位置与当前项目不一致，请先更新后台服务配置。'
fi

# 系统代理重新应用配置时可能覆盖直连列表，只补充本项目域名。
python3 - <<'PY'
import ast
import subprocess

setting = ['org.gnome.system.proxy', 'ignore-hosts']
raw = subprocess.check_output(['gsettings', 'get', *setting], text=True).strip()
if raw.startswith('@as '):
    raw = raw[4:]
hosts = ast.literal_eval(raw)
if not isinstance(hosts, list) or not all(isinstance(host, str) for host in hosts):
    raise ValueError('无法读取系统代理直连列表。')
if 'xuxin.local' not in hosts:
    hosts.append('xuxin.local')
    subprocess.run(['gsettings', 'set', *setting, repr(hosts)], check=True)
PY

printf '正在启动展会局域网服务……\n'
systemctl --user start "$service_name"

ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if systemctl --user is-active --quiet "$service_name" \
    && curl --noproxy '*' --fail --silent --connect-timeout 1 --max-time 2 \
      --resolve 'xuxin.local:10101:127.0.0.1' "${preview_url}__mirror_health" >/dev/null \
    && curl --noproxy '*' --fail --silent --connect-timeout 1 --max-time 2 \
      --resolve 'xuxin.local:10202:127.0.0.1' --cacert "$project_dir/.data/lan-tls/root-ca.crt" \
      'https://xuxin.local:10202/__camera_health' >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done

[[ "$ready" == true ]] || fail '服务尚未就绪，请检查后台服务日志。'
printf '\n局域网服务已启动：%s\n关闭此窗口后，服务仍会继续运行。\n' "$preview_url"

if [[ "${1:-}" != '--no-open' ]]; then
  if ! xdg-open "$preview_url" >/dev/null 2>&1; then
    printf '请在浏览器打开：%s\n' "$preview_url"
  fi
fi
