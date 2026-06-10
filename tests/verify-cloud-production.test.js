const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  assertBridgeSmokeEnv,
  commandEnv,
  normalizeBaseUrl,
  readExpectedRelease,
  verifyProduction
} = require("../scripts/verify-cloud-production.js");

function writeManifest(tempDir, manifest) {
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

test("production verifier normalizes public URLs", () => {
  assert.equal(normalizeBaseUrl("https://mia.gifgif.cn/"), "https://mia.gifgif.cn");
  assert.equal(normalizeBaseUrl("https://mia.gifgif.cn/api/../"), "https://mia.gifgif.cn");
  assert.throws(() => normalizeBaseUrl("file:///tmp/x"), /Cloud URL must be http or https/);
});

test("production verifier reads expected release identity from manifest", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-prod-verify-"));
  try {
    const manifestPath = writeManifest(tempDir, {
      source: { gitCommit: "abc123" },
      builtAt: "2026-05-21T01:02:03.000Z"
    });
    assert.deepEqual(readExpectedRelease({ manifestPath }), {
      gitCommit: "abc123",
      builtAt: "2026-05-21T01:02:03.000Z",
      manifestPath
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production verifier runs doctor, smoke, then site verification with manifest release expectations", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-prod-verify-"));
  try {
    const manifestPath = writeManifest(tempDir, {
      source: { gitCommit: "abc123" },
      builtAt: "2026-05-21T01:02:03.000Z"
    });
    const calls = [];
    const spawnSync = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    };
    const result = verifyProduction({
      publicUrl: "https://mia.gifgif.cn/",
      manifestPath,
      spawnSync,
      baseEnv: { EXISTING: "1" },
      cwd: "/repo",
      stdio: "pipe"
    });

    assert.equal(result.baseUrl, "https://mia.gifgif.cn");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].args, ["/repo/scripts/doctor-cloud.js", "https://mia.gifgif.cn"]);
    assert.deepEqual(calls[1].args, ["/repo/scripts/smoke-cloud.js", "https://mia.gifgif.cn"]);
    assert.deepEqual(calls[2].args, ["/repo/scripts/verify-site-verification.js", "https://mia.gifgif.cn"]);
    assert.equal(calls[0].options.env.EXISTING, "1");
    assert.equal(calls[0].options.env.MIA_DOCTOR_EXPECT_RELEASE_COMMIT, "abc123");
    assert.equal(calls[0].options.env.MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT, "2026-05-21T01:02:03.000Z");
    assert.equal(calls[1].options.env.MIA_SMOKE_EXPECT_RELEASE_COMMIT, "abc123");
    assert.equal(calls[1].options.env.MIA_SMOKE_EXPECT_RELEASE_BUILT_AT, "2026-05-21T01:02:03.000Z");
    assert.equal(calls[2].options.env.EXISTING, "1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production verifier stops before site verification when smoke fails", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-prod-verify-"));
  try {
    const manifestPath = writeManifest(tempDir, {
      source: { gitCommit: "abc123" },
      builtAt: "2026-05-21T01:02:03.000Z"
    });
    const statuses = [0, 1];
    const calls = [];
    assert.throws(() => verifyProduction({
      publicUrl: "https://mia.gifgif.cn",
      manifestPath,
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: statuses.shift() };
      },
      cwd: "/repo",
      stdio: "pipe"
    }), /Running production smoke failed with exit status 1/);
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production verifier stops before smoke when doctor fails", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-prod-verify-"));
  try {
    const manifestPath = writeManifest(tempDir, {
      source: { gitCommit: "abc123" },
      builtAt: "2026-05-21T01:02:03.000Z"
    });
    const calls = [];
    assert.throws(() => verifyProduction({
      publicUrl: "https://mia.gifgif.cn",
      manifestPath,
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 1 };
      },
      cwd: "/repo",
      stdio: "pipe"
    }), /Running production doctor failed with exit status 1/);
    assert.equal(calls.length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production verifier fails fast when bridge smoke lacks a fixed account", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-prod-verify-"));
  try {
    const manifestPath = writeManifest(tempDir, {
      source: { gitCommit: "abc123" },
      builtAt: "2026-05-21T01:02:03.000Z"
    });
    const calls = [];
    assert.throws(() => verifyProduction({
      publicUrl: "https://mia.gifgif.cn",
      manifestPath,
      spawnSync: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
      baseEnv: { MIA_SMOKE_REQUIRE_BRIDGE: "1" },
      cwd: "/repo",
      stdio: "pipe"
    }), /MIA_SMOKE_USERNAME and MIA_SMOKE_PASSWORD are required/);
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bridge smoke environment accepts a fixed account", () => {
  assert.doesNotThrow(() => assertBridgeSmokeEnv({
    MIA_SMOKE_REQUIRE_BRIDGE: "1",
    MIA_SMOKE_USERNAME: "smoketest",
    MIA_SMOKE_PASSWORD: "secret1"
  }));
});

test("commandEnv preserves existing environment and sets prefixed release expectations", () => {
  const env = commandEnv({ A: "b" }, "SMOKE", { gitCommit: "abc123", builtAt: "date" });
  assert.deepEqual(env, {
    A: "b",
    MIA_SMOKE_EXPECT_RELEASE_COMMIT: "abc123",
    MIA_SMOKE_EXPECT_RELEASE_BUILT_AT: "date"
  });
});
