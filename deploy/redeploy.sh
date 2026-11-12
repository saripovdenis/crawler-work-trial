#!/usr/bin/env bash
set -euo pipefail
# Run as root on the existing VM, after uploading an immutable release with built UI.
release=$(realpath "${1:?Usage: sudo bash deploy/redeploy.sh /opt/exa-crawler/layout-COMMIT}")
[[ "$release" =~ ^/opt/exa-crawler/layout-[a-zA-Z0-9]+$ ]] || { echo 'Invalid release directory' >&2; exit 1; }
cd "$release"
test -f apps/dashboard/dist/index.html
test -f /var/lib/exa-crawler/data/crawler.sqlite
npm ci --no-audit --no-fund
python3 -m venv .venv
.venv/bin/pip install -r services/fetcher-impersonate/requirements.txt
npm run check
npm run check:boundaries
npm test
.venv/bin/python services/fetcher-impersonate/check-cffi.py
# Save exact previous units for rollback. No database changes or queue resets.
mkdir -p deploy/previous-units
for unit in exa-crawler exa-observatory; do
  cp "/etc/systemd/system/$unit.service" "deploy/previous-units/$unit.service"
  sed "s|/opt/exa-crawler/layout-v1|$release|g" "deploy/$unit.service" > "deploy/$unit.rendered.service"
done
systemd-analyze verify deploy/exa-crawler.rendered.service deploy/exa-observatory.rendered.service
for unit in exa-crawler exa-observatory; do
  install -m 0644 "deploy/$unit.rendered.service" "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl restart exa-crawler exa-observatory
curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:4318/api/health
systemctl is-active exa-crawler exa-observatory caddy
