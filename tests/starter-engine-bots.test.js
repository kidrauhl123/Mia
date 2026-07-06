const { test } = require("node:test");
const assert = require("node:assert/strict");

global.miaCloudRuntime = require("../src/shared/cloud-runtime.js");
const starter = require("../src/renderer/bot/starter-engine-bots.js");

const CLOUD_AGENT_RUNTIME = {
  mode: "claude-code",
  runtimeKind: "cloud-claude-code",
  agentEngine: "claude-code",
  label: "Claude Code",
  available: true
};

function cloudSettings() {
  return { enabled: true, agentRuntime: CLOUD_AGENT_RUNTIME };
}

test("starterEngineBotSpecs lists only usable local engines in product order", () => {
  const specs = starter.starterEngineBotSpecs({
    agentInventory: {
      agents: [
        { id: "codex", label: "Codex", usableInMia: true },
        { id: "openclaw", label: "OpenClaw", usableInMia: false, installed: true },
        { id: "hermes", label: "Hermes", usableInMia: true },
        { id: "claude-code", label: "Claude Code", usableInMia: true }
      ]
    }
  });

  assert.deepEqual(specs.map((spec) => [spec.engineId, spec.name]), [
    ["hermes", "Hermes"],
    ["codex", "Codex"],
    ["claude-code", "Claude Code"]
  ]);
});

test("starterBotSpecs assigns flame status badges to default bots", () => {
  const specs = starter.starterBotSpecs({
    cloud: cloudSettings(),
    agentInventory: {
      agents: [
        { id: "hermes", label: "Hermes", usableInMia: true },
        { id: "openclaw", label: "OpenClaw", usableInMia: true },
        { id: "codex", label: "Codex", usableInMia: true },
        { id: "claude-code", label: "Claude Code", usableInMia: true }
      ]
    }
  });

  assert.deepEqual(
    specs.map((spec) => [spec.engineId, spec.statusBadge?.assetId]),
    [
      ["cloud-claude-code", "rainbow-fire"],
      ["hermes", "blue-fire"],
      ["openclaw", "pink-fire"],
      ["codex", "cyan-fire"],
      ["claude-code", "red-orange-fire"]
    ]
  );
});

test("starterBotSpecs assigns default avatar logos to starter bots", () => {
  const specs = starter.starterBotSpecs({
    cloud: cloudSettings(),
    agentInventory: {
      agents: [
        { id: "hermes", label: "Hermes", usableInMia: true },
        { id: "openclaw", label: "OpenClaw", usableInMia: true },
        { id: "codex", label: "Codex", usableInMia: true },
        { id: "claude-code", label: "Claude Code", usableInMia: true }
      ]
    }
  });

  assert.deepEqual(
    specs.map((spec) => [spec.engineId, spec.avatarImage || ""]),
    [
      ["cloud-claude-code", "./assets/mia-logo.png"],
      ["hermes", "./assets/engine-icons/hermesagent-starter.svg"],
      ["openclaw", "./assets/provider-icons/openclaw-starter.svg"],
      ["codex", "./assets/engine-icons/codex-color.svg"],
      ["claude-code", "./assets/engine-icons/claudecode-starter.svg"]
    ]
  );
});

test("ensureStarterEngineBots creates missing engine bots once and stores the account marker", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: cloudSettings(),
      localDevice: { id: "mac-1", name: "Jung Mac" },
      agentInventory: {
        agents: [
          { id: "hermes", label: "Hermes", usableInMia: true },
          { id: "codex", label: "Codex", usableInMia: true },
          { id: "openclaw", label: "OpenClaw", usableInMia: false }
        ]
      }
    }
  };
  const social = {
    moduleState: {
      myUserId: "u_123",
      bots: [{ id: "existing_codex", key: "existing_codex", name: "Codex", agentEngine: "codex" }]
    },
    upsertBotConversation(conversation) {
      calls.push(["upsertConversation", conversation.id]);
      return conversation;
    }
  };
  const api = {
    social: {
      async settingsGet() {
        calls.push(["settingsGet"]);
        return { ok: true, data: { settings: { version: 7, readMarks: {}, starterEngineBots: {} } } };
      },
      async settingsPut(body) {
        calls.push(["settingsPut", body]);
        return { ok: true, data: { settings: { ...body, version: 8 } } };
      }
    }
  };
  const commands = {
    async saveBot(options) {
      calls.push(["saveBot", options.runtimeKind, options.bot]);
      return {
        key: options.bot.key,
        bot: { id: options.bot.key, key: options.bot.key, name: options.bot.name, agentEngine: options.bot.agentEngine },
        conversation: { id: `botc_${options.bot.key}`, type: "bot" }
      };
    }
  };

  const result = await starter.ensureStarterEngineBots({ state, api, social, commands, now: () => "2026-06-26T08:00:00.000Z" });

  assert.equal(result.created.length, 2);
  assert.deepEqual(result.created.map((entry) => entry.engineId), ["cloud-claude-code", "hermes"]);
  assert.equal(calls.filter((call) => call[0] === "saveBot").length, 2);
  const saveBots = calls.filter((call) => call[0] === "saveBot");
  assert.equal(saveBots[0][1], "cloud-claude-code");
  assert.equal(saveBots[0][2].name, "Mia");
  assert.equal(saveBots[0][2].key, "starter_u_123_mia");
  assert.equal(saveBots[0][2].avatarImage, "./assets/mia-logo.png");
  assert.equal(saveBots[0][2].avatarCrop, null);
  assert.deepEqual(saveBots[0][2].statusBadge, { kind: "lottie", assetId: "rainbow-fire", label: "七彩火焰", loop: "always" });
  assert.equal(saveBots[1][1], "desktop-local");
  assert.equal(saveBots[1][2].name, "Hermes");
  assert.equal(saveBots[1][2].key, "starter_u_123_hermes");
  assert.equal(saveBots[1][2].avatarImage, "./assets/engine-icons/hermesagent-starter.svg");
  assert.equal(saveBots[1][2].avatarCrop, null);
  assert.deepEqual(saveBots[1][2].statusBadge, { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰", loop: "always" });
  const settingsPut = calls.find((call) => call[0] === "settingsPut");
  assert.deepEqual(settingsPut[1].starterEngineBots, {
    seededAt: "2026-06-26T08:00:00.000Z",
    engineIds: ["cloud-claude-code", "hermes", "codex"]
  });
  assert.ok(settingsPut[1].tags.items.some((tag) => tag.name === "云端"));
  assert.equal(settingsPut[1].expectedVersion, 7);
});

test("ensureStarterEngineBots creates an editable cloud Mia bot and tags its conversation", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: cloudSettings(),
      agentInventory: { agents: [] }
    }
  };
  const social = {
    moduleState: {
      myUserId: "u_123",
      bots: []
    },
    upsertBotConversation(conversation) {
      calls.push(["upsertConversation", conversation.id]);
      return conversation;
    }
  };
  const api = {
    social: {
      async settingsGet() {
        calls.push(["settingsGet"]);
        return { ok: true, data: { settings: { version: 11, readMarks: {}, tags: { items: [], assignments: {} }, starterEngineBots: {} } } };
      },
      async settingsPut(body) {
        calls.push(["settingsPut", body]);
        return { ok: true, data: { settings: { ...body, version: 12 } } };
      }
    }
  };
  const commands = {
    async saveBot(options) {
      calls.push(["saveBot", options.runtimeKind, options.bot]);
      return {
        key: options.bot.key,
        bot: {
          id: options.bot.key,
          key: options.bot.key,
          name: options.bot.name,
          agentEngine: options.bot.agentEngine,
          runtimeKind: options.runtimeKind
        },
        conversation: { id: `botc_${options.bot.key}`, type: "bot" }
      };
    }
  };

  const result = await starter.ensureStarterEngineBots({ state, api, social, commands, now: () => "2026-06-26T08:00:00.000Z" });

  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].engineId, "cloud-claude-code");
  const saveBot = calls.find((call) => call[0] === "saveBot");
  assert.equal(saveBot[1], "cloud-claude-code");
  assert.deepEqual(saveBot[2], {
    key: "starter_u_123_mia",
    name: "Mia",
    description: "Mia 云端助手，默认使用云端 Claude Code sandbox。",
    bio: "云端 Claude Code，随时可用，不依赖本机 Agent。",
    color: "#16a34a",
    avatarImage: "./assets/mia-logo.png",
    avatarCrop: null,
    statusBadge: { kind: "lottie", assetId: "rainbow-fire", label: "七彩火焰", loop: "always" },
    personaText: "你是 Mia。用云端 Claude Code sandbox 简洁、可靠地帮助用户处理日常问题、创作、信息整理和自动化请求。",
    agentEngine: "claude-code",
    targetDeviceId: "",
    targetDeviceName: "Mia Cloud",
    capabilities: { inheritEngineDefaults: true }
  });
  const settingsPut = calls.find((call) => call[0] === "settingsPut");
  assert.deepEqual(settingsPut[1].starterEngineBots, {
    seededAt: "2026-06-26T08:00:00.000Z",
    engineIds: ["cloud-claude-code"]
  });
  const cloudTag = settingsPut[1].tags.items.find((tag) => tag.name === "云端");
  assert.ok(cloudTag);
  assert.deepEqual(settingsPut[1].tags.assignments.botc_starter_u_123_mia, [cloudTag.id]);
  assert.equal(settingsPut[1].expectedVersion, 11);
});

test("ensureStarterEngineBots preserves the cloud tag when marker write retries after conflict", async () => {
  const calls = [];
  let settingsPutCount = 0;
  const state = {
    runtime: {
      cloud: cloudSettings(),
      agentInventory: { agents: [] }
    }
  };
  const api = {
    social: {
      async settingsGet() {
        calls.push(["settingsGet"]);
        if (settingsPutCount > 0) {
          return { settings: { version: 12, readMarks: {}, tags: { items: [], assignments: {} }, starterEngineBots: {} } };
        }
        return { settings: { version: 11, readMarks: {}, tags: { items: [], assignments: {} }, starterEngineBots: {} } };
      },
      async settingsPut(body) {
        settingsPutCount += 1;
        calls.push(["settingsPut", body]);
        if (settingsPutCount === 1) throw new Error("409 version conflict");
        return { settings: { ...body, version: 13 } };
      }
    }
  };
  const commands = {
    async saveBot(options) {
      return {
        key: options.bot.key,
        bot: { id: options.bot.key, key: options.bot.key, name: options.bot.name, runtimeKind: options.runtimeKind },
        conversation: { id: `botc_${options.bot.key}`, type: "bot" }
      };
    }
  };

  await starter.ensureStarterEngineBots({
    state,
    api,
    social: { moduleState: { myUserId: "u_123", bots: [] } },
    commands,
    now: () => "2026-06-26T08:00:00.000Z"
  });

  const retriedPut = calls.filter((call) => call[0] === "settingsPut").at(-1);
  const cloudTag = retriedPut[1].tags.items.find((tag) => tag.name === "云端");
  assert.ok(cloudTag);
  assert.deepEqual(retriedPut[1].tags.assignments.botc_starter_u_123_mia, [cloudTag.id]);
  assert.equal(retriedPut[1].expectedVersion, 12);
});

test("ensureStarterEngineBots backfills cloud Mia once for accounts seeded before it existed", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: cloudSettings(),
      agentInventory: { agents: [{ id: "codex", usableInMia: true }] }
    }
  };
  const api = {
    social: {
      async settingsGet() {
        calls.push(["settingsGet"]);
        return {
          settings: {
            version: 14,
            readMarks: {},
            tags: { items: [], assignments: {} },
            starterEngineBots: { seededAt: "2026-06-25T00:00:00.000Z", engineIds: ["hermes", "codex"] }
          }
        };
      },
      async settingsPut(body) {
        calls.push(["settingsPut", body]);
        return { settings: { ...body, version: 15 } };
      }
    }
  };
  const commands = {
    async saveBot(options) {
      calls.push(["saveBot", options.runtimeKind, options.bot]);
      return {
        key: options.bot.key,
        bot: { id: options.bot.key, key: options.bot.key, name: options.bot.name, runtimeKind: options.runtimeKind },
        conversation: { id: `botc_${options.bot.key}`, type: "bot" }
      };
    }
  };

  const result = await starter.ensureStarterEngineBots({
    state,
    api,
    social: { moduleState: { myUserId: "u_123", bots: [] } },
    commands,
    now: () => "2026-06-26T08:00:00.000Z"
  });

  assert.deepEqual(result.created.map((entry) => entry.engineId), ["cloud-claude-code"]);
  assert.equal(calls.filter((call) => call[0] === "saveBot").length, 1);
  assert.equal(calls.find((call) => call[0] === "saveBot")[1], "cloud-claude-code");
  const settingsPut = calls.find((call) => call[0] === "settingsPut");
  assert.deepEqual(settingsPut[1].starterEngineBots, {
    seededAt: "2026-06-25T00:00:00.000Z",
    engineIds: ["hermes", "codex", "cloud-claude-code"]
  });
});

test("ensureStarterEngineBots does not recreate bots after the account marker exists", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: cloudSettings(),
      agentInventory: { agents: [{ id: "hermes", label: "Hermes", usableInMia: true }] }
    }
  };
  const result = await starter.ensureStarterEngineBots({
    state,
    api: {
      social: {
        async settingsGet() {
          calls.push(["settingsGet"]);
          return { settings: { version: 3, starterEngineBots: { seededAt: "2026-06-25T00:00:00.000Z", engineIds: ["cloud-claude-code", "hermes"] } } };
        },
        async settingsPut(body) {
          calls.push(["settingsPut", body]);
        }
      }
    },
    social: { moduleState: { myUserId: "u_1", bots: [] } },
    commands: {
      async saveBot(options) {
        calls.push(["saveBot", options]);
      }
    }
  });

  assert.deepEqual(result, { skipped: true, created: [] });
  assert.deepEqual(calls, [["settingsGet"]]);
});

test("ensureStarterEngineBots backfills missing badges on existing starter bots without recreating", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: cloudSettings(),
      agentInventory: {
        agents: [
          { id: "hermes", label: "Hermes", usableInMia: true },
          { id: "codex", label: "Codex", usableInMia: true }
        ]
      }
    }
  };
  const social = {
    moduleState: {
      myUserId: "u_1",
      bots: [
        {
          id: "starter_u_1_hermes",
          key: "starter_u_1_hermes",
          name: "Hermes",
          agentEngine: "hermes",
          color: "#2563eb",
          bio: "existing bio",
          personaText: "existing persona",
          statusBadge: null
        },
        {
          id: "starter_u_1_codex",
          key: "starter_u_1_codex",
          name: "Codex",
          agentEngine: "codex",
          color: "#111827",
          avatarImage: "data:image/png;base64,custom",
          avatarCrop: { x: 50, y: 50, zoom: 1 },
          statusBadge: { kind: "emoji", emoji: "⭐", label: "Custom" }
        }
      ]
    }
  };
  const api = {
    social: {
      async settingsGet() {
        calls.push(["settingsGet"]);
        return { settings: { version: 3, starterEngineBots: { seededAt: "2026-06-25T00:00:00.000Z", engineIds: ["cloud-claude-code", "hermes", "codex"] } } };
      },
      async settingsPut(body) {
        calls.push(["settingsPut", body]);
      },
      async saveBotIdentity(key, body) {
        calls.push(["saveBotIdentity", key, body]);
        return { ok: true, bot: { id: key, key, name: body.name, statusBadge: body.statusBadge } };
      }
    }
  };

  const result = await starter.ensureStarterEngineBots({
    state,
    api,
    social,
    commands: {
      async saveBot() {
        throw new Error("should not recreate starter bots");
      }
    }
  });

  assert.deepEqual(result.updated.map((entry) => [entry.engineId, entry.key]), [["hermes", "starter_u_1_hermes"]]);
  assert.equal(calls.filter((call) => call[0] === "settingsPut").length, 0);
  assert.equal(calls.filter((call) => call[0] === "saveBotIdentity").length, 1);
  const update = calls.find((call) => call[0] === "saveBotIdentity");
  assert.equal(update[1], "starter_u_1_hermes");
  assert.equal(update[2].name, "Hermes");
  assert.equal(update[2].avatarImage, "./assets/engine-icons/hermesagent-starter.svg");
  assert.equal(update[2].avatarCrop, null);
  assert.equal(update[2].bio, "existing bio");
  assert.equal(update[2].personaText, "existing persona");
  assert.deepEqual(update[2].statusBadge, { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰", loop: "always" });
  assert.deepEqual(social.moduleState.bots.find((bot) => bot.key === "starter_u_1_hermes").statusBadge, {
    kind: "lottie",
    assetId: "blue-fire",
    label: "蓝色火焰",
    loop: "always"
  });
});

test("ensureStarterEngineBots backfills missing avatar logos on existing starter bots without overwriting custom avatars", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: cloudSettings(),
      agentInventory: {
        agents: [
          { id: "hermes", label: "Hermes", usableInMia: true },
          { id: "codex", label: "Codex", usableInMia: true }
        ]
      }
    }
  };
  const social = {
    moduleState: {
      myUserId: "u_1",
      bots: [
        {
          id: "starter_u_1_hermes",
          key: "starter_u_1_hermes",
          name: "Hermes",
          agentEngine: "hermes",
          color: "#2563eb",
          bio: "existing bio",
          personaText: "existing persona",
          avatarImage: "",
          avatarCrop: null,
          statusBadge: { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰", loop: "always" }
        },
        {
          id: "starter_u_1_codex",
          key: "starter_u_1_codex",
          name: "Codex",
          agentEngine: "codex",
          color: "#111827",
          avatarImage: "data:image/png;base64,custom",
          avatarCrop: { x: 50, y: 50, zoom: 1 },
          statusBadge: { kind: "lottie", assetId: "cyan-fire", label: "青色火焰", loop: "always" }
        }
      ]
    }
  };
  const api = {
    social: {
      async settingsGet() {
        calls.push(["settingsGet"]);
        return { settings: { version: 3, starterEngineBots: { seededAt: "2026-06-25T00:00:00.000Z", engineIds: ["cloud-claude-code", "hermes", "codex"] } } };
      },
      async settingsPut(body) {
        calls.push(["settingsPut", body]);
      },
      async saveBotIdentity(key, body) {
        calls.push(["saveBotIdentity", key, body]);
        return {
          ok: true,
          bot: {
            id: key,
            key,
            name: body.name,
            avatarImage: body.avatarImage,
            avatarCrop: body.avatarCrop,
            statusBadge: body.statusBadge
          }
        };
      }
    }
  };

  const result = await starter.ensureStarterEngineBots({
    state,
    api,
    social,
    commands: {
      async saveBot() {
        throw new Error("should not recreate starter bots");
      }
    }
  });

  assert.deepEqual(result.updated.map((entry) => [entry.engineId, entry.key]), [["hermes", "starter_u_1_hermes"]]);
  assert.equal(calls.filter((call) => call[0] === "settingsPut").length, 0);
  assert.equal(calls.filter((call) => call[0] === "saveBotIdentity").length, 1);
  const update = calls.find((call) => call[0] === "saveBotIdentity");
  assert.equal(update[1], "starter_u_1_hermes");
  assert.equal(update[2].avatarImage, "./assets/engine-icons/hermesagent-starter.svg");
  assert.equal(update[2].avatarCrop, null);
  assert.deepEqual(social.moduleState.bots.find((bot) => bot.key === "starter_u_1_hermes").avatarImage, "./assets/engine-icons/hermesagent-starter.svg");
  assert.equal(social.moduleState.bots.find((bot) => bot.key === "starter_u_1_codex").avatarImage, "data:image/png;base64,custom");
});

test("ensureStarterEngineBots backfills avatar for legacy cloud-hermes Mia starter bots", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: cloudSettings(),
      agentInventory: { agents: [] }
    }
  };
  const social = {
    moduleState: {
      myUserId: "u_1",
      bots: [
        {
          id: "starter_u_1_mia",
          key: "starter_u_1_mia",
          name: "Mia",
          agentEngine: "hermes",
          runtimeKind: "cloud-hermes",
          color: "#16a34a",
          avatarImage: "",
          avatarCrop: null,
          statusBadge: { kind: "lottie", assetId: "rainbow-fire", label: "七彩火焰", loop: "always" }
        }
      ]
    }
  };
  const api = {
    social: {
      async settingsGet() {
        calls.push(["settingsGet"]);
        return { settings: { version: 3, starterEngineBots: { seededAt: "2026-06-25T00:00:00.000Z", engineIds: ["cloud-claude-code"] } } };
      },
      async saveBotIdentity(key, body) {
        calls.push(["saveBotIdentity", key, body]);
        return { ok: true, bot: { id: key, key, name: body.name, avatarImage: body.avatarImage, avatarCrop: body.avatarCrop, statusBadge: body.statusBadge } };
      }
    }
  };

  const result = await starter.ensureStarterEngineBots({
    state,
    api,
    social,
    commands: {
      async saveBot() {
        throw new Error("should not recreate starter bots");
      }
    }
  });

  assert.deepEqual(result.updated.map((entry) => [entry.engineId, entry.key]), [["cloud-claude-code", "starter_u_1_mia"]]);
  const update = calls.find((call) => call[0] === "saveBotIdentity");
  assert.equal(update[1], "starter_u_1_mia");
  assert.equal(update[2].avatarImage, "./assets/mia-logo.png");
  assert.equal(update[2].avatarCrop, null);
});

test("ensureStarterEngineBots backfills existing starter avatars even when the engine is not currently usable", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: cloudSettings(),
      agentInventory: {
        agents: [
          { id: "hermes", label: "Hermes", usableInMia: true }
        ]
      }
    }
  };
  const social = {
    moduleState: {
      myUserId: "u_1",
      bots: [
        {
          id: "starter_u_1_codex",
          key: "starter_u_1_codex",
          name: "Codex",
          agentEngine: "codex",
          runtimeKind: "desktop-local",
          color: "#111827",
          avatarImage: "",
          avatarCrop: null,
          statusBadge: { kind: "lottie", assetId: "cyan-fire", label: "青色火焰", loop: "always" }
        }
      ]
    }
  };
  const api = {
    social: {
      async settingsGet() {
        calls.push(["settingsGet"]);
        return { settings: { version: 3, starterEngineBots: { seededAt: "2026-06-25T00:00:00.000Z", engineIds: ["hermes", "codex"] } } };
      },
      async saveBotIdentity(key, body) {
        calls.push(["saveBotIdentity", key, body]);
        return { ok: true, bot: { id: key, key, name: body.name, avatarImage: body.avatarImage, avatarCrop: body.avatarCrop, statusBadge: body.statusBadge } };
      }
    }
  };

  const result = await starter.ensureStarterEngineBots({
    state,
    api,
    social,
    commands: {
      async saveBot() {
        throw new Error("should not recreate starter bots");
      }
    }
  });

  assert.deepEqual(result.updated.map((entry) => [entry.engineId, entry.key]), [["codex", "starter_u_1_codex"]]);
  const update = calls.find((call) => call[0] === "saveBotIdentity");
  assert.equal(update[1], "starter_u_1_codex");
  assert.equal(update[2].avatarImage, "./assets/engine-icons/codex-color.svg");
  assert.equal(update[2].avatarCrop, null);
});
