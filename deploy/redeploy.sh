#!/usr/bin/env bash
set -euo pipefail
# The root-owned VM entrypoint fetches and builds only current origin/master.
exec /usr/local/sbin/deploy-exa-master "$@"
