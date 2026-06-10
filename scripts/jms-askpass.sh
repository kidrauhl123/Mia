#!/usr/bin/env bash
# SSH askpass helper for the company JumpServer deploy path.
#
# Reads the JumpServer password from the macOS login Keychain instead of a
# prompt or a plaintext file, so `npm run cloud:deploy:jms` can authenticate
# non-interactively without any secret living in the repo.
#
# Store / rotate the secret with:
#   security add-generic-password -U -s mia-jms-deploy -a zhangguiyu -w '<password>' -T /usr/bin/ssh
#
# SSH invokes this script (via SSH_ASKPASS) and uses whatever it prints on
# stdout as the password. It must print only the secret, nothing else.
set -euo pipefail
exec security find-generic-password -s "mia-jms-deploy" -a "zhangguiyu" -w
