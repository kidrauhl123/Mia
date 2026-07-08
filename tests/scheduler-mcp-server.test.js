const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function startDaemon(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function nextJsonLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      child.stdout.off("data", onData);
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
  });
}

function send(child, request) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
  return nextJsonLine(child);
}

test("schedule_create injects botId from scheduler context", async (t) => {
  const calls = [];
  const daemon = await startDaemon((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ job: { id: "task_1", status: "active", ...calls[0].body } }));
    });
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-scheduler-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contextPath = path.join(dir, "ctx.json");
  fs.writeFileSync(contextPath, JSON.stringify({
    botId: "bot_1",
    sessionId: "conversation:botc_u1_bot_1",
    originMessageId: "msg_1"
  }), "utf8");

  const child = spawn(process.execPath, [path.join(__dirname, "../src/main/scheduler-mcp-server.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
	      MIA_CORE_URL: daemon.url,
	      MIA_CORE_TOKEN: "token",
      MIA_SCHEDULER_CONTEXT_FILE: contextPath
    }
  });
  t.after(() => child.kill());

  const result = await send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "schedule_create",
      arguments: {
        title: "Daily",
        trigger: { type: "oneshot", at: "2026-06-06T09:00:00+08:00" },
        prompt: "summarize"
      }
    }
  });

  assert.equal(result.result.isError, false);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "/api/tasks/jobs");
  assert.equal(calls[0].body.target.botId, "bot_1");
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].body, "fellow" + "Id"), false);
  assert.equal(calls[0].body.target.sessionId, "conversation:botc_u1_bot_1");
  assert.equal(calls[0].body.target.originMessageId, "msg_1");
  const text = result.result.content[0].text;
  const payload = JSON.parse(text);
  assert.equal(payload.taskId, "task_1");
  assert.equal(payload.nextFireAt, new Date("2026-06-06T09:00:00+08:00").getTime());
  assert.match(payload.nextFireAtLocal, /2026/);
  assert.match(payload.nextFireAtLocal, /09:00/);
});

test("schedule_create forwards direct delivery fields", async (t) => {
  const calls = [];
  const daemon = await startDaemon((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ job: { id: "task_deliver", status: "active", ...calls[0].body } }));
    });
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-scheduler-mcp-direct-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contextPath = path.join(dir, "ctx.json");
  fs.writeFileSync(contextPath, JSON.stringify({
    botId: "bot_1",
    sessionId: "conversation:botc_u1_bot_1",
    originMessageId: "msg_1"
  }), "utf8");

  const child = spawn(process.execPath, [path.join(__dirname, "../src/main/scheduler-mcp-server.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
	      MIA_CORE_URL: daemon.url,
	      MIA_CORE_TOKEN: "token",
      MIA_SCHEDULER_CONTEXT_FILE: contextPath
    }
  });
  t.after(() => child.kill());

  const result = await send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "schedule_create",
      arguments: {
        title: "吃饭提醒",
        trigger: { type: "oneshot", at: "2026-06-06T09:00:00+08:00" },
        fireMode: "deliver",
        deliveryText: "该吃饭了",
        prompt: "提醒我吃饭"
      }
    }
  });

  assert.equal(result.result.isError, false);
  assert.equal(calls[0].body.kind, "deliver");
  assert.equal(calls[0].body.target.fireMode, "deliver");
  assert.equal(calls[0].body.target.deliveryText, "该吃饭了");
  const payload = JSON.parse(result.result.content[0].text);
  assert.equal(payload.task.fireMode, "deliver");
  assert.equal(payload.task.deliveryText, "该吃饭了");
});

test("schedule_create forwards Hermes-style schedule strings for Mia-side time parsing", async (t) => {
  const calls = [];
  const at = "2026-06-18T08:23:34.000Z";
  const daemon = await startDaemon((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        job: {
          id: "task_schedule",
          status: "active",
          ...calls[0].body,
          schedule: { type: "oneshot", atMs: new Date(at).getTime() },
          nextRunAt: new Date(at).getTime()
        }
      }));
    });
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-scheduler-mcp-schedule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contextPath = path.join(dir, "ctx.json");
  fs.writeFileSync(contextPath, JSON.stringify({
    botId: "bot_1",
    sessionId: "conversation:botc_u1_bot_1",
    originMessageId: "msg_1"
  }), "utf8");

  const child = spawn(process.execPath, [path.join(__dirname, "../src/main/scheduler-mcp-server.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
	      MIA_CORE_URL: daemon.url,
	      MIA_CORE_TOKEN: "token",
      MIA_SCHEDULER_CONTEXT_FILE: contextPath
    }
  });
  t.after(() => child.kill());

  const result = await send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "schedule_create",
      arguments: {
        title: "睡觉提醒",
        schedule: "1m",
        fireMode: "deliver",
        deliveryText: "该睡觉了"
      }
    }
  });

  assert.equal(result.result.isError, false);
  assert.equal(calls[0].body.schedule, "1m");
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].body, "trigger"), false);
  const payload = JSON.parse(result.result.content[0].text);
  assert.equal(payload.taskId, "task_schedule");
  assert.equal(payload.nextFireAt, new Date(at).getTime());
});

test("schedule_create accepts legacy daemon env while using Rust Core task jobs", async (t) => {
  const calls = [];
  const at = "2026-07-08T06:25:00.000Z";
  const daemon = await startDaemon((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(body || "{}")
      });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        job: {
          id: "task_legacy_env",
          status: "active",
          ...calls[0].body,
          schedule: { type: "oneshot", atMs: new Date(at).getTime() },
          nextRunAt: new Date(at).getTime()
        }
      }));
    });
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-scheduler-mcp-legacy-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contextPath = path.join(dir, "ctx.json");
  fs.writeFileSync(contextPath, JSON.stringify({
    botId: "starter_100001_hermes",
    sessionId: "botc_hermes",
    originMessageId: "msg_hermes"
  }), "utf8");

  const child = spawn(process.execPath, [path.join(__dirname, "../src/main/scheduler-mcp-server.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MIA_CORE_URL: "",
      MIA_CORE_TOKEN: "",
      MIA_DAEMON_URL: daemon.url,
      MIA_DAEMON_TOKEN: "legacy-token",
      MIA_SCHEDULER_CONTEXT_FILE: contextPath
    }
  });
  t.after(() => child.kill());

  const result = await send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "schedule_create",
      arguments: {
        title: "吃饭提醒",
        schedule: "2m",
        fireMode: "deliver",
        deliveryText: "该吃饭了"
      }
    }
  });

  assert.equal(result.result.isError, false);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "/api/tasks/jobs");
  assert.equal(calls[0].authorization, "Bearer legacy-token");
  assert.equal(calls[0].body.instructions, "该吃饭了");
  assert.equal(calls[0].body.target.botId, "starter_100001_hermes");
  assert.equal(calls[0].body.target.sessionId, "botc_hermes");
  const payload = JSON.parse(result.result.content[0].text);
  assert.equal(payload.taskId, "task_legacy_env");
});
