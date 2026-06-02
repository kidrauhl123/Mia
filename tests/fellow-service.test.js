const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createFellowManifest } = require("../src/main/fellow-manifest.js");
const { createFellowService } = require("../src/main/fellow-service.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-fellow-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = {
    home: dir,
    fellowDir: path.join(dir, "fellows"),
    fellowManifest: path.join(dir, "fellows", "manifest.json"),
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
  const fellowManifest = createFellowManifest({
    runtimePaths: () => paths,
    readJson,
    normalizeAgentEngine: (engine) => String(engine || "hermes"),
    settingsStore: { normalizeStoredEffortLevel: (value) => String(value || "") }
  });
  const service = createFellowService({
    initializeRuntime: () => { calls.initialize += 1; },
    runtimePaths: () => paths,
    fellowManifest,
    loadAgentSessionMap: () => ({ ...agentSessions }),
    saveAgentSessionMap: (store) => {
      agentSessions = { ...store };
      calls.savedAgentSessions.push(agentSessions);
      return agentSessions;
    },
    orphanTasksByFellow: (key) => {
      calls.orphaned.push(key);
      return 2;
    },
    emitTaskEvent: (event, payload) => calls.taskEvents.push({ event, payload }),
    rescanScheduler: () => { calls.rescans += 1; },
    recallFellowPet: (key) => calls.recalledPets.push(key),
    pushFellowToCloud: async (fellow) => { calls.cloudPushes.push(fellow); },
    deleteFellowFromCloud: async (key) => { calls.cloudDeletes.push(key); },
    appendCloudLog: (line) => calls.logs.push(line),
    getRuntimeStatus: () => ({ runtime: true, fellows: fellowManifest.loadFellowManifest().fellows }),
    petStatusForFellow: (key) => ({ key, placed: key === "alice" }),
    ...overrides
  });
  return {
    calls,
    paths,
    fellowManifest,
    service,
    setAgentSessions: (store) => { agentSessions = store; },
    getAgentSessions: () => agentSessions
  };
}

test("saveFellow creates normalized fellow, persona, sidecar, and best-effort cloud push", async (t) => {
  const { calls, paths, fellowManifest, service } = setup(t);

  const status = service.saveFellow({
    name: "Alice",
    agentEngine: "codex",
    engineConfig: { model: "gpt-5.3", permissionMode: "ask" },
    personaText: "Sharp reviewer",
    color: "#123456",
    bio: "Reviews code"
  });
  await Promise.resolve();

  assert.deepEqual(status.runtime, true);
  const manifest = fellowManifest.loadFellowManifest();
  assert.equal(manifest.fellows.length, 1);
  assert.equal(manifest.fellows[0].key, "alice");
  assert.equal(manifest.fellows[0].agentEngine, "codex");
  assert.equal(manifest.fellows[0].engineConfig.model, "gpt-5.3");
  assert.equal(manifest.fellows[0].color, "#123456");
  assert.match(manifest.fellows[0].personaText, /Sharp reviewer/);
  assert.match(fs.readFileSync(path.join(paths.fellowDir, "alice.md"), "utf8"), /Sharp reviewer/);
  const sidecar = readJson(path.join(paths.fellowDir, "alice.fellow.json"), {});
  assert.equal(sidecar.display_name, "Alice");
  assert.equal(sidecar.color, "#123456");
  assert.match(sidecar.persona_text, /Sharp reviewer/);
  assert.equal(calls.cloudPushes.length, 1);
  assert.equal(calls.cloudPushes[0].key, "alice");
  assert.equal(calls.cloudPushes[0].color, "#123456");
  assert.match(calls.cloudPushes[0].personaText, /Sharp reviewer/);
});

test("saveFellow assigns a unique key when a generated slug collides with another name", (t) => {
  const { fellowManifest, service } = setup(t);

  service.saveFellow({ name: "Alice", personaText: "Alice persona" });
  service.saveFellow({ name: "Alice!" });

  const fellows = fellowManifest.loadFellowManifest().fellows;
  assert.deepEqual(fellows.map((fellow) => fellow.key), ["alice", "alice_2"]);
  assert.doesNotMatch(fellows.find((fellow) => fellow.key === "alice_2").personaText, /Alice persona/);
});

test("engine, pin, and mute updates rewrite manifest and metadata sidecar", (t) => {
  const { paths, fellowManifest, service } = setup(t);
  service.saveFellow({ name: "Dev" });

  service.saveFellowEngineConfig({
    key: "dev",
    agentEngine: "codex",
    engineConfig: { model: "gpt-5.3-codex", effortLevel: "high" }
  });
  service.setFellowPinned({ key: "dev", pinned: true });
  service.setFellowMuted({ key: "dev", muted: true });

  const fellow = fellowManifest.loadFellowManifest().fellows.find((item) => item.key === "dev");
  assert.equal(fellow.agentEngine, "codex");
  assert.equal(fellow.engineConfig.model, "gpt-5.3-codex");
  assert.equal(fellow.pinned, true);
  assert.equal(fellow.muted, true);
  const sidecar = readJson(path.join(paths.fellowDir, "dev.fellow.json"), {});
  assert.equal(sidecar.agent_engine, "codex");
  assert.equal(sidecar.pinned, true);
  assert.equal(sidecar.muted, true);
});

test("deleteFellow removes files and cleans dependent local state", async (t) => {
  const {
    calls,
    paths,
    fellowManifest,
    service,
    setAgentSessions,
    getAgentSessions
  } = setup(t);
  service.saveFellow({ key: "mia", name: "Mia" });
  service.saveFellow({ key: "bob", name: "Bob" });
  const manifest = fellowManifest.loadFellowManifest();
  manifest.default_fellow = "bob";
  fellowManifest.saveFellowManifest(manifest);
  setAgentSessions({
    "codex:bob:s_1": "external_bob",
    "codex:mia:s_2": "external_mia"
  });

  service.deleteFellow({ key: "bob" });
  await Promise.resolve();

  assert.deepEqual(fellowManifest.loadFellowManifest().fellows.map((fellow) => fellow.key), ["mia"]);
  assert.equal(fellowManifest.loadFellowManifest().default_fellow, "mia");
  assert.equal(fs.existsSync(path.join(paths.fellowDir, "bob.md")), false);
  assert.equal(fs.existsSync(path.join(paths.fellowDir, "bob.fellow.json")), false);
  assert.deepEqual(getAgentSessions(), { "codex:mia:s_2": "external_mia" });
  assert.deepEqual(calls.orphaned, ["bob"]);
  assert.deepEqual(calls.taskEvents, [{ event: "orphaned", payload: { fellowId: "bob", count: 2 } }]);
  assert.equal(calls.rescans, 1);
  assert.deepEqual(calls.recalledPets, ["bob"]);
  assert.deepEqual(calls.cloudDeletes, ["bob"]);
});

test("getFellowDetails returns strict fellow, persona text, and pet status", (t) => {
  const { calls, service } = setup(t);
  service.saveFellow({ name: "Alice", personaText: "Custom persona" });

  const details = service.getFellowDetails("alice");

  assert.equal(details.fellow.key, "alice");
  assert.match(details.personaText, /Custom persona/);
  assert.deepEqual(details.pet, { key: "alice", placed: true });
  assert.ok(calls.initialize >= 1);
  assert.throws(() => service.getFellowDetails("missing"), /Fellow not found/);
});
