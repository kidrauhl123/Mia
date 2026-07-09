const { EventEmitter } = require("node:events");

const {
  AGENT_SESSION_EVENT_KINDS,
  ENGINE_SPECS,
  createAcceptedInputResult,
  createAgentSessionKey
} = require("./agent-session-contract.js");

const TERMINAL_MESSAGE_EVENTS = new Set([
  "message-completed",
  "message-cancelled",
  "message-failed"
]);

function indexEngineSpecs(engineSpecs) {
  const source = Array.isArray(engineSpecs) ? engineSpecs : ENGINE_SPECS;
  const indexed = new Map();
  for (const spec of source) {
    if (!spec || typeof spec !== "object") continue;
    indexed.set(spec.engineId, spec);
  }
  return indexed;
}

function mergeEngineSpec(baseSpec, overrideSpec) {
  if (!overrideSpec || typeof overrideSpec !== "object" || Array.isArray(overrideSpec)) return baseSpec || null;
  return {
    ...(baseSpec || {}),
    ...overrideSpec
  };
}

function getEventTurnId(payload = {}) {
  if (!payload || typeof payload !== "object") return null;
  const turnId = typeof payload.turnId === "string" ? payload.turnId.trim() : "";
  return turnId || null;
}

function getEventMessageId(payload = {}) {
  if (!payload || typeof payload !== "object") return null;
  const messageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
  return messageId || null;
}

class AgentSessionManager extends EventEmitter {
  constructor(options = {}) {
    super();

    if (typeof options.createSession !== "function") {
      throw new Error("createSession is required.");
    }

    this.createSessionFactory = options.createSession;
    this.engineSpecsById = indexEngineSpecs(options.engineSpecs);
    this.buildLocks = new Map();
    this.sessionsByKey = new Map();
    this.runningByKey = new Map();
    this.queuesByKey = new Map();
    this.loadNativeSessionId = typeof options.loadNativeSessionId === "function" ? options.loadNativeSessionId : null;
    this.saveNativeSessionId = typeof options.saveNativeSessionId === "function" ? options.saveNativeSessionId : null;
  }

  createSessionKey(descriptor = {}) {
    return createAgentSessionKey(descriptor);
  }

  async getOrCreateSession(descriptor = {}) {
    const sessionKey = this.createSessionKey(descriptor);
    if (this.sessionsByKey.has(sessionKey)) {
      return this.sessionsByKey.get(sessionKey);
    }
    if (this.buildLocks.has(sessionKey)) {
      return this.buildLocks.get(sessionKey);
    }

    const engineSpec = mergeEngineSpec(
      this.engineSpecsById.get(String(descriptor.engineId || "").trim()) || null,
      descriptor.engineSpec
    );
    const buildPromise = (async () => {
      const buildDescriptor = { ...descriptor };
      if (!buildDescriptor.nativeSessionId && this.loadNativeSessionId) {
        const nativeSessionId = String(await this.loadNativeSessionId(buildDescriptor) || "").trim();
        if (nativeSessionId) buildDescriptor.nativeSessionId = nativeSessionId;
      }
      const session = await this.createSessionFactory({
        ...buildDescriptor,
        sessionKey,
        engineSpec
      });
      this.sessionsByKey.set(sessionKey, session);
      this.attachSession(sessionKey, buildDescriptor, session);
      return session;
    })().finally(() => {
      this.buildLocks.delete(sessionKey);
    });

    this.buildLocks.set(sessionKey, buildPromise);
    return buildPromise;
  }

  async sendUserInput(input = {}) {
    const descriptor = this.getDescriptor(input);
    const sessionKey = this.createSessionKey(descriptor);
    const session = await this.getOrCreateSession(descriptor);
    const engineSpec = mergeEngineSpec(this.engineSpecsById.get(descriptor.engineId) || null, descriptor.engineSpec);
    const payload = this.getPayload(input);

    if (this.runningByKey.has(sessionKey)) {
      if (engineSpec?.supportsSteerInput) {
        await session.sendUserInput(payload);
        return createAcceptedInputResult({
          mode: "steered",
          conversationId: descriptor.conversationId,
          engineId: descriptor.engineId,
          turnId: payload.turnId,
          after: "next-tool-call"
        });
      }

      const queue = this.queuesByKey.get(sessionKey) || [];
      queue.push({ descriptor, payload });
      this.queuesByKey.set(sessionKey, queue);
      return createAcceptedInputResult({
        mode: "queued",
        conversationId: descriptor.conversationId,
        engineId: descriptor.engineId,
        turnId: payload.turnId,
        queueDepth: queue.length
      });
    }

    return this.startUserInput(sessionKey, descriptor, session, payload);
  }

  async cancelActive(descriptor = {}) {
    const sessionKey = this.createSessionKey(descriptor);
    const running = this.runningByKey.get(sessionKey);
    if (!running) return false;
    const session = await this.getOrCreateSession(descriptor);
    if (typeof session.cancel === "function") {
      await session.cancel();
    }
    return true;
  }

  async closeSession(descriptor = {}) {
    const sessionKey = this.createSessionKey(descriptor);
    return this.closeSessionByKey(sessionKey);
  }

  async closeAllSessions() {
    const sessionKeys = new Set([
      ...this.sessionsByKey.keys(),
      ...this.buildLocks.keys(),
      ...this.runningByKey.keys(),
      ...this.queuesByKey.keys()
    ]);

    await Promise.allSettled(
      Array.from(sessionKeys, (sessionKey) => this.closeSessionByKey(sessionKey))
    );
  }

  async closeAll() {
    return this.closeAllSessions();
  }

  async closeSessionByKey(sessionKey) {
    let session = this.sessionsByKey.get(sessionKey);
    if (!session && this.buildLocks.has(sessionKey)) {
      session = await this.buildLocks.get(sessionKey);
    }
    if (session && typeof session.kill === "function") {
      await session.kill();
    }
    this.sessionsByKey.delete(sessionKey);
    this.runningByKey.delete(sessionKey);
    this.queuesByKey.delete(sessionKey);
    this.buildLocks.delete(sessionKey);
  }

  getQueueSnapshot(sessionKey) {
    const queue = this.queuesByKey.get(sessionKey) || [];
    return queue.map((entry) => ({ ...entry.payload }));
  }

  getDescriptor(input = {}) {
    const descriptor = {
      conversationId: String(input.conversationId || "").trim(),
      engineId: String(input.engineId || "").trim(),
      workspacePath: String(input.workspacePath || "").trim()
    };
    const botId = String(input.botId || input.bot_id || "").trim();
    if (botId) descriptor.botId = botId;
    const nativeSessionId = String(input.nativeSessionId || input.native_session_id || input.acpSessionId || "").trim();
    if (nativeSessionId) descriptor.nativeSessionId = nativeSessionId;
    const runtimeKey = String(input.runtimeKey || input.runtime_key || "").trim();
    if (runtimeKey) descriptor.runtimeKey = runtimeKey;
    const mcpFingerprint = String(input.mcpFingerprint || input.mcp_fingerprint || "").trim();
    if (mcpFingerprint) descriptor.mcpFingerprint = mcpFingerprint;
    const skillFingerprint = String(input.skillFingerprint || input.skill_fingerprint || "").trim();
    if (skillFingerprint) descriptor.skillFingerprint = skillFingerprint;
    const permissionMode = String(input.permissionMode || input.permission_mode || "").trim();
    if (permissionMode) descriptor.permissionMode = permissionMode;
    if (input.env && typeof input.env === "object" && !Array.isArray(input.env)) {
      descriptor.env = { ...input.env };
    }
    if (input.engineSpec && typeof input.engineSpec === "object" && !Array.isArray(input.engineSpec)) {
      descriptor.engineSpec = { ...input.engineSpec };
    }
    if (Array.isArray(input.mcpServers)) {
      descriptor.mcpServers = input.mcpServers.slice();
    }
    if (typeof input.refreshMcpContext === "function") {
      descriptor.refreshMcpContext = input.refreshMcpContext;
    }
    if (typeof input.initialPromptPrefix === "string") {
      descriptor.initialPromptPrefix = input.initialPromptPrefix;
    }
    return descriptor;
  }

  getPayload(input = {}) {
    const payload = {};
    for (const [key, value] of Object.entries(input)) {
      if (
        key === "conversationId"
        || key === "botId"
        || key === "bot_id"
        || key === "engineId"
        || key === "workspacePath"
        || key === "nativeSessionId"
        || key === "native_session_id"
        || key === "acpSessionId"
        || key === "runtimeKey"
        || key === "runtime_key"
        || key === "mcpFingerprint"
        || key === "mcp_fingerprint"
        || key === "skillFingerprint"
        || key === "skill_fingerprint"
        || key === "permissionMode"
        || key === "permission_mode"
        || key === "env"
        || key === "engineSpec"
        || key === "mcpServers"
        || key === "refreshMcpContext"
        || key === "initialPromptPrefix"
      ) continue;
      payload[key] = value;
    }
    return payload;
  }

  attachSession(sessionKey, descriptor, session) {
    for (const eventKind of AGENT_SESSION_EVENT_KINDS) {
      if (typeof session.on !== "function") break;
      session.on(eventKind, (payload = {}) => {
        this.emit(eventKind, {
          conversationId: descriptor.conversationId,
          engineId: descriptor.engineId,
          workspacePath: descriptor.workspacePath,
          sessionKey,
          ...payload
        });

        if (eventKind === "message-started") {
          this.recordActiveMessageStart(sessionKey, payload);
        }

        if (eventKind === "session-started") {
          this.persistNativeSessionId(descriptor, payload);
        }

        if (TERMINAL_MESSAGE_EVENTS.has(eventKind)) {
          this.completeActiveRunFromTerminalEvent(sessionKey, payload);
        }

        if (eventKind === "session-closed") {
          this.sessionsByKey.delete(sessionKey);
          this.runningByKey.delete(sessionKey);
          this.queuesByKey.delete(sessionKey);
          this.buildLocks.delete(sessionKey);
        }
      });
    }
  }

  persistNativeSessionId(descriptor = {}, payload = {}) {
    if (!this.saveNativeSessionId) return;
    const nativeSessionId = String(payload.acpSessionId || payload.nativeSessionId || payload.sessionId || "").trim();
    if (!nativeSessionId) return;
    try {
      void Promise.resolve(this.saveNativeSessionId(descriptor, nativeSessionId)).catch(() => {});
    } catch {
      // Session persistence is best-effort; the active native session remains usable.
    }
  }

  async drainQueuedInput(sessionKey) {
    if (this.runningByKey.has(sessionKey)) return false;

    const queue = this.queuesByKey.get(sessionKey);
    if (!queue || queue.length === 0) return false;

    const next = queue.shift();
    if (queue.length === 0) {
      this.queuesByKey.delete(sessionKey);
    } else {
      this.queuesByKey.set(sessionKey, queue);
    }

    const session = await this.getOrCreateSession(next.descriptor);
    await this.startUserInput(sessionKey, next.descriptor, session, next.payload);
    return true;
  }

  async startUserInput(sessionKey, descriptor, session, payload) {
    let nativeSendPromise;
    try {
      nativeSendPromise = Promise.resolve(session.sendUserInput(payload));
    } catch (error) {
      return Promise.reject(error);
    }
    const activeRun = {
      turnId: payload.turnId,
      messageId: null,
      nativeSendPromise
    };
    this.runningByKey.set(sessionKey, activeRun);
    nativeSendPromise
      .finally(() => {
        this.completeActiveRunFromPromise(sessionKey, activeRun);
      })
      .catch(() => {});

    return createAcceptedInputResult({
      mode: "started",
      conversationId: descriptor.conversationId,
      engineId: descriptor.engineId,
      turnId: payload.turnId
    });
  }

  recordActiveMessageStart(sessionKey, payload = {}) {
    const running = this.runningByKey.get(sessionKey);
    if (!running) return;

    const eventTurnId = getEventTurnId(payload);
    if (eventTurnId && running.turnId !== eventTurnId) {
      return;
    }

    const eventMessageId = getEventMessageId(payload);
    if (!eventMessageId) return;
    running.messageId = eventMessageId;
  }

  completeActiveRunFromTerminalEvent(sessionKey, payload = {}) {
    const running = this.runningByKey.get(sessionKey);
    if (!running) return false;

    const eventTurnId = getEventTurnId(payload);
    const eventMessageId = getEventMessageId(payload);
    const matchesTurn = Boolean(eventTurnId && running.turnId === eventTurnId);
    const matchesMessage = Boolean(eventMessageId && running.messageId === eventMessageId);
    if (!matchesTurn && !matchesMessage) {
      return false;
    }

    this.runningByKey.delete(sessionKey);
    queueMicrotask(() => {
      void this.drainQueuedInput(sessionKey);
    });
    return true;
  }

  completeActiveRunFromPromise(sessionKey, activeRun) {
    if (this.runningByKey.get(sessionKey) !== activeRun) {
      return false;
    }

    this.runningByKey.delete(sessionKey);
    queueMicrotask(() => {
      void this.drainQueuedInput(sessionKey);
    });
    return true;
  }
}

function createAgentSessionManager(options = {}) {
  return new AgentSessionManager(options);
}

module.exports = Object.freeze({
  AgentSessionManager,
  TERMINAL_MESSAGE_EVENTS,
  createAgentSessionManager
});
