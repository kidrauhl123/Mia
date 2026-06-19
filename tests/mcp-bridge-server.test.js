const assert = require("node:assert/strict");
const { test } = require("node:test");
const http = require("node:http");
const { createMcpBridgeServer } = require("../src/main/mcp/mcp-bridge-server.js");
const {
  buildProxyToolEntries,
  createProxyHandlers,
  indexProxyToolEntries,
  proxyToolName
} = require("../src/main/mcp/mcp-stdio-proxy-server.js");

function postJson(url, secret, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mia-mcp-bridge-secret": secret
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test("bridge exposes manifest and routes tool calls with a secret", async () => {
  const calls = [];
  const manager = {
    toolManifest: () => [{ server: "xhs", name: "search_notes", description: "Search", inputSchema: { type: "object" } }],
    callTool: async (server, tool, args) => {
      calls.push([server, tool, args]);
      return { content: [{ type: "text", text: "ok" }], isError: false };
    }
  };
  const bridge = createMcpBridgeServer({ manager, secret: "secret-test" });
  const started = await bridge.start();
  try {
    const manifest = await postJson(started.manifestUrl, "secret-test", {});
    const result = await postJson(started.callbackUrl, "secret-test", { server: "xhs", tool: "search_notes", args: { q: "Mia" } });
    const unauthorized = await postJson(started.callbackUrl, "wrong", { server: "xhs", tool: "search_notes", args: {} });

    assert.equal(manifest.status, 200);
    assert.equal(manifest.json.tools[0].name, "search_notes");
    assert.equal(result.json.content[0].text, "ok");
    assert.deepEqual(calls, [["xhs", "search_notes", { q: "Mia" }]]);
    assert.equal(unauthorized.status, 401);
  } finally {
    await bridge.stop();
  }
});

test("bridge binds to loopback by default", async () => {
  const bridge = createMcpBridgeServer({
    manager: {
      toolManifest: () => [],
      callTool: async () => ({ content: [], isError: false })
    },
    secret: "secret-test"
  });

  const started = await bridge.start();
  try {
    assert.match(started.callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/execute$/);
    assert.match(started.manifestUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/manifest$/);
  } finally {
    await bridge.stop();
  }
});

test("bridge redacts secrets from failure logs", async () => {
  const logs = [];
  const bridge = createMcpBridgeServer({
    manager: {
      toolManifest: () => [],
      callTool: async () => {
        throw new Error("bridge secret secret-test and Bearer daemon-secret leaked");
      }
    },
    secret: "secret-test",
    appendLog: (line) => logs.push(String(line || ""))
  });

  const started = await bridge.start();
  try {
    const response = await postJson(started.callbackUrl, "secret-test", {
      server: "xhs",
      tool: "search_notes",
      args: { sessionToken: "daemon-secret" }
    });
    assert.equal(response.status, 500);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], /secret-test|daemon-secret/);
    assert.match(logs[0], /\[REDACTED\]/);
  } finally {
    await bridge.stop();
  }
});

test("stdio proxy manifest export uses injective encoded names", () => {
  const tools = [
    {
      server: "alpha/beta",
      name: "tool:name",
      description: "First",
      inputSchema: { type: "object", properties: { q: { type: "string" } } }
    },
    {
      server: "alpha_beta",
      name: "tool_name",
      description: "Second",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } }
    }
  ];

  const entries = buildProxyToolEntries(tools);

  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].proxyName, entries[1].proxyName);
  assert.equal(entries[0].proxyName, proxyToolName(tools[0]));
  assert.equal(entries[0].description, "[alpha/beta] First");
  assert.deepEqual(entries[1].inputSchema, tools[1].inputSchema);
});

test("stdio proxy call routing resolves the exact backend tool for colliding sanitized names", async () => {
  const tools = [
    { server: "alpha/beta", name: "tool:name", description: "First", inputSchema: { type: "object" } },
    { server: "alpha_beta", name: "tool_name", description: "Second", inputSchema: { type: "object" } }
  ];
  const calls = [];
  const handlers = createProxyHandlers({
    postJson: async (path, body) => {
      calls.push([path, body]);
      if (path === "/mcp/manifest") {
        return { tools };
      }
      if (path === "/mcp/execute") {
        return {
          content: [{ type: "text", text: "ok" }],
          isError: false
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    }
  });

  const listed = await handlers.listTools();
  const routed = await handlers.callTool({
    params: {
      name: listed.tools[1].name,
      arguments: { limit: 5, query: "Mia" }
    }
  });

  assert.equal(listed.tools[0].name, proxyToolName(tools[0]));
  assert.equal(listed.tools[1].name, proxyToolName(tools[1]));
  assert.deepEqual(calls, [
    ["/mcp/manifest", {}],
    ["/mcp/execute", { server: "alpha_beta", tool: "tool_name", args: { limit: 5, query: "Mia" } }]
  ]);
  assert.equal(routed.content[0].text, "ok");
});

test("stdio proxy call routing fills cache from manifest before execute", async () => {
  const tools = [
    { server: "alpha/beta", name: "tool:name", description: "First", inputSchema: { type: "object" } },
    { server: "alpha_beta", name: "tool_name", description: "Second", inputSchema: { type: "object" } }
  ];
  const calls = [];
  const handlers = createProxyHandlers({
    postJson: async (path, body) => {
      calls.push([path, body]);
      if (path === "/mcp/manifest") {
        return { tools };
      }
      if (path === "/mcp/execute") {
        return {
          content: [{ type: "text", text: "cached ok" }],
          isError: false
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    }
  });

  const routed = await handlers.callTool({
    params: {
      name: proxyToolName(tools[0]),
      arguments: { q: "cache-fill" }
    }
  });

  assert.deepEqual(calls, [
    ["/mcp/manifest", {}],
    ["/mcp/execute", { server: "alpha/beta", tool: "tool:name", args: { q: "cache-fill" } }]
  ]);
  assert.equal(routed.content[0].text, "cached ok");
});

test("stdio proxy fails closed on duplicate generated proxy names", () => {
  const duplicateEntries = [
    { proxyName: "mia__YWJj__ZGVm", server: "a", tool: "b" },
    { proxyName: "mia__YWJj__ZGVm", server: "c", tool: "d" }
  ];

  assert.throws(
    () => indexProxyToolEntries(duplicateEntries),
    /Duplicate Mia MCP proxy tool name generated/
  );
});
