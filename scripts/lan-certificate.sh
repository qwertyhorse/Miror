#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
umask 077
tls_dir=".data/lan-tls"
extra_ip=""
if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--ip" ]; then
    echo "用法：bash scripts/lan-certificate.sh [--ip 本机局域网IPv4地址]" >&2
    exit 1
  fi
  extra_ip="$2"
fi
mkdir -p "$tls_dir"
chmod 700 "$tls_dir"

# Preserve the leaf's existing DNS/IP SANs. An added IP must be on this Mac now.
san_info=$(python3 - "$extra_ip" "$tls_dir/server.crt" <<'PY'
import ipaddress, pathlib, re, subprocess, sys
requested, certificate = sys.argv[1:]
if requested:
    address = ipaddress.IPv4Address(requested)
    interfaces = subprocess.check_output(['/sbin/ifconfig', '-a'], text=True)
    current = set(re.findall(r'^\s*inet\s+(\d+\.\d+\.\d+\.\d+)\s', interfaces, re.M))
    if not address.is_private or address.is_loopback or str(address) not in current:
        sys.exit('新增 SAN 必须是本 Mac 当前接口上的局域网 IPv4 地址。')
    requested = str(address)
existing = []
if pathlib.Path(certificate).exists():
    detail = subprocess.check_output(['/usr/bin/openssl', 'x509', '-in', certificate, '-noout', '-text'], text=True)
    match = re.search(r'X509v3 Subject Alternative Name:\s*\n\s*([^\n]+)', detail)
    if match:
        for item in match.group(1).split(','):
            item = item.strip().replace('IP Address:', 'IP:')
            if not re.fullmatch(r'(?:DNS:[A-Za-z0-9.*_-]+|IP:[0-9A-Fa-f:.]+)', item):
                sys.exit('现有证书包含需人工处理的 SAN，未替换证书。')
            existing.append(item)
desired = list(dict.fromkeys(existing + ['DNS:xuminghong.local', 'DNS:localhost', 'IP:127.0.0.1'] + (['IP:' + requested] if requested else [])))
print(','.join(desired))
print('changed' if set(existing) != set(desired) else 'same')
PY
)
subject_alt_names="${san_info%$'\n'*}"
san_state="${san_info##*$'\n'}"

if [ ! -f "$tls_dir/root-ca.key" ] && [ ! -f "$tls_dir/root-ca.crt" ]; then
  cat > "$tls_dir/ca.cnf" <<'CONFIG'
[req]
distinguished_name = dn
x509_extensions = ca_extensions
prompt = no
[dn]
CN = Miror Local Preview CA
[ca_extensions]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
CONFIG
  /usr/bin/openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -config "$tls_dir/ca.cnf" -keyout "$tls_dir/root-ca.key" -out "$tls_dir/root-ca.crt" 2>/dev/null
elif [ ! -f "$tls_dir/root-ca.key" ] || [ ! -f "$tls_dir/root-ca.crt" ]; then
  echo "本地 HTTPS 根证书不完整，请恢复 .data/lan-tls 中的证书与私钥。" >&2
  exit 1
fi

if [ ! -f "$tls_dir/server.key" ] || [ ! -f "$tls_dir/server.crt" ] || \
   [ "$san_state" = "changed" ] || \
   ! /usr/bin/openssl x509 -checkend 2592000 -noout -in "$tls_dir/server.crt" >/dev/null; then
  if [ -f "$tls_dir/server.key" ] || [ -f "$tls_dir/server.crt" ]; then
    mkdir -p "$tls_dir/backups"
    backup_dir=$(mktemp -d "$tls_dir/backups/leaf-$(date +%Y%m%dT%H%M%S)-XXXXXX")
    chmod 700 "$tls_dir/backups" "$backup_dir"
    for name in server.key server.crt; do
      if [ -f "$tls_dir/$name" ]; then
        cp "$tls_dir/$name" "$backup_dir/$name"
        chmod 600 "$backup_dir/$name"
      fi
    done
    echo "已备份原服务器证书与私钥至 ${backup_dir}（未显示密钥）。"
  fi
  staging_dir=$(mktemp -d "$tls_dir/leaf-staging-XXXXXX")
  trap 'rm -rf -- "$staging_dir"' EXIT
  cat > "$staging_dir/server.cnf" <<'CONFIG'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = xuminghong.local
CONFIG
  cat > "$staging_dir/server.ext" <<CONFIG
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $subject_alt_names
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
CONFIG
  if [ -f "$tls_dir/server.key" ]; then
    cp "$tls_dir/server.key" "$staging_dir/server.key"
  else
    /usr/bin/openssl genrsa -out "$staging_dir/server.key" 2048 2>/dev/null
  fi
  /usr/bin/openssl req -new -sha256 -key "$staging_dir/server.key" \
    -config "$staging_dir/server.cnf" -out "$staging_dir/server.csr" 2>/dev/null
  /usr/bin/openssl x509 -req -sha256 -days 365 -in "$staging_dir/server.csr" \
    -CA "$tls_dir/root-ca.crt" -CAkey "$tls_dir/root-ca.key" -CAcreateserial \
    -extfile "$staging_dir/server.ext" -out "$staging_dir/server.crt" 2>/dev/null
  /usr/bin/openssl verify -CAfile "$tls_dir/root-ca.crt" "$staging_dir/server.crt" >/dev/null
  chmod 600 "$staging_dir/server.key" "$staging_dir/server.crt"
  for name in server.key server.crt server.cnf server.ext server.csr; do
    mv "$staging_dir/$name" "$tls_dir/$name"
  done
fi
/usr/bin/openssl verify -CAfile "$tls_dir/root-ca.crt" "$tls_dir/server.crt" >/dev/null
chmod 600 "$tls_dir/root-ca.key" "$tls_dir/server.key"
mkdir -p public
cp "$tls_dir/root-ca.crt" "public/openbuy-local-ca.crt"
chmod 644 "public/openbuy-local-ca.crt"
# Android debug trusts the project CA rather than a previously copied machine CA.
# Release trust settings stay unchanged; only the public certificate is copied.
if [ -d "android/exhibition" ]; then
  android_ca="android/exhibition/app/src/debug/res/raw/openbuy_local_ca.crt"
  if ! cmp -s "$tls_dir/root-ca.crt" "$android_ca"; then
    mkdir -p "$(dirname -- "$android_ca")"
    cp "$tls_dir/root-ca.crt" "$android_ca"
    chmod 644 "$android_ca"
    echo "Android 调试版公开 CA 已更新；请重新构建并安装 APK 后再连接本项目 HTTPS。"
  fi
fi
echo "证书已核验；SAN：${subject_alt_names}。未安装或修改任何系统信任。"
