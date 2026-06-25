const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  classifyMcpConnectionError,
  createCoreMcpConnectionTester
} = require("../src/core/mcp/connection-test.js");

function fakeLoadSdk(calls, overrides = {}) {
  class Client {
    async connect() {
      calls.push("connect");
    }

    async listTools() {
      calls.push("listTools");
      return {
        tools: [
          { name: "search", description: "Search", inputSchema: { type: "object" } }
        ]
      };
    }

    async close() {
      calls.push("client.close");
    }
  }

  class StdioClientTransport {
    constructor(options) {
      calls.push(["stdio", options]);
    }

    async close() {
      calls.push("transport.close");
    }
  }

  class SSEClientTransport {
    constructor(url, options) {
      calls.push(["sse", url.toString(), options]);
    }
  }

  class StreamableHTTPClientTransport {
    constructor(url, options) {
      calls.push(["http", url.toString(), options]);
    }
  }

  return async () => ({
    Client: overrides.Client || Client,
    StdioClientTransport,
    SSEClientTransport,
    StreamableHTTPClientTransport
  });
}

test("classifies command not found errors", () => {
  const result = classifyMcpConnectionError(
    Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }),
    { command: "npx", durationMs: 12 }
  );

  assert.equal(result.ok, false);
  assert.equal(result.success, false);
  assert.equal(result.code, "command_not_found");
  assert.equal(result.details.command, "npx");
});

test("classifies permission denied errors", () => {
  const result = classifyMcpConnectionError(
    Object.assign(new Error("spawn /bin/mcp EACCES"), { code: "EACCES" }),
    { command: "/bin/mcp", durationMs: 12 }
  );

  assert.equal(result.code, "permission_denied");
  assert.equal(result.details.command, "/bin/mcp");
});

test("classifies timeout errors", () => {
  const result = classifyMcpConnectionError(
    Object.assign(new Error("Timed out after 1000ms"), { code: "ETIMEDOUT" }),
    { durationMs: 1000 }
  );

  assert.equal(result.code, "timeout");
});

test("classifies 401 as auth_required with authenticate challenge", () => {
  const result = classifyMcpConnectionError(Object.assign(new Error("HTTP 401"), {
    status: 401,
    headers: { "www-authenticate": "Bearer resource_metadata=\"https://example.com/.well-known/oauth-protected-resource\"" }
  }), { url: "https://example.com/mcp", durationMs: 20 });

  assert.equal(result.status, "auth_required");
  assert.equal(result.code, "auth_required");
  assert.equal(result.auth.needsAuth, true);
  assert.equal(result.details.httpStatus, 401);
  assert.match(result.details.wwwAuthenticate, /resource_metadata/);
});

test("classifies HTTP protocol and generic connection errors", () => {
  assert.equal(classifyMcpConnectionError(Object.assign(new Error("HTTP 503"), { status: 503 })).code, "http_error");
  assert.equal(classifyMcpConnectionError(new Error("JSON-RPC initialize failed")).code, "protocol_error");
  assert.equal(classifyMcpConnectionError(new Error("socket hang up")).code, "connection_failed");
});

test("classifies message-only HTTP errors before command-not-found heuristics", () => {
  const result = classifyMcpConnectionError(new Error("HTTP 404 Not Found"), { durationMs: 7 });

  assert.equal(result.code, "http_error");
  assert.equal(result.details.httpStatus, 404);
});

test("auth diagnostics redact token-bearing server URLs", () => {
  const result = classifyMcpConnectionError(
    Object.assign(new Error("HTTP 401 Unauthorized"), { status: 401 }),
    { url: "https://example.com/mcp?access_token=abc123456789#refresh_token=shhh987654321", durationMs: 20 }
  );

  assert.equal(result.code, "auth_required");
  assert.doesNotMatch(result.auth.serverUrl, /abc123456789|shhh987654321/);
  assert.match(result.auth.serverUrl, /access_token=\[redacted\]/);
});

test("testConnection uses injected SDK transport and returns tools", async () => {
  const calls = [];
  const tester = createCoreMcpConnectionTester({
    loadSdk: fakeLoadSdk(calls),
    processEnvStrings: () => ({ PATH: "/usr/bin" }),
    timeoutMs: 1000
  });

  const result = await tester.testConnection({
    name: "pw",
    transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "connected");
  assert.equal(result.tools[0].name, "search");
  assert.equal(calls[0][0], "stdio");
  assert.equal(calls.filter((call) => call === "listTools").length, 1);
});

test("testConnection clears the timeout after the SDK operation completes", async () => {
  const calls = [];
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const handles = [];
  const clearedHandles = [];
  try {
    global.setTimeout = (callback, delay, ...args) => {
      const handle = originalSetTimeout(callback, delay, ...args);
      handles.push(handle);
      return handle;
    };
    global.clearTimeout = (handle) => {
      clearedHandles.push(handle);
      return originalClearTimeout(handle);
    };

    const tester = createCoreMcpConnectionTester({
      loadSdk: fakeLoadSdk(calls),
      processEnvStrings: () => ({ PATH: "/usr/bin" }),
      timeoutMs: 10000
    });

    const result = await tester.testConnection({
      name: "pw",
      transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] }
    });

    assert.equal(result.ok, true);
    assert.equal(clearedHandles.includes(handles[0]), true);
  } finally {
    for (const handle of handles) originalClearTimeout(handle);
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("testConnection resolves bearer token env var and OAuth headers", async () => {
  const calls = [];
  const tester = createCoreMcpConnectionTester({
    loadSdk: fakeLoadSdk(calls),
    processEnvStrings: () => ({ XHS_TOKEN: "env-secret" }),
    oauthService: {
      authorizationHeadersForServer: async () => ({ "X-OAuth": "present" })
    }
  });

  const result = await tester.testConnection({
    name: "remote",
    transport: {
      type: "http",
      url: "https://example.com/mcp",
      bearerTokenEnvVar: "XHS_TOKEN"
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0][2].requestInit.headers, {
    "X-OAuth": "present",
    Authorization: "Bearer env-secret"
  });
});

test("testConnection uses OAuth Authorization header when no env fallback exists", async () => {
  const calls = [];
  const tester = createCoreMcpConnectionTester({
    loadSdk: fakeLoadSdk(calls),
    processEnvStrings: () => ({}),
    oauthService: {
      authorizationHeadersForServer: async (record) => ({
        Authorization: `Bearer oauth-for-${record.transport.url}`
      })
    }
  });

  const result = await tester.testConnection({
    name: "remote",
    transport: {
      type: "http",
      url: "https://example.com/mcp"
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0][2].requestInit.headers, {
    Authorization: "Bearer oauth-for-https://example.com/mcp"
  });
});

test("testConnection keeps explicit Authorization before OAuth Authorization", async () => {
  const calls = [];
  const tester = createCoreMcpConnectionTester({
    loadSdk: fakeLoadSdk(calls),
    processEnvStrings: () => ({}),
    oauthService: {
      authorizationHeadersForServer: async () => ({
        Authorization: "Bearer oauth",
        "X-OAuth": "present"
      })
    }
  });

  const result = await tester.testConnection({
    name: "remote",
    transport: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer explicit" }
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0][2].requestInit.headers, {
    Authorization: "Bearer explicit",
    "X-OAuth": "present"
  });
});

test("SSE transports keep explicit headers and bearerTokenEnvVar fallback", async () => {
  const calls = [];
  const tester = createCoreMcpConnectionTester({
    loadSdk: fakeLoadSdk(calls),
    processEnvStrings: () => ({ SSE_TOKEN: "sse-secret" })
  });

  const result = await tester.testConnection({
    name: "events",
    transport: {
      type: "sse",
      url: "https://example.com/sse",
      headers: { "X-Client": "mia" },
      bearerTokenEnvVar: "SSE_TOKEN"
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["sse", "https://example.com/sse", {
    requestInit: {
      headers: {
        "X-Client": "mia",
        Authorization: "Bearer sse-secret"
      }
    }
  }]);
});

test("diagnostics redact secrets from error fields and details", () => {
  const result = classifyMcpConnectionError(
    Object.assign(new Error("Authorization: Bearer ghp_connection_secret API_TOKEN=abc123456789"), { status: 500 }),
    { durationMs: 5 }
  );

  assert.doesNotMatch(result.message, /ghp_connection_secret|abc123456789/);
  assert.doesNotMatch(result.error, /ghp_connection_secret|abc123456789/);
});
