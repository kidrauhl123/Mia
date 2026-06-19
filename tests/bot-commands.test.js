const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const commands = require("../src/renderer/bot/bot-commands.js");
const ids = require("../src/shared/ids.js");

test("saveBot creates a cloud-hermes bot through identity, runtime, and conversation commands", async () => {
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
    upsertBotConversation(conversation) {
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

  const result = await commands.saveBot({
    state,
    api,
    social,
    runtimeKind: "cloud-hermes",
    isCreate: true,
    cloudModelEntries: () => [{ id: "mia-fast", label: "Mia Fast" }],
    bot: {
      name: "Alice",
      avatarImage: "alice.png",
      avatarCrop: { x: 50, y: 50, zoom: 1 },
      personaText: "Helpful"
    }
  });

  assert.equal(ids.isPublicId(result.key), true);
  assert.equal(result.conversation.id, `botc_${result.key}`);
  assert.deepEqual(calls.map((call) => call[0]), ["identity", "runtime", "conversation", "upsertConversation"]);
  assert.equal(calls[0][1], result.key);
  assert.equal(calls[1][1], result.key);
  assert.equal(calls[2][1], result.key);
  assert.equal(calls[1][2].config.model, "mia-fast");
  assert.equal(calls[2][2].runtimeKind, "cloud-hermes");
  assert.equal(social.moduleState.bots[0].id, result.key);
});

test("saveBot requires cloud identity APIs for desktop-runtime bots", async () => {
  const api = {
    async saveBot() {
      throw new Error("local save should not be called");
    }
  };

  await assert.rejects(
    () => commands.saveBot({
      state: { runtime: { cloud: { enabled: false } } },
      api,
      social: {},
      runtimeKind: "desktop-local",
      isCreate: true,
      bot: { name: "Alice", agentEngine: "codex" }
    }),
    /请先登录 Mia Cloud/
  );
});

test("saveBot creates desktop-runtime bots as cloud identities when cloud is available", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: { enabled: true },
      localDevice: { id: "mac-1", name: "Mac" }
    }
  };
  const social = {
    moduleState: { bots: [] },
    upsertBotConversation(conversation) {
      calls.push(["upsertConversation", conversation.id]);
      return conversation;
    }
  };
  const api = {
    async saveBot() {
      calls.push(["local"]);
      throw new Error("local save should not be called");
    },
    social: {
      async saveBotIdentity(key, body) {
        calls.push(["identity", key, body]);
        return { ok: true, data: { bot: { id: key, key, ...body } } };
      },
      async saveBotRuntime(key, body) {
        calls.push(["runtime", key, body]);
        return { ok: true, data: { binding: { botId: key, ...body } } };
      },
      async ensureBotSessionConversation(key, body) {
        calls.push(["conversation", key, body]);
        return { ok: true, data: { conversation: { id: `botc_${key}`, type: "bot" } } };
      }
    }
  };

  const result = await commands.saveBot({
    state,
    api,
    social,
    runtimeKind: "desktop-local",
    isCreate: true,
    bot: {
      name: "Desktop Pal",
      agentEngine: "codex",
      targetDeviceId: "mac-1",
      targetDeviceName: "Mac"
    }
  });

  assert.equal(ids.isPublicId(result.key), true);
  assert.deepEqual(calls.map((call) => call[0]), ["identity", "runtime", "conversation", "upsertConversation"]);
  assert.equal(calls[1][2].runtimeKind, "desktop-local");
  assert.equal(calls[1][2].config.agentEngine, "codex");
  assert.equal(calls[1][2].config.deviceId, "mac-1");
  assert.deepEqual(result.bot.sourceKinds, ["cloud"]);
});

test("saveBot retargets cloud-sourced desktop bots through cloud runtime binding only", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: { enabled: true },
      localDevice: { id: "mac-1", name: "Mac" }
    }
  };
  const social = {
    moduleState: { bots: [{ id: "nono", key: "nono", name: "nono", sourceKinds: ["cloud"] }] },
    upsertBotConversation(conversation) {
      calls.push(["upsertConversation", conversation.id]);
      return conversation;
    }
  };
  const api = {
    async saveBot() {
      calls.push(["local"]);
      throw new Error("local save should not be called");
    },
    social: {
      async saveBotIdentity(key, body) {
        calls.push(["identity", key, body]);
        return { ok: true, data: { bot: { id: key, key, ...body } } };
      },
      async saveBotRuntime(key, body) {
        calls.push(["runtime", key, body]);
        return { ok: true, data: { binding: { botId: key, ...body } } };
      },
      async ensureBotSessionConversation(key, body) {
        calls.push(["conversation", key, body]);
        return { ok: true, data: { conversation: { id: `botc_${key}`, type: "bot" } } };
      }
    }
  };

  const result = await commands.saveBot({
    state,
    api,
    social,
    runtimeKind: "desktop-local",
    bot: {
      key: "nono",
      name: "nono",
      sourceKinds: ["cloud"],
      agentEngine: "codex",
      targetDeviceId: "win-1",
      targetDeviceName: "Windows PC",
      engineConfig: { model: "gpt-test", effortLevel: "high", permissionMode: "readOnly" }
    }
  });

  assert.equal(result.key, "nono");
  assert.deepEqual(calls.map((call) => call[0]), ["identity", "runtime", "conversation", "upsertConversation"]);
  assert.equal(calls[1][2].runtimeKind, "desktop-local");
  assert.equal(calls[1][2].activate, true);
  assert.deepEqual(calls[1][2].config, {
    agentEngine: "codex",
    deviceId: "win-1",
    deviceName: "Windows PC",
    model: "gpt-test",
    effortLevel: "high",
    modelEntries: []
  });
  assert.equal(result.bot.targetDeviceId, "win-1");
  assert.equal(result.bot.agentEngine, "codex");
  assert.equal(social.moduleState.bots[0].runtimeKind, "desktop-local");
});

test("deleteBot removes a cloud-hermes bot through cloud identity commands", async () => {
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
      async deleteBot(botId) {
        calls.push(["cloudDelete", botId]);
        return { ok: true };
      }
    }
  };

  const result = await commands.deleteBot({
    state: { runtime: { cloud: { enabled: true } } },
    api,
    social,
    bot: { key: "alice", runtimeKind: "cloud-hermes" }
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(calls, [["cloudDelete", "alice"], ["bootstrap"]]);
  assert.deepEqual(social.moduleState.bots.map((item) => item.id), ["mia"]);
});

test("deleteBot removes cloud-sourced desktop bots through cloud identity commands", async () => {
  const calls = [];
  const social = {
    moduleState: {
      bots: [
        { id: "alice", name: "Alice", runtimeKind: "desktop-local", sourceKinds: ["cloud", "desktop"] },
        { id: "mia", name: "Mia" }
      ]
    },
    async bootstrapAfterLogin() {
      calls.push(["bootstrap"]);
    }
  };
  const api = {
    social: {
      async deleteBot(botId) {
        calls.push(["cloudDelete", botId]);
        return { ok: true };
      }
    }
  };

  const result = await commands.deleteBot({
    state: { runtime: { cloud: { enabled: true } } },
    api,
    social,
    bot: { key: "alice", runtimeKind: "desktop-local", sourceKinds: ["cloud", "desktop"] }
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(calls, [["cloudDelete", "alice"], ["bootstrap"]]);
  assert.deepEqual(social.moduleState.bots.map((item) => item.id), ["mia"]);
});

test("deleteBot requires the cloud identity delete API", async () => {
  await assert.rejects(
    () => commands.deleteBot({
      state: { runtime: {} },
      api: {},
      social: {},
      bot: { key: "alice", runtimeKind: "desktop-local" }
    }),
    /云端身份删除接口不可用/
  );
});

test("saveBotCapabilities updates cloud-hermes identity and local bot cache", async () => {
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

  const result = await commands.saveBotCapabilities({
    state: { runtime: { cloud: { enabled: true } } },
    api,
    social,
    bot: {
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

test("saveBotCapabilities updates cloud-sourced desktop identities through cloud commands", async () => {
  const capabilities = { inheritEngineDefaults: false, enabledSkills: ["search"] };
  const calls = [];
  const social = {
    moduleState: {
      bots: [
        { id: "alice", name: "Alice", runtimeKind: "desktop-local", sourceKinds: ["cloud"], capabilities: [] }
      ]
    }
  };
  const api = {
    async saveBot() {
      calls.push(["local"]);
      throw new Error("local save should not be called");
    },
    social: {
      async saveBotIdentity(key, body) {
        calls.push(["identity", key, body]);
        return { ok: true, data: { bot: { id: key, ...body } } };
      }
    }
  };

  const result = await commands.saveBotCapabilities({
    state: { runtime: { cloud: { enabled: true } } },
    api,
    social,
    bot: {
      key: "alice",
      name: "Alice",
      runtimeKind: "desktop-local",
      sourceKinds: ["cloud"],
      agentEngine: "codex",
      runtimeConfig: { agentEngine: "codex", deviceId: "mac-1" }
    },
    capabilities
  });

  assert.equal(result.key, "alice");
  assert.deepEqual(calls.map((call) => call[0]), ["identity"]);
  assert.equal(social.moduleState.bots[0].runtimeKind, "desktop-local");
  assert.deepEqual(social.moduleState.bots[0].sourceKinds, ["cloud"]);
  assert.deepEqual(social.moduleState.bots[0].capabilities, capabilities);
});

test("saveBotCapabilities requires the cloud identity save API", async () => {
  const capabilities = { inheritEngineDefaults: true, disabledPlugins: ["shell"] };

  await assert.rejects(
    () => commands.saveBotCapabilities({
      state: { runtime: {} },
      api: {},
      social: {},
      bot: {
        key: "alice",
        name: "Alice",
        runtimeKind: "desktop-local",
        agentEngine: "codex"
      },
      capabilities
    }),
    /云端身份保存接口不可用/
  );
});

test("getBotRuntimeBinding reads and caches bot runtime bindings by kind", async () => {
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

  const cloud = await commands.getBotRuntimeBinding({ api, cache, botKey: "alice", runtimeKind: "cloud-hermes" });
  const cloudCached = await commands.getBotRuntimeBinding({ api, cache, botKey: "alice", runtimeKind: "cloud-hermes" });
  const desktop = await commands.getBotRuntimeBinding({ api, cache, botKey: "alice", runtimeKind: "desktop-local" });

  assert.deepEqual(cloud, { botId: "alice", runtimeKind: "cloud-hermes", config: { model: "mia-default" } });
  assert.equal(cloudCached, cloud);
  assert.deepEqual(desktop, { botId: "alice", runtimeKind: "desktop-local", config: { model: "mia-default" } });
  assert.deepEqual(calls, [["get", "alice", "cloud-hermes"], ["get", "alice", "desktop-local"]]);
});

test("saveBotRuntimeControl saves desktop-local hermes controls through bot runtime binding", async () => {
  const calls = [];
  const api = {
    social: {
      async getBotRuntime(botId, runtimeKind) {
        calls.push(["get", botId, runtimeKind]);
        return { ok: true, data: { binding: { botId, runtimeKind, enabled: true, config: {} } } };
      },
      async saveBotRuntime(botId, body) {
        calls.push(["save", botId, body]);
        return { ok: true, data: { binding: { botId, ...body } } };
      }
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

  await commands.saveBotRuntimeControl({
    api,
    bot: { key: "alice", runtimeKind: "desktop-local", agentEngine: "hermes" },
    field: "model",
    value: "deepseek-chat",
    modelEntries
  });
  await commands.saveBotRuntimeControl({
    api,
    bot: { key: "alice", runtimeKind: "desktop-local", agentEngine: "hermes" },
    field: "effortLevel",
    value: "high",
    modelEntries
  });
  await commands.saveBotRuntimeControl({
    api,
    bot: { key: "alice", runtimeKind: "desktop-local", agentEngine: "hermes" },
    field: "permissionMode",
    value: "yolo",
    modelEntries
  });

  assert.deepEqual(calls, [
    ["get", "alice", "desktop-local"],
    ["save", "alice", {
      runtimeKind: "desktop-local",
      enabled: true,
      config: {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseUrl: "https://api.deepseek.com",
        apiMode: "openai",
        providerLabel: "DeepSeek",
        authType: "api_key",
        modelProfileId: ""
      }
    }],
    ["get", "alice", "desktop-local"],
    ["save", "alice", {
      runtimeKind: "desktop-local",
      enabled: true,
      config: { effortLevel: "high" }
    }],
    ["get", "alice", "desktop-local"],
    ["save", "alice", {
      runtimeKind: "desktop-local",
      enabled: true,
      config: { permissionMode: "yolo" }
    }]
  ]);
});

test("saveBotRuntimeControl saves desktop-local external engine controls through bot runtime binding", async () => {
  const calls = [];
  const api = {
    social: {
      async getBotRuntime(botId, runtimeKind) {
        calls.push(["get", botId, runtimeKind]);
        return { ok: true, data: { binding: { botId, runtimeKind, enabled: true, config: { agentEngine: "codex" } } } };
      },
      async saveBotRuntime(botId, body) {
        calls.push(["save", botId, body]);
        return { ok: true, data: { binding: { botId, ...body } } };
      }
    }
  };

  const result = await commands.saveBotRuntimeControl({
    api,
    bot: { key: "codex", runtimeKind: "desktop-local", agentEngine: "codex" },
    field: "model",
    value: "gpt-5.3-codex",
    modelEntries: [
      { id: "default", model: "", label: "Codex 默认" },
      { id: "gpt-5.3-codex", model: "gpt-5.3-codex", label: "GPT-5.3 Codex" }
    ]
  });

  assert.equal(result.saved, true);
  assert.deepEqual(calls, [
    ["get", "codex", "desktop-local"],
    ["save", "codex", {
      runtimeKind: "desktop-local",
      enabled: true,
      config: {
        agentEngine: "codex",
        model: "gpt-5.3-codex"
      }
    }]
  ]);
});

test("saveBotRuntimeControl does not save desktop-local external permissionMode into bot runtime binding", async () => {
  const calls = [];
  const api = {
    social: {
      async getBotRuntime(botId, runtimeKind) {
        calls.push(["get", botId, runtimeKind]);
        return { ok: true, data: { binding: { botId, runtimeKind, enabled: true, config: { agentEngine: "codex" } } } };
      },
      async saveBotRuntime(botId, body) {
        calls.push(["save", botId, body]);
        return { ok: true, data: { binding: { botId, ...body } } };
      }
    }
  };

  const result = await commands.saveBotRuntimeControl({
    api,
    bot: { key: "codex", runtimeKind: "desktop-local", agentEngine: "codex" },
    field: "permissionMode",
    value: ":danger-full-access"
  });

  assert.deepEqual(result, { saved: false, runtime: null, binding: null });
  assert.deepEqual(calls, []);
});


test("saveBotRuntimeConfig merges patch with current cloud runtime binding", async () => {
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

  const result = await commands.saveBotRuntimeConfig({
    api,
    cache,
    botKey: "alice",
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

test("syncDesktopLocalBotRuntimeBinding stores hermes config from current device settings", async () => {
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

  const result = await commands.syncDesktopLocalBotRuntimeBinding({
    api,
    state,
    bot: { key: "alice", name: "Alice" },
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
      activate: false,
      preserveEnabled: true,
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

test("syncDesktopLocalBotRuntimeBinding preserves openclaw as a desktop target", async () => {
  const calls = [];
  const api = {
    async saveBotRuntime(botId, body) {
      calls.push(["runtime", botId, body]);
      return { ok: true, data: { binding: { botId, ...body } } };
    }
  };

  await commands.syncDesktopLocalBotRuntimeBinding({
    api,
    state: { runtime: { localDevice: { id: "mac-1", name: "Mac" } } },
    bot: { key: "claw", name: "Claw", agentEngine: "openclaw" }
  });

  assert.equal(calls[0][2].config.agentEngine, "openclaw");
  assert.equal(calls[0][2].config.deviceId, "mac-1");
});

test("ensureDesktopLocalBotConversation creates conversation and syncs external engine runtime config", async () => {
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

  const result = await commands.ensureDesktopLocalBotConversation({
    api,
    state: {
      runtime: {
        permissions: {
          engines: {
            codex: ":danger-full-access"
          }
        }
      }
    },
    bot: {
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
  assert.equal(calls[1][2].activate, false);
  assert.equal(calls[1][2].preserveEnabled, true);
  assert.deepEqual(calls[1][2].config, {
    agentEngine: "codex",
    model: "gpt-5.3-codex",
    effortLevel: "xhigh",
    modelEntries: [
      { value: "default", label: "Codex 默认", model: "", provider: "codex", providerLabel: "" },
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", model: "gpt-5.3-codex", provider: "codex", providerLabel: "" }
    ]
  });
  assert.equal(result.conversation.upserted, true);
  assert.equal(upserted[0].id, "botc_codex");
});

test("saveBotRuntimeControl saves cloud-hermes controls through cloud runtime config", async () => {
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

  await commands.saveBotRuntimeControl({
    api,
    bot: { key: "mia", runtimeKind: "cloud-hermes" },
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

test("bot commands attach as a browser global without legacy globals", () => {
  const sourcePath = path.join(__dirname, "..", "src", "renderer", "bot", "bot-commands.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const window = {};
  const context = vm.createContext({ window, globalThis: window, module: { exports: {} }, require, console });
  vm.runInContext(source, context, { filename: sourcePath });

  assert.equal(typeof window.miaBotCommands.saveBotRuntimeControl, "function");
  assert.equal(window["mia" + "FellowCommands"], undefined);
});
