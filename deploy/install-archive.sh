#!/usr/bin/env bash
# Invoked by deploy-master.sh before the existing four-process cutover.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'This pinned binary is for x86_64.' >&2; exit 1; }
umask 077
binary=/usr/local/lib/garage/garage-2.5.0
install -d -m 0755 /usr/local/lib/garage
if [[ ! -x "$binary" ]]; then
  temp=$(mktemp)
  trap 'rm -f "$temp"' EXIT
  curl --fail --silent --show-error --location --max-time 300 https://garagehq.deuxfleurs.fr/_releases/v2.5.0/x86_64-unknown-linux-musl/garage -o "$temp"
  # SHA is pinned from the official release, not a moving image tag.
  echo '2ff667286217cd73ebcb1c03af993822365000441dfe31a80cb64c5189a9dea8'"  $temp" | sha256sum -c -
  install -m 0755 "$temp" "$binary"
fi
echo '2ff667286217cd73ebcb1c03af993822365000441dfe31a80cb64c5189a9dea8'"  $binary" | sha256sum -c -
"$binary" --version
id -u exa-archive >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin exa-archive
install -d -o exa-archive -g exa-archive -m 0700 /var/lib/exa-crawler/garage
if [[ ! -f /etc/exa-archive.toml ]]; then
  python3 - <<'PY'
import pathlib,secrets
pathlib.Path('/etc/exa-archive.toml').write_text('''metadata_dir = "/var/lib/exa-crawler/garage/meta"
data_dir = "/var/lib/exa-crawler/garage/data"
db_engine = "lmdb"
replication_factor = 1
metadata_fsync = true
data_fsync = true
metadata_auto_snapshot_interval = "6h"
block_ram_buffer_max = "32MiB"
rpc_bind_addr = "127.0.0.1:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "''' + secrets.token_hex(32) + '''"
[s3_api]
s3_region = "garage"
api_bind_addr = "127.0.0.1:3900"
''')
PY
  chown root:exa-archive /etc/exa-archive.toml
  chmod 0640 /etc/exa-archive.toml
fi
if ! cmp -s deploy/exa-archive.service /etc/systemd/system/exa-archive.service; then
  install -m 0644 deploy/exa-archive.service /etc/systemd/system/exa-archive.service
  systemctl daemon-reload
fi
systemctl enable --now exa-archive
for _ in $(seq 1 30); do "$binary" -c /etc/exa-archive.toml status >/dev/null 2>&1 && break; sleep 1; done
python3 - <<'PY'
import os,pathlib,re,subprocess
cmd=['/usr/local/lib/garage/garage-2.5.0','-c','/etc/exa-archive.toml']
def run(*args):
    result=subprocess.run(cmd+list(args),text=True,capture_output=True,env={**os.environ,'RUST_LOG':'error'})
    if result.returncode: raise RuntimeError('Garage command failed: '+args[0])
    return result.stdout
try: run('bucket','info','response-archive')
except RuntimeError: run('bucket','create','response-archive')
for role in ('writer','reader'):
    path=pathlib.Path('/etc/exa-archive-'+role+'.env')
    if path.exists(): continue
    name='exa-archive-'+role
    try: output=run('key','info','--show-secret',name)
    except RuntimeError: output=run('key','create',name)
    key=re.search(r'Key ID:\s*(\S+)',output,re.I)
    secret=re.search(r'Secret key:\s*(\S+)',output,re.I)
    if not key or not secret: raise RuntimeError('Cannot parse Garage key output')
    run('bucket','allow','--key',key[1],'--write' if role=='writer' else '--read','response-archive')
    content=f'ARCHIVE_S3_ENDPOINT=http://127.0.0.1:3900\nARCHIVE_S3_REGION=garage\nARCHIVE_S3_BUCKET=response-archive\nARCHIVE_S3_ACCESS_KEY={key[1]}\nARCHIVE_S3_SECRET_KEY={secret[1]}\n'
    if role=='writer': content+='ARCHIVE_MIRROR=1\n'
    path.write_text(content);path.chmod(0o600)
print('Archive ready; writer/read-only credentials stored in root-only environment files.')
PY
