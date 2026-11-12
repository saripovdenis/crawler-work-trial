#!/usr/bin/env bash
set -euo pipefail
release=$(realpath "${1:?Usage: sudo bash deploy/deploy-reconciler.sh /opt/exa-crawler/reconcile-COMMIT}")
[[ "$release" =~ ^/opt/exa-crawler/reconcile-[a-zA-Z0-9]+$ ]] || exit 1
units=(exa-crawler exa-observatory)
case "${2:-}" in
  "") ;;
  --dashboard-monitor-only) units=(exa-observatory) ;;
  *) echo "Unknown deployment mode" >&2; exit 1 ;;
esac
cd "$release"
test -s /etc/exa-reconciler.env
test -s apps/dashboard/dist/index.html
npm ci --no-audit --no-fund
npm run check
npm run check:boundaries
# Run the full offline suite before packaging; avoid competing with the live crawler here.
install -d -o exa-crawler -g exa-crawler -m 0700 /var/lib/exa-crawler/reconciliation
mkdir -p deploy/previous-units
for unit in "${units[@]}"; do
  cp "/etc/systemd/system/$unit.service" deploy/previous-units/
  # Preserve existing limits, ports and hardening; only change the code path and DB reference.
  sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$release|" -e '/^Environment=RECONCILER_DB=/d' \
    -e '/^Environment=NODE_ENV=/a Environment=RECONCILER_DB=/var/lib/exa-crawler/reconciliation/reconciler.sqlite' \
    "deploy/previous-units/$unit.service" > "deploy/$unit.rendered.service"
done
if test -f /etc/systemd/system/exa-reconciler.service; then cp /etc/systemd/system/exa-reconciler.service deploy/previous-units/; fi
sed "s|/opt/exa-crawler/reconcile-v1|$release|g" deploy/exa-reconciler.service > deploy/exa-reconciler.rendered.service
rendered=(deploy/exa-reconciler.rendered.service)
for unit in "${units[@]}"; do rendered+=("deploy/$unit.rendered.service"); done
systemd-analyze verify "${rendered[@]}"
for unit in "${units[@]}" exa-reconciler; do
  install -m 0644 "deploy/$unit.rendered.service" "/etc/systemd/system/$unit.service"
done
python3 - <<'BACKUP'
import sqlite3, os
source=sqlite3.connect('file:/var/lib/exa-crawler/data/crawler.sqlite?mode=ro',uri=True)
target=sqlite3.connect('before-reconciler.sqlite');source.backup(target);target.close();source.close()
monitor='/var/lib/exa-crawler/reconciliation/reconciler.sqlite'
if os.path.exists(monitor):
    source=sqlite3.connect('file:'+monitor+'?mode=ro',uri=True)
    target=sqlite3.connect('before-monitor.sqlite');source.backup(target);target.close();source.close()
BACKUP
systemctl daemon-reload
# Scheduler restart does not stop the worker. Durable receipts survive the handoff.
# No schema change, backfill, budget reset, or change to the worker's release.
systemctl restart "${units[@]}"
systemctl enable exa-reconciler
systemctl restart exa-reconciler
# Existing scheduler startup scans can take over 20 seconds on the small VM.
health_options=(--fail --silent --show-error --retry 120 --retry-connrefused --retry-delay 1 --retry-max-time 180 --connect-timeout 2 --max-time 10)
curl "${health_options[@]}" http://127.0.0.1:4319/internal/health
curl "${health_options[@]}" http://127.0.0.1:4318/api/reconciliation --output reconcile-health.json
node -e 'const v=require("./reconcile-health.json"); console.log({ready:v.ready,summary:v.summary})'
python3 - <<'VERIFY'
import sqlite3
before=sqlite3.connect('file:before-reconciler.sqlite?mode=ro',uri=True)
after=sqlite3.connect('file:/var/lib/exa-crawler/data/crawler.sqlite?mode=ro',uri=True)
assert list(before.execute("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")) == list(after.execute("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"))
assert list(before.execute('SELECT domain,started FROM sites ORDER BY domain')) == list(after.execute('SELECT domain,started FROM sites ORDER BY domain'))
count,last=before.execute('SELECT count(*),max(id) FROM requests').fetchone()
assert after.execute('SELECT count(*) FROM requests WHERE id<=?',(last,)).fetchone()[0] == count
assert after.execute('SELECT count(*) FROM articles').fetchone()[0] >= before.execute('SELECT count(*) FROM articles').fetchone()[0]
print('Existing schema, start times, request charges and articles preserved')
VERIFY
systemctl is-active exa-crawler exa-fetch-worker exa-observatory exa-reconciler caddy
