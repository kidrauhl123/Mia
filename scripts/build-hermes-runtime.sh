#!/usr/bin/env bash
set -euo pipefail

# Builds the pinned, relocatable Hermes runtime published as a separate Mia
# engine backup. End users do not run this script: clicking "启用 Mia 稳定版"
# downloads the verified archive into Mia's private data and never changes PATH.

TARGET_ID="${1:-mac-arm64}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_ROOT="${HERMES_RUNTIME_OUTPUT_ROOT:-$ROOT/vendor/hermes-runtime}"
OUT_DIR="${OUT_DIR:-$OUTPUT_ROOT/$TARGET_ID}"
node -e "const p=require('path');const root=p.resolve(process.argv[1]);const out=p.resolve(process.argv[2]);const rel=p.relative(root,out);if(!rel||rel.startsWith('..'+p.sep)||p.isAbsolute(rel))throw new Error('Refusing to write Hermes runtime outside '+root+': '+out)" "$OUTPUT_ROOT" "$OUT_DIR"

case "$TARGET_ID" in
  mac-arm64) PBS_TRIPLE="aarch64-apple-darwin" ;;
  mac-x64) PBS_TRIPLE="x86_64-apple-darwin" ;;
  linux-x64) PBS_TRIPLE="x86_64-unknown-linux-gnu" ;;
  win-x64) PBS_TRIPLE="x86_64-pc-windows-msvc" ;;
  *) echo "Unsupported Hermes runtime target: $TARGET_ID" >&2; exit 1 ;;
esac

for command in node curl tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing build dependency: $command" >&2; exit 1; }
done

HERMES_VERSION="${HERMES_VERSION:-$(cd "$ROOT" && node -p "require('./package.json').hermes.version")}"
HERMES_PACKAGE_VERSION="${HERMES_PACKAGE_VERSION:-$(cd "$ROOT" && node -p "require('./package.json').hermes.packageVersion")}"
PYTHON_VERSION="${PYTHON_VERSION:-$(cd "$ROOT" && node -p "require('./package.json').hermes.pythonVersion")}"
PBS_RELEASE="${PBS_RELEASE:-$(cd "$ROOT" && node -p "require('./package.json').hermes.pbsRelease")}"
HERMES_WHEEL_URL="${HERMES_WHEEL_URL:-$(cd "$ROOT" && node -p "require('./package.json').hermes.wheelUrl")}"
HERMES_WHEEL_MIRROR_URL="${HERMES_WHEEL_MIRROR_URL:-$(cd "$ROOT" && node -p "require('./package.json').hermes.wheelMirrorUrl")}"
HERMES_WHEEL_SHA256="${HERMES_WHEEL_SHA256:-$(cd "$ROOT" && node -p "require('./package.json').hermes.wheelSha256")}"
DDGS_VERSION="${DDGS_VERSION:-$(cd "$ROOT" && node -p "require('./package.json').hermes.ddgsVersion")}"
PBS_TARBALL="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${PBS_TRIPLE}-install_only.tar.gz"
PBS_BASE="${PBS_MIRROR_URL:-https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE}"
PBS_URL="${PBS_BASE%/}/$PBS_TARBALL"
BUILD_CACHE_DIR="${HERMES_BUILD_CACHE_DIR:-$ROOT/vendor/hermes-runtime/.cache}"
PBS_ARCHIVE="$BUILD_CACHE_DIR/$PBS_TARBALL"
HERMES_WHEEL="$BUILD_CACHE_DIR/hermes_agent-${HERMES_PACKAGE_VERSION}-py3-none-any.whl"

BUILD_INFO="$OUT_DIR/runtime-build-info.json"
if [[ -f "$BUILD_INFO" && "${HERMES_FORCE_BUILD:-}" != "1" ]]; then
  CACHED="$(node -e "const i=require(process.argv[1]); process.stdout.write([i.target,i.hermesVersion,i.hermesPackageVersion,i.pythonVersion,i.pbsRelease,i.hermesWheelSha256,i.ddgsVersion].join(':'))" "$BUILD_INFO" 2>/dev/null || true)"
  WANTED="$TARGET_ID:$HERMES_VERSION:$HERMES_PACKAGE_VERSION:$PYTHON_VERSION:$PBS_RELEASE:$HERMES_WHEEL_SHA256:$DDGS_VERSION"
  if [[ "$CACHED" == "$WANTED" ]]; then
    echo "[hermes-runtime] cached $WANTED"
    exit 0
  fi
fi

mkdir -p "$OUTPUT_ROOT"
# Keep the staging directory beside the final artifact. On Windows, Git Bash
# otherwise stages under C: and `mv` has to copy thousands of Python files when
# the checkout lives on another drive.
WORK_DIR="$(mktemp -d "$OUTPUT_ROOT/.build-$TARGET_ID.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$WORK_DIR/python" "$WORK_DIR/site-packages"

echo "[hermes-runtime] downloading Python $PYTHON_VERSION for $TARGET_ID"
mkdir -p "$BUILD_CACHE_DIR"
if [[ ! -f "$PBS_ARCHIVE" ]]; then
  rm -f "$PBS_ARCHIVE.part"
  curl --fail --location --retry 4 --output "$PBS_ARCHIVE.part" "$PBS_URL"
  mv "$PBS_ARCHIVE.part" "$PBS_ARCHIVE"
fi
if [[ -n "${PBS_SHA256:-}" ]]; then
  node -e "const fs=require('fs'),c=require('crypto');const h=c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex');if(h!==process.argv[2])throw new Error('Python archive checksum mismatch: '+h)" "$PBS_ARCHIVE" "$PBS_SHA256"
fi
tar -xzf "$PBS_ARCHIVE" -C "$WORK_DIR/python" --strip-components=1

if [[ -f "$HERMES_WHEEL" ]] && ! node -e "const fs=require('fs'),c=require('crypto');const h=c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex');process.exit(h===process.argv[2]?0:1)" "$HERMES_WHEEL" "$HERMES_WHEEL_SHA256"; then
  rm -f "$HERMES_WHEEL"
fi
if [[ ! -f "$HERMES_WHEEL" ]]; then
  rm -f "$HERMES_WHEEL.part"
  WHEEL_DOWNLOADED=0
  for wheel_url in "$HERMES_WHEEL_MIRROR_URL" "$HERMES_WHEEL_URL"; do
    [[ -n "$wheel_url" ]] || continue
    if curl --fail --location --connect-timeout 20 --retry 4 --retry-delay 2 --output "$HERMES_WHEEL.part" "$wheel_url"; then
      WHEEL_DOWNLOADED=1
      break
    fi
    rm -f "$HERMES_WHEEL.part"
  done
  [[ "$WHEEL_DOWNLOADED" == "1" ]] || { echo "Unable to download the pinned Hermes wheel." >&2; exit 1; }
  mv "$HERMES_WHEEL.part" "$HERMES_WHEEL"
fi
node -e "const fs=require('fs'),c=require('crypto');const h=c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex');if(h!==process.argv[2])throw new Error('Hermes wheel checksum mismatch: '+h)" "$HERMES_WHEEL" "$HERMES_WHEEL_SHA256"

PYTHON_BIN="$WORK_DIR/python/bin/python3"
if [[ "$TARGET_ID" == win-* ]]; then PYTHON_BIN="$WORK_DIR/python/python.exe"; fi
[[ -f "$PYTHON_BIN" ]] || { echo "Bundled Python missing: $PYTHON_BIN" >&2; exit 1; }
HERMES_WHEEL_URI="$("$PYTHON_BIN" -c "from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve().as_uri())" "$HERMES_WHEEL")"
HERMES_REQUIREMENT="hermes-agent[web,mcp,acp] @ ${HERMES_WHEEL_URI}#sha256=${HERMES_WHEEL_SHA256}"

HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"
case "$HOST_OS:$HOST_ARCH" in
  darwin:arm64) HOST_TARGET="mac-arm64" ;;
  darwin:x86_64) HOST_TARGET="mac-x64" ;;
  linux:x86_64) HOST_TARGET="linux-x64" ;;
  mingw*:x86_64|msys*:x86_64|cygwin*:x86_64) HOST_TARGET="win-x64" ;;
  *) HOST_TARGET="" ;;
esac
[[ "$HOST_TARGET" == "$TARGET_ID" ]] || { echo "Build $TARGET_ID on a native $TARGET_ID host (current: $HOST_OS/$HOST_ARCH)." >&2; exit 1; }

echo "[hermes-runtime] installing Hermes $HERMES_VERSION into sealed site-packages"
PIP_ARGS=(
  -m pip install
  --disable-pip-version-check
  --cache-dir "$BUILD_CACHE_DIR/pip"
  --timeout 120
  --retries 5
  --target "$WORK_DIR/site-packages"
  "$HERMES_REQUIREMENT"
  "aiohttp==3.13.3"
  "mcp==1.26.0"
  "ddgs==$DDGS_VERSION"
)
PIP_PRIMARY_INDEX="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
PIP_FALLBACK_INDEX="${PIP_FALLBACK_INDEX_URL:-https://pypi.org/simple}"
if ! "$PYTHON_BIN" "${PIP_ARGS[@]}" --index-url "$PIP_PRIMARY_INDEX"; then
  [[ "$PIP_FALLBACK_INDEX" != "$PIP_PRIMARY_INDEX" ]] || exit 1
  echo "[hermes-runtime] primary package index failed; retrying official PyPI"
  "$PYTHON_BIN" "${PIP_ARGS[@]}" --index-url "$PIP_FALLBACK_INDEX"
fi

if [[ "$TARGET_ID" == win-* ]]; then
  node -e "const fs=require('fs');const body=['import os','import sys','_root = os.path.dirname(__file__)','for _relative in (\"win32\", \"win32/lib\", \"Pythonwin\", \"pywin32_system32\"):','    _candidate = os.path.join(_root, *_relative.split(\"/\"))','    if os.path.isdir(_candidate) and _candidate not in sys.path:','        sys.path.insert(0, _candidate)','_dll_dir = os.path.join(_root, \"pywin32_system32\")','if os.name == \"nt\" and os.path.isdir(_dll_dir) and hasattr(os, \"add_dll_directory\"):','    _mia_pywin32_dll_handle = os.add_dll_directory(_dll_dir)',''].join('\\n');fs.writeFileSync(process.argv[1],body)" "$WORK_DIR/site-packages/sitecustomize.py"
  PYTHONPATH="$WORK_DIR/site-packages" "$PYTHON_BIN" -c "import pywintypes, hermes_cli.main, acp_adapter.entry, aiohttp, mcp, ddgs; print('Hermes runtime imports OK')"
else
  PYTHONPATH="$WORK_DIR/site-packages" "$PYTHON_BIN" -c "import hermes_cli.main, acp_adapter.entry, aiohttp, mcp, ddgs; print('Hermes runtime imports OK')"
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
mv "$WORK_DIR/python" "$OUT_DIR/python"
mv "$WORK_DIR/site-packages" "$OUT_DIR/site-packages"
find "$OUT_DIR/site-packages" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT_DIR/site-packages" -type d \( -name tests -o -name test -o -name __tests__ \) -prune -exec rm -rf {} + 2>/dev/null || true

node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({builtAt:new Date().toISOString(),target:process.argv[2],hermesVersion:process.argv[3],hermesPackageVersion:process.argv[4],pythonVersion:process.argv[5],pbsRelease:process.argv[6],pbsTriple:process.argv[7],hermesWheelSha256:process.argv[8],ddgsVersion:process.argv[9]},null,2)+'\n')" "$BUILD_INFO" "$TARGET_ID" "$HERMES_VERSION" "$HERMES_PACKAGE_VERSION" "$PYTHON_VERSION" "$PBS_RELEASE" "$PBS_TRIPLE" "$HERMES_WHEEL_SHA256" "$DDGS_VERSION"
echo "[hermes-runtime] ready: $OUT_DIR"
