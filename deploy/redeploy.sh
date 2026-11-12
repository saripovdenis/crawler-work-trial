#!/usr/bin/env bash
set -euo pipefail
# Current architecture: private scheduler + fetch worker. Dashboard is unchanged.
exec bash "$(dirname "$0")/deploy-durable.sh" "$@"
