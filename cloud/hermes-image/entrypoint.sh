#!/usr/bin/env sh
set -eu

mkdir -p "${HERMES_HOME:-/data/hermes-home}" "${HOME:-/data/home}" "${TERMINAL_CWD:-/data/workspace}"

exec python -m mia_plugins gateway run --replace --accept-hooks
