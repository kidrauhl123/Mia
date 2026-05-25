#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${AIMASHI_DEPLOY_REMOTE:-root@aiweb.buytb01.com}"
PUBLIC_URL="${AIMASHI_CLOUD_PUBLIC_URL:-https://aiweb.buytb01.com}"
REMOTE_TMP="${AIMASHI_DEPLOY_TMP:-/tmp/aimashi-cloud-release.tgz}"
REMOTE_RELEASE_DIR="${AIMASHI_DEPLOY_RELEASE_DIR:-/tmp/aimashi-cloud-release}"
API_DIR="${AIMASHI_DEPLOY_API_DIR:-/opt/aimashi-cloud}"
WEB_DIR="${AIMASHI_DEPLOY_WEB_DIR:-/var/www/aimashi-web}"
DATA_DIR="${AIMASHI_DEPLOY_DATA_DIR:-/var/lib/aimashi-cloud}"
AGENT_ROOT="${AIMASHI_CLOUD_AGENT_ROOT:-/var/lib/aimashi-cloud-agent-users}"
HERMES_IMAGE="${AIMASHI_CLOUD_HERMES_IMAGE:-aimashi/hermes-cloud:2026-05-24}"
AGENT_DOCKER_NETWORK="${AIMASHI_CLOUD_AGENT_DOCKER_NETWORK:-aimashi-cloud}"
AGENT_MODEL_PROVIDER="${AIMASHI_CLOUD_AGENT_MODEL_PROVIDER:-aimashi-litellm}"
AGENT_MODEL_NAME="${AIMASHI_CLOUD_AGENT_MODEL:-aimashi-default}"
AGENT_MODEL_BASE_URL="${AIMASHI_CLOUD_AGENT_MODEL_BASE_URL:-http://litellm:4000/v1}"
AGENT_MODEL_API_KEY="${AIMASHI_CLOUD_AGENT_MODEL_API_KEY:-${AIMASHI_LITELLM_API_KEY:-}}"
BACKUP_DIR="${AIMASHI_DEPLOY_BACKUP_DIR:-/root}"
SERVICE="${AIMASHI_DEPLOY_SERVICE:-aimashi-cloud}"
SERVICE_USER="${AIMASHI_DEPLOY_SERVICE_USER:-aimashi-cloud}"
NGINX_MAP_CONF="${AIMASHI_DEPLOY_NGINX_MAP_CONF:-/etc/nginx/conf.d/aimashi-websocket-map.conf}"
NGINX_SITE_CONF="${AIMASHI_DEPLOY_NGINX_SITE_CONF:-/etc/nginx/sites-enabled/aimashi-web}"
DEPLOY_SUDO="${AIMASHI_DEPLOY_SUDO:-}"
DEPLOY_DRY_RUN="${AIMASHI_DEPLOY_DRY_RUN:-}"
ARCHIVE="$ROOT/dist/aimashi-cloud-release.tgz"
ARCHIVE_SHA="$ARCHIVE.sha256"
DEPLOY_ID="${AIMASHI_DEPLOY_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
API_BACKUP="$BACKUP_DIR/aimashi-cloud-api-$DEPLOY_ID.tgz"
WEB_BACKUP="$BACKUP_DIR/aimashi-cloud-web-$DEPLOY_ID.tgz"
DATA_BACKUP="$BACKUP_DIR/aimashi-cloud-data-$DEPLOY_ID.tgz"
UNIT_BACKUP="$BACKUP_DIR/aimashi-cloud-$SERVICE-unit-$DEPLOY_ID.service"
NGINX_MAP_BACKUP="$BACKUP_DIR/aimashi-cloud-nginx-map-$DEPLOY_ID.conf"
NGINX_SITE_BACKUP="$BACKUP_DIR/aimashi-cloud-nginx-site-$DEPLOY_ID.conf"

cd "$ROOT"

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

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
DEPLOY_SUDO_QUOTED="$(shell_quote "$DEPLOY_SUDO")"
SERVICE_USER_QUOTED="$(shell_quote "$SERVICE_USER")"

print_ssh_help() {
  echo
  echo "Remote SSH access failed for $REMOTE."
  if ssh-add -l >/tmp/aimashi-deploy-ssh-agent.$$ 2>&1; then
    identities="$(wc -l < /tmp/aimashi-deploy-ssh-agent.$$ | tr -d ' ')"
    echo "Local ssh-agent identities: $identities loaded."
    echo "A key is loaded locally; if SSH is still denied, inspect VPS authorized_keys and sshd policy with the diagnostics printed by cloud:deploy:authorize-help."
    echo "For a local filtered auth trace, run: AIMASHI_DEPLOY_REMOTE=\"$REMOTE\" npm run cloud:deploy:ssh-diagnose"
  elif grep -qi "no identities" /tmp/aimashi-deploy-ssh-agent.$$; then
    echo "Local ssh-agent identities: none loaded."
    echo "If your deployment key has a passphrase, run: ssh-add ~/.ssh/id_ed25519"
  else
    echo "Local ssh-agent status: unavailable."
  fi
  rm -f /tmp/aimashi-deploy-ssh-agent.$$
  echo "Run this locally to print the public-key authorization command for the VPS operator:"
  echo "  AIMASHI_DEPLOY_REMOTE=\"$REMOTE\" npm run cloud:deploy:authorize-help"
  echo
}

if [ "$DEPLOY_DRY_RUN" != "1" ]; then
  echo "==> Checking remote access to $REMOTE"
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" "true"; then
    print_ssh_help
    exit 255
  fi

  echo "==> Checking remote runtime prerequisites"
  ssh "$REMOTE" "node -e 'require(\"node:sqlite\"); const major = Number(process.versions.node.split(\".\")[0]); if (major < 25) { console.error(\"Node.js 25+ is required, found \" + process.version); process.exit(1); }' && command -v npm >/dev/null && command -v rsync >/dev/null && command -v systemctl >/dev/null && command -v tar >/dev/null && command -v id >/dev/null && command -v chown >/dev/null && command -v docker >/dev/null && (command -v usermod >/dev/null || test -x /usr/sbin/usermod) && (id -u $SERVICE_USER_QUOTED >/dev/null 2>&1 || command -v useradd >/dev/null || test -x /usr/sbin/useradd) && (command -v sha256sum >/dev/null || command -v shasum >/dev/null)"

  if [ -n "$DEPLOY_SUDO" ]; then
    echo "==> Checking remote privilege command: $DEPLOY_SUDO"
    ssh "$REMOTE" "$DEPLOY_SUDO true"
  fi
else
  echo "==> Dry run: skipping SSH, upload, install, and public smoke"
fi

echo "==> Verifying local source"
node src/check.js
npm test

echo "==> Building release"
npm run cloud:release
(cd "$ROOT/dist" && shasum -a 256 -c "$(basename "$ARCHIVE_SHA")")
AIMASHI_INSTALL_VERIFY_ONLY=1 bash "$ROOT/dist/aimashi-cloud-release/install-cloud-release-local.sh" "$ARCHIVE"
npm run cloud:release:handoff:file
npm run cloud:release:handoff:verify
npm run cloud:release:handoff:bundle
npm run cloud:release:handoff:bundle:verify
EXPECTED_RELEASE_COMMIT="$(node -e "const m=require('./dist/aimashi-cloud-release/manifest.json'); process.stdout.write(String(m.source?.gitCommit || ''))")"
EXPECTED_RELEASE_BUILT_AT="$(node -e "const m=require('./dist/aimashi-cloud-release/manifest.json'); process.stdout.write(String(m.builtAt || ''))")"

if [ "$DEPLOY_DRY_RUN" = "1" ]; then
  echo "Aimashi Cloud deploy dry run completed."
  echo "Remote target: $REMOTE"
  echo "Public URL: $PUBLIC_URL"
  echo "Archive: $ARCHIVE"
  echo "Archive SHA-256: $(awk '{print $1}' "$ARCHIVE_SHA")"
  echo "Expected release commit: $EXPECTED_RELEASE_COMMIT"
  echo "Expected release builtAt: $EXPECTED_RELEASE_BUILT_AT"
  echo "Remote API dir: $API_DIR"
  echo "Remote Web dir: $WEB_DIR"
  echo "Remote data dir: $DATA_DIR"
  echo
  npm run cloud:release:handoff:file
  npm run cloud:release:handoff:verify
  npm run cloud:release:handoff:bundle
  npm run cloud:release:handoff:bundle:verify
  echo
  npm run cloud:release:handoff
  exit 0
fi

echo "==> Uploading $ARCHIVE to $REMOTE:$REMOTE_TMP"
scp "$ARCHIVE" "$REMOTE:$REMOTE_TMP"
scp "$ARCHIVE_SHA" "$REMOTE:$REMOTE_TMP.sha256"

echo "==> Installing release on $REMOTE"
ssh "$REMOTE" "bash -s" <<REMOTE_SCRIPT
set -euo pipefail
SUDO_CMD=$DEPLOY_SUDO_QUOTED
SERVICE_USER=$SERVICE_USER_QUOTED
run_as_root() {
  if [ -n "\$SUDO_CMD" ]; then
    # AIMASHI_DEPLOY_SUDO is intentionally a command string, for example: sudo -n
    \$SUDO_CMD "\$@"
  else
    "\$@"
  fi
}

ensure_service_user() {
  if id -u "\$SERVICE_USER" >/dev/null 2>&1; then
    return
  fi
  useradd_cmd="\$(command -v useradd || true)"
  if [ -z "\$useradd_cmd" ] && [ -x /usr/sbin/useradd ]; then
    useradd_cmd="/usr/sbin/useradd"
  fi
  if [ -z "\$useradd_cmd" ]; then
    echo "Missing required command: useradd; create system user '\$SERVICE_USER' manually or install useradd." >&2
    exit 1
  fi
  login_shell="/usr/sbin/nologin"
  if [ ! -x "\$login_shell" ]; then
    login_shell="/bin/false"
  fi
  run_as_root "\$useradd_cmd" --system --user-group --home-dir "$DATA_DIR" --shell "\$login_shell" "\$SERVICE_USER"
}

ensure_docker_access() {
  if ! grep -q '^docker:' /etc/group; then
    echo "Missing docker group; install Docker with a docker group before enabling cloud Hermes workers." >&2
    exit 1
  fi
  if [ -n "$AGENT_DOCKER_NETWORK" ] && [ "$AGENT_DOCKER_NETWORK" != "bridge" ]; then
    run_as_root docker network inspect "$AGENT_DOCKER_NETWORK" >/dev/null 2>&1 || run_as_root docker network create "$AGENT_DOCKER_NETWORK" >/dev/null
  fi
  if id -nG "\$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
    return
  fi
  usermod_cmd="\$(command -v usermod || true)"
  if [ -z "\$usermod_cmd" ] && [ -x /usr/sbin/usermod ]; then
    usermod_cmd="/usr/sbin/usermod"
  fi
  if [ -z "\$usermod_cmd" ]; then
    echo "Missing required command: usermod; add '\$SERVICE_USER' to the docker group manually." >&2
    exit 1
  fi
  run_as_root "\$usermod_cmd" -aG docker "\$SERVICE_USER"
}

unit_value() {
  key="\$1"
  file="\$2"
  awk -F= -v key="\$key" '
    \$1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", \$2);
      print \$2;
      exit;
    }
  ' "\$file"
}

rollback_data_owner() {
  if [ -f "$UNIT_BACKUP" ]; then
    restored_user="\$(unit_value User "$UNIT_BACKUP")"
    if [ -z "\$restored_user" ]; then
      return 0
    fi
    restored_group="\$(unit_value Group "$UNIT_BACKUP")"
    if [ -z "\$restored_group" ]; then
      restored_group="\$restored_user"
    fi
    printf '%s:%s\n' "\$restored_user" "\$restored_group"
    return 0
  fi
  printf '%s:%s\n' "\$SERVICE_USER" "\$SERVICE_USER"
}

chown_data_for_rollback() {
  owner="\$(rollback_data_owner || true)"
  user="\${owner%%:*}"
  if [ -n "\$owner" ] && [ -n "\$user" ] && id -u "\$user" >/dev/null 2>&1; then
    run_as_root chown -R "\$owner" "$DATA_DIR" || true
  fi
}

install_done=0
rollback_install() {
  status=\$?
  if [ "\$install_done" = "1" ]; then
    exit "\$status"
  fi
  echo "Remote install failed; attempting rollback before exit." >&2
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
  if [ -f "$NGINX_MAP_BACKUP" ]; then
    run_as_root cp "$NGINX_MAP_BACKUP" "$NGINX_MAP_CONF" || true
    echo "Restored nginx map from $NGINX_MAP_BACKUP" >&2
  fi
  if [ -f "$NGINX_SITE_BACKUP" ]; then
    run_as_root cp "$NGINX_SITE_BACKUP" "$NGINX_SITE_CONF" || true
    echo "Restored nginx site from $NGINX_SITE_BACKUP" >&2
  fi
  run_as_root systemctl daemon-reload || true
  run_as_root systemctl restart "$SERVICE" || true
  run_as_root nginx -t >/dev/null 2>&1 && run_as_root systemctl reload nginx || true
  exit "\$status"
}
trap rollback_install ERR

rm -rf "$REMOTE_RELEASE_DIR"
mkdir -p "$REMOTE_RELEASE_DIR"
expected_sha="\$(awk '{print \$1}' "$REMOTE_TMP.sha256")"
if command -v sha256sum >/dev/null; then
  actual_sha="\$(sha256sum "$REMOTE_TMP" | awk '{print \$1}')"
else
  actual_sha="\$(shasum -a 256 "$REMOTE_TMP" | awk '{print \$1}')"
fi
if [ "\$actual_sha" != "\$expected_sha" ]; then
  echo "Release archive checksum mismatch for $REMOTE_TMP" >&2
  exit 1
fi
echo "Release archive checksum OK: \$actual_sha"
tar -xzf "$REMOTE_TMP" -C "$REMOTE_RELEASE_DIR" --strip-components=1

run_as_root mkdir -p "$BACKUP_DIR"
ensure_service_user
ensure_docker_access
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
if [ -f "$NGINX_MAP_CONF" ]; then
  run_as_root cp "$NGINX_MAP_CONF" "$NGINX_MAP_BACKUP"
  echo "nginx map backup written to $NGINX_MAP_BACKUP"
fi
if [ -f "$NGINX_SITE_CONF" ]; then
  run_as_root cp "$NGINX_SITE_CONF" "$NGINX_SITE_BACKUP"
  echo "nginx site backup written to $NGINX_SITE_BACKUP"
fi

run_as_root mkdir -p "$API_DIR" "$WEB_DIR" "$DATA_DIR" "$AGENT_ROOT"
run_as_root rsync -a --delete "$REMOTE_RELEASE_DIR/api/" "$API_DIR/"
run_as_root cp "$REMOTE_RELEASE_DIR/manifest.json" "$API_DIR/release-manifest.json"
run_as_root rsync -a --delete "$REMOTE_RELEASE_DIR/web/" "$WEB_DIR/"
run_as_root mkdir -p "$(dirname "$NGINX_MAP_CONF")" "$(dirname "$NGINX_SITE_CONF")"
run_as_root cp "$REMOTE_RELEASE_DIR/nginx/aimashi-websocket-map.conf" "$NGINX_MAP_CONF"
run_as_root cp "$REMOTE_RELEASE_DIR/nginx/aimashi-cloud-site.conf" "$NGINX_SITE_CONF"
run_as_root rm -f /etc/nginx/sites-enabled/litellm-admin /etc/nginx/sites-available/litellm-admin
run_as_root nginx -t
run_as_root systemctl reload nginx
run_as_root chown -R "\$SERVICE_USER:\$SERVICE_USER" "$DATA_DIR" "$AGENT_ROOT"
cd "$API_DIR"
run_as_root npm install --omit=dev
unit_tmp="$REMOTE_RELEASE_DIR/$SERVICE.service"
cat > "\$unit_tmp" <<SERVICE_UNIT
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
Environment=AIMASHI_CLOUD_AGENT_MODE=docker
Environment=AIMASHI_CLOUD_AGENT_ROOT=$AGENT_ROOT
Environment=AIMASHI_CLOUD_HERMES_IMAGE=$HERMES_IMAGE
Environment=AIMASHI_CLOUD_HERMES_CONTAINER_PORT=8765
Environment=AIMASHI_CLOUD_AGENT_DOCKER_NETWORK=$AGENT_DOCKER_NETWORK
Environment=AIMASHI_CLOUD_AGENT_MODEL_PROVIDER=$AGENT_MODEL_PROVIDER
Environment=AIMASHI_CLOUD_AGENT_MODEL=$AGENT_MODEL_NAME
Environment=AIMASHI_CLOUD_AGENT_MODEL_BASE_URL=$AGENT_MODEL_BASE_URL
Environment=AIMASHI_CLOUD_AGENT_MODEL_API_KEY=$AGENT_MODEL_API_KEY
Environment=AIMASHI_LITELLM_ADMIN_BASE_URL=http://127.0.0.1:4000
EnvironmentFile=-/etc/aimashi-cloud/admin.env
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $AGENT_ROOT

[Install]
WantedBy=multi-user.target
SERVICE_UNIT
run_as_root mkdir -p /etc/systemd/system
run_as_root cp "\$unit_tmp" "/etc/systemd/system/$SERVICE.service"
run_as_root systemctl daemon-reload
run_as_root systemctl enable "$SERVICE"
run_as_root systemctl restart "$SERVICE"
run_as_root systemctl is-active "$SERVICE"
install_done=1
trap - ERR
REMOTE_SCRIPT

rollback_remote() {
  echo "==> Attempting remote rollback"
ssh "$REMOTE" "bash -s" <<ROLLBACK_SCRIPT
set -euo pipefail
SUDO_CMD=$DEPLOY_SUDO_QUOTED
SERVICE_USER=$SERVICE_USER_QUOTED
run_as_root() {
  if [ -n "\$SUDO_CMD" ]; then
    \$SUDO_CMD "\$@"
  else
    "\$@"
  fi
}
unit_value() {
  key="\$1"
  file="\$2"
  awk -F= -v key="\$key" '
    \$1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", \$2);
      print \$2;
      exit;
    }
  ' "\$file"
}
rollback_data_owner() {
  if [ -f "$UNIT_BACKUP" ]; then
    restored_user="\$(unit_value User "$UNIT_BACKUP")"
    if [ -z "\$restored_user" ]; then
      return 0
    fi
    restored_group="\$(unit_value Group "$UNIT_BACKUP")"
    if [ -z "\$restored_group" ]; then
      restored_group="\$restored_user"
    fi
    printf '%s:%s\n' "\$restored_user" "\$restored_group"
    return 0
  fi
  printf '%s:%s\n' "\$SERVICE_USER" "\$SERVICE_USER"
}
chown_data_for_rollback() {
  owner="\$(rollback_data_owner || true)"
  user="\${owner%%:*}"
  if [ -n "\$owner" ] && [ -n "\$user" ] && id -u "\$user" >/dev/null 2>&1; then
    run_as_root chown -R "\$owner" "$DATA_DIR" || true
  fi
}
run_as_root systemctl stop "$SERVICE" || true
if [ -f "$DATA_BACKUP" ]; then
  run_as_root rm -rf "$DATA_DIR"
  run_as_root mkdir -p "$(dirname "$DATA_DIR")"
  run_as_root tar -xzf "$DATA_BACKUP" -C "$(dirname "$DATA_DIR")"
  chown_data_for_rollback
  echo "Restored data from $DATA_BACKUP"
fi
if [ -f "$API_BACKUP" ]; then
  run_as_root rm -rf "$API_DIR"
  run_as_root mkdir -p "$(dirname "$API_DIR")"
  run_as_root tar -xzf "$API_BACKUP" -C "$(dirname "$API_DIR")"
  echo "Restored API from $API_BACKUP"
fi
if [ -f "$WEB_BACKUP" ]; then
  run_as_root rm -rf "$WEB_DIR"
  run_as_root mkdir -p "$(dirname "$WEB_DIR")"
  run_as_root tar -xzf "$WEB_BACKUP" -C "$(dirname "$WEB_DIR")"
  echo "Restored Web from $WEB_BACKUP"
fi
if [ -f "$UNIT_BACKUP" ]; then
  run_as_root cp "$UNIT_BACKUP" "/etc/systemd/system/$SERVICE.service"
  echo "Restored systemd unit from $UNIT_BACKUP"
fi
if [ -f "$NGINX_MAP_BACKUP" ]; then
  run_as_root cp "$NGINX_MAP_BACKUP" "$NGINX_MAP_CONF"
  echo "Restored nginx map from $NGINX_MAP_BACKUP"
fi
if [ -f "$NGINX_SITE_BACKUP" ]; then
  run_as_root cp "$NGINX_SITE_BACKUP" "$NGINX_SITE_CONF"
  echo "Restored nginx site from $NGINX_SITE_BACKUP"
fi
run_as_root systemctl daemon-reload
run_as_root systemctl restart "$SERVICE"
run_as_root systemctl is-active "$SERVICE"
run_as_root nginx -t
run_as_root systemctl reload nginx
ROLLBACK_SCRIPT
}

echo "==> Running public doctor"
if ! AIMASHI_DOCTOR_EXPECT_RELEASE_COMMIT="$EXPECTED_RELEASE_COMMIT" \
  AIMASHI_DOCTOR_EXPECT_RELEASE_BUILT_AT="$EXPECTED_RELEASE_BUILT_AT" \
  npm run cloud:doctor -- "$PUBLIC_URL"; then
  echo "==> Public doctor failed; attempting remote rollback"
  rollback_remote || echo "Remote rollback failed; inspect $REMOTE manually." >&2
  exit 1
fi

echo "==> Running public smoke"
if ! AIMASHI_SMOKE_EXPECT_RELEASE_COMMIT="$EXPECTED_RELEASE_COMMIT" \
  AIMASHI_SMOKE_EXPECT_RELEASE_BUILT_AT="$EXPECTED_RELEASE_BUILT_AT" \
  npm run cloud:smoke -- "$PUBLIC_URL"; then
  echo "==> Public smoke failed; attempting remote rollback"
  rollback_remote || echo "Remote rollback failed; inspect $REMOTE manually." >&2
  exit 1
fi

echo "Aimashi Cloud deploy completed: $PUBLIC_URL"
