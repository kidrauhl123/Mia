const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  createCoreMcpAgentConfigService,
  parseClaudeMcpList,
  parseCodexMcpListJson,
  parseHermesConfigYaml,
  parseOpenClawMcpListJson
} = require("../src/core/mcp/agent-configs.js");

test("parses Claude MCP list output and marks plugin or failed entries not importable", () => {
  const servers = parseClaudeMcpList("xhs: npx -y xhs-mcp - ✓ Connected\nplugin:skip: node skip.js - ✓ Connected\nbroken: node bad.js - ✗ Failed");

  assert.equal(servers[0].name, "xhs");
  assert.equal(servers[0].importable, true);
  assert.equal(servers[0].transport.command, "npx");
  assert.deepEqual(servers[0].transport.args, ["-y", "xhs-mcp"]);
  assert.equal(servers[1].importable, false);
  assert.equal(servers[1].importSkipReason, "Plugin-managed MCP");
  assert.equal(servers[2].importable, false);
  assert.equal(servers[2].importSkipReason, "Failed");
});

test("parses Codex MCP JSON output with env object and env_vars", () => {
  const servers = parseCodexMcpListJson(JSON.stringify([
    { name: "pw", enabled: true, transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"], env: { A: "B" } } },
    { name: "env-vars", enabled: true, transport: { type: "stdio", command: "node", env_vars: [{ name: "TOKEN", value: "secret" }] } },
    { name: "remote", enabled: false, transport: { type: "http", url: "https://example.com/mcp" } }
  ]));

  assert.deepEqual(servers.map((item) => [item.name, item.importable]), [["pw", true], ["env-vars", true], ["remote", false]]);
  assert.deepEqual(servers[0].transport.env, { A: "B" });
  assert.deepEqual(servers[1].transport.env, { TOKEN: "secret" });
});

test("parses OpenClaw MCP JSON output with source override", () => {
  const servers = parseOpenClawMcpListJson(JSON.stringify([
    { name: "xhs", enabled: true, transport: { type: "http", url: "http://127.0.0.1:18060/mcp" } }
  ]));

  assert.equal(servers[0].source, "openclaw");
  assert.equal(servers[0].name, "xhs");
});

test("parses Hermes config yaml mcp_servers with stdio http and sse", () => {
  const servers = parseHermesConfigYaml("mcp_servers:\n  xhs:\n    url: http://127.0.0.1:18060/mcp\n  pw:\n    command: npx\n    args:\n      - -y\n      - '@playwright/mcp'\n  events:\n    type: sse\n    url: https://example.com/sse\n");

  assert.deepEqual(servers.map((item) => item.name), ["xhs", "pw", "events"]);
  assert.equal(servers[0].transport.type, "http");
  assert.equal(servers[1].transport.command, "npx");
  assert.equal(servers[2].transport.type, "sse");
});

test("getAgentConfigs uses runner and temp Hermes home without writing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-mcp-agent-configs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".hermes"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".hermes", "config.yaml"), "mcp_servers:\n  xhs:\n    url: http://127.0.0.1:18060/mcp\n");
  const commands = [];
  const service = createCoreMcpAgentConfigService({
    runtimePaths: () => ({ hermesHome: path.join(dir, ".hermes") }),
    fs,
    runner: async (command, args) => {
      commands.push([command, args]);
      if (command === "claude") return { ok: true, stdout: "claude-pw: npx -y pw - ✓ Connected", stderr: "" };
      if (command === "codex") return { ok: true, stdout: JSON.stringify([{ name: "codex-pw", enabled: true, transport: { type: "stdio", command: "npx", args: ["-y", "pw"] } }]), stderr: "" };
      if (command === "openclaw") return { ok: false, stdout: "", stderr: "unsupported TOKEN=secret" };
      return { ok: false, stdout: "", stderr: "" };
    }
  });

  const sources = await service.getAgentConfigs();

  assert.deepEqual(sources.map((source) => source.source), ["claude-code", "codex", "openclaw", "hermes"]);
  assert.equal(sources.find((source) => source.source === "hermes").servers[0].name, "xhs");
  assert.equal(sources.find((source) => source.source === "openclaw").installed, false);
  assert.equal(sources.find((source) => source.source === "openclaw").error, "unsupported TOKEN=[redacted]");
  assert.ok(commands.some(([command]) => command === "claude"));
});
