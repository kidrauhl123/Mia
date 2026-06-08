const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildRemoteProbeCommand,
  evaluateHealth,
  normalizeBaseUrl,
  parseArgs
} = require("../scripts/doctor-cloud.js");

test("cloud doctor normalizes the public cloud URL", () => {
  assert.equal(normalizeBaseUrl("https://mia.gifgif.cn///?x=1#frag"), "https://mia.gifgif.cn");
  assert.throws(() => normalizeBaseUrl("ftp://mia.gifgif.cn"), /Cloud URL must be http or https/);
});

test("cloud doctor reports missing required product features", () => {
  const headers = new Headers({
    "access-control-allow-origin": "https://mia.gifgif.cn",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "strict-transport-security": "max-age=31536000"
  });
  const checks = evaluateHealth({
    baseUrl: "https://mia.gifgif.cn",
    responseHeaders: headers,
    health: {
      features: ["authenticated-files"],
      release: null
    }
  });
  assert.equal(checks.find((check) => check.name === "health features").ok, false);
  assert.match(checks.find((check) => check.name === "health features").detail, /sqlite-store/);
  assert.equal(checks.find((check) => check.name === "release provenance").ok, false);
});

test("cloud doctor accepts current health/security shape", () => {
  const headers = new Headers({
    "access-control-allow-origin": "http://127.0.0.1:4175",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  });
  const checks = evaluateHealth({
    baseUrl: "http://127.0.0.1:4175",
    responseHeaders: headers,
    health: {
      features: [
        "sqlite-store",
        "authenticated-files",
        "events-websocket",
        "bridge-websocket-subprotocol-token",
        "bridge-run-lifecycle",
        "bridge-run-cancel",
        "bridge-run-progress",
        "desktop-sync"
      ],
      release: {
        gitCommit: "abc123",
        builtAt: "2026-05-20T00:00:00.000Z"
      }
    }
  });
  assert.deepEqual(checks.map((check) => [check.name, check.ok]), [
    ["health features", true],
    ["release provenance", true],
    ["same-origin CORS", true],
    ["security headers", true]
  ]);
});

test("cloud doctor verifies expected release provenance when configured", () => {
  const headers = new Headers({
    "access-control-allow-origin": "http://127.0.0.1:4175",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  });
  const checks = evaluateHealth({
    baseUrl: "http://127.0.0.1:4175",
    responseHeaders: headers,
    expectedReleaseCommit: "abc123",
    expectedReleaseBuiltAt: "2026-05-20T00:00:00.000Z",
    health: {
      features: [
        "sqlite-store",
        "authenticated-files",
        "events-websocket",
        "bridge-websocket-subprotocol-token",
        "bridge-run-lifecycle",
        "bridge-run-cancel",
        "bridge-run-progress",
        "desktop-sync"
      ],
      release: {
        gitCommit: "abc123",
        builtAt: "2026-05-20T00:00:00.000Z"
      }
    }
  });
  assert.equal(checks.find((check) => check.name === "expected release").ok, true);

  const mismatched = evaluateHealth({
    baseUrl: "http://127.0.0.1:4175",
    responseHeaders: headers,
    expectedReleaseCommit: "expectedcommit",
    expectedReleaseBuiltAt: "2026-05-21T00:00:00.000Z",
    health: {
      features: [
        "sqlite-store",
        "authenticated-files",
        "events-websocket",
        "bridge-websocket-subprotocol-token",
        "bridge-run-lifecycle",
        "bridge-run-cancel",
        "bridge-run-progress",
        "desktop-sync"
      ],
      release: {
        gitCommit: "abc123",
        builtAt: "2026-05-20T00:00:00.000Z"
      }
    }
  });
  const expectedRelease = mismatched.find((check) => check.name === "expected release");
  assert.equal(expectedRelease.ok, false);
  assert.match(expectedRelease.detail, /commit expected expectedcommit, got abc123/);
  assert.match(expectedRelease.detail, /builtAt expected 2026-05-21T00:00:00.000Z, got 2026-05-20T00:00:00.000Z/);
});

test("cloud doctor remote probe checks deploy-critical commands", () => {
  const command = buildRemoteProbeCommand({ sudo: "sudo -n" });
  assert.match(command, /require\("node:sqlite"\)/);
  assert.match(command, /major < 25/);
  assert.match(command, /command -v rsync/);
  assert.match(command, /command -v systemctl/);
  assert.match(command, /command -v id/);
  assert.match(command, /command -v chown/);
  assert.match(command, /id -u 'mia-cloud'/);
  assert.match(command, /command -v useradd/);
  assert.match(command, /sudo -n nginx -t/);
});

test("cloud doctor remote probe quotes custom service user", () => {
  const command = buildRemoteProbeCommand({ serviceUser: "mia'cloud" });
  assert.match(command, /id -u 'mia'\\''cloud'/);
});

test("cloud doctor parses defaults and remote settings", () => {
  const parsed = parseArgs([], {
    MIA_CLOUD_URL: "http://127.0.0.1:4175",
    MIA_DOCTOR_REMOTE: "deploy@example.com",
    MIA_DEPLOY_SUDO: "sudo -n",
    MIA_DEPLOY_SERVICE_USER: "mia-prod",
    MIA_DOCTOR_EXPECT_RELEASE_COMMIT: "abc123",
    MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT: "2026-05-20T00:00:00.000Z",
    MIA_DOCTOR_TIMEOUT_MS: "5000"
  });
  assert.equal(parsed.baseUrl, "http://127.0.0.1:4175");
  assert.equal(parsed.remote, "deploy@example.com");
  assert.equal(parsed.sudo, "sudo -n");
  assert.equal(parsed.serviceUser, "mia-prod");
  assert.equal(parsed.expectedReleaseCommit, "abc123");
  assert.equal(parsed.expectedReleaseBuiltAt, "2026-05-20T00:00:00.000Z");
  assert.equal(parsed.timeoutMs, 5000);
});
