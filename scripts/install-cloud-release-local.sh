#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_INPUT="${1:-${AIMASHI_RELEASE_ARCHIVE:-./aimashi-cloud-release.tgz}}"
ARCHIVE="$(cd "$(dirname "$ARCHIVE_INPUT")" && pwd)/$(basename "$ARCHIVE_INPUT")"
PUBLIC_URL="${AIMASHI_CLOUD_PUBLIC_URL:-https://aiweb.buytb01.com}"
SMOKE_URL="${AIMASHI_INSTALL_SMOKE_URL:-$PUBLIC_URL}"
API_DIR="${AIMASHI_DEPLOY_API_DIR:-/opt/aimashi-cloud}"
WEB_DIR="${AIMASHI_DEPLOY_WEB_DIR:-/var/www/aimashi-web}"
DATA_DIR="${AIMASHI_DEPLOY_DATA_DIR:-/var/lib/aimashi-cloud}"
BACKUP_DIR="${AIMASHI_DEPLOY_BACKUP_DIR:-/root}"
SERVICE="${AIMASHI_DEPLOY_SERVICE:-aimashi-cloud}"
SERVICE_USER="${AIMASHI_DEPLOY_SERVICE_USER:-aimashi-cloud}"
DEPLOY_SUDO="${AIMASHI_DEPLOY_SUDO:-}"
INSTALL_TMP="${AIMASHI_INSTALL_TMP:-/tmp/aimashi-cloud-release-install-$$}"
DEPLOY_ID="${AIMASHI_DEPLOY_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
SKIP_SMOKE="${AIMASHI_INSTALL_SKIP_SMOKE:-}"
VERIFY_ONLY="${AIMASHI_INSTALL_VERIFY_ONLY:-}"

API_BACKUP="$BACKUP_DIR/aimashi-cloud-api-$DEPLOY_ID.tgz"
WEB_BACKUP="$BACKUP_DIR/aimashi-cloud-web-$DEPLOY_ID.tgz"
DATA_BACKUP="$BACKUP_DIR/aimashi-cloud-data-$DEPLOY_ID.tgz"
UNIT_BACKUP="$BACKUP_DIR/aimashi-cloud-$SERVICE-unit-$DEPLOY_ID.service"

validate_deploy_sudo() {
  if [ -z "$DEPLOY_SUDO" ]; then
    return
  fi
  if printf "%s" "$DEPLOY_SUDO" | LC_ALL=C grep -q '[^A-Za-z0-9_./ -]'; then
    echo "AIMASHI_DEPLOY_SUDO must be a simple command such as 'sudo -n' or '/usr/bin/sudo -n'." >&2
    exit 1
  fi
}

validate_deploy_sudo

run_as_root() {
  if [ -n "$DEPLOY_SUDO" ]; then
    # AIMASHI_DEPLOY_SUDO is intentionally a command string, for example: sudo -n
    $DEPLOY_SUDO "$@"
  else
    "$@"
  fi
}

require_command() {
  command -v "$1" >/dev/null || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

checksum_file() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

ensure_service_user() {
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    return
  fi
  useradd_cmd="$(command -v useradd || true)"
  if [ -z "$useradd_cmd" ] && [ -x /usr/sbin/useradd ]; then
    useradd_cmd="/usr/sbin/useradd"
  fi
  if [ -z "$useradd_cmd" ]; then
    echo "Missing required command: useradd; create system user '$SERVICE_USER' manually or install useradd." >&2
    exit 1
  fi
  login_shell="/usr/sbin/nologin"
  if [ ! -x "$login_shell" ]; then
    login_shell="/bin/false"
  fi
  run_as_root "$useradd_cmd" --system --user-group --home-dir "$DATA_DIR" --shell "$login_shell" "$SERVICE_USER"
}

unit_value() {
  key="$1"
  file="$2"
  awk -F= -v key="$key" '
    $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2);
      print $2;
      exit;
    }
  ' "$file"
}

rollback_data_owner() {
  if [ -f "$UNIT_BACKUP" ]; then
    restored_user="$(unit_value User "$UNIT_BACKUP")"
    if [ -z "$restored_user" ]; then
      return 0
    fi
    restored_group="$(unit_value Group "$UNIT_BACKUP")"
    if [ -z "$restored_group" ]; then
      restored_group="$restored_user"
    fi
    printf '%s:%s\n' "$restored_user" "$restored_group"
    return 0
  fi
  printf '%s:%s\n' "$SERVICE_USER" "$SERVICE_USER"
}

chown_data_for_rollback() {
  owner="$(rollback_data_owner || true)"
  user="${owner%%:*}"
  if [ -n "$owner" ] && [ -n "$user" ] && id -u "$user" >/dev/null 2>&1; then
    run_as_root chown -R "$owner" "$DATA_DIR" || true
  fi
}

rollback_install() {
  status=$?
  if [ "${install_done:-0}" = "1" ]; then
    exit "$status"
  fi
  echo "Install failed; attempting rollback before exit." >&2
  run_as_root systemctl stop "$SERVICE" || true
  if [ -f "$DATA_BACKUP" ]; then
    run_as_root rm -rf "$DATA_DIR" || true
    run_as_root mkdir -p "$(dirname "$DATA_DIR")" || true
    run_as_root tar -xzf "$DATA_BACKUP" -C "$(dirname "$DATA_DIR")" || true
    chown_data_for_rollback
    echo "Restored data from $DATA_BACKUP" >&2
  fi
  if [ -f "$API_BACKUP" ]; then
    run_as_root rm -rf "$API_DIR" || true
    run_as_root mkdir -p "$(dirname "$API_DIR")" || true
    run_as_root tar -xzf "$API_BACKUP" -C "$(dirname "$API_DIR")" || true
    echo "Restored API from $API_BACKUP" >&2
  fi
  if [ -f "$WEB_BACKUP" ]; then
    run_as_root rm -rf "$WEB_DIR" || true
    run_as_root mkdir -p "$(dirname "$WEB_DIR")" || true
    run_as_root tar -xzf "$WEB_BACKUP" -C "$(dirname "$WEB_DIR")" || true
    echo "Restored Web from $WEB_BACKUP" >&2
  fi
  if [ -f "$UNIT_BACKUP" ]; then
    run_as_root cp "$UNIT_BACKUP" "/etc/systemd/system/$SERVICE.service" || true
    echo "Restored systemd unit from $UNIT_BACKUP" >&2
  fi
  run_as_root systemctl daemon-reload || true
  run_as_root systemctl restart "$SERVICE" || true
  exit "$status"
}

rollback_after_public_verification_failure() {
  echo "Public verification failed; attempting rollback." >&2
  run_as_root systemctl stop "$SERVICE" || true
  if [ -f "$DATA_BACKUP" ]; then
    run_as_root rm -rf "$DATA_DIR"
    run_as_root mkdir -p "$(dirname "$DATA_DIR")"
    run_as_root tar -xzf "$DATA_BACKUP" -C "$(dirname "$DATA_DIR")"
    chown_data_for_rollback
    echo "Restored data from $DATA_BACKUP" >&2
  fi
  if [ -f "$API_BACKUP" ]; then
    run_as_root rm -rf "$API_DIR"
    run_as_root mkdir -p "$(dirname "$API_DIR")"
    run_as_root tar -xzf "$API_BACKUP" -C "$(dirname "$API_DIR")"
    echo "Restored API from $API_BACKUP" >&2
  fi
  if [ -f "$WEB_BACKUP" ]; then
    run_as_root rm -rf "$WEB_DIR"
    run_as_root mkdir -p "$(dirname "$WEB_DIR")"
    run_as_root tar -xzf "$WEB_BACKUP" -C "$(dirname "$WEB_DIR")"
    echo "Restored Web from $WEB_BACKUP" >&2
  fi
  if [ -f "$UNIT_BACKUP" ]; then
    run_as_root cp "$UNIT_BACKUP" "/etc/systemd/system/$SERVICE.service"
    echo "Restored systemd unit from $UNIT_BACKUP" >&2
  fi
  run_as_root systemctl daemon-reload
  run_as_root systemctl restart "$SERVICE"
}

if [ ! -f "$ARCHIVE" ]; then
  echo "Release archive not found: $ARCHIVE" >&2
  exit 1
fi

require_command node
require_command tar
require_command awk
if ! command -v sha256sum >/dev/null && ! command -v shasum >/dev/null; then
  echo "Missing required command: sha256sum or shasum" >&2
  exit 1
fi

node -e 'require("node:sqlite"); const major = Number(process.versions.node.split(".")[0]); if (major < 25) { console.error("Node.js 25+ is required, found " + process.version); process.exit(1); }'
if [ -n "$DEPLOY_SUDO" ]; then
  run_as_root true
fi

if [ -f "$ARCHIVE.sha256" ]; then
  expected_sha="$(awk '{print $1}' "$ARCHIVE.sha256")"
  actual_sha="$(checksum_file "$ARCHIVE")"
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "Release archive checksum mismatch for $ARCHIVE" >&2
    exit 1
  fi
  echo "Release archive checksum OK: $actual_sha"
else
  echo "Warning: $ARCHIVE.sha256 not found; installing without sidecar checksum verification." >&2
fi

rm -rf "$INSTALL_TMP"
mkdir -p "$INSTALL_TMP"
tar -xzf "$ARCHIVE" -C "$INSTALL_TMP" --strip-components=1

for required_file in \
  "$INSTALL_TMP/api/server.js" \
  "$INSTALL_TMP/api/package.json" \
  "$INSTALL_TMP/web/index.html" \
  "$INSTALL_TMP/web/app.js" \
  "$INSTALL_TMP/web/styles.css" \
  "$INSTALL_TMP/smoke-cloud.js" \
  "$INSTALL_TMP/doctor-cloud.js" \
  "$INSTALL_TMP/manifest.json"; do
  if [ ! -f "$required_file" ]; then
    echo "Release archive is missing $required_file" >&2
    exit 1
  fi
done

EXPECTED_RELEASE_COMMIT="$(node -e "const m=require(process.argv[1]); process.stdout.write(String(m.source?.gitCommit || ''))" "$INSTALL_TMP/manifest.json")"
EXPECTED_RELEASE_BUILT_AT="$(node -e "const m=require(process.argv[1]); process.stdout.write(String(m.builtAt || ''))" "$INSTALL_TMP/manifest.json")"

node - "$INSTALL_TMP/manifest.json" "$INSTALL_TMP" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const manifestPath = process.argv[2];
const root = process.argv[3];
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.product !== "Aimashi Cloud") {
  throw new Error("Release manifest has the wrong product.");
}
if (!manifest.builtAt || !manifest.files || typeof manifest.files !== "object") {
  throw new Error("Release manifest is missing build metadata or file hashes.");
}
for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
  const fullPath = path.join(root, relativePath);
  if (!fullPath.startsWith(root + path.sep) || !fs.existsSync(fullPath)) {
    throw new Error(`Release manifest references a missing file: ${relativePath}`);
  }
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`Release manifest hash mismatch for ${relativePath}`);
  }
}
NODE

if [ "$VERIFY_ONLY" = "1" ]; then
  echo "Aimashi Cloud local installer verify-only completed: $ARCHIVE"
  rm -rf "$INSTALL_TMP"
  exit 0
fi

require_command npm
require_command rsync
require_command systemctl
require_command id
require_command chown

install_done=0
trap rollback_install ERR
ensure_service_user

run_as_root mkdir -p "$BACKUP_DIR"
if [ -d "$DATA_DIR" ]; then
  run_as_root systemctl stop "$SERVICE" || true
  run_as_root tar -C "$(dirname "$DATA_DIR")" -czf "$DATA_BACKUP" "$(basename "$DATA_DIR")"
  run_as_root tar -tzf "$DATA_BACKUP" >/dev/null
  echo "Data backup written to $DATA_BACKUP"
fi
if [ -d "$API_DIR" ]; then
  run_as_root tar -C "$(dirname "$API_DIR")" -czf "$API_BACKUP" "$(basename "$API_DIR")"
  run_as_root tar -tzf "$API_BACKUP" >/dev/null
  echo "API backup written to $API_BACKUP"
fi
if [ -d "$WEB_DIR" ]; then
  run_as_root tar -C "$(dirname "$WEB_DIR")" -czf "$WEB_BACKUP" "$(basename "$WEB_DIR")"
  run_as_root tar -tzf "$WEB_BACKUP" >/dev/null
  echo "Web backup written to $WEB_BACKUP"
fi
if [ -f "/etc/systemd/system/$SERVICE.service" ]; then
  run_as_root cp "/etc/systemd/system/$SERVICE.service" "$UNIT_BACKUP"
  echo "systemd unit backup written to $UNIT_BACKUP"
fi

run_as_root mkdir -p "$API_DIR" "$WEB_DIR" "$DATA_DIR"
run_as_root rsync -a --delete "$INSTALL_TMP/api/" "$API_DIR/"
run_as_root cp "$INSTALL_TMP/manifest.json" "$API_DIR/release-manifest.json"
run_as_root rsync -a --delete "$INSTALL_TMP/web/" "$WEB_DIR/"
run_as_root chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

cd "$API_DIR"
run_as_root npm install --omit=dev

unit_tmp="$INSTALL_TMP/$SERVICE.service"
cat > "$unit_tmp" <<SERVICE_UNIT
[Unit]
Description=Aimashi Cloud API
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$API_DIR
ExecStart=/usr/bin/env node $API_DIR/server.js
Restart=always
RestartSec=3
Environment=AIMASHI_CLOUD_HOST=127.0.0.1
Environment=AIMASHI_CLOUD_PORT=4175
Environment=AIMASHI_CLOUD_DATA=$DATA_DIR
Environment=AIMASHI_CLOUD_ALLOWED_ORIGINS=$PUBLIC_URL
Environment=AIMASHI_BRIDGE_RUN_TIMEOUT_MS=300000
Environment=AIMASHI_CLOUD_VERSION=2026-05-20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
SERVICE_UNIT
run_as_root mkdir -p /etc/systemd/system
run_as_root cp "$unit_tmp" "/etc/systemd/system/$SERVICE.service"
run_as_root systemctl daemon-reload
run_as_root systemctl enable "$SERVICE"
run_as_root systemctl restart "$SERVICE"
run_as_root systemctl is-active "$SERVICE"
install_done=1
trap - ERR

if [ "$SKIP_SMOKE" = "1" ]; then
  echo "Aimashi Cloud local install completed without public verification: $SERVICE"
  exit 0
fi

echo "Running doctor against $SMOKE_URL"
if ! AIMASHI_DOCTOR_EXPECT_RELEASE_COMMIT="$EXPECTED_RELEASE_COMMIT" \
  AIMASHI_DOCTOR_EXPECT_RELEASE_BUILT_AT="$EXPECTED_RELEASE_BUILT_AT" \
  node "$INSTALL_TMP/doctor-cloud.js" "$SMOKE_URL"; then
  rollback_after_public_verification_failure || echo "Rollback after doctor failure failed; inspect this host manually." >&2
  exit 1
fi

echo "Running smoke against $SMOKE_URL"
if ! AIMASHI_SMOKE_EXPECT_RELEASE_COMMIT="$EXPECTED_RELEASE_COMMIT" \
  AIMASHI_SMOKE_EXPECT_RELEASE_BUILT_AT="$EXPECTED_RELEASE_BUILT_AT" \
  node "$INSTALL_TMP/smoke-cloud.js" "$SMOKE_URL"; then
  rollback_after_public_verification_failure || echo "Rollback after smoke failure failed; inspect this host manually." >&2
  exit 1
fi

echo "Aimashi Cloud local install completed: $SMOKE_URL"
