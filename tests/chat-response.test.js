const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  chatCompletionResponse,
  responseMessageContent
} = require("../src/main/chat-response.js");

test("chatCompletionResponse returns OpenAI-compatible response shape", () => {
  const response = chatCompletionResponse({
    id: "r1",
    model: "hermes-agent",
    content: "hello",
    finishReason: "stop",
    mia: { fellow_key: "alice" }
  });
  assert.equal(response.id, "r1");
  assert.equal(response.object, "chat.completion");
  assert.equal(response.model, "hermes-agent");
  assert.equal(response.choices[0].message.role, "assistant");
  assert.equal(response.choices[0].message.content, "hello");
  assert.equal(response.choices[0].finish_reason, "stop");
  assert.deepEqual(response.mia, { fellow_key: "alice" });
});

test("responseMessageContent trims assistant content", () => {
  assert.equal(responseMessageContent({
    choices: [{ message: { content: "  hi  " } }]
  }), "hi");
  assert.equal(responseMessageContent({}), "");
});

test("chatCompletionResponse carries structured command results", () => {
  const commandResult = { type: "session-list", rows: [{ id: "s1" }] };
  const response = chatCompletionResponse({
    id: "r2",
    model: "claude-code",
    content: "choose",
    commandResult,
    mia: { transport: "local-command" }
  });

  assert.deepEqual(response.choices[0].message.commandResult, commandResult);
  assert.deepEqual(response.mia.commandResult, commandResult);
  assert.equal(response.mia.transport, "local-command");
});
