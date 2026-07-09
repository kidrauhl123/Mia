#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # Double-clicked .command files run under bash and may not load zsh/nvm setup.
  # Load nvm explicitly so npm-installed CLIs under ~/.nvm are visible.
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  NODE_READY=0
  NODE_CANDIDATES=()
  if [ -n "${MIA_NODE_VERSION:-}" ]; then
    NODE_CANDIDATES+=("$MIA_NODE_VERSION")
  fi
  NODE_CANDIDATES+=("24" "22" "20" "default")
  for node_version in "${NODE_CANDIDATES[@]}"; do
    if nvm use --silent "$node_version" >/dev/null 2>&1 && node --version >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
      NODE_READY=1
      break
    fi
  done
  if [ "$NODE_READY" != "1" ]; then
    nvm use --silent default >/dev/null 2>&1 || true
  fi
fi

PATH_CANDIDATES=(
  "$HOME/.nvm/current/bin"
  "$HOME/.local/bin"
  "$HOME/.npm-global/bin"
  "$HOME/.bun/bin"
  "$HOME/.deno/bin"
  "$HOME/.cargo/bin"
  "$HOME/Library/pnpm"
  "/opt/homebrew/bin"
  "/usr/local/bin"
  "/usr/bin"
  "/bin"
  "/usr/sbin"
  "/sbin"
)

macos_major=""
if command -v sw_vers >/dev/null 2>&1; then
  macos_major="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)"
fi

node_bin_supported() {
  local node_bin="$1"
  local version_dir
  local major
  version_dir="$(basename "$(dirname "$(dirname "$node_bin")")")"
  major="${version_dir#v}"
  major="${major%%.*}"
  if [[ "$OSTYPE" == darwin* ]] && [[ "$macos_major" =~ ^[0-9]+$ ]] && [[ "$major" =~ ^[0-9]+$ ]]; then
    if [ "$macos_major" -lt 13 ] && [ "$major" -ge 26 ]; then
      return 1
    fi
  fi
  return 0
}

if [ -d "$HOME/.nvm/versions/node" ]; then
  while IFS= read -r node_bin; do
    if [ -x "$node_bin/node" ] && node_bin_supported "$node_bin/node" && "$node_bin/node" --version >/dev/null 2>&1; then
      PATH_CANDIDATES+=("$node_bin")
    fi
  done < <(find "$HOME/.nvm/versions/node" -maxdepth 2 -type d -name bin 2>/dev/null | sort -r)
fi

for dir in "${PATH_CANDIDATES[@]}"; do
  if [ -d "$dir" ]; then
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) export PATH="$dir:$PATH" ;;
    esac
  fi
done

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js/npm or make npm available in PATH, then run this again."
  exit 127
fi

if [ ! -d "node_modules/electron" ]; then
  echo "Installing Mia dependencies..."
  npm install
fi

CORE_PLATFORM="$(node -p "process.platform" 2>/dev/null || echo darwin)"
CORE_ARCH="$(node -p "process.arch" 2>/dev/null || echo arm64)"
CORE_EXE="mia-core"
if [ "$CORE_PLATFORM" = "win32" ]; then
  CORE_EXE="mia-core.exe"
fi

CORE_CANDIDATES=(
  "resources/bundled-mia-core/${CORE_PLATFORM}-${CORE_ARCH}/${CORE_EXE}"
  "target/debug/${CORE_EXE}"
  "target/release/${CORE_EXE}"
)

core_ready() {
  for core_candidate in "${CORE_CANDIDATES[@]}"; do
    if [ -x "$core_candidate" ]; then
      return 0
    fi
  done
  return 1
}

build_mia_core_locally() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo not found. Install Rust or publish the prebuilt Mia Core release first."
    return 127
  fi
  echo "Building Mia Core locally for development..."
  CARGO_REGISTRIES_CRATES_IO_PROTOCOL="${CARGO_REGISTRIES_CRATES_IO_PROTOCOL:-sparse}" \
  CARGO_HTTP_TIMEOUT="${CARGO_HTTP_TIMEOUT:-60}" \
  cargo build -p mia-core-app --bin mia-core
}

if ! core_ready; then
  echo "Preparing Mia Core prebuilt binary..."
  if ! npm run core:prepare || ! core_ready; then
    echo
    echo "Prebuilt Mia Core is unavailable; trying a local development build."
    if ! build_mia_core_locally || ! core_ready; then
      echo
      echo "Mia Core binary is not ready."
      echo "Run one of these, then open Mia again:"
      echo "  npm run core:prepare"
      echo "  MIA_CORE_RS_BIN=/path/to/mia-core npm run core:prepare"
      echo "  cargo build -p mia-core-app --bin mia-core"
      exit 1
    fi
  fi
fi

npm run open
