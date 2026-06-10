#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { generatePrincipalId } = require("../src/shared/ids.js");
const { dmConversationId } = require("../src/cloud/dm-conversation.js");

const CURRENT_USER_ID_RE = /^[1-9][0-9]{9}$/;
const DEFAULT_ACCOUNTS = ["755439", "Marcos", "king"];

const USER_ID_COLUMNS = [
  ["users", "id"],
  ["sessions", "user_id"],
  ["workspaces", "user_id"],
  ["files", "user_id"],
  ["bridge_devices", "user_id"],
  ["bridge_runs", "user_id"],
  ["friend_requests", "from_user"],
  ["friend_requests", "to_user"],
  ["conversation_members", "owner_id"],
  ["messages", "sender_owner_id"],
  ["message_hidden", "user_id"],
  ["user_events", "user_id"],
  ["op_idempotency", "user_id"],
  ["bots", "owner_user_id"],
  ["user_settings", "user_id"],
  ["bot_runtime_bindings", "user_id"],
  ["cloud_agent_runs", "user_id"],
  ["skills", "owner_user_id"],
  ["skill_installs", "user_id"],
  ["skill_reports", "reporter_id"]
];

const CONVERSATION_ID_COLUMNS = [
  ["conversations", "id"],
  ["conversation_members", "conversation_id"],
  ["messages", "conversation_id"],
  ["message_hidden", "conversation_id"],
  ["bridge_runs", "conversation_id"],
  ["cloud_agent_runs", "conversation_id"]
];

const JSON_COLUMNS = [
  ["workspaces", ["snapshot_json"]],
  ["conversations", ["host_member_json", "decorations_json", "context_card_json"]],
  ["conversation_members", ["ai_perms_json"]],
  ["messages", ["attachments_json", "mentions_json", "skills_json", "trace_json", "error_json"]],
  ["bridge_devices", ["capabilities_json"]],
  ["bridge_runs", ["request_attachments_json", "attachments_json"]],
  ["user_events", ["payload"]],
  ["op_idempotency", ["result_json"]],
  ["bots", ["avatar_crop_json", "status_badge_json", "capabilities_json"]],
  ["user_settings", ["pins_json", "read_marks_json", "appearance_json"]],
  ["bot_runtime_bindings", ["config_json"]],
  ["cloud_agent_runs", ["error_json"]],
  ["skill_versions", ["manifest_json"]]
];

function normalizeAccount(value) {
  return String(value || "").trim().toLowerCase();
}

function isCurrentUserId(value) {
  return CURRENT_USER_ID_RE.test(String(value || "").trim());
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db, table, column) {
  return tableColumns(db, table).has(column);
}

function updateExactColumn(db, table, column, oldValue, newValue, extraWhere = "") {
  if (!hasColumn(db, table, column)) return 0;
  const where = extraWhere ? ` AND ${extraWhere}` : "";
  return db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?${where}`)
    .run(newValue, oldValue).changes;
}

function directReplacementMap(idMap, conversationIdMap) {
  return new Map([
    ...Array.from(conversationIdMap.entries()),
    ...Array.from(idMap.entries())
  ]);
}

function replaceAllMapped(value, replacements) {
  let out = String(value);
  for (const [oldValue, newValue] of replacements) {
    out = out.split(oldValue).join(newValue);
  }
  return out;
}

function containsAnyMapped(value, replacements) {
  const text = String(value || "");
  for (const oldValue of replacements.keys()) {
    if (text.includes(oldValue)) return true;
  }
  return false;
}

function replaceJsonValue(value, replacements) {
  if (typeof value === "string") return replaceAllMapped(value, replacements);
  if (Array.isArray(value)) return value.map((item) => replaceJsonValue(item, replacements));
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[replaceAllMapped(key, replacements)] = replaceJsonValue(item, replacements);
    }
    return next;
  }
  return value;
}

function replaceJsonColumns(db, replacements) {
  let changed = 0;
  if (!replacements.size) return changed;
  for (const [table, columns] of JSON_COLUMNS) {
    if (!hasTable(db, table)) continue;
    const existing = columns.filter((column) => hasColumn(db, table, column));
    if (!existing.length) continue;
    const rows = db.prepare(`SELECT rowid AS _rowid, ${existing.join(", ")} FROM ${table}`).all();
    for (const row of rows) {
      const patches = {};
      for (const column of existing) {
        const raw = row[column];
        if (!raw || !containsAnyMapped(raw, replacements)) continue;
        let next = "";
        try {
          next = JSON.stringify(replaceJsonValue(JSON.parse(String(raw)), replacements));
        } catch {
          next = replaceAllMapped(raw, replacements);
        }
        if (next !== raw) patches[column] = next;
      }
      const entries = Object.entries(patches);
      if (!entries.length) continue;
      const setSql = entries.map(([column]) => `${column} = ?`).join(", ");
      db.prepare(`UPDATE ${table} SET ${setSql} WHERE rowid = ?`)
        .run(...entries.map(([, value]) => value), row._rowid);
      changed += entries.length;
    }
  }
  return changed;
}

function parseDmParticipants(db, conversation) {
  const id = String(conversation.id || "");
  if (id.startsWith("dm:")) {
    const parts = id.split(":");
    if (parts.length === 3 && parts[1] && parts[2]) return [parts[1], parts[2]];
  }
  const members = db.prepare(`
    SELECT member_ref FROM conversation_members
    WHERE conversation_id = ? AND member_kind = 'user'
    ORDER BY member_ref
  `).all(id).map((row) => String(row.member_ref || "")).filter(Boolean);
  return members.length === 2 ? members : null;
}

function buildConversationIdMap(db, idMap) {
  const map = new Map();
  const conversations = db.prepare("SELECT id, type FROM conversations").all();
  for (const conversation of conversations) {
    const oldId = String(conversation.id || "");
    let newId = oldId;
    const type = String(conversation.type || "");
    if (type === "dm" || oldId.startsWith("dm:")) {
      const participants = parseDmParticipants(db, conversation);
      if (participants?.some((id) => idMap.has(id))) {
        newId = dmConversationId(idMap.get(participants[0]) || participants[0], idMap.get(participants[1]) || participants[1]);
      }
    } else if (containsAnyMapped(oldId, idMap)) {
      newId = replaceAllMapped(oldId, idMap);
    }
    if (newId !== oldId) map.set(oldId, newId);
  }

  const targets = new Set();
  for (const [oldId, newId] of map) {
    if (targets.has(newId)) throw new Error(`conversation id collision while planning ${oldId} -> ${newId}`);
    targets.add(newId);
    const existing = db.prepare("SELECT id FROM conversations WHERE id = ?").get(newId);
    if (existing && !map.has(newId)) {
      throw new Error(`conversation id ${newId} already exists; refusing to merge ${oldId}`);
    }
  }
  return map;
}

function generateReplacementId(db, used, idGenerator) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = String(idGenerator() || "").trim();
    if (!isCurrentUserId(candidate)) throw new Error(`generated user id is not current format: ${candidate}`);
    if (used.has(candidate)) continue;
    if (db.prepare("SELECT 1 FROM users WHERE id = ?").get(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
  throw new Error("could not generate a collision-free user id");
}

function planUserIdRotation(db, accounts, { forceCurrent = false, idGenerator = generatePrincipalId } = {}) {
  const used = new Set(db.prepare("SELECT id FROM users").all().map((row) => String(row.id || "")));
  const rotated = [];
  const skipped = [];
  const missing = [];
  const idMap = new Map();
  for (const rawAccount of accounts) {
    const account = normalizeAccount(rawAccount);
    if (!account) continue;
    const row = db.prepare("SELECT id, account, username FROM users WHERE account = ?").get(account);
    if (!row) {
      missing.push(account);
      continue;
    }
    const oldId = String(row.id || "");
    if (isCurrentUserId(oldId) && !forceCurrent) {
      skipped.push({ account: row.account || account, id: oldId, reason: "already-current-format" });
      continue;
    }
    const newId = generateReplacementId(db, used, idGenerator);
    idMap.set(oldId, newId);
    rotated.push({ account: row.account || account, oldId, newId });
  }
  return { rotated, skipped, missing, idMap };
}

function sortFriendPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function rebuildFriendships(db, idMap) {
  if (!idMap.size || !hasTable(db, "friendships")) return 0;
  const affected = db.prepare("SELECT user_a, user_b, created_at FROM friendships")
    .all()
    .filter((row) => idMap.has(row.user_a) || idMap.has(row.user_b));
  if (!affected.length) return 0;
  for (const row of affected) {
    db.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").run(row.user_a, row.user_b);
  }
  for (const row of affected) {
    const [a, b] = sortFriendPair(idMap.get(row.user_a) || row.user_a, idMap.get(row.user_b) || row.user_b);
    if (a !== b) {
      db.prepare("INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)")
        .run(a, b, row.created_at);
    }
  }
  return affected.length;
}

function rewriteFilesAndMoveUploads(db, dbPath, idMap, uploadDir = path.join(path.dirname(dbPath), "uploads")) {
  let moved = 0;
  if (!idMap.size) return moved;
  for (const [oldId, newId] of idMap) {
    if (hasColumn(db, "files", "path")) {
      const rows = db.prepare("SELECT id, path FROM files WHERE path LIKE ?").all(`%${oldId}%`);
      for (const row of rows) {
        const nextPath = replaceAllMapped(row.path, new Map([[oldId, newId]]));
        if (nextPath !== row.path) db.prepare("UPDATE files SET path = ? WHERE id = ?").run(nextPath, row.id);
      }
    }
    const oldDir = path.join(uploadDir, oldId);
    const newDir = path.join(uploadDir, newId);
    if (!fs.existsSync(oldDir)) continue;
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    if (fs.existsSync(newDir)) {
      for (const name of fs.readdirSync(oldDir)) {
        const source = path.join(oldDir, name);
        const target = path.join(newDir, name);
        if (fs.existsSync(target)) throw new Error(`upload target already exists: ${target}`);
        fs.renameSync(source, target);
      }
      fs.rmSync(oldDir, { recursive: true, force: true });
    } else {
      fs.renameSync(oldDir, newDir);
    }
    moved += 1;
  }
  return moved;
}

function applyRotation(db, { dbPath, idMap, conversationIdMap, uploadDir }) {
  let changes = 0;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    rebuildFriendships(db, idMap);
    for (const [oldId, newId] of conversationIdMap) {
      for (const [table, column] of CONVERSATION_ID_COLUMNS) {
        changes += updateExactColumn(db, table, column, oldId, newId);
      }
      changes += updateExactColumn(db, "user_events", "scope_ref", oldId, newId);
    }
    for (const [oldId, newId] of idMap) {
      for (const [table, column] of USER_ID_COLUMNS) {
        changes += updateExactColumn(db, table, column, oldId, newId);
      }
      changes += updateExactColumn(db, "conversation_members", "member_ref", oldId, newId, "member_kind = 'user'");
      changes += updateExactColumn(db, "messages", "sender_ref", oldId, newId, "sender_kind = 'user'");
      changes += updateExactColumn(db, "user_events", "scope_ref", oldId, newId);
    }
    changes += replaceJsonColumns(db, directReplacementMap(idMap, conversationIdMap));
    const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (fkErrors.length) throw new Error(`foreign key check failed: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const uploadMoves = rewriteFilesAndMoveUploads(db, dbPath, idMap, uploadDir);
  return { changes, uploadMoves };
}

function createBackup(db, dbPath) {
  const backupPath = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  return backupPath;
}

function rotateCloudUserIds(options = {}) {
  const dbPath = path.resolve(options.dbPath || process.env.MIA_CLOUD_DB || path.join(process.env.MIA_CLOUD_DATA || path.join(process.cwd(), ".mia-cloud"), "cloud.sqlite"));
  const accounts = (options.accounts && options.accounts.length ? options.accounts : DEFAULT_ACCOUNTS).map(String);
  if (!fs.existsSync(dbPath)) throw new Error(`cloud sqlite database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const plan = planUserIdRotation(db, accounts, {
      forceCurrent: options.forceCurrent === true,
      idGenerator: options.idGenerator || generatePrincipalId
    });
    const conversationIdMap = buildConversationIdMap(db, plan.idMap);
    let backupPath = "";
    let applied = { changes: 0, uploadMoves: 0 };
    if (options.apply && plan.idMap.size) {
      if (options.backup !== false) backupPath = createBackup(db, dbPath);
      applied = applyRotation(db, {
        dbPath,
        idMap: plan.idMap,
        conversationIdMap,
        uploadDir: options.uploadDir || path.join(path.dirname(dbPath), "uploads")
      });
    }
    return {
      dbPath,
      apply: Boolean(options.apply),
      backupPath,
      rotated: plan.rotated,
      skipped: plan.skipped,
      missing: plan.missing,
      conversationIds: Array.from(conversationIdMap.entries()).map(([oldId, newId]) => ({ oldId, newId })),
      changes: applied.changes,
      uploadMoves: applied.uploadMoves
    };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const out = { accounts: [], apply: false, backup: true, forceCurrent: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--dry-run") out.apply = false;
    else if (arg === "--no-backup") out.backup = false;
    else if (arg === "--force-current") out.forceCurrent = true;
    else if (arg === "--db") out.dbPath = argv[++i];
    else if (arg === "--upload-dir") out.uploadDir = argv[++i];
    else if (arg === "--account") out.accounts.push(argv[++i]);
    else if (arg === "--accounts") out.accounts.push(...String(argv[++i] || "").split(","));
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else out.accounts.push(arg);
  }
  out.accounts = out.accounts.map((item) => item.trim()).filter(Boolean);
  return out;
}

function printHelp() {
  console.log([
    "Usage: node scripts/rotate-cloud-user-ids.js [--db cloud.sqlite] [--apply] [--account 755439] [--account Marcos] [--account king]",
    "",
    "Defaults to a dry run for accounts: 755439, Marcos, king.",
    "Database path defaults to MIA_CLOUD_DB or $MIA_CLOUD_DATA/cloud.sqlite.",
    "Use --apply to write changes. A VACUUM INTO backup is created unless --no-backup is set."
  ].join("\n"));
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      process.exit(0);
    }
    const result = rotateCloudUserIds(args);
    console.log(JSON.stringify(result, null, 2));
    if (!args.apply) {
      console.error("Dry run only. Re-run with --apply to write changes.");
    }
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  CURRENT_USER_ID_RE,
  DEFAULT_ACCOUNTS,
  isCurrentUserId,
  planUserIdRotation,
  rotateCloudUserIds
};
