const BOT_CONVERSATION_ENGINE_CONTRACT = "AgentSession";

const ENGINE_IDS = Object.freeze(["claude", "codex", "hermes", "openclaw"]);

const AGENT_SESSION_EVENT_KINDS = Object.freeze([
  "session-started",
  "message-started",
  "assistant-delta",
  "tool-call-started",
  "tool-call-delta",
  "tool-call-completed",
  "message-completed",
  "message-cancelled",
  "message-failed",
  "permission-requested",
  "session-closed"
]);

const AGENT_SESSION_STATUS = Object.freeze({
  Idle: "idle",
  Starting: "starting",
  Running: "running",
  Queued: "queued",
  Steered: "steered",
  Completed: "completed",
  Cancelled: "cancelled",
  Failed: "failed",
  Closed: "closed"
});

const ENGINE_SPECS = Object.freeze(
  ENGINE_IDS.map((engineId) =>
    Object.freeze({
      engineId,
      transport: "acp",
      displayName:
        engineId === "claude"
          ? "Claude Code"
          : engineId === "codex"
            ? "Codex"
            : engineId === "hermes"
              ? "Hermes"
              : "OpenClaw",
      supportsNativeSession: true,
      supportsQueuedInput: true,
      supportsSteerInput: false
    })
  )
);

function normalizeAgentEngineId(value) {
  const id = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (!id) return "";
  if (id === "claude" || id === "claude-code" || id === "claude-code-agent") return "claude";
  if (id === "codex" || id === "openai-codex" || id === "codex-cli") return "codex";
  if (id === "hermes" || id === "hermes-cli") return "hermes";
  if (id === "openclaw" || id === "open-claw") return "openclaw";
  return id;
}

function assertKnownAgentEngine(value) {
  const engineId = normalizeAgentEngineId(value);
  if (!ENGINE_IDS.includes(engineId)) {
    throw new Error(`Unknown AgentSession engine: ${String(value || "").trim()}`);
  }
  return engineId;
}

function createAgentSessionKey({ conversationId, engineId, workspacePath } = {}) {
  const normalizedConversationId = String(conversationId || "").trim();
  const normalizedWorkspacePath = String(workspacePath || "").trim();
  const normalizedEngineId = assertKnownAgentEngine(engineId);

  if (!normalizedConversationId) throw new Error("conversationId is required.");
  if (!normalizedWorkspacePath) throw new Error("workspacePath is required.");

  return [normalizedConversationId, normalizedEngineId, normalizedWorkspacePath].join("::");
}

function createAcceptedInputResult(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Accepted input result must be an object.");
  }

  const { mode, conversationId, engineId, turnId } = options;
  const ownKeys = Object.keys(options).sort();

  if (typeof mode !== "string" || !mode.trim()) {
    throw new Error("mode is required.");
  }
  if (typeof conversationId !== "string" || !conversationId.trim()) {
    throw new Error("conversationId is required.");
  }
  if (typeof turnId !== "string" || !turnId.trim()) {
    throw new Error("turnId is required.");
  }
  if (typeof engineId !== "string" || !engineId.trim()) {
    throw new Error("engineId is required.");
  }

  const normalizedMode = mode.trim();
  const normalizedConversationId = conversationId.trim();
  const normalizedTurnId = turnId.trim();
  const normalizedEngineId = assertKnownAgentEngine(engineId);

  function hasExactKeys(expectedKeys) {
    if (ownKeys.length !== expectedKeys.length) {
      return false;
    }
    for (let index = 0; index < expectedKeys.length; index += 1) {
      if (ownKeys[index] !== expectedKeys[index]) {
        return false;
      }
    }
    return true;
  }

  if (normalizedMode === "started") {
    if (!hasExactKeys(["conversationId", "engineId", "mode", "turnId"])) {
      throw new Error("Unexpected accepted input fields for started mode.");
    }
    return Object.freeze({
      ok: true,
      mode: normalizedMode,
      conversationId: normalizedConversationId,
      engineId: normalizedEngineId,
      turnId: normalizedTurnId
    });
  }

  if (normalizedMode === "queued") {
    if (!hasExactKeys(["conversationId", "engineId", "mode", "queueDepth", "turnId"])) {
      throw new Error("Unexpected accepted input fields for queued mode.");
    }
    if (!Object.prototype.hasOwnProperty.call(options, "queueDepth")) {
      throw new Error("queueDepth is required.");
    }
    const { queueDepth } = options;
    if (!Number.isInteger(queueDepth) || queueDepth < 0) {
      throw new Error("queueDepth is required.");
    }
    return Object.freeze({
      ok: true,
      mode: normalizedMode,
      conversationId: normalizedConversationId,
      engineId: normalizedEngineId,
      turnId: normalizedTurnId,
      queueDepth
    });
  }

  if (normalizedMode === "steered") {
    if (!hasExactKeys(["after", "conversationId", "engineId", "mode", "turnId"])) {
      throw new Error("Unexpected accepted input fields for steered mode.");
    }
    if (options.after !== "next-tool-call") {
      throw new Error("after must be next-tool-call.");
    }
    return Object.freeze({
      ok: true,
      mode: normalizedMode,
      conversationId: normalizedConversationId,
      engineId: normalizedEngineId,
      turnId: normalizedTurnId,
      after: "next-tool-call"
    });
  }

  throw new Error(`Unknown accepted input mode: ${normalizedMode}`);
}

module.exports = Object.freeze({
  BOT_CONVERSATION_ENGINE_CONTRACT,
  ENGINE_IDS,
  ENGINE_SPECS,
  AGENT_SESSION_ENGINE_SPECS: ENGINE_SPECS,
  AGENT_SESSION_ENGINES: ENGINE_SPECS,
  AGENT_SESSION_EVENT_KINDS,
  AGENT_SESSION_STATUS,
  createAgentSessionKey,
  assertKnownAgentEngine,
  createAcceptedInputResult
});
