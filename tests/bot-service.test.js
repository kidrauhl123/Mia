const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBotManifest } = require("../src/main/bot-manifest.js");
const { createBotService } = require("../src/main/bot-service.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bot-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = {
    home: dir,
    botDir: path.join(dir, "bots"),
    botManifest: path.join(dir, "bots", "manifest.json"),
    legacyPersonaManifest: path.join(dir, "personas", "manifest.json"),
    legacyPersonaDir: path.join(dir, "personas", "accounts")
  };
  const calls = {
    initialize: 0,
    cloudPushes: [],
    cloudDeletes: [],
    logs: [],
    savedAgentSessions: [],
    orphaned: [],
    taskEvents: [],
    rescans: 0,
    recalledPets: []
  };
  let agentSessions = {};
  const botManifest = createBotManifest({
    runtimePaths: () => paths,
    readJson,
    normalizeAgentEngine: (engine) => String(engine || "hermes"),
    settingsStore: { normalizeStoredEffortLevel: (value) => String(value || "") }
  });
  const service = createBotService({
    initializeRuntime: () => { calls.initialize += 1; },
    runtimePaths: () => paths,
    botManifest,
    loadAgentSessionMap: () => ({ ...agentSessions }),
    saveAgentSessionMap: (store) => {
      agentSessions = { ...store };
      calls.savedAgentSessions.push(agentSessions);
      return agentSessions;
    },
    orphanTasksByBot: (key) => {
      calls.orphaned.push(key);
      return 2;
    },
    emitTaskEvent: (event, payload) => calls.taskEvents.push({ event, payload }),
    rescanScheduler: () => { calls.rescans += 1; },
    recallBotPet: (key) => calls.recalledPets.push(key),
    pushBotToCloud: async (bot) => { calls.cloudPushes.push(bot); },
    deleteBotFromCloud: async (key) => { calls.cloudDeletes.push(key); },
    appendCloudLog: (line) => calls.logs.push(line),
    getRuntimeStatus: () => ({ runtime: true, bots: botManifest.loadBotManifest().bots }),
    petStatusForBot: (key) => ({ key, placed: key === "alice" }),
    ...overrides
  });
  return {
    calls,
    paths,
    botManifest,
    service,
    setAgentSessions: (store) => { agentSessions = store; },
    getAgentSessions: () => agentSessions
  };
}

test("saveBot creates normalized bot, persona, sidecar, and best-effort cloud push", async (t) => {
  const { calls, paths, botManifest, service } = setup(t);

  const status = service.saveBot({
    name: "Alice",
    agentEngine: "codex",
    engineConfig: { model: "gpt-5.3", permissionMode: "ask" },
    personaText: "Sharp reviewer",
    color: "#123456",
    bio: "Reviews code"
  });
  await Promise.resolve();

  assert.deepEqual(status.runtime, true);
  const manifest = botManifest.loadBotManifest();
  assert.equal(manifest.bots.length, 1);
  assert.equal(manifest.bots[0].key, "alice");
  assert.equal(manifest.bots[0].agentEngine, "codex");
  assert.equal(manifest.bots[0].engineConfig.model, "gpt-5.3");
  assert.equal(manifest.bots[0].color, "#123456");
  assert.match(manifest.bots[0].personaText, /Sharp reviewer/);
  assert.match(fs.readFileSync(path.join(paths.botDir, "alice.md"), "utf8"), /Sharp reviewer/);
  const sidecar = readJson(path.join(paths.botDir, "alice.bot.json"), {});
  assert.equal(sidecar.display_name, "Alice");
  assert.equal(sidecar.color, "#123456");
  assert.match(sidecar.persona_text, /Sharp reviewer/);
  assert.equal(calls.cloudPushes.length, 1);
  assert.equal(calls.cloudPushes[0].key, "alice");
  assert.equal(calls.cloudPushes[0].color, "#123456");
  assert.match(calls.cloudPushes[0].personaText, /Sharp reviewer/);
});

test("saveBot assigns a unique key when a generated slug collides with another name", (t) => {
  const { botManifest, service } = setup(t);

  service.saveBot({ name: "Alice", personaText: "Alice persona" });
  service.saveBot({ name: "Alice!" });

  const bots = botManifest.loadBotManifest().bots;
  assert.deepEqual(bots.map((bot) => bot.key), ["alice", "alice_2"]);
  assert.doesNotMatch(bots.find((bot) => bot.key === "alice_2").personaText, /Alice persona/);
});

test("engine, pin, and mute updates rewrite manifest and metadata sidecar", (t) => {
  const { paths, botManifest, service } = setup(t);
  service.saveBot({ name: "Dev" });

  service.saveBotEngineConfig({
    key: "dev",
    agentEngine: "codex",
    engineConfig: { model: "gpt-5.3-codex", effortLevel: "high" }
  });
  service.setBotPinned({ key: "dev", pinned: true });
  service.setBotMuted({ key: "dev", muted: true });

  const bot = botManifest.loadBotManifest().bots.find((item) => item.key === "dev");
  assert.equal(bot.agentEngine, "codex");
  assert.equal(bot.engineConfig.model, "gpt-5.3-codex");
  assert.equal(bot.pinned, true);
  assert.equal(bot.muted, true);
  const sidecar = readJson(path.join(paths.botDir, "dev.bot.json"), {});
  assert.equal(sidecar.agent_engine, "codex");
  assert.equal(sidecar.pinned, true);
  assert.equal(sidecar.muted, true);
});

test("deleteBot removes files and cleans dependent local state", async (t) => {
  const {
    calls,
    paths,
    botManifest,
    service,
    setAgentSessions,
    getAgentSessions
  } = setup(t);
  service.saveBot({ key: "mia", name: "Mia" });
  service.saveBot({ key: "bob", name: "Bob" });
  const manifest = botManifest.loadBotManifest();
  manifest.default_bot = "bob";
  botManifest.saveBotManifest(manifest);
  setAgentSessions({
    "codex:bob:s_1": "external_bob",
    "codex:mia:s_2": "external_mia"
  });

  service.deleteBot({ key: "bob" });
  await Promise.resolve();

  assert.deepEqual(botManifest.loadBotManifest().bots.map((bot) => bot.key), ["mia"]);
  assert.equal(botManifest.loadBotManifest().default_bot, "mia");
  assert.equal(fs.existsSync(path.join(paths.botDir, "bob.md")), false);
  assert.equal(fs.existsSync(path.join(paths.botDir, "bob.bot.json")), false);
  assert.deepEqual(getAgentSessions(), { "codex:mia:s_2": "external_mia" });
  assert.deepEqual(calls.orphaned, ["bob"]);
  assert.deepEqual(calls.taskEvents, [{ event: "orphaned", payload: { botId: "bob", count: 2 } }]);
  assert.equal(calls.rescans, 1);
  assert.deepEqual(calls.recalledPets, ["bob"]);
  assert.deepEqual(calls.cloudDeletes, ["bob"]);
});

test("getBotDetails returns strict bot, persona text, and pet status", (t) => {
  const { calls, service } = setup(t);
  service.saveBot({ name: "Alice", personaText: "Custom persona" });

  const details = service.getBotDetails("alice");

  assert.equal(details.bot.key, "alice");
  assert.match(details.personaText, /Custom persona/);
  assert.deepEqual(details.pet, { key: "alice", placed: true });
  assert.ok(calls.initialize >= 1);
  assert.throws(() => service.getBotDetails("missing"), /Bot not found/);
});
