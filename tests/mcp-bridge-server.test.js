const assert = require("node:assert/strict");
const { test } = require("node:test");
const http = require("node:http");
const { createMcpBridgeServer } = require("../src/main/mcp/mcp-bridge-server.js");

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
