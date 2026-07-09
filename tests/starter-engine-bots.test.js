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

test("starterBotSpecs keeps display assets for Core-returned starter identities", () => {
  const specs = starter.starterBotSpecs({
    cloud: cloudSettings(),
    agentInventory: {
      agents: [
        { id: "hermes", label: "Hermes", usableInMia: true },
        { id: "codex", label: "Codex", usableInMia: true },
        { id: "claude-code", label: "Claude Code", usableInMia: true }
      ]
    }
  });

  assert.deepEqual(
    specs.map((spec) => [spec.engineId, spec.statusBadge?.assetId, spec.avatarImage || ""]),
    [
      ["cloud-claude-code", "rainbow-fire", "./assets/mia-logo.png"],
      ["hermes", "blue-fire", "./assets/engine-icons/hermesagent.svg"],
      ["codex", "cyan-fire", "./assets/engine-icons/codex-color.svg"],
      ["claude-code", "red-orange-fire", "./assets/engine-icons/claudecode.svg"]
    ]
  );
});

test("ensureStarterEngineBots delegates starter materialization to Rust Core only", async () => {
  const calls = [];
  const state = {
    runtime: {
      cloud: cloudSettings(),
      localDevice: { id: "mac-1", name: "Jung Mac" },
      agentInventory: {
        agents: [{ id: "hermes", label: "Hermes", usableInMia: true }]
      }
    }
  };
  const social = {
    moduleState: {
      myUserId: "u_123",
      bots: []
    }
  };
  const api = {
    social: {
      async ensureStarterEngineBots(body) {
        calls.push(["ensureStarterEngineBots", body]);
        return {
          ok: true,
          data: {
            skipped: false,
            settings: { starterEngineBots: { seededAt: "2026-06-26T08:00:00.000Z", engineIds: ["cloud-claude-code", "hermes"] } },
            created: [{
              engineId: "cloud-claude-code",
              key: "starter_u_123_mia",
              conversationId: "botc_starter_u_123_mia",
              bot: {
                id: "starter_u_123_mia",
                displayName: "Mia",
                identity: { name: "Mia", avatarImage: "./assets/mia-logo.png", runtimeKind: "cloud-claude-code", agentEngine: "claude-code" },
                capabilities: { inheritEngineDefaults: true }
              }
            }]
          }
        };
      },
      async settingsGet() {
        throw new Error("renderer must not read starter marker directly");
      },
      async settingsPut() {
        throw new Error("renderer must not write starter marker directly");
      },
      async saveBotIdentity() {
        throw new Error("renderer must not backfill starter identity directly");
      }
    }
  };
  const commands = {
    async saveBot() {
      throw new Error("renderer must not create starter bots directly");
    }
  };

  const result = await starter.ensureStarterEngineBots({
    state,
    api,
    social,
    commands,
    now: () => "2026-06-26T08:00:00.000Z"
  });

  assert.equal(result.created.length, 1);
  assert.deepEqual(calls, [[
    "ensureStarterEngineBots",
    {
      runtime: state.runtime,
      userId: "u_123",
      now: "2026-06-26T08:00:00.000Z"
    }
  ]]);
  assert.equal(social.moduleState.cloudSettings, result.settings);
  assert.deepEqual(social.moduleState.bots.map((bot) => [bot.key, bot.name, bot.agentEngine]), [
    ["starter_u_123_mia", "Mia", "claude-code"]
  ]);
});

test("ensureStarterEngineBots normalizes stale starter avatar images from Core", async () => {
  const state = { runtime: { cloud: cloudSettings() } };
  const social = {
    moduleState: {
      myUserId: "u_123",
      bots: []
    }
  };
  const api = {
    social: {
      async ensureStarterEngineBots() {
        return {
          ok: true,
          data: {
            updated: [{
              engineId: "hermes",
              key: "starter_u_123_hermes",
              bot: {
                id: "starter_u_123_hermes",
                displayName: "Hermes",
                identity: {
                  name: "Hermes",
                  avatarImage: "./assets/engine-icons/hermesagent-starter.svg",
                  agentEngine: "hermes"
                }
              }
            }]
          }
        };
      }
    }
  };

  await starter.ensureStarterEngineBots({ state, api, social });

  assert.deepEqual(social.moduleState.bots.map((bot) => [bot.key, bot.avatarImage]), [
    ["starter_u_123_hermes", "./assets/engine-icons/hermesagent.svg"]
  ]);
});

test("ensureStarterEngineBots skips when Core starter endpoint is unavailable", async () => {
  const result = await starter.ensureStarterEngineBots({
    state: { runtime: { cloud: cloudSettings() } },
    api: { social: {} },
    social: { moduleState: { myUserId: "u_1", bots: [] } }
  });

  assert.deepEqual(result, { skipped: true, created: [] });
});
