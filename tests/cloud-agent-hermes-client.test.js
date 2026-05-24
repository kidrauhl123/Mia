const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createHermesWorkerManager } = require("../src/cloud-agent/hermes-worker-manager.js");
const { createHermesRunsClient } = require("../src/cloud-agent/hermes-runs-client.js");

test("worker manager derives separate roots and env per user", () => {
  const manager = createHermesWorkerManager({ rootDir: "/tmp/aimashi-agents", mode: "static", staticBaseUrl: "http://127.0.0.1:9999" });
  const a = manager.pathsForUser("user_a");
  const b = manager.pathsForUser("user_b");

  assert.equal(a.root, path.join("/tmp/aimashi-agents", "user_a"));
  assert.equal(a.workspace, path.join("/tmp/aimashi-agents", "user_a", "workspace"));
  assert.notEqual(a.home, b.home);
  assert.notEqual(a.hermesHome, b.hermesHome);

  assert.deepEqual(manager.envForUser("user_a"), {
    HERMES_HOME: "/data/hermes-home",
    HOME: "/data/home",
    TERMINAL_CWD: "/data/workspace",
    HERMES_WRITE_SAFE_ROOT: "/data/workspace"
  });
});

test("worker manager rejects unsafe user ids for filesystem paths", () => {
  const manager = createHermesWorkerManager({ rootDir: "/tmp/aimashi-agents" });
  assert.throws(() => manager.pathsForUser("../escape"), /unsafe userId/);
  assert.throws(() => manager.pathsForUser(""), /userId required/);
});

test("Hermes runs client sends Fellow headers and returns final text", async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", headers: options.headers || {}, body: options.body || "" });
    if (String(url).endsWith("/v1/runs")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ run_id: "run_1" })
      };
    }
    if (String(url).endsWith("/v1/runs/run_1/events")) {
      return {
        ok: true,
        status: 200,
        text: async () => [
          "data: {\"type\":\"message.delta\",\"delta\":\"hel\"}",
          "",
          "data: {\"type\":\"message.delta\",\"delta\":\"lo\"}",
          "",
          "data: {\"type\":\"run.completed\",\"finish_reason\":\"stop\"}",
          "",
        ].join("\n")
      };
    }
    throw new Error(`unexpected url ${url}`);
  };

  const client = createHermesRunsClient({ fetch: fakeFetch });
  const out = await client.runChat({
    baseUrl: "http://worker",
    apiKey: "secret",
    userId: "u1",
    fellow: { id: "aimashi", name: "Aimashi" },
    roomId: "fellow:u1:aimashi",
    input: "hi",
    conversationHistory: [{ role: "user", content: "hi" }]
  });

  assert.equal(out.runId, "run_1");
  assert.equal(out.content, "hello");
  assert.equal(calls[0].url, "http://worker/v1/runs");
  assert.equal(calls[0].headers["X-Aimashi-Fellow"], "aimashi");
  assert.equal(calls[0].headers["X-Alkaka-Fellow"], "aimashi");
  assert.equal(calls[0].headers["X-Hermes-Session-Key"], "cloud:u1:aimashi:fellow:u1:aimashi");
  assert.equal(calls[0].headers.Authorization, "Bearer secret");
  const body = JSON.parse(calls[0].body);
  assert.equal(body.session_id, "cloud:u1:aimashi:fellow:u1:aimashi");
  assert.deepEqual(body.conversation_history, [{ role: "user", content: "hi" }]);
  assert.equal(body.metadata.account_id, "u1");
});

test("docker worker mode starts one isolated container per user", async () => {
  const execCalls = [];
  const fakeExecFile = async (bin, args) => {
    execCalls.push({ bin, args });
    const command = args.slice(0, 2).join(" ");
    if (command === "inspect -f") throw new Error("not running");
    if (args[0] === "run") return { stdout: "container-id\n", stderr: "" };
    if (args[0] === "port") return { stdout: "127.0.0.1:49152\n", stderr: "" };
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };
  const manager = createHermesWorkerManager({
    rootDir: "/tmp/aimashi-agents",
    mode: "docker",
    image: "aimashi/hermes-cloud:test",
    execFile: fakeExecFile
  });

  const worker = await manager.ensureWorker("user_a");

  assert.equal(worker.baseUrl, "http://127.0.0.1:49152");
  const runCall = execCalls.find((call) => call.args[0] === "run");
  assert.ok(runCall, "docker run should be called when container is missing");
  assert.ok(runCall.args.includes("--network=bridge"));
  assert.ok(runCall.args.includes("--read-only"));
  assert.ok(runCall.args.includes("--cpus=1"));
  assert.ok(runCall.args.includes("--memory=1024m"));
  assert.ok(runCall.args.includes("type=bind,src=/tmp/aimashi-agents/user_a,dst=/data"));
  assert.ok(runCall.args.includes("HERMES_HOME=/data/hermes-home"));
  assert.ok(runCall.args.includes("HOME=/data/home"));
  assert.ok(runCall.args.includes("TERMINAL_CWD=/data/workspace"));
  assert.ok(runCall.args.includes("HERMES_WRITE_SAFE_ROOT=/data/workspace"));
  assert.equal(runCall.args.some((arg) => String(arg).includes("docker.sock")), false);
});
