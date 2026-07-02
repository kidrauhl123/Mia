const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeStatusBadge } = require("../shared/identity.js");
const { generatePrincipalId, publicIdFromConversationId } = require("../shared/ids.js");
const { sanitizeCssColor } = require("./css-color.js");

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const ALLOWED_FILE_DATA_URL_MIME_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/zip",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values"
]);

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

function wechatSubject(profile = {}) {
  const unionid = String(profile.unionid || "").trim();
  const openid = String(profile.openid || "").trim();
  if (!unionid && !openid) throw new Error("微信授权结果缺少 openid。");
  return unionid || openid;
}

function wechatUsername(profile = {}) {
  const digest = crypto.createHash("sha256").update(wechatSubject(profile)).digest("hex").slice(0, 12);
  return `wx_${digest}`;
}

function wechatDisplayName(profile = {}) {
  return String(profile.nickname || profile.displayName || "").trim().slice(0, 80) || "微信用户";
}

function explicitWechatDisplayName(profile = {}) {
  return String(profile.nickname || profile.displayName || "").trim().slice(0, 80);
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
    displayName: row.display_name || row.displayName || "",
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
      { id: "contact_mia", title: "Mia", meta: "智能体", avatar: "./assets/avatar-01.png", status: "可用", note: "负责日常对话、信息整理和轻量任务推进。" },
      { id: "contact_codex", title: "Codex", meta: "代码与自动化", avatar: "./assets/avatar-08.png", status: "本地桥接待接入", note: "通过桌面端 Bridge 调用本机 Hermes / Claude Code / Codex / OpenClaw。" }
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

function fileExtensionForDataUrlMime(mimeType) {
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "application/json") return ".json";
  if (mimeType === "application/zip") return ".zip";
  if (mimeType === "application/vnd.ms-excel") return ".xls";
  if (mimeType === "application/vnd.ms-powerpoint") return ".ppt";
  if (mimeType === "application/msword") return ".doc";
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return ".xlsx";
  if (mimeType === "application/vnd.ms-excel.sheet.macroenabled.12") return ".xlsm";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return ".docx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return ".pptx";
  if (mimeType === "text/markdown") return ".md";
  if (mimeType === "text/csv") return ".csv";
  if (mimeType === "text/tab-separated-values") return ".tsv";
  if (mimeType === "text/plain") return ".txt";
  return "";
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
    displayName: row.display_name || "",
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

function parseFileDataUrl(dataUrl) {
  const raw = String(dataUrl || "");
  const match = raw.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid file payload.");
  const mimeType = String(match[1] || "").toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error("Invalid file size.");
  return { mimeType, buffer };
}

function typeForStoredFile(mimeType, name = "") {
  if (ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) return "image";
  if (mimeType === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mimeType.startsWith("text/") || /\.(txt|md|markdown|json|csv|tsv|log)$/i.test(name)) return "text";
  return "file";
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
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  resetVolatileBridgeState(db, now);

  function id(prefix) {
    return randomId(prefix, randomBytes);
  }

  function getUserByUsername(username) {
    const row = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").trim().toLowerCase());
    return row ? publicUser(row) : null;
  }

  function getUserById(userId) {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  }

  function generateUniquePrincipalId() {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const userId = generatePrincipalId(randomBytes);
      if (!getUserById(userId)) return userId;
    }
    throw new Error("无法生成唯一用户 UID。");
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

  // (ensureWorkspace removed in Phase 4 cutover — workspace snapshots
  //  are no longer the conversation store. The `workspaces` table is
  //  left intact but unused; a future commit can DROP it once we've
  //  confirmed no rollback need.)

  function findWechatUser(profile = {}) {
    const unionid = String(profile.unionid || "").trim();
    const openid = String(profile.openid || "").trim();
    if (unionid) {
      const row = db.prepare(`
        SELECT u.*
        FROM wechat_accounts w
        JOIN users u ON u.id = w.user_id
        WHERE w.unionid = ?
        LIMIT 1
      `).get(unionid);
      if (row) return row;
    }
    if (openid) {
      const row = db.prepare(`
        SELECT u.*
        FROM wechat_accounts w
        JOIN users u ON u.id = w.user_id
        WHERE w.openid = ?
        LIMIT 1
      `).get(openid);
      if (row) return row;
    }
    return null;
  }

  function upsertWechatAccount(userId, profile = {}) {
    const timestamp = now();
    const openid = String(profile.openid || "").trim();
    const unionid = String(profile.unionid || "").trim();
    if (!openid && !unionid) throw new Error("微信授权结果缺少 openid。");
    db.prepare(`
      INSERT INTO wechat_accounts (
        openid, user_id, unionid, nickname, avatar_url, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(openid) DO UPDATE SET
        user_id = excluded.user_id,
        unionid = excluded.unionid,
        nickname = excluded.nickname,
        avatar_url = excluded.avatar_url,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `).run(
      openid || unionid,
      userId,
      unionid,
      wechatDisplayName(profile),
      String(profile.avatarUrl || "").trim(),
      JSON.stringify(profile.raw || {}),
      timestamp,
      timestamp
    );
  }

  function loginWithWechat(profile = {}) {
    const openid = String(profile.openid || "").trim();
    const unionid = String(profile.unionid || "").trim();
    if (!openid && !unionid) throw new Error("微信授权结果缺少 openid。");
    let row = findWechatUser(profile);
    if (!row) {
      const userId = generateUniquePrincipalId();
      const createdAt = now();
      db.prepare(`
        INSERT INTO users (id, account, username, email, display_name, avatar_image, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        `wechat:${wechatSubject(profile)}`,
        wechatUsername(profile),
        "",
        wechatDisplayName(profile),
        String(profile.avatarUrl || "").trim(),
        createdAt
      );
      row = getUserById(userId);
    } else {
      const displayName = explicitWechatDisplayName(profile);
      const avatarImage = String(profile.avatarUrl || "").trim();
      const updates = [];
      const values = [];
      if (displayName && (!row.display_name || row.display_name === "微信用户")) {
        updates.push("display_name = ?");
        values.push(displayName);
      }
      if (avatarImage && !row.avatar_image) {
        updates.push("avatar_image = ?");
        values.push(avatarImage);
      }
      if (updates.length) {
        values.push(row.id);
        db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      }
      row = getUserById(row.id);
    }
    upsertWechatAccount(row.id, profile);
    const user = rowToUser(getUserById(row.id));
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

  function saveFileDataUrl(userId, attachment = {}) {
    if (!getUserById(userId)) throw new Error("用户不存在。");
    const { mimeType, buffer } = parseFileDataUrl(attachment.dataUrl);
    if (mimeType.startsWith("image/")) return saveImageDataUrl(userId, attachment);
    if (!ALLOWED_FILE_DATA_URL_MIME_TYPES.has(mimeType)) throw new Error("Unsupported file type.");
    const fileId = id("file");
    const userDir = path.join(uploadDir, userId);
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    const fallbackName = `${fileId}${fileExtensionForDataUrlMime(mimeType)}`;
    const name = sanitizeStoredFileName(attachment.name || fallbackName, fallbackName);
    const ext = path.extname(name) || fileExtensionForDataUrlMime(mimeType);
    const filePath = path.join(userDir, `${fileId}${ext || ""}`);
    fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    db.prepare(`
      INSERT INTO files (id, user_id, type, name, mime_type, path, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fileId,
      userId,
      typeForStoredFile(mimeType, name),
      name,
      mimeType,
      filePath,
      buffer.length,
      now()
    );
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

  function getFile(fileId) {
    return rowToFile(db.prepare("SELECT * FROM files WHERE id = ?").get(String(fileId || "")));
  }

  function listBridgeDevices(userId, options = {}) {
    const includeOffline = Boolean(options.includeOffline || options.includeAll);
    if (includeOffline) {
      return db.prepare(`
        SELECT * FROM bridge_devices
        WHERE user_id = ?
        ORDER BY status = 'online' DESC, last_seen_at DESC
      `).all(userId).map(rowToDevice);
    }
    return db.prepare(`
      SELECT * FROM bridge_devices
      WHERE user_id = ? AND status = 'online'
      ORDER BY last_seen_at DESC
    `).all(userId).map(rowToDevice);
  }

  function bridgeDeviceEngine(input = {}) {
    const explicit = String(input.engine || "").trim().slice(0, 40);
    const engines = Array.isArray(input.capabilities?.engines)
      ? input.capabilities.engines.map((engine) => String(engine || "").trim()).filter(Boolean)
      : [];
    return explicit || engines.find((engine) => ["hermes", "claude-code", "codex", "openclaw"].includes(engine)) || "mia-desktop";
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
      bridgeDeviceEngine(input),
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
    if (typeof patch.displayName === "string") {
      sets.push("display_name = ?");
      values.push(patch.displayName.trim().slice(0, 120));
    }
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
      values.push(sanitizeCssColor(patch.avatarColor));
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

  function upsertPushToken(userId, token, meta = {}) {
    const value = String(token || "").trim();
    if (!userId || !value) return false;
    const now = nowIso();
    db.prepare(
      `INSERT INTO push_tokens (token, user_id, platform, device_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET
         user_id = excluded.user_id,
         platform = excluded.platform,
         device_name = excluded.device_name,
         updated_at = excluded.updated_at`
    ).run(value, userId, String(meta.platform || "").slice(0, 40), String(meta.deviceName || "").slice(0, 120), now, now);
    return true;
  }

  function deletePushToken(token) {
    const value = String(token || "").trim();
    if (!value) return false;
    return db.prepare("DELETE FROM push_tokens WHERE token = ?").run(value).changes > 0;
  }

  function listPushTokens(userId) {
    if (!userId) return [];
    return db
      .prepare("SELECT token, platform, device_name FROM push_tokens WHERE user_id = ?")
      .all(userId)
      .map((r) => ({ token: r.token, platform: r.platform, deviceName: r.device_name }));
  }

  return {
    loginWithWechat,
    logoutSession,
    authenticateToken,
    saveImageDataUrl,
    saveFileDataUrl,
    saveLocalFileForUser,
    getFile,
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
    upsertPushToken,
    deletePushToken,
    listPushTokens,
    getDb: () => db,
    uploadDir,
    dataDir: path.dirname(dbPath),
    close: () => db.close()
  };
}

function migrate(db) {
  if (!hasColumn(db, "cloud_agent_runs", "bot_id")) {
    db.exec("DROP TABLE IF EXISTS cloud_agent_runs");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wechat_accounts (
      openid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unionid TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wechat_accounts_user ON wechat_accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_wechat_accounts_unionid ON wechat_accounts(unionid);

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
    --   'group' — multi-member conversation (internal id format g_<public_id>)
    --   'bot'   — a private chat with a globally identified bot.
    -- The type column is the canonical answer for "what kind of
    -- conversation is this"; id prefix is just a historical hint.
    CREATE TABLE IF NOT EXISTS conversations (
      id                TEXT PRIMARY KEY,
      public_id         TEXT,
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
      content_blocks_json TEXT,
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
      muted_conversations_json TEXT NOT NULL DEFAULT '[]',
      unread_overrides_json TEXT NOT NULL DEFAULT '{}',
      appearance_json  TEXT NOT NULL DEFAULT '{}',
      tags_json        TEXT NOT NULL DEFAULT '{"items":[],"assignments":{}}',
      starter_engine_bots_json TEXT NOT NULL DEFAULT '{}',
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

    CREATE TABLE IF NOT EXISTS model_accounts (
      user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance_microusd  INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_balance_ledger (
      id                      TEXT PRIMARY KEY,
      user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta_microusd          INTEGER NOT NULL,
      balance_after_microusd  INTEGER NOT NULL,
      reason                  TEXT NOT NULL DEFAULT '',
      usage_id                TEXT NOT NULL DEFAULT '',
      created_at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_balance_ledger_user
      ON model_balance_ledger(user_id, created_at);

    CREATE TABLE IF NOT EXISTS model_usage_ledger (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_id           TEXT NOT NULL,
      upstream_model     TEXT NOT NULL DEFAULT '',
      provider           TEXT NOT NULL DEFAULT '',
      request_path       TEXT NOT NULL DEFAULT '',
      prompt_tokens      INTEGER NOT NULL DEFAULT 0,
      completion_tokens  INTEGER NOT NULL DEFAULT 0,
      total_tokens       INTEGER NOT NULL DEFAULT 0,
      cost_microusd      INTEGER NOT NULL DEFAULT 0,
      charge_microusd    INTEGER NOT NULL DEFAULT 0,
      status             TEXT NOT NULL,
      error              TEXT NOT NULL DEFAULT '',
      created_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_usage_ledger_user
      ON model_usage_ledger(user_id, created_at);

    CREATE TABLE IF NOT EXISTS model_gateway_settings (
      id                             TEXT PRIMARY KEY,
      mode                           TEXT NOT NULL DEFAULT 'deepseek',
      model_id                       TEXT NOT NULL DEFAULT 'mia-auto',
      provider                       TEXT NOT NULL DEFAULT 'deepseek',
      upstream_model                 TEXT NOT NULL DEFAULT 'deepseek-chat',
      api_base                       TEXT NOT NULL DEFAULT '',
      api_key                        TEXT NOT NULL DEFAULT '',
      input_microusd_per_million     INTEGER NOT NULL DEFAULT 140000,
      output_microusd_per_million    INTEGER NOT NULL DEFAULT 280000,
      markup                         REAL NOT NULL DEFAULT 1,
      updated_at                     TEXT NOT NULL
    );

    -- Expo push tokens for mobile devices. token is globally unique to one
    -- device; re-login as another account on the same phone re-points the row
    -- so a device never double-delivers to a previous user.
    CREATE TABLE IF NOT EXISTS push_tokens (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform    TEXT NOT NULL DEFAULT '',
      device_name TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

    -- v17: scheduled tasks are account-scoped cloud state. Desktop and MCP
    -- still call the local daemon, but the daemon proxies these APIs to Cloud
    -- so every device sees the same task list and history.
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title               TEXT NOT NULL,
      bot_id              TEXT NOT NULL,
      conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      session_id          TEXT NOT NULL DEFAULT '',
      origin_message_id   TEXT NOT NULL DEFAULT '',
      trigger_json        TEXT NOT NULL DEFAULT '{}',
      timezone            TEXT NOT NULL DEFAULT 'UTC',
      prompt              TEXT NOT NULL DEFAULT '',
      fire_mode           TEXT NOT NULL DEFAULT 'agent',
      delivery_text       TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'active',
      runtime_kind        TEXT NOT NULL DEFAULT '',
      runtime_config_json TEXT NOT NULL DEFAULT '{}',
      target_device_id    TEXT NOT NULL DEFAULT '',
      next_fire_at        INTEGER,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON scheduled_tasks(user_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(status, next_fire_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_conversation ON scheduled_tasks(conversation_id);

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id                TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fired_at          INTEGER NOT NULL,
      finished_at       INTEGER,
      status            TEXT NOT NULL,
      output_message_id TEXT,
      output_text       TEXT NOT NULL DEFAULT '',
      error             TEXT NOT NULL DEFAULT '',
      missed_count      INTEGER NOT NULL DEFAULT 0,
      first_missed_at   INTEGER,
      last_missed_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task ON scheduled_task_runs(task_id, fired_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_user ON scheduled_task_runs(user_id, fired_at);

    -- v22: account-scoped Mia memory sync. Engine-native sessions remain
    -- engine-owned; this table stores only policy-scoped Mia memory entries
    -- that have already been assigned to user / bot / session scope locally.
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT '',
      origin_engine TEXT NOT NULL DEFAULT '',
      origin_native_session_id TEXT NOT NULL DEFAULT '',
      source_message_ids_json TEXT NOT NULL DEFAULT '[]',
      linked_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      policy_result_json TEXT NOT NULL DEFAULT '{}',
      hash TEXT NOT NULL DEFAULT '',
      text_normalized TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      deleted_at TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_user_updated ON memory_entries(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_scope ON memory_entries(user_id, scope, bot_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_deleted ON memory_entries(user_id, deleted_at);

    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_user_created ON memory_events(user_id, created_at);
  `);
  if (!hasColumn(db, "bridge_runs", "request_attachments_json")) {
    db.exec("ALTER TABLE bridge_runs ADD COLUMN request_attachments_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!hasColumn(db, "users", "display_name")) {
    db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, "scheduled_tasks", "next_fire_at")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN next_fire_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(status, next_fire_at)");
  }
  if (!hasColumn(db, "scheduled_tasks", "fire_mode")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN fire_mode TEXT NOT NULL DEFAULT 'agent'");
  }
  if (!hasColumn(db, "scheduled_tasks", "delivery_text")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN delivery_text TEXT NOT NULL DEFAULT ''");
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
  if (!hasColumn(db, "user_settings", "tags_json")) {
    db.exec("ALTER TABLE user_settings ADD COLUMN tags_json TEXT NOT NULL DEFAULT '{\"items\":[],\"assignments\":{}}'");
  }
  if (!hasColumn(db, "user_settings", "muted_conversations_json")) {
    db.exec("ALTER TABLE user_settings ADD COLUMN muted_conversations_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!hasColumn(db, "user_settings", "unread_overrides_json")) {
    db.exec("ALTER TABLE user_settings ADD COLUMN unread_overrides_json TEXT NOT NULL DEFAULT '{}'");
  }
  // v7: conversations.type column for explicit conversation kind. Existing
  // rows backfilled by id prefix; new rows must declare it.
  if (!hasColumn(db, "conversations", "type")) {
    db.exec("ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'group'");
    db.exec("UPDATE conversations SET type = 'dm' WHERE id LIKE 'dm:%'");
    db.exec("UPDATE conversations SET type = 'bot' WHERE id LIKE 'bot:%'");
  }
  if (!hasColumn(db, "conversations", "public_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN public_id TEXT");
  }
  for (const row of db.prepare("SELECT id FROM conversations WHERE type = 'group' AND (public_id IS NULL OR public_id = '') AND id LIKE 'g_%'").all()) {
    const publicId = publicIdFromConversationId(row.id);
    if (publicId) {
      db.prepare("UPDATE conversations SET public_id = ? WHERE id = ? AND (public_id IS NULL OR public_id = '')")
        .run(publicId, row.id);
    }
  }
  cleanupRetiredIdentityRows(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_public_id ON conversations(public_id) WHERE public_id IS NOT NULL AND public_id <> ''");
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
  // v14: user profile display names are account-scoped cloud state, not a
  // global desktop-local file.
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (14, ?)")
    .run(nowIso());
  // v15: platform model billing. Users buy Mia model credits; the server calls
  // upstream providers with Mia-owned keys and records each billable model use.
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (15, ?)")
    .run(nowIso());
  // v16: per-user conversation tags live in user_settings.tags_json.
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (16, ?)")
    .run(nowIso());
  // v17: cloud-owned scheduled tasks and run history.
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (17, ?)")
    .run(nowIso());
  // v18: conversation mute + manual unread overrides live in user_settings.
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (18, ?)")
    .run(nowIso());
  // v19: simple reminder tasks store final delivery text and do not rerun an
  // agent at fire time.
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (19, ?)")
    .run(nowIso());
  // v20: ordered assistant content blocks preserve the real event order inside
  // one bot-authored message.
  if (!hasColumn(db, "messages", "content_blocks_json")) {
    db.exec("ALTER TABLE messages ADD COLUMN content_blocks_json TEXT");
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (20, ?)")
    .run(nowIso());
  // v21: account-level marker for one-time starter bots generated from the
  // user's usable local agent engines.
  if (!hasColumn(db, "user_settings", "starter_engine_bots_json")) {
    db.exec("ALTER TABLE user_settings ADD COLUMN starter_engine_bots_json TEXT NOT NULL DEFAULT '{}'");
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (21, ?)")
    .run(nowIso());
  // v22: cloud memory sync metadata. Existing self-hosted databases may have
  // been created before tombstones/revisions were added, so keep the additive
  // column checks even though the CREATE TABLE above covers fresh databases.
  if (!hasColumn(db, "memory_entries", "deleted_at")) {
    db.exec("ALTER TABLE memory_entries ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, "memory_entries", "revision")) {
    db.exec("ALTER TABLE memory_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  }
  if (hasColumn(db, "memory_entries", "kind") || hasColumn(db, "memory_entries", "status")) {
    db.exec(`
      CREATE TABLE memory_entries_clean (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 1,
        source TEXT NOT NULL DEFAULT '',
        origin_engine TEXT NOT NULL DEFAULT '',
        origin_native_session_id TEXT NOT NULL DEFAULT '',
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        linked_memory_ids_json TEXT NOT NULL DEFAULT '[]',
        policy_result_json TEXT NOT NULL DEFAULT '{}',
        hash TEXT NOT NULL DEFAULT '',
        text_normalized TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        deleted_at TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO memory_entries_clean (
        id, user_id, bot_id, session_id, scope, text, confidence,
        source, origin_engine, origin_native_session_id, source_message_ids_json,
        linked_memory_ids_json, policy_result_json, hash, text_normalized, priority,
        pinned, created_at, updated_at, last_used_at, expires_at, metadata_json,
        deleted_at, revision
      )
      SELECT
        id, user_id, bot_id, session_id, scope, text, confidence,
        source, origin_engine, origin_native_session_id, source_message_ids_json,
        linked_memory_ids_json, policy_result_json, hash, text_normalized, priority,
        pinned, created_at, updated_at, last_used_at, expires_at, metadata_json,
        deleted_at, revision
      FROM memory_entries;
      DROP TABLE memory_entries;
      ALTER TABLE memory_entries_clean RENAME TO memory_entries;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_entries_user_updated ON memory_entries(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_scope ON memory_entries(user_id, scope, bot_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_deleted ON memory_entries(user_id, deleted_at);
    `);
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (22, ?)")
    .run(nowIso());
}

function retiredIdentityKind() {
  return ["fel", "low"].join("");
}

function cleanupRetiredIdentityRows(db) {
  const retiredKind = retiredIdentityKind();
  const retiredPrivateConversation = `${retiredKind}:%`;
  db.prepare("DELETE FROM messages WHERE conversation_id LIKE ?").run(retiredPrivateConversation);
  db.prepare("DELETE FROM messages WHERE sender_kind = ?").run(retiredKind);
  db.prepare("DELETE FROM conversation_members WHERE conversation_id LIKE ?").run(retiredPrivateConversation);
  db.prepare("DELETE FROM conversation_members WHERE member_kind = ?").run(retiredKind);
  db.prepare("DELETE FROM conversations WHERE type = ? OR id LIKE ?").run(retiredKind, retiredPrivateConversation);
}

module.exports = {
  createCloudStore
};
