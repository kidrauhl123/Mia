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
    sendHermesChat: async (context) => {
      calls.push(["send-hermes", context.sessionId]);
      return { engine: "hermes" };
    }
  };
}

const bot = { key: "alice" };

test("claude adapter returns local slash command response without SDK call", async () => {
  const deps = createDeps({ externalSlashResult: "local help" });
  const adapters = createChatEngineAdapters(deps);
  const response = await adapters["claude-code"].send({
    bot,
    sessionId: "s1",
    slashText: "/help"
  });

  assert.equal(response.id, "cmd_test");
  assert.equal(response.model, "claude-code");
  assert.equal(response.choices[0].message.content, "local help");
  assert.deepEqual(response.mia, {
    transport: "local-command",
    engine: "claude-code",
    bot_id: "alice"
  });
  assert.deepEqual(deps.calls, [["external-slash", "claude-code", "/help"]]);
});

test("claude adapter rejects the retired direct bot chat path when slash is not local", async () => {
  const deps = createDeps({ externalSlashResult: null });
  const adapters = createChatEngineAdapters(deps);

  await assert.rejects(
    () => adapters["claude-code"].send({
      bot,
      sessionId: "s2",
      slashText: "/unknown"
    }),
    /AgentSession/
  );
  assert.deepEqual(deps.calls, [
    ["external-slash", "claude-code", "/unknown"]
  ]);
});

test("codex adapter rejects the retired direct bot chat path when slash is not local", async () => {
  const deps = createDeps({ externalSlashResult: null });
  const adapters = createChatEngineAdapters(deps);

  await assert.rejects(
    () => adapters.codex.send({
      bot,
      sessionId: "s-codex",
      slashText: "/unknown"
    }),
    /AgentSession/
  );
  assert.deepEqual(deps.calls, [
    ["external-slash", "codex", "/unknown"]
  ]);
});

test("claude adapter preserves structured local command result", async () => {
  const deps = createDeps({
    externalSlashResult: {
      content: "选择一个会话继续：",
      commandResult: { type: "session-list", rows: [{ id: "s1" }] }
    }
  });
  const adapters = createChatEngineAdapters(deps);
  const response = await adapters["claude-code"].send({
    bot,
    sessionId: "s1",
    slashText: "/resume"
  });

  assert.equal(response.choices[0].message.content, "选择一个会话继续：");
  assert.deepEqual(response.choices[0].message.commandResult, { type: "session-list", rows: [{ id: "s1" }] });
  assert.deepEqual(response.mia.commandResult, { type: "session-list", rows: [{ id: "s1" }] });
});


test("hermes adapter starts runtime before local slash command", async () => {
  const deps = createDeps({ hermesSlashResult: "settings saved" });
  const adapters = createChatEngineAdapters(deps);
  const response = await adapters.hermes.send({
    bot,
    sessionId: "s3",
    slashText: "/model"
  });

  assert.equal(response.id, "cmd_test");
  assert.equal(response.model, "hermes-agent");
  assert.equal(response.choices[0].message.content, "settings saved");
  assert.deepEqual(response.mia, {
    transport: "local-command",
    engine: "hermes",
    bot_id: "alice"
  });
  assert.deepEqual(deps.calls, [
    ["ensure-hermes"],
    ["hermes-slash", "/model"]
  ]);
});

test("hermes adapter rejects the retired direct desktop chat path", async () => {
  const deps = createDeps();
  const adapters = createChatEngineAdapters(deps);

  await assert.rejects(
    () => adapters.hermes.send({
      bot,
      sessionId: "s4",
      slashText: ""
    }),
    /AgentSession/
  );
  assert.deepEqual(deps.calls, []);
});

test("sendWithChatEngineAdapter rejects unknown adapters", async () => {
  const deps = createDeps();
  const adapters = createChatEngineAdapters(deps);

  await assert.rejects(
    () => sendWithChatEngineAdapter(adapters, {
      chatEngine: { id: "unknown" },
      bot,
      sessionId: "s5",
      slashText: ""
    }),
    /No chat engine adapter for unknown/
  );
  assert.deepEqual(deps.calls, []);
});

test("sendWithChatEngineAdapter rejects removed OpenClaw adapter requests", async () => {
  const deps = createDeps({ externalSlashResult: "openclaw help" });
  const adapters = createChatEngineAdapters(deps);

  await assert.rejects(
    () => sendWithChatEngineAdapter(adapters, {
      chatEngine: { id: "openclaw" },
      bot,
      sessionId: "s-openclaw",
      slashText: "/help"
    }),
    /No chat engine adapter for openclaw/
  );
  assert.deepEqual(deps.calls, []);
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
    bot,
    systemPrompt: "sys",
    userPrompt: "user"
  }), { content: "claude" });
  assert.deepEqual(await adapters.codex.send({
    chatEngine: { id: "codex" },
    bot,
    systemPrompt: "sys2",
    userPrompt: "user2"
  }), { content: "codex" });

  assert.deepEqual(deps.calls, [
    ["stateless-claude", "sys", "user"],
    ["stateless-codex", "sys2", "user2"]
  ]);
});

test("stateless hermes adapter rejects the retired desktop HTTP path", async () => {
  const deps = createStatelessDeps();
  const adapters = createStatelessChatEngineAdapters(deps);

  await assert.rejects(
    () => adapters.hermes.send({
      chatEngine: { id: "hermes" },
      bot,
      systemPrompt: "sys",
      userPrompt: "user"
    }),
    /legacy HTTP execution path/
  );
  assert.deepEqual(deps.calls, []);
});

test("sendWithStatelessChatEngineAdapter rejects unknown adapters", async () => {
  const deps = createStatelessDeps();
  const adapters = createStatelessChatEngineAdapters(deps);

  await assert.rejects(
    () => sendWithStatelessChatEngineAdapter(adapters, {
      chatEngine: { id: "unknown" },
      bot,
      systemPrompt: "",
      userPrompt: "user"
    }),
    /No stateless chat engine adapter for unknown/
  );
  assert.deepEqual(deps.calls, []);
});

test("sendWithStatelessChatEngineAdapter rejects removed OpenClaw adapter requests", async () => {
  const deps = createStatelessDeps();
  const adapters = createStatelessChatEngineAdapters(deps);

  await assert.rejects(
    () => sendWithStatelessChatEngineAdapter(adapters, {
      chatEngine: { id: "openclaw" },
      bot,
      systemPrompt: "",
      userPrompt: "user"
    }),
    /No stateless chat engine adapter for openclaw/
  );
  assert.deepEqual(deps.calls, []);
});
