const fs = require("node:fs");
const path = require("node:path");

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
  const normalizeFellowAgentEngine = deps.normalizeFellowAgentEngine || ((engine) => String(engine || "").trim());
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

  function sessionKey(engine, fellowKey, sessionId) {
    return [
      normalizeFellowAgentEngine(engine),
      String(fellowKey || "mia").trim() || "mia",
      String(sessionId || "default").trim() || "default"
    ].join(":");
  }

  function getEntry(engine, fellowKey, sessionId) {
    const store = loadMap();
    const entry = store[sessionKey(engine, fellowKey, sessionId)];
    if (!entry) return { id: "", fingerprint: "" };
    if (typeof entry === "string") return { id: entry.trim(), fingerprint: "" };
    return {
      id: String(entry.id || "").trim(),
      fingerprint: String(entry.fingerprint || "").trim()
    };
  }

  function getId(engine, fellowKey, sessionId) {
    return getEntry(engine, fellowKey, sessionId).id;
  }

  function setEntry(engine, fellowKey, sessionId, externalSessionId, fingerprint) {
    const id = String(externalSessionId || "").trim();
    if (!id) return;
    const fp = String(fingerprint || "").trim();
    const store = loadMap();
    store[sessionKey(engine, fellowKey, sessionId)] = fp ? { id, fingerprint: fp } : id;
    saveMap(store);
  }

  function setId(engine, fellowKey, sessionId, externalSessionId) {
    setEntry(engine, fellowKey, sessionId, externalSessionId, "");
  }

  function deleteEntry(engine, fellowKey, sessionId) {
    const store = loadMap();
    const key = sessionKey(engine, fellowKey, sessionId);
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

module.exports = {
  createAgentSessionStore
};
