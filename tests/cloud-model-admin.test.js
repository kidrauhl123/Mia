const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { freePort } = require("./helpers/free-port");
const { seedCloudAccountInDataDir } = require("./helpers/cloud-auth.js");
const { createUserModelProxyToken } = require("../src/cloud/model-proxy-auth.js");

const dataDirsByPort = new Map();

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
    model_name: "mia-auto",
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
        res.end(JSON.stringify({ model: "mia-auto", choices: [{ message: { content: "mia-ok" } }] }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "mia-auto", output_text: "mia-ok" }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "mia-auto", content: [{ type: "text", text: "mia-claude-ok" }] }));
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

async function startDeepSeekFake({ models = [
  { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
  { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" }
] } = {}) {
  const port = await freePort();
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : {} });
      if (req.headers.authorization !== "Bearer deepseek-key") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unauthorized" } }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: models }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "deepseek-test",
          model: "deepseek-chat",
          choices: [{ message: { role: "assistant", content: "deepseek-ok" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, calls, server };
}

async function register(port, account) {
  const dataDir = dataDirsByPort.get(port);
  if (!dataDir) throw new Error("missing test cloud data dir for port " + port);
  return seedCloudAccountInDataDir(dataDir, account);
}

async function startCloud(litellmPort, extraEnv = {}) {
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
      MIA_CLOUD_AGENT_MODE: "disabled",
      MIA_LITELLM_ADMIN_BASE_URL: `http://127.0.0.1:${litellmPort}`,
      LITELLM_MASTER_KEY: "master",
      MIA_CLOUD_AGENT_MODEL_API_KEY: "service",
      MIA_MODEL_GATEWAY: "litellm",
      MIA_DEEPSEEK_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const done = () => resolve();
    proc.stdout.on("data", (chunk) => { if (/listening|Listening/.test(chunk.toString())) done(); });
    proc.stderr.on("data", (chunk) => { if (/listening|Listening|mia-cloud/i.test(chunk.toString())) done(); });
    proc.on("error", reject);
    setTimeout(done, 5000);
  });
  dataDirsByPort.set(port, tmpDir);
  return { port, proc, tmpDir };
}

async function stopCloud(ctx) {
  if (ctx.proc.exitCode === null && ctx.proc.signalCode === null) {
    ctx.proc.kill("SIGTERM");
    await new Promise((resolve) => ctx.proc.once("exit", resolve));
  }
  dataDirsByPort.delete(ctx.port);
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

test("admin model gateway replaces mia-auto without leaking provider key", async () => {
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
    assert.equal(lite.models[0].model_name, "mia-auto");
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

test("admin model gateway can add a second platform alias without deleting mia-auto", async () => {
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
    assert.deepEqual(lite.models.map((model) => model.model_name), ["mia-auto", "mia-pro"]);
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => lite.server.close(resolve));
  }
});

test("admin model page lets operators edit the public model alias", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src/web/admin-model.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "src/web/admin-model.js"), "utf8");
  assert.match(html, /id="publicModelInput"/);
  assert.match(html, /id="upstreamModelSelect"/);
  assert.match(html, /id="upstreamCustomWrap"/);
  assert.match(html, /data-custom-value="__custom__"/);
  assert.match(html, /admin-model\.css\?v=20260612-row-credit/);
  assert.match(html, /class="console-sidebar"/);
  assert.match(html, /data-admin-nav="overview"/);
  assert.match(html, /data-admin-nav="logs"/);
  assert.match(html, /id="overviewUsersBody"/);
  assert.match(html, /id="usageLogsBody"/);
  assert.match(html, /id="usageUsersBody"/);
  assert.match(html, /id="userCreditForm"/);
  assert.match(html, /user-filter-form/);
  assert.match(html, /搜索 UID \/ username/);
  assert.doesNotMatch(html, /id="creditAmountInput"/);
  assert.doesNotMatch(html, /id="grantCreditButton"/);
  assert.match(html, /高级参数/);
  assert.match(html, /id="inputPriceInput"/);
  assert.match(html, /id="outputPriceInput"/);
  assert.match(html, /id="markupInput"/);
  assert.match(html, /留空则保留已保存 key/);
  assert.doesNotMatch(html, /id="publicModelInput"[^>]*readonly/);
  assert.match(js, /publicModel/);
  assert.match(js, /renderUpstreamModelOptions/);
  assert.match(js, /selectedUpstreamModel/);
  assert.match(js, /modelOptions/);
  assert.match(js, /modelName:\s*els\.publicModel\.value/);
  assert.match(js, /upstreamModel:\s*selectedUpstreamModel\(\)/);
  assert.match(js, /inputMicrousdPerMillion:\s*els\.inputPrice\.value/);
  assert.match(js, /model-usage-summary/);
  assert.match(js, /data-admin-nav/);
  assert.match(js, /renderLogs/);
  assert.match(js, /UID \$\{user\.id\}/);
  assert.match(js, /userLookupParam/);
  assert.match(js, /userId/);
  assert.match(js, /row-credit-button/);
  assert.match(js, /data-credit-open/);
  assert.match(js, /grantInlineCredit/);
});

test("authenticated users can list platform model aliases without provider secrets", async () => {
  const lite = await startLiteLLMFake([
    {
      model_name: "mia-auto",
      litellm_params: { model: "deepseek/deepseek-chat", api_key: "sk-default-secret" },
      model_info: { id: "mia-auto", base_model: "deepseek/deepseek-chat", provider: "deepseek", label: "Mia Auto" }
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
    assert.deepEqual(catalog.body.models.map((model) => model.id), ["mia-auto", "mia-pro"]);
    assert.equal(catalog.body.models[0].label, "Mia Auto");
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
      model_name: "mia-auto",
      litellm_params: { model: "deepseek/deepseek-chat", api_key: "sk-default-secret" },
      model_info: { id: "mia-auto", base_model: "deepseek/deepseek-chat", provider: "deepseek", label: "Mia Auto" }
    }
  ]);
  const cloud = await startCloud(lite.port);
  try {
    const user = await register(cloud.port, "proxy");
    const models = await request(cloud.port, "GET", "/api/me/model-proxy/v1/models", { token: user.token });
    assert.equal(models.status, 200);
    assert.deepEqual(models.body.data.map((model) => model.id), ["mia-auto"]);

    const completion = await request(cloud.port, "POST", "/api/me/model-proxy/v1/chat/completions", {
      token: user.token,
      body: {
        model: "mia-auto",
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
        model: "mia-auto",
        input: "hello"
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.output_text, "mia-ok");
    assert.ok(lite.calls.some((call) => call.path === "/v1/responses"));

    const anthropic = await request(cloud.port, "POST", "/api/me/model-proxy/v1/messages", {
      token: user.token,
      body: {
        model: "mia-auto",
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
        model: "mia-auto",
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

test("DeepSeek gateway settings can be saved in admin without leaking the API key", async () => {
  const deepseek = await startDeepSeekFake();
  const cloud = await startCloud(9, {
    MIA_MODEL_GATEWAY: "deepseek",
    MIA_DEEPSEEK_API_KEY: "",
    MIA_DEEPSEEK_BASE_URL: "",
    MIA_MODEL_INPUT_MICROUSD_PER_1M: "",
    MIA_MODEL_OUTPUT_MICROUSD_PER_1M: ""
  });
  const auth = { username: "admin", password: "secret" };
  try {
    const saved = await request(cloud.port, "POST", "/api/admin/model-gateway", {
      auth,
      body: {
        modelName: "mia-admin",
        provider: "deepseek",
        upstreamModel: "deepseek/deepseek-chat",
        apiKey: "deepseek-key",
        apiBase: `http://127.0.0.1:${deepseek.port}/v1`,
        inputMicrousdPerMillion: 1000000,
        outputMicrousdPerMillion: 1000000,
        markup: 1
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.model.modelId, "mia-admin");
    assert.equal(saved.body.model.upstreamModel, "deepseek-chat");
    assert.equal(saved.body.model.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(saved.body), /deepseek-key/);

    const status = await request(cloud.port, "GET", "/api/admin/model-gateway", { auth });
    assert.equal(status.status, 200);
    assert.equal(status.body.gateway.configured, true);
    assert.equal(status.body.gateway.configuredFrom, "database");
    assert.equal(status.body.settings.modelId, "mia-admin");
    assert.equal(status.body.settings.hasApiKey, true);
    assert.deepEqual(status.body.modelOptions.map((model) => model.id), [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner"
    ]);
    assert.equal(status.body.modelOptions[0].source, "deepseek");
    assert.equal(status.body.modelOptions.find((model) => model.id === "deepseek-chat").deprecated, true);
    assert.doesNotMatch(JSON.stringify(status.body), /deepseek-key/);

    const tested = await request(cloud.port, "POST", "/api/admin/model-gateway/test", { auth, body: {} });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.reply, "deepseek-ok");
    assert.equal(tested.body.model, "mia-admin");

    const user = await register(cloud.port, "saved-deepseek");
    await request(cloud.port, "POST", "/api/admin/model-credits/grant", {
      auth,
      body: { userId: user.user.id, amountUsd: 1, reason: "test_topup" }
    });
    const completion = await request(cloud.port, "POST", "/api/me/model-proxy/v1/chat/completions", {
      token: user.token,
      body: { model: "mia-admin", messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(completion.status, 200);
    assert.equal(completion.body.choices[0].message.content, "deepseek-ok");
    assert.equal(deepseek.calls.at(-1).body.model, "deepseek-chat");

    const balance = await request(cloud.port, "GET", "/api/me/model-balance", { token: user.token });
    assert.equal(balance.status, 200);
    assert.equal(balance.body.balance.balanceMicrousd, 998500);

    const summary = await request(cloud.port, "GET", "/api/admin/model-usage-summary", { auth });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.totals.userCount, 1);
    assert.equal(summary.body.totals.activeUserCount, 1);
    assert.equal(summary.body.totals.requestCount, 1);
    assert.equal(summary.body.totals.totalTokens, 1500);
    assert.equal(summary.body.totals.chargeMicrousd, 1500);
    assert.equal(summary.body.users[0].user.username, "saved-deepseek");
    assert.equal(summary.body.users[0].balance.balanceMicrousd, 998500);
    assert.equal(summary.body.users[0].usage.chargeMicrousd, 1500);
    assert.equal(summary.body.recentUsage[0].user.username, "saved-deepseek");
    assert.doesNotMatch(JSON.stringify(summary.body), /deepseek-key|api_key/);
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => deepseek.server.close(resolve));
  }
});

test("DeepSeek direct model proxy requires balance and records billable usage", async () => {
  const deepseek = await startDeepSeekFake();
  const cloud = await startCloud(9, {
    MIA_MODEL_GATEWAY: "deepseek",
    MIA_DEEPSEEK_API_KEY: "deepseek-key",
    MIA_DEEPSEEK_BASE_URL: `http://127.0.0.1:${deepseek.port}/v1`,
    MIA_MODEL_INPUT_MICROUSD_PER_1M: "1000000",
    MIA_MODEL_OUTPUT_MICROUSD_PER_1M: "1000000"
  });
  const auth = { username: "admin", password: "secret" };
  try {
    const user = await register(cloud.port, "paid-user");
    const catalog = await request(cloud.port, "GET", "/api/me/model-catalog", { token: user.token });
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.models.map((model) => model.id), ["mia-auto"]);
    assert.equal(catalog.body.models[0].provider, "deepseek");

    const blocked = await request(cloud.port, "POST", "/api/me/model-proxy/v1/chat/completions", {
      token: user.token,
      body: { model: "mia-auto", messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(blocked.status, 402);
    assert.equal(deepseek.calls.length, 0);
    const blockedSummary = await request(cloud.port, "GET", "/api/admin/model-usage-summary", { auth });
    assert.equal(blockedSummary.status, 200);
    assert.equal(blockedSummary.body.totals.requestCount, 1);
    assert.equal(blockedSummary.body.totals.failedCount, 1);
    assert.equal(blockedSummary.body.totals.chargeMicrousd, 0);
    assert.equal(blockedSummary.body.recentUsage[0].status, "failed");
    assert.match(blockedSummary.body.recentUsage[0].error, /余额不足/);

    const grant = await request(cloud.port, "POST", "/api/admin/model-credits/grant", {
      auth,
      body: { userId: user.user.id, amountUsd: 1, reason: "test_topup" }
    });
    assert.equal(grant.status, 200);
    assert.equal(grant.body.balance.balanceMicrousd, 1000000);

    const completion = await request(cloud.port, "POST", "/api/me/model-proxy/v1/chat/completions", {
      token: user.token,
      body: { model: "mia-auto", messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(completion.status, 200);
    assert.equal(completion.body.choices[0].message.content, "deepseek-ok");
    assert.equal(deepseek.calls[0].body.model, "deepseek-chat");

    const balance = await request(cloud.port, "GET", "/api/me/model-balance", { token: user.token });
    assert.equal(balance.status, 200);
    assert.equal(balance.body.balance.balanceMicrousd, 998500);
    assert.equal(balance.body.recentUsage[0].promptTokens, 1000);
    assert.equal(balance.body.recentUsage[0].completionTokens, 500);
    assert.equal(balance.body.recentUsage[0].chargeMicrousd, 1500);
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => deepseek.server.close(resolve));
  }
});

test("internal model proxy token bills the owning Mia user", async () => {
  const deepseek = await startDeepSeekFake();
  const internalSecret = "internal-secret";
  const cloud = await startCloud(9, {
    MIA_MODEL_GATEWAY: "deepseek",
    MIA_DEEPSEEK_API_KEY: "deepseek-key",
    MIA_DEEPSEEK_BASE_URL: `http://127.0.0.1:${deepseek.port}/v1`,
    MIA_MODEL_INPUT_MICROUSD_PER_1M: "1000000",
    MIA_MODEL_OUTPUT_MICROUSD_PER_1M: "1000000",
    MIA_CLOUD_INTERNAL_MODEL_PROXY_KEY: internalSecret
  });
  const auth = { username: "admin", password: "secret" };
  try {
    const user = await register(cloud.port, "worker-user");
    await request(cloud.port, "POST", "/api/admin/model-credits/grant", {
      auth,
      body: { userId: user.user.id, amountUsd: 1, reason: "test_topup" }
    });
    const internalToken = createUserModelProxyToken(internalSecret, user.user.id);
    const completion = await request(cloud.port, "POST", "/api/internal/model-proxy/v1/chat/completions", {
      token: internalToken,
      body: { model: "mia-auto", messages: [{ role: "user", content: "hello from worker" }] }
    });
    assert.equal(completion.status, 200);
    assert.equal(completion.body.choices[0].message.content, "deepseek-ok");

    const adminBalance = await request(cloud.port, "GET", `/api/admin/model-credits?userId=${encodeURIComponent(user.user.id)}`, { auth });
    assert.equal(adminBalance.status, 200);
    assert.equal(adminBalance.body.balance.balanceMicrousd, 998500);
    assert.equal(adminBalance.body.recentUsage[0].provider, "deepseek");
  } finally {
    await stopCloud(cloud);
    await new Promise((resolve) => deepseek.server.close(resolve));
  }
});
