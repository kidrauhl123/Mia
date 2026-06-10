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

npm run open
