"use strict";

const { normalizeTurnRuntimeConfig } = require("../runtime-config-normalizer.js");

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20000;

function defaultBridgeState() {
  return {
    connecting: false,
    connected: false,
    deviceId: "",
    lastError: "",
    logs: []
  };
}

function normalizeAgentEngine(value, fallback = "codex") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "claude" || raw === "claude-code" || raw === "anthropic") return "claude-code";
  if (raw === "codex" || raw === "openai-codex") return "codex";
  if (raw === "openclaw" || raw === "open-claw") return "openclaw";
  if (raw === "hermes" || raw === "cloud-hermes") return "hermes";
  return fallback;
}

function engineLabel(engine) {
  if (engine === "claude-code") return "Claude Code";
  if (engine === "codex") return "Codex";
  if (engine === "openclaw") return "OpenClaw";
  return "Hermes";
}

function runtimeConfigFromMessage(message = {}) {
  const raw = message.runtimeConfig || message.runtime_config || message.config || {};
  const input = raw && typeof raw === "object" ? raw : {};
  const agentEngine = normalizeAgentEngine(
    message.agentEngine || message.agent_engine || message.engine || input.agentEngine || input.agent_engine,
    "codex"
  );
  const config = normalizeTurnRuntimeConfig({ ...input, agentEngine });
  for (const key of ["model", "effortLevel", "permissionMode"]) {
    if (message[key] != null) config[key] = message[key];
  }
  if (message.model != null && message.modelProfileId == null && message.model_profile_id == null) {
    delete config.modelProfileId;
  }
  if (message.modelProfileId != null) config.modelProfileId = message.modelProfileId;
  if (message.model_profile_id != null) config.modelProfileId = message.model_profile_id;
  if (message.effort_level != null) config.effortLevel = message.effort_level;
  if (message.permission_mode != null) config.permissionMode = message.permission_mode;
  applyHermesManagedModelFallback(config, input);
  return config;
}

function normalizeMiaManagedModelId(value = "") {
  const id = String(value || "").trim();
  if (id === "mia-default") return "mia-auto";
  return id;
}

function miaManagedEntryFromRuntimeOptions(input = {}) {
  const entries = Array.isArray(input.modelEntries || input.model_entries)
    ? (input.modelEntries || input.model_entries)
    : [];
  for (const entry of entries) {
    const provider = String(
      entry?.providerConnectionId
      || entry?.provider_connection_id
      || entry?.provider
      || ""
    ).trim();
    const authType = String(entry?.authType || entry?.auth_type || "").trim();
    const profileId = String(entry?.modelProfileId || entry?.model_profile_id || "").trim();
    const model = normalizeMiaManagedModelId(entry?.model || entry?.id || entry?.value || "");
    if ((provider === "mia" || authType === "mia_account" || profileId.startsWith("mia:")) && model) {
      return { provider, authType, profileId, model };
    }
  }
  return null;
}

function applyHermesManagedModelFallback(config = {}, input = {}) {
  if (config.agentEngine !== "hermes") return;
  if (config.model || config.providerConnectionId || config.modelProfileId) return;
  const entry = miaManagedEntryFromRuntimeOptions(input);
  if (!entry) return;
  config.providerConnectionId = "mia";
  config.model = entry.model;
  config.modelProfileId = entry.profileId.startsWith("mia:")
    ? `mia:${entry.model}`
    : `mia:${entry.model}`;
}

function attachmentListFromAssistant(assistant = {}, randomUUID = () => "") {
  return (assistant.attachments || []).map((attachment) => ({
    id: attachment.id || `att_${randomUUID()}`,
    type: attachment.type || attachment.kind || "file",
    name: attachment.name || "附件",
    mimeType: attachment.mimeType || attachment.mime || "",
    dataUrl: attachment.dataUrl || attachment.thumbnailDataUrl || "",
    url: attachment.url || ""
  })).filter((attachment) => attachment.dataUrl || attachment.url);
}

function botEngineConfigFromRuntime(runtimeConfig = {}, agentEngine = "codex") {
  return {
    effortLevel: runtimeConfig.effortLevel || "medium",
    ...(agentEngine === "hermes" ? { permissionMode: runtimeConfig.permissionMode || "ask" } : {}),
    ...(runtimeConfig.providerConnectionId ? { providerConnectionId: runtimeConfig.providerConnectionId } : {}),
    ...(runtimeConfig.modelProfileId ? { modelProfileId: runtimeConfig.modelProfileId } : {}),
    ...(runtimeConfig.model ? { model: runtimeConfig.model } : {})
  };
}

function createCloudBridgeClient({
  WebSocketImpl,
  getSettings,
  isDaemonProcess = false,
  isDaemonEnabled,
  cloudBridgeUrl,
  cloudWebSocketProtocols,
  runBridgeBotTurn,
  resolveBotCapabilities = () => ({}),
  resetLocalDeviceIdentity = null,
  randomUUID,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS
}) {
  let activeSocket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let isAlive = true;
  const abortControllers = new Map();
  let bridgeState = defaultBridgeState();

  function settings() {
    return typeof getSettings === "function" ? getSettings() : {};
  }

  function appendLog(line) {
    const token = String(settings().token || "");
    const clean = String(line || "").replace(token ? new RegExp(token, "g") : /$a/, "[REDACTED]");
    bridgeState.logs.push(clean);
    if (bridgeState.logs.length > 200) bridgeState.logs = bridgeState.logs.slice(-200);
  }

  function status(includeToken = false) {
    const s = settings();
    return {
      enabled: Boolean(s.enabled && s.token),
      connected: Boolean(bridgeState.connected),
      connecting: Boolean(bridgeState.connecting),
      url: s.url,
      user: s.user,
      deviceId: bridgeState.deviceId,
      lastError: bridgeState.lastError,
      logs: bridgeState.logs.slice(-80),
      ...(includeToken ? { token: s.token } : {})
    };
  }

  function shouldHostBridge() {
    if (!isDaemonProcess) return false;
    return typeof isDaemonEnabled === "function" ? Boolean(isDaemonEnabled()) : true;
  }

  function sendCloudBridgeRunEvent(ws, runId, kind, payload = {}) {
    if (!ws || ws.readyState !== WebSocketImpl.OPEN || !runId) return;
    ws.send(JSON.stringify({
      type: "run_event",
      runId,
      event: {
        kind: String(kind || "status"),
        ...payload
      }
    }));
  }

  async function runCloudBridgeRequest(ws, message = {}) {
    const runId = String(message.runId || randomUUID());
    const abortController = new AbortController();
    abortControllers.set(runId, abortController);
    const runtimeConfig = runtimeConfigFromMessage(message);
    const agentEngine = normalizeAgentEngine(runtimeConfig.agentEngine, "codex");
    const label = engineLabel(agentEngine);
    if (typeof runBridgeBotTurn !== "function") {
      throw new Error(`${label} 已保存为运行目标，但当前 Bridge 还没有可用运行入口。`);
    }
    const botKey = String(message.botKey || message.botId || `mia_cloud_${agentEngine.replace(/[^a-z0-9]+/g, "_")}`).trim();
    const botName = String(message.botName || message.displayName || label).trim();
    const capabilities = resolveBotCapabilities({ botKey, botName, message, runtimeConfig }) || {};
    const botSnapshot = {
      key: botKey,
      id: botKey,
      name: botName,
      agentEngine,
      bio: "",
      capabilities,
      engineConfig: botEngineConfigFromRuntime(runtimeConfig, agentEngine)
    };
    try {
      const response = await runBridgeBotTurn({
        botKey,
        botId: botKey,
        botSnapshot,
        sessionId: `cloud:${String(message.conversationId || "default")}`,
        messages: [{
          role: "user",
          content: String(message.text || ""),
          attachments: Array.isArray(message.attachments) ? message.attachments : []
        }],
        signal: abortController.signal,
        emit: (kind, payload) => sendCloudBridgeRunEvent(ws, runId, kind, payload),
        utility: false,
        runtimeConfig
      });
      const assistant = response.choices?.[0]?.message || {};
      const attachments = attachmentListFromAssistant(assistant, randomUUID);
      return {
        text: String(assistant.content || "").trim() || (attachments.length ? "图片已生成。" : `本机 ${label} 已完成。`),
        attachments
      };
    } finally {
      abortControllers.delete(runId);
    }
  }

  function handleMessage(ws, raw) {
    isAlive = true;
    let message = null;
    try {
      message = JSON.parse(String(raw || ""));
    } catch {
      appendLog("Cloud bridge sent invalid JSON.");
      return;
    }
    if (message.type === "bridge_ready") {
      bridgeState.connected = true;
      bridgeState.connecting = false;
      bridgeState.deviceId = String(message.deviceId || "");
      bridgeState.lastError = "";
      appendLog("Mia Cloud Bridge connected.");
      return;
    }
    if (message.type === "device_identity_conflict") {
      bridgeState.connected = false;
      bridgeState.connecting = false;
      bridgeState.deviceId = "";
      bridgeState.lastError = String(message.message || "设备标识冲突，已重新生成本机设备标识。");
      appendLog(bridgeState.lastError);
      try {
        if (typeof resetLocalDeviceIdentity === "function") resetLocalDeviceIdentity(message);
      } catch (error) {
        appendLog(`Device identity reset failed: ${error?.message || error}`);
      }
      if (activeSocket === ws) activeSocket = null;
      if (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING) {
        try { ws.close(4009, "device identity conflict"); } catch { /* ignore stale socket close */ }
      }
      scheduleReconnect();
      return;
    }
    if (message.type === "cancel") {
      abortControllers.get(String(message.runId || ""))?.abort();
      return;
    }
    if (message.type !== "run") return;
    const runId = String(message.runId || "");
    runCloudBridgeRequest(ws, message)
      .then((result) => {
        if (ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify({ type: "run_result", runId, ok: true, ...result }));
      })
      .catch((error) => {
        if (ws.readyState === WebSocketImpl.OPEN) {
          ws.send(JSON.stringify({ type: "run_result", runId, ok: false, error: String(error?.message || error) }));
        }
        appendLog(`Cloud run failed: ${error?.message || error}`);
      });
  }

  function recycleSocket(ws, reason) {
    if (!ws) return;
    bridgeState.lastError = reason;
    appendLog(`Mia Cloud Bridge ${reason}; reconnecting.`);
    try {
      if (typeof ws.terminate === "function") ws.terminate();
      else ws.close(4000, reason);
    } catch { /* ignore terminate failures */ }
    if (activeSocket === ws) {
      activeSocket = null;
      bridgeState.connected = false;
      bridgeState.connecting = false;
      bridgeState.deviceId = "";
      scheduleReconnect();
    }
  }

  function heartbeatTick() {
    const ws = activeSocket;
    if (!ws || !bridgeState.connected) return;
    if (!isAlive) {
      recycleSocket(ws, "heartbeat timeout");
      return;
    }
    isAlive = false;
    try {
      if (typeof ws.ping === "function") ws.ping();
    } catch {
      recycleSocket(ws, "ping failed");
    }
  }

  function ensureHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setIntervalFn(heartbeatTick, heartbeatIntervalMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const s = settings();
    if (!s.enabled || !s.token) return;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      start();
    }, reconnectDelayMs);
  }

  function stop() {
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
    }
    const ws = activeSocket;
    activeSocket = null;
    if (ws && (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING)) {
      ws.close(1000, "cloud disabled");
    }
    bridgeState = {
      ...bridgeState,
      connecting: false,
      connected: false,
      deviceId: ""
    };
    return status(false);
  }

  function start() {
    if (!shouldHostBridge()) {
      if (activeSocket) stop();
      return status(false);
    }
    const s = settings();
    if (!s.enabled || !s.token) return status(false);
    if (activeSocket && [WebSocketImpl.CONNECTING, WebSocketImpl.OPEN].includes(activeSocket.readyState)) {
      return status(false);
    }
    bridgeState.connecting = true;
    bridgeState.connected = false;
    bridgeState.lastError = "";
    isAlive = true;
    const ws = new WebSocketImpl(cloudBridgeUrl(s), cloudWebSocketProtocols(s));
    activeSocket = ws;
    ensureHeartbeat();
    ws.on("open", () => {
      appendLog(`Connecting to Mia Cloud: ${s.url}`);
    });
    ws.on("pong", () => { isAlive = true; });
    ws.on("message", (raw) => handleMessage(ws, raw));
    ws.on("error", (error) => {
      bridgeState.lastError = String(error?.message || error);
      appendLog(`Cloud bridge socket error: ${bridgeState.lastError}`);
    });
    ws.on("close", () => {
      if (activeSocket !== ws) return;
      activeSocket = null;
      bridgeState.connected = false;
      bridgeState.connecting = false;
      bridgeState.deviceId = "";
      appendLog("Mia Cloud Bridge disconnected.");
      scheduleReconnect();
    });
    return status(false);
  }

  return {
    appendLog,
    handleMessage,
    start,
    status,
    stop
  };
}

module.exports = {
  createCloudBridgeClient
};
