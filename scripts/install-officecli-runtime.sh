#!/usr/bin/env bash
set -euo pipefail

RUNTIME_HOME="${MIA_CLOUD_AGENT_OFFICECLI_HOME:-/opt/mia-agent-runtime/officecli}"
INSTALLER_MIRROR_URL="${MIA_OFFICECLI_INSTALLER_MIRROR_URL:-https://d.officecli.ai/install.sh}"
INSTALLER_FALLBACK_URL="${MIA_OFFICECLI_INSTALLER_FALLBACK_URL:-https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/v1.0.135/install.sh}"
INSTALLER_SHA256="${MIA_OFFICECLI_INSTALLER_SHA256:-2a0fdae06f4a018ea8d8516c69bfa5eeeb53406aacb5fa16fd07a9e572991bb6}"
OFFICECLI_BIN="$RUNTIME_HOME/.local/bin/officecli"
LOCK_DIR="${TMPDIR:-/tmp}/mia-officecli-runtime-install.lock"
LOCK_WAIT_SECONDS="${MIA_OFFICECLI_INSTALL_LOCK_WAIT_SECONDS:-330}"
lock_acquired=0
tmp_dir=""

cleanup() {
  if [ -n "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
  if [ "$lock_acquired" = "1" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -rf "$LOCK_DIR"
  fi
}
trap cleanup EXIT

officecli_version() {
  "$OFFICECLI_BIN" --version 2>/dev/null | head -n 1
}

if [ -x "$OFFICECLI_BIN" ] && version="$(officecli_version)" && [ -n "$version" ]; then
  echo "OfficeCLI runtime already ready: $version"
  exit 0
fi

command -v curl >/dev/null 2>&1 || {
  echo "OfficeCLI runtime installer requires curl." >&2
  exit 1
}

acquire_install_lock() {
  waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    case "$owner" in
      "")
        sleep 1
        owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
        if [ -z "$owner" ]; then
          rm -rf "$LOCK_DIR"
          continue
        fi
        ;;
      *[!0-9]*) rm -rf "$LOCK_DIR"; continue ;;
    esac
    case "$owner" in
      *[!0-9]*) rm -rf "$LOCK_DIR"; continue ;;
    esac
    if ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [ "$waited" -ge "$LOCK_WAIT_SECONDS" ]; then
      echo "Timed out waiting for another OfficeCLI installation to finish." >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  lock_acquired=1
}

acquire_install_lock
if [ -x "$OFFICECLI_BIN" ] && version="$(officecli_version)" && [ -n "$version" ]; then
  echo "OfficeCLI runtime already ready: $version"
  exit 0
fi

checksum_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

download_installer() {
  url="$1"
  output="$2"
  curl -fsSL --connect-timeout 5 --max-time 60 "$url" -o "$output"
}

verify_installer() {
  file="$1"
  actual="$(checksum_file "$file")"
  if [ "$actual" != "$INSTALLER_SHA256" ]; then
    echo "OfficeCLI installer checksum mismatch: expected $INSTALLER_SHA256, got $actual" >&2
    return 1
  fi
}

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/mia-officecli-installer.XXXXXX")"
installer="$tmp_dir/install.sh"

echo "Downloading OfficeCLI installer from the China mirror..."
if ! download_installer "$INSTALLER_MIRROR_URL" "$installer" || ! verify_installer "$installer"; then
  rm -f "$installer"
  echo "China mirror unavailable or invalid; falling back to the pinned upstream installer..."
  download_installer "$INSTALLER_FALLBACK_URL" "$installer"
  verify_installer "$installer"
fi

mkdir -p "$RUNTIME_HOME"
HOME="$RUNTIME_HOME" PATH="$RUNTIME_HOME/.local/bin:$PATH" bash "$installer"

if [ ! -x "$OFFICECLI_BIN" ] || ! version="$(officecli_version)" || [ -z "$version" ]; then
  echo "OfficeCLI installer completed without a working binary at $OFFICECLI_BIN" >&2
  exit 1
fi

chmod -R a+rX "$RUNTIME_HOME"
echo "OfficeCLI runtime ready: $version"
