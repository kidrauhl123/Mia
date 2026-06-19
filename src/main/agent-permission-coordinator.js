const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function stableJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function compactWhitespace(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) {
      const text = value.map((item) => String(item || "")).filter(Boolean).join(" ").trim();
      if (text) return text;
    }
  }
  return "";
}

function commandFromInput(input = {}) {
  return compactWhitespace(firstString(input.command, input.cmd, input.shellCommand, input.args));
}

function pathFromInput(input = {}) {
  return firstString(input.file_path, input.filePath, input.path, input.cwd, input.grantRoot);
}

function previewForInput(input = {}) {
  const command = commandFromInput(input);
  if (command) return command;
  const filePath = pathFromInput(input);
  if (filePath) return filePath;
  try {
    return JSON.stringify(input, null, 2).slice(0, 4000);
  } catch {
    return String(input || "").slice(0, 4000);
  }
}

function permissionEngineLabel(engine = "") {
  const normalized = String(engine || "").trim().toLowerCase();
  if (normalized === "codex") return "Codex";
  if (normalized === "claude-code") return "Claude Code";
  if (normalized === "openclaw") return "OpenClaw";
  if (normalized === "mcp") return "MCP";
  return String(engine || "").trim() || "Agent";
}

function isLikelyMcpToolName(toolName = "") {
  const value = String(toolName || "").trim();
  return value.includes(".") || /^mcp([:_./ -]|$)/i.test(value);
}

function formatMcpPermissionTitle({ engine = "", toolName = "" } = {}) {
  const tool = String(toolName || "MCP 工具").trim() || "MCP 工具";
  return `${permissionEngineLabel(engine)} 想使用 MCP 工具 ${tool}`;
}

function formatPermissionTitle({ engine = "", toolName = "", title = "" } = {}) {
  const explicit = compactWhitespace(title);
  if (explicit) return explicit;
  if (isLikelyMcpToolName(toolName)) {
    return formatMcpPermissionTitle({ engine, toolName });
  }
  const engineLabel = permissionEngineLabel(engine);
  const tool = String(toolName || "tool").trim() || "tool";
  return `${engineLabel} 请求使用 ${tool}`;
}

function ruleSubject(toolName, input = {}) {
  const tool = String(toolName || "").trim();
  const command = commandFromInput(input);
  if (command && /^(bash|shell|exec|command|commandexecution)$/i.test(tool.replace(/[^a-z]/gi, ""))) {
    return { type: "command", value: command, label: command };
  }
  if (command && /bash|shell|command|exec/i.test(tool)) {
    return { type: "command", value: command, label: command };
  }
  const filePath = pathFromInput(input);
  if (filePath && /read|write|edit|patch|file/i.test(tool)) {
    return { type: "path", value: filePath, label: filePath };
  }
  const json = stableJson(input);
  return {
    type: "input",
    value: sha1(json),
    label: previewForInput(input).slice(0, 160)
  };
}

function buildRule(request = {}) {
  const engine = String(request.engine || "").trim() || "agent";
  const toolName = String(request.toolName || request.tool || "").trim() || "tool";
  const subject = ruleSubject(toolName, request.input || {});
  return {
    id: sha1([engine, toolName, subject.type, subject.value].join("\n")).slice(0, 24),
    engine,
    toolName,
    subjectType: subject.type,
    subjectValue: subject.value,
    label: subject.label || toolName
  };
}

function normalizeStore(raw) {
  const store = raw && typeof raw === "object" ? raw : {};
  const rules = Array.isArray(store.rules) ? store.rules : [];
  return {
    version: 1,
    rules: rules.map((rule) => ({
      id: String(rule?.id || "").trim(),
      engine: String(rule?.engine || "").trim(),
      toolName: String(rule?.toolName || "").trim(),
      subjectType: String(rule?.subjectType || "").trim(),
      subjectValue: String(rule?.subjectValue || "").trim(),
      label: String(rule?.label || "").trim(),
      createdAt: String(rule?.createdAt || "").trim()
    })).filter((rule) => rule.id && rule.engine && rule.toolName && rule.subjectType && rule.subjectValue)
  };
}

function publicRequest(pending) {
  return {
    requestId: pending.requestId,
    engine: pending.engine,
    botId: pending.botId,
    sessionId: pending.sessionId,
    toolName: pending.toolName,
    title: pending.title,
    description: pending.description,
    preview: pending.preview,
    rule: pending.rule,
    createdAt: pending.createdAt
  };
}

function createAgentPermissionCoordinator(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const readJson = deps.readJson || ((filePath, fallback) => {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
  });
  const fsImpl = deps.fs || fs;
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const now = deps.now || (() => new Date().toISOString());
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Number(deps.timeoutMs) : 10 * 60 * 1000;
  const pending = new Map();

  function storePath() {
    const paths = runtimePaths();
    return paths.agentPermissionRules || path.join(paths.home, "mia-agent-permissions.json");
  }

  function loadStore() {
    return normalizeStore(readJson(storePath(), { version: 1, rules: [] }));
  }

  function saveStore(store) {
    const filePath = storePath();
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(normalizeStore(store), null, 2) + "\n", { mode: 0o600 });
    if (typeof fsImpl.chmodSync === "function") fsImpl.chmodSync(filePath, 0o600);
  }

  function rememberRule(rule) {
    const store = loadStore();
    const existing = store.rules.find((item) => item.id === rule.id);
    if (!existing) {
      store.rules.push({ ...rule, createdAt: now() });
      saveStore(store);
    }
    return existing || { ...rule, createdAt: now() };
  }

  function matchingRule(request) {
    const rule = buildRule(request);
    const store = loadStore();
    return store.rules.find((item) => item.id === rule.id) || null;
  }

  function emitPending(pendingRequest, kind, extra = {}) {
    if (typeof pendingRequest.emit !== "function") return;
    pendingRequest.emit(kind, {
      ...publicRequest(pendingRequest),
      ...extra
    });
  }

  function settle(pendingRequest, result) {
    if (!pending.has(pendingRequest.requestId)) return;
    pending.delete(pendingRequest.requestId);
    if (pendingRequest.abortHandler && pendingRequest.signal) {
      pendingRequest.signal.removeEventListener("abort", pendingRequest.abortHandler);
    }
    if (pendingRequest.timer) clearTimeout(pendingRequest.timer);
    emitPending(pendingRequest, "permission_resolved", {
      decision: result.decision,
      remembered: Boolean(result.remembered)
    });
    pendingRequest.resolve(result);
  }

  function requestPermission(request = {}) {
    const toolName = String(request.toolName || request.tool || "").trim() || "tool";
    const engine = String(request.engine || "").trim() || "agent";
    const input = request.input && typeof request.input === "object" ? request.input : {};
    const remembered = matchingRule({ ...request, engine, toolName, input });
    const rule = buildRule({ ...request, engine, toolName, input });
    if (remembered) {
      return Promise.resolve({
        decision: "allow",
        scope: "always",
        remembered: true,
        rule: remembered
      });
    }
    if (typeof request.emit !== "function") {
      return Promise.resolve({
        decision: "deny",
        scope: "once",
        message: "没有可用的权限审批界面。"
      });
    }

    const pendingRequest = {
      requestId: String(request.requestId || `perm_${randomUUID()}`),
      engine,
      botId: String(request.botId || "").trim(),
      sessionId: String(request.sessionId || "").trim(),
      toolName,
      title: formatPermissionTitle({ engine, toolName, title: request.title }),
      description: String(request.description || "").trim(),
      preview: String(request.preview || previewForInput(input)).trim(),
      input,
      rule,
      emit: request.emit,
      signal: request.signal || null,
      createdAt: now(),
      resolve: null,
      timer: null,
      abortHandler: null
    };

    const promise = new Promise((resolve) => {
      pendingRequest.resolve = resolve;
      pending.set(pendingRequest.requestId, pendingRequest);
      if (timeoutMs > 0) {
        pendingRequest.timer = setTimeout(() => {
          settle(pendingRequest, {
            decision: "deny",
            scope: "once",
            message: "权限审批超时。"
          });
        }, timeoutMs);
      }
      if (pendingRequest.signal) {
        pendingRequest.abortHandler = () => settle(pendingRequest, {
          decision: "deny",
          scope: "once",
          message: "权限请求已取消。"
        });
        if (pendingRequest.signal.aborted) {
          pendingRequest.abortHandler();
          return;
        }
        pendingRequest.signal.addEventListener("abort", pendingRequest.abortHandler, { once: true });
      }
      emitPending(pendingRequest, "permission_request");
      if (typeof request.emit === "function") {
        request.emit("status", { text: "等待权限审批…" });
      }
    });
    return promise;
  }

  function resolvePermission(payload = {}) {
    const requestId = String(payload.requestId || payload.id || "").trim();
    const pendingRequest = pending.get(requestId);
    if (!pendingRequest) return { ok: false, error: "permission request not found" };
    const rawDecision = String(payload.decision || payload.action || "").trim();
    const allowAlways = rawDecision === "allow_always" || rawDecision === "always";
    const allow = allowAlways || rawDecision === "allow_once" || rawDecision === "allow";
    if (allowAlways) rememberRule(pendingRequest.rule);
    settle(pendingRequest, {
      decision: allow ? "allow" : "deny",
      scope: allowAlways ? "always" : "once",
      remembered: allowAlways,
      rule: pendingRequest.rule,
      message: allow ? "" : "用户拒绝了工具权限。"
    });
    if (allowAlways) {
      for (const other of [...pending.values()]) {
        if (other.rule?.id !== pendingRequest.rule.id) continue;
        settle(other, {
          decision: "allow",
          scope: "always",
          remembered: true,
          rule: other.rule,
          message: ""
        });
      }
    }
    return { ok: true };
  }

  function listPending(filter = {}) {
    const sessionId = String(filter.sessionId || "").trim();
    return [...pending.values()]
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .map(publicRequest);
  }

  return {
    buildRule,
    listPending,
    loadStore,
    matchingRule,
    rememberRule,
    requestPermission,
    resolvePermission,
    saveStore
  };
}

module.exports = {
  buildRule,
  createAgentPermissionCoordinator,
  formatMcpPermissionTitle,
  formatPermissionTitle,
  stableJson
};
