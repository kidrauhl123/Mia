const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createChatEngineAdapters,
  createStatelessChatEngineAdapters,
  sendWithChatEngineAdapter,
  sendWithStatelessChatEngineAdapter
} = require("../src/main/chat-engine-adapters.js");
const { chatCompletionResponse } = require("../src/main/chat-response.js");

function createDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    chatCompletionResponse,
    commandId: () => "cmd_test",
    runExternalSlashCommand: (input) => {
      calls.push(["external-slash", input.engine, input.text]);
      return overrides.externalSlashResult ?? null;
    },
    runHermesSlashCommand: (input) => {
      calls.push(["hermes-slash", input.text]);
      return overrides.hermesSlashResult ?? "";
    },
    hermesSlashCommandResponse: (input) => {
      calls.push(["hermes-slash-response", input.id, input.content]);
      return { id: input.id, model: "hermes-agent", content: input.content };
    },
    ensureHermesReady: async () => {
      calls.push(["ensure-hermes"]);
    },
    sendClaudeCodeChat: async (context) => {
      calls.push(["send-claude", context.sessionId]);
      return { engine: "claude-code" };
    },
    sendCodexChat: async (context) => {
      calls.push(["send-codex", context.sessionId]);
      return { engine: "codex" };
    },
    sendHermesChat: async (context) => {
      calls.push(["send-hermes", context.sessionId]);
      return { engine: "hermes" };
    }
  };
}

const fellow = { key: "alice" };

test("claude adapter returns local slash command response without SDK call", async () => {
  const deps = createDeps({ externalSlashResult: "local help" });
  const adapters = createChatEngineAdapters(deps);
  const response = await adapters["claude-code"].send({
    fellow,
    sessionId: "s1",
    slashText: "/help"
  });

  assert.equal(response.id, "cmd_test");
  assert.equal(response.model, "claude-code");
  assert.equal(response.choices[0].message.content, "local help");
  assert.deepEqual(response.aimashi, {
    transport: "local-command",
    engine: "claude-code",
    fellow_key: "alice"
  });
  assert.deepEqual(deps.calls, [["external-slash", "claude-code", "/help"]]);
});

test("codex adapter falls through to SDK call when slash is not local", async () => {
  const deps = createDeps({ externalSlashResult: null });
  const adapters = createChatEngineAdapters(deps);
  const response = await adapters.codex.send({
    fellow,
    sessionId: "s2",
    slashText: "/unknown"
  });

  assert.deepEqual(response, { engine: "codex" });
  assert.deepEqual(deps.calls, [
    ["external-slash", "codex", "/unknown"],
    ["send-codex", "s2"]
  ]);
});

test("hermes adapter starts runtime before local slash command", async () => {
  const deps = createDeps({ hermesSlashResult: "settings saved" });
  const adapters = createChatEngineAdapters(deps);
  const response = await adapters.hermes.send({
    fellow,
    sessionId: "s3",
    slashText: "/model"
  });

  assert.deepEqual(response, {
    id: "cmd_test",
    model: "hermes-agent",
    content: "settings saved"
  });
  assert.deepEqual(deps.calls, [
    ["ensure-hermes"],
    ["hermes-slash", "/model"],
    ["hermes-slash-response", "cmd_test", "settings saved"]
  ]);
});

test("hermes adapter starts runtime before normal run", async () => {
  const deps = createDeps();
  const adapters = createChatEngineAdapters(deps);
  const response = await adapters.hermes.send({
    fellow,
    sessionId: "s4",
    slashText: ""
  });

  assert.deepEqual(response, { engine: "hermes" });
  assert.deepEqual(deps.calls, [
    ["ensure-hermes"],
    ["send-hermes", "s4"]
  ]);
});

test("sendWithChatEngineAdapter falls back to hermes adapter", async () => {
  const deps = createDeps();
  const adapters = createChatEngineAdapters(deps);
  const response = await sendWithChatEngineAdapter(adapters, {
    chatEngine: { id: "unknown" },
    fellow,
    sessionId: "s5",
    slashText: ""
  });

  assert.deepEqual(response, { engine: "hermes" });
  assert.deepEqual(deps.calls, [
    ["ensure-hermes"],
    ["send-hermes", "s5"]
  ]);
});

test("createChatEngineAdapters requires response factory dependency", () => {
  assert.throws(() => createChatEngineAdapters({}), /chatCompletionResponse dependency is required/);
});

function createStatelessDeps() {
  const calls = [];
  return {
    calls,
    ensureHermesReady: async () => {
      calls.push(["ensure-hermes"]);
    },
    sendClaudeCodeStateless: async (context) => {
      calls.push(["stateless-claude", context.systemPrompt, context.userPrompt]);
      return { content: "claude" };
    },
    sendCodexStateless: async (context) => {
      calls.push(["stateless-codex", context.systemPrompt, context.userPrompt]);
      return { content: "codex" };
    },
    sendHermesStateless: async (context) => {
      calls.push(["stateless-hermes", context.systemPrompt, context.userPrompt]);
      return { content: "hermes" };
    }
  };
}

test("stateless adapters dispatch claude and codex without hermes startup", async () => {
  const deps = createStatelessDeps();
  const adapters = createStatelessChatEngineAdapters(deps);

  assert.deepEqual(await adapters["claude-code"].send({
    chatEngine: { id: "claude-code" },
    fellow,
    systemPrompt: "sys",
    userPrompt: "user"
  }), { content: "claude" });
  assert.deepEqual(await adapters.codex.send({
    chatEngine: { id: "codex" },
    fellow,
    systemPrompt: "sys2",
    userPrompt: "user2"
  }), { content: "codex" });

  assert.deepEqual(deps.calls, [
    ["stateless-claude", "sys", "user"],
    ["stateless-codex", "sys2", "user2"]
  ]);
});

test("stateless hermes adapter ensures runtime first", async () => {
  const deps = createStatelessDeps();
  const adapters = createStatelessChatEngineAdapters(deps);

  assert.deepEqual(await adapters.hermes.send({
    chatEngine: { id: "hermes" },
    fellow,
    systemPrompt: "sys",
    userPrompt: "user"
  }), { content: "hermes" });
  assert.deepEqual(deps.calls, [
    ["ensure-hermes"],
    ["stateless-hermes", "sys", "user"]
  ]);
});

test("sendWithStatelessChatEngineAdapter falls back to hermes adapter", async () => {
  const deps = createStatelessDeps();
  const adapters = createStatelessChatEngineAdapters(deps);

  assert.deepEqual(await sendWithStatelessChatEngineAdapter(adapters, {
    chatEngine: { id: "unknown" },
    fellow,
    systemPrompt: "",
    userPrompt: "user"
  }), { content: "hermes" });
  assert.deepEqual(deps.calls, [
    ["ensure-hermes"],
    ["stateless-hermes", "", "user"]
  ]);
});
