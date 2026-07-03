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

function openClawArgsWithMiaRuntime(args = [], env = {}) {
  const next = Array.isArray(args) ? args.slice() : [];
  const profile = String(env.MIA_OPENCLAW_PROFILE || "").trim();
  if (profile && !next.includes("--profile")) {
    next.unshift("--profile", profile);
  }
  const gatewayUrl = String(env.MIA_OPENCLAW_GATEWAY_URL || "").trim();
  if (gatewayUrl && !next.includes("--url")) {
    next.push("--url", gatewayUrl);
  }
  const gatewayTokenFile = String(env.MIA_OPENCLAW_GATEWAY_TOKEN_FILE || "").trim();
  if (gatewayTokenFile && !next.includes("--token") && !next.includes("--token-file")) {
    next.push("--token-file", gatewayTokenFile);
  }
  return next;
}

async function defaultCreateTransport(options = {}) {
  const sdk = await importAcpSdk();
  const engineSpec = options.engineSpec || {};
  const sessionKey = String(options.sessionKey || "").trim();
  const engineArgs = engineSpec?.engineId === "openclaw"
    ? openClawArgsWithMiaRuntime(engineSpec.args, options.env || {})
    : (Array.isArray(engineSpec.args) ? engineSpec.args : []);
  const spawnEngineSpec = engineSpec?.engineId === "openclaw" && sessionKey
    ? { ...engineSpec, args: [...engineArgs, "--session", sessionKey] }
    : (engineSpec?.engineId === "openclaw" ? { ...engineSpec, args: engineArgs } : engineSpec);
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

class AcpAgentSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.engineSpec = options.engineSpec || null;
    this.sessionKey = String(options.sessionKey || "").trim();
    this.workspacePath = String(options.workspacePath || "").trim();
    this.conversationId = String(options.conversationId || "").trim();
    this.engineId = assertKnownAgentEngine(options.engineId || options.engineSpec?.engineId || "");
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
    this.acpSessionId = "";
    this.closed = false;
    this.activePrompt = null;
    this.toolTitles = new Map();
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
        await raceTransportStartup(this.transport, this.client.initialize({
          protocolVersion: sdk.PROTOCOL_VERSION || 1,
          clientCapabilities: {},
          clientInfo: {
            name: "mia-agent-session-acp-client",
            version: "1.0.0"
          }
        }));
      }
      const session = await raceTransportStartup(this.transport, this.client.newSession({
        cwd: this.workspacePath,
        mcpServers: this.mcpServers,
        _meta: {
          sessionKey: this.sessionKey,
          conversationId: this.conversationId,
          engineId: this.engineId,
          initializationMetadata: this.initializationMetadata
        }
      }));
      this.acpSessionId = String(session?.sessionId || "").trim();
      if (!this.acpSessionId) {
        throw new Error("ACP session did not return a sessionId.");
      }
      this.pendingInitialPromptPrefix = Boolean(this.initialPromptPrefix);
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

    this.toolTitles.clear();
    this.activePrompt = { turnId, cancelled: false };
    this.emit("message-started", buildBaseEvent(this, turnId ? { turnId } : {}));

    try {
      const response = await this.client.prompt(promptRequest);
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
    const update = params.update && typeof params.update === "object"
      ? params.update
      : params;
    const normalized = normalizeAcpSessionUpdate({
      turnId: this.activePrompt?.turnId || "",
      update,
      toolTitles: this.toolTitles
    });
    for (const event of normalized) {
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
    return createPermissionFallback(params);
  }
}

function createAcpAgentSession(options = {}) {
  return new AcpAgentSession(options);
}

module.exports = Object.freeze({
  AcpAgentSession,
  createAcpAgentSession,
  createPermissionFallback,
  defaultCreateClient,
  defaultCreateTransport,
  importAcpSdk,
  openClawArgsWithMiaRuntime,
  promptCancelledError
});
