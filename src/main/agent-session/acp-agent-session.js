const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { Readable, Writable } = require("node:stream");

const { assertKnownAgentEngine } = require("./agent-session-contract.js");
const { normalizeAcpSessionUpdate } = require("./acp-event-normalizer.js");

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

async function defaultCreateTransport(options = {}) {
  const sdk = await importAcpSdk();
  const child = (options.spawnProcess || spawn)(
    options.engineSpec?.command || "",
    Array.isArray(options.engineSpec?.args) ? options.engineSpec.args : [],
    {
      cwd: options.workspacePath || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "inherit"]
    }
  );
  if (!child?.stdin || !child?.stdout) {
    throw new Error("ACP transport requires stdio stdin/stdout.");
  }
  return {
    sdk,
    process: child,
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
        spawnProcess: this.spawnProcess
      });
      this.client = await this.createClient({
        transport: this.transport,
        engineSpec: this.engineSpec,
        sessionKey: this.sessionKey,
        workspacePath: this.workspacePath,
        conversationId: this.conversationId,
        engineId: this.engineId,
        onSessionUpdate: (params) => this.handleSessionUpdate(params),
        onPermissionRequest: (params) => this.handlePermissionRequest(params)
      });
      if (typeof this.client.initialize === "function") {
        const sdk = this.transport?.sdk || await importAcpSdk();
        await this.client.initialize({
          protocolVersion: sdk.PROTOCOL_VERSION || 1,
          clientCapabilities: {},
          clientInfo: {
            name: "mia-agent-session-acp-client",
            version: "1.0.0"
          }
        });
      }
      const session = await this.client.newSession({
        cwd: this.workspacePath,
        _meta: {
          sessionKey: this.sessionKey,
          conversationId: this.conversationId,
          engineId: this.engineId
        }
      });
      this.acpSessionId = String(session?.sessionId || "").trim();
      if (!this.acpSessionId) {
        throw new Error("ACP session did not return a sessionId.");
      }
      this.emit("session-started", buildBaseEvent(this, { acpSessionId: this.acpSessionId }));
      return session;
    })();

    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  async sendUserInput(payload = {}) {
    if (this.activePrompt) {
      throw new Error("ACP session already has an active prompt.");
    }

    await this.start();

    const turnId = typeof payload.turnId === "string" ? payload.turnId.trim() : "";
    const text = typeof payload.text === "string" ? payload.text : "";
    const attachments = Array.isArray(payload.attachments) ? payload.attachments.slice() : [];
    const promptRequest = {
      sessionId: this.acpSessionId,
      prompt: [{ type: "text", text }]
    };
    if (attachments.length > 0) {
      promptRequest._meta = { attachments };
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

  async kill() {
    if (this.closed) return;
    this.closed = true;
    this.activePrompt = null;
    await this.transport?.close?.();
    await this.transport?.kill?.();
    this.emit("session-closed", buildBaseEvent(this));
  }

  async handleSessionUpdate(params = {}) {
    const normalized = normalizeAcpSessionUpdate({
      turnId: this.activePrompt?.turnId || "",
      update: params.update || {},
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
  promptCancelledError
});
