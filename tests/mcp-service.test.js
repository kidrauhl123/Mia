const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createMcpService } = require("../src/main/mcp/mcp-service.js");

function createHarness(routes = {}, extraDeps = {}) {
  const calls = [];
  const service = createMcpService({
    coreRequest: async (method, route, body) => {
      calls.push({ method, route, body });
      const key = `${method} ${route}`;
      const value = routes[key];
      if (value instanceof Error) throw value;
      if (typeof value === "function") return value(body);
      if (value !== undefined) return value;
      return {};
    },
    ...extraDeps
  });
  return { calls, service };
}

test("MCP service routes list save test and delete through Rust Core", async () => {
  const { calls, service } = createHarness({
    "GET /api/mcp/servers": { servers: [{ id: "mcp_docs", name: "docs" }] },
    "POST /api/mcp/servers": { server: { id: "mcp_docs", name: "docs" } },
    "POST /api/mcp/servers/mcp_docs/test": {
      ok: true,
      diagnostic: { status: "connected", tools: [{ name: "search" }] }
    },
    "DELETE /api/mcp/servers/mcp_docs": { ok: true },
    "GET /api/mcp/agent-configs": { configs: { mcpServers: {}, mcp_servers: {} } }
  });

  const listed = await service.list();
  const saved = await service.save({ name: "docs", transport: { type: "http", url: "https://example.test/mcp" } });
  const tested = await service.test("mcp_docs");
  const deleted = await service.delete("mcp_docs");

  assert.equal(listed.success, true);
  assert.deepEqual(listed.data.servers.map((server) => server.id), ["mcp_docs"]);
  assert.equal(saved.data.id, "mcp_docs");
  assert.equal(tested.data.status, "connected");
  assert.equal(deleted.data.ok, true);
  const businessRoutes = calls
    .map((call) => `${call.method} ${call.route}`)
    .filter((route) => route !== "GET /api/mcp/agent-configs");
  assert.deepEqual(businessRoutes, [
    "GET /api/mcp/servers",
    "POST /api/mcp/servers",
    "POST /api/mcp/servers/mcp_docs/test",
    "DELETE /api/mcp/servers/mcp_docs"
  ]);
});

test("MCP service caches Rust Core agent configs for runtime injection", async () => {
  const { calls, service } = createHarness({
    "GET /api/mcp/agent-configs": {
      configs: {
        mcpServers: {
          docs: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer redacted" }
          }
        },
        mcp_servers: {
          docs: {
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer redacted" }
          }
        }
      }
    }
  });

  const initialized = await service.initialize();

  assert.equal(initialized.success, true);
  assert.equal(service.getEngineSpecs("codex").docs.type, "http");
  assert.equal(service.getEngineSpecs("claude-code").docs.url, "https://example.test/mcp");
  assert.equal(service.getEngineSpecs("hermes").docs.url, "https://example.test/mcp");
  assert.match(service.fingerprint(), /^core-mcp:[a-f0-9]{16}$/);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.route}`), ["GET /api/mcp/agent-configs"]);
});

test("MCP service wraps Core errors in the legacy success envelope", async () => {
  const { service } = createHarness({
    "GET /api/mcp/servers": new Error("Core unavailable")
  });

  const listed = await service.list();

  assert.equal(listed.success, false);
  assert.match(listed.error, /Core unavailable/);
});

test("MCP service opens Core-returned OAuth authUrl through the foreground adapter", async () => {
  const opened = [];
  const { calls, service } = createHarness(
    {
      "POST /api/mcp/oauth/mcp_docs/login": {
        ok: true,
        authUrl: "https://auth.example.test/authorize?state=abc"
      }
    },
    {
      openExternal: async (url) => {
        opened.push(url);
        return true;
      }
    }
  );

  const result = await service.oauth.login({ serverId: "mcp_docs" });

  assert.equal(result.success, true);
  assert.deepEqual(opened, ["https://auth.example.test/authorize?state=abc"]);
  assert.deepEqual(calls, [
    {
      method: "POST",
      route: "/api/mcp/oauth/mcp_docs/login",
      body: { serverId: "mcp_docs" }
    }
  ]);
});
