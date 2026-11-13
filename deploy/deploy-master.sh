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
migrated=0
service_user=exa-crawler
marker=/var/lib/exa-crawler/deployments/postgres-cutover.json
archive_root=/var/lib/exa-crawler/sqlite-archive
pg() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }
as_service() { runuser -u "$service_user" -- env PGHOST=/var/run/postgresql PGDATABASE=crawler "$@"; }
rollback() {
  local result=$?
  trap - EXIT INT TERM
  rm -f "$archive"
  if (( result != 0 && cutover == 1 )); then
    echo 'Cutover failed; restoring previous service units. Database and budget history are not rolled back.' >&2
    # A failed first PostgreSQL release leaves SQLite as the live store. Drop
    # the partial copy so the next attempt loads it again from current SQLite.
    if (( migrated == 1 )) && [[ ! -e "$marker" ]]; then pg -d crawler -c 'DROP SCHEMA IF EXISTS crawl_budget CASCADE' -c 'DROP SCHEMA IF EXISTS reconciler CASCADE' || true; fi
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
# All rows live in PostgreSQL. Install it once; the service user owns one
# database and reaches it over the local socket with peer authentication.
command -v psql >/dev/null || { apt-get update -q; DEBIAN_FRONTEND=noninteractive apt-get install -y -q postgresql; }
systemctl enable --now postgresql
for _ in $(seq 1 30); do runuser -u postgres -- pg_isready -q && break; sleep 1; done
pg -At -c "SELECT 1 FROM pg_roles WHERE rolname='$service_user'" | grep -qx 1 || pg -c "CREATE ROLE \"$service_user\" LOGIN"
pg -At -c "SELECT 1 FROM pg_database WHERE datname='crawler'" | grep -qx 1 ||
  pg -c "CREATE DATABASE crawler OWNER \"$service_user\" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
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
python3 - "$release" "$commit" "$marker" <<'PY'
import datetime,json,os,pathlib,re,sqlite3,sys
release=pathlib.Path(sys.argv[1]); sha=sys.argv[2]; migrated=os.path.exists(sys.argv[3])
limits={'exa-crawler':{'MemoryMax':'2G'},'exa-observatory':{'MemoryMax':'2G','CPUQuota':'200%'},'exa-reconciler':{'MemoryMax':'512M'}}
previous=release/'deploy/previous-units'
old_dirs=[]
for unit in previous.glob('*.service'):
    match=re.search(r'^WorkingDirectory=(.+)$',unit.read_text(),re.M)
    if not match: raise RuntimeError(f'No WorkingDirectory in {unit}')
    old_dirs.append(match.group(1))
for unit in previous.glob('*.service'):
    text=unit.read_text()
    for old in sorted(set(old_dirs),key=len,reverse=True): text=text.replace(old,str(release))
    if unit.stem in ('exa-crawler','exa-fetch-worker'):
        timing_env=f'EnvironmentFile={release}/deploy/timing.env'
        if timing_env not in text:
            if '[Service]\n' not in text: raise RuntimeError(f'No Service section in {unit}')
            text=text.replace('[Service]\n',f'[Service]\n{timing_env}\n',1)
    if unit.stem in limits:
        # These three services use PostgreSQL over the local socket. Their old
        # memory limits were sized for a 2 GB machine.
        for line in ('Environment=PGDATABASE=crawler','Environment=PGHOST=/var/run/postgresql'):
            if line not in text: text=text.replace('[Service]\n',f'[Service]\n{line}\n',1)
        for line in ('Wants=postgresql.service','After=postgresql.service'):
            if line not in text: text=text.replace('[Unit]\n',f'[Unit]\n{line}\n',1)
        for key,value in limits[unit.stem].items():
            text,count=re.subn(rf'^{key}=.*$',f'{key}={value}',text,flags=re.M)
            if not count: raise RuntimeError(f'No {key} in {unit}')
    (release/'deploy/rendered'/unit.name).write_text(text)
# Before the first PostgreSQL release the live rows are still in SQLite.
if not migrated:
    for name,path in [('crawler','/var/lib/exa-crawler/data/crawler.sqlite'),('monitor','/var/lib/exa-crawler/reconciliation/reconciler.sqlite')]:
        source=sqlite3.connect('file:'+path+'?mode=ro',uri=True)
        target=sqlite3.connect(str(release/f'before-{name}.sqlite'))
        source.backup(target); target.close(); source.close()
(release/'release.json').write_text(json.dumps({'branch':'master','commit':sha,'directory':str(release),'preparedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
PY
if [[ -e "$marker" ]]; then runuser -u postgres -- pg_dump -Fc -n crawl_budget -n reconciler crawler > before-crawl_budget.dump; fi
systemd-analyze verify deploy/rendered/*.service
no_legacy_deploy
[[ "$(resolve_master)" == "$commit" ]] || { echo 'Master advanced during preparation. No services changed; rerun for the new master.' >&2; exit 2; }
# Refuse to overwrite a unit changed by an overlapping legacy deployment.
for unit in "${units[@]}"; do cmp -s "deploy/previous-units/$unit.service" "/etc/systemd/system/$unit.service"; done
cutover=1
# Keep a single executor. Durable charges and receipts survive this handoff.
systemctl stop exa-fetch-worker
systemctl stop exa-crawler exa-observatory exa-reconciler
if [[ ! -e "$marker" ]]; then
  # First PostgreSQL release. With every writer stopped, freeze a consistent
  # copy of both SQLite files and load PostgreSQL from that copy. The original
  # files are left in place, untouched, for the previous release.
  sqlite_archive="$archive_root/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$sqlite_archive"
  python3 - "$sqlite_archive" <<'PY'
import sqlite3,sys
for name,path in [('crawler','/var/lib/exa-crawler/data/crawler.sqlite'),('reconciler','/var/lib/exa-crawler/reconciliation/reconciler.sqlite')]:
    source=sqlite3.connect('file:'+path+'?mode=ro',uri=True)
    target=sqlite3.connect(f'{sys.argv[1]}/{name}.sqlite')
    source.backup(target); target.execute('PRAGMA journal_mode=DELETE'); target.close(); source.close()
PY
  chmod 0444 "$sqlite_archive"/*.sqlite
  chown -R "$service_user:$service_user" "$archive_root"
  migrated=1
  pg -d crawler -c 'DROP SCHEMA IF EXISTS crawl_budget CASCADE' -c 'DROP SCHEMA IF EXISTS reconciler CASCADE'
  as_service /usr/local/bin/node --import tsx tools/postgres/ensure-schema.ts
  as_service python3 deploy/migrate-sqlite-to-postgres.py "$sqlite_archive/crawler.sqlite" "$sqlite_archive/reconciler.sqlite"
  python3 - "$sqlite_archive/crawler.sqlite" > ledger-before.txt <<'PY'
import sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print('%d %d' % db.execute('SELECT count(*),coalesce(max(id),0) FROM requests').fetchone())
for row in db.execute('SELECT domain,started FROM sites ORDER BY domain'): print('%s %d' % row)
PY
else
  { pg -d crawler -At -c "SELECT count(*)||' '||coalesce(max(id),0) FROM crawl_budget.requests"
    pg -d crawler -At -c "SELECT domain||' '||started FROM crawl_budget.sites ORDER BY domain"; } > ledger-before.txt
fi
# Apply schema changes while nothing is connected, before any service starts.
as_service /usr/local/bin/node --import tsx tools/postgres/ensure-schema.ts
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
read -r ledger_count ledger_last < ledger-before.txt
[[ "$(pg -d crawler -At -c "SELECT count(*) FROM crawl_budget.requests WHERE id<=$ledger_last")" == "$ledger_count" ]]
diff <(tail -n +2 ledger-before.txt) <(pg -d crawler -At -c "SELECT domain||' '||started FROM crawl_budget.sites ORDER BY domain")
echo 'Existing request charges and site start times preserved'
if (( migrated == 1 )); then
  printf '{"commit":"%s","sqliteArchive":"%s","at":"%s"}\n' "$commit" "$sqlite_archive" "$(date -u +%FT%TZ)" > "$marker"
  echo "SQLite copies kept read-only in $sqlite_archive"
fi
install -m 0644 release.json /var/lib/exa-crawler/deployments/current.json
cutover=0
# Keep this release and the one it replaced (the rollback target); remove every
# other directory under /opt/exa-crawler. A pruning error never fails a deploy.
previous=$(sed -n 's/^WorkingDirectory=//p' deploy/previous-units/exa-crawler.service | head -n 1)
in_use=$(for unit in "${units[@]}"; do systemctl show "$unit" -p WorkingDirectory --value; done)
for old in /opt/exa-crawler/*/; do
  old=${old%/}
  [[ "$old" == "$release" || "$old" == "$previous" ]] && continue
  grep -qxF "$old" <<<"$in_use" && continue
  rm -rf --one-file-system -- "$old" && echo "Pruned $old" || echo "Could not prune $old" >&2
done
printf 'Deployed master %s to all four services: %s\n' "$commit" "$release"
