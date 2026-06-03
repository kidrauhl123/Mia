#!/usr/bin/env bash
set -euo pipefail

# Build a distributable Hermes runtime folder for embedding into Electron.
# Mirrors lobsterai/scripts/build-openclaw-runtime.sh, adapted for Python.
#
# Layout produced under vendor/hermes-runtime/<target-id>/:
#   python/        <- relocatable Python from python-build-standalone
#   site-packages/ <- hermes-agent[web] + transitive deps (pip --target)
#   runtime-build-info.json
#
# Usage:
#   bash scripts/build-hermes-runtime.sh [target-id]
# target-id: mac-arm64 | mac-x64 | linux-x64 | win-x64
# Environment overrides:
#   HERMES_VERSION       (default: package.json's hermes.version)
#   PYTHON_VERSION       (default: package.json's hermes.pythonVersion, e.g. 3.11.10)
#   PBS_RELEASE          python-build-standalone release tag (default: 20251007)
#   PBS_MIRROR_URL       optional mirror prefix; if set, fetch from this URL
#                        instead of github.com/astral-sh/python-build-standalone
#   PIP_INDEX_URL        optional pip mirror (e.g. https://mirrors.aliyun.com/pypi/simple)
#   OUT_DIR              override output dir

TARGET_ID="${1:-mac-arm64}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/vendor/hermes-runtime/$TARGET_ID}"

# ---------------------------------------------------------------------------
# Target → platform/arch/python-build-standalone triple
# ---------------------------------------------------------------------------
case "$TARGET_ID" in
  mac-arm64)   PBS_TRIPLE="aarch64-apple-darwin"; PIP_PLATFORM="macosx_11_0_arm64";;
  mac-x64)     PBS_TRIPLE="x86_64-apple-darwin";  PIP_PLATFORM="macosx_11_0_x86_64";;
  linux-x64)   PBS_TRIPLE="x86_64-unknown-linux-gnu"; PIP_PLATFORM="manylinux2014_x86_64";;
  win-x64)     PBS_TRIPLE="x86_64-pc-windows-msvc"; PIP_PLATFORM="win_amd64";;
  *)
    echo "Unknown target: $TARGET_ID (expected mac-arm64|mac-x64|linux-x64|win-x64)" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Read pinned versions from package.json
# ---------------------------------------------------------------------------
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1" >&2; exit 1; }
}
need_cmd node
need_cmd curl
need_cmd tar

HERMES_VERSION="${HERMES_VERSION:-$(node -e "process.stdout.write(require(\"$ROOT/package.json\").hermes?.version || \"\")")}"
PYTHON_VERSION="${PYTHON_VERSION:-$(node -e "process.stdout.write(require(\"$ROOT/package.json\").hermes?.pythonVersion || \"3.11.10\")")}"
PBS_RELEASE="${PBS_RELEASE:-20251007}"

if [[ -z "$HERMES_VERSION" ]]; then
  echo "package.json hermes.version is not set; set it (e.g. 0.13.0) or pass HERMES_VERSION env" >&2
  exit 1
fi

PBS_URL_BASE="${PBS_MIRROR_URL:-https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE}"
PBS_TARBALL="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${PBS_TRIPLE}-install_only.tar.gz"
PBS_URL="${PBS_URL_BASE}/${PBS_TARBALL}"

echo "[hermes-runtime] target=$TARGET_ID hermes=$HERMES_VERSION python=$PYTHON_VERSION pbs=$PBS_RELEASE"

# ---------------------------------------------------------------------------
# Cache check
# ---------------------------------------------------------------------------
BUILD_INFO="$OUT_DIR/runtime-build-info.json"
if [[ -f "$BUILD_INFO" && "${HERMES_FORCE_BUILD:-}" != "1" ]]; then
  CACHED=$(node -e "try { const i = require(\"$BUILD_INFO\"); console.log(i.hermesVersion + ':' + i.pythonVersion + ':' + i.target); } catch {}")
  WANT="$HERMES_VERSION:$PYTHON_VERSION:$TARGET_ID"
  if [[ "$CACHED" == "$WANT" ]]; then
    echo "[hermes-runtime] cached ($WANT) — skipping. HERMES_FORCE_BUILD=1 to rebuild."
    exit 0
  fi
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hermes-runtime.XXXXXX")"
PBS_DOWNLOAD="$WORK_DIR/python.tar.gz"
PY_DIR="$WORK_DIR/python"
mkdir -p "$PY_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

# ---------------------------------------------------------------------------
# 1. Download python-build-standalone
# ---------------------------------------------------------------------------
echo "[1/4] Downloading Python: $PBS_URL"
curl -fLo "$PBS_DOWNLOAD" "$PBS_URL"
tar -xzf "$PBS_DOWNLOAD" -C "$PY_DIR" --strip-components=1
PYTHON_BIN="$PY_DIR/bin/python3"
if [[ "$TARGET_ID" == win-* ]]; then
  PYTHON_BIN="$PY_DIR/python.exe"
fi
[[ -x "$PYTHON_BIN" ]] || { echo "Python binary missing at $PYTHON_BIN after extract" >&2; exit 1; }
"$PYTHON_BIN" --version

# ---------------------------------------------------------------------------
# 2. pip install hermes-agent[web] @ pinned version, vendor into site-packages
# ---------------------------------------------------------------------------
SITE_PACKAGES="$WORK_DIR/site-packages"
mkdir -p "$SITE_PACKAGES"

# Detect host vs target — only run "native" install when they match. Cross-arch
# install requires --platform/--only-binary and a different code path that
# pip handles poorly with source-distributed packages like hermes-agent itself.
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"
case "$HOST_OS:$HOST_ARCH" in
  darwin:arm64)   HOST_TARGET="mac-arm64";;
  darwin:x86_64)  HOST_TARGET="mac-x64";;
  linux:x86_64)   HOST_TARGET="linux-x64";;
  # Windows under git-bash/msys reports uname -s as MINGW64_NT-* / MSYS_NT-* /
  # CYGWIN_NT-* (lowercased here). GitHub's windows-latest runner is x86_64, so
  # this is the in-CI path that builds the win-x64 runtime on its native host.
  mingw*:x86_64|msys*:x86_64|cygwin*:x86_64) HOST_TARGET="win-x64";;
  *)              HOST_TARGET="";;
esac
if [[ -z "$HOST_TARGET" || "$HOST_TARGET" != "$TARGET_ID" ]]; then
  echo "[hermes-runtime] cross-arch install (host=$HOST_OS:$HOST_ARCH, target=$TARGET_ID) is not yet supported by this script." >&2
  echo "[hermes-runtime] Run the build on a $TARGET_ID machine." >&2
  exit 1
fi

# Hermes pip spec — pull from GitHub archive at the pinned tag, with [web] extra.
HERMES_SPEC="hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/refs/tags/v${HERMES_VERSION}.tar.gz"

echo "[2/4] pip install $HERMES_SPEC → $SITE_PACKAGES"
PIP_ARGS=(
  -m pip install
  --no-cache-dir
  --target "$SITE_PACKAGES"
  --retries 5
  --timeout 60
)
if [[ -n "${PIP_INDEX_URL:-}" ]]; then
  PIP_ARGS+=(--index-url "$PIP_INDEX_URL" --extra-index-url https://pypi.org/simple)
fi
# gateway.platforms.api_server (the HTTP interface Mia talks to) imports aiohttp,
# but the hermes-agent[web] extra only pulls fastapi/uvicorn — aiohttp must be
# installed explicitly or the API server silently refuses to start ("aiohttp not
# installed") and the engine never passes its health check.
PIP_ARGS+=("$HERMES_SPEC" "aiohttp")
"$PYTHON_BIN" "${PIP_ARGS[@]}"

# ---------------------------------------------------------------------------
# 3. Sanity check: required modules import in the bundled site-packages
# ---------------------------------------------------------------------------
echo "[3/4] Importing hermes_cli + gateway + aiohttp via bundled Python..."
# api_server guards its `from aiohttp import web` in a try/except, so importing
# the module does NOT fail when aiohttp is missing. Import aiohttp explicitly so
# a missing API-server dependency fails the build instead of silently shipping a
# runtime whose API server never binds.
PYTHONPATH="$SITE_PACKAGES" "$PYTHON_BIN" -c "
import hermes_cli, gateway.platforms.api_server, aiohttp
print('hermes_cli', hermes_cli.__version__)
print('gateway api_server import OK')
print('aiohttp', aiohttp.__version__)
"

# ---------------------------------------------------------------------------
# 4. Stage to OUT_DIR
# ---------------------------------------------------------------------------
echo "[4/4] Staging to $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$(dirname "$OUT_DIR")"
mkdir -p "$OUT_DIR"
mv "$PY_DIR" "$OUT_DIR/python"
mv "$SITE_PACKAGES" "$OUT_DIR/site-packages"

# Strip caches and tests to shrink final size
find "$OUT_DIR/site-packages" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT_DIR/site-packages" -type d \( -name "tests" -o -name "test" -o -name "__tests__" \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT_DIR/site-packages" -name "*.dist-info" -type d -prune -exec rm -rf {} + 2>/dev/null || true

# Strip native binaries (debug symbols). Hermes runtime is sealed — we never
# need backtraces with symbol names in production builds.
# On macOS arm64, `strip` invalidates the ad-hoc signature pip wheels ship
# with, which causes dlopen to fail under stricter signature enforcement
# (notarized contexts, future macOS versions). Re-sign ad-hoc after stripping.
if [[ "$TARGET_ID" == mac-* ]]; then
  while IFS= read -r -d '' bin; do
    strip -x "$bin" 2>/dev/null || true
    codesign --force --sign - --timestamp=none "$bin" >/dev/null 2>&1 || true
  done < <(find "$OUT_DIR/site-packages" \( -name "*.so" -o -name "*.dylib" \) -type f -print0)
elif [[ "$TARGET_ID" == linux-* ]]; then
  find "$OUT_DIR/site-packages" \( -name "*.so" -o -name "*.so.*" \) -type f -exec strip --strip-unneeded {} + 2>/dev/null || true
fi

# Drop Python stdlib modules the sealed runtime never uses (GUI/REPL/2to3/pip).
PY_STDLIB=""
case "$TARGET_ID" in
  mac-*|linux-*) PY_STDLIB="$OUT_DIR/python/lib/python${PYTHON_VERSION%.*}";;
  win-*)         PY_STDLIB="$OUT_DIR/python/Lib";;
esac
if [[ -n "$PY_STDLIB" && -d "$PY_STDLIB" ]]; then
  for unused in tkinter idlelib turtledemo ensurepip lib2to3 pydoc_data; do
    rm -rf "$PY_STDLIB/$unused" 2>/dev/null || true
  done
  # tk shared libs follow tkinter
  find "$PY_STDLIB/../.." -maxdepth 3 \( -name "_tkinter*.so" -o -name "libtcl*.dylib" -o -name "libtk*.dylib" \) -delete 2>/dev/null || true
fi

cat > "$OUT_DIR/runtime-build-info.json" <<JSON
{
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "target": "$TARGET_ID",
  "hermesVersion": "$HERMES_VERSION",
  "pythonVersion": "$PYTHON_VERSION",
  "pbsRelease": "$PBS_RELEASE",
  "pbsTriple": "$PBS_TRIPLE"
}
JSON

echo ""
echo "[hermes-runtime] DONE."
echo "  $OUT_DIR ($(du -sh "$OUT_DIR" | awk '{print $1}'))"
echo "  python: $(du -sh "$OUT_DIR/python" | awk '{print $1}')"
echo "  site-packages: $(du -sh "$OUT_DIR/site-packages" | awk '{print $1}')"
