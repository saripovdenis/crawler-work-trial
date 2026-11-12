#!/usr/bin/env bash
set -euo pipefail
# This is an operational release command, not a publisher-site validation run.
if (( $# > 1 )) || { (( $# == 1 )) && [[ ! "$1" =~ ^[0-9a-f]{40}$ ]]; }; then
  echo 'Only the current origin/master commit is deployable. Usage: deploy-exa-master [full master SHA]' >&2
  exit 2
fi
[[ $EUID == 0 ]] || { echo 'Run on the VM with sudo.' >&2; exit 2; }
umask 022
mkdir -p /opt/exa-crawler /var/lib/exa-crawler/deployments
exec 9>/run/lock/exa-crawler-deploy.lock
flock -n 9 || { echo 'Another master deployment holds the lock.' >&2; exit 2; }
repository=saripovdenis/crawler-work-trial
resolve_master() {
  curl --fail --silent --show-error --max-time 30 "https://api.github.com/repos/$repository/git/ref/heads/master" |
    python3 -c 'import json,re,sys; s=json.load(sys.stdin)["object"]["sha"]; assert re.fullmatch("[0-9a-f]{40}",s); print(s)'
}
no_legacy_deploy() {
  local pid
  for pid in $(pgrep -f '^bash (/opt/exa-crawler/.*/deploy/(deploy-|redeploy|install-)|/tmp/(deploy-|restore-freshness))' || true); do
    [[ "$pid" == "$$" ]] || { echo "Legacy deployment $pid is running; wait for it to finish." >&2; return 1; }
  done
}
no_legacy_deploy
commit=$(resolve_master)
[[ $# == 0 || "$1" == "$commit" ]] || { echo "Rejected: $1 is not current origin/master ($commit)." >&2; exit 2; }
release="/opt/exa-crawler/master-${commit:0:12}-$(date -u +%Y%m%d%H%M%S)"
mkdir "$release"
archive=$(mktemp /tmp/exa-master.XXXXXX.tar.gz)
units=(exa-crawler exa-fetch-worker exa-observatory exa-reconciler)
cutover=0
rollback() {
  local result=$?
  trap - EXIT INT TERM
  rm -f "$archive"
  if (( result != 0 && cutover == 1 )); then
    echo 'Cutover failed; restoring previous service units. Database and budget history are not rolled back.' >&2
    systemctl stop exa-fetch-worker || true
    systemctl stop exa-crawler exa-observatory exa-reconciler || true
    for unit in "${units[@]}"; do
      install -m 0644 "$release/deploy/previous-units/$unit.service" "/etc/systemd/system/$unit.service"
    done
    systemctl daemon-reload
    systemctl start exa-crawler exa-observatory exa-reconciler
    systemctl start exa-fetch-worker
  fi
  exit "$result"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl --fail --silent --show-error --location --max-time 120 "https://codeload.github.com/$repository/tar.gz/$commit" -o "$archive"
tar -xzf "$archive" --strip-components=1 -C "$release"
# The installed entrypoint must itself be the committed master version.
cmp -s "$0" "$release/deploy/deploy-master.sh" || {
  echo 'Update /usr/local/sbin/deploy-exa-master from current master before deploying.' >&2; exit 2;
}
cd "$release"
npm ci --no-audit --no-fund
npm --prefix apps/dashboard ci --no-audit --no-fund
npm run check
npm run check:boundaries
NODE_OPTIONS=--max-old-space-size=512 npm run dashboard:build
python3 -m venv .venv
.venv/bin/pip install --disable-pip-version-check -r services/fetcher-impersonate/requirements.txt
.venv/bin/python -c 'from curl_cffi import requests; print("Python transport import OK")'
test -s apps/dashboard/dist/index.html
test -s /etc/exa-reconciler.env
mkdir -p deploy/previous-units deploy/rendered
for unit in "${units[@]}"; do
  cp "/etc/systemd/system/$unit.service" "deploy/previous-units/$unit.service"
done
python3 - "$release" "$commit" <<'PY'
import datetime,json,pathlib,re,sqlite3,sys
release=pathlib.Path(sys.argv[1]); sha=sys.argv[2]
previous=release/'deploy/previous-units'
old_dirs=[]
for unit in previous.glob('*.service'):
    match=re.search(r'^WorkingDirectory=(.+)$',unit.read_text(),re.M)
    if not match: raise RuntimeError(f'No WorkingDirectory in {unit}')
    old_dirs.append(match.group(1))
for unit in previous.glob('*.service'):
    text=unit.read_text()
    for old in sorted(set(old_dirs),key=len,reverse=True): text=text.replace(old,str(release))
    (release/'deploy/rendered'/unit.name).write_text(text)
for name,path in [('crawler','/var/lib/exa-crawler/data/crawler.sqlite'),('monitor','/var/lib/exa-crawler/reconciliation/reconciler.sqlite')]:
    source=sqlite3.connect('file:'+path+'?mode=ro',uri=True)
    target=sqlite3.connect(str(release/f'before-{name}.sqlite'))
    source.backup(target); target.close(); source.close()
(release/'release.json').write_text(json.dumps({'branch':'master','commit':sha,'directory':str(release),'preparedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
PY
systemd-analyze verify deploy/rendered/*.service
no_legacy_deploy
[[ "$(resolve_master)" == "$commit" ]] || { echo 'Master advanced during preparation. No services changed; rerun for the new master.' >&2; exit 2; }
# Refuse to overwrite a unit changed by an overlapping legacy deployment.
for unit in "${units[@]}"; do cmp -s "deploy/previous-units/$unit.service" "/etc/systemd/system/$unit.service"; done
cutover=1
# Keep a single executor. Durable charges and receipts survive this handoff.
systemctl stop exa-fetch-worker
systemctl stop exa-crawler exa-observatory exa-reconciler
for unit in "${units[@]}"; do install -m 0644 "deploy/rendered/$unit.service" "/etc/systemd/system/$unit.service"; done
systemctl daemon-reload
systemctl start exa-crawler exa-observatory exa-reconciler
health=(--fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 2 --connect-timeout 2 --max-time 10)
curl "${health[@]}" http://127.0.0.1:4319/internal/health > scheduler-health.json
systemctl start exa-fetch-worker
curl "${health[@]}" http://127.0.0.1:4318/api/health > api-health.json
# One long read avoids piling up abandoned expensive requests on the small VM.
curl --fail --silent --show-error --max-time 180 'http://127.0.0.1:4318/api/freshness?window=1h' > freshness-health.json
node --input-type=module -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync("freshness-health.json")); if(!r.ready || !r.freshness?.overall?.published || r.groups.some(g=>!g.publication_timing)) throw Error("Freshness health check failed"); console.log({ready:r.ready,records:r.groupCount});'
curl --fail --silent --show-error --max-time 30 http://127.0.0.1:4318/freshness > page-health.html
cmp page-health.html apps/dashboard/dist/index.html
systemctl is-active "${units[@]}"
for unit in "${units[@]}"; do [[ "$(systemctl show "$unit" -p WorkingDirectory --value)" == "$release" ]]; done
python3 - <<'PY'
import sqlite3
before=sqlite3.connect('file:before-crawler.sqlite?mode=ro',uri=True)
after=sqlite3.connect('file:/var/lib/exa-crawler/data/crawler.sqlite?mode=ro',uri=True)
count,last=before.execute('SELECT count(*),max(id) FROM requests').fetchone()
assert after.execute('SELECT count(*) FROM requests WHERE id<=?',(last,)).fetchone()[0]==count
assert list(before.execute('SELECT domain,started FROM sites ORDER BY domain'))==list(after.execute('SELECT domain,started FROM sites ORDER BY domain'))
print('Existing request charges and site start times preserved')
PY
install -m 0644 release.json /var/lib/exa-crawler/deployments/current.json
cutover=0
printf 'Deployed master %s to all four services: %s\n' "$commit" "$release"
