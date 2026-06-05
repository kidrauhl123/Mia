const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeStatusBadge } = require("../shared/identity.js");

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function nowIso() {
  return new Date().toISOString();
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function randomId(prefix, randomBytes = crypto.randomBytes) {
  return `${prefix}_${base64url(randomBytes(12))}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeAccount(value) {
  return String(value || "").trim().toLowerCase();
}

function accountFromBody(input = {}) {
  return normalizeAccount(input.username || input.email || input.account);
}

function validateAccount(account) {
  return account.length >= 2 && account.length <= 64 && !/[\s\x00-\x1f\x7f]/.test(account);
}

function validatePassword(password) {
  return String(password || "").length >= 6;
}

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("base64");
}

function profileStatusBadge(row = {}) {
  return normalizeStatusBadge(row.statusBadge || row.status_badge || parseJson(row.status_badge_json, null));
}

function publicUser(row) {
  if (!row) return null;
  let avatarCrop = null;
  const cropSource = row.avatar_crop_json || row.avatarCrop;
  if (cropSource) {
    if (typeof cropSource === "object") {
      avatarCrop = cropSource;
    } else {
      try { avatarCrop = JSON.parse(cropSource); } catch { avatarCrop = null; }
    }
  }
  const statusBadge = profileStatusBadge(row);
  return {
    id: row.id,
    username: row.username || row.email || "",
    email: row.email || "",
    createdAt: row.created_at || row.createdAt || "",
    // Profile avatar: expose so friends + the user themself render with the
    // same image+crop their desktop uses, instead of falling back to a
    // letter circle. All three fields are optional and may be "" / null.
    avatarImage: row.avatar_image || row.avatarImage || "",
    avatarCrop,
    avatarColor: row.avatar_color || row.avatarColor || "",
    ...(statusBadge ? { statusBadge } : {})
  };
}

function userDisplayName(user) {
  return user.username || user.email || "Mia 用户";
}

function defaultWorkspace(user, now = nowIso, id = randomId) {
  return {
    revision: 1,
    activeConversationId: "conv_mia",
    conversations: [{
      id: "conv_mia",
      title: "Mia",
      meta: "Mia Cloud · 已同步",
      avatar: "./assets/avatar-01.png",
      updatedAt: now(),
      unread: 0,
      messages: [{
        id: id("msg"),
        role: "assistant",
        text: `欢迎，${userDisplayName(user)}。这是你的 Mia Cloud 工作区，消息会保存在服务器上。`,
        createdAt: now(),
        attachments: []
      }]
    }],
    contacts: [
      { id: "contact_mia", title: "Mia", meta: "默认 Bot", avatar: "./assets/avatar-01.png", status: "可用", note: "负责日常对话、信息整理和轻量任务推进。" },
      { id: "contact_codex", title: "Codex", meta: "代码与自动化", avatar: "./assets/avatar-08.png", status: "本地桥接待接入", note: "通过桌面端 Bridge 调用本机 Codex / Claude Code / Hermes。" }
    ],
    skills: [
      { id: "skill_image", title: "图片生成", meta: "生成并同步图片附件", icon: "IMG", status: "已启用" },
      { id: "skill_docs", title: "文档整理", meta: "把聊天过程整理成文档", icon: "DOC", status: "待接入" },
      { id: "skill_code", title: "代码任务", meta: "连接桌面端 Agent Bridge", icon: "DEV", status: "待接入" }
    ],
    workbench: [
      { id: "task_sync", title: "多端同步", meta: "Web / Desktop / PWA", status: "运行中" },
      { id: "task_bridge", title: "本地 Agent Bridge", meta: "远程调用本机能力", status: "运行中" },
      { id: "task_native", title: "原生手机 App", meta: "PWA 稳定后启动", status: "规划中" }
    ]
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function fileExtensionForMime(mimeType) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".jpg";
}

function sanitizeStoredFileName(value, fallback = "file") {
  const base = path.basename(String(value || fallback)).replace(/[\x00-\x1f\x7f]/g, "").trim();
  const cleaned = base.replace(/[^\w.\- ()\[\]\u4e00-\u9fff]/g, "_").slice(0, 160);
  return cleaned || fallback;
}

function rowToUser(row) {
  let avatarCrop = null;
  if (row.avatar_crop_json) {
    try { avatarCrop = JSON.parse(row.avatar_crop_json); } catch { avatarCrop = null; }
  }
  const statusBadge = profileStatusBadge(row);
  return {
    id: row.id,
    username: row.username,
    email: row.email || "",
    createdAt: row.created_at,
    avatarImage: row.avatar_image || "",
    avatarCrop,
    avatarColor: row.avatar_color || "",
    ...(statusBadge ? { statusBadge } : {})
  };
}

function rowToFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type || "image",
    name: row.name,
    mimeType: row.mime_type,
    path: row.path,
    size: row.size,
    url: `/api/files/${row.id}`,
    createdAt: row.created_at
  };
}

function rowToDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceName: row.device_name,
    engine: row.engine,
    capabilities: parseJson(row.capabilities_json, {}),
    connectedAt: row.connected_at,
    lastSeenAt: row.last_seen_at,
    status: row.status
  };
}

function rowToBridgeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceId: row.device_id,
    conversationId: row.conversation_id,
    text: row.text,
    status: row.status,
    error: row.error || "",
    resultText: row.result_text || "",
    requestAttachments: parseJson(row.request_attachments_json, []),
    attachments: parseJson(row.attachments_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || ""
  };
}

function resetVolatileBridgeState(db, now = nowIso) {
  const timestamp = now();
  db.prepare("UPDATE bridge_devices SET status = 'offline', last_seen_at = ? WHERE status = 'online'")
    .run(timestamp);
  db.prepare(`
    UPDATE bridge_runs
    SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
    WHERE status IN ('pending', 'running')
  `).run("Mia Cloud 已重启，本机 Agent 运行已中断。", timestamp, timestamp);
}

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
}

function createCloudStore(options = {}) {
  const dbPath = options.dbPath || path.join(options.dataDir || path.join(os.tmpdir(), "mia-cloud"), "cloud.sqlite");
  const uploadDir = options.uploadDir || path.join(path.dirname(dbPath), "uploads");
  const now = options.now || nowIso;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const loginRateLimit = {
    maxFailures: Number(options.loginRateLimit?.maxFailures || 8),
    windowMs: Number(options.loginRateLimit?.windowMs || 1000 * 60 * 15)
  };
  const loginFailures = new Map();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  importLegacyJsonIfNeeded(db, {
    legacyJsonPath: options.legacyJsonPath || path.join(path.dirname(dbPath), "cloud.json")
  });
  resetVolatileBridgeState(db, now);

  function id(prefix) {
    return randomId(prefix, randomBytes);
  }

  function getUserByAccount(account) {
    return db.prepare("SELECT * FROM users WHERE account = ?").get(account);
  }

  function getUserByUsername(username) {
    const row = db.prepare("SELECT * FROM users WHERE account = ?").get(String(username || "").trim().toLowerCase());
    return row ? publicUser(row) : null;
  }

  function getUserById(userId) {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  }

  function createSession(userId) {
    const token = base64url(randomBytes(32));
    db.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      sha256(token),
      userId,
      now(),
      new Date(Date.now() + SESSION_TTL_MS).toISOString()
    );
    return token;
  }

  function rateLimitKey(account, ip) {
    return `${String(ip || "unknown").trim() || "unknown"}:${account}`;
  }

  function recentFailures(account, ip) {
    const key = rateLimitKey(account, ip);
    const cutoff = Date.now() - loginRateLimit.windowMs;
    const failures = (loginFailures.get(key) || []).filter((timestamp) => timestamp >= cutoff);
    if (failures.length) loginFailures.set(key, failures);
    else loginFailures.delete(key);
    return failures;
  }

  function assertLoginAllowed(account, ip) {
    if (recentFailures(account, ip).length >= loginRateLimit.maxFailures) {
      throw new Error("登录尝试过多，请稍后再试。");
    }
  }

  function recordLoginFailure(account, ip) {
    const key = rateLimitKey(account, ip);
    loginFailures.set(key, [...recentFailures(account, ip), Date.now()]);
  }

  function clearLoginFailures(account, ip) {
    loginFailures.delete(rateLimitKey(account, ip));
  }

  // (ensureWorkspace removed in Phase 4 cutover — workspace snapshots
  //  are no longer the conversation store. The `workspaces` table is
  //  left intact but unused; a future commit can DROP it once we've
  //  confirmed no rollback need.)

  function registerUser(input = {}) {
    const account = accountFromBody(input);
    const password = String(input.password || "");
    if (!validateAccount(account)) throw new Error("用户名需要 2-64 个字符，不能包含空格。");
    if (!validatePassword(password)) throw new Error("密码至少 6 位。");
    if (getUserByAccount(account)) throw new Error("账号已存在，请直接登录。");
    const userId = id("user");
    const salt = base64url(randomBytes(16));
    const createdAt = now();
    db.prepare(`
      INSERT INTO users (id, account, username, email, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      account,
      account,
      String(input.email || "").includes("@") ? account : "",
      salt,
      passwordHash(password, salt),
      createdAt
    );
    const row = getUserById(userId);
    const user = rowToUser(row);
    // Phase 4 cutover: workspace removed from auth response. Clients
    // bootstrap conversations from /api/conversations now.
    return { token: createSession(user.id), user };
  }

  function loginUser(input = {}) {
    const account = accountFromBody(input);
    assertLoginAllowed(account, input.ip);
    const row = getUserByAccount(account);
    if (!row || passwordHash(String(input.password || ""), row.password_salt) !== row.password_hash) {
      recordLoginFailure(account, input.ip);
      throw new Error("用户名或密码不正确。");
    }
    clearLoginFailures(account, input.ip);
    const user = rowToUser(row);
    return { token: createSession(user.id), user };
  }

  function authenticateToken(token) {
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash);
    if (!session || Date.parse(session.expires_at) <= Date.now()) {
      if (session) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    const row = getUserById(session.user_id);
    if (!row) return null;
    return { user: rowToUser(row), sessionKey: tokenHash };
  }

  function logoutSession(token) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  // (getWorkspace / putWorkspace / appendMessage removed in Phase 4
  //  cutover — see the ensureWorkspace note above.)

  function saveImageDataUrl(userId, attachment = {}) {
    if (!getUserById(userId)) throw new Error("用户不存在。");
    const raw = String(attachment.dataUrl || "");
    const match = raw.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid image payload.");
    const mimeType = String(match[1] || "").toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Unsupported image type.");
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("Invalid image size.");
    const fileId = id("file");
    const userDir = path.join(uploadDir, userId);
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(userDir, `${fileId}${fileExtensionForMime(mimeType)}`);
    fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    db.prepare(`
      INSERT INTO files (id, user_id, type, name, mime_type, path, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, userId, "image", String(attachment.name || path.basename(filePath)), mimeType, filePath, buffer.length, now());
    return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(fileId));
  }

  function saveLocalFileForUser(userId, input = {}) {
    if (!getUserById(userId)) throw new Error("用户不存在。");
    const sourcePath = String(input.path || input.filePath || "").trim();
    if (!sourcePath) throw new Error("File path is required.");
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || !stat.size || stat.size > MAX_FILE_BYTES) throw new Error("Invalid file size.");
    const mimeType = String(input.mimeType || input.mime || "application/octet-stream").slice(0, 160);
    const fileId = id("file");
    const userDir = path.join(uploadDir, userId);
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    const name = sanitizeStoredFileName(input.name || path.basename(sourcePath), fileId);
    const ext = path.extname(name);
    const filePath = path.join(userDir, `${fileId}${ext || ""}`);
    fs.copyFileSync(sourcePath, filePath);
    fs.chmodSync(filePath, 0o600);
    db.prepare(`
      INSERT INTO files (id, user_id, type, name, mime_type, path, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fileId,
      userId,
      String(input.type || "file"),
      name,
      mimeType,
      filePath,
      stat.size,
      now()
    );
    return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(fileId));
  }

  function getFileForUser(userId, fileId) {
    return rowToFile(db.prepare("SELECT * FROM files WHERE id = ? AND user_id = ?").get(String(fileId || ""), userId));
  }

  function listBridgeDevices(userId) {
    return db.prepare(`
      SELECT * FROM bridge_devices
      WHERE user_id = ? AND status = 'online'
      ORDER BY last_seen_at DESC
    `).all(userId).map(rowToDevice);
  }

  function upsertBridgeDevice(userId, input = {}) {
    if (!getUserById(userId)) throw new Error("用户不存在。");
    const deviceId = String(input.id || id("bridge"));
    const timestamp = now();
    db.prepare(`
      INSERT INTO bridge_devices (id, user_id, device_name, engine, capabilities_json, connected_at, last_seen_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'online')
      ON CONFLICT(id) DO UPDATE SET
        device_name = excluded.device_name,
        engine = excluded.engine,
        capabilities_json = excluded.capabilities_json,
        last_seen_at = excluded.last_seen_at,
        status = 'online'
    `).run(
      deviceId,
      userId,
      String(input.deviceName || "").trim().slice(0, 80) || "本机 Agent",
      String(input.engine || "").trim().slice(0, 40) || "codex",
      JSON.stringify(input.capabilities || {}),
      timestamp,
      timestamp
    );
    return rowToDevice(db.prepare("SELECT * FROM bridge_devices WHERE id = ? AND user_id = ?").get(deviceId, userId));
  }

  function removeBridgeDevice(userId, deviceId) {
    db.prepare("UPDATE bridge_devices SET status = 'offline', last_seen_at = ? WHERE id = ? AND user_id = ?")
      .run(now(), deviceId, userId);
  }

  function createBridgeRun(userId, input = {}) {
    const runId = id("run");
    const timestamp = now();
    db.prepare(`
      INSERT INTO bridge_runs (id, user_id, device_id, conversation_id, text, status, request_attachments_json, attachments_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, '[]', ?, ?)
    `).run(
      runId,
      userId,
      String(input.deviceId || ""),
      String(input.conversationId || ""),
      String(input.text || ""),
      JSON.stringify(Array.isArray(input.attachments) ? input.attachments : []),
      timestamp,
      timestamp
    );
    return rowToBridgeRun(db.prepare("SELECT * FROM bridge_runs WHERE id = ? AND user_id = ?").get(runId, userId));
  }

  function completeBridgeRun(userId, runId, result = {}) {
    const timestamp = now();
    db.prepare(`
      UPDATE bridge_runs
      SET status = 'succeeded', result_text = ?, attachments_json = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'running')
    `).run(
      String(result.text || ""),
      JSON.stringify(Array.isArray(result.attachments) ? result.attachments : []),
      timestamp,
      timestamp,
      runId,
      userId
    );
    return rowToBridgeRun(db.prepare("SELECT * FROM bridge_runs WHERE id = ? AND user_id = ?").get(runId, userId));
  }

  function startBridgeRun(userId, runId) {
    const timestamp = now();
    db.prepare(`
      UPDATE bridge_runs
      SET status = 'running', updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'pending'
    `).run(timestamp, runId, userId);
    return rowToBridgeRun(db.prepare("SELECT * FROM bridge_runs WHERE id = ? AND user_id = ?").get(runId, userId));
  }

  function failBridgeRun(userId, runId, error) {
    const timestamp = now();
    db.prepare(`
      UPDATE bridge_runs
      SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'running')
    `).run(String(error || "本机 Agent 执行失败。"), timestamp, timestamp, runId, userId);
    return rowToBridgeRun(db.prepare("SELECT * FROM bridge_runs WHERE id = ? AND user_id = ?").get(runId, userId));
  }

  function timeoutBridgeRun(userId, runId, error) {
    const timestamp = now();
    db.prepare(`
      UPDATE bridge_runs
      SET status = 'timed_out', error = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'running')
    `).run(String(error || "本机 Agent 响应超时。"), timestamp, timestamp, runId, userId);
    return rowToBridgeRun(db.prepare("SELECT * FROM bridge_runs WHERE id = ? AND user_id = ?").get(runId, userId));
  }

  function cancelBridgeRun(userId, runId) {
    const timestamp = now();
    db.prepare(`
      UPDATE bridge_runs
      SET status = 'cancelled', error = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'running')
    `).run("本机 Agent 运行已取消。", timestamp, timestamp, runId, userId);
    return rowToBridgeRun(db.prepare("SELECT * FROM bridge_runs WHERE id = ? AND user_id = ?").get(runId, userId));
  }

  function listBridgeRuns(userId) {
    return db.prepare("SELECT * FROM bridge_runs WHERE user_id = ? ORDER BY created_at DESC").all(userId).map(rowToBridgeRun);
  }

  function getBridgeRun(userId, runId) {
    return rowToBridgeRun(db.prepare("SELECT * FROM bridge_runs WHERE id = ? AND user_id = ?").get(runId, userId));
  }

  function getUserPublic(userId) {
    const row = getUserById(userId);
    return row ? publicUser(row) : null;
  }

  function updateUserProfile(userId, patch = {}) {
    const row = getUserById(userId);
    if (!row) throw new Error("用户不存在。");
    const sets = [];
    const values = [];
    if (typeof patch.avatarImage === "string") {
      // Cap profile avatar payloads so animated GIF / short video avatars
      // can sync without letting profile rows grow without bound.
      const trimmed = patch.avatarImage.slice(0, 8_000_000);
      sets.push("avatar_image = ?");
      values.push(trimmed);
    }
    if (patch.avatarCrop === null || typeof patch.avatarCrop === "object") {
      sets.push("avatar_crop_json = ?");
      values.push(patch.avatarCrop ? JSON.stringify(patch.avatarCrop) : "");
    }
    if (typeof patch.avatarColor === "string") {
      sets.push("avatar_color = ?");
      values.push(patch.avatarColor.slice(0, 32));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "statusBadge")) {
      const statusBadge = normalizeStatusBadge(patch.statusBadge);
      sets.push("status_badge_json = ?");
      values.push(statusBadge ? JSON.stringify(statusBadge) : "");
    }
    if (!sets.length) return rowToUser(row);
    values.push(userId);
    db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return rowToUser(getUserById(userId));
  }

  return {
    registerUser,
    loginUser,
    logoutSession,
    authenticateToken,
    saveImageDataUrl,
    saveLocalFileForUser,
    getFileForUser,
    listBridgeDevices,
    upsertBridgeDevice,
    removeBridgeDevice,
    createBridgeRun,
    startBridgeRun,
    completeBridgeRun,
    failBridgeRun,
    timeoutBridgeRun,
    cancelBridgeRun,
    listBridgeRuns,
    updateUserProfile,
    getBridgeRun,
    getUserPublic,
    getUserByUsername,
    getDb: () => db,
    uploadDir,
    dataDir: path.dirname(dbPath),
    close: () => db.close()
  };
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'image',
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_name TEXT NOT NULL,
      engine TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      connected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'online'
    );

    CREATE TABLE IF NOT EXISTS bridge_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      result_text TEXT NOT NULL DEFAULT '',
      request_attachments_json TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
    CREATE INDEX IF NOT EXISTS idx_bridge_devices_user ON bridge_devices(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_bridge_runs_user ON bridge_runs(user_id, created_at);

    CREATE TABLE IF NOT EXISTS friendships (
      user_a       TEXT NOT NULL,
      user_b       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (user_a, user_b)
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id           TEXT PRIMARY KEY,
      from_user    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user      TEXT,
      code         TEXT UNIQUE,
      status       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      resolved_at  TEXT
    );

    -- A "conversation" is the universal Conversation entity. type values:
    --   'dm'    — two-user direct message (id format dm:a:b)
    --   'group' — multi-member conversation (id format g_<hex>)
    --   'bot'   — a private chat with a globally identified bot.
    -- The type column is the canonical answer for "what kind of
    -- conversation is this"; id prefix is just a historical hint.
    CREATE TABLE IF NOT EXISTS conversations (
      id                TEXT PRIMARY KEY,
      type              TEXT NOT NULL DEFAULT 'group',
      name              TEXT,
      avatar            TEXT,
      host_member_json  TEXT,
      decorations_json  TEXT,
      context_card_json TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      member_kind   TEXT NOT NULL,
      member_ref    TEXT NOT NULL,
      owner_id      TEXT,
      ai_perms_json TEXT,
      joined_at     TEXT NOT NULL,
      PRIMARY KEY (conversation_id, member_kind, member_ref)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id         TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,
      turn_id         TEXT,
      sender_kind     TEXT NOT NULL,
      sender_ref      TEXT NOT NULL,
      sender_owner_id TEXT,
      body_md         TEXT NOT NULL DEFAULT '',
      attachments_json TEXT,
      mentions_json   TEXT,
      skills_json     TEXT,
      trace_json      TEXT,
      status          TEXT NOT NULL,
      error_json      TEXT,
      created_at      TEXT NOT NULL,
      UNIQUE (conversation_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user, status);
    CREATE INDEX IF NOT EXISTS idx_friend_requests_code ON friend_requests(code, status);
    CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(member_kind, member_ref);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq);

    -- v9: per-user message hiding (WeChat-style local delete). Deleting a
    -- message removes it only from the deleter's own view (across their
    -- devices); other conversation members keep their copy. This is distinct from a
    -- future "recall" that would hard-delete for everyone. The read path
    -- filters messages whose id appears here for the requesting user.
    CREATE TABLE IF NOT EXISTS message_hidden (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_hidden_user_conversation ON message_hidden(user_id, conversation_id);

    -- v4: per-user persistent event log + write idempotency.
    -- See docs/superpowers/plans/2026-05-23-sync-architecture-redesign.md.
    -- Every state-changing WS broadcast also lands a row here. Clients
    -- track last_seen_seq and on reconnect ask for since_seq > N → server
    -- replays the missed rows. Disconnect tolerance becomes free.
    CREATE TABLE IF NOT EXISTS user_events (
      id          INTEGER PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seq         INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      scope_kind  TEXT,
      scope_ref   TEXT,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE (user_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_user_events_user_seq ON user_events(user_id, seq);

    -- Write-side idempotency. Body.clientOpId on POST/PATCH/DELETE; server
    -- caches the response for 24h so retries return the same answer.
    CREATE TABLE IF NOT EXISTS op_idempotency (
      user_id     TEXT NOT NULL,
      client_op   TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, client_op)
    );
    CREATE INDEX IF NOT EXISTS idx_op_idempotency_created ON op_idempotency(created_at);

    -- v5: globally unique bot identity definitions on cloud. Runtime config
    -- stays desktop-local because it pins to a specific host machine.
    CREATE TABLE IF NOT EXISTS bots (
      id              TEXT PRIMARY KEY,
      owner_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
      display_name    TEXT NOT NULL,
      color           TEXT NOT NULL DEFAULT '',
      avatar_image    TEXT NOT NULL DEFAULT '',
      avatar_crop_json TEXT NOT NULL DEFAULT '',
      status_badge_json TEXT NOT NULL DEFAULT '',
      bio             TEXT NOT NULL DEFAULT '',
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      persona_text    TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_user_id);

    -- v6: per-user cross-device settings (pin / read marks / appearance).
    -- One row per user, JSON for the small bags so we don't need a
    -- schema migration every time a setting category is added. Read on
    -- bootstrap, updated via PUT /api/me/settings, broadcast via
    -- user_settings.updated.
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      pins_json        TEXT NOT NULL DEFAULT '[]',
      read_marks_json  TEXT NOT NULL DEFAULT '{}',
      appearance_json  TEXT NOT NULL DEFAULT '{}',
      version          INTEGER NOT NULL DEFAULT 0,
      updated_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_runtime_bindings (
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bot_id       TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      runtime_kind TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      config_json  TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (user_id, bot_id, runtime_kind)
    );

    CREATE TABLE IF NOT EXISTS cloud_agent_runs (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bot_id          TEXT NOT NULL,
      conversation_id            TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      trigger_message_id TEXT NOT NULL,
      hermes_run_id      TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL,
      error_json         TEXT NOT NULL DEFAULT '',
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_agent_runs_conversation
      ON cloud_agent_runs(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS skills (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'uncategorized',
      description   TEXT NOT NULL DEFAULT '',
      source_label  TEXT NOT NULL DEFAULT '',
      body          TEXT NOT NULL,
      install_count INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
    CREATE INDEX IF NOT EXISTS idx_skills_popularity ON skills(install_count DESC);

    CREATE TABLE IF NOT EXISTS skill_installs (
      skill_id   TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (skill_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS skill_versions (
      skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      version       TEXT NOT NULL,
      package_path  TEXT NOT NULL,
      checksum      TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      entry_path    TEXT NOT NULL DEFAULT 'SKILL.md',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      changelog     TEXT NOT NULL DEFAULT '',
      scan_status   TEXT NOT NULL DEFAULT 'unscanned',
      created_at    TEXT NOT NULL,
      PRIMARY KEY (skill_id, version)
    );

    CREATE TABLE IF NOT EXISTS skill_reports (
      id          TEXT PRIMARY KEY,
      skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason      TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL
    );
  `);
  if (!hasColumn(db, "bridge_runs", "request_attachments_json")) {
    db.exec("ALTER TABLE bridge_runs ADD COLUMN request_attachments_json TEXT NOT NULL DEFAULT '[]'");
  }
  // Profile avatar columns added in v3 so friends + the user themself can
  // surface their display avatar on every device.
  if (!hasColumn(db, "users", "avatar_image")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_image TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, "users", "avatar_crop_json")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_crop_json TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, "users", "avatar_color")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, "users", "status_badge_json")) {
    db.exec("ALTER TABLE users ADD COLUMN status_badge_json TEXT NOT NULL DEFAULT ''");
  }
  // v4: per-user event seq cache. event_seq mirrors MAX(user_events.seq)
  // for that user; kept on the row for fast monotonic increment under
  // the same transaction as the user_events insert.
  if (!hasColumn(db, "users", "event_seq")) {
    db.exec("ALTER TABLE users ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0");
  }
  // v6.1: user_settings.version for compare-and-swap. Multi-device
  // PUTs without CAS silently dropped each other (codex review).
  if (!hasColumn(db, "user_settings", "version")) {
    db.exec("ALTER TABLE user_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
  }
  // v7: conversations.type column for explicit conversation kind. Existing
  // rows backfilled by id prefix; new rows must declare it.
  if (!hasColumn(db, "conversations", "type")) {
    db.exec("ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'group'");
    db.exec("UPDATE conversations SET type = 'dm' WHERE id LIKE 'dm:%'");
    db.exec("UPDATE conversations SET type = 'bot' WHERE id LIKE 'bot:%'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)");
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)")
    .run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)")
    .run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)")
    .run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)")
    .run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)")
    .run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, ?)")
    .run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, ?)")
    .run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (8, ?)")
    .run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (9, ?)")
    .run(nowIso());
  // v10: skill marketplace registry (skills + per-user install ledger).
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (10, ?)")
    .run(nowIso());
  // v11: community marketplace — skills become listings with versioned zip
  // packages + ownership. (skill_versions / skill_reports created above.)
  if (!hasColumn(db, "skills", "owner_user_id")) {
    db.exec("ALTER TABLE skills ADD COLUMN owner_user_id TEXT");
  }
  if (!hasColumn(db, "skills", "owner_label")) {
    db.exec("ALTER TABLE skills ADD COLUMN owner_label TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, "skills", "latest_version")) {
    db.exec("ALTER TABLE skills ADD COLUMN latest_version TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, "skills", "status")) {
    db.exec("ALTER TABLE skills ADD COLUMN status TEXT NOT NULL DEFAULT 'published'");
  }
  if (!hasColumn(db, "skill_installs", "installed_version")) {
    db.exec("ALTER TABLE skill_installs ADD COLUMN installed_version TEXT NOT NULL DEFAULT ''");
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (11, ?)")
    .run(nowIso());
  // v12: composer "使用" skill chips travel with the message — the skills the
  // user explicitly selected for that turn, rendered in the bubble and used by
  // the bot responder to drive the agent.
  if (!hasColumn(db, "messages", "skills_json")) {
    db.exec("ALTER TABLE messages ADD COLUMN skills_json TEXT");
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (12, ?)")
    .run(nowIso());
  // v13: assistant trace blocks (reasoning + tool-call summaries) are stored
  // with bot-authored messages so cloud conversations render the same agent
  // activity UI as local sessions.
  if (!hasColumn(db, "messages", "trace_json")) {
    db.exec("ALTER TABLE messages ADD COLUMN trace_json TEXT");
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (13, ?)")
    .run(nowIso());
}

function importLegacyJsonIfNeeded(db, { legacyJsonPath }) {
  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (Number(userCount) > 0 || !legacyJsonPath || !fs.existsSync(legacyJsonPath)) return;
  let legacy = null;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyJsonPath, "utf8"));
  } catch {
    return;
  }
  const timestamp = nowIso();
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, account, username, email, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [accountKey, user] of Object.entries(legacy.users || {})) {
    if (!user?.id) continue;
    const account = normalizeAccount(accountKey || user.username || user.email);
    if (!account) continue;
    insertUser.run(
      String(user.id),
      account,
      normalizeAccount(user.username || account),
      String(user.email || ""),
      String(user.passwordSalt || user.password_salt || ""),
      String(user.passwordHash || user.password_hash || ""),
      String(user.createdAt || user.created_at || timestamp)
    );
  }

  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const [tokenHash, session] of Object.entries(legacy.sessions || {})) {
    if (!session?.userId && !session?.user_id) continue;
    insertSession.run(
      String(tokenHash),
      String(session.userId || session.user_id),
      String(session.createdAt || session.created_at || timestamp),
      String(session.expiresAt || session.expires_at || timestamp)
    );
  }

  const insertWorkspace = db.prepare(`
    INSERT OR REPLACE INTO workspaces (user_id, revision, snapshot_json, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const [userId, workspace] of Object.entries(legacy.workspaces || {})) {
    if (!workspace || typeof workspace !== "object") continue;
    insertWorkspace.run(
      String(userId),
      Number(workspace.revision || 1),
      JSON.stringify(workspace),
      String(workspace.updatedAt || timestamp)
    );
  }

  const insertFile = db.prepare(`
    INSERT OR IGNORE INTO files (id, user_id, type, name, mime_type, path, size, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const file of Object.values(legacy.files || {})) {
    if (!file?.id || !file?.userId || !file?.path) continue;
    let size = Number(file.size || 0);
    try {
      size = fs.statSync(file.path).size;
    } catch {
      // Keep metadata even if the legacy disk object is missing.
    }
    insertFile.run(
      String(file.id),
      String(file.userId),
      String(file.type || "image"),
      String(file.name || file.id),
      String(file.mimeType || file.mime || "application/octet-stream"),
      String(file.path),
      size,
      String(file.createdAt || file.created_at || timestamp)
    );
  }
}

module.exports = {
  createCloudStore
};
