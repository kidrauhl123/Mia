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

  return [normalizedWorkspacePath, normalizedEngineId, normalizedConversationId].join("::");
}

function createAcceptedInputResult(input, maybeDetails = {}) {
  const options = typeof input === "string" ? { ...maybeDetails, mode: input } : { ...(input || {}) };
  const mode = String(options.mode || "").trim();
  const conversationId = String(options.conversationId || "").trim();
  const engineId = assertKnownAgentEngine(options.engineId);
  const turnId = String(options.turnId || "").trim();

  if (!conversationId) throw new Error("conversationId is required.");
  if (!turnId) throw new Error("turnId is required.");

  if (mode === "started") {
    return Object.freeze({ ok: true, mode, conversationId, engineId, turnId });
  }

  if (mode === "queued") {
    const queueDepth = Number(options.queueDepth);
    if (!Number.isInteger(queueDepth) || queueDepth < 0) {
      throw new Error("queueDepth is required.");
    }
    return Object.freeze({ ok: true, mode, conversationId, engineId, turnId, queueDepth });
  }

  if (mode === "steered") {
    if (options.after !== "next-tool-call") {
      throw new Error("after must be next-tool-call.");
    }
    return Object.freeze({
      ok: true,
      mode,
      conversationId,
      engineId,
      turnId,
      after: "next-tool-call"
    });
  }

  throw new Error(`Unknown accepted input mode: ${mode}`);
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
