const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const {
  callTool,
  isDuckDuckGoChallengePage,
  normalizeDdgsResults,
  parseDuckDuckGoHtml,
  parseRssItems,
  parseWebPageText,
  permissionClassForTool,
  runDdgsSearch,
  toolDefinitions
} = require("../src/main/mia-app-mcp-server.js");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

test("mia-app MCP exposes scheduler, skills, and social tools", () => {
  const names = toolDefinitions().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "context_snapshot",
    "conversation_create_group",
    "conversation_list",
    "conversation_post_message",
    "memory_forget",
    "memory_list",
    "memory_remember",
    "memory_search",
    "memory_update",
    "schedule_create",
    "schedule_delete",
    "schedule_list",
    "schedule_pause",
    "schedule_resume",
    "schedule_update",
    "skill_install",
    "skill_list_current",
    "skill_read_current",
    "skill_search",
    "skill_show",
    "web_fetch",
    "web_search"
  ]);
});

test("write tools require permission", () => {
  assert.equal(permissionClassForTool("schedule_list"), "read");
  assert.equal(permissionClassForTool("context_snapshot"), "read");
  assert.equal(permissionClassForTool("skill_search"), "read");
  assert.equal(permissionClassForTool("skill_list_current"), "read");
  assert.equal(permissionClassForTool("skill_read_current"), "read");
  assert.equal(permissionClassForTool("memory_search"), "read");
  assert.equal(permissionClassForTool("memory_list"), "read");
  assert.equal(permissionClassForTool("web_search"), "read");
  assert.equal(permissionClassForTool("web_fetch"), "read");
  assert.equal(permissionClassForTool("skill_install"), "write");
  assert.equal(permissionClassForTool("memory_remember"), "write");
  assert.equal(permissionClassForTool("memory_update"), "write");
  assert.equal(permissionClassForTool("memory_forget"), "write");
  assert.equal(permissionClassForTool("conversation_create_group"), "write");
  assert.equal(permissionClassForTool("conversation_post_message"), "write");
  assert.equal(permissionClassForTool("unknown"), "unknown");
});

test("memory write tools expose bounded retrieval priority", () => {
  const byName = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
  for (const name of ["memory_remember", "memory_update"]) {
    const priority = byName.get(name)?.inputSchema?.properties?.priority;
    assert.equal(priority?.type, "number");
    assert.match(priority?.description || "", /-100 to 100/);
  }
});

test("schedule tools route to Rust Core task job endpoints", async (t) => {
	  const previous = {
	    MIA_CORE_URL: process.env.MIA_CORE_URL,
	    MIA_CORE_TOKEN: process.env.MIA_CORE_TOKEN
	  };
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = bodyText ? JSON.parse(bodyText) : null;
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/api/tasks/jobs") {
        res.end(JSON.stringify({
          jobs: [{
            id: "task_core_listed",
            kind: "agent",
            schedule: { type: "cron", cron: "0 9 * * *", timezone: "Asia/Shanghai" },
            target: { botId: "mia", conversationId: "conv_1", sessionId: "conv_1", title: "Listed" },
            instructions: "List",
            status: "active",
            nextRunAt: 1710000000000
          }]
        }));
        return;
      }
      const status = body?.status || "active";
      res.end(JSON.stringify({
        job: {
          id: "task_core_1",
          kind: body?.kind || "agent",
          schedule: body?.schedule || { type: "cron", cron: "0 9 * * *", timezone: "Asia/Shanghai" },
          target: body?.target || { botId: "mia", conversationId: "conv_1", sessionId: "conv_1", title: "Daily" },
          instructions: body?.instructions || "",
          status,
          nextRunAt: 1710000000000
        }
      }));
    });
  });
  t.after(() => {
    server.close();
    restoreEnv(previous);
  });
  process.env.MIA_CORE_URL = await listen(server);
  process.env.MIA_CORE_TOKEN = "core-token";

  const created = await callTool("schedule_create", {
    title: "Daily",
    botId: "mia",
    sessionId: "conv_1",
    trigger: { type: "cron", cron: "0 9 * * *" },
    timezone: "Asia/Shanghai",
    prompt: "Summarize"
  });
  const listed = await callTool("schedule_list", {});
  const paused = await callTool("schedule_pause", { id: "task_core_1" });

  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "/api/tasks/jobs");
  assert.equal(calls[0].auth, "Bearer core-token");
  assert.deepEqual(calls[0].body, {
    kind: "agent",
    schedule: { type: "cron", cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    target: {
      botId: "mia",
      conversationId: "conv_1",
      sessionId: "conv_1",
      title: "Daily",
      timezone: "Asia/Shanghai",
      fireMode: "agent",
      deliveryText: "",
      originMessageId: ""
    },
    instructions: "Summarize"
  });
  assert.equal(created.taskId, "task_core_1");
  assert.equal(created.task.nextFireAt, 1710000000000);
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].url, "/api/tasks/jobs");
  assert.equal(listed.tasks[0].id, "task_core_listed");
  assert.equal(calls[2].method, "PATCH");
  assert.equal(calls[2].url, "/api/tasks/jobs/task_core_1");
  assert.deepEqual(calls[2].body, { status: "paused" });
  assert.equal(paused.task.status, "paused");
});

test("memory MCP schema does not ask agents to classify memory kinds", () => {
  const byName = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
  for (const name of ["memory_search", "memory_list", "memory_remember", "memory_update"]) {
    const properties = byName.get(name)?.inputSchema?.properties || {};
    assert.equal(Object.prototype.hasOwnProperty.call(properties, "kind"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(properties, "kinds"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(properties, "status"), false);
  }
});

test("memory MCP tools expose read/write annotations from the same permission classes", () => {
  const byName = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get("memory_search")?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  assert.deepEqual(byName.get("memory_list")?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  assert.deepEqual(byName.get("memory_remember")?.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  });
  assert.deepEqual(byName.get("memory_update")?.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  });
  assert.deepEqual(byName.get("memory_forget")?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  });
});

test("parseDuckDuckGoHtml extracts result URLs and snippets", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fworld&amp;rut=x">Example &amp; Result</a>
      <a class="result__snippet">A useful <b>snippet</b>.</a>
    </div>
  `;
  assert.deepEqual(parseDuckDuckGoHtml(html, 5), [{
    title: "Example & Result",
    url: "https://example.com/world",
    snippet: "A useful snippet."
  }]);
});

test("isDuckDuckGoChallengePage detects anti-bot pages", () => {
  assert.equal(isDuckDuckGoChallengePage("<html>Unfortunately, bots use DuckDuckGo too.</html>"), true);
  assert.equal(isDuckDuckGoChallengePage("<script src=\"/dist/anomaly.js\"></script>"), true);
  assert.equal(isDuckDuckGoChallengePage("<div class=\"result\">normal results</div>"), false);
});

test("normalizeDdgsResults maps Hermes DDGS provider output into Mia search results", () => {
  const providerResult = {
    success: true,
    data: {
      web: [
        { title: "Agent News", url: "https://example.com/agent", description: "Fresh update", position: 2 },
        { title: "Agent News", url: "https://example.com/agent", description: "Duplicate" },
        { title: "No URL", description: "ignored" }
      ]
    }
  };
  assert.deepEqual(normalizeDdgsResults(providerResult, 5), [{
    title: "Agent News",
    url: "https://example.com/agent",
    snippet: "Fresh update",
    position: 2
  }]);
});

test("runDdgsSearch falls through to the next Python when a candidate lacks ddgs", async (t) => {
  const previous = {
    MIA_DDGS_PYTHON: process.env.MIA_DDGS_PYTHON,
    MIA_PYTHON: process.env.MIA_PYTHON,
    PYTHON: process.env.PYTHON
  };
  process.env.MIA_DDGS_PYTHON = "missing-ddgs-python";
  process.env.MIA_PYTHON = "working-ddgs-python";
  delete process.env.PYTHON;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const calls = [];
  const spawn = (command) => {
    calls.push(command);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = { end() {} };
    child.kill = () => {};
    process.nextTick(() => {
      const payload = command === "missing-ddgs-python"
        ? { success: false, error: "ddgs package is not installed - run pip install ddgs" }
        : { success: true, data: { web: [{ title: "Ok", url: "https://example.com", description: "Found", position: 1 }] } };
      child.stdout.write(JSON.stringify(payload));
      child.stdout.end();
      child.emit("exit", 0);
    });
    return child;
  };

  const result = await runDdgsSearch("agent news", 1, { spawn, timeoutMs: 1000 });

  assert.deepEqual(calls.slice(0, 2), ["missing-ddgs-python", "working-ddgs-python"]);
  assert.equal(result.success, true);
  assert.equal(result.data.web[0].url, "https://example.com");
});

test("parseRssItems extracts web search RSS results", () => {
  const rss = `
    <rss><channel>
      <item>
        <title><![CDATA[AI Agent &amp; News]]></title>
        <link>https://example.com/agent-news</link>
        <description><![CDATA[Fresh <b>agent</b> update.]]></description>
        <source url="https://example.com">Example</source>
        <pubDate>Tue, 30 Jun 2026 12:00:00 GMT</pubDate>
      </item>
    </channel></rss>
  `;
  assert.deepEqual(parseRssItems(rss, 5), [{
    title: "AI Agent & News",
    url: "https://example.com/agent-news",
    snippet: "Fresh agent update.",
    sourceName: "Example",
    publishedAt: "Tue, 30 Jun 2026 12:00:00 GMT"
  }]);
});

test("parseWebPageText strips scripts styles and tags", () => {
  const parsed = parseWebPageText(`
    <html><head><title>Example &amp; Page</title><style>.x{}</style></head>
    <body><script>secret()</script><main><h1>Hello</h1><p>World</p></main></body></html>
  `, "https://example.com", 1000);
  assert.equal(parsed.title, "Example & Page");
  assert.equal(parsed.url, "https://example.com");
  assert.match(parsed.text, /Hello World/);
  assert.doesNotMatch(parsed.text, /secret|\.x/);
});
