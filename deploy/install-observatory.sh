#!/usr/bin/env bash
set -euo pipefail
# Run on the existing crawler VM as root after extracting the release.
cd /opt/exa-crawler/layout-v1
npm ci --no-audit --no-fund
install -m 0644 deploy/exa-observatory.service /etc/systemd/system/exa-observatory.service
systemctl daemon-reload
systemctl enable --now exa-observatory
curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:4318/api/health
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
systemctl is-active exa-crawler exa-observatory caddy
