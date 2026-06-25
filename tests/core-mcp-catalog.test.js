const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  builtinMcpTemplates,
  builtinMcpTemplateById,
  materializeBuiltinMcpRecord
} = require("../src/core/mcp/catalog.js");

test("built-in catalog contains only the first supported Mia-managed set", () => {
  const templates = builtinMcpTemplates();
  assert.deepEqual(templates.map((item) => item.id), [
    "xiaohongshu",
    "playwright",
    "context7",
    "github",
    "tavily",
    "firecrawl"
  ]);
  assert.equal(templates.every((item) => ["native", "managed"].includes(item.managementMode)), true);
  assert.equal(templates.some((item) => /external/i.test(item.managementMode)), false);
  assert.equal(templates.some((item) => /notion|slack|gmail|drive|calendar|todoist|canva|gitlab/i.test(item.id)), false);
});

test("xiaohongshu is a managed connector owned by Mia", () => {
  const template = builtinMcpTemplateById("xiaohongshu");
  assert.equal(template.managementMode, "managed");
  assert.equal(template.nativeName, "xiaohongshu");
  assert.equal(template.transport.type, "http");
  assert.equal(template.transport.url, "http://127.0.0.1:18060/mcp");
  assert.equal(template.managedRuntime.connectorId, "xiaohongshu");
  assert.equal(template.managedRuntime.expectedToolCount, 13);
  assert.deepEqual(template.connectionWizard.actions.map((action) => action.id), [
    "install",
    "login",
    "start",
    "test"
  ]);
});

test("Lobster-derived native templates keep runtime commands out of user copy", () => {
  const byId = Object.fromEntries(builtinMcpTemplates().map((item) => [item.id, item]));
  assert.deepEqual(byId.playwright.transport.args, ["-y", "@executeautomation/playwright-mcp-server"]);
  assert.deepEqual(byId.context7.transport.args, ["-y", "@upstash/context7-mcp@latest"]);
  assert.deepEqual(byId.github.transport.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(byId.tavily.transport.args, ["-y", "tavily-mcp@latest"]);
  assert.deepEqual(byId.firecrawl.transport.args, ["-y", "firecrawl-mcp@latest"]);
  assert.equal(byId.playwright.setupCommands, undefined);
});

test("required env fields are represented as app form inputs", () => {
  const github = builtinMcpTemplateById("github");
  const tavily = builtinMcpTemplateById("tavily");
  const firecrawl = builtinMcpTemplateById("firecrawl");
  assert.deepEqual(github.requiredInputs.map((field) => field.key), ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  assert.deepEqual(tavily.requiredInputs.map((field) => field.key), ["TAVILY_API_KEY"]);
  assert.deepEqual(firecrawl.requiredInputs.map((field) => field.key), ["FIRECRAWL_API_KEY"]);
  assert.equal(github.requiredInputs[0].secret, true);
  assert.equal(github.requiredInputs[0].target, "env");
});

test("materializeBuiltinMcpRecord saves disabled until required inputs are present and tested", () => {
  const template = builtinMcpTemplateById("github");
  const missing = materializeBuiltinMcpRecord(template, {}, {
    now: () => 1710000000000,
    idFactory: (name) => `mcp_${name}`
  });
  assert.equal(missing.record.enabled, false);
  assert.equal(missing.record.managementMode, "native");
  assert.deepEqual(missing.missingRequiredInputs, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  assert.equal(missing.record.connectionWizard.state, "missing_required_inputs");

  const ready = materializeBuiltinMcpRecord(template, {
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret"
  }, {
    now: () => 1710000000000,
    idFactory: (name) => `mcp_${name}`
  });
  assert.deepEqual(ready.missingRequiredInputs, []);
  assert.equal(ready.record.enabled, false);
  assert.equal(ready.record.transport.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_secret");
  assert.equal(ready.record.connectionWizard.state, "ready_to_test");
});
