const { spawn: defaultSpawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");
const { spawnExecutable } = require("./agent-runtime/process-launcher.js");
const {
  createWorkspaceDiffTracker,
  fileEditPayloadsFromAcpContent
} = require("./agent-file-edit-events.js");
const { isForbiddenSchedulerToolName } = require("./scheduler-tool-guard.js");

const CODEX_APP_SERVER_PROTOCOL_VERSION = 2;
const CODEX_CHATGPT_HTTPS_PROVIDER_ID = "mia-chatgpt-http";
const CODEX_CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlArray(values = []) {
  return `[${(Array.isArray(values) ? values : []).map(tomlString).join(",")}]`;
}

function tomlPathSegment(value) {
  const key = String(value || "").trim();
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return tomlString(key);
}

function codexConfigOverridesForMcpServers(mcpServers = {}) {
  const overrides = [];
  for (const [name, spec] of Object.entries(mcpServers || {})) {
    const serverName = String(name || "").trim();
    const prefix = `mcp_servers.${tomlPathSegment(serverName)}`;
    const url = String(spec?.url || "").trim();
    const command = String(spec?.command || "").trim();
    if (!serverName) continue;
    if (url) {
      overrides.push(`${prefix}.url=${tomlString(url)}`);
      const bearer = String(spec?.bearer_token_env_var || spec?.bearerTokenEnvVar || "").trim();
      if (bearer) overrides.push(`${prefix}.bearer_token_env_var=${tomlString(bearer)}`);
      continue;
    }
    if (!command) continue;
    overrides.push(`${prefix}.command=${tomlString(command)}`);
    overrides.push(`${prefix}.args=${tomlArray(spec.args || [])}`);
    for (const [key, value] of Object.entries(spec.env || {})) {
      overrides.push(`${prefix}.env.${key}=${tomlString(value)}`);
    }
  }
  return overrides;
}

function codexChatGptHttpsProviderOverrides() {
  const prefix = `model_providers.${tomlPathSegment(CODEX_CHATGPT_HTTPS_PROVIDER_ID)}`;
  return [
    `model_provider=${tomlString(CODEX_CHATGPT_HTTPS_PROVIDER_ID)}`,
    `${prefix}.name=${tomlString("ChatGPT Codex HTTPS")}`,
    `${prefix}.base_url=${tomlString(CODEX_CHATGPT_CODEX_BASE_URL)}`,
    `${prefix}.wire_api=${tomlString("responses")}`,
    `${prefix}.requires_openai_auth=true`,
    `${prefix}.supports_websockets=false`
  ];
}

function shouldUseCodexChatGptHttpsProvider({ baseUrl = "", apiKey = "", env = {}, options = {} } = {}) {
  if (options.codexChatGptHttpsProvider === false) return false;
  if (String(baseUrl || "").trim() || String(apiKey || "").trim()) return false;
  if (String(env?.CODEX_API_KEY || env?.OPENAI_API_KEY || "").trim()) return false;
  return true;
}

function stoppedError() {
  const stopped = new Error("生成已停止");
  stopped.code = "MIA_STOPPED";
  return stopped;
}

function sandboxPolicy(mode) {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function finalTextFromTurn(turn = {}) {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const message = [...items].reverse().find((item) => item?.type === "agentMessage" && item.text);
  return String(message?.text || "");
}

function toolPayloadFromCodexItem(item = {}) {
  if (item.type === "commandExecution") {
    return {
      id: String(item.id || "command"),
      name: "shell",
      preview: String(item.command || ""),
      status: item.status || "",
      duration: typeof item.durationMs === "number" ? item.durationMs / 1000 : null,
      error: item.status === "failed"
    };
  }
  if (item.type === "fileChange") {
    return null;
  }
  if (item.type === "mcpToolCall") {
    return {
      id: String(item.id || "mcp_tool"),
      name: [item.server, item.tool].filter(Boolean).join(".") || "mcp",
      preview: item.arguments ? JSON.stringify(item.arguments, null, 2).slice(0, 4000) : "",
      status: item.status || "",
      duration: typeof item.durationMs === "number" ? item.durationMs / 1000 : null,
      error: item.status === "failed"
    };
  }
  if (item.type === "webSearch") {
    return {
      id: String(item.id || "web_search"),
      name: "web_search",
      preview: String(item.query || ""),
      status: "",
      duration: null,
      error: false
    };
  }
  return null;
}

function fileEditPayloadsFromCodexItem(item = {}) {
  if (item.type !== "fileChange") return [];
  return fileEditPayloadsFromAcpContent(item.changes || [], {
    idPrefix: String(item.id || "file_change"),
    status: item.status || "completed",
    error: item.status === "failed"
  });
}

function writeJsonLine(child, message) {
  if (!child.stdin || child.stdin.destroyed) return;
  const payload = message && typeof message === "object" && !Object.prototype.hasOwnProperty.call(message, "version")
    ? { version: CODEX_APP_SERVER_PROTOCOL_VERSION, ...message }
    : message;
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function envWithExecutableDirFirst(env = {}, executablePath = "") {
  const dir = path.dirname(String(executablePath || ""));
  if (!dir || dir === ".") return env || {};
  const currentPath = String(env?.PATH || env?.Path || "");
  const delimiter = process.platform === "win32" && !currentPath.includes(";") && !/^[A-Za-z]:[\\/]/.test(currentPath)
    ? ":"
    : process.platform === "win32" ? ";" : path.delimiter;
  const parts = currentPath.split(delimiter).filter(Boolean).filter((item) => item !== dir);
  return {
    ...(env || {}),
    PATH: [dir, ...parts].join(delimiter)
  };
}

function createCodexAppServerConnection({
  codexPath,
  env,
  configOverrides = [],
  spawn = defaultSpawn,
  platform = process.platform,
  onNotification = () => {},
  onServerRequest = null,
  onClose = null,
  appendLog = () => {}
} = {}) {
  if (!codexPath) throw new Error("codexPath is required.");
  let nextId = 1;
  const pending = new Map();
  let notificationHandler = typeof onNotification === "function" ? onNotification : () => {};
  let serverRequestHandler = typeof onServerRequest === "function" ? onServerRequest : null;
  let closed = false;
  const args = ["app-server", "--listen", "stdio://"];
  for (const override of configOverrides) {
    if (override) args.push("--config", String(override));
  }
  const child = spawnExecutable(spawn, codexPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithExecutableDirFirst(env, codexPath)
  }, { platform });
  appendLog(`[codex-app-server] spawned ${codexPath}`);
  let stderr = "";
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
  }
  function rejectPending(error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function markClosed(error) {
    if (closed) return;
    closed = true;
    rejectPending(error);
    if (typeof onClose === "function") {
      try { onClose(error); } catch { /* ignore close observers */ }
    }
  }

  child.once("error", (error) => {
    markClosed(error);
  });
  child.once("exit", (code, signal) => {
    if (closed) return;
    const message = signal
      ? `Codex app-server exited with signal ${signal}`
      : `Codex app-server exited with code ${code ?? 1}`;
    markClosed(new Error(stderr ? `${message}: ${stderr}` : message));
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      appendLog(`Codex app-server JSON parse failed: ${error?.message || error}`);
      return;
    }
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.id != null && message.method && typeof serverRequestHandler === "function") {
      Promise.resolve()
        .then(() => serverRequestHandler(message))
        .then((result) => writeJsonLine(child, { id: message.id, result: result == null ? {} : result }))
        .catch((error) => writeJsonLine(child, {
          id: message.id,
          error: { code: -32000, message: String(error?.message || error) }
      }));
      return;
    }
    if (message.method) notificationHandler(message);
  });

  function request(method, params) {
    if (closed) return Promise.reject(new Error("Codex app-server connection is closed."));
    const id = nextId++;
    writeJsonLine(child, { id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function setHandlers(handlers = {}) {
    notificationHandler = typeof handlers.onNotification === "function" ? handlers.onNotification : () => {};
    serverRequestHandler = typeof handlers.onServerRequest === "function" ? handlers.onServerRequest : null;
  }

  function close() {
    if (closed) return;
    closed = true;
    rejectPending(new Error("Codex app-server connection closed."));
    if (typeof onClose === "function") {
      try { onClose(new Error("Codex app-server connection closed.")); } catch { /* ignore close observers */ }
    }
    try { rl.close(); } catch { /* ignore */ }
    if (!child.killed) child.kill("SIGTERM");
  }

  return { child, close, request, setHandlers, isClosed: () => closed };
}

function codexApprovalTitle(method, params = {}) {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    return "Codex 想执行命令";
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return "Codex 想修改文件";
  }
  if (method === "item/permissions/requestApproval") return "Codex 请求扩展权限";
  if (method === "mcpServer/elicitation/request") return "Codex 想使用 MCP 工具";
  return "Codex 请求权限";
}

function codexMcpToolName(params = {}) {
  const server = String(params.serverName || params.server || "").trim();
  const message = String(params.message || "");
  const match = message.match(/tool\s+"([^"]+)"/i);
  const tool = String(params.tool || params._meta?.tool || match?.[1] || "").trim();
  return [server, tool].filter(Boolean).join(".") || "mcp";
}

function codexApprovalInput(method, params = {}) {
  if (method === "item/commandExecution/requestApproval") {
    return { command: params.command || "", cwd: params.cwd || "", reason: params.reason || "" };
  }
  if (method === "execCommandApproval") {
    return { command: Array.isArray(params.command) ? params.command.join(" ") : "", cwd: params.cwd || "", reason: params.reason || "" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { path: params.grantRoot || params.itemId || "", reason: params.reason || "" };
  }
  if (method === "applyPatchApproval") {
    return { path: params.grantRoot || Object.keys(params.fileChanges || {}).join(","), reason: params.reason || "" };
  }
  if (method === "item/permissions/requestApproval") {
    return { cwd: params.cwd || "", reason: params.reason || "", permissions: params.permissions || {} };
  }
  if (method === "mcpServer/elicitation/request") {
    return {
      serverName: params.serverName || "",
      toolName: codexMcpToolName(params),
      params: params._meta?.tool_params || {}
    };
  }
  return params;
}

function codexApprovalPreview(method, params = {}) {
  if (method === "item/commandExecution/requestApproval") return String(params.command || "");
  if (method === "execCommandApproval") return Array.isArray(params.command) ? params.command.join(" ") : "";
  if (method === "applyPatchApproval") {
    return Object.entries(params.fileChanges || {})
      .map(([filePath, change]) => `${change?.kind || "update"} ${filePath}`)
      .join("\n");
  }
  if (method === "item/fileChange/requestApproval") return String(params.grantRoot || params.reason || params.itemId || "");
  if (method === "item/permissions/requestApproval") return JSON.stringify(params.permissions || {}, null, 2);
  if (method === "mcpServer/elicitation/request") {
    const toolParams = params._meta?.tool_params || {};
    return Object.keys(toolParams).length ? JSON.stringify(toolParams, null, 2) : String(params.message || "");
  }
  return "";
}

function codexToolName(method) {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") return "shell";
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") return "apply_patch";
  if (method === "item/permissions/requestApproval") return "request_permissions";
  return "codex_tool";
}

function isCodexApprovalRequest(method) {
  return /Approval$|requestApproval$/.test(String(method || ""))
    || method === "mcpServer/elicitation/request";
}

function codexDecisionFor(method, decision) {
  const allowed = decision?.decision === "allow";
  const always = allowed && decision.scope === "always";
  if (method === "mcpServer/elicitation/request") {
    return allowed ? { action: "accept", content: {} } : { action: "decline" };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: allowed ? (always ? "approved_for_session" : "approved") : "denied" };
  }
  if (method === "item/commandExecution/requestApproval") {
    return { decision: allowed ? (always ? "acceptForSession" : "accept") : "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: allowed ? (always ? "acceptForSession" : "accept") : "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    const permissions = allowed && decision?.requestPermissions ? decision.requestPermissions : {};
    return { permissions, scope: always ? "session" : "turn" };
  }
  return {};
}

const codexAppServerRuntimePool = new Map();

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableJsonValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function codexRuntimePoolKey({ reuseKey = "", codexPath = "", env = {}, configOverrides = [] } = {}) {
  const key = String(reuseKey || "").trim();
  if (!key) return "";
  return JSON.stringify(stableJsonValue({
    key,
    codexPath,
    env,
    configOverrides
  }));
}

function deleteCodexRuntimeEntry(poolKey) {
  if (!poolKey) return;
  codexAppServerRuntimePool.delete(poolKey);
}

function closeCodexRuntimeEntry(entry) {
  if (!entry) return;
  deleteCodexRuntimeEntry(entry.poolKey);
  try { entry.connection?.close?.(); } catch { /* ignore close failures */ }
}

function getCodexRuntimeEntry(poolKey, options) {
  const existing = codexAppServerRuntimePool.get(poolKey);
  if (existing && !existing.connection.isClosed()) return existing;
  if (existing) deleteCodexRuntimeEntry(poolKey);
  const entry = {
    poolKey,
    initialized: null,
    queue: Promise.resolve(),
    connection: null
  };
  entry.connection = createCodexAppServerConnection({
    ...options,
    onClose: () => deleteCodexRuntimeEntry(poolKey)
  });
  codexAppServerRuntimePool.set(poolKey, entry);
  return entry;
}

function enqueueCodexRuntime(entry, run) {
  const previous = entry.queue.catch(() => {});
  const current = previous.then(run);
  entry.queue = current.catch(() => {});
  return current;
}

function closeCodexAppServerRuntimes() {
  for (const entry of codexAppServerRuntimePool.values()) {
    closeCodexRuntimeEntry(entry);
  }
  codexAppServerRuntimePool.clear();
}

async function runCodexAppServerTurn({
  codexPath,
  env,
  baseUrl = "",
  apiKey = "",
  threadId = "",
  prompt,
  options = {},
  signal = null,
  emit = null,
  permissionCoordinator = null,
  botId = "",
  sessionId = "",
  mcpServers = {},
  spawn = defaultSpawn,
  reuseKey = "",
  appendLog = () => {}
} = {}) {
  const startedAt = Date.now();
  let lastMarkAt = startedAt;
  const textByItem = new Map();
  const toolPreviewById = new Map();
  let activeThreadId = String(threadId || "");
  let activeTurnId = "";
  let finalResponse = "";
  let completedTurn = null;
  const workspaceDiffTracker = createWorkspaceDiffTracker(options.workingDirectory || "");
  let doneResolve;
  let doneReject;
  const done = new Promise((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });

  function mark(label) {
    const now = Date.now();
    appendLog(`[codex-app-server] ${label}: +${now - lastMarkAt}ms total=${now - startedAt}ms`);
    lastMarkAt = now;
  }

  function emitTool(kind, item) {
    if (typeof emit !== "function") return;
    const payload = toolPayloadFromCodexItem(item);
    if (!payload) return;
    if (kind === "tool_call_started") {
      toolPreviewById.set(payload.id, payload.preview || "");
      emit(kind, payload);
      return;
    }
    const preview = payload.preview || toolPreviewById.get(payload.id) || "";
    emit(kind, { ...payload, preview });
  }

  function emitFileEdits(item) {
    if (typeof emit !== "function") return;
    const payloads = item?.type === "commandExecution"
      ? workspaceDiffTracker.collect({
          idPrefix: String(item.id || "command"),
          status: item.status === "failed" ? "failed" : "completed",
          error: item.status === "failed"
        })
      : fileEditPayloadsFromCodexItem(item);
    for (const payload of payloads) {
      emit("file_edit", payload);
    }
  }

  function onNotification(message) {
    const method = message.method;
    const params = message.params || {};
    if (!onNotification.seenFirst) {
      onNotification.seenFirst = true;
      mark(`first notification ${method}`);
    }
    if (method === "thread/started") {
      activeThreadId = params.thread?.id || params.threadId || activeThreadId;
      if (typeof emit === "function" && activeThreadId) emit("session_started", { sessionId: activeThreadId });
      return;
    }
    if (method === "turn/started") {
      activeTurnId = params.turn?.id || params.turnId || activeTurnId;
      return;
    }
    if (method === "item/started") {
      emitTool("tool_call_started", params.item);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const id = String(params.itemId || "agent_message");
      const text = String(params.delta || "");
      if (text && !onNotification.seenFirstText) {
        onNotification.seenFirstText = true;
        mark("first text delta");
      }
      textByItem.set(id, `${textByItem.get(id) || ""}${text}`);
      finalResponse = textByItem.get(id) || finalResponse;
      if (typeof emit === "function" && text) emit("text_delta", { id, text });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      if (typeof emit === "function") emit("reasoning_delta", {
        id: String(params.itemId || "reasoning"),
        text: String(params.delta || "")
      });
      return;
    }
    if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
      const id = String(params.itemId || "");
      const next = `${toolPreviewById.get(id) || ""}${String(params.delta || "")}`.slice(-4000);
      toolPreviewById.set(id, next);
      if (typeof emit === "function") emit("tool_call_delta", { id, name: "", preview: next });
      return;
    }
    if (method === "item/completed") {
      const item = params.item || {};
      if (item.type === "agentMessage") finalResponse = String(item.text || finalResponse || "");
      emitTool("tool_call_completed", item);
      emitFileEdits(item);
      return;
    }
    if (method === "turn/completed") {
      completedTurn = params.turn || {};
      finalResponse = finalTextFromTurn(completedTurn) || finalResponse;
      if (typeof emit === "function") emit("complete", { finishReason: "stop" });
      mark("turn completed");
      doneResolve({ finalResponse, items: completedTurn.items || [], usage: null, threadId: activeThreadId });
    }
  }

  async function onServerRequest(message) {
    const method = message.method;
    const params = message.params || {};
    if (!isCodexApprovalRequest(method)) {
      throw new Error(`Unsupported Codex server request: ${method}`);
    }
    if (method === "mcpServer/elicitation/request" && isForbiddenSchedulerToolName(codexMcpToolName(params))) {
      return codexDecisionFor(method, { decision: "deny" });
    }
    if (!permissionCoordinator || typeof permissionCoordinator.requestPermission !== "function") {
      return codexDecisionFor(method, { decision: "deny" });
    }
    const input = codexApprovalInput(method, params);
    const decision = await permissionCoordinator.requestPermission({
      engine: "codex",
      botId,
      sessionId,
      signal,
      emit,
      toolName: method === "mcpServer/elicitation/request" ? codexMcpToolName(params) : codexToolName(method),
      title: codexApprovalTitle(method, params),
      description: String(params.reason || params._meta?.tool_description || params.message || ""),
      preview: codexApprovalPreview(method, params),
      input
    });
    return codexDecisionFor(method, {
      ...decision,
      requestPermissions: params.permissions ? {
        ...(params.permissions.network ? { network: params.permissions.network } : {}),
        ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {})
      } : null
    });
  }

  const managedEnv = { ...(env || {}) };
  if (apiKey) managedEnv.CODEX_API_KEY = String(apiKey);
  const configOverrides = [];
  if (shouldUseCodexChatGptHttpsProvider({ baseUrl, apiKey, env: managedEnv, options })) {
    configOverrides.push(...codexChatGptHttpsProviderOverrides());
  }
  configOverrides.push(...codexConfigOverridesForMcpServers(mcpServers));
  if (baseUrl) configOverrides.push(`openai_base_url=${tomlString(baseUrl)}`);

  const initializeParams = {
    clientInfo: { name: "mia", title: "Mia", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false }
  };

  async function executeTurn(connection, poolEntry = null) {
    connection.setHandlers?.({ onNotification, onServerRequest });
    const onAbort = () => {
      connection.request("turn/interrupt", { threadId: activeThreadId, turnId: activeTurnId }).catch(() => {});
      if (poolEntry) closeCodexRuntimeEntry(poolEntry);
      else connection.close();
      doneReject(stoppedError());
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      if (poolEntry) {
        if (!poolEntry.initialized) {
          poolEntry.initialized = connection.request("initialize", initializeParams);
          await poolEntry.initialized;
          mark("initialize");
        } else {
          await poolEntry.initialized;
          mark("initialize cached");
        }
      } else {
        await connection.request("initialize", initializeParams);
        mark("initialize");
      }
      return await runInitializedTurn(connection);
    } catch (error) {
      if (poolEntry) closeCodexRuntimeEntry(poolEntry);
      throw error;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      connection.setHandlers?.({});
      if (!poolEntry) connection.close();
    }
  }

  async function runInitializedTurn(connection) {
    const permissionProfile = String(options.permissionProfile || "").trim();
    const hasApprovalPolicy = Object.prototype.hasOwnProperty.call(options, "approvalPolicy")
      && options.approvalPolicy !== null
      && options.approvalPolicy !== "";
    const common = {
      model: options.model || null,
      cwd: options.workingDirectory || null,
      approvalsReviewer: "user",
      config: permissionProfile ? { default_permissions: permissionProfile } : null,
      serviceName: "Mia",
      ephemeral: false
    };
    if (hasApprovalPolicy) common.approvalPolicy = options.approvalPolicy;
    if (!permissionProfile) {
      if (!hasApprovalPolicy) common.approvalPolicy = "untrusted";
      common.sandbox = options.sandboxMode || "workspace-write";
    }
    if (activeThreadId) {
      const resumed = await connection.request("thread/resume", { threadId: activeThreadId, ...common });
      activeThreadId = resumed?.thread?.id || activeThreadId;
      mark("thread/resume");
    } else {
      const started = await connection.request("thread/start", common);
      activeThreadId = started?.thread?.id || "";
      if (typeof emit === "function" && activeThreadId) emit("session_started", { sessionId: activeThreadId });
      mark("thread/start");
    }
    const turnParams = {
      threadId: activeThreadId,
      input: [{ type: "text", text: String(prompt || ""), text_elements: [] }],
      model: options.model || null,
      effort: options.modelReasoningEffort || null,
      approvalsReviewer: "user"
    };
    if (hasApprovalPolicy) turnParams.approvalPolicy = options.approvalPolicy;
    if (!permissionProfile) {
      if (!hasApprovalPolicy) turnParams.approvalPolicy = "untrusted";
    }
    const startedTurn = await connection.request("turn/start", turnParams);
    activeTurnId = startedTurn?.turn?.id || activeTurnId;
    mark("turn/start response");
    if (startedTurn?.turn?.status === "completed") {
      completedTurn = startedTurn.turn;
      finalResponse = finalTextFromTurn(completedTurn) || finalResponse;
      if (typeof emit === "function") emit("complete", { finishReason: "stop" });
      doneResolve({ finalResponse, items: completedTurn.items || [], usage: null, threadId: activeThreadId });
    } else if (startedTurn?.turn?.status === "failed") {
      doneReject(new Error(startedTurn.turn.error?.message || "Codex turn failed."));
    }
    const result = await done;
    return result;
  }

  const pooledKey = codexRuntimePoolKey({
    reuseKey,
    codexPath,
    env: managedEnv,
    configOverrides
  });
  if (pooledKey) {
    const entry = getCodexRuntimeEntry(pooledKey, {
      codexPath,
      env: managedEnv,
      configOverrides,
      spawn,
      appendLog
    });
    return enqueueCodexRuntime(entry, () => executeTurn(entry.connection, entry));
  }

  const connection = createCodexAppServerConnection({
    codexPath,
    env: managedEnv,
    configOverrides,
    spawn,
    appendLog,
    onNotification,
    onServerRequest
  });
  return executeTurn(connection);
}

module.exports = {
  codexConfigOverridesForMcpServers,
  codexDecisionFor,
  closeCodexAppServerRuntimes,
  createCodexAppServerConnection,
  isCodexApprovalRequest,
  runCodexAppServerTurn,
  sandboxPolicy,
  fileEditPayloadsFromCodexItem,
  toolPayloadFromCodexItem
};
