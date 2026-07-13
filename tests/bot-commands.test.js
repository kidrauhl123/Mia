const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.miaCloudRuntime = require("../src/shared/cloud-runtime.js");
const { MANUAL_BOT_DEFAULT_ENABLED_SKILLS } = require("../src/shared/bot-identity.js");
const commands = require("../src/renderer/bot/bot-commands.js");

const CLOUD_AGENT_RUNTIME = {
  mode: "claude-code",
  runtimeKind: "cloud-claude-code",
  agentEngine: "claude-code",
  label: "Claude Code",
  available: true
};

test("saveBot creates a cloud-claude-code bot through identity, runtime, and conversation commands", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: { enabled: true, agentRuntime: CLOUD_AGENT_RUNTIME },
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
	        return { ok: true, data: { bot: { id: key || "bot_core_cloud", ...body } } };
	      },
      async saveBotRuntime(key, body) {
        calls.push(["runtime", key, body]);
        return {
          ok: true,
          data: {
            binding: {
              botId: key,
              ...body,
              agentEngine: body.targetIntent?.agentEngine || "",
              targetDeviceId: body.targetIntent?.deviceId || "",
              targetDeviceName: body.targetIntent?.deviceName || "",
              runtimeLabel: body.targetIntent?.deviceName || "",
              config: { agentEngine: "hermes", deviceId: "legacy-device", deviceName: "Legacy Mac" },
              runtimeConfig: { agentEngine: "hermes", deviceId: "legacy-device", deviceName: "Legacy Mac" }
            }
          }
        };
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
    runtimeKind: "cloud-claude-code",
    isCreate: true,
    bot: {
      name: "Alice",
      avatarImage: "alice.png",
      avatarCrop: { x: 50, y: 50, zoom: 1 },
      personaText: "Helpful"
    }
  });

  assert.notEqual(calls[0][1], "");
  assert.equal(result.key, calls[0][1]);
  assert.equal(result.conversation.id, `botc_${result.key}`);
  assert.deepEqual(calls.map((call) => call[0]), ["identity", "runtime", "conversation", "upsertConversation"]);
  assert.equal(calls[1][1], result.key);
  assert.equal(calls[2][1], result.key);
  assert.deepEqual(calls[0][2].capabilities.enabledSkills, MANUAL_BOT_DEFAULT_ENABLED_SKILLS);
  assert.equal(calls[1][2].targetIntent.agentEngine, "claude-code");
  assert.equal(Object.hasOwn(calls[1][2], "config"), false);
  assert.equal(calls[2][2].runtimeKind, "cloud-claude-code");
  assert.equal(social.moduleState.bots[0].id, result.key);
});

test("saveBot refuses cloud-claude-code when cloud runtime metadata is missing", async () => {
  await assert.rejects(
    () => commands.saveBot({
      state: { runtime: { cloud: { enabled: true } } },
      api: { social: { saveBotIdentity() {} } },
      social: { moduleState: { bots: [] } },
      runtimeKind: "cloud-claude-code",
      isCreate: true,
      bot: { name: "Alice" }
    }),
    /Mia Cloud 运行内核未同步/
  );
});

test("saveBot strips copied local engine identity when saving cloud-claude-code bots", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: { enabled: true, agentRuntime: CLOUD_AGENT_RUNTIME },
      bots: []
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
    social: {
	      async saveBotIdentity(key, body) {
	        calls.push(["identity", key, body]);
	        return { ok: true, data: { bot: { id: key || "bot_core_strip", ...body } } };
	      },
      async saveBotRuntime(key, body) {
        calls.push(["runtime", key, body]);
        return {
          ok: true,
          data: {
            binding: {
              botId: key,
              ...body,
              agentEngine: body.targetIntent?.agentEngine || "",
              targetDeviceId: body.targetIntent?.deviceId || "",
              targetDeviceName: body.targetIntent?.deviceName || "",
              runtimeLabel: body.targetIntent?.deviceName || ""
            }
          }
        };
      },
      async ensureBotSessionConversation(key, body) {
        calls.push(["conversation", key, body]);
        return { ok: true, data: { conversation: { id: `botc_${key}`, type: "bot", decorations: { botId: key, runtimeKind: body.runtimeKind } } } };
      }
    }
  };

  await commands.saveBot({
    state,
    api,
    social,
    runtimeKind: "cloud-claude-code",
    isCreate: true,
    bot: {
      name: "？？",
      bio: "你是 Claude Code。专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。",
      personaText: "你是 Claude Code。专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。"
    }
  });

  const identity = calls.find((call) => call[0] === "identity")[2];
  assert.equal(identity.name, "？？");
  assert.equal(identity.bio, "专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。");
  assert.equal(identity.personaText, "专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。");
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
	        return { ok: true, data: { bot: { id: key || "bot_core_desktop", key: key || "bot_core_desktop", ...body } } };
	      },
      async saveBotRuntime(key, body) {
        calls.push(["runtime", key, body]);
        return {
          ok: true,
          data: {
            binding: {
              botId: key,
              ...body,
              agentEngine: body.targetIntent?.agentEngine || "",
              targetDeviceId: body.targetIntent?.deviceId || "",
              targetDeviceName: body.targetIntent?.deviceName || "",
              runtimeLabel: body.targetIntent?.deviceName || "",
              config: { agentEngine: "hermes", deviceId: "legacy-device", deviceName: "Legacy PC" },
              runtimeConfig: { agentEngine: "hermes", deviceId: "legacy-device", deviceName: "Legacy PC" }
            }
          }
        };
      },
      async ensureBotConversation(key, body) {
        calls.push(["conversation", key, body]);
        return { ok: true, data: { conversation: { id: `botc_${key}`, type: "bot" } } };
      },
      async ensureBotSessionConversation(key, body) {
        calls.push(["core-session-conversation", key, body]);
        throw new Error(`Mia Core HTTP POST /api/bots/${key}/session-conversation failed 404: Not Found`);
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

  assert.notEqual(calls[0][1], "");
  assert.equal(result.key, calls[0][1]);
  assert.deepEqual(calls.map((call) => call[0]), ["identity", "runtime", "conversation", "upsertConversation"]);
  assert.deepEqual(calls[0][2].capabilities.enabledSkills, MANUAL_BOT_DEFAULT_ENABLED_SKILLS);
  assert.equal(calls[1][2].runtimeKind, "desktop-local");
  assert.equal(calls[1][2].targetIntent.agentEngine, "codex");
  assert.equal(calls[1][2].targetIntent.deviceId, "mac-1");
  assert.equal(Object.hasOwn(calls[1][2], "config"), false);
  assert.deepEqual(result.bot.sourceKinds, ["cloud"]);
  assert.equal(result.bot.agentEngine, "codex");
  assert.equal(result.bot.targetDeviceId, "mac-1");
  assert.equal(result.bot.targetDeviceName, "Mac");
  assert.equal(result.bot.runtimeLabel, "Mac");
  assert.equal(Object.hasOwn(result.bot, "runtimeConfig"), false);
});

test("saveBot preserves explicit capabilities when creating desktop-runtime bots", async () => {
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
    social: {
	      async saveBotIdentity(key, body) {
	        calls.push(["identity", key, body]);
	        return { ok: true, data: { bot: { id: key || "bot_core_caps", key: key || "bot_core_caps", ...body } } };
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

  await commands.saveBot({
    state,
    api,
    social,
    runtimeKind: "desktop-local",
    isCreate: true,
    bot: {
      name: "Preset Bot",
      capabilities: { enabledSkills: ["mia-official:paper-research"] }
    }
  });

  assert.deepEqual(calls[0][2].capabilities.enabledSkills, ["mia-official:paper-research"]);
});

test("saveBot preserves submitted status badge when older cloud responses omit it", async () => {
  const calls = [];
  const badge = { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰" };
  const state = {
    runtime: {
      cloud: { enabled: true },
      localDevice: { id: "mac-1", name: "Mac" }
    }
  };
  const social = {
    moduleState: { bots: [] },
    upsertBotConversation(conversation) {
      return conversation;
    }
  };
  const api = {
    social: {
      async saveBotIdentity(key, body) {
        calls.push(["identity", key, body]);
        return {
          ok: true,
          data: {
            bot: {
              id: key || "bot_legacy_cloud",
              key: key || "bot_legacy_cloud",
              name: body.name
            }
          }
        };
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
      name: "Mia",
      statusBadge: badge,
      agentEngine: "hermes",
      targetDeviceId: "mac-1",
      targetDeviceName: "Mac"
    }
  });

  assert.deepEqual(calls[0][2].statusBadge, badge);
  assert.deepEqual(result.bot.statusBadge, badge);
  assert.deepEqual(social.moduleState.bots[0].statusBadge, badge);
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
  assert.deepEqual(calls[1][2].targetIntent, {
    agentEngine: "codex",
    deviceId: "win-1",
    deviceName: "Windows PC"
  });
  assert.equal(result.bot.targetDeviceId, "win-1");
  assert.equal(result.bot.targetDeviceName, "Windows PC");
  assert.equal(result.bot.runtimeLabel, "Windows PC");
  assert.equal(result.bot.agentEngine, "codex");
  assert.equal(Object.hasOwn(result.bot, "runtimeConfig"), false);
  assert.equal(social.moduleState.bots[0].runtimeKind, "desktop-local");
  assert.equal(social.moduleState.bots[0].targetDeviceId, "win-1");
});

test("deleteBot removes a cloud-claude-code bot through cloud identity commands", async () => {
  const calls = [];
  const social = {
    moduleState: {
      bots: [
        { id: "alice", name: "Alice" },
        { id: "mia", name: "Mia" }
      ],
      conversations: [
        { id: "botc_alice", type: "bot", decorations: { botId: "alice" } },
        { id: "botc_mia", type: "bot", decorations: { botId: "mia" } }
      ],
      messageCache: new Map([["botc_alice", { messages: [] }]]),
      unreadByConversation: new Map([["botc_alice", 1]])
    },
    async bootstrapAfterLogin() {
      calls.push(["bootstrap"]);
    }
  };
  const api = {
    social: {
      async deleteBot(botId) {
        calls.push(["cloudDelete", botId]);
        return { ok: true, data: { deletedConversationIds: ["botc_alice"] } };
      }
    }
  };

  const result = await commands.deleteBot({
    state: { runtime: { cloud: { enabled: true } } },
    api,
    social,
    bot: { key: "alice", runtimeKind: "cloud-claude-code" }
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(calls, [["cloudDelete", "alice"], ["bootstrap"]]);
  assert.deepEqual(social.moduleState.bots.map((item) => item.id), ["mia"]);
  assert.deepEqual(social.moduleState.conversations.map((item) => item.id), ["botc_mia"]);
  assert.equal(social.moduleState.messageCache.has("botc_alice"), false);
  assert.equal(social.moduleState.unreadByConversation.has("botc_alice"), false);
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

test("saveBotCapabilities updates cloud-claude-code identity and local bot cache", async () => {
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
      runtimeKind: "cloud-claude-code",
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

test("saveBotCapabilities strips copied engine identity for cloud-claude-code bots", async () => {
  const capabilities = { inheritEngineDefaults: true };
  const calls = [];
  const api = {
    social: {
      async saveBotIdentity(key, body) {
        calls.push(["identity", key, body]);
        return { ok: true, data: { bot: { id: key, ...body } } };
      }
    }
  };

  await commands.saveBotCapabilities({
    state: { runtime: { cloud: { enabled: true } } },
    api,
    social: { moduleState: { bots: [] } },
    bot: {
      key: "4020623",
      name: "？？",
      runtimeKind: "cloud-claude-code",
      bio: "你是 Claude Code。专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。",
      personaText: "你是 Claude Code。专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。"
    },
    capabilities
  });

  const identity = calls.find((call) => call[0] === "identity")[2];
  assert.equal(identity.bio, "专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。");
  assert.equal(identity.personaText, "专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。");
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
      targetDeviceId: "mac-1",
      runtimeLabel: "Office Mac"
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

  const cloud = await commands.getBotRuntimeBinding({ api, cache, botKey: "alice", runtimeKind: "cloud-claude-code" });
  const cloudCached = await commands.getBotRuntimeBinding({ api, cache, botKey: "alice", runtimeKind: "cloud-claude-code" });
  const desktop = await commands.getBotRuntimeBinding({ api, cache, botKey: "alice", runtimeKind: "desktop-local" });

  assert.deepEqual(cloud, { botId: "alice", runtimeKind: "cloud-claude-code", config: { model: "mia-default" } });
  assert.equal(cloudCached, cloud);
  assert.deepEqual(desktop, { botId: "alice", runtimeKind: "desktop-local", config: { model: "mia-default" } });
  assert.deepEqual(calls, [["get", "alice", "cloud-claude-code"], ["get", "alice", "desktop-local"]]);
});

test("saveBotRuntimeControl saves desktop-local hermes controls through bot runtime binding", async () => {
  const calls = [];
  const api = {
    social: {
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
    ["save", "alice", {
      runtimeKind: "desktop-local",
      enabled: true,
      controlIntent: {
        field: "model",
        value: "deepseek-chat",
        modelEntries: [{
          id: "deepseek-chat",
          model: "deepseek-chat",
          provider: "deepseek",
          providerLabel: "DeepSeek",
          authType: "api_key"
        }]
      }
    }],
    ["save", "alice", {
      runtimeKind: "desktop-local",
      enabled: true,
      controlIntent: {
        field: "effortLevel",
        value: "high",
        modelEntries: []
      }
    }],
    ["save", "alice", {
      runtimeKind: "desktop-local",
      enabled: true,
      controlIntent: {
        field: "permissionMode",
        value: "yolo",
        modelEntries: []
      }
    }]
  ]);
  assert.equal(Object.hasOwn(calls[0][2].controlIntent.modelEntries[0], "apiKeyEnv"), false);
  assert.equal(Object.hasOwn(calls[0][2].controlIntent.modelEntries[0], "baseUrl"), false);
  assert.equal(Object.hasOwn(calls[0][2].controlIntent.modelEntries[0], "apiMode"), false);
});

test("saveBotRuntimeControl sends sanitized model control intent to Rust Core", async () => {
  const calls = [];
  const api = {
    social: {
      async saveBotRuntime(botId, body) {
        calls.push(["save", botId, body]);
        return { ok: true, data: { binding: { botId, ...body } } };
      }
    }
  };

  await commands.saveBotRuntimeControl({
    api,
    bot: { key: "alice", runtimeKind: "desktop-local", agentEngine: "hermes" },
    field: "model",
    value: "deepseek-chat",
    modelEntries: [
      {
        id: "deepseek-chat",
        provider: "deepseek",
        model: "deepseek-chat",
        providerLabel: "DeepSeek",
        authType: "api_key",
        modelProfileId: "deepseek:deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseUrl: "https://api.deepseek.com",
        apiMode: "openai"
      }
    ]
  });

  assert.deepEqual(calls, [
    ["save", "alice", {
      runtimeKind: "desktop-local",
      enabled: true,
      controlIntent: {
        field: "model",
        value: "deepseek-chat",
        modelEntries: [{
          id: "deepseek-chat",
          model: "deepseek-chat",
          provider: "deepseek",
          providerLabel: "DeepSeek",
          authType: "api_key",
          modelProfileId: "deepseek:deepseek-chat"
        }]
      }
    }]
  ]);
  const entry = calls[0][2].controlIntent.modelEntries[0];
  assert.equal(Object.hasOwn(entry, "apiKeyEnv"), false);
  assert.equal(Object.hasOwn(entry, "baseUrl"), false);
  assert.equal(Object.hasOwn(entry, "apiMode"), false);
});

test("saveBotRuntimeControl sends non-model controls as Rust Core intent", async () => {
  const calls = [];
  const api = {
    social: {
      async saveBotRuntime(botId, body) {
        calls.push(["save", botId, body]);
        return { ok: true, data: { binding: { botId, ...body } } };
      }
    }
  };

  await commands.saveBotRuntimeControl({
    api,
    bot: { key: "alice", runtimeKind: "desktop-local", agentEngine: "hermes" },
    field: "effortLevel",
    value: "high",
    modelEntries: []
  });

  assert.deepEqual(calls, [
    ["save", "alice", {
      runtimeKind: "desktop-local",
      enabled: true,
      controlIntent: {
        field: "effortLevel",
        value: "high",
        modelEntries: []
      }
    }]
  ]);
});

test("saveBotRuntimeControl saves desktop-local external engine controls through bot runtime binding", async () => {
  const calls = [];
  const api = {
    social: {
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
      { id: "gpt-5.3-codex", model: "gpt-5.3-codex", label: "GPT-5.3 Codex", provider: "codex", modelProfileId: "codex:gpt-5.3-codex" }
    ]
  });

  assert.equal(result.saved, true);
  assert.deepEqual(calls, [
    ["save", "codex", {
      runtimeKind: "desktop-local",
      enabled: true,
      controlIntent: {
        field: "model",
        value: "gpt-5.3-codex",
        modelEntries: [
          { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", model: "gpt-5.3-codex", provider: "codex", modelProfileId: "codex:gpt-5.3-codex" }
        ]
      }
    }]
  ]);
});

test("saveBotRuntimeControl delegates desktop-local external permissionMode policy to Rust Core", async () => {
  const calls = [];
  const api = {
    social: {
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

  assert.equal(result.saved, true);
  assert.deepEqual(calls, [
    ["save", "codex", {
      runtimeKind: "desktop-local",
      enabled: true,
      controlIntent: {
        field: "permissionMode",
        value: ":danger-full-access",
        modelEntries: []
      }
    }]
  ]);
});


test("bot commands do not expose direct runtime config saves", () => {
  assert.equal(commands.saveBotRuntimeConfig, undefined);
});

test("bot commands keep desktop runtime sync intent assembly internal", () => {
  assert.equal(commands.desktopLocalRuntimeSyncIntent, undefined);
});

test("syncDesktopLocalBotRuntimeBinding sends only target intent to Rust Core", async () => {
  const calls = [];
  const api = {
    async saveBotRuntime(botId, body) {
      calls.push(["runtime", botId, body]);
      return { ok: true, data: { binding: { botId, ...body } } };
    }
  };

  const result = await commands.syncDesktopLocalBotRuntimeBinding({
    api,
    state: { runtime: { localDevice: { id: "mac-1", name: "Mac.local" } } },
    bot: { key: "alice", name: "Alice" }
  });

  assert.equal(result.botId, "alice");
  assert.deepEqual(calls, [
    ["runtime", "alice", {
      runtimeKind: "desktop-local",
      activate: false,
      preserveEnabled: true,
      enabled: true,
      syncIntent: {
        agentEngine: "hermes",
        deviceId: "mac-1",
        deviceName: "Mac"
      }
    }]
  ]);
  assert.equal(Object.hasOwn(calls[0][2], "config"), false);
  assert.equal(Object.hasOwn(calls[0][2].syncIntent, "model"), false);
  assert.equal(Object.hasOwn(calls[0][2].syncIntent, "effortLevel"), false);
  assert.equal(Object.hasOwn(calls[0][2].syncIntent, "permissionMode"), false);
  assert.equal(Object.hasOwn(calls[0][2].syncIntent, "modelEntries"), false);
  assert.equal(Object.hasOwn(calls[0][2].syncIntent, "baseUrl"), false);
  assert.equal(Object.hasOwn(calls[0][2].syncIntent, "apiKeyEnv"), false);
  assert.equal(Object.hasOwn(calls[0][2].syncIntent, "apiMode"), false);
});

test("syncDesktopLocalBotRuntimeBinding preserves Codex as a desktop target", async () => {
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
    bot: { key: "codex", name: "Codex", agentEngine: "codex" }
  });

  assert.equal(calls[0][2].syncIntent.agentEngine, "codex");
  assert.equal(calls[0][2].syncIntent.deviceId, "mac-1");
  assert.equal(Object.hasOwn(calls[0][2].syncIntent, "effortLevel"), false);
  assert.equal(Object.hasOwn(calls[0][2].syncIntent, "modelEntries"), false);
  assert.equal(Object.hasOwn(calls[0][2], "config"), false);
});

test("syncDesktopLocalBotRuntimeBinding does not guess Hermes for an invalid binding with no engine", async () => {
  const calls = [];
  const api = {
    async saveBotRuntime(botId, body) {
      calls.push([botId, body]);
      return { ok: true, data: { binding: { botId, ...body } } };
    }
  };

  const result = await commands.syncDesktopLocalBotRuntimeBinding({
    api,
    state: { runtime: { localDevice: { id: "mac-1", name: "Mac" } } },
    bot: {
      key: "broken-runtime",
      name: "Broken Runtime",
      runtimeKind: "desktop-local",
      runtimeStatus: "invalid_config",
      agentEngine: ""
    }
  });

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test("ensureDesktopLocalBotConversation creates conversation and syncs external engine runtime intent", async () => {
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
    state: { runtime: {} },
    bot: {
      key: "codex",
      name: "Codex",
      agentEngine: "codex"
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
  assert.deepEqual(calls[1][2].syncIntent, {
    agentEngine: "codex"
  });
  assert.equal(Object.hasOwn(calls[1][2], "config"), false);
  assert.equal(Object.hasOwn(calls[1][2].syncIntent, "model"), false);
  assert.equal(Object.hasOwn(calls[1][2].syncIntent, "effortLevel"), false);
  assert.equal(Object.hasOwn(calls[1][2].syncIntent, "permissionMode"), false);
  assert.equal(Object.hasOwn(calls[1][2].syncIntent, "modelEntries"), false);
  assert.equal(result.conversation.upserted, true);
  assert.equal(upserted[0].id, "botc_codex");
});

test("ensureDesktopLocalBotConversation uses cloud bot conversation route when available", async () => {
  const calls = [];
  const api = {
    async ensureBotConversation(botId, body) {
      calls.push(["cloud-conversation", botId, body]);
      return {
        ok: true,
        data: {
          conversation: {
            id: `botc_${botId}`,
            type: "bot",
            decorations: { botId, sessionId: botId, runtimeKind: "desktop-local" }
          }
        }
      };
    },
    async ensureBotSessionConversation(sessionId) {
      calls.push(["core-session-conversation", sessionId]);
      throw new Error(`Mia Core HTTP POST /api/bots/${sessionId}/session-conversation failed 404: Not Found`);
    },
    async saveBotRuntime(botId, body) {
      calls.push(["runtime", botId, body]);
      return { ok: true, data: { binding: { botId, ...body } } };
    }
  };

  const result = await commands.ensureDesktopLocalBotConversation({
    api,
    state: { runtime: { localDevice: { id: "mac-1", name: "Mac" } } },
    bot: {
      key: "hermes",
      name: "Hermes",
      agentEngine: "hermes"
    }
  });

  assert.equal(result.conversation.id, "botc_hermes");
  assert.deepEqual(calls.map((call) => call[0]), ["cloud-conversation", "runtime"]);
  assert.deepEqual(calls[0], ["cloud-conversation", "hermes", {
    botId: "hermes",
    title: "Hermes",
    runtimeKind: "desktop-local"
  }]);
});

test("saveBotRuntimeControl saves cloud-claude-code controls through cloud runtime config", async () => {
  const calls = [];
  const api = {
    social: {
      async saveBotRuntime(botId, body) {
        calls.push(["save", botId, body]);
        return { ok: true, data: { binding: { botId, ...body } } };
      }
    }
  };

  await commands.saveBotRuntimeControl({
    api,
    bot: { key: "mia", runtimeKind: "cloud-claude-code" },
    field: "model",
    value: "mia-pro",
    modelEntries: [{ id: "mia-pro", model: "mia-pro", label: "Mia Pro" }]
  });

  assert.deepEqual(calls, [
    ["save", "mia", {
      runtimeKind: "cloud-claude-code",
      enabled: true,
      controlIntent: {
        field: "model",
        value: "mia-pro",
        modelEntries: [{ id: "mia-pro", label: "Mia Pro", model: "mia-pro" }]
      }
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
