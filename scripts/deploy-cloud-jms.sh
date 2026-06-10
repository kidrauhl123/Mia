#!/usr/bin/env bash
# One-command production deploy through the company JumpServer, with no manual
# password prompt. Authentication comes from the macOS Keychain via
# scripts/jms-askpass.sh, so nothing secret lives in the repo or the logs.
#
# One-time setup (per machine):
#   security add-generic-password -U -s mia-jms-deploy -a zhangguiyu -w '<password>' -T /usr/bin/ssh
#   (the mia-jms-deploy Host block must exist in ~/.ssh/config)
#
# Usage:
#   bash scripts/deploy-cloud-jms.sh            # full deploy (runs local tests)
#   MIA_DEPLOY_DRY_RUN=1 bash scripts/deploy-cloud-jms.sh
#   MIA_DEPLOY_SKIP_LOCAL_TESTS=1 bash scripts/deploy-cloud-jms.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALIAS="${MIA_DEPLOY_REMOTE:-mia-jms-deploy}"

export SSH_ASKPASS="$ROOT/scripts/jms-askpass.sh"
export SSH_ASKPASS_REQUIRE=force
export MIA_DEPLOY_REMOTE="$ALIAS"
export MIA_DEBIAN_APT_MIRROR="${MIA_DEBIAN_APT_MIRROR:-https://mirrors.tencent.com/debian}"
export MIA_PIP_INDEX_URL="${MIA_PIP_INDEX_URL:-https://mirrors.tencent.com/pypi/simple}"

# Reuse a live bastion master connection when present; otherwise open one. The
# askpass helper supplies the JumpServer password from the Keychain, so this is
# non-interactive.
if ! ssh -O check "$ALIAS" >/dev/null 2>&1; then
  echo "[deploy-jms] opening JumpServer master connection ($ALIAS)…"
  ssh -MNf "$ALIAS"
fi
ssh "$ALIAS" 'true' >/dev/null

exec bash "$ROOT/scripts/deploy-cloud-release.sh" "$@"
