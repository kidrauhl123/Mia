const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createOpenClawMiaProfile
} = require("../src/main/openclaw-mia-profile.js");

function fakeChild(pid = 1001) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal = "SIGTERM") => {
    child.signalCode = signal;
    child.emit("exit", null, signal);
    return true;
  };
  child.unref = () => {};
  return child;
}

test("writes Mia managed model config into the isolated OpenClaw profile and starts a Core-owned gateway", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-openclaw-profile-"));
  try {
    const healthChecks = [];
    const spawns = [];
    const profile = createOpenClawMiaProfile({
      homeDir: () => home,
      gatewayToken: "local-gateway-token",
      gatewayHealthy: async (input) => {
        healthChecks.push(input);
        return true;
      },
      spawnProcess: (file, args, options) => {
        spawns.push({ file, args, options });
        return fakeChild();
      }
    });

    const result = await profile.ensure({
      provider: "mia",
      model: "mia-auto",
      modelProfileId: "mia:mia-auto",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiKey: "cloud-token"
    });

    assert.deepEqual(result, {
      profile: "mia",
      gatewayUrl: "ws://127.0.0.1:18790",
      gatewayTokenFile: path.join(home, ".openclaw-mia", "gateway-token")
    });

    const profileRoot = path.join(home, ".openclaw-mia");
    const openclawConfig = JSON.parse(fs.readFileSync(path.join(profileRoot, "openclaw.json"), "utf8"));
    assert.equal(openclawConfig.gateway.mode, "local");
    assert.equal(openclawConfig.gateway.bind, "loopback");
    assert.equal(openclawConfig.gateway.port, 18790);
    assert.deepEqual(openclawConfig.gateway.auth, { mode: "token", token: "local-gateway-token" });
    assert.equal(openclawConfig.models.mode, "merge");
    assert.equal(openclawConfig.models.providers.mia.apiKey, "cloud-token");
    assert.equal(openclawConfig.models.providers.mia.baseUrl, "https://mia.example/api/me/model-proxy/v1");
    assert.equal(openclawConfig.models.providers.mia.models[0].id, "mia-auto");

    const modelsConfig = JSON.parse(fs.readFileSync(path.join(profileRoot, "agents", "main", "agent", "models.json"), "utf8"));
    assert.equal(modelsConfig.providers.mia.apiKey, "cloud-token");
    assert.equal(modelsConfig.providers.mia.models[0].agentRuntime.id, "openclaw");
    assert.equal(fs.readFileSync(path.join(profileRoot, "gateway-token"), "utf8"), "local-gateway-token\n");

    assert.deepEqual(spawns.map(({ file, args }) => ({ file, args })), [
      {
        file: "openclaw",
        args: [
          "--profile", "mia",
          "gateway", "run",
          "--port", "18790",
          "--bind", "loopback",
          "--auth", "token",
          "--force",
          "--compact"
        ]
      }
    ]);
    assert.deepEqual(healthChecks, [
      {
        profile: "mia",
        gatewayPort: 18790,
        gatewayUrl: "ws://127.0.0.1:18790"
      }
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("clears stale OpenClaw device pairing state in the isolated Mia profile", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-openclaw-profile-"));
  try {
    const spawns = [];
    const profileRoot = path.join(home, ".openclaw-mia");
    const devicesDir = path.join(profileRoot, "devices");
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(path.join(devicesDir, "paired.json"), JSON.stringify({
      stale: {
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.read"],
        approvedScopes: ["operator.read"]
      }
    }));
    fs.writeFileSync(path.join(devicesDir, "pending.json"), JSON.stringify({
      upgrade: {
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.admin"]
      }
    }));

    const profile = createOpenClawMiaProfile({
      homeDir: () => home,
      gatewayToken: "local-gateway-token",
      gatewayHealthy: async () => true,
      spawnProcess: (file, args, options) => {
        spawns.push({ file, args, options });
        return fakeChild();
      }
    });

    await profile.ensure({
      model: "mia-auto",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiKey: "cloud-token"
    });

    assert.equal(fs.existsSync(path.join(devicesDir, "paired.json")), false);
    assert.equal(fs.existsSync(path.join(devicesDir, "pending.json")), false);
    assert.equal(spawns.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("does not restart the OpenClaw Mia gateway when config is unchanged and health is ok", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-openclaw-profile-"));
  try {
    const healthChecks = [];
    const spawns = [];
    const profile = createOpenClawMiaProfile({
      homeDir: () => home,
      gatewayToken: "local-gateway-token",
      gatewayHealthy: async (input) => {
        healthChecks.push(input);
        return true;
      },
      spawnProcess: (file, args, options) => {
        spawns.push({ file, args, options });
        return fakeChild();
      }
    });
    const runtime = {
      provider: "mia",
      model: "mia-auto",
      modelProfileId: "mia:mia-auto",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiKey: "cloud-token"
    };

    await profile.ensure(runtime);
    healthChecks.length = 0;
    spawns.length = 0;
    await profile.ensure(runtime);

    assert.deepEqual(spawns, []);
    assert.deepEqual(healthChecks, [
      {
        profile: "mia",
        gatewayPort: 18790,
        gatewayUrl: "ws://127.0.0.1:18790"
      }
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
