const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { Readable, Writable } = require("node:stream");

const { assertKnownAgentEngine } = require("./agent-session-contract.js");
const { normalizeAcpMcpServers } = require("./acp-mcp-servers.js");
const { normalizeAcpSessionUpdate } = require("./acp-event-normalizer.js");
const { spawnAcpEngineProcess } = require("./acp-engine-specs.js");
const { prepareNativeTurnInput } = require("./native-input-policy.js");

async function importAcpSdk() {
  return import("@agentclientprotocol/sdk");
}

function buildBaseEvent(session, payload = {}) {
  return {
    engineId: session.engineId,
    conversationId: session.conversationId,
    sessionKey: session.sessionKey,
    workspacePath: session.workspacePath,
    ...payload
  };
}

function promptCancelledError() {
  const error = new Error("ACP prompt cancelled.");
  error.code = "ACP_PROMPT_CANCELLED";
  return error;
}

function acpProcessStartupError(engineSpec = {}, errorOrExit = {}) {
  if (errorOrExit instanceof Error) {
    return errorOrExit;
  }
  const engineId = String(engineSpec.engineId || "unknown").trim() || "unknown";
  const command = String(engineSpec.command || "").trim() || engineId;
  const code = errorOrExit.code;
  const signal = errorOrExit.signal;
  const detail = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
  return new Error(`ACP engine ${engineId} command '${command}' exited before startup completed (${detail}).`);
}

function createTransportStartupError(child, engineSpec = {}) {
  if (!child || typeof child.once !== "function") return null;
  const startupError = new Promise((_resolve, reject) => {
    child.once("error", (error) => {
      reject(acpProcessStartupError(engineSpec, error));
    });
    child.once("exit", (code, signal) => {
      reject(acpProcessStartupError(engineSpec, { code, signal }));
    });
  });
  startupError.catch(() => {});
  return startupError;
}

async function raceTransportStartup(transport, promise) {
  const startupError = transport?.startupError;
  if (!startupError || typeof startupError.then !== "function") return promise;
  return Promise.race([promise, startupError]);
}

function createPermissionFallback(params = {}) {
  const options = Array.isArray(params.options) ? params.options : [];
  const rejectOnce = options.find((option) => String(option?.kind || "") === "reject_once");
  if (rejectOnce?.optionId) {
    return { outcome: { outcome: "selected", optionId: rejectOnce.optionId } };
  }
  const transientReject = options.find((option) => {
    const kind = String(option?.kind || "");
    return kind.includes("reject") && kind !== "reject_always";
  });
  if (transientReject?.optionId) {
    return { outcome: { outcome: "selected", optionId: transientReject.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function isAutoAllowPermissionMode(value = "") {
  const normalized = String(value || "").trim();
  return [
    ":danger-full-access",
    "danger-full-access",
    "full-access",
    "bypassPermissions",
    "yolo",
    "yoloNoSandbox",
    "off",
    "never"
  ].includes(normalized);
}

function createPermissionAutoApproval(params = {}) {
  const options = Array.isArray(params.options) ? params.options : [];
  const allowAlways = options.find((option) => String(option?.kind || "") === "allow_always");
  if (allowAlways?.optionId) {
    return { outcome: { outcome: "selected", optionId: allowAlways.optionId } };
  }
  const allowOnce = options.find((option) => String(option?.kind || "") === "allow_once");
  if (allowOnce?.optionId) {
    return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
  }
  const transientAllow = options.find((option) => {
    const kind = String(option?.kind || "");
    return kind.includes("allow") && kind !== "allow_never";
  });
  if (transientAllow?.optionId) {
    return { outcome: { outcome: "selected", optionId: transientAllow.optionId } };
  }
  return createPermissionFallback(params);
}

function acpPermissionEngineId(engineId = "") {
  const normalized = String(engineId || "").trim();
  return normalized === "claude" ? "claude-code" : normalized;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizedRawInput(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  return { input: value };
}

function previewForPermissionInput(input = {}) {
  const command = firstString(input.command, input.cmd, input.shellCommand, input.args);
  if (command) return command;
  try {
    return JSON.stringify(input, null, 2).slice(0, 4000);
  } catch {
    return String(input || "").slice(0, 4000);
  }
}

function buildPermissionCoordinatorRequest(session, params = {}) {
  const toolCall = params.toolCall || params.tool_call || {};
  const input = normalizedRawInput(
    toolCall.rawInput
    || toolCall.raw_input
    || params.input
    || params.rawInput
    || params.raw_input
  );
  const toolName = firstString(
    toolCall.title,
    toolCall.name,
    params.toolName,
    params.tool_name,
    toolCall.kind,
    params.tool
  ) || "tool";
  return {
    engine: acpPermissionEngineId(session.engineId),
    botId: session.botId,
    sessionId: session.conversationId,
    toolName,
    title: firstString(params.title, toolCall.title) || `${acpPermissionEngineId(session.engineId)} requests ${toolName}`,
    description: firstString(params.description, toolCall.description),
    preview: previewForPermissionInput(input),
    input,
    rawRequest: params
  };
}

function permissionDecisionOption(params = {}, decision = {}) {
  const options = Array.isArray(params.options) ? params.options : [];
  const rawDecision = String(decision?.decision || decision?.action || "").trim();
  const rawScope = String(decision?.scope || "").trim();
  const wantsAllow = rawDecision.startsWith("allow");
  const preferred = wantsAllow
    ? (rawScope === "always" || rawDecision === "allow_always" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"])
    : (rawScope === "always" || rawDecision === "reject_always" ? ["reject_always", "reject_once"] : ["reject_once", "reject_always"]);
  for (const kind of preferred) {
    const option = options.find((item) => String(item?.kind || "") === kind);
    if (option?.optionId) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return wantsAllow ? createPermissionAutoApproval(params) : createPermissionFallback(params);
}

async function defaultCreateTransport(options = {}) {
  const sdk = await importAcpSdk();
  const engineSpec = options.engineSpec || {};
  const spawnEngineSpec = {
    ...engineSpec,
    args: Array.isArray(engineSpec.args) ? engineSpec.args : []
  };
  const child = spawnAcpEngineProcess(
    options.spawnProcess || spawn,
    spawnEngineSpec,
    {
      cwd: options.workspacePath || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "inherit"]
    },
    {
      platform: options.platform,
      nodePath: options.nodePath
    }
  );
  if (!child?.stdin || !child?.stdout) {
    throw new Error("ACP transport requires stdio stdin/stdout.");
  }
  return {
    sdk,
    process: child,
    startupError: createTransportStartupError(child, spawnEngineSpec),
    stream: sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    async close() {
      try { child.stdin.end(); } catch {}
    },
    async kill() {
      try { child.kill(); } catch {}
    }
  };
}

async function defaultCreateClient(options = {}) {
  const sdk = options.transport?.sdk || await importAcpSdk();
  return new sdk.ClientSideConnection(() => ({
    sessionUpdate: options.onSessionUpdate,
    requestPermission: options.onPermissionRequest
  }), options.transport.stream);
}

function prependPromptPrefix(prefix = "", text = "") {
  const normalizedPrefix = String(prefix || "").trim();
  const normalizedText = typeof text === "string" ? text : "";
  return normalizedPrefix ? `${normalizedPrefix}\n\n${normalizedText}` : normalizedText;
}

function agentCapabilitiesFromInitialize(response = {}) {
  if (!response || typeof response !== "object") return {};
  const capabilities = response.agentCapabilities || response.agent_capabilities || {};
  return capabilities && typeof capabilities === "object" ? capabilities : {};
}

function supportsLoadSession(capabilities = {}) {
  return capabilities.loadSession === true || capabilities.load_session === true;
}

function supportsResumeSession(capabilities = {}) {
  const sessionCapabilities = capabilities.sessionCapabilities || capabilities.session_capabilities || {};
  if (!sessionCapabilities || typeof sessionCapabilities !== "object") return false;
  return Boolean(sessionCapabilities.resume);
}

function isAcpSessionNotFoundError(error) {
  const text = [
    error?.code,
    error?.message,
    error?.data?.code,
    error?.data?.message,
    error?.cause?.code,
    error?.cause?.message
  ].map((part) => String(part || "")).join(" ").toLowerCase();
  return (
    /session[_\s-]*not[_\s-]*found/.test(text)
    || (/session/.test(text) && /not\s+found/.test(text))
  );
}

class AcpAgentSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.engineSpec = options.engineSpec || null;
    this.sessionKey = String(options.sessionKey || "").trim();
    this.workspacePath = String(options.workspacePath || "").trim();
    this.conversationId = String(options.conversationId || "").trim();
    this.engineId = assertKnownAgentEngine(options.engineId || options.engineSpec?.engineId || "");
    this.botId = String(options.botId || options.bot_id || "").trim();
    this.permissionMode = String(options.permissionMode || options.permission_mode || "").trim();
    this.requestPermission = typeof options.requestPermission === "function" ? options.requestPermission : null;
    this.nativeSessionId = String(options.nativeSessionId || options.native_session_id || options.acpSessionId || "").trim();
    this.initializationMetadata = options.initializationMetadata && typeof options.initializationMetadata === "object"
      ? { ...options.initializationMetadata }
      : null;
    this.env = options.env && typeof options.env === "object" && !Array.isArray(options.env)
      ? { ...options.env }
      : null;
    this.mcpServers = normalizeAcpMcpServers(options.mcpServers);
    this.refreshMcpContext = typeof options.refreshMcpContext === "function" ? options.refreshMcpContext : null;
    this.initialPromptPrefix = typeof options.initialPromptPrefix === "string" ? options.initialPromptPrefix.trim() : "";
    this.pendingInitialPromptPrefix = false;
    this.createTransport = typeof options.createTransport === "function" ? options.createTransport : defaultCreateTransport;
    this.createClient = typeof options.createClient === "function" ? options.createClient : defaultCreateClient;
    this.spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;

    this.startPromise = null;
    this.transport = null;
    this.client = null;
    this.agentCapabilities = {};
    this.acpSessionId = "";
    this.closed = false;
    this.activePrompt = null;
    this.toolTitles = new Map();
    this.suppressSessionReplay = false;
  }

  sessionMetadata(extra = {}) {
    return {
      sessionKey: this.sessionKey,
      conversationId: this.conversationId,
      engineId: this.engineId,
      initializationMetadata: this.initializationMetadata,
      ...extra
    };
  }

  sessionSetupRequest(extraMeta = {}) {
    return {
      cwd: this.workspacePath,
      mcpServers: this.mcpServers,
      _meta: this.sessionMetadata(extraMeta)
    };
  }

  sessionResumeRequest(sessionId) {
    return {
      sessionId,
      ...this.sessionSetupRequest()
    };
  }

  buildPromptRequest(text, attachments = [], fileReferences = []) {
    const promptRequest = {
      sessionId: this.acpSessionId,
      prompt: [{ type: "text", text }]
    };
    if (attachments.length > 0 || fileReferences.length > 0) {
      promptRequest._meta = {
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(fileReferences.length > 0 ? { fileReferences } : {})
      };
    }
    return promptRequest;
  }

  resetAttemptBuffering() {
    if (!this.activePrompt) return;
    this.activePrompt.bufferedEvents = [];
    this.activePrompt.bufferAssistantText = "";
  }

  emitBufferedAttemptEvents() {
    const events = Array.isArray(this.activePrompt?.bufferedEvents)
      ? this.activePrompt.bufferedEvents.slice()
      : [];
    if (this.activePrompt) {
      this.activePrompt.bufferedEvents = [];
      this.activePrompt.bufferAssistantText = "";
    }
    for (const event of events) {
      this.emit(event.kind, buildBaseEvent(this, event.payload));
    }
  }

  discardBufferedAttemptEvents() {
    if (!this.activePrompt) return;
    this.activePrompt.bufferedEvents = [];
    this.activePrompt.bufferAssistantText = "";
  }

  emitSyntheticAssistantDelta(turnId = "", text = "") {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return;
    this.emit("assistant-delta", buildBaseEvent(this, {
      ...(turnId ? { turnId } : {}),
      text: normalizedText
    }));
  }

  async runPromptWithFallback(nativeTurn = {}, attachments = [], fileReferences = []) {
    const baseText = typeof nativeTurn.text === "string" ? nativeTurn.text : "";
    const basePrefix = typeof nativeTurn.turnPromptPrefix === "string" ? nativeTurn.turnPromptPrefix : "";
    const skillFallback = nativeTurn.skillFallback && typeof nativeTurn.skillFallback === "object"
      ? nativeTurn.skillFallback
      : null;

    if (!skillFallback) {
      const promptText = prependPromptPrefix(basePrefix, baseText);
      return this.client.prompt(this.buildPromptRequest(promptText, attachments, fileReferences));
    }

    const detectRequests = typeof skillFallback.detectRequests === "function"
      ? skillFallback.detectRequests
      : () => [];
    const materializePrompt = typeof skillFallback.materializePrompt === "function"
      ? skillFallback.materializePrompt
      : async () => "";
    const fallbackText = typeof skillFallback.fallbackText === "function"
      ? skillFallback.fallbackText
      : () => "";
    const maxRounds = Number.isInteger(skillFallback.maxRounds) && skillFallback.maxRounds >= 0
      ? skillFallback.maxRounds
      : 0;
    let requestedSkillIds = [];
    let promptPrefix = basePrefix;

    for (let round = 0; round <= maxRounds; round += 1) {
      this.toolTitles.clear();
      this.resetAttemptBuffering();
      const promptText = prependPromptPrefix(promptPrefix, baseText);
      const response = await this.client.prompt(this.buildPromptRequest(promptText, attachments, fileReferences));
      const assistantText = String(this.activePrompt?.bufferAssistantText || "");
      const loadRequests = detectRequests(assistantText);
      const nextRequests = loadRequests.filter((id) => !requestedSkillIds.includes(id));
      if (!nextRequests.length) {
        this.emitBufferedAttemptEvents();
        return response;
      }
      if (round >= maxRounds) {
        this.discardBufferedAttemptEvents();
        this.emitSyntheticAssistantDelta(this.activePrompt?.turnId || "", fallbackText(nextRequests));
        return response;
      }
      requestedSkillIds = [...requestedSkillIds, ...nextRequests];
      promptPrefix = String(await materializePrompt(requestedSkillIds) || "").trim();
      this.discardBufferedAttemptEvents();
    }

    return this.client.prompt(this.buildPromptRequest(prependPromptPrefix(basePrefix, baseText), attachments, fileReferences));
  }

  async start() {
    if (this.closed) {
      throw new Error("ACP session is closed.");
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      this.transport = await this.createTransport({
        engineSpec: this.engineSpec,
        sessionKey: this.sessionKey,
        workspacePath: this.workspacePath,
        conversationId: this.conversationId,
        engineId: this.engineId,
        ...(this.env ? { env: this.env } : {}),
        spawnProcess: this.spawnProcess
      });
      this.client = await raceTransportStartup(this.transport, this.createClient({
        transport: this.transport,
        engineSpec: this.engineSpec,
        sessionKey: this.sessionKey,
        workspacePath: this.workspacePath,
        conversationId: this.conversationId,
        engineId: this.engineId,
        onSessionUpdate: (params) => this.handleSessionUpdate(params),
        onPermissionRequest: (params) => this.handlePermissionRequest(params)
      }));
      if (typeof this.client.initialize === "function") {
        const sdk = this.transport?.sdk || await importAcpSdk();
        const initialized = await raceTransportStartup(this.transport, this.client.initialize({
          protocolVersion: sdk.PROTOCOL_VERSION || 1,
          clientCapabilities: {},
          clientInfo: {
            name: "mia-agent-session-acp-client",
            version: "1.0.0"
          }
        }));
        this.agentCapabilities = agentCapabilitiesFromInitialize(initialized);
      }
      const { session, restored } = await this.openAcpSession();
      this.acpSessionId = String(session?.sessionId || "").trim();
      if (!this.acpSessionId) {
        throw new Error("ACP session did not return a sessionId.");
      }
      this.pendingInitialPromptPrefix = Boolean(this.initialPromptPrefix && !restored);
      this.emit("session-started", buildBaseEvent(this, { acpSessionId: this.acpSessionId }));
      return session;
    })();

    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      const transport = this.transport;
      this.transport = null;
      this.client = null;
      this.acpSessionId = "";
      try { await transport?.close?.(); } catch {}
      try { await transport?.kill?.(); } catch {}
      throw error;
    }
  }

  async openAcpSession() {
    const nativeSessionId = String(this.nativeSessionId || "").trim();
    if (!nativeSessionId) {
      return this.openFreshAcpSession();
    }

    if (this.engineId === "claude") {
      try {
        const session = await raceTransportStartup(this.transport, this.client.newSession(this.sessionSetupRequest({
          claudeCode: {
            options: {
              resume: nativeSessionId
            }
          }
        })));
        return { session, restored: true };
      } catch (error) {
        if (isAcpSessionNotFoundError(error)) return this.openFreshAcpSession();
        throw error;
      }
    }

    if (supportsLoadSession(this.agentCapabilities)) {
      if (typeof this.client.loadSession !== "function") {
        throw new Error("ACP agent advertised session/load but the client does not expose loadSession.");
      }
      this.suppressSessionReplay = true;
      try {
        const session = await raceTransportStartup(this.transport, this.client.loadSession(this.sessionResumeRequest(nativeSessionId)));
        return {
          session: {
            ...(session && typeof session === "object" ? session : {}),
            sessionId: String(session?.sessionId || nativeSessionId).trim() || nativeSessionId
          },
          restored: true
        };
      } catch (error) {
        if (isAcpSessionNotFoundError(error)) return this.openFreshAcpSession();
        throw error;
      } finally {
        this.suppressSessionReplay = false;
      }
    }

    if (supportsResumeSession(this.agentCapabilities)) {
      if (typeof this.client.resumeSession !== "function") {
        throw new Error("ACP agent advertised session/resume but the client does not expose resumeSession.");
      }
      try {
        const session = await raceTransportStartup(this.transport, this.client.resumeSession(this.sessionResumeRequest(nativeSessionId)));
        return {
          session: {
            ...(session && typeof session === "object" ? session : {}),
            sessionId: String(session?.sessionId || nativeSessionId).trim() || nativeSessionId
          },
          restored: true
        };
      } catch (error) {
        if (isAcpSessionNotFoundError(error)) return this.openFreshAcpSession();
        throw error;
      }
    }

    return {
      session: { sessionId: nativeSessionId },
      restored: true
    };
  }

  async openFreshAcpSession() {
    const session = await raceTransportStartup(this.transport, this.client.newSession(this.sessionSetupRequest()));
    return { session, restored: false };
  }

  async sendUserInput(payload = {}) {
    if (this.activePrompt) {
      throw new Error("ACP session already has an active prompt.");
    }

    const nativeTurn = prepareNativeTurnInput(payload);
    if ("initializationMetadata" in nativeTurn) {
      throw new Error("initializationMetadata must be provided as session metadata when creating the ACP session.");
    }

    const turnId = typeof nativeTurn.turnId === "string" ? nativeTurn.turnId.trim() : "";
    try {
      await this.start();
    } catch (error) {
      this.emit("message-failed", buildBaseEvent(this, {
        ...(turnId ? { turnId } : {}),
        error
      }));
      throw error;
    }

    let text = typeof nativeTurn.text === "string" ? nativeTurn.text : "";
    await this.refreshMcpContextForTurn({ turnId, text });
    if (this.pendingInitialPromptPrefix && this.initialPromptPrefix) {
      this.pendingInitialPromptPrefix = false;
      text = `${this.initialPromptPrefix}\n\n${text}`;
    }
    const attachments = Array.isArray(nativeTurn.attachments) ? nativeTurn.attachments.slice() : [];
    const fileReferences = Array.isArray(nativeTurn.fileReferences) ? nativeTurn.fileReferences.slice() : [];

    this.toolTitles.clear();
    this.activePrompt = {
      turnId,
      cancelled: false,
      bufferedEvents: null,
      bufferAssistantText: ""
    };
    this.emit("message-started", buildBaseEvent(this, turnId ? { turnId } : {}));

    try {
      const response = await this.runPromptWithFallback({
        ...nativeTurn,
        text
      }, attachments, fileReferences);
      if (response?.stopReason === "cancelled") {
        const error = promptCancelledError();
        this.emit("message-cancelled", buildBaseEvent(this, turnId ? { turnId } : {}));
        throw error;
      }
      this.emit("message-completed", buildBaseEvent(this, {
        ...(turnId ? { turnId } : {}),
        ...(response?.stopReason ? { stopReason: response.stopReason } : {})
      }));
      return response;
    } catch (error) {
      if (error?.code === "ACP_PROMPT_CANCELLED") {
        throw error;
      }
      this.emit("message-failed", buildBaseEvent(this, {
        ...(turnId ? { turnId } : {}),
        error
      }));
      throw error;
    } finally {
      this.activePrompt = null;
    }
  }

  async cancel() {
    if (!this.client || !this.acpSessionId || !this.activePrompt) {
      return false;
    }
    this.activePrompt.cancelled = true;
    await this.client.cancel({ sessionId: this.acpSessionId });
    return true;
  }

  async refreshMcpContextForTurn({ turnId = "", text = "" } = {}) {
    if (!this.refreshMcpContext) return;
    try {
      await this.refreshMcpContext({
        engineId: this.engineId,
        conversationId: this.conversationId,
        sessionKey: this.sessionKey,
        workspacePath: this.workspacePath,
        acpSessionId: this.acpSessionId,
        turnId,
        text
      });
    } catch {
      // MCP context refresh is best-effort; the session still has the MCP tools.
    }
  }

  async kill() {
    if (this.closed) return;
    this.closed = true;
    this.activePrompt = null;
    await this.transport?.close?.();
    await this.transport?.kill?.();
    this.emit("session-closed", buildBaseEvent(this));
  }

  async handleSessionUpdate(params = {}) {
    if (this.suppressSessionReplay) return;
    const update = params.update && typeof params.update === "object"
      ? params.update
      : params;
    const normalized = normalizeAcpSessionUpdate({
      turnId: this.activePrompt?.turnId || "",
      update,
      toolTitles: this.toolTitles
    });
    for (const event of normalized) {
      if (Array.isArray(this.activePrompt?.bufferedEvents)) {
        if (event.kind === "assistant-delta" && typeof event.payload?.text === "string") {
          this.activePrompt.bufferAssistantText += event.payload.text;
        }
        this.activePrompt.bufferedEvents.push(event);
        continue;
      }
      this.emit(event.kind, buildBaseEvent(this, event.payload));
    }
  }

  async handlePermissionRequest(params = {}) {
    this.emit("permission-requested", buildBaseEvent(this, {
      ...(this.activePrompt?.turnId ? { turnId: this.activePrompt.turnId } : {}),
      request: params
    }));
    if (this.activePrompt?.cancelled) {
      return { outcome: { outcome: "cancelled" } };
    }
    if (isAutoAllowPermissionMode(this.permissionMode)) {
      return createPermissionAutoApproval(params);
    }
    if (this.requestPermission) {
      const request = buildPermissionCoordinatorRequest(this, params);
      const decision = await this.requestPermission({
        ...request,
        emit: (type, payload = {}) => {
          this.emit("permission-requested", buildBaseEvent(this, {
            ...(this.activePrompt?.turnId ? { turnId: this.activePrompt.turnId } : {}),
            event: {
              type,
              ...payload
            }
          }));
        }
      });
      return permissionDecisionOption(params, decision);
    }
    return createPermissionFallback(params);
  }
}

function createAcpAgentSession(options = {}) {
  return new AcpAgentSession(options);
}

module.exports = Object.freeze({
  AcpAgentSession,
  createAcpAgentSession,
  createPermissionAutoApproval,
  createPermissionFallback,
  defaultCreateClient,
  defaultCreateTransport,
  importAcpSdk,
  isAutoAllowPermissionMode,
  promptCancelledError
});
