const { test } = require("node:test");
const assert = require("node:assert/strict");

const contract = require("../src/main/agent-session/agent-session-contract.js");

const ENGINE_IDS = ["claude", "codex", "hermes", "openclaw"];
const AGENT_SESSION_EVENT_KINDS = [
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
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return [];
}

function engineSpecFor(specs, engineId) {
  if (!specs) return null;
  if (Array.isArray(specs)) return specs.find((spec) => spec?.engineId === engineId) || null;
  return specs[engineId] || specs[engineId.replace(/-/g, "")] || null;
}

test("AgentSession contract exposes the normalized engine ids and runtime event kinds", () => {
  const ids = asArray(contract.ENGINE_IDS);
  const kinds = asArray(contract.AGENT_SESSION_EVENT_KINDS);
  const specs = contract.ENGINE_SPECS || contract.AGENT_SESSION_ENGINES || contract.AGENT_SESSION_ENGINE_SPECS;

  assert.deepEqual(ids, ENGINE_IDS);
  assert.deepEqual(kinds, AGENT_SESSION_EVENT_KINDS);
  assert.ok(specs, "expected AgentSession engine specs to be exported");

  for (const engineId of ENGINE_IDS) {
    const spec = engineSpecFor(specs, engineId);
    assert.ok(spec, `expected ${engineId} engine spec`);
    assert.equal(spec.engineId, engineId);
    assert.equal(spec.transport, "acp");
    assert.equal(typeof spec.displayName, "string");
    assert.equal(spec.displayName.trim().length > 0, true);
    assert.equal(spec.supportsNativeSession, true);
    assert.equal(typeof spec.supportsQueuedInput, "boolean");
    assert.equal(typeof spec.supportsSteerInput, "boolean");
  }

  assert.equal(new Set(ids).size, ENGINE_IDS.length);
  assert.equal(new Set(kinds).size, AGENT_SESSION_EVENT_KINDS.length);
});

test("createAgentSessionKey is stable and rejects missing values", () => {
  assert.equal(
    contract.createAgentSessionKey({
      conversationId: "conversation_1",
      engineId: "claude",
      workspacePath: "/repo"
    }),
    contract.createAgentSessionKey({
      conversationId: "conversation_1",
      engineId: "claude",
      workspacePath: "/repo"
    })
  );
  assert.notEqual(
    contract.createAgentSessionKey({
      conversationId: "conversation_1",
      engineId: "claude",
      workspacePath: "/repo"
    }),
    contract.createAgentSessionKey({
      conversationId: "conversation_2",
      engineId: "claude",
      workspacePath: "/repo"
    })
  );

  assert.throws(() => contract.createAgentSessionKey({ engineId: "claude", workspacePath: "/repo" }));
  assert.throws(() => contract.createAgentSessionKey({ conversationId: "conversation_1", workspacePath: "/repo" }));
  assert.throws(() => contract.createAgentSessionKey({ conversationId: "conversation_1", engineId: "claude" }));
});
