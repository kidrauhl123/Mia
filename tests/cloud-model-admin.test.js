const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { freePort } = require("./helpers/free-port");

function request(port, method, pathStr, { body, auth } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "content-type": "application/json" };
    if (auth) headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
    const req = http.request({ host: "127.0.0.1", port, path: pathStr, method, headers }, (res) => {
      let chunks = "";
      res.on("data", (chunk) => { chunks += chunk; });
      res.on("end", () => {
        let parsed = chunks;
        try { parsed = JSON.parse(chunks); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function startLiteLLMFake() {
  const port = await freePort();
  const calls = [];
  let models = [{
    model_name: "aimashi-default",
    litellm_params: { model: "openai/old", api_key: "hidden" },
    model_info: { id: "old-model-id" }
  }];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    calls.push({ method: req.method, path: url.pathname });
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer master" && req.headers.authorization !== "Bearer service") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/model/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: models }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/model/delete") {
        const input = JSON.parse(body || "{}");
        models = models.filter((model) => model.model_info.id !== input.id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/model/new") {
        const input = JSON.parse(body || "{}");
        models.push(input);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(input));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "aimashi-default", choices: [{ message: { content: "aimashi-ok" } }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, calls, server, get models() { return models; } };
}

async function startCloud(litellmPort) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-admin-test-"));
  const port = await freePort();
  const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
    env: {
      ...process.env,
      AIMASHI_CLOUD_HOST: "127.0.0.1",
      AIMASHI_CLOUD_PORT: String(port),
      AIMASHI_CLOUD_DATA: tmpDir,
      AIMASHI_CLOUD_ADMIN_USERNAME: "admin",
      AIMASHI_CLOUD_ADMIN_PASSWORD: "secret",
      AIMASHI_LITELLM_ADMIN_BASE_URL: `http://127.0.0.1:${litellmPort}`,
      LITELLM_MASTER_KEY: "master",
      AIMASHI_CLOUD_AGENT_MODEL_API_KEY: "service"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const done = () => resolve();
    proc.stdout.on("data", (chunk) => { if (/listening|Listening/.test(chunk.toString())) done(); });
    proc.stderr.on("data", (chunk) => { if (/listening|Listening|aimashi-cloud/i.test(chunk.toString())) done(); });
    proc.on("error", reject);
    setTimeout(done, 1200);
  });
  return { port, proc, tmpDir };
}

async function stopCloud(ctx) {
  if (ctx.proc.exitCode === null && ctx.proc.signalCode === null) {
    ctx.proc.kill("SIGTERM");
    await new Promise((resolve) => ctx.proc.once("exit", resolve));
  }
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

test("admin model gateway is protected by Basic auth", async () => {
  const lite = await startLiteLLMFake();
  const cloud = await startCloud(lite.port);
  try {
    const unauth = await request(cloud.port, "GET", "/api/admin/model-gateway");
    assert.equal(unauth.status, 401);
    assert.match(String(unauth.headers["www-authenticate"] || ""), /Aimashi Admin/);
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => lite.server.close(resolve));
  }
});

test("admin model gateway replaces aimashi-default without leaking provider key", async () => {
  const lite = await startLiteLLMFake();
  const cloud = await startCloud(lite.port);
  const auth = { username: "admin", password: "secret" };
  try {
    const saved = await request(cloud.port, "POST", "/api/admin/model-gateway", {
      auth,
      body: {
        provider: "deepseek",
        upstreamModel: "deepseek/deepseek-chat",
        apiKey: "sk-provider-secret"
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ok, true);
    assert.equal(saved.body.model.litellm_params.api_key, "configured");
    assert.equal(lite.models.length, 1);
    assert.equal(lite.models[0].model_name, "aimashi-default");
    assert.equal(lite.models[0].litellm_params.model, "deepseek/deepseek-chat");
    assert.equal(lite.models[0].litellm_params.api_key, "sk-provider-secret");
    assert.ok(lite.calls.some((call) => call.path === "/model/delete"));

    const status = await request(cloud.port, "GET", "/api/admin/model-gateway", { auth });
    assert.equal(status.status, 200);
    assert.equal(status.body.models[0].litellm_params.api_key, "configured");

    const tested = await request(cloud.port, "POST", "/api/admin/model-gateway/test", { auth, body: {} });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.reply, "aimashi-ok");
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => lite.server.close(resolve));
  }
});
