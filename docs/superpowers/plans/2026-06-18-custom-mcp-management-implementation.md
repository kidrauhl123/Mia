# Custom MCP Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a product-grade custom MCP management center in Mia so one user-configured MCP server can be tested, managed, synced, and used by Hermes, Claude Code, Codex, and OpenClaw.

**Architecture:** Mia owns a runtime JSON registry for user MCP servers, exposes narrow IPC to the renderer, and keeps all native agent config writes in the main process. A main-process MCP SDK manager handles connection tests, tool discovery, and bridge calls; engine adapters consume normalized records through one shared conversion layer. The ability library becomes the product entry with `技能市场 / 我的技能 / MCP 服务`, and MCP services include `已安装 / 市场 / 自定义`.

**Tech Stack:** Electron main/preload/renderer CommonJS, native DOM modules, `node:test`, `js-yaml`, `@modelcontextprotocol/sdk`, `@agentclientprotocol/sdk`, Claude Agent SDK, Codex app-server config overrides.

## Global Constraints

- Keep user-visible renderer copy in Chinese.
- Renderer must not write native agent config files directly.
- Main-process IPC handlers must return serializable `{ success, data, error }` objects.
- Store user MCP records at `runtimePaths().mcpServers`, under `mia-mcp-servers.json`.
- Tests must inject temporary runtime paths and must not write `~/Library/Application Support/Mia`, `~/.codex`, or `~/.claude`.
- Supported transports are exactly `stdio`, `http`, `sse`, and `streamable_http`.
- All engines are in scope: Hermes, Claude Code, Codex, and OpenClaw.
- External CLI integration uses user-installed CLIs; do not bundle Claude Code, Codex, OpenClaw, or Hermes as MCP dependencies.
- Secrets in env values, headers, bearer tokens, daemon tokens, and bridge secrets must be masked in renderer state and logs.
- Preserve built-in `mia-app` and `mia-scheduler` MCP behavior.
- The current repo may contain unrelated dirty worktree changes. Execution should start in a clean worktree or add/commit only the files named by the active task.

---

## File Structure

Create:

- `src/shared/mcp-contracts.js`: shared transport names, status names, public record shape helpers, and IPC-safe validation constants.
- `src/main/mcp/mcp-records.js`: record normalization, masking, import parsing, fingerprinting, public list projection.
- `src/main/mcp/mcp-sdk-client.js`: official MCP SDK client manager for testing, tool discovery, refresh, and direct calls.
- `src/main/mcp/mcp-bridge-server.js`: local HTTP callback bridge bound to `127.0.0.1`.
- `src/main/mcp/mcp-stdio-proxy-server.js`: stdio MCP server used by engines that need a stdio bridge.
- `src/main/mcp/mcp-engine-sync.js`: engine-specific conversion and native CLI sync/remove command generation.
- `src/main/mcp/mcp-service.js`: main-process orchestrator for registry, SDK manager, bridge, marketplace, sync, and public status.
- `src/main/ipc/mcp-ipc.js`: MCP IPC handlers.
- `src/renderer/mcp/mcp-library.js`: MCP renderer feature module mounted inside the ability library.
- `src/renderer/styles/mcp.css`: MCP-specific ability-library styles.
- `tests/mcp-records.test.js`
- `tests/mcp-sdk-client.test.js`
- `tests/mcp-bridge-server.test.js`
- `tests/mcp-engine-sync.test.js`
- `tests/mcp-service.test.js`
- `tests/mcp-ipc-preload.test.js`
- `tests/renderer-mcp-library.test.js`

Modify:

- `package.json`: add direct dependency on `@modelcontextprotocol/sdk`.
- `package-lock.json`: updated by `npm install @modelcontextprotocol/sdk --save`.
- `src/main/runtime-paths.js`: add `mcpServers`.
- `src/shared/ipc-channels.js`: add MCP channel constants.
- `src/preload.js`: expose `window.mia.mcp`.
- `src/main.js`: instantiate MCP service, register IPC, pass MCP getters to runtime config and adapters.
- `src/main/engine-runtime-config-service.js`: merge user MCP specs into Hermes config.
- `src/main/claude-code-chat-adapter.js`: merge user MCP specs and include MCP fingerprint in persisted sessions.
- `src/main/codex-chat-adapter.js`: merge user MCP specs and use fingerprinted session entries.
- `src/main/codex-app-server-runner.js`: support URL/bearer MCP config overrides.
- `src/main/openclaw-chat-adapter.js`: pass normalized MCP servers to ACP `newSession` and fingerprint sessions.
- `src/renderer/app-state.js`: replace boolean skill market mode with a capability mode plus MCP state defaults.
- `src/renderer/skills/skill-library.js`: route `MCP 服务` mode to the MCP feature module.
- `src/renderer/index.html`: load `mcp.css` and `mcp-library.js`.
- `src/renderer/styles/skills.css`: adjust the three-item ability mode toggle.
- Existing tests for runtime paths, engine config, Claude, Codex, OpenClaw, and skill market UI.

---

### Task 1: Shared Contract And Registry Normalization

**Files:**
- Create: `src/shared/mcp-contracts.js`
- Create: `src/main/mcp/mcp-records.js`
- Test: `tests/mcp-records.test.js`
- Modify: `src/main/runtime-paths.js`
- Test: `tests/runtime-paths.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `MCP_TRANSPORTS`, `MCP_CONNECTION_STATUSES`, `MCP_ENGINE_IDS`, `MCP_SYNC_STATUSES`.
- Produces: `normalizeMcpRecord(input, options) -> record`.
- Produces: `normalizeMcpRegistry(value) -> record[]`.
- Produces: `parseMcpImportJson(input) -> Array<{ name, description, enabled, transport }>` .
- Produces: `maskMcpRecord(record) -> record`.
- Produces: `mcpFingerprint(records) -> string`.
- Produces: `enabledMcpRecords(records) -> record[]`.
- Consumed by: Tasks 2, 4, 5, 6, and 8.

- [ ] **Step 1: Add failing registry tests**

Add `tests/mcp-records.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  enabledMcpRecords,
  maskMcpRecord,
  mcpFingerprint,
  normalizeMcpRecord,
  normalizeMcpRegistry,
  parseMcpImportJson
} = require("../src/main/mcp/mcp-records.js");

test("normalizeMcpRecord stores stable MCP fields and defaults sync state", () => {
  const record = normalizeMcpRecord({
    name: " 小红书 ",
    description: "XHS",
    enabled: true,
    transport: {
      type: "http",
      url: " http://127.0.0.1:18060/mcp ",
      headers: { Authorization: "Bearer secret" },
      bearerTokenEnvVar: "XHS_TOKEN"
    }
  }, { now: () => 1710000000000, idFactory: () => "mcp_fixed" });

  assert.equal(record.id, "mcp_fixed");
  assert.equal(record.name, "小红书");
  assert.equal(record.transport.type, "http");
  assert.equal(record.transport.url, "http://127.0.0.1:18060/mcp");
  assert.equal(record.sync.codex.status, "pending");
  assert.equal(record.status, "unknown");
});

test("normalizeMcpRegistry keeps valid records and drops impossible records", () => {
  const records = normalizeMcpRegistry([
    { name: "stdio-one", transport: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { A: "1" } } },
    { name: "bad-http", transport: { type: "http", url: "" } },
    { name: "sse-one", enabled: false, transport: { type: "sse", url: "https://example.test/sse" } }
  ], { now: () => 1, idFactory: (name) => `mcp_${name}` });

  assert.deepEqual(records.map((record) => record.name), ["stdio-one", "sse-one"]);
  assert.equal(records[0].transport.command, "npx");
  assert.equal(records[1].enabled, false);
});

test("parseMcpImportJson accepts Claude Cursor Codex and generic mcpServers JSON", () => {
  const imported = parseMcpImportJson({
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], env: { TOKEN: "abc" } },
      xhs: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: { Authorization: "Bearer abc" } }
    }
  });

  assert.deepEqual(imported.map((item) => item.name), ["filesystem", "xhs"]);
  assert.equal(imported[0].transport.type, "stdio");
  assert.equal(imported[1].transport.type, "http");
});

test("maskMcpRecord hides secrets without destroying non-secret fields", () => {
  const record = normalizeMcpRecord({
    name: "github",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret", SAFE_FLAG: "1" }
    }
  }, { now: () => 1, idFactory: () => "mcp_github" });

  const masked = maskMcpRecord(record);
  assert.equal(masked.transport.env.GITHUB_PERSONAL_ACCESS_TOKEN, "••••••••");
  assert.equal(masked.transport.env.SAFE_FLAG, "1");
  assert.equal(masked.transport.command, "npx");
});

test("mcpFingerprint changes when enabled transport config changes", () => {
  const first = normalizeMcpRegistry([
    { name: "a", enabled: true, transport: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    { name: "b", enabled: false, transport: { type: "stdio", command: "npx", args: ["pkg"] } }
  ], { now: () => 1, idFactory: (name) => `mcp_${name}` });
  const second = normalizeMcpRegistry([
    { name: "a", enabled: true, transport: { type: "http", url: "http://127.0.0.1:2/mcp" } },
    { name: "b", enabled: false, transport: { type: "stdio", command: "npx", args: ["pkg"] } }
  ], { now: () => 1, idFactory: (name) => `mcp_${name}` });

  assert.notEqual(mcpFingerprint(first), mcpFingerprint(second));
  assert.deepEqual(enabledMcpRecords(first).map((record) => record.name), ["a"]);
});
```

Update `tests/runtime-paths.test.js` with an assertion:

```js
assert.equal(paths.mcpServers, path.join(expectedHome, "mia-mcp-servers.json"));
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/mcp-records.test.js tests/runtime-paths.test.js
```

Expected: `tests/mcp-records.test.js` fails because `src/main/mcp/mcp-records.js` does not exist, and `runtime-paths` assertion fails until `mcpServers` is added.

- [ ] **Step 3: Add shared constants and runtime path**

Add `src/shared/mcp-contracts.js`:

```js
(function attachMcpContracts(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaMcpContracts = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildMcpContracts() {
  const MCP_TRANSPORTS = Object.freeze(["stdio", "http", "sse", "streamable_http"]);
  const MCP_ENGINE_IDS = Object.freeze(["hermes", "claude-code", "codex", "openclaw"]);
  const MCP_CONNECTION_STATUSES = Object.freeze(["unknown", "connected", "disconnected", "unsupported", "auth_required"]);
  const MCP_SYNC_STATUSES = Object.freeze(["pending", "synced", "available", "unsupported", "error"]);
  const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|bearer|cookie|session)/i;

  return Object.freeze({
    MCP_TRANSPORTS,
    MCP_ENGINE_IDS,
    MCP_CONNECTION_STATUSES,
    MCP_SYNC_STATUSES,
    SENSITIVE_KEY_PATTERN
  });
});
```

Modify `src/main/runtime-paths.js` by adding this property near the other `mia-*.json` files:

```js
mcpServers: path.join(home, "mia-mcp-servers.json"),
```

- [ ] **Step 4: Add normalizer implementation**

Create `src/main/mcp/mcp-records.js` with these exported functions:

```js
const crypto = require("node:crypto");
const { MCP_ENGINE_IDS, MCP_TRANSPORTS, SENSITIVE_KEY_PATTERN } = require("../../shared/mcp-contracts.js");

function nowMs() {
  return Date.now();
}

function stableId(name = "") {
  const slug = String(name || "server").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `mcp_${slug || crypto.randomUUID()}`;
}

function cleanObject(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    const cleanKey = String(key || "").trim();
    if (!cleanKey) continue;
    if (value == null) continue;
    out[cleanKey] = String(value);
  }
  return out;
}

function defaultSync() {
  return MCP_ENGINE_IDS.reduce((sync, engine) => {
    sync[engine] = { status: "pending", message: "" };
    return sync;
  }, {});
}

function normalizeTransport(input = {}) {
  const type = String(input.type || (input.url ? "http" : "stdio")).trim().toLowerCase().replace(/-/g, "_");
  if (!MCP_TRANSPORTS.includes(type)) return null;
  if (type === "stdio") {
    const command = String(input.command || "").trim();
    if (!command) return null;
    return {
      type,
      command,
      args: Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [],
      env: cleanObject(input.env)
    };
  }
  const url = String(input.url || "").trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  const transport = {
    type,
    url,
    headers: cleanObject(input.headers)
  };
  const bearerTokenEnvVar = String(input.bearerTokenEnvVar || input.bearer_token_env_var || "").trim();
  if (bearerTokenEnvVar) transport.bearerTokenEnvVar = bearerTokenEnvVar;
  return transport;
}

function normalizeMcpRecord(input = {}, options = {}) {
  const now = typeof options.now === "function" ? options.now() : nowMs();
  const name = String(input.name || "").trim();
  const transport = normalizeTransport(input.transport || input);
  if (!name || !transport) return null;
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : stableId;
  return {
    id: String(input.id || idFactory(name)).trim(),
    name,
    description: String(input.description || "").trim(),
    enabled: input.enabled !== false,
    status: String(input.status || "unknown").trim() || "unknown",
    tools: Array.isArray(input.tools) ? input.tools.map((tool) => ({
      name: String(tool?.name || "").trim(),
      description: String(tool?.description || "").trim(),
      inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {}
    })).filter((tool) => tool.name) : [],
    transport,
    sync: { ...defaultSync(), ...(input.sync && typeof input.sync === "object" ? input.sync : {}) },
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : now,
    updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : now,
    lastCheckedAt: Number.isFinite(Number(input.lastCheckedAt)) ? Number(input.lastCheckedAt) : 0,
    lastError: String(input.lastError || ""),
    registryId: String(input.registryId || "").trim(),
    source: String(input.source || "custom").trim() || "custom",
    originalJson: String(input.originalJson || "")
  };
}

function normalizeMcpRegistry(value = [], options = {}) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const records = [];
  for (const item of rows) {
    const record = normalizeMcpRecord(item, options);
    if (!record || seen.has(record.name)) continue;
    seen.add(record.name);
    records.push(record);
  }
  return records;
}

function parseMcpImportJson(input) {
  const source = typeof input === "string" ? JSON.parse(input) : input;
  const servers = source?.mcpServers || source?.mcp_servers || source?.servers || {};
  return Object.entries(servers).map(([name, spec]) => ({
    name,
    description: String(spec?.description || ""),
    enabled: spec?.enabled !== false,
    transport: {
      type: spec?.type || spec?.transport || (spec?.url ? "http" : "stdio"),
      command: spec?.command,
      args: spec?.args,
      env: spec?.env,
      url: spec?.url,
      headers: spec?.headers,
      bearerTokenEnvVar: spec?.bearer_token_env_var || spec?.bearerTokenEnvVar
    }
  }));
}

function maskValue(key, value) {
  return SENSITIVE_KEY_PATTERN.test(String(key || "")) && String(value || "") ? "••••••••" : value;
}

function maskMcpRecord(record = {}) {
  const copy = JSON.parse(JSON.stringify(record || {}));
  if (copy.transport?.env) {
    for (const key of Object.keys(copy.transport.env)) copy.transport.env[key] = maskValue(key, copy.transport.env[key]);
  }
  if (copy.transport?.headers) {
    for (const key of Object.keys(copy.transport.headers)) copy.transport.headers[key] = maskValue(key, copy.transport.headers[key]);
  }
  return copy;
}

function enabledMcpRecords(records = []) {
  return normalizeMcpRegistry(records).filter((record) => record.enabled);
}

function fingerprintPayload(records = []) {
  return enabledMcpRecords(records).map((record) => ({
    name: record.name,
    transport: record.transport
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function mcpFingerprint(records = []) {
  return crypto.createHash("sha256").update(JSON.stringify(fingerprintPayload(records))).digest("hex");
}

module.exports = {
  enabledMcpRecords,
  maskMcpRecord,
  mcpFingerprint,
  normalizeMcpRecord,
  normalizeMcpRegistry,
  normalizeTransport,
  parseMcpImportJson
};
```

- [ ] **Step 5: Add direct SDK dependency**

Run:

```bash
npm install @modelcontextprotocol/sdk --save
```

Expected: `package.json` contains `@modelcontextprotocol/sdk` under `dependencies`, and `package-lock.json` updates.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/mcp-records.test.js tests/runtime-paths.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/shared/mcp-contracts.js src/main/runtime-paths.js src/main/mcp/mcp-records.js tests/mcp-records.test.js tests/runtime-paths.test.js
git commit -m "feat(mcp): 增加 MCP 配置规范化"
```

---

### Task 2: MCP SDK Manager

**Files:**
- Create: `src/main/mcp/mcp-sdk-client.js`
- Test: `tests/mcp-sdk-client.test.js`

**Interfaces:**
- Consumes: `normalizeMcpRecord`, `maskMcpRecord`.
- Produces: `createMcpSdkClientManager(deps)`.
- Produces manager methods:
  - `testServer(record) -> Promise<{ success, status, tools, error }>`
  - `refresh(records) -> Promise<{ success, tools, errors }>`
  - `callTool(serverName, toolName, args, options) -> Promise<{ content, isError }>`
  - `toolManifest() -> Array<{ server, name, description, inputSchema }>`
  - `stopAll() -> Promise<void>`

- [ ] **Step 1: Add failing SDK manager tests**

Add `tests/mcp-sdk-client.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { createMcpSdkClientManager } = require("../src/main/mcp/mcp-sdk-client.js");

function fakeLoadSdk(events) {
  class Client {
    constructor(info) {
      events.push(["client", info.name]);
    }
    async connect(transport) {
      events.push(["connect", transport.kind, transport.options]);
    }
    async listTools() {
      events.push(["listTools"]);
      return { tools: [{ name: "search_notes", description: "Search notes", inputSchema: { type: "object" } }] };
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
  return async () => ({ Client, StdioClientTransport, SSEClientTransport, StreamableHTTPClientTransport });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/mcp-sdk-client.test.js
```

Expected: FAIL because `src/main/mcp/mcp-sdk-client.js` does not exist.

- [ ] **Step 3: Implement SDK manager**

Create `src/main/mcp/mcp-sdk-client.js`:

```js
async function defaultLoadSdk() {
  const [{ Client }, { StdioClientTransport }, { SSEClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js")
  ]);
  return { Client, StdioClientTransport, SSEClientTransport, StreamableHTTPClientTransport };
}

function requestInitFor(record = {}) {
  const headers = record.transport?.headers || {};
  return Object.keys(headers).length ? { headers: { ...headers } } : undefined;
}

function toolManifestFor(serverName, tools = []) {
  return tools.map((tool) => ({
    server: serverName,
    name: String(tool?.name || "").trim(),
    description: String(tool?.description || ""),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {}
  })).filter((tool) => tool.name);
}

function createMcpSdkClientManager(deps = {}) {
  const loadSdk = deps.loadSdk || defaultLoadSdk;
  const processEnvStrings = deps.processEnvStrings || (() => process.env);
  const appendLog = deps.appendLog || (() => {});
  const clients = new Map();
  let manifest = [];

  async function transportFor(record) {
    const sdk = await loadSdk();
    const transport = record.transport || {};
    if (transport.type === "stdio") {
      return new sdk.StdioClientTransport({
        command: transport.command,
        args: transport.args || [],
        env: { ...processEnvStrings(), ...(transport.env || {}) }
      });
    }
    const url = new URL(transport.url);
    const init = requestInitFor(record);
    if (transport.type === "sse") {
      return new sdk.SSEClientTransport(url, init ? { requestInit: init } : undefined);
    }
    return new sdk.StreamableHTTPClientTransport(url, init ? { requestInit: init } : undefined);
  }

  async function startRecord(record) {
    const sdk = await loadSdk();
    const transport = await transportFor(record);
    const client = new sdk.Client({ name: "mia-mcp-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = toolManifestFor(record.name, listed.tools || []);
    clients.set(record.name, { record, client, transport, tools });
    return tools;
  }

  async function testServer(record) {
    let transport = null;
    let client = null;
    try {
      const sdk = await loadSdk();
      transport = await transportFor(record);
      client = new sdk.Client({ name: "mia-mcp-test", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);
      const listed = await client.listTools();
      return { success: true, status: "connected", tools: toolManifestFor(record.name, listed.tools || []), error: "" };
    } catch (error) {
      appendLog(`[MCP] test failed for ${record?.name || "server"}: ${error?.message || error}`);
      return { success: false, status: "disconnected", tools: [], error: String(error?.message || error) };
    } finally {
      try { await client?.close?.(); } catch { }
      try { await transport?.close?.(); } catch { }
    }
  }

  async function stopAll() {
    const entries = [...clients.values()];
    clients.clear();
    manifest = [];
    await Promise.allSettled(entries.map((entry) => entry.client.close()));
  }

  async function refresh(records = []) {
    await stopAll();
    const enabled = records.filter((record) => record.enabled !== false);
    const errors = [];
    const toolRows = [];
    for (const record of enabled) {
      try {
        toolRows.push(...await startRecord(record));
      } catch (error) {
        errors.push({ server: record.name, error: String(error?.message || error) });
      }
    }
    manifest = toolRows;
    return { success: errors.length === 0, tools: manifest, errors };
  }

  async function callTool(serverName, toolName, args = {}, options = {}) {
    const entry = clients.get(serverName);
    if (!entry) return { content: [{ type: "text", text: `MCP server "${serverName}" is not running` }], isError: true };
    if (options.signal?.aborted) return { content: [{ type: "text", text: "Tool execution aborted" }], isError: true };
    try {
      const result = await entry.client.callTool({ name: toolName, arguments: args || {} });
      return {
        content: Array.isArray(result.content) ? result.content : [{ type: "text", text: String(result.content || "") }],
        isError: result.isError === true
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Tool execution error: ${error?.message || error}` }], isError: true };
    }
  }

  function toolManifest() {
    return manifest.slice();
  }

  return { callTool, refresh, stopAll, testServer, toolManifest };
}

module.exports = { createMcpSdkClientManager, defaultLoadSdk, toolManifestFor };
```

- [ ] **Step 4: Run focused test**

Run:

```bash
node --test tests/mcp-sdk-client.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/mcp-sdk-client.js tests/mcp-sdk-client.test.js
git commit -m "feat(mcp): 增加 MCP SDK 管理器"
```

---

### Task 3: Local Bridge And Stdio Proxy

**Files:**
- Create: `src/main/mcp/mcp-bridge-server.js`
- Create: `src/main/mcp/mcp-stdio-proxy-server.js`
- Test: `tests/mcp-bridge-server.test.js`

**Interfaces:**
- Consumes: SDK manager `toolManifest()` and `callTool(serverName, toolName, args, options)`.
- Produces: `createMcpBridgeServer({ manager, secret, host })`.
- Produces bridge methods:
  - `start() -> Promise<{ port, callbackUrl, manifestUrl, secret }>`
  - `stop() -> Promise<void>`
  - `callbackUrl() -> string`
  - `manifestUrl() -> string`
- Produces stdio proxy env:
  - `MIA_MCP_BRIDGE_URL`
  - `MIA_MCP_BRIDGE_SECRET`

- [ ] **Step 1: Add failing bridge tests**

Add `tests/mcp-bridge-server.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/mcp-bridge-server.test.js
```

Expected: FAIL because `mcp-bridge-server.js` does not exist.

- [ ] **Step 3: Implement HTTP bridge**

Create `src/main/mcp/mcp-bridge-server.js`:

```js
const http = require("node:http");
const net = require("node:net");

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function freePort(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const address = srv.address();
      srv.close(() => resolve(address.port));
    });
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function createMcpBridgeServer({ manager, secret, host = "127.0.0.1", appendLog = () => {} } = {}) {
  if (!manager) throw new Error("manager dependency is required.");
  if (!secret) throw new Error("secret dependency is required.");
  let server = null;
  let port = 0;

  function baseUrl() {
    return port ? `http://${host}:${port}` : "";
  }

  function callbackUrl() {
    return baseUrl() ? `${baseUrl()}/mcp/execute` : "";
  }

  function manifestUrl() {
    return baseUrl() ? `${baseUrl()}/mcp/manifest` : "";
  }

  async function handle(req, res) {
    if (req.method !== "POST") {
      writeJson(res, 404, { error: "Not found" });
      return;
    }
    if (req.headers["x-mia-mcp-bridge-secret"] !== secret) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    if (req.url === "/mcp/manifest") {
      writeJson(res, 200, { tools: manager.toolManifest() });
      return;
    }
    if (req.url === "/mcp/execute") {
      const body = JSON.parse(await readBody(req) || "{}");
      const result = await manager.callTool(String(body.server || ""), String(body.tool || ""), body.args || {});
      writeJson(res, 200, result);
      return;
    }
    writeJson(res, 404, { error: "Not found" });
  }

  async function start() {
    if (server) return { port, callbackUrl: callbackUrl(), manifestUrl: manifestUrl(), secret };
    port = await freePort(host);
    server = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        appendLog(`[MCP] bridge request failed: ${error?.message || error}`);
        writeJson(res, 500, { error: "Internal server error" });
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    return { port, callbackUrl: callbackUrl(), manifestUrl: manifestUrl(), secret };
  }

  async function stop() {
    if (!server) return;
    const closing = server;
    server = null;
    port = 0;
    await new Promise((resolve) => closing.close(resolve));
  }

  return { callbackUrl, manifestUrl, start, stop };
}

module.exports = { createMcpBridgeServer };
```

- [ ] **Step 4: Add stdio proxy script**

Create `src/main/mcp/mcp-stdio-proxy-server.js` with a standard MCP server process that fetches bridge manifest and calls bridge execute. Use the SDK server modules through dynamic imports so the script can run under the packaged app's Node-compatible runtime:

```js
#!/usr/bin/env node
"use strict";

const bridgeUrl = String(process.env.MIA_MCP_BRIDGE_URL || "").replace(/\/+$/, "");
const secret = String(process.env.MIA_MCP_BRIDGE_SECRET || "");

async function postJson(path, body) {
  const response = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mia-mcp-bridge-secret": secret
    },
    body: JSON.stringify(body || {})
  });
  if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
  return response.json();
}

function proxyToolName(tool) {
  return `${String(tool.server || "").replace(/[^a-zA-Z0-9_-]/g, "_")}__${String(tool.name || "").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function main() {
  if (!bridgeUrl || !secret) throw new Error("MIA_MCP_BRIDGE_URL and MIA_MCP_BRIDGE_SECRET are required.");
  const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js")
  ]);
  const server = new Server({ name: "mia-mcp-bridge", version: "1.0.0" }, { capabilities: { tools: {} } });
  let cachedTools = [];

  server.setRequestHandler(types.ListToolsRequestSchema, async () => {
    const manifest = await postJson("/mcp/manifest", {});
    cachedTools = Array.isArray(manifest.tools) ? manifest.tools : [];
    return {
      tools: cachedTools.map((tool) => ({
        name: proxyToolName(tool),
        description: `[${tool.server}] ${tool.description || tool.name}`,
        inputSchema: tool.inputSchema || { type: "object" }
      }))
    };
  });

  server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
    if (!cachedTools.length) {
      const manifest = await postJson("/mcp/manifest", {});
      cachedTools = Array.isArray(manifest.tools) ? manifest.tools : [];
    }
    const tool = cachedTools.find((entry) => proxyToolName(entry) === request.params.name);
    if (!tool) return { content: [{ type: "text", text: `Unknown Mia MCP bridge tool: ${request.params.name}` }], isError: true };
    return postJson("/mcp/execute", { server: tool.server, tool: tool.name, args: request.params.arguments || {} });
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`mia-mcp-stdio-proxy fatal: ${error?.message || error}\n`);
  process.exit(1);
});
```

- [ ] **Step 5: Run focused tests and syntax check**

Run:

```bash
node --test tests/mcp-bridge-server.test.js
node -c src/main/mcp/mcp-stdio-proxy-server.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/mcp-bridge-server.js src/main/mcp/mcp-stdio-proxy-server.js tests/mcp-bridge-server.test.js
git commit -m "feat(mcp): 增加本地 MCP bridge"
```

---

### Task 4: Engine Conversion And Native Sync Planning

**Files:**
- Create: `src/main/mcp/mcp-engine-sync.js`
- Test: `tests/mcp-engine-sync.test.js`
- Modify: `src/main/codex-app-server-runner.js`
- Test: `tests/codex-app-server-runner.test.js`

**Interfaces:**
- Consumes: normalized MCP records from Task 1.
- Produces: `mcpSpecsForClaudeSdk(records, options) -> object`.
- Produces: `mcpSpecsForCodex(records, options) -> object`.
- Produces: `mcpSpecsForHermes(records, options) -> object`.
- Produces: `mcpServersForOpenClawAcp(records, options) -> array`.
- Produces: `planClaudeCliSync(records) -> command specs`.
- Produces: `planCodexCliSync(records) -> command specs`.
- Produces: `bridgeMcpSpec({ command, scriptPath, bridgeUrl, secret }) -> stdio spec`.

- [ ] **Step 1: Add failing conversion tests**

Add `tests/mcp-engine-sync.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  bridgeMcpSpec,
  mcpServersForOpenClawAcp,
  mcpSpecsForClaudeSdk,
  mcpSpecsForCodex,
  mcpSpecsForHermes,
  planClaudeCliSync,
  planCodexCliSync
} = require("../src/main/mcp/mcp-engine-sync.js");

const records = [
  { name: "stdio", enabled: true, transport: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "abc" } } },
  { name: "xhs", enabled: true, transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {}, bearerTokenEnvVar: "XHS_TOKEN" } },
  { name: "header-http", enabled: true, transport: { type: "http", url: "http://127.0.0.1:1999/mcp", headers: { Authorization: "Bearer abc" } } }
];

test("mcpSpecsForClaudeSdk preserves stdio and URL transports", () => {
  assert.deepEqual(mcpSpecsForClaudeSdk(records).xhs, {
    type: "http",
    url: "http://127.0.0.1:18060/mcp",
    headers: {}
  });
  assert.equal(mcpSpecsForClaudeSdk(records).stdio.command, "npx");
});

test("mcpSpecsForCodex uses native URL for bearer-token HTTP and bridge for arbitrary headers", () => {
  const bridge = bridgeMcpSpec({ command: "/usr/local/bin/node", scriptPath: "/app/mcp-stdio-proxy-server.js", bridgeUrl: "http://127.0.0.1:3333", secret: "sec" });
  const specs = mcpSpecsForCodex(records, { bridge });

  assert.equal(specs.xhs.url, "http://127.0.0.1:18060/mcp");
  assert.equal(specs.xhs.bearer_token_env_var, "XHS_TOKEN");
  assert.equal(specs["mia-mcp-bridge"].command, "/usr/local/bin/node");
});

test("mcpSpecsForHermes emits direct URL when supported and bridge when URL support is disabled", () => {
  const bridge = bridgeMcpSpec({ command: "/node", scriptPath: "/proxy.js", bridgeUrl: "http://127.0.0.1:1", secret: "sec" });

  assert.equal(mcpSpecsForHermes(records, { hermesSupportsUrl: true, bridge }).xhs.url, "http://127.0.0.1:18060/mcp");
  assert.deepEqual(Object.keys(mcpSpecsForHermes(records, { hermesSupportsUrl: false, bridge })), ["stdio", "mia-mcp-bridge"]);
});

test("mcpServersForOpenClawAcp maps records into ACP wire shape", () => {
  const acp = mcpServersForOpenClawAcp(records, { supportsHttp: true, supportsSse: true, bridge: null });
  assert.deepEqual(acp[0], { name: "stdio", command: "npx", args: ["-y", "pkg"], env: [{ name: "TOKEN", value: "abc" }] });
  assert.deepEqual(acp[1], { type: "http", name: "xhs", url: "http://127.0.0.1:18060/mcp", headers: [] });
});

test("native CLI planners generate safe command argument arrays", () => {
  assert.deepEqual(planCodexCliSync([records[1]])[0].args, ["mcp", "add", "xhs", "--url", "http://127.0.0.1:18060/mcp", "--bearer-token-env-var", "XHS_TOKEN"]);
  assert.equal(planClaudeCliSync([records[0]])[0].args[0], "mcp");
});
```

Update `tests/codex-app-server-runner.test.js` with:

```js
test("codexConfigOverridesForMcpServers supports URL MCP servers", () => {
  const overrides = codexConfigOverridesForMcpServers({
    xhs: { url: "http://127.0.0.1:18060/mcp", bearer_token_env_var: "XHS_TOKEN" }
  });

  assert.deepEqual(overrides, [
    'mcp_servers.xhs.url="http://127.0.0.1:18060/mcp"',
    'mcp_servers.xhs.bearer_token_env_var="XHS_TOKEN"'
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/mcp-engine-sync.test.js tests/codex-app-server-runner.test.js
```

Expected: `mcp-engine-sync` module missing and Codex URL override assertion failing.

- [ ] **Step 3: Implement conversion module**

Create `src/main/mcp/mcp-engine-sync.js`:

```js
function envArray(env = {}) {
  return Object.entries(env || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function headerArray(headers = {}) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function enabled(records = []) {
  return records.filter((record) => record?.enabled !== false);
}

function bridgeMcpSpec({ command, scriptPath, bridgeUrl, secret }) {
  return {
    type: "stdio",
    command,
    args: [scriptPath],
    env: {
      MIA_MCP_BRIDGE_URL: bridgeUrl,
      MIA_MCP_BRIDGE_SECRET: secret
    },
    alwaysLoad: true
  };
}

function toNativeSpec(record) {
  const transport = record.transport || {};
  if (transport.type === "stdio") return {
    type: "stdio",
    command: transport.command,
    args: transport.args || [],
    env: transport.env || {}
  };
  return {
    type: transport.type === "streamable_http" ? "http" : transport.type,
    url: transport.url,
    headers: transport.headers || {},
    ...(transport.bearerTokenEnvVar ? { bearer_token_env_var: transport.bearerTokenEnvVar } : {})
  };
}

function mcpSpecsForClaudeSdk(records = {}) {
  return Object.fromEntries(enabled(records).map((record) => [record.name, toNativeSpec(record)]));
}

function needsBridgeForCodex(record) {
  const transport = record.transport || {};
  if (transport.type === "sse") return true;
  if ((transport.type === "http" || transport.type === "streamable_http") && Object.keys(transport.headers || {}).length > 0 && !transport.bearerTokenEnvVar) return true;
  return false;
}

function mcpSpecsForCodex(records = [], { bridge = null } = {}) {
  const specs = {};
  let needsBridge = false;
  for (const record of enabled(records)) {
    if (needsBridgeForCodex(record)) {
      needsBridge = true;
      continue;
    }
    specs[record.name] = toNativeSpec(record);
  }
  if (needsBridge && bridge) specs["mia-mcp-bridge"] = bridge;
  return specs;
}

function mcpSpecsForHermes(records = [], { hermesSupportsUrl = false, bridge = null } = {}) {
  const specs = {};
  let needsBridge = false;
  for (const record of enabled(records)) {
    const transport = record.transport || {};
    if (transport.type === "stdio") {
      specs[record.name] = toNativeSpec(record);
    } else if (hermesSupportsUrl) {
      specs[record.name] = toNativeSpec(record);
    } else {
      needsBridge = true;
    }
  }
  if (needsBridge && bridge) specs["mia-mcp-bridge"] = bridge;
  return specs;
}

function mcpServersForOpenClawAcp(records = [], { supportsHttp = false, supportsSse = false, bridge = null } = {}) {
  const servers = [];
  let needsBridge = false;
  for (const record of enabled(records)) {
    const transport = record.transport || {};
    if (transport.type === "stdio") {
      servers.push({ name: record.name, command: transport.command, args: transport.args || [], env: envArray(transport.env) });
    } else if ((transport.type === "http" || transport.type === "streamable_http") && supportsHttp) {
      servers.push({ type: "http", name: record.name, url: transport.url, headers: headerArray(transport.headers) });
    } else if (transport.type === "sse" && supportsSse) {
      servers.push({ type: "sse", name: record.name, url: transport.url, headers: headerArray(transport.headers) });
    } else {
      needsBridge = true;
    }
  }
  if (needsBridge && bridge) servers.push({ name: "mia-mcp-bridge", command: bridge.command, args: bridge.args || [], env: envArray(bridge.env) });
  return servers;
}

function planCodexCliSync(records = []) {
  return enabled(records).map((record) => {
    const transport = record.transport || {};
    if (transport.type === "stdio") {
      const args = ["mcp", "add", record.name];
      for (const [key, value] of Object.entries(transport.env || {})) args.push("--env", `${key}=${value}`);
      args.push("--", transport.command, ...(transport.args || []));
      return { engine: "codex", name: record.name, args };
    }
    const args = ["mcp", "add", record.name, "--url", transport.url];
    if (transport.bearerTokenEnvVar) args.push("--bearer-token-env-var", transport.bearerTokenEnvVar);
    return { engine: "codex", name: record.name, args };
  });
}

function planClaudeCliSync(records = []) {
  return enabled(records).map((record) => {
    const transport = record.transport || {};
    if (transport.type === "stdio") {
      return { engine: "claude-code", name: record.name, args: ["mcp", "add-json", "-s", "user", record.name, JSON.stringify(toNativeSpec(record))] };
    }
    const args = ["mcp", "add", "-s", "user", "--transport", transport.type === "streamable_http" ? "http" : transport.type, record.name, transport.url];
    for (const [key, value] of Object.entries(transport.headers || {})) args.push("--header", `${key}: ${value}`);
    return { engine: "claude-code", name: record.name, args };
  });
}

module.exports = {
  bridgeMcpSpec,
  mcpServersForOpenClawAcp,
  mcpSpecsForClaudeSdk,
  mcpSpecsForCodex,
  mcpSpecsForHermes,
  planClaudeCliSync,
  planCodexCliSync,
  toNativeSpec
};
```

- [ ] **Step 4: Extend Codex app-server overrides**

Modify `codexConfigOverridesForMcpServers` in `src/main/codex-app-server-runner.js` so URL specs work:

```js
function codexConfigOverridesForMcpServers(mcpServers = {}) {
  const overrides = [];
  for (const [name, spec] of Object.entries(mcpServers || {})) {
    const serverName = String(name || "").trim();
    if (!serverName) continue;
    const prefix = `mcp_servers.${serverName}`;
    const url = String(spec?.url || "").trim();
    const command = String(spec?.command || "").trim();
    if (url) {
      overrides.push(`${prefix}.url=${tomlString(url)}`);
      const bearer = String(spec.bearer_token_env_var || spec.bearerTokenEnvVar || "").trim();
      if (bearer) overrides.push(`${prefix}.bearer_token_env_var=${tomlString(bearer)}`);
      continue;
    }
    if (!command) continue;
    overrides.push(`${prefix}.command=${tomlString(command)}`);
    overrides.push(`${prefix}.args=${tomlArray(spec.args || [])}`);
    for (const [key, value] of Object.entries(spec.env || {})) {
      overrides.push(`${prefix}.env.${key}=${tomlString(value)}`);
    }
  }
  return overrides;
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test tests/mcp-engine-sync.test.js tests/codex-app-server-runner.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/mcp-engine-sync.js src/main/codex-app-server-runner.js tests/mcp-engine-sync.test.js tests/codex-app-server-runner.test.js
git commit -m "feat(mcp): 增加引擎 MCP 转换规则"
```

---

### Task 5: Main MCP Service And IPC

**Files:**
- Create: `src/main/mcp/mcp-service.js`
- Create: `src/main/ipc/mcp-ipc.js`
- Test: `tests/mcp-service.test.js`
- Test: `tests/mcp-ipc-preload.test.js`
- Modify: `src/shared/ipc-channels.js`
- Modify: `src/preload.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: records, SDK manager, bridge server, engine sync converters.
- Produces: `createMcpService(deps)`.
- Produces service methods:
  - `list()`
  - `save(input)`
  - `delete(id)`
  - `test(idOrInput)`
  - `importJson(input)`
  - `fetchMarketplace()`
  - `installTemplate(templateId, values)`
  - `sync()`
  - `refreshBridge()`
  - `enabledRecords()`
  - `fingerprint()`
  - `getBridgeSpec()`
  - `getEngineSpecs(engineId)`

- [ ] **Step 1: Add failing service and IPC tests**

Add `tests/mcp-service.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createMcpService } = require("../src/main/mcp/mcp-service.js");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-mcp-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    home: path.join(dir, "home"),
    runtime: path.join(dir, "runtime"),
    mcpServers: path.join(dir, "home", "mia-mcp-servers.json")
  };
  const manager = {
    testServer: async (record) => ({ success: true, status: "connected", tools: [{ server: record.name, name: "search_notes", description: "", inputSchema: {} }], error: "" }),
    refresh: async () => ({ success: true, tools: [], errors: [] }),
    toolManifest: () => [],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false })
  };
  const bridge = {
    start: async () => ({ callbackUrl: "http://127.0.0.1:3333/mcp/execute", manifestUrl: "http://127.0.0.1:3333/mcp/manifest", secret: "sec", port: 3333 }),
    stop: async () => {}
  };
  const service = createMcpService({
    runtimePaths: () => runtime,
    fs,
    manager,
    bridge,
    nodePath: () => "/usr/local/bin/node",
    stdioProxyScriptPath: () => path.join(runtime.runtime, "mcp-stdio-proxy-server.js"),
    now: () => 1710000000000,
    idFactory: () => "mcp_xhs"
  });
  return { runtime, service };
}

test("save list test and delete persist MCP records", async (t) => {
  const { runtime, service } = setup(t);

  const saved = await service.save({ name: "xhs", transport: { type: "http", url: "http://127.0.0.1:18060/mcp" } });
  const tested = await service.test(saved.data.id);
  const listed = await service.list();
  const deleted = await service.delete(saved.data.id);

  assert.equal(saved.success, true);
  assert.equal(tested.data.status, "connected");
  assert.equal(listed.data.servers[0].tools[0].name, "search_notes");
  assert.equal(deleted.success, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8")), []);
});

test("importJson saves imported servers as disabled until tested", async (t) => {
  const { service } = setup(t);
  const imported = await service.importJson({ mcpServers: { xhs: { type: "http", url: "http://127.0.0.1:18060/mcp" } } });

  assert.equal(imported.success, true);
  assert.equal(imported.data.servers[0].enabled, false);
});
```

Add `tests/mcp-ipc-preload.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("MCP IPC channels and preload bridge are wired", () => {
  const channels = read("src/shared/ipc-channels.js");
  assert.match(channels, /McpList:\s*"mcp:list"/);
  assert.match(channels, /McpSave:\s*"mcp:save"/);
  assert.match(channels, /McpRefreshBridge:\s*"mcp:refresh-bridge"/);

  const preload = read("src/preload.js");
  assert.match(preload, /mcp:\s*\{/);
  assert.match(preload, /list:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpList\)/);
  assert.match(preload, /refreshBridge:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpRefreshBridge\)/);

  const ipc = read("src/main/ipc/mcp-ipc.js");
  assert.match(ipc, /registerMcpIpc/);
  assert.match(ipc, /IpcChannel\.McpList/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/mcp-service.test.js tests/mcp-ipc-preload.test.js
```

Expected: FAIL because service, IPC module, channels, and preload bridge are missing.

- [ ] **Step 3: Add IPC channels and preload bridge**

In `src/shared/ipc-channels.js`, add constants:

```js
McpList: "mcp:list",
McpSave: "mcp:save",
McpDelete: "mcp:delete",
McpTest: "mcp:test",
McpImportJson: "mcp:import-json",
McpFetchMarketplace: "mcp:fetch-marketplace",
McpInstallTemplate: "mcp:install-template",
McpSync: "mcp:sync",
McpRefreshBridge: "mcp:refresh-bridge",
McpRemoveFromAgents: "mcp:remove-from-agents",
```

In `src/preload.js`, add:

```js
mcp: {
  list: () => ipcRenderer.invoke(IpcChannel.McpList),
  save: (input) => ipcRenderer.invoke(IpcChannel.McpSave, input),
  delete: (id) => ipcRenderer.invoke(IpcChannel.McpDelete, id),
  test: (input) => ipcRenderer.invoke(IpcChannel.McpTest, input),
  importJson: (input) => ipcRenderer.invoke(IpcChannel.McpImportJson, input),
  fetchMarketplace: () => ipcRenderer.invoke(IpcChannel.McpFetchMarketplace),
  installTemplate: (templateId, values) => ipcRenderer.invoke(IpcChannel.McpInstallTemplate, templateId, values),
  sync: () => ipcRenderer.invoke(IpcChannel.McpSync),
  refreshBridge: () => ipcRenderer.invoke(IpcChannel.McpRefreshBridge),
  removeFromAgents: () => ipcRenderer.invoke(IpcChannel.McpRemoveFromAgents)
},
```

- [ ] **Step 4: Implement main service**

Create `src/main/mcp/mcp-service.js` with registry read/write, bridge spec, and IPC-safe wrappers. The implementation must write only `runtimePaths().mcpServers`, use `0o600`, and return masked records from public methods:

```js
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { bridgeMcpSpec, mcpSpecsForClaudeSdk, mcpSpecsForCodex, mcpSpecsForHermes, mcpServersForOpenClawAcp } = require("./mcp-engine-sync.js");
const { maskMcpRecord, mcpFingerprint, normalizeMcpRecord, normalizeMcpRegistry, parseMcpImportJson } = require("./mcp-records.js");

function readJson(fsImpl, filePath, fallback) {
  try { return JSON.parse(fsImpl.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function atomicWriteJson(fsImpl, filePath, value) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fsImpl.renameSync(tmp, filePath);
}

function ok(data) {
  return { success: true, data, error: "" };
}

function fail(error) {
  return { success: false, data: null, error: String(error?.message || error) };
}

function createMcpService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const fsImpl = deps.fs || fs;
  const manager = deps.manager;
  const bridge = deps.bridge;
  const now = deps.now || (() => Date.now());
  const idFactory = deps.idFactory || (() => `mcp_${crypto.randomUUID()}`);
  const nodePath = deps.nodePath || (() => "");
  const stdioProxyScriptPath = deps.stdioProxyScriptPath || (() => path.join(__dirname, "mcp-stdio-proxy-server.js"));
  let bridgeInfo = null;

  function recordsPath() {
    return runtimePaths().mcpServers;
  }

  function loadRecords() {
    return normalizeMcpRegistry(readJson(fsImpl, recordsPath(), []), { now, idFactory });
  }

  function saveRecords(records) {
    const normalized = normalizeMcpRegistry(records, { now, idFactory });
    atomicWriteJson(fsImpl, recordsPath(), normalized);
    return normalized;
  }

  function publicServers(records = loadRecords()) {
    return records.map(maskMcpRecord);
  }

  async function list() {
    try { return ok({ servers: publicServers(loadRecords()), fingerprint: fingerprint() }); } catch (error) { return fail(error); }
  }

  async function save(input = {}) {
    try {
      const current = loadRecords();
      const record = normalizeMcpRecord(input, { now, idFactory });
      if (!record) throw new Error("MCP 服务配置无效。");
      const next = current.filter((item) => item.id !== record.id && item.name !== record.name);
      next.push({ ...record, updatedAt: now() });
      const saved = saveRecords(next);
      return ok(maskMcpRecord(saved.find((item) => item.id === record.id) || record));
    } catch (error) { return fail(error); }
  }

  async function deleteServer(id) {
    try {
      const next = loadRecords().filter((record) => record.id !== id);
      saveRecords(next);
      await refreshBridge();
      return ok({ servers: publicServers(next) });
    } catch (error) { return fail(error); }
  }

  async function testServer(idOrInput) {
    try {
      const records = loadRecords();
      const record = typeof idOrInput === "string"
        ? records.find((item) => item.id === idOrInput || item.name === idOrInput)
        : normalizeMcpRecord(idOrInput, { now, idFactory });
      if (!record) throw new Error("没有找到 MCP 服务。");
      const result = await manager.testServer(record);
      const next = records.map((item) => item.id === record.id ? {
        ...item,
        status: result.status,
        tools: result.tools,
        lastCheckedAt: now(),
        lastError: result.error || "",
        enabled: result.success ? item.enabled : false
      } : item);
      saveRecords(next);
      return ok(maskMcpRecord(next.find((item) => item.id === record.id) || record));
    } catch (error) { return fail(error); }
  }

  async function importJson(input) {
    try {
      const imported = parseMcpImportJson(input).map((item) => normalizeMcpRecord({ ...item, enabled: false }, { now, idFactory })).filter(Boolean);
      const existing = loadRecords();
      const names = new Set(imported.map((item) => item.name));
      const next = existing.filter((item) => !names.has(item.name)).concat(imported);
      saveRecords(next);
      return ok({ servers: publicServers(next), imported: imported.length });
    } catch (error) { return fail(error); }
  }

  async function fetchMarketplace() {
    return ok({ templates: [
      { id: "xhs-local-http", name: "小红书 MCP", description: "连接本机运行的小红书 MCP HTTP 服务。", category: "内容平台", transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {} }, requiredEnvKeys: [] }
    ] });
  }

  async function installTemplate(templateId) {
    const market = await fetchMarketplace();
    const template = market.data.templates.find((item) => item.id === templateId);
    if (!template) return fail(new Error("没有找到 MCP 模板。"));
    return save({ name: template.name, description: template.description, registryId: template.id, source: "marketplace", transport: template.transport });
  }

  async function refreshBridge() {
    const records = loadRecords().filter((record) => record.enabled);
    const refreshed = await manager.refresh(records);
    if (bridge) bridgeInfo = await bridge.start();
    return ok({ tools: refreshed.tools || [], errors: refreshed.errors || [] });
  }

  function getBridgeSpec() {
    if (!bridgeInfo?.manifestUrl && bridge?.start) return null;
    if (!bridgeInfo) return null;
    const command = nodePath();
    if (!command) return null;
    return bridgeMcpSpec({ command, scriptPath: stdioProxyScriptPath(), bridgeUrl: bridgeInfo.manifestUrl.replace(/\/mcp\/manifest$/, ""), secret: bridgeInfo.secret });
  }

  function enabledRecords() {
    return loadRecords().filter((record) => record.enabled);
  }

  function fingerprint() {
    return mcpFingerprint(loadRecords());
  }

  function getEngineSpecs(engineId, options = {}) {
    const records = enabledRecords();
    const bridgeSpec = getBridgeSpec();
    if (engineId === "claude-code") return mcpSpecsForClaudeSdk(records, { bridge: bridgeSpec, ...options });
    if (engineId === "codex") return mcpSpecsForCodex(records, { bridge: bridgeSpec, ...options });
    if (engineId === "hermes") return mcpSpecsForHermes(records, { bridge: bridgeSpec, ...options });
    if (engineId === "openclaw") return mcpServersForOpenClawAcp(records, { bridge: bridgeSpec, ...options });
    return {};
  }

  async function sync() {
    await refreshBridge();
    return ok({ fingerprint: fingerprint(), servers: publicServers(loadRecords()) });
  }

  return {
    delete: deleteServer,
    enabledRecords,
    fetchMarketplace,
    fingerprint,
    getBridgeSpec,
    getEngineSpecs,
    importJson,
    list,
    refreshBridge,
    save,
    sync,
    test: testServer,
    installTemplate
  };
}

module.exports = { createMcpService };
```

- [ ] **Step 5: Add IPC registration**

Create `src/main/ipc/mcp-ipc.js`:

```js
const { IpcChannel } = require("../../shared/ipc-channels.js");

function registerMcpIpc({ ipcMain, mcpService }) {
  ipcMain.handle(IpcChannel.McpList, () => mcpService.list());
  ipcMain.handle(IpcChannel.McpSave, (_event, input) => mcpService.save(input || {}));
  ipcMain.handle(IpcChannel.McpDelete, (_event, id) => mcpService.delete(String(id || "")));
  ipcMain.handle(IpcChannel.McpTest, (_event, input) => mcpService.test(input));
  ipcMain.handle(IpcChannel.McpImportJson, (_event, input) => mcpService.importJson(input));
  ipcMain.handle(IpcChannel.McpFetchMarketplace, () => mcpService.fetchMarketplace());
  ipcMain.handle(IpcChannel.McpInstallTemplate, (_event, templateId, values) => mcpService.installTemplate(String(templateId || ""), values || {}));
  ipcMain.handle(IpcChannel.McpSync, () => mcpService.sync());
  ipcMain.handle(IpcChannel.McpRefreshBridge, () => mcpService.refreshBridge());
  ipcMain.handle(IpcChannel.McpRemoveFromAgents, () => mcpService.sync());
}

module.exports = { registerMcpIpc };
```

Modify `src/main.js`:

```js
const { registerMcpIpc } = require("./main/ipc/mcp-ipc.js");
const { createMcpService } = require("./main/mcp/mcp-service.js");
const { createMcpSdkClientManager } = require("./main/mcp/mcp-sdk-client.js");
const { createMcpBridgeServer } = require("./main/mcp/mcp-bridge-server.js");
```

Instantiate after `miaAppMcpBridge`:

```js
const userMcpManager = createMcpSdkClientManager({ processEnvStrings, appendLog: appendEngineLog });
const userMcpBridge = createMcpBridgeServer({
  manager: userMcpManager,
  secret: crypto.randomUUID(),
  appendLog: appendEngineLog
});
const userMcpService = createMcpService({
  runtimePaths,
  manager: userMcpManager,
  bridge: userMcpBridge,
  nodePath: () => localAgentEngineService.shellCommandPath("node"),
  stdioProxyScriptPath: () => path.join(__dirname, "main", "mcp", "mcp-stdio-proxy-server.js")
});
```

Register IPC near other focused IPC modules:

```js
registerMcpIpc({ ipcMain, mcpService: userMcpService });
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/mcp-service.test.js tests/mcp-ipc-preload.test.js
node -c src/main/ipc/mcp-ipc.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc-channels.js src/preload.js src/main.js src/main/ipc/mcp-ipc.js src/main/mcp/mcp-service.js tests/mcp-service.test.js tests/mcp-ipc-preload.test.js
git commit -m "feat(mcp): 增加 MCP 主进程服务和 IPC"
```

---

### Task 6: Engine Injection And Session Fingerprints

**Files:**
- Modify: `src/main/engine-runtime-config-service.js`
- Modify: `src/main/claude-code-chat-adapter.js`
- Modify: `src/main/codex-chat-adapter.js`
- Modify: `src/main/openclaw-chat-adapter.js`
- Modify: `src/main.js`
- Test: `tests/engine-runtime-config-service.test.js`
- Test: `tests/claude-code-chat-adapter.test.js`
- Test: `tests/codex-chat-adapter.test.js`
- Test: `tests/openclaw-chat-adapter.test.js`

**Interfaces:**
- Consumes: `userMcpService.getEngineSpecs(engineId, options)`.
- Consumes: `userMcpService.fingerprint()`.
- Produces: all adapters combine built-in and user MCP specs.
- Produces: Claude, Codex, and OpenClaw persisted sessions are reused only when MCP fingerprint is unchanged.

- [ ] **Step 1: Add failing engine tests**

Add or extend focused tests with these assertions:

`tests/engine-runtime-config-service.test.js`:

```js
test("writeRuntimeConfig merges user MCP specs into Hermes config", (t) => {
  const { runtime, service } = setup(t, {
    getUserMcpSpecs: () => ({
      xhs: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {} }
    })
  });

  service.writeRuntimeConfig(19191);

  const parsed = yaml.load(fs.readFileSync(path.join(runtime.home, "config.yaml"), "utf8"));
  assert.deepEqual(parsed.mcp_servers.xhs, {
    url: "http://127.0.0.1:18060/mcp",
    headers: {}
  });
});
```

`tests/openclaw-chat-adapter.test.js`:

```js
test("ACP newSession receives user MCP servers and records fingerprinted session", async () => {
  const deps = createDeps({
    getUserMcpServers: () => [{ name: "xhs", command: "node", args: ["/proxy.js"], env: [{ name: "A", value: "1" }] }],
    getMcpFingerprint: () => "mcp_fp"
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "bot", name: "Bot", engineConfig: {} },
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }]
  });

  const newSession = deps.calls.find((call) => call[0] === "acp-new-session")[1];
  assert.deepEqual(newSession.mcpServers, [{ name: "xhs", command: "node", args: ["/proxy.js"], env: [{ name: "A", value: "1" }] }]);
  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), ["set-session", "openclaw", "bot", "s1", "openclaw:mia:bot:s1:mcp_fp"]);
});
```

Extend Claude and Codex tests to assert user MCP merge and fingerprint behavior:

```js
assert.equal(queryCall.options.mcpServers.xhs.url, "http://127.0.0.1:18060/mcp");
assert.match(queryCall.options.mcpServers["mia-scheduler"].command, /node/);
```

```js
assert.equal(appServerCall.mcpServers.xhs.url, "http://127.0.0.1:18060/mcp");
assert.equal(setEntryCall[5], "mcp_fp");
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/engine-runtime-config-service.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js
```

Expected: FAIL on missing `getUserMcpSpecs`, empty OpenClaw `mcpServers`, and missing Codex/OpenClaw fingerprinting.

- [ ] **Step 3: Inject user MCP into Hermes config**

In `src/main/engine-runtime-config-service.js`, add dependency:

```js
const getUserMcpSpecs = typeof deps.getUserMcpSpecs === "function" ? deps.getUserMcpSpecs : () => ({});
```

Before dumping `mcpServers`, merge user specs:

```js
Object.assign(mcpServers, getUserMcpSpecs());
```

In `src/main.js`, pass:

```js
getUserMcpSpecs: () => userMcpService.getEngineSpecs("hermes", { hermesSupportsUrl: true })
```

- [ ] **Step 4: Inject user MCP into Claude Code**

In `src/main/claude-code-chat-adapter.js`, add deps:

```js
const getUserMcpSpecs = deps.getUserMcpSpecs || (() => ({}));
const getMcpFingerprint = deps.getMcpFingerprint || (() => "");
```

Combine the session fingerprint:

```js
const mcpFingerprint = getMcpFingerprint();
const sessionFingerprint = [bridgeFingerprint, mcpFingerprint].filter(Boolean).join(":");
const externalSessionId = savedEntry.id && savedEntry.fingerprint === sessionFingerprint
  ? savedEntry.id
  : "";
```

Merge MCP servers:

```js
const userMcpServers = getUserMcpSpecs();
const mcpServers = {
  ...(miaAppMcpSpec ? { "mia-app": miaAppMcpSpec } : {}),
  ...(schedulerMcpSpec ? { "mia-scheduler": schedulerMcpSpec } : {}),
  ...userMcpServers
};
```

When saving captured session id, pass `sessionFingerprint` instead of `bridgeFingerprint`.

In `src/main.js`, pass:

```js
getUserMcpSpecs: () => userMcpService.getEngineSpecs("claude-code"),
getMcpFingerprint: userMcpService.fingerprint,
```

- [ ] **Step 5: Inject user MCP into Codex with fingerprinted sessions**

In `src/main/codex-chat-adapter.js`, replace `getAgentSessionId` and `setAgentSessionId` deps with optional entry-capable deps while keeping old fallbacks:

```js
const getAgentSessionEntry = deps.getAgentSessionEntry || ((engine, botId, localSessionId) => ({ id: getAgentSessionId(engine, botId, localSessionId), fingerprint: "" }));
const setAgentSessionEntry = deps.setAgentSessionEntry || ((engine, botId, localSessionId, externalId) => setAgentSessionId(engine, botId, localSessionId, externalId));
const getUserMcpSpecs = deps.getUserMcpSpecs || (() => ({}));
const getMcpFingerprint = deps.getMcpFingerprint || (() => "");
```

Use:

```js
const mcpFingerprint = getMcpFingerprint();
const savedEntry = shouldPersistAgentSession ? getAgentSessionEntry(engine, bot.key, sessionId) : { id: "", fingerprint: "" };
const externalSessionId = savedEntry.id && savedEntry.fingerprint === mcpFingerprint ? savedEntry.id : "";
```

Merge:

```js
const mcpServers = {
  ...(miaAppMcpSpec ? { "mia-app": miaAppMcpSpec } : {}),
  ...(schedulerMcpSpec ? { "mia-scheduler": schedulerMcpSpec } : {}),
  ...getUserMcpSpecs()
};
```

When saving, call:

```js
if (capturedSessionId && shouldPersistAgentSession) setAgentSessionEntry(engine, bot.key, sessionId, capturedSessionId, mcpFingerprint);
```

In `src/main.js`, pass:

```js
getAgentSessionEntry: agentSessionStore.getEntry,
setAgentSessionEntry: agentSessionStore.setEntry,
getUserMcpSpecs: () => userMcpService.getEngineSpecs("codex"),
getMcpFingerprint: userMcpService.fingerprint,
```

- [ ] **Step 6: Inject user MCP into OpenClaw ACP**

In `src/main/openclaw-chat-adapter.js`, add deps:

```js
const getUserMcpServers = deps.getUserMcpServers || (() => []);
const getMcpFingerprint = deps.getMcpFingerprint || (() => "");
```

Before `client.newSession`, compute:

```js
const userMcpServers = getUserMcpServers({
  supportsHttp: true,
  supportsSse: true
});
const mcpFingerprint = getMcpFingerprint();
```

Change `newSession`:

```js
mcpServers: userMcpServers,
```

Use fingerprint in session key:

```js
const sessionKey = ["openclaw", "mia", bot.key, sessionId, mcpFingerprint].filter(Boolean).join(":");
```

In `src/main.js`, pass:

```js
getUserMcpServers: (options) => userMcpService.getEngineSpecs("openclaw", options),
getMcpFingerprint: userMcpService.fingerprint,
```

- [ ] **Step 7: Run engine tests**

Run:

```bash
node --test tests/engine-runtime-config-service.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main.js src/main/engine-runtime-config-service.js src/main/claude-code-chat-adapter.js src/main/codex-chat-adapter.js src/main/openclaw-chat-adapter.js tests/engine-runtime-config-service.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js
git commit -m "feat(mcp): 接入用户 MCP 到本地引擎"
```

---

### Task 7: Ability Library MCP UI

**Files:**
- Create: `src/renderer/mcp/mcp-library.js`
- Create: `src/renderer/styles/mcp.css`
- Test: `tests/renderer-mcp-library.test.js`
- Modify: `src/renderer/app-state.js`
- Modify: `src/renderer/skills/skill-library.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles/skills.css`
- Test: `tests/skill-market-ui.test.js`

**Interfaces:**
- Consumes: `window.mia.mcp`.
- Produces: `window.miaMcpLibrary.initMcpLibrary({ state, els, escapeHtml, setText })`.
- Produces: `window.miaMcpLibrary.loadMcpServers()`.
- Produces: `window.miaMcpLibrary.renderMcpLibrary()`.
- Consumes state:
  - `state.skillCapabilityMode`: `"market" | "mine" | "mcp"`.
  - `state.mcp.activeTab`: `"installed" | "marketplace" | "custom"`.
  - `state.mcp.servers`, `state.mcp.templates`, `state.mcp.loading`, `state.mcp.error`, `state.mcp.syncing`.

- [ ] **Step 1: Add failing renderer tests**

Add `tests/renderer-mcp-library.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("ability library exposes MCP service mode and loads MCP renderer script", () => {
  const appState = read("src/renderer/app-state.js");
  const skillLibrary = read("src/renderer/skills/skill-library.js");
  const html = read("src/renderer/index.html");

  assert.match(appState, /skillCapabilityMode:\s*"market"/);
  assert.match(appState, /mcp:\s*\{/);
  assert.match(skillLibrary, /data-skill-mode="mcp"/);
  assert.match(skillLibrary, /window\.miaMcpLibrary\.renderMcpLibrary/);
  assert.match(html, /styles\/mcp\.css/);
  assert.match(html, /mcp\/mcp-library\.js/);
});

test("mcp-library renders installed, marketplace, and custom tabs", async () => {
  const src = read("src/renderer/mcp/mcp-library.js");
  const fakeEl = () => ({
    innerHTML: "",
    textContent: "",
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {}
  });
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{ id: "mcp_xhs", name: "小红书 MCP", enabled: true, status: "connected", transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }, tools: [{ name: "search_notes" }], sync: {} }],
      templates: [{ id: "xhs-local-http", name: "小红书 MCP", description: "本地 HTTP", transport: { type: "http" } }],
      loading: false,
      error: ""
    }
  };
  const els = { skillPageTitle: fakeEl(), skillChipRow: fakeEl(), skillCardGrid: fakeEl() };
  const context = {
    console,
    window: { mia: { mcp: { list: async () => ({ success: true, data: { servers: state.mcp.servers } }) } } }
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: "mcp-library.js" });
  context.window.miaMcpLibrary.initMcpLibrary({
    state,
    els,
    escapeHtml: (value) => String(value || "").replace(/&/g, "&amp;"),
    setText: (node, value) => { node.textContent = value; }
  });
  context.window.miaMcpLibrary.renderMcpLibrary();

  assert.match(els.skillCardGrid.innerHTML, /小红书 MCP/);
  assert.match(els.skillChipRow.innerHTML, /已安装/);
  assert.match(els.skillChipRow.innerHTML, /市场/);
  assert.match(els.skillChipRow.innerHTML, /自定义/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/renderer-mcp-library.test.js tests/skill-market-ui.test.js
```

Expected: FAIL on missing MCP mode and missing renderer module.

- [ ] **Step 3: Add renderer state defaults**

Modify `src/renderer/app-state.js`:

```js
skillCapabilityMode: "market",
skillMarketMode: true,
mcp: {
  activeTab: "installed",
  servers: [],
  templates: [],
  loading: false,
  syncing: false,
  error: "",
  selectedId: "",
  formOpen: false,
  formMode: "create",
  formDraft: null,
  importOpen: false,
  importText: ""
},
```

Keep `skillMarketMode` during this task for backward compatibility with existing tests, and update it from `skillCapabilityMode`.

- [ ] **Step 4: Update ability mode toggle**

In `src/renderer/skills/skill-library.js`, change mode rendering to three modes:

```js
function currentSkillMode() {
  if (state.skillCapabilityMode) return state.skillCapabilityMode;
  return state.skillMarketMode ? "market" : "mine";
}

function renderModeToggle() {
  if (!els.skillModeToggle) return;
  const mode = currentSkillMode();
  els.skillModeToggle.innerHTML = `
    <button class="${mode === "market" ? "active" : ""}" type="button" role="tab" data-skill-mode="market">技能市场</button>
    <button class="${mode === "mine" ? "active" : ""}" type="button" role="tab" data-skill-mode="mine">我的技能</button>
    <button class="${mode === "mcp" ? "active" : ""}" type="button" role="tab" data-skill-mode="mcp">MCP 服务</button>
  `;
  els.skillModeToggle.querySelectorAll("[data-skill-mode]").forEach((button) => {
    button.addEventListener("click", () => switchSkillMode(button.dataset.skillMode));
  });
  syncModeToggleIndicator(els.skillModeToggle);
}
```

Change switching:

```js
function switchSkillMode(nextMode) {
  const mode = nextMode === "mcp" ? "mcp" : nextMode === "mine" ? "mine" : "market";
  if (currentSkillMode() === mode) return;
  pageTurnDirection = mode === "market" ? 1 : -1;
  window.miaMasonryGrid?.capture(els.skillCardGrid, pageTurnDirection);
  state.skillCapabilityMode = mode;
  state.skillMarketMode = mode === "market";
  state.skillCategoryFilter = "";
  closeSkillContextMenu();
  renderSkillLibrary();
  if (mode === "market" && !state.skillMarket.loaded && !state.skillMarket.loading) loadMarketSkills();
  if (mode === "mcp") window.miaMcpLibrary?.loadMcpServers?.();
}
```

In `renderSkillLibrary`, route mode:

```js
if (currentSkillMode() === "mcp") window.miaMcpLibrary?.renderMcpLibrary?.();
else if (currentSkillMode() === "market") renderMarketView();
else renderLocalView();
```

- [ ] **Step 5: Create MCP renderer module**

Create `src/renderer/mcp/mcp-library.js`:

```js
(function () {
  "use strict";

  let state, els, escapeHtml, setText;

  function initMcpLibrary(deps) {
    state = deps.state;
    els = deps.els;
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
  }

  function mcpState() {
    if (!state.mcp) state.mcp = { activeTab: "installed", servers: [], templates: [], loading: false, error: "" };
    return state.mcp;
  }

  async function loadMcpServers() {
    const mcp = mcpState();
    if (!window.mia?.mcp?.list) return;
    mcp.loading = true;
    mcp.error = "";
    renderMcpLibrary();
    try {
      const [listResult, marketResult] = await Promise.all([
        window.mia.mcp.list(),
        window.mia.mcp.fetchMarketplace ? window.mia.mcp.fetchMarketplace() : Promise.resolve({ success: true, data: { templates: [] } })
      ]);
      if (listResult?.success) mcp.servers = Array.isArray(listResult.data?.servers) ? listResult.data.servers : [];
      if (marketResult?.success) mcp.templates = Array.isArray(marketResult.data?.templates) ? marketResult.data.templates : [];
    } catch (error) {
      mcp.error = error?.message || "MCP 服务加载失败";
    } finally {
      mcp.loading = false;
      renderMcpLibrary();
    }
  }

  function setMcpTab(tab) {
    const mcp = mcpState();
    mcp.activeTab = tab;
    renderMcpLibrary();
  }

  function renderMcpTabs() {
    const mcp = mcpState();
    const tabs = [
      ["installed", "已安装", mcp.servers.length],
      ["marketplace", "市场", mcp.templates.length],
      ["custom", "自定义", ""]
    ];
    els.skillChipRow.innerHTML = tabs.map(([id, label, count]) => `
      <button class="${mcp.activeTab === id ? "active" : ""}" type="button" data-mcp-tab="${id}">
        ${escapeHtml(label)}${count !== "" ? ` <span>${count}</span>` : ""}
      </button>
    `).join("");
    els.skillChipRow.querySelectorAll("[data-mcp-tab]").forEach((button) => {
      button.addEventListener("click", () => setMcpTab(button.dataset.mcpTab));
    });
  }

  function transportSummary(transport = {}) {
    if (transport.type === "stdio") return [transport.command, ...(transport.args || [])].filter(Boolean).join(" ");
    return transport.url || "";
  }

  function renderServerCard(server) {
    const status = server.status === "connected" ? "已连接" : server.status === "auth_required" ? "需要认证" : server.status === "unsupported" ? "不支持" : "未连接";
    return `
      <article class="skill-card mcp-card" data-mcp-id="${escapeHtml(server.id)}">
        <div class="skill-card-head">
          <strong>${escapeHtml(server.name)}</strong>
          <p>${escapeHtml(server.description || transportSummary(server.transport))}</p>
        </div>
        <span class="skill-card-source">
          <span class="mcp-transport">${escapeHtml(server.transport?.type || "")}</span>
          <span>${escapeHtml(status)}</span>
          <span>${Number(server.tools?.length || 0)} 个工具</span>
        </span>
      </article>
    `;
  }

  function renderTemplateCard(template) {
    return `
      <article class="skill-card mcp-card" data-mcp-template="${escapeHtml(template.id)}">
        <div class="skill-card-head">
          <strong>${escapeHtml(template.name)}</strong>
          <p>${escapeHtml(template.description || "")}</p>
        </div>
        <span class="skill-card-source">
          <span class="mcp-transport">${escapeHtml(template.transport?.type || "")}</span>
          <span>${escapeHtml(template.category || "模板")}</span>
        </span>
      </article>
    `;
  }

  function renderCustomEntry() {
    return `
      <article class="skill-card mcp-card mcp-custom-action" data-mcp-action="create">
        <div class="skill-card-head">
          <strong>添加自定义 MCP</strong>
          <p>填写命令、URL、headers 或导入 mcpServers JSON。</p>
        </div>
        <span class="skill-card-source">自定义 · stdio / http / sse / streamable_http</span>
      </article>
      <article class="skill-card mcp-card mcp-custom-action" data-mcp-action="import">
        <div class="skill-card-head">
          <strong>导入 JSON</strong>
          <p>支持 Cursor、Claude、Codex 和通用 mcpServers 格式。</p>
        </div>
        <span class="skill-card-source">批量导入</span>
      </article>
    `;
  }

  function renderMcpLibrary() {
    if (!state || !els) return;
    const mcp = mcpState();
    setText(els.skillPageTitle, "MCP 服务");
    renderMcpTabs();
    if (mcp.loading) {
      els.skillCardGrid.innerHTML = `<div class="skill-empty-state">正在加载 MCP 服务...</div>`;
      return;
    }
    if (mcp.error) {
      els.skillCardGrid.innerHTML = `<div class="skill-empty-state">${escapeHtml(mcp.error)}</div>`;
      return;
    }
    if (mcp.activeTab === "marketplace") {
      els.skillCardGrid.innerHTML = mcp.templates.length ? mcp.templates.map(renderTemplateCard).join("") : `<div class="skill-empty-state">暂无 MCP 模板</div>`;
    } else if (mcp.activeTab === "custom") {
      els.skillCardGrid.innerHTML = renderCustomEntry();
    } else {
      els.skillCardGrid.innerHTML = mcp.servers.length ? mcp.servers.map(renderServerCard).join("") : `<div class="skill-empty-state">还没有添加 MCP 服务</div>`;
    }
    window.miaMasonryGrid?.layout?.(els.skillCardGrid, ".skill-card");
  }

  window.miaMcpLibrary = {
    initMcpLibrary,
    loadMcpServers,
    renderMcpLibrary,
    setMcpTab
  };
})();
```

This task deliberately renders the full entry surface and list states. The modal CRUD form is completed in Task 8 so tests stay focused.

- [ ] **Step 6: Load CSS and JS**

Modify `src/renderer/index.html`:

```html
<link rel="stylesheet" href="./styles/mcp.css">
```

Before `skills/skill-library.js` or after helpers:

```html
<script src="./mcp/mcp-library.js"></script>
```

Initialize in `src/renderer/app.js` near `initSkillLibrary`:

```js
if (window.miaMcpLibrary && window.miaMcpLibrary.initMcpLibrary) {
  window.miaMcpLibrary.initMcpLibrary({
    state,
    els,
    escapeHtml: window.miaMarkdown.escapeHtml,
    setText
  });
}
```

- [ ] **Step 7: Add MCP CSS**

Create `src/renderer/styles/mcp.css`:

```css
.mcp-card .mcp-transport {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent, #318ad3) 10%, transparent);
  color: var(--text);
  font-size: 11px;
  font-weight: 650;
}

.mcp-custom-action {
  border-style: dashed;
}
```

- [ ] **Step 8: Run renderer tests**

Run:

```bash
node --test tests/renderer-mcp-library.test.js tests/skill-market-ui.test.js
node -c src/renderer/mcp/mcp-library.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/app-state.js src/renderer/skills/skill-library.js src/renderer/mcp/mcp-library.js src/renderer/styles/mcp.css src/renderer/index.html src/renderer/styles/skills.css tests/renderer-mcp-library.test.js tests/skill-market-ui.test.js
git commit -m "feat(mcp): 在能力库增加 MCP 服务入口"
```

---

### Task 8: MCP CRUD Form, Import, Test, Sync, And Permissions Copy

**Files:**
- Modify: `src/renderer/mcp/mcp-library.js`
- Modify: `src/renderer/styles/mcp.css`
- Modify: `src/main/agent-permission-coordinator.js`
- Test: `tests/renderer-mcp-library.test.js`
- Test: `tests/agent-permission-coordinator.test.js`

**Interfaces:**
- Consumes: `window.mia.mcp.save`, `delete`, `test`, `importJson`, `sync`, `installTemplate`.
- Produces: modal form for `stdio`, `http`, `sse`, `streamable_http`.
- Produces: JSON import modal.
- Produces: sync/test/delete actions on installed cards.
- Produces: permission prompt text that displays `server.tool` for user-added MCP tools.

- [ ] **Step 1: Add failing UI behavior tests**

Extend `tests/renderer-mcp-library.test.js` with source assertions:

```js
test("mcp-library contains form, import, test, sync, and delete actions", () => {
  const src = read("src/renderer/mcp/mcp-library.js");
  assert.match(src, /function openMcpForm/);
  assert.match(src, /function submitMcpForm/);
  assert.match(src, /function importMcpJson/);
  assert.match(src, /window\.mia\.mcp\.test/);
  assert.match(src, /window\.mia\.mcp\.sync/);
  assert.match(src, /window\.mia\.mcp\.delete/);
  assert.match(src, /data-mcp-action="test"/);
  assert.match(src, /data-mcp-action="sync"/);
  assert.match(src, /data-mcp-action="delete"/);
});
```

Add or extend permission coordinator tests with:

```js
assert.match(formatPermissionTitle({ engine: "codex", toolName: "xhs.search_notes" }), /xhs\.search_notes/);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/renderer-mcp-library.test.js tests/agent-permission-coordinator.test.js
```

Expected: FAIL because modal form/actions and MCP-specific permission title are not present.

- [ ] **Step 3: Add installed-card actions**

Update `renderServerCard(server)` to include icon/text actions:

```js
<div class="mcp-card-actions">
  <button type="button" data-mcp-action="test" data-mcp-id="${escapeHtml(server.id)}">测试</button>
  <button type="button" data-mcp-action="sync" data-mcp-id="${escapeHtml(server.id)}">同步</button>
  <button type="button" data-mcp-action="edit" data-mcp-id="${escapeHtml(server.id)}">编辑</button>
  <button type="button" data-mcp-action="delete" data-mcp-id="${escapeHtml(server.id)}">删除</button>
</div>
```

Add event binding after rendering:

```js
els.skillCardGrid.querySelectorAll("[data-mcp-action]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    handleMcpAction(button.dataset.mcpAction, button.dataset.mcpId || button.dataset.mcpTemplate || "");
  });
});
```

Add handlers:

```js
async function handleMcpAction(action, id) {
  if (action === "create") return openMcpForm(null);
  if (action === "import") return openImportForm();
  if (action === "edit") return openMcpForm(mcpState().servers.find((server) => server.id === id));
  if (action === "test") return testMcpServer(id);
  if (action === "sync") return syncMcpServers();
  if (action === "delete") return deleteMcpServer(id);
  if (action === "install") return installTemplate(id);
}
```

- [ ] **Step 4: Add form and import modals**

Use a single inline overlay appended to `document.body` from `mcp-library.js`. The form fields must use deterministic `name` attributes:

```js
function openMcpForm(server) {
  const isEdit = !!server;
  const transport = server?.transport || { type: "stdio", command: "", args: [], env: {} };
  const overlay = document.createElement("section");
  overlay.className = "mcp-dialog";
  overlay.innerHTML = `
    <div class="mcp-dialog-backdrop" data-mcp-close></div>
    <form class="mcp-dialog-panel" data-mcp-form>
      <header class="mcp-dialog-head">
        <h2>${isEdit ? "编辑 MCP 服务" : "添加 MCP 服务"}</h2>
        <button type="button" data-mcp-close aria-label="关闭">×</button>
      </header>
      <label>名称<input name="name" value="${escapeHtml(server?.name || "")}" required></label>
      <label>描述<input name="description" value="${escapeHtml(server?.description || "")}"></label>
      <label>传输类型
        <select name="type">
          ${["stdio", "http", "sse", "streamable_http"].map((type) => `<option value="${type}" ${transport.type === type ? "selected" : ""}>${type}</option>`).join("")}
        </select>
      </label>
      <label data-mcp-stdio>命令<input name="command" value="${escapeHtml(transport.command || "")}"></label>
      <label data-mcp-stdio>参数<textarea name="args">${escapeHtml((transport.args || []).join("\\n"))}</textarea></label>
      <label data-mcp-stdio>环境变量<textarea name="env">${escapeHtml(Object.entries(transport.env || {}).map(([key, value]) => `${key}=${value}`).join("\\n"))}</textarea></label>
      <label data-mcp-url>URL<input name="url" value="${escapeHtml(transport.url || "")}"></label>
      <label data-mcp-url>Headers<textarea name="headers">${escapeHtml(Object.entries(transport.headers || {}).map(([key, value]) => `${key}: ${value}`).join("\\n"))}</textarea></label>
      <label data-mcp-url>Bearer Token 环境变量<input name="bearerTokenEnvVar" value="${escapeHtml(transport.bearerTokenEnvVar || transport.bearer_token_env_var || "")}"></label>
      <footer class="mcp-dialog-actions">
        <button type="button" data-mcp-close>取消</button>
        <button type="submit">${isEdit ? "保存" : "添加"}</button>
      </footer>
    </form>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("[data-mcp-form]").addEventListener("submit", (event) => submitMcpForm(event, server?.id || "", overlay));
  overlay.querySelectorAll("[data-mcp-close]").forEach((button) => button.addEventListener("click", () => overlay.remove()));
}
```

Add parser helpers:

```js
function parseKeyValueLines(text, separatorPattern) {
  const out = {};
  String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const match = line.match(separatorPattern);
    if (match) out[match[1].trim()] = match[2].trim();
  });
  return out;
}

async function submitMcpForm(event, id, overlay) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const type = String(data.get("type") || "stdio");
  const transport = type === "stdio"
    ? {
        type,
        command: String(data.get("command") || "").trim(),
        args: String(data.get("args") || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        env: parseKeyValueLines(data.get("env"), /^([^=]+)=(.*)$/)
      }
    : {
        type,
        url: String(data.get("url") || "").trim(),
        headers: parseKeyValueLines(data.get("headers"), /^([^:]+):(.*)$/),
        bearerTokenEnvVar: String(data.get("bearerTokenEnvVar") || "").trim()
      };
  const result = await window.mia.mcp.save({ id, name: data.get("name"), description: data.get("description"), enabled: true, transport });
  if (!result?.success) window.alert(`保存失败：${result?.error || "未知错误"}`);
  overlay.remove();
  await loadMcpServers();
}
```

- [ ] **Step 5: Add test, sync, delete, import, and marketplace install handlers**

Add:

```js
async function testMcpServer(id) {
  const result = await window.mia.mcp.test(id);
  if (!result?.success) window.alert(`测试失败：${result?.error || "未知错误"}`);
  await loadMcpServers();
}

async function syncMcpServers() {
  const result = await window.mia.mcp.sync();
  if (!result?.success) window.alert(`同步失败：${result?.error || "未知错误"}`);
  await loadMcpServers();
}

async function deleteMcpServer(id) {
  if (!window.confirm("删除这个 MCP 服务？")) return;
  const result = await window.mia.mcp.delete(id);
  if (!result?.success) window.alert(`删除失败：${result?.error || "未知错误"}`);
  await loadMcpServers();
}

async function installTemplate(id) {
  const result = await window.mia.mcp.installTemplate(id, {});
  if (!result?.success) window.alert(`安装失败：${result?.error || "未知错误"}`);
  await loadMcpServers();
}

function openImportForm() {
  const text = window.prompt("粘贴 mcpServers JSON：", "{\n  \"mcpServers\": {}\n}");
  if (text === null) return;
  importMcpJson(text);
}

async function importMcpJson(text) {
  const result = await window.mia.mcp.importJson(text);
  if (!result?.success) window.alert(`导入失败：${result?.error || "未知错误"}`);
  await loadMcpServers();
}
```

- [ ] **Step 6: Add form CSS**

Append to `src/renderer/styles/mcp.css`:

```css
.mcp-card-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.mcp-card-actions button,
.mcp-dialog-actions button {
  min-height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: var(--floating-control-bg);
  color: var(--text);
}

.mcp-dialog {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
}

.mcp-dialog-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(17, 24, 39, 0.32);
}

.mcp-dialog-panel {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 12px;
  width: min(620px, calc(100vw - 28px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 18px;
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--menu-shadow);
}

.mcp-dialog-head,
.mcp-dialog-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.mcp-dialog-panel label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 13px;
}

.mcp-dialog-panel input,
.mcp-dialog-panel textarea,
.mcp-dialog-panel select {
  width: 100%;
  min-height: 34px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--background);
  color: var(--text);
}

.mcp-dialog-panel textarea {
  min-height: 82px;
  resize: vertical;
}
```

- [ ] **Step 7: Improve MCP permission copy**

In `src/main/agent-permission-coordinator.js`, add or adjust a pure formatter export if one does not exist:

```js
function formatMcpPermissionTitle({ engine = "", toolName = "" } = {}) {
  const tool = String(toolName || "MCP 工具").trim();
  const engineLabel = engine === "codex" ? "Codex" : engine === "claude-code" ? "Claude Code" : engine === "openclaw" ? "OpenClaw" : "Agent";
  return `${engineLabel} 想使用 MCP 工具 ${tool}`;
}
```

Use it when `toolName` contains `.` or method is MCP-specific. Export it for tests.

- [ ] **Step 8: Run focused tests**

Run:

```bash
node --test tests/renderer-mcp-library.test.js tests/agent-permission-coordinator.test.js
node -c src/renderer/mcp/mcp-library.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/mcp/mcp-library.js src/renderer/styles/mcp.css src/main/agent-permission-coordinator.js tests/renderer-mcp-library.test.js tests/agent-permission-coordinator.test.js
git commit -m "feat(mcp): 完成 MCP 管理交互"
```

---

### Task 9: End-To-End Verification And Product Hardening

**Files:**
- Modify: `docs/superpowers/specs/2026-06-18-custom-mcp-management-design.md` if implementation changes final wording.
- Test: all MCP and touched engine tests.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified, documented product-ready behavior.

- [ ] **Step 1: Run all focused MCP and engine tests**

Run:

```bash
node --test tests/mcp-*.test.js tests/codex-app-server-runner.test.js tests/codex-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/engine-runtime-config-service.test.js tests/openclaw-chat-adapter.test.js tests/renderer-mcp-library.test.js tests/skill-market-ui.test.js tests/agent-permission-coordinator.test.js
```

Expected: PASS.

- [ ] **Step 2: Run syntax checks for new files**

Run:

```bash
node -c src/main/mcp/mcp-records.js
node -c src/main/mcp/mcp-sdk-client.js
node -c src/main/mcp/mcp-bridge-server.js
node -c src/main/mcp/mcp-stdio-proxy-server.js
node -c src/main/mcp/mcp-engine-sync.js
node -c src/main/mcp/mcp-service.js
node -c src/main/ipc/mcp-ipc.js
node -c src/renderer/mcp/mcp-library.js
```

Expected: every command exits 0.

- [ ] **Step 3: Run repository smoke checks**

Run:

```bash
npm run check
npm test
```

Expected: PASS.

- [ ] **Step 4: Manual desktop smoke**

Run:

```bash
MIA_HOME="$(mktemp -d)" npm start
```

Verify:

- Rail `能力库` opens normally.
- Mode toggle shows `技能市场 / 我的技能 / MCP 服务`.
- `MCP 服务` shows `已安装 / 市场 / 自定义`.
- Add custom HTTP MCP with name `xhs` and URL `http://127.0.0.1:18060/mcp`.
- Test shows either connected tools or a clear connection error.
- Saving does not reveal secrets in the card.
- Deleting removes the server from the list.

- [ ] **Step 5: Inspect generated config with temp home**

With the app closed, inspect the temp `MIA_HOME` used in Step 4:

```bash
find "$MIA_HOME" -name 'mia-mcp-servers.json' -o -name 'config.yaml' -o -name 'config.toml'
```

Expected:

- `mia-mcp-servers.json` exists only inside temp home.
- `config.yaml` contains built-in MCP servers plus enabled user MCP servers or `mia-mcp-bridge` fallback.
- No real user `~/.codex/config.toml` or `~/.claude` files were touched during manual smoke unless explicitly syncing native CLI configs from the UI.

- [ ] **Step 6: Commit final verification notes if docs changed**

If implementation changed the spec, commit the doc alignment:

```bash
git add docs/superpowers/specs/2026-06-18-custom-mcp-management-design.md
git commit -m "docs(mcp): 对齐 MCP 实现细节"
```

If no docs changed, skip this commit.

---

## Self-Review

**Spec coverage:**

- Product entry in `能力库 -> MCP 服务`: Task 7.
- `已安装 / 市场 / 自定义`: Task 7.
- CRUD, import, test, sync, delete: Tasks 5 and 8.
- Transports `stdio`, `http`, `sse`, `streamable_http`: Tasks 1, 2, 4.
- Tool discovery through MCP SDK: Task 2.
- Mia local bridge and stdio proxy: Task 3.
- Hermes, Claude Code, Codex, OpenClaw: Tasks 4 and 6.
- Native CLI sync command planning: Task 4.
- Codex URL/bearer config overrides: Task 4.
- MCP fingerprint and stale session prevention: Task 6.
- Permission prompt copy for MCP tools: Task 8.
- Sensitive masking: Tasks 1 and 5.
- Existing built-in `mia-app` and `mia-scheduler` preserved: Tasks 4 and 6.

**Residual implementation risks:**

- The exact OpenClaw ACP capability advertisement may differ by installed OpenClaw version. The plan defaults to HTTP/SSE enabled in tests and keeps bridge fallback available.
- Hermes URL MCP support should be confirmed against the installed runtime during Task 9 manual smoke. If unsupported, `mia-mcp-bridge` stdio proxy remains the product path.
- Native CLI sync writes user-level Claude/Codex config only when invoked by the user through MCP sync; all tests must use temporary paths or command planners.

**Placeholder scan:**

- Each task has concrete files, interfaces, tests, commands, expected results, and commit scope.
- The plan uses named follow-up tasks inside the same product plan, not open-ended placeholders.
