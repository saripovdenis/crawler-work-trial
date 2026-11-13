#!/usr/bin/python3
"""Use the current committed release, including after a normal redeploy."""
import json
import os
from pathlib import Path

release = Path(json.loads(Path('/var/lib/exa-crawler/deployments/current.json').read_text())['directory']).resolve()
if release.parent != Path('/opt/exa-crawler') or not release.name.startswith('master-'):
    raise RuntimeError('Unexpected release directory')
script = release / 'tools/storage/verify-mirror.ts'
if not script.exists():
    raise SystemExit(0)  # Previous release during installation or rollback.
os.chdir(release)
os.execv('/usr/local/bin/node', ['node', '--import', 'tsx', str(script)])
