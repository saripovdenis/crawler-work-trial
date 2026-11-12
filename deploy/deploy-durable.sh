#!/usr/bin/env bash
set -euo pipefail
echo 'Retired: release paths and feature branches are not deployable. Run sudo /usr/local/sbin/deploy-exa-master [full master SHA] on the VM.' >&2
exit 2
