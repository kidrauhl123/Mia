const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  parseDuckDuckGoHtml,
  parseWebPageText,
  permissionClassForTool,
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
