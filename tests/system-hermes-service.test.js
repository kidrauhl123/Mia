const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createSystemHermesService } = require("../src/main/system-hermes-service.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-system-hermes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = { home: path.join(dir, "engine-home") };
  const calls = [];
  const service = createSystemHermesService({
    runtimePaths: () => runtime,
    readJson,
    now: () => new Date("2026-05-25T12:34:56.000Z"),
    resetAgentEngineCache: () => calls.push("reset-cache"),
    ...overrides
  });
  return { calls, runtime, service };
}

test("loadCache returns a pending disabled status when no cache exists", (t) => {
  const { service } = setup(t);

  assert.deepEqual(service.loadCache(), { available: false, pending: true, disabled: true });
});

test("refresh records the disabled system Hermes policy and resets local Agent cache", async (t) => {
  const { calls, runtime, service } = setup(t);

  await service.refresh();

  const cachePath = path.join(runtime.home, "mia-system-hermes.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")), {
    available: false,
    checkedAt: "2026-05-25T12:34:56.000Z",
    disabled: true
  });
  assert.deepEqual(calls, ["reset-cache"]);
});

test("disabled system Hermes never leaks legacy user Hermes home or dotenv values", (t) => {
  const { runtime, service } = setup(t);
  const oldHermesHome = path.join(path.dirname(runtime.home), "old-hermes");
  fs.mkdirSync(oldHermesHome, { recursive: true });
  fs.writeFileSync(path.join(oldHermesHome, ".env"), "OPENAI_API_KEY=secret\n");
  fs.mkdirSync(runtime.home, { recursive: true });
  fs.writeFileSync(path.join(runtime.home, "mia-system-hermes.json"), JSON.stringify({
    available: true,
    hermesHome: oldHermesHome
  }, null, 2));

  assert.equal(service.userHomePath(), "");
  assert.deepEqual(service.loadDotenv(), {});
});
