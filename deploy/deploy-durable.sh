#!/usr/bin/env bash
set -euo pipefail
release=$(realpath "${1:?Usage: sudo bash deploy/deploy-durable.sh /opt/exa-crawler/durable-COMMIT}")
[[ "$release" =~ ^/opt/exa-crawler/durable-[a-zA-Z0-9]+$ ]] || exit 1
cd "$release"
npm ci --no-audit --no-fund
python3 -m venv .venv
.venv/bin/pip install -r services/fetcher-impersonate/requirements.txt
npm run check
npm run check:boundaries
mkdir -p deploy/previous-units
cp /etc/systemd/system/exa-crawler.service deploy/previous-units/
if test -f /etc/systemd/system/exa-fetch-worker.service; then cp /etc/systemd/system/exa-fetch-worker.service deploy/previous-units/; fi
for unit in exa-crawler exa-fetch-worker; do
  sed "s|/opt/exa-crawler/layout-v1|$release|g" "deploy/$unit.service" > "deploy/$unit.rendered.service"
done
systemd-analyze verify deploy/exa-crawler.rendered.service deploy/exa-fetch-worker.rendered.service
# Stop the executor first on subsequent deployments. Never overlap old/new loops.
if systemctl is-active --quiet exa-fetch-worker; then systemctl stop exa-fetch-worker; fi
systemctl stop exa-crawler
systemctl is-active --quiet exa-crawler && exit 1
python3 - <<'PY'
import sqlite3
source=sqlite3.connect('file:/var/lib/exa-crawler/data/crawler.sqlite?mode=ro',uri=True)
target=sqlite3.connect('before-cutover.sqlite');source.backup(target);target.close();source.close()
PY
install -d -o exa-crawler -g exa-crawler -m 0700 /var/lib/exa-crawler/data/receipts
for unit in exa-crawler exa-fetch-worker; do install -m 0644 "deploy/$unit.rendered.service" "/etc/systemd/system/$unit.service"; done
systemctl daemon-reload
systemctl start exa-crawler
curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 1 http://127.0.0.1:4319/internal/health
systemctl enable --now exa-fetch-worker
systemctl is-active exa-crawler exa-fetch-worker exa-observatory caddy
