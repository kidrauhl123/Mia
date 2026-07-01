const { test } = require("node:test");
const assert = require("node:assert/strict");
const { promptMessagesForNativeSession } = require("../src/main/agent-prompt-messages.js");

test("promptMessagesForNativeSession keeps only system and current user for native sessions", () => {
  const messages = [
    { role: "system", content: "system rules" },
    { role: "user", content: "old user" },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "hello" }
  ];

  assert.deepEqual(promptMessagesForNativeSession(messages, true), [
    { role: "system", content: "system rules" },
    { role: "user", content: "hello" }
  ]);
  assert.deepEqual(promptMessagesForNativeSession(messages, false), [
    { role: "system", content: "system rules" },
    { role: "user", content: "hello" }
  ]);
});
