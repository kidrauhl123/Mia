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

  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].engineId, "hermes");
  assert.equal(calls.filter((call) => call[0] === "saveBot").length, 1);
  assert.equal(calls.find((call) => call[0] === "saveBot")[2].name, "Hermes");
  assert.equal(calls.find((call) => call[0] === "saveBot")[2].key, "starter_u_123_hermes");
  const settingsPut = calls.find((call) => call[0] === "settingsPut");
  assert.deepEqual(settingsPut[1].starterEngineBots, {
    seededAt: "2026-06-26T08:00:00.000Z",
    engineIds: ["hermes", "codex"]
  });
  assert.equal(settingsPut[1].expectedVersion, 7);
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
          return { settings: { version: 3, starterEngineBots: { seededAt: "2026-06-25T00:00:00.000Z", engineIds: ["hermes"] } } };
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
