const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const { createMcpSdkClientManager } = require("../src/main/mcp/mcp-sdk-client.js");

function fakeLoadSdk(events, overrides = {}) {
  class Client {
    constructor(info) {
      events.push(["client", info.name]);
    }

    async connect(transport) {
      events.push(["connect", transport.kind, transport.options]);
    }

    async listTools() {
      events.push(["listTools"]);
      return {
        tools: [
          { name: "search_notes", description: "Search notes", inputSchema: { type: "object" } }
        ]
      };
    }

    async callTool(request) {
      events.push(["callTool", request]);
      return { content: [{ type: "text", text: "ok" }], isError: false };
    }

    async close() {
      events.push(["close"]);
    }
  }

  class StdioClientTransport {
    constructor(options) {
      this.kind = "stdio";
      this.options = options;
      this.stderr = new EventEmitter();
    }
  }

  class SSEClientTransport {
    constructor(url, options) {
      this.kind = "sse";
      this.options = { url: url.toString(), requestInit: options?.requestInit || null };
    }
  }

  class StreamableHTTPClientTransport {
    constructor(url, options) {
      this.kind = "streamable_http";
      this.options = { url: url.toString(), requestInit: options?.requestInit || null };
    }
  }

  return async () => ({
    Client: overrides.Client || Client,
    StdioClientTransport: overrides.StdioClientTransport || StdioClientTransport,
    SSEClientTransport: overrides.SSEClientTransport || SSEClientTransport,
    StreamableHTTPClientTransport: overrides.StreamableHTTPClientTransport || StreamableHTTPClientTransport
  });
}

test("testServer connects through stdio and returns tool manifest", async () => {
  const events = [];
  const manager = createMcpSdkClientManager({
    loadSdk: fakeLoadSdk(events),
    processEnvStrings: () => ({ PATH: "/usr/bin", HOME: "/tmp/home" })
  });

  const result = await manager.testServer({
    name: "xhs",
    transport: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { API_TOKEN: "secret" } }
  });

  assert.equal(result.success, true);
  assert.equal(result.tools[0].name, "search_notes");
  assert.deepEqual(events[1], ["connect", "stdio", {
    command: "npx",
    args: ["-y", "pkg"],
    env: { PATH: "/usr/bin", HOME: "/tmp/home", API_TOKEN: "secret" }
  }]);
});

test("refresh stores enabled server tools and callTool routes by server name", async () => {
  const events = [];
  const manager = createMcpSdkClientManager({ loadSdk: fakeLoadSdk(events), processEnvStrings: () => ({}) });

  const refreshed = await manager.refresh([
    { name: "xhs", enabled: true, transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: { Authorization: "Bearer secret" } } }
  ]);
  const called = await manager.callTool("xhs", "search_notes", { q: "Mia" });

  assert.equal(refreshed.success, true);
  assert.deepEqual(manager.toolManifest().map((tool) => `${tool.server}.${tool.name}`), ["xhs.search_notes"]);
  assert.equal(called.content[0].text, "ok");
});

test("HTTP transports resolve bearerTokenEnvVar into Authorization header", async () => {
  const events = [];
  const manager = createMcpSdkClientManager({
    loadSdk: fakeLoadSdk(events),
    processEnvStrings: () => ({ XHS_TOKEN: "env-secret" })
  });

  const result = await manager.testServer({
    name: "xhs",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp", bearerTokenEnvVar: "XHS_TOKEN" }
  });

  assert.equal(result.success, true);
  assert.deepEqual(events[1], ["connect", "streamable_http", {
    url: "http://127.0.0.1:18060/mcp",
    requestInit: { headers: { Authorization: "Bearer env-secret" } }
  }]);
});

test("HTTP transports keep explicit Authorization before bearerTokenEnvVar", async () => {
  const events = [];
  const manager = createMcpSdkClientManager({
    loadSdk: fakeLoadSdk(events),
    processEnvStrings: () => ({ XHS_TOKEN: "env-secret" })
  });

  const result = await manager.testServer({
    name: "xhs",
    transport: {
      type: "streamable_http",
      url: "http://127.0.0.1:18060/mcp",
      headers: { Authorization: "Bearer explicit" },
      bearerTokenEnvVar: "XHS_TOKEN"
    }
  });

  assert.equal(result.success, true);
  assert.deepEqual(events[1][2].requestInit.headers, { Authorization: "Bearer explicit" });
});

test("HTTP transports use OAuth Authorization header during refresh", async () => {
  const events = [];
  const manager = createMcpSdkClientManager({
    loadSdk: fakeLoadSdk(events),
    processEnvStrings: () => ({}),
    oauthService: {
      authorizationHeadersForServer: async (record) => ({
        Authorization: `Bearer oauth-for-${record.name}`
      })
    }
  });

  const refreshed = await manager.refresh([
    { name: "xhs", enabled: true, transport: { type: "http", url: "http://127.0.0.1:18060/mcp" } }
  ]);

  assert.equal(refreshed.success, true);
  assert.deepEqual(events[1], ["connect", "streamable_http", {
    url: "http://127.0.0.1:18060/mcp",
    requestInit: { headers: { Authorization: "Bearer oauth-for-xhs" } }
  }]);
});

test("HTTP transports keep explicit Authorization before OAuth Authorization", async () => {
  const events = [];
  const manager = createMcpSdkClientManager({
    loadSdk: fakeLoadSdk(events),
    processEnvStrings: () => ({}),
    oauthService: {
      authorizationHeadersForServer: async () => ({
        Authorization: "Bearer oauth",
        "X-OAuth": "present"
      })
    }
  });

  const refreshed = await manager.refresh([
    {
      name: "xhs",
      enabled: true,
      transport: {
        type: "http",
        url: "http://127.0.0.1:18060/mcp",
        headers: { Authorization: "Bearer explicit" }
      }
    }
  ]);

  assert.equal(refreshed.success, true);
  assert.deepEqual(events[1][2].requestInit.headers, {
    Authorization: "Bearer explicit",
    "X-OAuth": "present"
  });
});

test("callTool checks authorizeToolCall before invoking the SDK client", async () => {
  const events = [];
  const calls = [];
  const manager = createMcpSdkClientManager({
    loadSdk: fakeLoadSdk(events),
    processEnvStrings: () => ({}),
    authorizeToolCall: async (payload) => {
      calls.push(payload);
      return { allowed: true };
    }
  });

  await manager.refresh([
    { name: "xhs", enabled: true, transport: { type: "http", url: "http://127.0.0.1:18060/mcp" } }
  ]);
  await manager.callTool("xhs", "search_notes", { q: "Mia" }, { source: "bridge" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].serverName, "xhs");
  assert.equal(calls[0].toolName, "search_notes");
  assert.deepEqual(calls[0].args, { q: "Mia" });
  assert.equal(calls[0].record.name, "xhs");
  assert.equal(calls[0].record.transport.type, "http");
  assert.equal(calls[0].record.transport.url, "http://127.0.0.1:18060/mcp");
  assert.deepEqual(calls[0].options, { source: "bridge", toolLabel: "xhs.search_notes" });
  assert.equal(events.some((entry) => entry[0] === "callTool"), true);
});

test("callTool returns an MCP error response when authorizeToolCall does not allow it", async () => {
  const events = [];
  const manager = createMcpSdkClientManager({
    loadSdk: fakeLoadSdk(events),
    processEnvStrings: () => ({}),
    authorizeToolCall: async () => ({ allowed: false, reason: "Denied" })
  });

  await manager.refresh([
    { name: "xhs", enabled: true, transport: { type: "http", url: "http://127.0.0.1:18060/mcp" } }
  ]);
  const result = await manager.callTool("xhs", "search_notes", { q: "Mia" });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Denied/);
  assert.equal(events.some((entry) => entry[0] === "callTool"), false);
});

test("refresh and testServer redact bridge errors before logging or returning them", async () => {
  const logs = [];
  const boom = Object.assign(new Error("Authorization: Bearer ghp_bridge_refresh_secret X_API_KEY=super_secret_value"), {
    code: "EAUTH"
  });
  const manager = createMcpSdkClientManager({
    loadSdk: fakeLoadSdk([], {
      Client: class Client {
        async connect() {
          throw boom;
        }
      }
    }),
    processEnvStrings: () => ({}),
    appendLog: (line) => logs.push(line)
  });

  const tested = await manager.testServer({
    name: "alpha",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: { Authorization: "Bearer ghp_bridge_refresh_secret" } }
  });
  const refreshed = await manager.refresh([
    {
      name: "alpha",
      enabled: true,
      transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: { Authorization: "Bearer ghp_bridge_refresh_secret" } }
    }
  ]);

  assert.equal(tested.success, false);
  assert.match(tested.error, /\[redacted\]/);
  assert.doesNotMatch(tested.error, /ghp_bridge_refresh_secret|super_secret_value/);
  assert.equal(refreshed.success, false);
  assert.match(refreshed.errors[0].error, /\[redacted\]/);
  assert.doesNotMatch(refreshed.errors[0].error, /ghp_bridge_refresh_secret|super_secret_value/);
  assert.equal(logs.length >= 2, true);
  for (const line of logs) {
    assert.match(line, /\[redacted\]/);
    assert.doesNotMatch(line, /ghp_bridge_refresh_secret|super_secret_value/);
  }
});
