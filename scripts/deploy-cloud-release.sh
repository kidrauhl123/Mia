#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${MIA_DEPLOY_REMOTE:-root@mia.gifgif.cn}"
PUBLIC_URL="${MIA_CLOUD_PUBLIC_URL:-https://mia.gifgif.cn}"
EXTRA_ALLOWED_ORIGINS="${MIA_CLOUD_EXTRA_ALLOWED_ORIGINS:-https://gifgif.cn}"
if [ -n "${MIA_CLOUD_ALLOWED_ORIGINS:-}" ]; then
  ALLOWED_ORIGINS="$MIA_CLOUD_ALLOWED_ORIGINS"
elif [ -n "$EXTRA_ALLOWED_ORIGINS" ]; then
  ALLOWED_ORIGINS="$PUBLIC_URL,$EXTRA_ALLOWED_ORIGINS"
else
  ALLOWED_ORIGINS="$PUBLIC_URL"
fi
REMOTE_TMP="${MIA_DEPLOY_TMP:-/tmp/mia-cloud-release.tgz}"
REMOTE_RELEASE_DIR="${MIA_DEPLOY_RELEASE_DIR:-/tmp/mia-cloud-release}"
API_DIR="${MIA_DEPLOY_API_DIR:-/opt/mia-cloud}"
WEB_DIR="${MIA_DEPLOY_WEB_DIR:-/var/www/mia-web}"
WEB_BASENAME="$(basename "$WEB_DIR")"
UPDATES_DIR="${MIA_DEPLOY_UPDATES_DIR:-/var/www/mia-updates}"
DATA_DIR="${MIA_DEPLOY_DATA_DIR:-/var/lib/mia-cloud}"
AGENT_ROOT="${MIA_CLOUD_AGENT_ROOT:-/var/lib/mia-cloud-agent-users}"
AGENT_MODE="${MIA_CLOUD_AGENT_MODE:-claude-code}"
DEBIAN_APT_MIRROR="${MIA_DEBIAN_APT_MIRROR:-}"
DEBIAN_APT_SECURITY_MIRROR="${MIA_DEBIAN_APT_SECURITY_MIRROR:-}"
PIP_INDEX_URL="${MIA_PIP_INDEX_URL:-}"
PIP_EXTRA_INDEX_URL="${MIA_PIP_EXTRA_INDEX_URL:-}"
AGENT_PIP_INDEX_URL="${PIP_INDEX_URL:-https://mirrors.tencent.com/pypi/simple}"
AGENT_PYTHON_BIN="${MIA_CLOUD_AGENT_PYTHON_BIN:-python3.12}"
AGENT_PYTHON_VENV="${MIA_CLOUD_AGENT_PYTHON_VENV:-/opt/mia-agent-runtime/python}"
AGENT_PYTHON_PACKAGES="${MIA_CLOUD_AGENT_PYTHON_PACKAGES:-python-pptx python-docx openpyxl xlsxwriter pandas numpy matplotlib pillow reportlab pypdf requests beautifulsoup4 lxml markdown}"
AGENT_OFFICECLI_HOME="${MIA_CLOUD_AGENT_OFFICECLI_HOME:-/opt/mia-agent-runtime/officecli}"
AGENT_MODEL_PROVIDER="${MIA_CLOUD_AGENT_MODEL_PROVIDER:-mia}"
AGENT_MODEL_NAME="${MIA_CLOUD_AGENT_MODEL:-mia-auto}"
AGENT_MODEL_BASE_URL="${MIA_CLOUD_AGENT_MODEL_BASE_URL:-http://litellm:4000/v1}"
AGENT_MODEL_API_KEY="${MIA_CLOUD_AGENT_MODEL_API_KEY:-${MIA_LITELLM_API_KEY:-}}"
CLAUDE_CODE_BASE_URL="${MIA_CLOUD_CLAUDE_CODE_BASE_URL:-${MIA_DEEPSEEK_ANTHROPIC_BASE_URL:-https://api.deepseek.com/anthropic}}"
CLAUDE_CODE_MODEL="${MIA_CLOUD_CLAUDE_CODE_MODEL:-claude-sonnet-4-5}"
CLAUDE_CODE_SANDBOX="${MIA_CLOUD_CLAUDE_CODE_SANDBOX:-1}"
CLAUDE_CODE_SANDBOX_REQUIRED="${MIA_CLOUD_CLAUDE_CODE_SANDBOX_REQUIRED:-1}"
BACKUP_DIR="${MIA_DEPLOY_BACKUP_DIR:-/root}"
BACKUP_KEEP="${MIA_DEPLOY_BACKUP_KEEP:-3}"
SERVICE="${MIA_DEPLOY_SERVICE:-mia-cloud}"
SERVICE_USER="${MIA_DEPLOY_SERVICE_USER:-mia-cloud}"
NGINX_MAP_CONF="${MIA_DEPLOY_NGINX_MAP_CONF:-/etc/nginx/conf.d/mia-websocket-map.conf}"
NGINX_SITE_CONF="${MIA_DEPLOY_NGINX_SITE_CONF:-/etc/nginx/sites-enabled/mia-web}"
DEPLOY_SUDO="${MIA_DEPLOY_SUDO:-}"
DEPLOY_DRY_RUN="${MIA_DEPLOY_DRY_RUN:-}"
DEPLOY_SKIP_LOCAL_TESTS="${MIA_DEPLOY_SKIP_LOCAL_TESTS:-}"
DEPLOY_SKIP_SMOKE="${MIA_DEPLOY_SKIP_SMOKE:-}"
ARCHIVE="$ROOT/dist/mia-cloud-release.tgz"
ARCHIVE_SHA="$ARCHIVE.sha256"
DEPLOY_ID="${MIA_DEPLOY_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
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
LEGACY_NGINX_MAP_CONF="${MIA_DEPLOY_LEGACY_NGINX_MAP_CONF:-/etc/nginx/conf.d/$LEGACY_SLUG-websocket-map.conf}"
LEGACY_NGINX_SITE_CONF="${MIA_DEPLOY_LEGACY_NGINX_SITE_CONF:-/etc/nginx/sites-enabled/$LEGACY_SLUG-web}"

cd "$ROOT"

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

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
DEPLOY_SUDO_QUOTED="$(shell_quote "$DEPLOY_SUDO")"
SERVICE_USER_QUOTED="$(shell_quote "$SERVICE_USER")"
DEBIAN_APT_MIRROR_QUOTED="$(shell_quote "$DEBIAN_APT_MIRROR")"
DEBIAN_APT_SECURITY_MIRROR_QUOTED="$(shell_quote "$DEBIAN_APT_SECURITY_MIRROR")"
PIP_INDEX_URL_QUOTED="$(shell_quote "$PIP_INDEX_URL")"
PIP_EXTRA_INDEX_URL_QUOTED="$(shell_quote "$PIP_EXTRA_INDEX_URL")"
AGENT_PIP_INDEX_URL_QUOTED="$(shell_quote "$AGENT_PIP_INDEX_URL")"
AGENT_PYTHON_BIN_QUOTED="$(shell_quote "$AGENT_PYTHON_BIN")"
AGENT_PYTHON_VENV_QUOTED="$(shell_quote "$AGENT_PYTHON_VENV")"
AGENT_PYTHON_PACKAGES_QUOTED="$(shell_quote "$AGENT_PYTHON_PACKAGES")"
AGENT_OFFICECLI_HOME_QUOTED="$(shell_quote "$AGENT_OFFICECLI_HOME")"
AGENT_MODE_QUOTED="$(shell_quote "$AGENT_MODE")"
CLAUDE_CODE_BASE_URL_QUOTED="$(shell_quote "$CLAUDE_CODE_BASE_URL")"
CLAUDE_CODE_MODEL_QUOTED="$(shell_quote "$CLAUDE_CODE_MODEL")"
CLAUDE_CODE_SANDBOX_QUOTED="$(shell_quote "$CLAUDE_CODE_SANDBOX")"
CLAUDE_CODE_SANDBOX_REQUIRED_QUOTED="$(shell_quote "$CLAUDE_CODE_SANDBOX_REQUIRED")"
BACKUP_KEEP_QUOTED="$(shell_quote "$BACKUP_KEEP")"
WEB_BASENAME_QUOTED="$(shell_quote "$WEB_BASENAME")"
LEGACY_SERVICE_QUOTED="$(shell_quote "$LEGACY_SERVICE")"
LEGACY_DATA_DIR_QUOTED="$(shell_quote "$LEGACY_DATA_DIR")"
LEGACY_AGENT_ROOT_QUOTED="$(shell_quote "$LEGACY_AGENT_ROOT")"
LEGACY_ETC_DIR_QUOTED="$(shell_quote "$LEGACY_ETC_DIR")"
LEGACY_NGINX_MAP_CONF_QUOTED="$(shell_quote "$LEGACY_NGINX_MAP_CONF")"
LEGACY_NGINX_SITE_CONF_QUOTED="$(shell_quote "$LEGACY_NGINX_SITE_CONF")"

print_ssh_help() {
  echo
  echo "Remote SSH access failed for $REMOTE."
  if ssh-add -l >/tmp/mia-deploy-ssh-agent.$$ 2>&1; then
    identities="$(wc -l < /tmp/mia-deploy-ssh-agent.$$ | tr -d ' ')"
    echo "Local ssh-agent identities: $identities loaded."
    echo "A key is loaded locally; if SSH is still denied, inspect VPS authorized_keys and sshd policy with the diagnostics printed by cloud:deploy:authorize-help."
    echo "For a local filtered auth trace, run: MIA_DEPLOY_REMOTE=\"$REMOTE\" npm run cloud:deploy:ssh-diagnose"
  elif grep -qi "no identities" /tmp/mia-deploy-ssh-agent.$$; then
    echo "Local ssh-agent identities: none loaded."
    echo "If your deployment key has a passphrase, run: ssh-add ~/.ssh/id_ed25519"
  else
    echo "Local ssh-agent status: unavailable."
  fi
  rm -f /tmp/mia-deploy-ssh-agent.$$
  echo "Run this locally to print the public-key authorization command for the VPS operator:"
  echo "  MIA_DEPLOY_REMOTE=\"$REMOTE\" npm run cloud:deploy:authorize-help"
  echo
}

if [ "$DEPLOY_DRY_RUN" != "1" ]; then
  echo "==> Checking remote access to $REMOTE"
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" "true"; then
    print_ssh_help
    exit 255
  fi

  echo "==> Checking remote runtime prerequisites"
  remote_check="node -e 'require(\"node:sqlite\"); const major = Number(process.versions.node.split(\".\")[0]); if (major < 25) { console.error(\"Node.js 25+ is required, found \" + process.version); process.exit(1); }' && command -v npm >/dev/null && command -v rsync >/dev/null && command -v systemctl >/dev/null && command -v tar >/dev/null && command -v id >/dev/null && command -v chown >/dev/null"
  remote_check="$remote_check && (id -u $SERVICE_USER_QUOTED >/dev/null 2>&1 || command -v useradd >/dev/null || test -x /usr/sbin/useradd) && (command -v sha256sum >/dev/null || command -v shasum >/dev/null)"
  ssh "$REMOTE" "$remote_check"

  if [ -n "$DEPLOY_SUDO" ]; then
    echo "==> Checking remote privilege command: $DEPLOY_SUDO"
    ssh "$REMOTE" "$DEPLOY_SUDO true"
  fi
else
  echo "==> Dry run: skipping SSH, upload, install, and public smoke"
fi

echo "==> Verifying local source"
node src/check.js
if [ "$DEPLOY_SKIP_LOCAL_TESTS" = "1" ]; then
  echo "==> Skipping npm test because MIA_DEPLOY_SKIP_LOCAL_TESTS=1"
else
  npm test
fi

echo "==> Building release"
npm run cloud:release
(cd "$ROOT/dist" && shasum -a 256 -c "$(basename "$ARCHIVE_SHA")")
MIA_INSTALL_VERIFY_ONLY=1 bash "$ROOT/dist/mia-cloud-release/install-cloud-release-local.sh" "$ARCHIVE"
npm run cloud:release:handoff:file
npm run cloud:release:handoff:verify
npm run cloud:release:handoff:bundle
npm run cloud:release:handoff:bundle:verify
EXPECTED_RELEASE_COMMIT="$(node -e "const m=require('./dist/mia-cloud-release/manifest.json'); process.stdout.write(String(m.source?.gitCommit || ''))")"
EXPECTED_RELEASE_BUILT_AT="$(node -e "const m=require('./dist/mia-cloud-release/manifest.json'); process.stdout.write(String(m.builtAt || ''))")"

if [ "$DEPLOY_DRY_RUN" = "1" ]; then
  echo "Mia Cloud deploy dry run completed."
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
rsync -av --checksum --partial "$ARCHIVE" "$REMOTE:$REMOTE_TMP"
rsync -av --checksum --partial "$ARCHIVE_SHA" "$REMOTE:$REMOTE_TMP.sha256"

echo "==> Installing release on $REMOTE"
ssh "$REMOTE" "bash -s" <<REMOTE_SCRIPT
set -euo pipefail
SUDO_CMD=$DEPLOY_SUDO_QUOTED
SERVICE_USER=$SERVICE_USER_QUOTED
DEBIAN_APT_MIRROR=$DEBIAN_APT_MIRROR_QUOTED
DEBIAN_APT_SECURITY_MIRROR=$DEBIAN_APT_SECURITY_MIRROR_QUOTED
PIP_INDEX_URL=$PIP_INDEX_URL_QUOTED
PIP_EXTRA_INDEX_URL=$PIP_EXTRA_INDEX_URL_QUOTED
AGENT_PIP_INDEX_URL=$AGENT_PIP_INDEX_URL_QUOTED
AGENT_PYTHON_BIN=$AGENT_PYTHON_BIN_QUOTED
AGENT_PYTHON_VENV=$AGENT_PYTHON_VENV_QUOTED
AGENT_PYTHON_PACKAGES=$AGENT_PYTHON_PACKAGES_QUOTED
AGENT_OFFICECLI_HOME=$AGENT_OFFICECLI_HOME_QUOTED
AGENT_MODE=$AGENT_MODE_QUOTED
CLAUDE_CODE_BASE_URL=$CLAUDE_CODE_BASE_URL_QUOTED
CLAUDE_CODE_MODEL=$CLAUDE_CODE_MODEL_QUOTED
CLAUDE_CODE_SANDBOX=$CLAUDE_CODE_SANDBOX_QUOTED
CLAUDE_CODE_SANDBOX_REQUIRED=$CLAUDE_CODE_SANDBOX_REQUIRED_QUOTED
BACKUP_KEEP=$BACKUP_KEEP_QUOTED
WEB_BASENAME=$WEB_BASENAME_QUOTED
LEGACY_SERVICE=$LEGACY_SERVICE_QUOTED
LEGACY_DATA_DIR=$LEGACY_DATA_DIR_QUOTED
LEGACY_AGENT_ROOT=$LEGACY_AGENT_ROOT_QUOTED
LEGACY_ETC_DIR=$LEGACY_ETC_DIR_QUOTED
LEGACY_NGINX_MAP_CONF=$LEGACY_NGINX_MAP_CONF_QUOTED
LEGACY_NGINX_SITE_CONF=$LEGACY_NGINX_SITE_CONF_QUOTED
run_as_root() {
  if [ -n "\$SUDO_CMD" ]; then
    # MIA_DEPLOY_SUDO is intentionally a command string, for example: sudo -n
    \$SUDO_CMD "\$@"
  else
    "\$@"
  fi
}

truthy_value() {
  case "\$(printf "%s" "\$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

needs_claude_code_sandbox_deps() {
  case "\$AGENT_MODE" in
    claude|claude-code|cloud-claude-code) ;;
    *) return 1 ;;
  esac
  truthy_value "\$CLAUDE_CODE_SANDBOX" && truthy_value "\$CLAUDE_CODE_SANDBOX_REQUIRED"
}

uses_claude_code_agent() {
  case "\$AGENT_MODE" in
    claude|claude-code|cloud-claude-code) return 0 ;;
    *) return 1 ;;
  esac
}

agent_python_runtime_enabled() {
  case "\$(printf "%s" "\$AGENT_PYTHON_VENV" | tr '[:upper:]' '[:lower:]')" in
    ""|0|false|no|off) return 1 ;;
    *) return 0 ;;
  esac
}

install_system_packages() {
  if [ "\$#" -eq 0 ]; then
    return
  fi
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "\$@"
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y "\$@"
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y "\$@"
  else
    echo "Missing package manager; install required packages manually: \$*" >&2
    exit 1
  fi
}

ensure_agent_python_binary() {
  if command -v "\$AGENT_PYTHON_BIN" >/dev/null 2>&1; then
    return
  fi
  echo "Installing Agent Python runtime binary: \$AGENT_PYTHON_BIN"
  if command -v apt-get >/dev/null 2>&1; then
    install_system_packages "\$AGENT_PYTHON_BIN" "\$AGENT_PYTHON_BIN-venv" "\$AGENT_PYTHON_BIN-pip"
  else
    install_system_packages "\$AGENT_PYTHON_BIN" "\$AGENT_PYTHON_BIN-pip"
  fi
}

write_agent_python_pip_conf() {
  tmp_conf="\$(mktemp "\${TMPDIR:-/tmp}/mia-agent-pip.XXXXXX")"
  {
    printf '[global]\n'
    printf 'index-url = %s\n' "\$AGENT_PIP_INDEX_URL"
    printf 'trusted-host = mirrors.tencent.com\n'
    printf 'retries = 5\n'
    printf 'timeout = 60\n'
    if [ -n "\$PIP_EXTRA_INDEX_URL" ]; then
      printf 'extra-index-url = %s\n' "\$PIP_EXTRA_INDEX_URL"
    fi
  } > "\$tmp_conf"
  run_as_root cp "\$tmp_conf" "\$AGENT_PYTHON_VENV/pip.conf"
  rm -f "\$tmp_conf"
}

ensure_agent_python_runtime() {
  if ! uses_claude_code_agent || ! agent_python_runtime_enabled; then
    return
  fi
  ensure_agent_python_binary
  run_as_root mkdir -p "\$(dirname "\$AGENT_PYTHON_VENV")"
  if [ ! -x "\$AGENT_PYTHON_VENV/bin/python" ]; then
    echo "Creating Agent Python venv: \$AGENT_PYTHON_VENV"
    run_as_root "\$AGENT_PYTHON_BIN" -m venv "\$AGENT_PYTHON_VENV"
  fi
  write_agent_python_pip_conf
  run_as_root env PIP_CONFIG_FILE="\$AGENT_PYTHON_VENV/pip.conf" "\$AGENT_PYTHON_VENV/bin/python" -m pip install --upgrade pip setuptools wheel
  if [ -n "\$AGENT_PYTHON_PACKAGES" ]; then
    echo "Installing Agent Python packages: \$AGENT_PYTHON_PACKAGES"
    run_as_root env PIP_CONFIG_FILE="\$AGENT_PYTHON_VENV/pip.conf" "\$AGENT_PYTHON_VENV/bin/python" -m pip install \$AGENT_PYTHON_PACKAGES
  fi
  run_as_root chmod -R a+rX "\$AGENT_PYTHON_VENV"
  run_as_root "\$AGENT_PYTHON_VENV/bin/python" -c 'import pptx, docx, openpyxl, pandas, matplotlib, PIL, reportlab, pypdf, requests, bs4, lxml, markdown; print("Agent Python runtime OK")'
}

officecli_runtime_enabled() {
  case "\$(printf "%s" "\$AGENT_OFFICECLI_HOME" | tr '[:upper:]' '[:lower:]')" in
    ""|0|false|no|off) return 1 ;;
    *) return 0 ;;
  esac
}

ensure_officecli_runtime() {
  if ! officecli_runtime_enabled; then
    return
  fi
  run_as_root env MIA_CLOUD_AGENT_OFFICECLI_HOME="\$AGENT_OFFICECLI_HOME" \
    bash "$REMOTE_RELEASE_DIR/install-officecli-runtime.sh"
}

ensure_claude_code_sandbox_deps() {
  if ! needs_claude_code_sandbox_deps; then
    return
  fi
  packages=()
  if ! command -v bwrap >/dev/null 2>&1; then
    packages+=(bubblewrap)
  fi
  if ! command -v socat >/dev/null 2>&1; then
    packages+=(socat)
  fi
  if [ "\${#packages[@]}" -gt 0 ]; then
    echo "Installing Claude Code sandbox dependencies: \${packages[*]}"
    install_system_packages "\${packages[@]}"
  fi
  command -v bwrap >/dev/null || { echo "Missing required command: bwrap" >&2; exit 1; }
  command -v socat >/dev/null || { echo "Missing required command: socat" >&2; exit 1; }
}

restore_web_backup() {
  backup="\$1"
  tmp="\$(mktemp -d "\${TMPDIR:-/tmp}/mia-web-rollback.XXXXXX")"
  run_as_root mkdir -p "$WEB_DIR"
  run_as_root tar -xzf "\$backup" -C "\$tmp"
  run_as_root rsync -a --delete --exclude '/downloads/' "\$tmp/\$WEB_BASENAME/" "$WEB_DIR/"
  run_as_root rm -rf "\$tmp"
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

stop_legacy_service() {
  if [ -z "\$LEGACY_SERVICE" ] || [ "\$LEGACY_SERVICE" = "$SERVICE" ]; then
    return
  fi
  if systemctl list-unit-files "\$LEGACY_SERVICE.service" >/dev/null 2>&1 || systemctl status "\$LEGACY_SERVICE" >/dev/null 2>&1; then
    run_as_root systemctl stop "\$LEGACY_SERVICE" || true
  fi
}

disable_legacy_service() {
  if [ -z "\$LEGACY_SERVICE" ] || [ "\$LEGACY_SERVICE" = "$SERVICE" ]; then
    return
  fi
  run_as_root systemctl disable "\$LEGACY_SERVICE" >/dev/null 2>&1 || true
}

migrate_legacy_dir() {
  src="\$1"
  dst="\$2"
  label="\$3"
  if [ -e "\$dst" ] || [ ! -d "\$src" ]; then
    return
  fi
  echo "Migrating legacy \$label to \$dst"
  run_as_root mkdir -p "\$(dirname "\$dst")" "\$dst"
  run_as_root rsync -a "\$src/" "\$dst/"
}

migrate_legacy_admin_env() {
  src="\$LEGACY_ETC_DIR/admin.env"
  dst="/etc/mia-cloud/admin.env"
  if [ -f "\$dst" ] || [ ! -f "\$src" ]; then
    return
  fi
  legacy_slug="\$(basename "\$LEGACY_SERVICE" | sed 's/-cloud$//')"
  legacy_upper="\$(printf '%s' "\$legacy_slug" | tr '[:lower:]' '[:upper:]')"
  legacy_title="\$(printf '%s' "\$legacy_slug" | awk '{ print toupper(substr(\$0,1,1)) substr(\$0,2) }')"
  echo "Migrating legacy admin env to \$dst"
  run_as_root mkdir -p /etc/mia-cloud
  sed "s/\${legacy_upper}_/MIA_/g;s/\${legacy_title}/Mia/g;s/\${legacy_slug}/mia/g" "\$src" | run_as_root tee "\$dst" >/dev/null
  run_as_root chmod 600 "\$dst"
}

migrate_legacy_dropins() {
  src_dir="/etc/systemd/system/\$LEGACY_SERVICE.service.d"
  dst_dir="/etc/systemd/system/$SERVICE.service.d"
  if [ -d "\$dst_dir" ] || [ ! -d "\$src_dir" ]; then
    return
  fi
  legacy_slug="\$(basename "\$LEGACY_SERVICE" | sed 's/-cloud$//')"
  legacy_upper="\$(printf '%s' "\$legacy_slug" | tr '[:lower:]' '[:upper:]')"
  echo "Migrating legacy systemd drop-ins to \$dst_dir"
  run_as_root mkdir -p "\$dst_dir"
  for src in "\$src_dir"/*.conf; do
    [ -f "\$src" ] || continue
    sed "s/\${legacy_upper}_/MIA_/g;s/\${legacy_slug}/mia/g" "\$src" | run_as_root tee "\$dst_dir/\$(basename "\$src")" >/dev/null
  done
}

sync_web_release() {
  if [ -d "$REMOTE_RELEASE_DIR/web/downloads" ]; then
    run_as_root mkdir -p "$WEB_DIR/downloads"
    run_as_root rsync -a "$REMOTE_RELEASE_DIR/web/downloads/" "$WEB_DIR/downloads/"
  fi
  run_as_root rsync -a --delete --exclude '/downloads/' "$REMOTE_RELEASE_DIR/web/" "$WEB_DIR/"
}

remove_legacy_nginx_sites() {
  run_as_root rm -f "\$LEGACY_NGINX_MAP_CONF" "\$LEGACY_NGINX_SITE_CONF"
  run_as_root rm -f "/etc/nginx/sites-available/\$(basename "\$LEGACY_NGINX_SITE_CONF")"
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
  if [ -n "\$LEGACY_SERVICE" ] && [ "\$LEGACY_SERVICE" != "$SERVICE" ]; then
    run_as_root systemctl start "\$LEGACY_SERVICE" || true
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

ensure_claude_code_sandbox_deps
ensure_agent_python_runtime
ensure_officecli_runtime
run_as_root mkdir -p "$BACKUP_DIR"
ensure_service_user
stop_legacy_service
migrate_legacy_dir "\$LEGACY_DATA_DIR" "$DATA_DIR" "data"
migrate_legacy_dir "\$LEGACY_AGENT_ROOT" "$AGENT_ROOT" "agent root"
migrate_legacy_admin_env
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
  run_as_root tar --exclude "\$WEB_BASENAME/downloads" -C "$(dirname "$WEB_DIR")" -czf "$WEB_BACKUP" "\$WEB_BASENAME"
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
run_as_root rsync -a --delete "$REMOTE_RELEASE_DIR/api/" "$API_DIR/"
run_as_root cp "$REMOTE_RELEASE_DIR/manifest.json" "$API_DIR/release-manifest.json"
sync_web_release
run_as_root mkdir -p "$(dirname "$NGINX_MAP_CONF")" "$(dirname "$NGINX_SITE_CONF")"
run_as_root cp "$REMOTE_RELEASE_DIR/nginx/mia-websocket-map.conf" "$NGINX_MAP_CONF"
run_as_root cp "$REMOTE_RELEASE_DIR/nginx/mia-cloud-site.conf" "$NGINX_SITE_CONF"
remove_legacy_nginx_sites
run_as_root rm -f /etc/nginx/sites-enabled/litellm-admin /etc/nginx/sites-available/litellm-admin
run_as_root nginx -t
run_as_root systemctl reload nginx
run_as_root chown -R "\$SERVICE_USER:\$SERVICE_USER" "$DATA_DIR" "$AGENT_ROOT"
cd "$API_DIR"
run_as_root npm install --omit=dev
unit_tmp="$REMOTE_RELEASE_DIR/$SERVICE.service"
cat > "\$unit_tmp" <<SERVICE_UNIT
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
Environment=MIA_CLOUD_AGENT_MODE=$AGENT_MODE
Environment=MIA_CLOUD_AGENT_ROOT=$AGENT_ROOT
Environment=MIA_CLOUD_AGENT_PYTHON_VENV=$AGENT_PYTHON_VENV
Environment=MIA_CLOUD_AGENT_OFFICECLI_HOME=$AGENT_OFFICECLI_HOME
Environment=MIA_PIP_INDEX_URL=$AGENT_PIP_INDEX_URL
Environment=MIA_PIP_EXTRA_INDEX_URL=$PIP_EXTRA_INDEX_URL
Environment=MIA_CLOUD_CLAUDE_CODE_BASE_URL=$CLAUDE_CODE_BASE_URL
Environment=MIA_CLOUD_CLAUDE_CODE_MODEL=$CLAUDE_CODE_MODEL
Environment=MIA_CLOUD_CLAUDE_CODE_SANDBOX=$CLAUDE_CODE_SANDBOX
Environment=MIA_CLOUD_CLAUDE_CODE_SANDBOX_REQUIRED=$CLAUDE_CODE_SANDBOX_REQUIRED
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
run_as_root cp "\$unit_tmp" "/etc/systemd/system/$SERVICE.service"
migrate_legacy_dropins
run_as_root systemctl daemon-reload
run_as_root systemctl enable "$SERVICE"
run_as_root systemctl restart "$SERVICE"
run_as_root systemctl is-active "$SERVICE"
disable_legacy_service
install_done=1
trap - ERR
REMOTE_SCRIPT

rollback_remote() {
  echo "==> Attempting remote rollback"
ssh "$REMOTE" "bash -s" <<ROLLBACK_SCRIPT
set -euo pipefail
SUDO_CMD=$DEPLOY_SUDO_QUOTED
SERVICE_USER=$SERVICE_USER_QUOTED
WEB_BASENAME=$WEB_BASENAME_QUOTED
run_as_root() {
  if [ -n "\$SUDO_CMD" ]; then
    \$SUDO_CMD "\$@"
  else
    "\$@"
  fi
}
restore_web_backup() {
  backup="\$1"
  tmp="\$(mktemp -d "\${TMPDIR:-/tmp}/mia-web-rollback.XXXXXX")"
  run_as_root mkdir -p "$WEB_DIR"
  run_as_root tar -xzf "\$backup" -C "\$tmp"
  run_as_root rsync -a --delete --exclude '/downloads/' "\$tmp/\$WEB_BASENAME/" "$WEB_DIR/"
  run_as_root rm -rf "\$tmp"
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
  restore_web_backup "$WEB_BACKUP"
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

cleanup_remote_backups() {
  echo "==> Cleaning old remote backups"
  ssh "$REMOTE" "bash -s" <<CLEANUP_SCRIPT
set -euo pipefail
SUDO_CMD=$DEPLOY_SUDO_QUOTED
BACKUP_KEEP=$BACKUP_KEEP_QUOTED
run_as_root() {
  if [ -n "\$SUDO_CMD" ]; then
    \$SUDO_CMD "\$@"
  else
    "\$@"
  fi
}
cleanup_backup_pattern() {
  pattern="\$1"
  case "\$BACKUP_KEEP" in
    ""|*[!0-9]*) echo "Skipping backup cleanup; invalid MIA_DEPLOY_BACKUP_KEEP=\$BACKUP_KEEP" >&2; return 0 ;;
  esac
  if [ "\$BACKUP_KEEP" -le 0 ] || [ ! -d "$BACKUP_DIR" ] || ! command -v find >/dev/null; then
    return 0
  fi
  old_files="\$(run_as_root find "$BACKUP_DIR" -maxdepth 1 -type f -name "\$pattern" -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk -v keep="\$BACKUP_KEEP" 'NR > keep { sub(/^[^ ]+ /, ""); print }')"
  if [ -z "\$old_files" ]; then
    return 0
  fi
  printf '%s\n' "\$old_files" | while IFS= read -r file; do
    [ -n "\$file" ] && run_as_root rm -f "\$file"
  done
}
cleanup_backup_pattern 'mia-cloud-api-*.tgz'
cleanup_backup_pattern 'mia-cloud-web-*.tgz'
cleanup_backup_pattern 'mia-cloud-data-*.tgz'
cleanup_backup_pattern 'mia-cloud-*-unit-*.service'
cleanup_backup_pattern 'mia-cloud-nginx-map-*.conf'
cleanup_backup_pattern 'mia-cloud-nginx-site-*.conf'
CLEANUP_SCRIPT
}

wait_for_public_release() {
  echo "==> Waiting for public health"
  MIA_WAIT_PUBLIC_URL="$PUBLIC_URL" \
    MIA_WAIT_EXPECT_RELEASE_COMMIT="$EXPECTED_RELEASE_COMMIT" \
    MIA_WAIT_EXPECT_RELEASE_BUILT_AT="$EXPECTED_RELEASE_BUILT_AT" \
    node <<'NODE'
const baseUrl = String(process.env.MIA_WAIT_PUBLIC_URL || "").replace(/\/+$/, "");
const expectedCommit = String(process.env.MIA_WAIT_EXPECT_RELEASE_COMMIT || "");
const expectedBuiltAt = String(process.env.MIA_WAIT_EXPECT_RELEASE_BUILT_AT || "");
const timeoutMs = Number(process.env.MIA_WAIT_TIMEOUT_MS || 60000);
const intervalMs = Number(process.env.MIA_WAIT_INTERVAL_MS || 2000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const deadline = Date.now() + timeoutMs;
  let last = "not checked";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: baseUrl }
      });
      const body = await response.text();
      if (!response.ok) {
        last = `HTTP ${response.status}`;
      } else {
        const health = body ? JSON.parse(body) : {};
        const release = health.release || {};
        const commitMatches = !expectedCommit || release.gitCommit === expectedCommit;
        const builtAtMatches = !expectedBuiltAt || release.builtAt === expectedBuiltAt;
        if (commitMatches && builtAtMatches) {
          console.log(`Public health is serving ${release.gitCommit || "unknown"} ${release.builtAt || ""}`.trim());
          return;
        }
        last = `release commit ${release.gitCommit || "missing"} builtAt ${release.builtAt || "missing"}`;
      }
    } catch (error) {
      last = error.message;
    }
    await sleep(intervalMs);
  }
  console.error(`Timed out waiting for public health: ${last}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`Failed while waiting for public health: ${error.message}`);
  process.exit(1);
});
NODE
}

if ! wait_for_public_release; then
  echo "==> Public health did not become ready; attempting remote rollback"
  rollback_remote || echo "Remote rollback failed; inspect $REMOTE manually." >&2
  exit 1
fi

echo "==> Running public doctor"
if ! MIA_DOCTOR_EXPECT_RELEASE_COMMIT="$EXPECTED_RELEASE_COMMIT" \
  MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT="$EXPECTED_RELEASE_BUILT_AT" \
  npm run cloud:doctor -- "$PUBLIC_URL"; then
  echo "==> Public doctor failed; attempting remote rollback"
  rollback_remote || echo "Remote rollback failed; inspect $REMOTE manually." >&2
  exit 1
fi

if [ "$DEPLOY_SKIP_SMOKE" = "1" ]; then
  echo "==> Skipping public smoke because MIA_DEPLOY_SKIP_SMOKE=1"
else
  echo "==> Running public smoke"
  if ! MIA_SMOKE_EXPECT_RELEASE_COMMIT="$EXPECTED_RELEASE_COMMIT" \
    MIA_SMOKE_EXPECT_RELEASE_BUILT_AT="$EXPECTED_RELEASE_BUILT_AT" \
    npm run cloud:smoke -- "$PUBLIC_URL"; then
    echo "==> Public smoke failed; attempting remote rollback"
    rollback_remote || echo "Remote rollback failed; inspect $REMOTE manually." >&2
    exit 1
  fi
fi

echo "==> Running public site verification"
if ! npm run cloud:site-verify -- "$PUBLIC_URL"; then
  echo "==> Public site verification failed; attempting remote rollback"
  rollback_remote || echo "Remote rollback failed; inspect $REMOTE manually." >&2
  exit 1
fi

cleanup_remote_backups || echo "Remote backup cleanup failed; inspect $REMOTE:$BACKUP_DIR manually." >&2

echo "Mia Cloud deploy completed: $PUBLIC_URL"
