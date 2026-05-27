const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createHermesWorkerManager } = require("../src/cloud-agent/hermes-worker-manager.js");
const { createHermesRunsClient } = require("../src/cloud-agent/hermes-runs-client.js");

test("worker manager derives separate roots and env per user", () => {
  const manager = createHermesWorkerManager({ rootDir: "/tmp/mia-agents", mode: "static", staticBaseUrl: "http://127.0.0.1:9999" });
  const a = manager.pathsForUser("user_a");
  const b = manager.pathsForUser("user_b");

  assert.equal(a.root, path.join("/tmp/mia-agents", "user_a"));
  assert.equal(a.workspace, path.join("/tmp/mia-agents", "user_a", "workspace"));
  assert.notEqual(a.home, b.home);
  assert.notEqual(a.hermesHome, b.hermesHome);

  assert.deepEqual(manager.envForUser("user_a"), {
    HERMES_HOME: "/data/hermes-home",
    HOME: "/data/home",
    TERMINAL_CWD: "/data/workspace",
    HERMES_WRITE_SAFE_ROOT: "/data/workspace",
    HERMES_ACCEPT_HOOKS: "1",
    GATEWAY_ALLOW_ALL_USERS: "true",
    PYTHONUNBUFFERED: "1",
    API_SERVER_ENABLED: "true",
    API_SERVER_HOST: "0.0.0.0",
    API_SERVER_PORT: "8765",
    API_SERVER_KEY: "mia-cloud"
  });
});

test("worker manager rejects unsafe user ids for filesystem paths", () => {
  const manager = createHermesWorkerManager({ rootDir: "/tmp/mia-agents" });
  assert.throws(() => manager.pathsForUser("../escape"), /unsafe userId/);
  assert.throws(() => manager.pathsForUser(""), /userId required/);
});

test("worker manager writes platform LiteLLM config per user", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agents-"));
  const manager = createHermesWorkerManager({
    rootDir,
    mode: "static",
    staticBaseUrl: "http://127.0.0.1:9999",
    apiKey: "worker-api-key",
    modelProvider: "mia-litellm",
    model: "mia-default",
    modelBaseUrl: "http://litellm:4000/v1",
    modelApiKey: "sk-litellm"
  });

  const paths = manager.ensureUserDirs("user_a");
  const configPath = path.join(paths.hermesHome, "config.yaml");
  const config = fs.readFileSync(configPath, "utf8");
  const stat = fs.statSync(configPath);

  assert.equal(stat.mode & 0o777, 0o600);
  assert.match(config, /provider: "mia-litellm"/);
  assert.match(config, /default: "mia-default"/);
  assert.match(config, /base_url: "http:\/\/litellm:4000\/v1"/);
  assert.match(config, /host: 0\.0\.0\.0/);
  assert.match(config, /key_env: "MIA_CLOUD_AGENT_MODEL_API_KEY"/);
  assert.match(config, /key: worker-api-key/);
  assert.doesNotMatch(config, /sk-litellm/);
  assert.equal(manager.envForUser("user_a").MIA_CLOUD_AGENT_MODEL_API_KEY, "sk-litellm");
});

test("Hermes runs client sends Fellow headers and returns final text", async () => {
  const calls = [];
  const callbacks = [];
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
    fellow: { id: "mia", name: "Mia" },
    conversationId: "fellow:u1:mia",
    model: "hermes-agent",
    effortLevel: "high",
    permissionMode: "auto",
    input: "hi",
    attachments: [{ id: "file_1", name: "note.txt", mimeType: "text/plain", size: 12, kind: "text", path: "/data/attachments/run/note.txt" }],
    conversationHistory: [{ role: "user", content: "hi" }],
    onRunCreated(runId) {
      callbacks.push({ type: "run", runId });
    },
    onEvent(event) {
      callbacks.push({ type: "event", event });
    }
  });

  assert.equal(out.runId, "run_1");
  assert.equal(out.content, "hello");
  assert.equal(calls[0].url, "http://worker/v1/runs");
  assert.equal(calls[0].headers["X-Mia-Fellow"], "mia");
  assert.equal(calls[0].headers["X-Alkaka-Fellow"], "mia");
  assert.equal(calls[0].headers["X-Hermes-Session-Key"], "cloud:u1:mia:fellow:u1:mia");
  assert.equal(calls[0].headers.Authorization, "Bearer secret");
  assert.equal(calls[1].headers.Authorization, "Bearer secret");
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, "hermes-agent");
  assert.equal(body.session_id, "cloud:u1:mia:fellow:u1:mia");
  assert.deepEqual(body.conversation_history, [{ role: "user", content: "hi" }]);
  assert.deepEqual(body.attachments, [{ id: "file_1", name: "note.txt", mimeType: "text/plain", size: 12, kind: "text", path: "/data/attachments/run/note.txt" }]);
  assert.equal(body.metadata.account_id, "u1");
  assert.equal(body.metadata.effort_level, "high");
  assert.equal(body.metadata.permission_mode, "auto");
  assert.deepEqual(body.metadata.attachments, [{ id: "file_1", name: "note.txt", mimeType: "text/plain", path: "/data/attachments/run/note.txt" }]);
  assert.equal(callbacks[0].type, "run");
  assert.equal(callbacks[0].runId, "run_1");
  assert.deepEqual(callbacks.filter((item) => item.type === "event").map((item) => item.event.type), [
    "message.delta",
    "message.delta",
    "run.completed"
  ]);
});

test("Hermes runs client accepts an isolated session id for conductor-style calls", async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {}, body: options.body || "" });
    if (String(url).endsWith("/v1/runs")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ run_id: "run_conductor" }) };
    }
    return { ok: true, status: 200, text: async () => "data: {\"type\":\"run.completed\",\"content\":\"{}\"}\n\n" };
  };

  const client = createHermesRunsClient({ fetch: fakeFetch });
  await client.runChat({
    baseUrl: "http://worker",
    userId: "u1",
    fellow: { id: "alice", name: "Alice" },
    conversationId: "g_1",
    sessionId: "cloud:u1:conductor:g_1:m_1",
    metadataRole: "group-conductor",
    input: "choose"
  });

  const body = JSON.parse(calls[0].body);
  assert.equal(body.session_id, "cloud:u1:conductor:g_1:m_1");
  assert.equal(body.metadata.conversation_id, "g_1");
  assert.equal(body.metadata.role, "group-conductor");
  assert.equal(calls[0].headers["X-Hermes-Session-Key"], "cloud:u1:conductor:g_1:m_1");
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
    rootDir: "/tmp/mia-agents",
    mode: "docker",
    image: "mia/hermes-cloud:test",
    dockerNetwork: "mia-cloud",
    modelApiKey: "sk-litellm",
    healthTimeoutMs: 0,
    execFile: fakeExecFile
  });

  const worker = await manager.ensureWorker("user_a");

  assert.equal(worker.baseUrl, "http://127.0.0.1:49152");
  const runCall = execCalls.find((call) => call.args[0] === "run");
  assert.ok(runCall, "docker run should be called when container is missing");
  assert.ok(runCall.args.includes("--network"));
  assert.ok(runCall.args.includes("mia-cloud"));
  assert.ok(runCall.args.includes("--read-only"));
  assert.ok(runCall.args.includes("--cpus=1"));
  assert.ok(runCall.args.includes("--memory=1024m"));
  assert.ok(runCall.args.includes("type=bind,src=/tmp/mia-agents/user_a,dst=/data"));
  assert.ok(runCall.args.includes("HERMES_HOME=/data/hermes-home"));
  assert.ok(runCall.args.includes("HOME=/data/home"));
  assert.ok(runCall.args.includes("TERMINAL_CWD=/data/workspace"));
  assert.ok(runCall.args.includes("HERMES_WRITE_SAFE_ROOT=/data/workspace"));
  assert.ok(runCall.args.includes("API_SERVER_ENABLED=true"));
  assert.ok(runCall.args.includes("API_SERVER_HOST=0.0.0.0"));
  assert.ok(runCall.args.includes("API_SERVER_PORT=8765"));
  assert.ok(runCall.args.includes("API_SERVER_KEY=mia-cloud"));
  assert.ok(runCall.args.includes("MIA_CLOUD_AGENT_MODEL_API_KEY=sk-litellm"));
  assert.equal(runCall.args.some((arg) => String(arg).includes("docker.sock")), false);
});
