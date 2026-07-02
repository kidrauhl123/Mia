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

    const engineSpec = this.engineSpecsById.get(String(descriptor.engineId || "").trim()) || null;
    const buildPromise = (async () => {
      const session = await this.createSessionFactory({
        ...descriptor,
        sessionKey,
        engineSpec
      });
      this.sessionsByKey.set(sessionKey, session);
      this.attachSession(sessionKey, descriptor, session);
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
    const engineSpec = this.engineSpecsById.get(descriptor.engineId) || null;
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
    return {
      conversationId: String(input.conversationId || "").trim(),
      engineId: String(input.engineId || "").trim(),
      workspacePath: String(input.workspacePath || "").trim()
    };
  }

  getPayload(input = {}) {
    const payload = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === "conversationId" || key === "engineId" || key === "workspacePath") continue;
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
    nativeSendPromise.finally(() => {
      this.completeActiveRunFromPromise(sessionKey, activeRun);
    });

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
