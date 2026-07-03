const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  prepareNativeTurnInput
} = require("../src/main/agent-session/native-input-policy.js");

test("prepareNativeTurnInput keeps only the current turn payload and session/bootstrap metadata fields", () => {
  const prepared = prepareNativeTurnInput({
    turnId: "turn-1",
    text: "Ship it",
    attachments: [{ id: "att-1", name: "error.log" }],
    fileReferences: [{ path: "/repo/README.md" }],
    workspacePath: "/repo",
    cwd: "/repo/app",
    sessionId: "acp-session-1",
    initializationMetadata: {
      systemPromptId: "native-default",
      developerFlags: ["sandboxed"]
    },
    ignored: "drop me"
  });

  assert.deepEqual(prepared, {
    turnId: "turn-1",
    text: "Ship it",
    attachments: [{ id: "att-1", name: "error.log" }],
    fileReferences: [{ path: "/repo/README.md" }],
    workspacePath: "/repo",
    cwd: "/repo/app",
    sessionId: "acp-session-1",
    initializationMetadata: {
      systemPromptId: "native-default",
      developerFlags: ["sandboxed"]
    }
  });
});

test("prepareNativeTurnInput rejects obvious visible-history keys", () => {
  for (const key of [
    "messages",
    "history",
    "conversationHistory",
    "previousMessages",
    "transcript",
    "assistantHistory",
    "priorUserMessages",
    "priorAssistantMessages"
  ]) {
    assert.throws(
      () => prepareNativeTurnInput({
        text: "Current turn only",
        [key]: [{ role: "user", content: "older text" }]
      }),
      /native input policy/i,
      `expected ${key} to be rejected`
    );
  }
});

test("prepareNativeTurnInput rejects role-array transcript replay under other keys", () => {
  assert.throws(
    () => prepareNativeTurnInput({
      text: "Current turn only",
      prompt: [
        { role: "system", content: "setup" },
        { role: "user", content: "older text" },
        { role: "assistant", content: "older reply" }
      ]
    }),
    /native input policy/i
  );
});
