const { test } = require("node:test");
const assert = require("node:assert/strict");

const commands = require("../src/renderer/fellow/fellow-commands.js");

test("saveFellow creates a cloud-hermes fellow through identity, runtime, and conversation commands", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: { enabled: true },
      bots: [{ key: "local", name: "Local" }]
    }
  };
  const social = {
    moduleState: {
      bots: [{ id: "mia", name: "Mia" }]
    },
    upsertFellowConversation(conversation) {
      calls.push(["upsertConversation", conversation.id]);
      return conversation;
    }
  };
  const api = {
    social: {
      async saveBotIdentity(key, body) {
        calls.push(["identity", key, body]);
        return { ok: true, data: { bot: { id: key, ...body } } };
      },
      async saveBotRuntime(key, body) {
        calls.push(["runtime", key, body]);
        return { ok: true, data: { binding: { botId: key, ...body } } };
      },
      async ensureBotSessionConversation(key, body) {
        calls.push(["conversation", key, body]);
        return { ok: true, data: { conversation: { id: `botc_${key}`, type: "bot", decorations: { botId: key, runtimeKind: body.runtimeKind } } } };
      }
    }
  };

  const result = await commands.saveFellow({
    state,
    api,
    social,
    runtimeKind: "cloud-hermes",
    isCreate: true,
    cloudModelEntries: () => [{ id: "mia-fast", label: "Mia Fast" }],
    fellow: {
      name: "Alice",
      avatarImage: "alice.png",
      avatarCrop: { x: 50, y: 50, zoom: 1 },
      personaText: "Helpful"
    }
  });

  assert.equal(result.key, "alice");
  assert.equal(result.conversation.id, "botc_alice");
  assert.deepEqual(calls.map((call) => call[0]), ["identity", "runtime", "conversation", "upsertConversation"]);
  assert.equal(calls[1][2].config.model, "mia-fast");
  assert.equal(calls[2][2].runtimeKind, "cloud-hermes");
  assert.equal(social.moduleState.bots[0].id, "alice");
});

test("saveFellow saves a desktop-local fellow through the local runtime command", async () => {
  const calls = [];
  const runtime = {
    bots: [
      { key: "alice", name: "Alice" },
      { key: "mia", name: "Mia" }
    ]
  };
  const api = {
    async saveBot(fellow) {
      calls.push(["local", fellow]);
      return runtime;
    }
  };

  const result = await commands.saveFellow({
    state: { runtime: { cloud: { enabled: true } } },
    api,
    social: {},
    runtimeKind: "desktop-local",
    isCreate: true,
    fellow: { name: "Alice", agentEngine: "codex" }
  });

  assert.equal(result.key, "alice");
  assert.equal(result.runtime, runtime);
  assert.deepEqual(calls.map((call) => call[0]), ["local"]);
  assert.equal(calls[0][1].agentEngine, "codex");
});

test("deleteFellow removes a cloud-hermes fellow through cloud identity commands", async () => {
  const calls = [];
  const social = {
    moduleState: {
      bots: [
        { id: "alice", name: "Alice" },
        { id: "mia", name: "Mia" }
      ]
    },
    async bootstrapAfterLogin() {
      calls.push(["bootstrap"]);
    }
  };
  const api = {
    social: {
      async deleteBot(fellowId) {
        calls.push(["cloudDelete", fellowId]);
        return { ok: true };
      }
    }
  };

  const result = await commands.deleteFellow({
    state: { runtime: { cloud: { enabled: true } } },
    api,
    social,
    fellow: { key: "alice", runtimeKind: "cloud-hermes" }
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(calls, [["cloudDelete", "alice"], ["bootstrap"]]);
  assert.deepEqual(social.moduleState.bots.map((item) => item.id), ["mia"]);
});

test("deleteFellow removes a desktop-local fellow through the local runtime command", async () => {
  const calls = [];
  const runtime = { bots: [{ key: "mia", name: "Mia" }] };
  const api = {
    async deleteBot(payload) {
      calls.push(["localDelete", payload]);
      return runtime;
    }
  };

  const result = await commands.deleteFellow({
    state: { runtime: {} },
    api,
    social: {},
    fellow: { key: "alice", runtimeKind: "desktop-local" }
  });

  assert.equal(result.deleted, true);
  assert.equal(result.runtime, runtime);
  assert.deepEqual(calls, [["localDelete", { key: "alice" }]]);
});

test("saveFellowCapabilities updates cloud-hermes identity and local fellow cache", async () => {
  const { normalizeBotCapabilities } = require("../src/shared/bot-identity.js");
  const capabilities = normalizeBotCapabilities({ inheritEngineDefaults: false, enabledSkills: ["search"] });
  const social = {
    moduleState: {
      bots: [
        { id: "alice", name: "Alice", capabilities: [] },
        { id: "mia", name: "Mia", capabilities: [] }
      ]
    }
  };
  const calls = [];
  const api = {
    social: {
      async saveBotIdentity(key, body) {
        calls.push(["identity", key, body]);
        return { ok: true, data: { bot: { id: key, ...body } } };
      }
    }
  };

  const result = await commands.saveFellowCapabilities({
    state: { runtime: { cloud: { enabled: true } } },
    api,
    social,
    fellow: {
      key: "alice",
      name: "Alice",
      runtimeKind: "cloud-hermes",
      bio: "helper",
      personaText: "Persona"
    },
    capabilities
  });

  assert.equal(result.key, "alice");
  assert.deepEqual(calls, [[
    "identity",
    "alice",
    {
      name: "Alice",
      avatarImage: "",
      avatarCrop: null,
      bio: "helper",
      personaText: "Persona",
      capabilities
    }
  ]]);
  assert.deepEqual(social.moduleState.bots.map((item) => [item.id, item.capabilities]), [
    ["alice", capabilities],
    ["mia", []]
  ]);
});

test("saveFellowCapabilities updates desktop-local fellows through local saveFellow", async () => {
  const capabilities = { inheritEngineDefaults: true, disabledPlugins: ["shell"] };
  const runtime = { bots: [{ key: "alice", name: "Alice", capabilities }] };
  const calls = [];
  const api = {
    async saveBot(fellow) {
      calls.push(["local", fellow]);
      return runtime;
    }
  };

  const result = await commands.saveFellowCapabilities({
    state: { runtime: {} },
    api,
    social: {},
    fellow: {
      key: "alice",
      name: "Alice",
      runtimeKind: "desktop-local",
      agentEngine: "codex"
    },
    capabilities
  });

  assert.equal(result.runtime, runtime);
  assert.deepEqual(calls, [[
    "local",
    {
      key: "alice",
      name: "Alice",
      runtimeKind: "desktop-local",
      agentEngine: "codex",
      capabilities
    }
  ]]);
});

test("getFellowRuntimeBinding reads and caches cloud-hermes runtime bindings", async () => {
  const calls = [];
  const cache = new Map();
  const api = {
    social: {
      async getBotRuntime(botId, runtimeKind) {
        calls.push(["get", botId, runtimeKind]);
        return { ok: true, data: { binding: { botId, runtimeKind, config: { model: "mia-default" } } } };
      }
    }
  };

  const first = await commands.getFellowRuntimeBinding({ api, cache, fellowKey: "alice", runtimeKind: "cloud-hermes" });
  const second = await commands.getFellowRuntimeBinding({ api, cache, fellowKey: "alice", runtimeKind: "cloud-hermes" });
  const skipped = await commands.getFellowRuntimeBinding({ api, cache, fellowKey: "alice", runtimeKind: "desktop-local" });

  assert.deepEqual(first, { botId: "alice", runtimeKind: "cloud-hermes", config: { model: "mia-default" } });
  assert.equal(second, first);
  assert.equal(skipped, null);
  assert.deepEqual(calls, [["get", "alice", "cloud-hermes"]]);
});

test("saveFellowRuntimeConfig merges patch with current cloud runtime binding", async () => {
  const calls = [];
  const cache = new Map();
  const api = {
    social: {
      async getBotRuntime(botId, runtimeKind) {
        calls.push(["get", botId, runtimeKind]);
        return { ok: true, data: { binding: { botId, runtimeKind, enabled: true, config: { model: "mia-default", effortLevel: "low" } } } };
      },
      async saveBotRuntime(botId, body) {
        calls.push(["save", botId, body]);
        return { ok: true, data: { binding: { botId, ...body } } };
      }
    }
  };

  const result = await commands.saveFellowRuntimeConfig({
    api,
    cache,
    fellowKey: "alice",
    runtimeKind: "cloud-hermes",
    patch: { effortLevel: "high", permissionMode: "ask" }
  });

  assert.deepEqual(result.binding.config, {
    model: "mia-default",
    effortLevel: "high",
    permissionMode: "ask"
  });
  assert.deepEqual(calls, [
    ["get", "alice", "cloud-hermes"],
    ["save", "alice", {
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: {
        model: "mia-default",
        effortLevel: "high",
        permissionMode: "ask"
      }
    }]
  ]);
  assert.equal(cache.get("alice:cloud-hermes"), result.binding);
});

test("syncDesktopLocalFellowRuntimeBinding stores hermes config from current device settings", async () => {
  const calls = [];
  const api = {
    async saveBotRuntime(botId, body) {
      calls.push(["runtime", botId, body]);
      return { ok: true, data: { binding: { botId, ...body } } };
    }
  };
  const state = {
    runtime: {
      model: { provider: "deepseek", model: "deepseek-chat" },
      effort: { level: "high" },
      permissions: { mode: "yolo" }
    }
  };

  const result = await commands.syncDesktopLocalFellowRuntimeBinding({
    api,
    state,
    fellow: { key: "alice", name: "Alice" },
    modelSettings: {
      connectedModelEntries: () => [
        { id: "deepseek-chat", model: "deepseek-chat", label: "DeepSeek", provider: "deepseek", providerLabel: "DeepSeek" }
      ]
    }
  });

  assert.equal(result.botId, "alice");
  assert.deepEqual(calls, [[
    "runtime",
    "alice",
    {
      runtimeKind: "desktop-local",
      enabled: true,
      config: {
        agentEngine: "hermes",
        model: "deepseek-chat",
        effortLevel: "high",
        permissionMode: "yolo",
        modelEntries: [
          { value: "deepseek-chat", label: "DeepSeek", model: "deepseek-chat", provider: "deepseek", providerLabel: "DeepSeek" }
        ]
      }
    }
  ]]);
});

test("ensureDesktopLocalFellowConversation creates conversation and syncs external engine runtime config", async () => {
  const calls = [];
  const api = {
    async ensureBotSessionConversation(sessionId, body) {
      calls.push(["conversation", sessionId, body]);
      return { ok: true, data: { conversation: { id: `botc_${sessionId}`, type: "bot" } } };
    },
    async saveBotRuntime(botId, body) {
      calls.push(["runtime", botId, body]);
      return { ok: true, data: { binding: { botId, ...body } } };
    }
  };
  const upserted = [];

  const result = await commands.ensureDesktopLocalFellowConversation({
    api,
    state: { runtime: {} },
    fellow: {
      key: "codex",
      name: "Codex",
      agentEngine: "codex",
      engineConfig: { model: "gpt-5.3-codex", effortLevel: "xhigh", permissionMode: "readOnly" }
    },
    engineOptions: {
      externalModelEntries: () => [
        { id: "default", model: "", label: "Codex 默认", provider: "codex" },
        { id: "gpt-5.3-codex", model: "gpt-5.3-codex", label: "GPT-5.3 Codex", provider: "codex" }
      ]
    },
    onConversation: (conversation) => {
      upserted.push(conversation);
      return { ...conversation, upserted: true };
    }
  });

  assert.deepEqual(calls.map((call) => call[0]), ["conversation", "runtime"]);
  assert.deepEqual(calls[0], ["conversation", "codex", { botId: "codex", title: "Codex", runtimeKind: "desktop-local" }]);
  assert.equal(calls[1][1], "codex");
  assert.deepEqual(calls[1][2].config, {
    agentEngine: "codex",
    model: "gpt-5.3-codex",
    effortLevel: "xhigh",
    permissionMode: "readOnly",
    modelEntries: [
      { value: "default", label: "Codex 默认", model: "", provider: "codex", providerLabel: "" },
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", model: "gpt-5.3-codex", provider: "codex", providerLabel: "" }
    ]
  });
  assert.equal(result.conversation.upserted, true);
  assert.equal(upserted[0].id, "botc_codex");
});

test("saveFellowRuntimeControl saves desktop-local hermes controls through device runtime settings", async () => {
  const calls = [];
  const api = {
    async saveModel(payload) {
      calls.push(["model", payload]);
      return { fellows: [] };
    },
    async saveEffort(payload) {
      calls.push(["effort", payload]);
      return { fellows: [] };
    },
    async savePermissions(payload) {
      calls.push(["permissions", payload]);
      return { fellows: [] };
    }
  };
  const modelEntries = [
    {
      id: "deepseek-chat",
      provider: "deepseek",
      model: "deepseek-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com",
      apiMode: "openai",
      providerLabel: "DeepSeek",
      authType: "api_key"
    }
  ];

  await commands.saveFellowRuntimeControl({
    api,
    fellow: { key: "alice", runtimeKind: "desktop-local", agentEngine: "hermes" },
    field: "model",
    value: "deepseek-chat",
    modelEntries
  });
  await commands.saveFellowRuntimeControl({
    api,
    fellow: { key: "alice", runtimeKind: "desktop-local", agentEngine: "hermes" },
    field: "effortLevel",
    value: "high",
    modelEntries
  });
  await commands.saveFellowRuntimeControl({
    api,
    fellow: { key: "alice", runtimeKind: "desktop-local", agentEngine: "hermes" },
    field: "permissionMode",
    value: "yolo",
    modelEntries
  });

  assert.deepEqual(calls, [
    ["model", {
      provider: "deepseek",
      model: "deepseek-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com",
      apiMode: "openai",
      providerLabel: "DeepSeek",
      authType: "api_key"
    }],
    ["effort", { level: "high" }],
    ["permissions", { mode: "yolo" }]
  ]);
});

test("saveFellowRuntimeControl saves desktop-local external engine controls through fellow engine config", async () => {
  const calls = [];
  const api = {
    async saveBotEngine(payload) {
      calls.push(["engine", payload]);
      return { bots: [{ key: payload.key, agentEngine: payload.agentEngine, engineConfig: payload.engineConfig }] };
    }
  };

  const result = await commands.saveFellowRuntimeControl({
    api,
    fellow: { key: "codex", runtimeKind: "desktop-local", agentEngine: "codex" },
    field: "model",
    value: "gpt-5.3-codex",
    modelEntries: [
      { id: "default", model: "", label: "Codex 默认" },
      { id: "gpt-5.3-codex", model: "gpt-5.3-codex", label: "GPT-5.3 Codex" }
    ]
  });

  assert.equal(result.saved, true);
  assert.deepEqual(calls, [[
    "engine",
    {
      key: "codex",
      agentEngine: "codex",
      engineConfig: { model: "gpt-5.3-codex" }
    }
  ]]);
});

test("saveFellowRuntimeControl saves cloud-hermes controls through cloud runtime config", async () => {
  const calls = [];
  const api = {
    social: {
      async getBotRuntime(botId, runtimeKind) {
        calls.push(["get", botId, runtimeKind]);
        return { ok: true, data: { binding: { botId, runtimeKind, enabled: true, config: { model: "mia-default" } } } };
      },
      async saveBotRuntime(botId, body) {
        calls.push(["save", botId, body]);
        return { ok: true, data: { binding: { botId, ...body } } };
      }
    }
  };

  await commands.saveFellowRuntimeControl({
    api,
    fellow: { key: "mia", runtimeKind: "cloud-hermes" },
    field: "model",
    value: "mia-pro",
    modelEntries: [{ id: "mia-pro", model: "mia-pro", label: "Mia Pro" }]
  });

  assert.deepEqual(calls, [
    ["get", "mia", "cloud-hermes"],
    ["save", "mia", {
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: { model: "mia-pro" }
    }]
  ]);
});
