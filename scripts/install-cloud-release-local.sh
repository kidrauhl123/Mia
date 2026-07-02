#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_INPUT="${1:-${MIA_RELEASE_ARCHIVE:-./mia-cloud-release.tgz}}"
ARCHIVE="$(cd "$(dirname "$ARCHIVE_INPUT")" && pwd)/$(basename "$ARCHIVE_INPUT")"
PUBLIC_URL="${MIA_CLOUD_PUBLIC_URL:-https://mia.gifgif.cn}"
EXTRA_ALLOWED_ORIGINS="${MIA_CLOUD_EXTRA_ALLOWED_ORIGINS:-https://gifgif.cn}"
if [ -n "${MIA_CLOUD_ALLOWED_ORIGINS:-}" ]; then
  ALLOWED_ORIGINS="$MIA_CLOUD_ALLOWED_ORIGINS"
elif [ -n "$EXTRA_ALLOWED_ORIGINS" ]; then
  ALLOWED_ORIGINS="$PUBLIC_URL,$EXTRA_ALLOWED_ORIGINS"
else
  ALLOWED_ORIGINS="$PUBLIC_URL"
fi
SMOKE_URL="${MIA_INSTALL_SMOKE_URL:-$PUBLIC_URL}"
API_DIR="${MIA_DEPLOY_API_DIR:-/opt/mia-cloud}"
WEB_DIR="${MIA_DEPLOY_WEB_DIR:-/var/www/mia-web}"
WEB_BASENAME="$(basename "$WEB_DIR")"
UPDATES_DIR="${MIA_DEPLOY_UPDATES_DIR:-/var/www/mia-updates}"
DATA_DIR="${MIA_DEPLOY_DATA_DIR:-/var/lib/mia-cloud}"
AGENT_ROOT="${MIA_CLOUD_AGENT_ROOT:-/var/lib/mia-cloud-agent-users}"
HERMES_IMAGE="${MIA_CLOUD_HERMES_IMAGE:-mia/hermes-cloud:2026.5.29}"
DEBIAN_APT_MIRROR="${MIA_DEBIAN_APT_MIRROR:-}"
DEBIAN_APT_SECURITY_MIRROR="${MIA_DEBIAN_APT_SECURITY_MIRROR:-}"
PIP_INDEX_URL="${MIA_PIP_INDEX_URL:-}"
PIP_EXTRA_INDEX_URL="${MIA_PIP_EXTRA_INDEX_URL:-}"
SKIP_HERMES_IMAGE_BUILD="${MIA_INSTALL_SKIP_HERMES_IMAGE_BUILD:-${MIA_SKIP_HERMES_IMAGE_BUILD:-}}"
AGENT_DOCKER_NETWORK="${MIA_CLOUD_AGENT_DOCKER_NETWORK:-mia-cloud}"
LITELLM_CONTAINER="${MIA_LITELLM_CONTAINER:-litellm}"
AGENT_MODEL_PROVIDER="${MIA_CLOUD_AGENT_MODEL_PROVIDER:-mia}"
AGENT_MODEL_NAME="${MIA_CLOUD_AGENT_MODEL:-mia-auto}"
AGENT_MODEL_BASE_URL="${MIA_CLOUD_AGENT_MODEL_BASE_URL:-http://litellm:4000/v1}"
AGENT_MODEL_API_KEY="${MIA_CLOUD_AGENT_MODEL_API_KEY:-${MIA_LITELLM_API_KEY:-}}"
BACKUP_DIR="${MIA_DEPLOY_BACKUP_DIR:-/root}"
BACKUP_KEEP="${MIA_DEPLOY_BACKUP_KEEP:-3}"
SERVICE="${MIA_DEPLOY_SERVICE:-mia-cloud}"
SERVICE_USER="${MIA_DEPLOY_SERVICE_USER:-mia-cloud}"
NGINX_MAP_CONF="${MIA_DEPLOY_NGINX_MAP_CONF:-/etc/nginx/conf.d/mia-websocket-map.conf}"
NGINX_SITE_CONF="${MIA_DEPLOY_NGINX_SITE_CONF:-/etc/nginx/sites-enabled/mia-web}"
DEPLOY_SUDO="${MIA_DEPLOY_SUDO:-}"
INSTALL_TMP="${MIA_INSTALL_TMP:-/tmp/mia-cloud-release-install-$$}"
DEPLOY_ID="${MIA_DEPLOY_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
SKIP_SMOKE="${MIA_INSTALL_SKIP_SMOKE:-}"
VERIFY_ONLY="${MIA_INSTALL_VERIFY_ONLY:-}"

API_BACKUP="$BACKUP_DIR/mia-cloud-api-$DEPLOY_ID.tgz"
WEB_BACKUP="$BACKUP_DIR/mia-cloud-web-$DEPLOY_ID.tgz"
DATA_BACKUP="$BACKUP_DIR/mia-cloud-data-$DEPLOY_ID.tgz"
UNIT_BACKUP="$BACKUP_DIR/mia-cloud-$SERVICE-unit-$DEPLOY_ID.service"
NGINX_MAP_BACKUP="$BACKUP_DIR/mia-cloud-nginx-map-$DEPLOY_ID.conf"
NGINX_SITE_BACKUP="$BACKUP_DIR/mia-cloud-nginx-site-$DEPLOY_ID.conf"
LEGACY_SLUG="${MIA_DEPLOY_LEGACY_SLUG:-aima$(printf 'shi')}"
LEGACY_SERVICE="${MIA_DEPLOY_LEGACY_SERVICE:-$LEGACY_SLUG-cloud}"
LEGACY_DATA_DIR="${MIA_DEPLOY_LEGACY_DATA_DIR:-/var/lib/$LEGACY_SERVICE}"
LEGACY_AGENT_ROOT="${MIA_DEPLOY_LEGACY_AGENT_ROOT:-/var/lib/$LEGACY_SERVICE-agent-users}"
LEGACY_ETC_DIR="${MIA_DEPLOY_LEGACY_ETC_DIR:-/etc/$LEGACY_SERVICE}"

validate_deploy_sudo() {
  if [ -z "$DEPLOY_SUDO" ]; then
    return
  fi
  if printf "%s" "$DEPLOY_SUDO" | LC_ALL=C grep -q '[^A-Za-z0-9_./ -]'; then
    echo "MIA_DEPLOY_SUDO must be a simple command such as 'sudo -n' or '/usr/bin/sudo -n'." >&2
    exit 1
  fi
}

validate_deploy_sudo

run_as_root() {
  if [ -n "$DEPLOY_SUDO" ]; then
    # MIA_DEPLOY_SUDO is intentionally a command string, for example: sudo -n
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

ensure_docker_access() {
  if ! grep -q '^docker:' /etc/group; then
    echo "Missing docker group; install Docker with a docker group before enabling cloud Hermes workers." >&2
    exit 1
  fi
  if [ -n "$AGENT_DOCKER_NETWORK" ] && [ "$AGENT_DOCKER_NETWORK" != "bridge" ]; then
    run_as_root docker network inspect "$AGENT_DOCKER_NETWORK" >/dev/null 2>&1 || run_as_root docker network create "$AGENT_DOCKER_NETWORK" >/dev/null
    if run_as_root docker container inspect "$LITELLM_CONTAINER" >/dev/null 2>&1; then
      run_as_root docker network connect "$AGENT_DOCKER_NETWORK" "$LITELLM_CONTAINER" >/dev/null 2>&1 || true
    fi
  fi
  if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
    return
  fi
  usermod_cmd="$(command -v usermod || true)"
  if [ -z "$usermod_cmd" ] && [ -x /usr/sbin/usermod ]; then
    usermod_cmd="/usr/sbin/usermod"
  fi
  if [ -z "$usermod_cmd" ]; then
    echo "Missing required command: usermod; add '$SERVICE_USER' to the docker group manually." >&2
    exit 1
  fi
  run_as_root "$usermod_cmd" -aG docker "$SERVICE_USER"
}

stop_legacy_service() {
  if [ -z "$LEGACY_SERVICE" ] || [ "$LEGACY_SERVICE" = "$SERVICE" ]; then
    return
  fi
  if systemctl list-unit-files "$LEGACY_SERVICE.service" >/dev/null 2>&1 || systemctl status "$LEGACY_SERVICE" >/dev/null 2>&1; then
    run_as_root systemctl stop "$LEGACY_SERVICE" || true
  fi
}

disable_legacy_service() {
  if [ -z "$LEGACY_SERVICE" ] || [ "$LEGACY_SERVICE" = "$SERVICE" ]; then
    return
  fi
  run_as_root systemctl disable "$LEGACY_SERVICE" >/dev/null 2>&1 || true
}

migrate_legacy_dir() {
  src="$1"
  dst="$2"
  label="$3"
  if [ -e "$dst" ] || [ ! -d "$src" ]; then
    return
  fi
  echo "Migrating legacy $label to $dst"
  run_as_root mkdir -p "$(dirname "$dst")" "$dst"
  run_as_root rsync -a "$src/" "$dst/"
}

migrate_legacy_admin_env() {
  src="$LEGACY_ETC_DIR/admin.env"
  dst="/etc/mia-cloud/admin.env"
  if [ -f "$dst" ] || [ ! -f "$src" ]; then
    return
  fi
  legacy_slug="$(basename "$LEGACY_SERVICE" | sed 's/-cloud$//')"
  legacy_upper="$(printf '%s' "$legacy_slug" | tr '[:lower:]' '[:upper:]')"
  legacy_title="$(printf '%s' "$legacy_slug" | awk '{ print toupper(substr($0,1,1)) substr($0,2) }')"
  echo "Migrating legacy admin env to $dst"
  run_as_root mkdir -p /etc/mia-cloud
  sed "s/${legacy_upper}_/MIA_/g;s/${legacy_title}/Mia/g;s/${legacy_slug}/mia/g" "$src" | run_as_root tee "$dst" >/dev/null
  run_as_root chmod 600 "$dst"
}

migrate_legacy_dropins() {
  src_dir="/etc/systemd/system/$LEGACY_SERVICE.service.d"
  dst_dir="/etc/systemd/system/$SERVICE.service.d"
  if [ -d "$dst_dir" ] || [ ! -d "$src_dir" ]; then
    return
  fi
  legacy_slug="$(basename "$LEGACY_SERVICE" | sed 's/-cloud$//')"
  legacy_upper="$(printf '%s' "$legacy_slug" | tr '[:lower:]' '[:upper:]')"
  echo "Migrating legacy systemd drop-ins to $dst_dir"
  run_as_root mkdir -p "$dst_dir"
  for src in "$src_dir"/*.conf; do
    [ -f "$src" ] || continue
    sed "s/${legacy_upper}_/MIA_/g;s/${legacy_slug}/mia/g" "$src" | run_as_root tee "$dst_dir/$(basename "$src")" >/dev/null
  done
}

sync_web_release() {
  if [ -d "$INSTALL_TMP/web/downloads" ]; then
    run_as_root mkdir -p "$WEB_DIR/downloads"
    run_as_root rsync -a "$INSTALL_TMP/web/downloads/" "$WEB_DIR/downloads/"
  fi
  run_as_root rsync -a --delete --exclude '/downloads/' "$INSTALL_TMP/web/" "$WEB_DIR/"
}

restore_web_backup() {
  backup="$1"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/mia-web-rollback.XXXXXX")"
  run_as_root mkdir -p "$WEB_DIR"
  run_as_root tar -xzf "$backup" -C "$tmp"
  run_as_root rsync -a --delete --exclude '/downloads/' "$tmp/$WEB_BASENAME/" "$WEB_DIR/"
  run_as_root rm -rf "$tmp"
}

cleanup_backup_pattern() {
  pattern="$1"
  case "$BACKUP_KEEP" in
    ""|*[!0-9]*) echo "Skipping backup cleanup; invalid MIA_DEPLOY_BACKUP_KEEP=$BACKUP_KEEP" >&2; return 0 ;;
  esac
  if [ "$BACKUP_KEEP" -le 0 ] || [ ! -d "$BACKUP_DIR" ] || ! command -v find >/dev/null; then
    return 0
  fi
  old_files="$(run_as_root find "$BACKUP_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk -v keep="$BACKUP_KEEP" 'NR > keep { sub(/^[^ ]+ /, ""); print }')"
  if [ -z "$old_files" ]; then
    return 0
  fi
  printf '%s\n' "$old_files" | while IFS= read -r file; do
    [ -n "$file" ] && run_as_root rm -f "$file"
  done
}

cleanup_old_backups() {
  cleanup_backup_pattern 'mia-cloud-api-*.tgz'
  cleanup_backup_pattern 'mia-cloud-web-*.tgz'
  cleanup_backup_pattern 'mia-cloud-data-*.tgz'
  cleanup_backup_pattern 'mia-cloud-*-unit-*.service'
  cleanup_backup_pattern 'mia-cloud-nginx-map-*.conf'
  cleanup_backup_pattern 'mia-cloud-nginx-site-*.conf'
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
  if [ -n "$LEGACY_SERVICE" ] && [ "$LEGACY_SERVICE" != "$SERVICE" ]; then
    run_as_root systemctl start "$LEGACY_SERVICE" || true
  fi
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
    restore_web_backup "$WEB_BACKUP" || true
    echo "Restored Web from $WEB_BACKUP" >&2
  fi
  if [ -f "$UNIT_BACKUP" ]; then
    run_as_root cp "$UNIT_BACKUP" "/etc/systemd/system/$SERVICE.service" || true
    echo "Restored systemd unit from $UNIT_BACKUP" >&2
  fi
  if [ -f "$NGINX_MAP_BACKUP" ]; then
    run_as_root cp "$NGINX_MAP_BACKUP" "$NGINX_MAP_CONF" || true
    echo "Restored nginx map from $NGINX_MAP_BACKUP" >&2
  fi
  if [ -f "$NGINX_SITE_BACKUP" ]; then
    run_as_root cp "$NGINX_SITE_BACKUP" "$NGINX_SITE_CONF" || true
    echo "Restored nginx site from $NGINX_SITE_BACKUP" >&2
  fi
  run_as_root nginx -t >/dev/null 2>&1 && run_as_root systemctl reload nginx || true
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
    restore_web_backup "$WEB_BACKUP"
    echo "Restored Web from $WEB_BACKUP" >&2
  fi
  if [ -f "$UNIT_BACKUP" ]; then
    run_as_root cp "$UNIT_BACKUP" "/etc/systemd/system/$SERVICE.service"
    echo "Restored systemd unit from $UNIT_BACKUP" >&2
  fi
  if [ -f "$NGINX_MAP_BACKUP" ]; then
    run_as_root cp "$NGINX_MAP_BACKUP" "$NGINX_MAP_CONF"
    echo "Restored nginx map from $NGINX_MAP_BACKUP" >&2
  fi
  if [ -f "$NGINX_SITE_BACKUP" ]; then
    run_as_root cp "$NGINX_SITE_BACKUP" "$NGINX_SITE_CONF"
    echo "Restored nginx site from $NGINX_SITE_BACKUP" >&2
  fi
  run_as_root nginx -t
  run_as_root systemctl reload nginx
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
  "$INSTALL_TMP/nginx/mia-websocket-map.conf" \
  "$INSTALL_TMP/nginx/mia-cloud-site.conf" \
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
if (manifest.product !== "Mia Cloud") {
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
  echo "Mia Cloud local installer verify-only completed: $ARCHIVE"
  rm -rf "$INSTALL_TMP"
  exit 0
fi

node -e 'require("node:sqlite"); const major = Number(process.versions.node.split(".")[0]); if (major < 25) { console.error("Node.js 25+ is required, found " + process.version); process.exit(1); }'
if [ -n "$DEPLOY_SUDO" ]; then
  run_as_root true
fi

require_command npm
require_command rsync
require_command systemctl
require_command id
require_command chown
require_command docker
require_command nginx

install_done=0
trap rollback_install ERR
ensure_service_user
ensure_docker_access
stop_legacy_service
migrate_legacy_dir "$LEGACY_DATA_DIR" "$DATA_DIR" "data"
migrate_legacy_dir "$LEGACY_AGENT_ROOT" "$AGENT_ROOT" "agent root"
migrate_legacy_admin_env

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
  run_as_root tar --exclude "$WEB_BASENAME/downloads" -C "$(dirname "$WEB_DIR")" -czf "$WEB_BACKUP" "$WEB_BASENAME"
  run_as_root tar -tzf "$WEB_BACKUP" >/dev/null
  echo "Web backup written to $WEB_BACKUP"
fi
if [ -f "/etc/systemd/system/$SERVICE.service" ]; then
  run_as_root cp "/etc/systemd/system/$SERVICE.service" "$UNIT_BACKUP"
  echo "systemd unit backup written to $UNIT_BACKUP"
fi
if [ -f "$NGINX_MAP_CONF" ]; then
  run_as_root cp "$NGINX_MAP_CONF" "$NGINX_MAP_BACKUP"
  echo "nginx map backup written to $NGINX_MAP_BACKUP"
fi
if [ -f "$NGINX_SITE_CONF" ]; then
  run_as_root cp "$NGINX_SITE_CONF" "$NGINX_SITE_BACKUP"
  echo "nginx site backup written to $NGINX_SITE_BACKUP"
fi

run_as_root mkdir -p "$API_DIR" "$WEB_DIR" "$UPDATES_DIR" "$DATA_DIR" "$AGENT_ROOT"
if [ -f "$INSTALL_TMP/hermes-image/Dockerfile" ]; then
  if [ "$SKIP_HERMES_IMAGE_BUILD" = "1" ]; then
    if run_as_root docker image inspect "$HERMES_IMAGE" >/dev/null 2>&1; then
      echo "Skipping cloud Hermes worker image build; existing image found: $HERMES_IMAGE"
    else
      echo "MIA_INSTALL_SKIP_HERMES_IMAGE_BUILD=1 but image is missing: $HERMES_IMAGE" >&2
      exit 1
    fi
  else
    echo "Building cloud Hermes worker image: $HERMES_IMAGE"
    docker_build_args=()
    if [ -n "$DEBIAN_APT_MIRROR" ]; then
      docker_build_args+=(--build-arg "DEBIAN_APT_MIRROR=$DEBIAN_APT_MIRROR")
    fi
    if [ -n "$DEBIAN_APT_SECURITY_MIRROR" ]; then
      docker_build_args+=(--build-arg "DEBIAN_APT_SECURITY_MIRROR=$DEBIAN_APT_SECURITY_MIRROR")
    fi
    if [ -n "$PIP_INDEX_URL" ]; then
      docker_build_args+=(--build-arg "PIP_INDEX_URL=$PIP_INDEX_URL")
    fi
    if [ -n "$PIP_EXTRA_INDEX_URL" ]; then
      docker_build_args+=(--build-arg "PIP_EXTRA_INDEX_URL=$PIP_EXTRA_INDEX_URL")
    fi
    run_as_root docker build "${docker_build_args[@]}" -t "$HERMES_IMAGE" "$INSTALL_TMP/hermes-image"
  fi
fi
run_as_root rsync -a --delete "$INSTALL_TMP/api/" "$API_DIR/"
run_as_root cp "$INSTALL_TMP/manifest.json" "$API_DIR/release-manifest.json"
sync_web_release
run_as_root mkdir -p "$(dirname "$NGINX_MAP_CONF")" "$(dirname "$NGINX_SITE_CONF")"
run_as_root cp "$INSTALL_TMP/nginx/mia-websocket-map.conf" "$NGINX_MAP_CONF"
run_as_root cp "$INSTALL_TMP/nginx/mia-cloud-site.conf" "$NGINX_SITE_CONF"
run_as_root nginx -t
run_as_root systemctl reload nginx
run_as_root chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" "$AGENT_ROOT"

cd "$API_DIR"
run_as_root npm install --omit=dev

unit_tmp="$INSTALL_TMP/$SERVICE.service"
cat > "$unit_tmp" <<SERVICE_UNIT
[Unit]
Description=Mia Cloud API
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$API_DIR
ExecStart=/usr/bin/env node $API_DIR/server.js
Restart=always
RestartSec=3
Environment=MIA_CLOUD_HOST=127.0.0.1
Environment=MIA_CLOUD_PORT=4175
Environment=MIA_CLOUD_DATA=$DATA_DIR
Environment=MIA_WEB_ROOT=$WEB_DIR
Environment=MIA_CLOUD_PUBLIC_URL=$PUBLIC_URL
Environment=MIA_CLOUD_ALLOWED_ORIGINS=$ALLOWED_ORIGINS
Environment=MIA_BRIDGE_RUN_TIMEOUT_MS=300000
Environment=MIA_CLOUD_VERSION=2026-05-20
Environment=MIA_CLOUD_AGENT_MODE=docker
Environment=MIA_CLOUD_AGENT_ROOT=$AGENT_ROOT
Environment=MIA_CLOUD_HERMES_IMAGE=$HERMES_IMAGE
Environment=MIA_CLOUD_HERMES_CONTAINER_PORT=8765
Environment=MIA_CLOUD_AGENT_DOCKER_NETWORK=$AGENT_DOCKER_NETWORK
Environment=MIA_CLOUD_AGENT_MODEL_PROVIDER=$AGENT_MODEL_PROVIDER
Environment=MIA_CLOUD_AGENT_MODEL=$AGENT_MODEL_NAME
Environment=MIA_CLOUD_AGENT_MODEL_BASE_URL=$AGENT_MODEL_BASE_URL
Environment=MIA_CLOUD_AGENT_MODEL_API_KEY=$AGENT_MODEL_API_KEY
Environment=MIA_LITELLM_ADMIN_BASE_URL=http://127.0.0.1:4000
EnvironmentFile=-/etc/mia-cloud/admin.env
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $AGENT_ROOT

[Install]
WantedBy=multi-user.target
SERVICE_UNIT
run_as_root mkdir -p /etc/systemd/system
run_as_root cp "$unit_tmp" "/etc/systemd/system/$SERVICE.service"
migrate_legacy_dropins
run_as_root systemctl daemon-reload
run_as_root systemctl enable "$SERVICE"
run_as_root systemctl restart "$SERVICE"
run_as_root systemctl is-active "$SERVICE"
disable_legacy_service
install_done=1
trap - ERR

if [ "$SKIP_SMOKE" = "1" ]; then
  cleanup_old_backups || echo "Backup cleanup failed; inspect $BACKUP_DIR manually." >&2
  echo "Mia Cloud local install completed without public verification: $SERVICE"
  exit 0
fi

echo "Running doctor against $SMOKE_URL"
if ! MIA_DOCTOR_EXPECT_RELEASE_COMMIT="$EXPECTED_RELEASE_COMMIT" \
  MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT="$EXPECTED_RELEASE_BUILT_AT" \
  node "$INSTALL_TMP/doctor-cloud.js" "$SMOKE_URL"; then
  rollback_after_public_verification_failure || echo "Rollback after doctor failure failed; inspect this host manually." >&2
  exit 1
fi

echo "Running smoke against $SMOKE_URL"
if ! MIA_SMOKE_EXPECT_RELEASE_COMMIT="$EXPECTED_RELEASE_COMMIT" \
  MIA_SMOKE_EXPECT_RELEASE_BUILT_AT="$EXPECTED_RELEASE_BUILT_AT" \
  node "$INSTALL_TMP/smoke-cloud.js" "$SMOKE_URL"; then
  rollback_after_public_verification_failure || echo "Rollback after smoke failure failed; inspect this host manually." >&2
  exit 1
fi

echo "Running site verification against $SMOKE_URL"
if ! node "$INSTALL_TMP/verify-site-verification.js" "$SMOKE_URL"; then
  rollback_after_public_verification_failure || echo "Rollback after site verification failure failed; inspect this host manually." >&2
  exit 1
fi

cleanup_old_backups || echo "Backup cleanup failed; inspect $BACKUP_DIR manually." >&2

echo "Mia Cloud local install completed: $SMOKE_URL"
