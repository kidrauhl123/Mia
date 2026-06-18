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
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ task: { id: "task_1", ...calls[0].body } }));
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
      MIA_DAEMON_URL: daemon.url,
      MIA_DAEMON_TOKEN: "token",
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
  assert.equal(calls[0].url, "/api/tasks");
  assert.equal(calls[0].body.botId, "bot_1");
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].body, "fellow" + "Id"), false);
  assert.equal(calls[0].body.sessionId, "conversation:botc_u1_bot_1");
  assert.equal(calls[0].body.originMessageId, "msg_1");
  const text = result.result.content[0].text;
  const payload = JSON.parse(text);
  assert.equal(payload.taskId, "task_1");
  assert.equal(payload.nextFireAt, new Date("2026-06-06T09:00:00+08:00").getTime());
  assert.match(payload.nextFireAtLocal, /2026/);
  assert.match(payload.nextFireAtLocal, /09:00/);
});
