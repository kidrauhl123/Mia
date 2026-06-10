const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { freePort } = require("./helpers/free-port");

function request(port, method, pathStr, { body, auth, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "content-type": "application/json" };
    if (auth) headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
    if (token) headers.authorization = `Bearer ${token}`;
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

async function startLiteLLMFake(initialModels = null) {
  const port = await freePort();
  const calls = [];
  let models = initialModels || [{
    model_name: "mia-default",
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
        res.end(JSON.stringify({ model: "mia-default", choices: [{ message: { content: "mia-ok" } }] }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "mia-default", output_text: "mia-ok" }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "mia-default", content: [{ type: "text", text: "mia-claude-ok" }] }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 42 }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, calls, server, get models() { return models; } };
}

async function register(port, account) {
  const response = await request(port, "POST", "/api/auth/register", {
    body: { account, password: "passworD1!", username: `u-${account}` }
  });
  assert.ok(response.status === 200 || response.status === 201);
  return response.body;
}

async function startCloud(litellmPort) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-admin-test-"));
  const port = await freePort();
  const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
    env: {
      ...process.env,
      MIA_CLOUD_HOST: "127.0.0.1",
      MIA_CLOUD_PORT: String(port),
      MIA_CLOUD_DATA: tmpDir,
      MIA_CLOUD_ADMIN_USERNAME: "admin",
      MIA_CLOUD_ADMIN_PASSWORD: "secret",
      MIA_LITELLM_ADMIN_BASE_URL: `http://127.0.0.1:${litellmPort}`,
      LITELLM_MASTER_KEY: "master",
      MIA_CLOUD_AGENT_MODEL_API_KEY: "service"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const done = () => resolve();
    proc.stdout.on("data", (chunk) => { if (/listening|Listening/.test(chunk.toString())) done(); });
    proc.stderr.on("data", (chunk) => { if (/listening|Listening|mia-cloud/i.test(chunk.toString())) done(); });
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
    assert.match(String(unauth.headers["www-authenticate"] || ""), /Mia Admin/);
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => lite.server.close(resolve));
  }
});

test("admin model gateway replaces mia-default without leaking provider key", async () => {
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
    assert.equal(lite.models[0].model_name, "mia-default");
    assert.equal(lite.models[0].litellm_params.model, "deepseek/deepseek-chat");
    assert.equal(lite.models[0].litellm_params.api_key, "sk-provider-secret");
    assert.ok(lite.calls.some((call) => call.path === "/model/delete"));

    const status = await request(cloud.port, "GET", "/api/admin/model-gateway", { auth });
    assert.equal(status.status, 200);
    assert.equal(status.body.models[0].litellm_params.api_key, "configured");

    const tested = await request(cloud.port, "POST", "/api/admin/model-gateway/test", { auth, body: {} });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.reply, "mia-ok");
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => lite.server.close(resolve));
  }
});

test("admin model gateway can add a second platform alias without deleting mia-default", async () => {
  const lite = await startLiteLLMFake();
  const cloud = await startCloud(lite.port);
  const auth = { username: "admin", password: "secret" };
  try {
    const saved = await request(cloud.port, "POST", "/api/admin/model-gateway", {
      auth,
      body: {
        modelName: "mia-pro",
        provider: "anthropic",
        upstreamModel: "anthropic/claude-sonnet-4",
        apiKey: "sk-pro-secret"
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.model.model_name, "mia-pro");
    assert.deepEqual(lite.models.map((model) => model.model_name), ["mia-default", "mia-pro"]);
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => lite.server.close(resolve));
  }
});

test("admin model page lets operators edit the public model alias", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src/web/admin-model.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "src/web/admin-model.js"), "utf8");
  assert.match(html, /id="publicModelInput"/);
  assert.doesNotMatch(html, /id="publicModelInput"[^>]*readonly/);
  assert.match(js, /publicModel/);
  assert.match(js, /modelName:\s*els\.publicModel\.value/);
});

test("authenticated users can list platform model aliases without provider secrets", async () => {
  const lite = await startLiteLLMFake([
    {
      model_name: "mia-default",
      litellm_params: { model: "deepseek/deepseek-chat", api_key: "sk-default-secret" },
      model_info: { id: "mia-default", base_model: "deepseek/deepseek-chat", provider: "deepseek", label: "Mia Default" }
    },
    {
      model_name: "mia-pro",
      litellm_params: { model: "anthropic/claude-sonnet-4", api_key: "sk-pro-secret" },
      model_info: { id: "mia-pro", base_model: "anthropic/claude-sonnet-4", provider: "anthropic", label: "Mia Pro" }
    }
  ]);
  const cloud = await startCloud(lite.port);
  try {
    const user = await register(cloud.port, "sigma");
    const catalog = await request(cloud.port, "GET", "/api/me/model-catalog", { token: user.token });
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.models.map((model) => model.id), ["mia-default", "mia-pro"]);
    assert.equal(catalog.body.models[0].label, "Mia Default");
    assert.equal(catalog.body.models[1].provider, "anthropic");
    const serialized = JSON.stringify(catalog.body);
    assert.doesNotMatch(serialized, /sk-default-secret|sk-pro-secret|api_key/);
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => lite.server.close(resolve));
  }
});

test("authenticated users can call Mia model proxy without provider secrets", async () => {
  const lite = await startLiteLLMFake([
    {
      model_name: "mia-default",
      litellm_params: { model: "deepseek/deepseek-chat", api_key: "sk-default-secret" },
      model_info: { id: "mia-default", base_model: "deepseek/deepseek-chat", provider: "deepseek", label: "Mia Default" }
    }
  ]);
  const cloud = await startCloud(lite.port);
  try {
    const user = await register(cloud.port, "proxy");
    const models = await request(cloud.port, "GET", "/api/me/model-proxy/v1/models", { token: user.token });
    assert.equal(models.status, 200);
    assert.deepEqual(models.body.data.map((model) => model.id), ["mia-default"]);

    const completion = await request(cloud.port, "POST", "/api/me/model-proxy/v1/chat/completions", {
      token: user.token,
      body: {
        model: "mia-default",
        messages: [{ role: "user", content: "hello" }]
      }
    });
    assert.equal(completion.status, 200);
    assert.equal(completion.body.choices[0].message.content, "mia-ok");
    assert.ok(lite.calls.some((call) => call.path === "/v1/chat/completions"));
    assert.doesNotMatch(JSON.stringify(completion.body), /sk-default-secret|service|master/);

    const response = await request(cloud.port, "POST", "/api/me/model-proxy/v1/responses", {
      token: user.token,
      body: {
        model: "mia-default",
        input: "hello"
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.output_text, "mia-ok");
    assert.ok(lite.calls.some((call) => call.path === "/v1/responses"));

    const anthropic = await request(cloud.port, "POST", "/api/me/model-proxy/v1/messages", {
      token: user.token,
      body: {
        model: "mia-default",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64
      }
    });
    assert.equal(anthropic.status, 200);
    assert.equal(anthropic.body.content[0].text, "mia-claude-ok");
    assert.ok(lite.calls.some((call) => call.path === "/v1/messages"));

    const counted = await request(cloud.port, "POST", "/api/me/model-proxy/v1/messages/count_tokens", {
      token: user.token,
      body: {
        model: "mia-default",
        messages: [{ role: "user", content: "hello" }]
      }
    });
    assert.equal(counted.status, 200);
    assert.equal(counted.body.input_tokens, 42);
    assert.ok(lite.calls.some((call) => call.path === "/v1/messages/count_tokens"));
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => lite.server.close(resolve));
  }
});
