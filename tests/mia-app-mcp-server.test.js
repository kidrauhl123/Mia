const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const {
  isDuckDuckGoChallengePage,
  normalizeDdgsResults,
  parseDuckDuckGoHtml,
  parseRssItems,
  parseWebPageText,
  permissionClassForTool,
  runDdgsSearch,
  toolDefinitions
} = require("../src/main/mia-app-mcp-server.js");

test("mia-app MCP exposes scheduler, skills, and social tools", () => {
  const names = toolDefinitions().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "conversation_create_group",
    "conversation_list",
    "conversation_post_message",
    "schedule_create",
    "schedule_delete",
    "schedule_list",
    "schedule_pause",
    "schedule_resume",
    "schedule_update",
    "skill_install",
    "skill_search",
    "skill_show",
    "web_fetch",
    "web_search"
  ]);
});

test("write tools require permission", () => {
  assert.equal(permissionClassForTool("schedule_list"), "read");
  assert.equal(permissionClassForTool("skill_search"), "read");
  assert.equal(permissionClassForTool("web_search"), "read");
  assert.equal(permissionClassForTool("web_fetch"), "read");
  assert.equal(permissionClassForTool("skill_install"), "write");
  assert.equal(permissionClassForTool("conversation_create_group"), "write");
  assert.equal(permissionClassForTool("conversation_post_message"), "write");
  assert.equal(permissionClassForTool("unknown"), "unknown");
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
