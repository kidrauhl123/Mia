const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function defaultReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function createAgentSessionStore(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const readJson = deps.readJson || defaultReadJson;
  const normalizeBotAgentEngine = deps.normalizeBotAgentEngine || ((engine) => String(engine || "").trim());
  const fsImpl = deps.fs || fs;

  function sessionFilePath() {
    return runtimePaths().agentSessions;
  }

  function loadMap() {
    const raw = readJson(sessionFilePath(), {});
    return raw && typeof raw === "object" ? raw : {};
  }

  function saveMap(store) {
    const filePath = sessionFilePath();
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(store || {}, null, 2) + "\n", { mode: 0o600 });
    if (typeof fsImpl.chmodSync === "function") fsImpl.chmodSync(filePath, 0o600);
  }

  function workspaceKey(workspacePath = "") {
    const raw = String(workspacePath || "").trim();
    if (!raw) return "";
    const normalized = path.resolve(raw);
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  function sessionKey(engine, botId, sessionId, workspacePath = "") {
    const parts = [
      normalizeBotAgentEngine(engine),
      String(botId || "mia").trim() || "mia",
      String(sessionId || "default").trim() || "default"
    ];
    const scopedWorkspace = workspaceKey(workspacePath);
    if (scopedWorkspace) {
      parts.push("workspace", scopedWorkspace);
    }
    return parts.join(":");
  }

  function getEntry(engine, botId, sessionId, workspacePath = "") {
    const store = loadMap();
    const entry = store[sessionKey(engine, botId, sessionId, workspacePath)];
    if (!entry) return { id: "", fingerprint: "" };
    if (typeof entry === "string") return { id: entry.trim(), fingerprint: "" };
    return {
      id: String(entry.id || "").trim(),
      fingerprint: String(entry.fingerprint || "").trim()
    };
  }

  function getId(engine, botId, sessionId, workspacePath = "") {
    return getEntry(engine, botId, sessionId, workspacePath).id;
  }

  function setEntry(engine, botId, sessionId, externalSessionId, fingerprint, workspacePath = "") {
    const id = String(externalSessionId || "").trim();
    if (!id) return;
    const fp = String(fingerprint || "").trim();
    const store = loadMap();
    store[sessionKey(engine, botId, sessionId, workspacePath)] = fp ? { id, fingerprint: fp } : id;
    saveMap(store);
  }

  function setId(engine, botId, sessionId, externalSessionId, workspacePath = "") {
    setEntry(engine, botId, sessionId, externalSessionId, "", workspacePath);
  }

  function deleteEntry(engine, botId, sessionId, workspacePath = "") {
    const store = loadMap();
    const key = sessionKey(engine, botId, sessionId, workspacePath);
    const existed = Object.prototype.hasOwnProperty.call(store, key);
    if (!existed) return false;
    delete store[key];
    saveMap(store);
    return true;
  }

  return {
    deleteEntry,
    getEntry,
    getId,
    loadMap,
    saveMap,
    sessionKey,
    setEntry,
    setId
  };
}

function managerDescriptorBotId(descriptor = {}) {
  return String(descriptor.botId || descriptor.bot_id || descriptor.engineId || "mia").trim() || "mia";
}

function createAgentSessionManagerPersistence(agentSessionStore) {
  const store = agentSessionStore || {};
  return {
    loadNativeSessionId(descriptor = {}) {
      if (typeof store.getId !== "function") return "";
      return store.getId(
        descriptor.engineId,
        managerDescriptorBotId(descriptor),
        descriptor.conversationId,
        descriptor.workspacePath
      );
    },
    saveNativeSessionId(descriptor = {}, nativeSessionId = "") {
      if (typeof store.setId !== "function") return;
      store.setId(
        descriptor.engineId,
        managerDescriptorBotId(descriptor),
        descriptor.conversationId,
        nativeSessionId,
        descriptor.workspacePath
      );
    }
  };
}

module.exports = {
  createAgentSessionManagerPersistence,
  createAgentSessionStore
};
