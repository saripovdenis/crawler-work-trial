#!/usr/bin/env python3
"""Copy the crawler and reconciler SQLite files into the PostgreSQL crawl_budget and reconciler schemas.

The SQLite files are opened read-only and never changed. The schema must
already exist and be empty. PSQL may override the psql command line.
Usage: migrate-sqlite-to-postgres.py CRAWLER_SQLITE [RECONCILER_SQLITE]
"""
import csv, io, os, shlex, sqlite3, subprocess, sys

PSQL = shlex.split(os.environ.get('PSQL', 'psql -X -q -v ON_ERROR_STOP=1 -d crawler'))
CRAWLER = ['meta', 'sites', 'requests', 'robots', 'sources', 'candidates', 'articles', 'crawl_tasks',
           'attempt_assignments', 'scheduler_domains', 'article_aliases']
MONITOR = ['provider_state', 'provider_schedule', 'provider_runs', 'external_sightings', 'monitor_meta', 'audit_candidates']
ROWID = {'candidates', 'articles', 'audit_candidates'}
SERIAL = {'requests': 'id', 'crawl_tasks': 'id', 'provider_runs': 'id', 'external_sightings': 'id',
          'candidates': 'rowid', 'articles': 'rowid', 'audit_candidates': 'rowid'}

def schema(table): return 'reconciler' if table in MONITOR else 'crawl_budget'

def psql(sql):
    return subprocess.run(PSQL + ['-At', '-c', sql], check=True, capture_output=True, text=True).stdout.strip()

def copy(db, table):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
        print(f'{table}: not in source, skipped'); return
    info = db.execute(f'PRAGMA table_info({table})').fetchall()
    names = (['rowid'] if table in ROWID else []) + [column[1] for column in info]
    real = {column[1] for column in info if 'REAL' in (column[2] or '').upper()}
    process = subprocess.Popen(PSQL + ['-c', f"COPY {schema(table)}.{table} ({','.join(names)}) FROM STDIN WITH (FORMAT csv, NULL '\\N')"], stdin=subprocess.PIPE)
    writer = csv.writer(io.TextIOWrapper(process.stdin, encoding='utf-8', newline='', write_through=True))
    count = 0
    for row in db.execute(f"SELECT {','.join(names)} FROM {table}"):
        out = []
        for name, value in zip(names, row):
            if value is None: value = '\\N'
            elif isinstance(value, bytes): value = value.decode('utf-8', 'replace').replace('\x00', '')
            elif isinstance(value, str): value = value.replace('\x00', '')
            elif isinstance(value, float) and name not in real and value.is_integer(): value = int(value)
            out.append(value)
        writer.writerow(out); count += 1
    process.stdin.close()
    if process.wait() != 0: raise SystemExit(f'{table}: COPY failed')
    loaded = int(psql(f'SELECT count(*) FROM {schema(table)}.{table}'))
    if loaded != count: raise SystemExit(f'{table}: source has {count} rows, PostgreSQL has {loaded}')
    if table in SERIAL:
        column = SERIAL[table]
        psql(f"SELECT setval(pg_get_serial_sequence('{schema(table)}.{table}','{column}'), coalesce(max({column}),0)+1, false) FROM {schema(table)}.{table}")
    print(f'{table}: {count} rows')

def main():
    if len(sys.argv) < 2: raise SystemExit(__doc__)
    if int(psql('SELECT (SELECT count(*) FROM crawl_budget.requests)+(SELECT count(*) FROM crawl_budget.meta)')): raise SystemExit('Target schema is not empty')
    for path, tables in [(sys.argv[1], CRAWLER)] + ([(sys.argv[2], MONITOR)] if len(sys.argv) > 2 else []):
        db = sqlite3.connect('file:' + path + '?mode=ro', uri=True)
        db.text_factory = lambda value: value.decode('utf-8', 'replace')
        try:
            db.execute('BEGIN')   # one consistent read snapshot per file
            for table in tables: copy(db, table)
        finally: db.close()
    psql('ANALYZE')
    print('migration complete')

main()
