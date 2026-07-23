#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${MIA_DEPLOY_REMOTE:-root@mia.gifgif.cn}"
DATA_DIR="${MIA_RESET_DATA_DIR:-${MIA_DEPLOY_DATA_DIR:-/var/lib/mia-cloud}}"
AGENT_ROOT="${MIA_RESET_AGENT_ROOT:-${MIA_CLOUD_AGENT_ROOT:-/var/lib/mia-cloud-agent-users}}"
BACKUP_DIR="${MIA_RESET_BACKUP_DIR:-${MIA_DEPLOY_BACKUP_DIR:-/root}}"
SERVICE="${MIA_RESET_SERVICE:-${MIA_DEPLOY_SERVICE:-mia-cloud}}"
SERVICE_USER="${MIA_RESET_SERVICE_USER:-${MIA_DEPLOY_SERVICE_USER:-mia-cloud}}"
DEPLOY_SUDO="${MIA_DEPLOY_SUDO:-${MIA_RESET_SUDO:-}}"
RESET_CONFIRM="${MIA_RESET_CONFIRM:-}"
RESET_ID="${MIA_RESET_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
DATA_BACKUP="$BACKUP_DIR/mia-cloud-reset-data-$RESET_ID.tgz"
AGENT_BACKUP="$BACKUP_DIR/mia-cloud-reset-agent-root-$RESET_ID.tgz"
MODEL_GATEWAY_EXPORT="$BACKUP_DIR/mia-cloud-reset-model-gateway-$RESET_ID.json"
CONFIRM_TOKEN="DELETE_ALL_MIA_DATA"

cd "$ROOT"

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

validate_deploy_sudo() {
  if [ -z "$DEPLOY_SUDO" ]; then
    return
  fi
  if printf "%s" "$DEPLOY_SUDO" | LC_ALL=C grep -q '[^A-Za-z0-9_./ -]'; then
    echo "MIA_DEPLOY_SUDO/MIA_RESET_SUDO must be a simple command such as 'sudo -n'." >&2
    exit 1
  fi
}

print_dry_run() {
  cat <<EOF
Mia Cloud production data reset dry run.

Remote: $REMOTE
Service: $SERVICE
Service user: $SERVICE_USER
Data dir: $DATA_DIR
Agent root: $AGENT_ROOT
Backup dir: $BACKUP_DIR
Data backup: $DATA_BACKUP
Agent backup: $AGENT_BACKUP
Model gateway export: $MODEL_GATEWAY_EXPORT

This will delete cloud.sqlite, uploads, avatar-assets, and cloud agent user workdirs
after writing tar backups. It preserves platform model gateway settings and will
not delete website downloads or update feeds.

To execute:
  MIA_RESET_CONFIRM=$CONFIRM_TOKEN bash scripts/reset-cloud-production-data.sh
EOF
}

if [ "$RESET_CONFIRM" != "$CONFIRM_TOKEN" ]; then
  print_dry_run
  exit 0
fi

validate_deploy_sudo
DEPLOY_SUDO_QUOTED="$(shell_quote "$DEPLOY_SUDO")"
DATA_DIR_QUOTED="$(shell_quote "$DATA_DIR")"
AGENT_ROOT_QUOTED="$(shell_quote "$AGENT_ROOT")"
BACKUP_DIR_QUOTED="$(shell_quote "$BACKUP_DIR")"
DATA_BACKUP_QUOTED="$(shell_quote "$DATA_BACKUP")"
AGENT_BACKUP_QUOTED="$(shell_quote "$AGENT_BACKUP")"
MODEL_GATEWAY_EXPORT_QUOTED="$(shell_quote "$MODEL_GATEWAY_EXPORT")"
SERVICE_QUOTED="$(shell_quote "$SERVICE")"
SERVICE_USER_QUOTED="$(shell_quote "$SERVICE_USER")"

echo "==> Checking remote access to $REMOTE"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" "true"

echo "==> Resetting Mia Cloud production data on $REMOTE"
ssh "$REMOTE" "bash -s" <<REMOTE_SCRIPT
set -euo pipefail
SUDO_CMD=$DEPLOY_SUDO_QUOTED
DATA_DIR=$DATA_DIR_QUOTED
AGENT_ROOT=$AGENT_ROOT_QUOTED
BACKUP_DIR=$BACKUP_DIR_QUOTED
DATA_BACKUP=$DATA_BACKUP_QUOTED
AGENT_BACKUP=$AGENT_BACKUP_QUOTED
MODEL_GATEWAY_EXPORT=$MODEL_GATEWAY_EXPORT_QUOTED
SERVICE=$SERVICE_QUOTED
SERVICE_USER=$SERVICE_USER_QUOTED

run_as_root() {
  if [ -n "\$SUDO_CMD" ]; then
    # MIA_DEPLOY_SUDO is validated locally as a simple command string.
    \$SUDO_CMD "\$@"
  else
    "\$@"
  fi
}

reject_unsafe_path() {
  target="\$1"
  label="\$2"
  case "\$target" in
    ""|"/"|"/var"|"/var/"|"/var/lib"|"/var/lib/"|"/home"|"/home/"|"/root"|"/root/"|"/opt"|"/opt/")
      echo "Refusing unsafe \$label path: \$target" >&2
      exit 2
      ;;
  esac
}

backup_path() {
  label="\$1"
  target="\$2"
  backup="\$3"
  best_effort="\${4:-}"
  if [ ! -e "\$target" ]; then
    echo "\$label path does not exist, skipping backup: \$target"
    return
  fi
  run_as_root mkdir -p "\$(dirname "\$backup")"
  if ! run_as_root tar --warning=no-file-changed --ignore-failed-read -C "\$(dirname "\$target")" -czf "\$backup" "\$(basename "\$target")"; then
    if [ "\$best_effort" = "best-effort" ] && [ -f "\$backup" ]; then
      echo "Warning: \$label backup completed with file-change warnings: \$backup" >&2
    else
      return 1
    fi
  fi
  if [ -f "\$backup" ]; then
    run_as_root tar -tzf "\$backup" >/dev/null
  fi
  echo "\$label backup written to \$backup"
}

export_model_gateway_settings() {
  db="\$DATA_DIR/cloud.sqlite"
  export_file="\$MODEL_GATEWAY_EXPORT"
  if [ ! -f "\$db" ]; then
    echo "No cloud sqlite database found, skipping model gateway export: \$db"
    return
  fi
  run_as_root mkdir -p "\$(dirname "\$export_file")"
  run_as_root node - "\$db" "\$export_file" <<'NODE'
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const [dbPath, exportPath] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
let gatewaySettings = [];
let rateCards = [];
try {
  gatewaySettings = db.prepare([
    "SELECT id, mode, model_id, provider, upstream_model, api_base, api_key, updated_at",
    "FROM model_gateway_settings"
  ].join("\n")).all();
} catch (error) {
  if (!/no such table/i.test(error?.message || "")) throw error;
}
try {
  rateCards = db.prepare([
    "SELECT id, provider, upstream_model, version,",
    "       cache_hit_microcny_per_million, cache_miss_microcny_per_million,",
    "       output_microcny_per_million, millipoints_per_cny_cost,",
    "       is_active, created_at, updated_at",
    "FROM model_rate_cards"
  ].join("\n")).all();
} catch (error) {
  if (!/no such table/i.test(error?.message || "")) throw error;
} finally {
  db.close();
}
fs.writeFileSync(exportPath, JSON.stringify({ version: 2, gatewaySettings, rateCards }, null, 2) + "\n", { mode: 0o600 });
NODE
  run_as_root chmod 600 "\$export_file" || true
  echo "Model gateway settings export written to \$export_file"
}

restore_model_gateway_settings() {
  db="\$DATA_DIR/cloud.sqlite"
  export_file="\$MODEL_GATEWAY_EXPORT"
  if [ ! -s "\$export_file" ]; then
    echo "No model gateway settings export found, skipping restore."
    return
  fi
  run_as_root node - "\$db" "\$export_file" <<'NODE'
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const [dbPath, exportPath] = process.argv.slice(2);
const exported = JSON.parse(fs.readFileSync(exportPath, "utf8"));
const gatewaySettings = Array.isArray(exported) ? exported : (Array.isArray(exported?.gatewaySettings) ? exported.gatewaySettings : []);
const rateCards = Array.isArray(exported?.rateCards) ? exported.rateCards : [];
const db = new DatabaseSync(dbPath);
db.exec([
  "CREATE TABLE IF NOT EXISTS model_gateway_settings (",
  "  id                             TEXT PRIMARY KEY,",
  "  mode                           TEXT NOT NULL DEFAULT 'deepseek',",
  "  model_id                       TEXT NOT NULL DEFAULT 'mia-auto',",
  "  provider                       TEXT NOT NULL DEFAULT 'deepseek',",
  "  upstream_model                 TEXT NOT NULL DEFAULT 'deepseek-chat',",
  "  api_base                       TEXT NOT NULL DEFAULT '',",
  "  api_key                        TEXT NOT NULL DEFAULT '',",
  "  input_microusd_per_million     INTEGER NOT NULL DEFAULT 140000,",
  "  output_microusd_per_million    INTEGER NOT NULL DEFAULT 280000,",
  "  markup                         REAL NOT NULL DEFAULT 1,",
  "  updated_at                     TEXT NOT NULL",
  ");",
  "CREATE TABLE IF NOT EXISTS model_rate_cards (",
  "  id                                  TEXT PRIMARY KEY,",
  "  provider                            TEXT NOT NULL,",
  "  upstream_model                      TEXT NOT NULL,",
  "  version                             INTEGER NOT NULL DEFAULT 1,",
  "  cache_hit_microcny_per_million      INTEGER NOT NULL DEFAULT 0,",
  "  cache_miss_microcny_per_million     INTEGER NOT NULL DEFAULT 0,",
  "  output_microcny_per_million         INTEGER NOT NULL DEFAULT 0,",
  "  millipoints_per_cny_cost            INTEGER NOT NULL DEFAULT 50000,",
  "  is_active                           INTEGER NOT NULL DEFAULT 1,",
  "  created_at                          TEXT NOT NULL,",
  "  updated_at                          TEXT NOT NULL,",
  "  UNIQUE(provider, upstream_model, version)",
  ");"
].join("\n"));
const stmt = db.prepare([
  "INSERT INTO model_gateway_settings (",
  "  id, mode, model_id, provider, upstream_model, api_base, api_key, updated_at",
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  "ON CONFLICT(id) DO UPDATE SET",
  "  mode = excluded.mode,",
  "  model_id = excluded.model_id,",
  "  provider = excluded.provider,",
  "  upstream_model = excluded.upstream_model,",
  "  api_base = excluded.api_base,",
  "  api_key = excluded.api_key,",
  "  updated_at = excluded.updated_at"
].join("\n"));
const rateCardStmt = db.prepare([
  "INSERT INTO model_rate_cards (",
  "  id, provider, upstream_model, version,",
  "  cache_hit_microcny_per_million, cache_miss_microcny_per_million,",
  "  output_microcny_per_million, millipoints_per_cny_cost,",
  "  is_active, created_at, updated_at",
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  "ON CONFLICT(id) DO UPDATE SET",
  "  provider = excluded.provider,",
  "  upstream_model = excluded.upstream_model,",
  "  version = excluded.version,",
  "  cache_hit_microcny_per_million = excluded.cache_hit_microcny_per_million,",
  "  cache_miss_microcny_per_million = excluded.cache_miss_microcny_per_million,",
  "  output_microcny_per_million = excluded.output_microcny_per_million,",
  "  millipoints_per_cny_cost = excluded.millipoints_per_cny_cost,",
  "  is_active = excluded.is_active,",
  "  created_at = excluded.created_at,",
  "  updated_at = excluded.updated_at"
].join("\n"));
function text(value, fallback = "") {
  const raw = value == null ? fallback : value;
  return String(raw);
}
function integer(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
db.exec("BEGIN");
try {
  for (const row of gatewaySettings) {
    const id = text(row.id, "").trim();
    if (!id) continue;
    stmt.run(
      id,
      text(row.mode, "deepseek").trim() || "deepseek",
      text(row.model_id, "mia-auto").trim() || "mia-auto",
      text(row.provider, "deepseek").trim() || "deepseek",
      text(row.upstream_model, "deepseek-chat").trim() || "deepseek-chat",
      text(row.api_base, "").trim(),
      text(row.api_key, "").trim(),
      text(row.updated_at, new Date().toISOString())
    );
  }
  for (const row of rateCards) {
    const id = text(row.id, "").trim();
    const provider = text(row.provider, "").trim();
    const upstreamModel = text(row.upstream_model, "").trim();
    if (!id || !provider || !upstreamModel) continue;
    rateCardStmt.run(
      id,
      provider,
      upstreamModel,
      integer(row.version, 1),
      integer(row.cache_hit_microcny_per_million, 0),
      integer(row.cache_miss_microcny_per_million, 0),
      integer(row.output_microcny_per_million, 0),
      integer(row.millipoints_per_cny_cost, 50000),
      integer(row.is_active, 1) ? 1 : 0,
      text(row.created_at, new Date().toISOString()),
      text(row.updated_at, new Date().toISOString())
    );
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}
NODE
  echo "Model gateway settings restored into \$db"
}

reject_unsafe_path "\$DATA_DIR" "data dir"
reject_unsafe_path "\$AGENT_ROOT" "agent root"

if ! command -v systemctl >/dev/null; then
  echo "systemctl is required on the remote host." >&2
  exit 1
fi
if ! command -v tar >/dev/null; then
  echo "tar is required on the remote host." >&2
  exit 1
fi
if ! command -v node >/dev/null; then
  echo "node is required on the remote host to preserve model gateway settings." >&2
  exit 1
fi
node -e 'require("node:sqlite")'

run_as_root mkdir -p "\$BACKUP_DIR"
run_as_root systemctl stop "\$SERVICE" || true

backup_path "data" "\$DATA_DIR" "\$DATA_BACKUP"
backup_path "agent root" "\$AGENT_ROOT" "\$AGENT_BACKUP" "best-effort"
export_model_gateway_settings

run_as_root rm -f "\$DATA_DIR/cloud.sqlite" "\$DATA_DIR/cloud.sqlite-shm" "\$DATA_DIR/cloud.sqlite-wal"
run_as_root rm -rf "\$DATA_DIR/uploads" "\$DATA_DIR/avatar-assets" "\$DATA_DIR/tmp" "\$AGENT_ROOT"
run_as_root mkdir -p "\$DATA_DIR/uploads" "\$AGENT_ROOT"
restore_model_gateway_settings

if id -u "\$SERVICE_USER" >/dev/null 2>&1; then
  run_as_root chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$DATA_DIR" "\$AGENT_ROOT" || run_as_root chown -R "\$SERVICE_USER" "\$DATA_DIR" "\$AGENT_ROOT"
fi

run_as_root systemctl start "\$SERVICE"
sleep 2
run_as_root systemctl is-active --quiet "\$SERVICE"
echo "Mia Cloud production data reset completed."
REMOTE_SCRIPT

echo "Mia Cloud production data reset completed on $REMOTE."
echo "Data backup: $DATA_BACKUP"
echo "Agent backup: $AGENT_BACKUP"
echo "Model gateway export: $MODEL_GATEWAY_EXPORT"
