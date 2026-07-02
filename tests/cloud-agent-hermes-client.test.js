const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createHermesWorkerManager } = require("../src/cloud-agent/hermes-worker-manager.js");
const { createHermesImClient } = require("../src/cloud-agent/hermes-im-client.js");
const { normalizeCloudHermesModel } = require("../src/cloud-agent/cloud-hermes-model.js");
const { verifyUserModelProxyToken } = require("../src/cloud/model-proxy-auth.js");

function createGatewayHarness() {
  const requests = [];
  const handlers = new Map();
  const gateway = {
    connectedUrl: "",
    closed: false,
    async connect(url) {
      gateway.connectedUrl = url;
    },
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "runtime_new", stored_session_id: "stored_new" };
      }
      if (method === "prompt.submit") {
        queueMicrotask(() => {
          gateway.emit("message.delta", { type: "message.delta", session_id: params.session_id, payload: { text: "hel" } });
          gateway.emit("message.complete", { type: "message.complete", session_id: params.session_id, payload: { content: "hello" } });
        });
        return { submitted: true };
      }
      throw new Error(`unexpected request ${method}`);
    },
    emit(type, event) {
      for (const handler of handlers.get(type) || []) handler(event);
      for (const handler of handlers.get("*") || []) handler(event);
    },
    close() {
      gateway.closed = true;
    }
  };
  return { gateway, requests };
}

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
  assert.match(config, /default: "mia-auto"/);
  assert.match(config, /base_url: "http:\/\/litellm:4000\/v1"/);
  assert.match(config, /host: 0\.0\.0\.0/);
  assert.match(config, /key_env: "MIA_CLOUD_AGENT_MODEL_API_KEY"/);
  assert.match(config, /key: worker-api-key/);
  assert.match(config, /disabled_toolsets:\n    - cronjob/);
  assert.match(config, /mia-web-search:/);
  assert.match(config, /mia_plugins\.web_search_mcp/);
  assert.doesNotMatch(config, /mia-scheduler/);
  assert.doesNotMatch(config, /sk-litellm/);
  assert.equal(manager.envForUser("user_a").MIA_CLOUD_AGENT_MODEL_API_KEY, "sk-litellm");
});

test("worker manager normalizes legacy managed model aliases at the boundary", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agents-"));
  const manager = createHermesWorkerManager({
    rootDir,
    mode: "static",
    staticBaseUrl: "http://127.0.0.1:9999",
    model: "default"
  });

  const paths = manager.ensureUserDirs("user_a");
  const config = fs.readFileSync(path.join(paths.hermesHome, "config.yaml"), "utf8");
  const worker = await manager.ensureWorker("user_a");

  assert.match(config, /default: "mia-auto"/);
  assert.match(config, /default_model: "mia-auto"/);
  assert.equal(worker.model, "mia-auto");
});

test("static worker mode derives gateway websocket url from base url", async () => {
  const manager = createHermesWorkerManager({
    rootDir: "/tmp/mia-agents",
    mode: "static",
    staticBaseUrl: "http://127.0.0.1:9999"
  });

  const worker = await manager.ensureWorker("user_a");

  assert.equal(worker.baseUrl, "http://127.0.0.1:9999");
  assert.equal(worker.gatewayWsUrl, "ws://127.0.0.1:9999/api/ws?token=mia-cloud");
  assert.equal(worker.model, "mia-auto");
  assert.equal(worker.modelProvider, "mia-litellm");
  assert.equal(worker.modelApiMode, "chat_completions");
});

test("static worker mode honors explicit gateway websocket url", async () => {
  const manager = createHermesWorkerManager({
    rootDir: "/tmp/mia-agents",
    mode: "static",
    staticBaseUrl: "http://127.0.0.1:9999",
    gatewayWsUrl: "wss://gateway.example/api/ws?token=override"
  });

  const worker = await manager.ensureWorker("user_a");

  assert.equal(worker.gatewayWsUrl, "wss://gateway.example/api/ws?token=override");
});

test("worker manager can route user workers through Mia internal billing proxy", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agents-"));
  const manager = createHermesWorkerManager({
    rootDir,
    mode: "static",
    staticBaseUrl: "http://127.0.0.1:9999",
    publicUrl: "https://mia.example",
    internalModelProxyKey: "internal-secret"
  });

  const paths = manager.ensureUserDirs("user_a");
  const config = fs.readFileSync(path.join(paths.hermesHome, "config.yaml"), "utf8");
  const tokenA = manager.envForUser("user_a").MIA_CLOUD_AGENT_MODEL_API_KEY;
  const tokenB = manager.envForUser("user_b").MIA_CLOUD_AGENT_MODEL_API_KEY;

  assert.match(config, /provider: "mia"/);
  assert.match(config, /base_url: "https:\/\/mia\.example\/api\/internal\/model-proxy\/v1"/);
  assert.match(config, /key_env: "MIA_CLOUD_AGENT_MODEL_API_KEY"/);
  assert.match(config, /mia-web-search:/);
  assert.match(config, /mia_plugins\.web_search_mcp/);
  assert.match(config, /mia-scheduler:/);
  assert.match(config, /python/);
  assert.match(config, /mia_plugins\.scheduler_mcp/);
  assert.match(config, /MIA_CLOUD_TASKS_URL: "https:\/\/mia\.example\/api\/internal\/tasks"/);
  assert.match(config, /MIA_SCHEDULER_CONTEXT_FILE: "\/data\/hermes-home\/mia-scheduler-context\.json"/);
  assert.doesNotMatch(config, /internal-secret/);
  assert.notEqual(tokenA, tokenB);
  assert.equal(verifyUserModelProxyToken("internal-secret", tokenA), "user_a");
  assert.equal(verifyUserModelProxyToken("internal-secret", tokenB), "user_b");
  const taskToken = config.match(/MIA_CLOUD_TASKS_TOKEN: "([^"]+)"/)?.[1] || "";
  assert.equal(verifyUserModelProxyToken("internal-secret", taskToken), "user_a");
});

test("worker manager writes Mia internal model proxy config and gateway shim", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agents-"));
  const manager = createHermesWorkerManager({
    rootDir,
    mode: "static",
    staticBaseUrl: "http://127.0.0.1:9999",
    publicUrl: "https://mia.example",
    internalModelProxyKey: "internal-secret"
  });

  const paths = manager.ensureUserDirs("user_a");
  const config = fs.readFileSync(path.join(paths.hermesHome, "config.yaml"), "utf8");
  const shim = fs.readFileSync(path.join(paths.hermesHome, "mia-hermes-gateway-server.py"), "utf8");

  assert.match(config, /provider: "mia"/);
  assert.match(config, /default: "mia-auto"/);
  assert.match(config, /api_mode: "chat_completions"/);
  assert.match(shim, /transport": "tui_gateway"/);
  assert.match(shim, /@app\.get\("\/health"\)/);
  assert.match(shim, /@app\.websocket\("\/api\/ws"\)/);
  assert.match(shim, /MIA_HERMES_GATEWAY_TOKEN/);
  assert.match(shim, /Authorization/);
  assert.match(shim, /from tui_gateway\.ws import handle_ws as gateway_handle_ws/);
  assert.match(shim, /await gateway_handle_ws\(websocket\)/);
  assert.doesNotMatch(shim, /tui_gateway\.ws\.handle_ws/);
});

test("normalizeCloudHermesModel preserves mia-auto and maps legacy aliases to fallback", () => {
  const aliases = ["", "auto", "default", "hermes", "mia", "mia:auto", "mia-default", "mia:mia-default"];

  assert.equal(normalizeCloudHermesModel("mia-auto", { defaultModel: "mia-auto" }), "mia-auto");
  for (const input of aliases) {
    assert.equal(normalizeCloudHermesModel(input, { defaultModel: "mia-auto" }), "mia-auto");
  }
});

test("Hermes IM client routes cloud chats through the gateway websocket only", async () => {
  const { gateway, requests } = createGatewayHarness();
  const client = createHermesImClient({
    sessionsStore: {
      getSession() {
        return null;
      },
      upsertSession() {},
      clearRuntimeSession() {}
    },
    gatewayClientFactory: () => gateway
  });
  const callbacks = [];

  const out = await client.runChat({
    gatewayWsUrl: "ws://gateway.test/ws",
    apiKey: "secret",
    userId: "u1",
    bot: { id: "bot_mia", displayName: "Mia" },
    conversationId: "botc_u1_bot_mia",
    model: "hermes-agent",
    workerModel: "mia-auto",
    modelProvider: "mia",
    effortLevel: "high",
    permissionMode: "auto",
    input: "hi",
    onRunCreated(runId) {
      callbacks.push({ type: "run", runId });
    },
    onEvent(event) {
      callbacks.push({ type: "event", event });
    }
  });

  assert.equal(gateway.connectedUrl, "ws://gateway.test/ws");
  assert.equal(out.runId, "runtime_new");
  assert.equal(out.content, "hello");
  assert.deepEqual(requests.map((entry) => entry.method), ["session.create", "prompt.submit"]);
  assert.deepEqual(requests[0].params, {
    title: "Mia",
    source: "mia-cloud",
    cwd: "/data/workspace",
    model: "mia-auto",
    provider: "mia",
    reasoning_effort: "high",
    messages: []
  });
  assert.deepEqual(requests[1].params, {
    session_id: "runtime_new",
    prompt: "hi",
    instructions: "",
    permission_mode: "auto"
  });
  assert.equal(callbacks[0].type, "run");
  assert.equal(callbacks[0].runId, "runtime_new");
  assert.deepEqual(callbacks.filter((item) => item.type === "event").map((item) => item.event.type), [
    "message.delta",
    "message.complete"
  ]);
  assert.equal(gateway.closed, true);
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
  assert.equal(worker.gatewayWsUrl, "ws://127.0.0.1:49152/api/ws?token=mia-cloud");
  assert.equal(worker.model, "mia-auto");
  assert.equal(worker.modelProvider, "mia-litellm");
  assert.equal(worker.modelApiMode, "chat_completions");
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
  assert.equal(runCall.args[runCall.args.indexOf("mia/hermes-cloud:test") + 1], "python");
  assert.equal(runCall.args[runCall.args.indexOf("mia/hermes-cloud:test") + 2], "/data/hermes-home/mia-hermes-gateway-server.py");
  assert.equal(runCall.args.some((arg) => String(arg).includes("docker.sock")), false);
});

test("docker worker mode removes stale same-name container before starting", async () => {
  const execCalls = [];
  const fakeExecFile = async (bin, args) => {
    execCalls.push({ bin, args });
    const command = args.slice(0, 2).join(" ");
    if (command === "inspect -f") return { stdout: "false\texited\n", stderr: "" };
    if (args[0] === "rm") return { stdout: "removed\n", stderr: "" };
    if (args[0] === "run") return { stdout: "container-id\n", stderr: "" };
    if (args[0] === "port") return { stdout: "127.0.0.1:49153\n", stderr: "" };
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };
  const manager = createHermesWorkerManager({
    rootDir: "/tmp/mia-agents",
    mode: "docker",
    image: "mia/hermes-cloud:test",
    healthTimeoutMs: 0,
    execFile: fakeExecFile
  });

  const worker = await manager.ensureWorker("user_a");

  assert.equal(worker.baseUrl, "http://127.0.0.1:49153");
  assert.deepEqual(execCalls.map((call) => call.args[0]), ["inspect", "rm", "run", "port"]);
  assert.deepEqual(execCalls[1].args, ["rm", "-f", "mia-hermes-user_a"]);
});

test("docker worker mode reuses container created by concurrent start", async () => {
  const execCalls = [];
  let inspectCount = 0;
  const fakeExecFile = async (bin, args) => {
    execCalls.push({ bin, args });
    const command = args.slice(0, 2).join(" ");
    if (command === "inspect -f") {
      inspectCount += 1;
      if (inspectCount === 1) throw new Error("not found");
      return { stdout: "true\trunning\n", stderr: "" };
    }
    if (args[0] === "run") {
      const error = new Error("docker: Error response from daemon: Conflict. The container name \"/mia-hermes-user_a\" is already in use.");
      error.stderr = error.message;
      throw error;
    }
    if (args[0] === "port") return { stdout: "127.0.0.1:49154\n", stderr: "" };
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };
  const manager = createHermesWorkerManager({
    rootDir: "/tmp/mia-agents",
    mode: "docker",
    image: "mia/hermes-cloud:test",
    healthTimeoutMs: 0,
    execFile: fakeExecFile
  });

  const worker = await manager.ensureWorker("user_a");

  assert.equal(worker.baseUrl, "http://127.0.0.1:49154");
  assert.deepEqual(execCalls.map((call) => call.args[0]), ["inspect", "run", "inspect", "port"]);
});
