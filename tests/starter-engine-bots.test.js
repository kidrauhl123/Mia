const { test } = require("node:test");
const assert = require("node:assert/strict");

const starter = require("../src/renderer/bot/starter-engine-bots.js");

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

test("ensureStarterEngineBots creates missing engine bots once and stores the account marker", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: { enabled: true },
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
  assert.deepEqual(result.created.map((entry) => entry.engineId), ["cloud-hermes", "hermes"]);
  assert.equal(calls.filter((call) => call[0] === "saveBot").length, 2);
  const saveBots = calls.filter((call) => call[0] === "saveBot");
  assert.equal(saveBots[0][1], "cloud-hermes");
  assert.equal(saveBots[0][2].name, "Mia");
  assert.equal(saveBots[0][2].key, "starter_u_123_mia");
  assert.equal(saveBots[1][1], "desktop-local");
  assert.equal(saveBots[1][2].name, "Hermes");
  assert.equal(saveBots[1][2].key, "starter_u_123_hermes");
  const settingsPut = calls.find((call) => call[0] === "settingsPut");
  assert.deepEqual(settingsPut[1].starterEngineBots, {
    seededAt: "2026-06-26T08:00:00.000Z",
    engineIds: ["cloud-hermes", "hermes", "codex"]
  });
  assert.ok(settingsPut[1].tags.items.some((tag) => tag.name === "云端"));
  assert.equal(settingsPut[1].expectedVersion, 7);
});

test("ensureStarterEngineBots creates an editable cloud Mia bot and tags its conversation", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: { enabled: true },
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
  assert.equal(result.created[0].engineId, "cloud-hermes");
  const saveBot = calls.find((call) => call[0] === "saveBot");
  assert.equal(saveBot[1], "cloud-hermes");
  assert.deepEqual(saveBot[2], {
    key: "starter_u_123_mia",
    name: "Mia",
    description: "Mia 云端助手，默认使用云端 Hermes。",
    bio: "云端 Hermes，随时可用，不依赖本机 Agent。",
    color: "#16a34a",
    personaText: "你是 Mia。用云端 Hermes 简洁、可靠地帮助用户处理日常问题、创作、信息整理和自动化请求。",
    agentEngine: "hermes",
    targetDeviceId: "",
    targetDeviceName: "Mia Cloud",
    capabilities: { inheritEngineDefaults: true }
  });
  const settingsPut = calls.find((call) => call[0] === "settingsPut");
  assert.deepEqual(settingsPut[1].starterEngineBots, {
    seededAt: "2026-06-26T08:00:00.000Z",
    engineIds: ["cloud-hermes"]
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
      cloud: { enabled: true },
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
      cloud: { enabled: true },
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

  assert.deepEqual(result.created.map((entry) => entry.engineId), ["cloud-hermes"]);
  assert.equal(calls.filter((call) => call[0] === "saveBot").length, 1);
  assert.equal(calls.find((call) => call[0] === "saveBot")[1], "cloud-hermes");
  const settingsPut = calls.find((call) => call[0] === "settingsPut");
  assert.deepEqual(settingsPut[1].starterEngineBots, {
    seededAt: "2026-06-25T00:00:00.000Z",
    engineIds: ["hermes", "codex", "cloud-hermes"]
  });
});

test("ensureStarterEngineBots does not recreate bots after the account marker exists", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: { enabled: true },
      agentInventory: { agents: [{ id: "hermes", label: "Hermes", usableInMia: true }] }
    }
  };
  const result = await starter.ensureStarterEngineBots({
    state,
    api: {
      social: {
        async settingsGet() {
          calls.push(["settingsGet"]);
          return { settings: { version: 3, starterEngineBots: { seededAt: "2026-06-25T00:00:00.000Z", engineIds: ["cloud-hermes", "hermes"] } } };
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
