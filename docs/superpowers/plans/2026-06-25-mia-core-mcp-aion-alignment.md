# Mia Core MCP AION Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move user MCP ownership into Mia Core and align the first usable slice with AION's MCP configuration, diagnostics, OAuth, and external agent discovery model.

**Architecture:** Add a Core MCP boundary under `src/core/mcp/` while keeping `src/main/mcp/*` as compatibility modules for bridge and engine conversion code. Core owns records, soft delete, structured connection tests, OAuth token state, external agent config discovery, and engine specs; Electron IPC/preload calls Core instead of owning MCP state.

**Tech Stack:** Node.js CommonJS, Electron main/preload compatibility wrappers, `node:test`, `@modelcontextprotocol/sdk`, built-in `http`, built-in `crypto`, `js-yaml`, existing Mia Core runtime paths and local agent environment resolution.

## Global Constraints

- First phase includes A+B+C only: basic MCP usability, AION-style configuration/diagnostics, and OAuth/auth_required.
- Team MCP is out of scope.
- Core is the owner of MCP lifecycle. Electron is only a client.
- Existing `mia-app` and `mia-scheduler` built-ins remain reserved and cannot be overridden by user MCP records.
- Tokens and other secrets are never exposed through renderer APIs, logs, diagnostics, or public record projections.
- The first phase may keep `mia-mcp-servers.json`, but APIs must behave like a repository with soft delete and redacted public projections.
- Connection setup failures must not crash Core startup or block unrelated turns.
- Native CLI/config writes remain explicit user actions; discovery is read-only.
- Tests must use temp runtime directories and must not write real user agent configs.

---

## File Structure

- Create `src/core/mcp/records.js`
  - Owns normalized Core MCP record shape, soft-delete filtering, redaction, fingerprinting, and import parsing.

- Create `src/core/mcp/file-registry.js`
  - Owns repository-like JSON persistence over `runtimePaths().mcpServers`.

- Create `src/core/mcp/service.js`
  - Core public MCP service. It composes registry, SDK manager, bridge, connection tester, OAuth service, agent discovery, native sync, and engine spec conversion.

- Modify `src/main/mcp/mcp-records.js`
  - Compatibility re-export from `src/core/mcp/records.js`.

- Modify `src/main/mcp/mcp-service.js`
  - Compatibility wrapper exporting `createMcpService` from `src/core/mcp/service.js`.

- Create `src/core/mcp/connection-test.js`
  - Structured MCP connection diagnostics and error code mapping.

- Modify `src/main/mcp/mcp-sdk-client.js`
  - Accept OAuth/auth header injection and return structured test results.

- Create `src/core/mcp/oauth-token-store.js`
  - File-backed token store separate from the public MCP registry.

- Create `src/core/mcp/oauth-service.js`
  - OAuth discovery, PKCE login, callback, token exchange, refresh, logout, and authenticated status.

- Create `src/core/mcp/agent-configs.js`
  - Read-only external Agent MCP discovery adapters for Claude Code, Codex, Hermes, and OpenClaw.

- Modify `src/core/mia-core.js`
  - Construct the Core MCP service and pass it to all engine adapters.

- Modify `src/shared/ipc-channels.js`
  - Add IPC channel names for `mcp:list-tools`, `mcp:agent-configs`, `mcp:import-agent-config`, `mcp:oauth:*`.

- Modify `src/main/ipc/mcp-ipc.js`
  - Register the new Core MCP methods.

- Modify `src/preload.js`
  - Expose the new MCP methods under `window.mia.mcp`.

- Modify `src/renderer/mcp/mcp-library.js`
  - Show structured diagnostics, OAuth status/actions, and discovered external configs.

- Modify `src/renderer/styles/mcp.css`
  - Style diagnostic/auth/discovery rows.

- Add tests:
  - `tests/core-mcp-records.test.js`
  - `tests/core-mcp-file-registry.test.js`
  - `tests/core-mcp-service.test.js`
  - `tests/core-mcp-connection-test.test.js`
  - `tests/core-mcp-oauth-service.test.js`
  - `tests/core-mcp-agent-configs.test.js`

- Modify tests:
  - `tests/mcp-records.test.js`
  - `tests/mcp-service.test.js`
  - `tests/mcp-sdk-client.test.js`
  - `tests/mcp-ipc-preload.test.js`
  - `tests/renderer-mcp-library.test.js`
  - `tests/mcp-engine-sync.test.js`
  - `tests/mia-core-engines.test.js`
  - `tests/claude-code-chat-adapter.test.js`
  - `tests/codex-chat-adapter.test.js`
  - `tests/openclaw-chat-adapter.test.js`
  - `tests/engine-runtime-config-service.test.js`

---

### Task 1: Core MCP Records And File Registry

**Files:**
- Create: `src/core/mcp/records.js`
- Create: `src/core/mcp/file-registry.js`
- Modify: `src/main/mcp/mcp-records.js`
- Test: `tests/core-mcp-records.test.js`
- Test: `tests/core-mcp-file-registry.test.js`
- Modify: `tests/mcp-records.test.js`

**Interfaces:**
- Produces: `normalizeCoreMcpRecord(input, options) -> CoreMcpRecord | null`
- Produces: `normalizeCoreMcpRegistry(value, options) -> CoreMcpRecord[]`
- Produces: `publicCoreMcpRecord(record) -> redacted record`
- Produces: `publicCoreMcpRecords(records, { includeDeleted }) -> redacted records`
- Produces: `enabledCoreMcpRecords(records) -> non-deleted enabled records`
- Produces: `coreMcpFingerprint(records) -> sha256 string`
- Produces: `parseCoreMcpImportJson(input) -> normalized input records`
- Produces: `createCoreMcpFileRegistry({ runtimePaths, fs, now, idFactory })`
- Compatibility: `src/main/mcp/mcp-records.js` exports the old names by aliasing the Core functions.

- [ ] **Step 1: Write failing record tests**

Create `tests/core-mcp-records.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  normalizeCoreMcpRecord,
  publicCoreMcpRecord,
  enabledCoreMcpRecords,
  coreMcpFingerprint,
  parseCoreMcpImportJson
} = require("../src/core/mcp/records.js");

test("normalizes AION-style fields and maps old status fields", () => {
  const record = normalizeCoreMcpRecord({
    id: "mcp_xhs",
    name: "xhs",
    displayName: "XHS",
    enabled: true,
    status: "connected",
    tools: [{ name: "search", inputSchema: { type: "object" } }],
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  }, { now: () => 1710000000000 });

  assert.equal(record.lastTestStatus, "connected");
  assert.equal(record.deletedAt, null);
  assert.equal(record.oauth.authenticated, false);
  assert.equal(record.sync.codex.status, "pending");
});

test("public record redacts env headers oauth token refs and original json", () => {
  const record = normalizeCoreMcpRecord({
    name: "github",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
      env: { GITHUB_TOKEN: "ghp_real_secret" }
    },
    oauth: { authenticated: true, tokenRef: "oauth_token_1" },
    originalJson: JSON.stringify({ headers: { Authorization: "Bearer secret" } })
  });

  const view = publicCoreMcpRecord(record);
  assert.equal(view.transport.env.GITHUB_TOKEN, "••••••••");
  assert.equal(view.oauth.tokenRef, "");
  assert.doesNotMatch(view.originalJson, /secret|ghp_real_secret/);
});

test("enabled records exclude disabled and soft-deleted records", () => {
  const active = normalizeCoreMcpRecord({ name: "active", transport: { type: "stdio", command: "npx" } });
  const disabled = normalizeCoreMcpRecord({ name: "disabled", enabled: false, transport: { type: "stdio", command: "npx" } });
  const deleted = normalizeCoreMcpRecord({ name: "deleted", deletedAt: 171, transport: { type: "stdio", command: "npx" } });

  assert.deepEqual(enabledCoreMcpRecords([active, disabled, deleted]).map((item) => item.name), ["active"]);
});

test("fingerprint changes when enabled transport changes and ignores deleted records", () => {
  const a = normalizeCoreMcpRecord({ name: "a", transport: { type: "stdio", command: "npx", args: ["one"] } });
  const b = normalizeCoreMcpRecord({ name: "a", transport: { type: "stdio", command: "npx", args: ["two"] } });
  const deleted = normalizeCoreMcpRecord({ name: "gone", deletedAt: 171, transport: { type: "stdio", command: "node" } });

  assert.notEqual(coreMcpFingerprint([a]), coreMcpFingerprint([b]));
  assert.equal(coreMcpFingerprint([a]), coreMcpFingerprint([a, deleted]));
});

test("import parser accepts mcpServers and streamable-http aliases", () => {
  const imported = parseCoreMcpImportJson({
    mcpServers: {
      remote: { type: "streamable-http", url: "https://example.com/mcp" }
    }
  });

  assert.equal(imported[0].name, "remote");
  assert.equal(imported[0].transport.type, "http");
});
```

- [ ] **Step 2: Write failing file registry tests**

Create `tests/core-mcp-file-registry.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createCoreMcpFileRegistry } = require("../src/core/mcp/file-registry.js");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-mcp-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registryPath = path.join(dir, "mia-mcp-servers.json");
  const registry = createCoreMcpFileRegistry({
    runtimePaths: () => ({ mcpServers: registryPath }),
    fs,
    now: () => 1710000000000,
    idFactory: (name) => `mcp_${name}`
  });
  return { registry, registryPath };
}

test("upsert persists normalized records and list hides soft-deleted by default", async (t) => {
  const { registry, registryPath } = setup(t);
  const saved = await registry.upsert({
    name: "playwright",
    transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] }
  });

  await registry.softDelete(saved.id);

  assert.deepEqual((await registry.list()).map((record) => record.name), []);
  assert.deepEqual((await registry.list({ includeDeleted: true })).map((record) => record.name), ["playwright"]);
  assert.equal(JSON.parse(fs.readFileSync(registryPath, "utf8"))[0].deletedAt, 1710000000000);
});

test("get resolves by id or name including deleted records", async (t) => {
  const { registry } = setup(t);
  const saved = await registry.upsert({
    name: "xhs",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  await registry.softDelete(saved.id);

  assert.equal((await registry.get(saved.id)).name, "xhs");
  assert.equal((await registry.get("xhs")).id, saved.id);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/core-mcp-records.test.js tests/core-mcp-file-registry.test.js
```

Expected: FAIL with `Cannot find module '../src/core/mcp/records.js'`.

- [ ] **Step 4: Implement `src/core/mcp/records.js`**

Create `src/core/mcp/records.js` by copying the current contents of
`src/main/mcp/mcp-records.js`, then apply these exact changes:

- Change the import path for shared contracts to `../../shared/mcp-contracts.js`.
- Rename exported functions:
  - `normalizeMcpRecord` -> `normalizeCoreMcpRecord`
  - `normalizeMcpRegistry` -> `normalizeCoreMcpRegistry`
  - `maskMcpRecord` -> `publicCoreMcpRecord`
  - `enabledMcpRecords` -> `enabledCoreMcpRecords`
  - `mcpFingerprint` -> `coreMcpFingerprint`
  - `parseMcpImportJson` -> `parseCoreMcpImportJson`
- Add `deletedAt`, `lastTestStatus`, `lastTestCode`, `diagnostics`, `oauth`,
  `sourceAgent`, `displayName`, and `builtin` to the returned record.
- Preserve old callers by mapping old `status` into `lastTestStatus`.
- Exclude `deletedAt` records from `enabledCoreMcpRecords()` and
  `coreMcpFingerprint()`.
- Redact `oauth.tokenRef`, `transport.env`, `transport.headers`,
  `originalJson`, `lastError`, and `diagnostics.message` in
  `publicCoreMcpRecord()`.
- Normalize transport type aliases so `streamable-http` and `streamable_http`
  both become `http`.

The resulting module must expose:

```js
"use strict";

module.exports = {
  MASK,
  cleanObject,
  coreMcpFingerprint,
  enabledCoreMcpRecords,
  normalizeCoreMcpRecord,
  normalizeCoreMcpRegistry,
  normalizeTransport,
  parseCoreMcpImportJson,
  publicCoreMcpRecord,
  publicCoreMcpRecords,
  sanitizeSecretText
};
```

- [ ] **Step 5: Implement `src/core/mcp/file-registry.js`**

Create the file:

```js
"use strict";

const fsDefault = require("node:fs");
const path = require("node:path");
const {
  normalizeCoreMcpRecord,
  normalizeCoreMcpRegistry
} = require("./records.js");

function readJson(fsImpl, filePath, fallback) {
  try { return JSON.parse(fsImpl.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function atomicWriteJson(fsImpl, filePath, value) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsImpl.renameSync(tmp, filePath);
}

function createCoreMcpFileRegistry(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const fsImpl = deps.fs || fsDefault;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const idFactory = typeof deps.idFactory === "function" ? deps.idFactory : undefined;
  const normalizeOptions = () => ({ now, ...(idFactory ? { idFactory } : {}) });
  const pathForRecords = () => runtimePaths().mcpServers;

  function readAll() {
    return normalizeCoreMcpRegistry(readJson(fsImpl, pathForRecords(), []), normalizeOptions());
  }

  function writeAll(records) {
    const normalized = normalizeCoreMcpRegistry(records, normalizeOptions());
    atomicWriteJson(fsImpl, pathForRecords(), normalized);
    return normalized;
  }

  async function list(options = {}) {
    return readAll().filter((record) => options.includeDeleted === true || !record.deletedAt);
  }

  async function get(idOrName) {
    const needle = String(idOrName || "").trim();
    return readAll().find((record) => record.id === needle || record.name === needle) || null;
  }

  async function upsert(input = {}) {
    const current = readAll();
    const existing = input.id ? current.find((record) => record.id === input.id) : current.find((record) => record.name === String(input.name || "").trim());
    const record = normalizeCoreMcpRecord({ ...(existing || {}), ...(input || {}), id: input.id || existing?.id, createdAt: existing?.createdAt }, normalizeOptions());
    if (!record) throw new Error("MCP server record is invalid.");
    return writeAll(current.filter((item) => item.id !== record.id && item.name !== record.name).concat({ ...record, updatedAt: now() })).find((item) => item.id === record.id);
  }

  async function softDelete(idOrName) {
    const current = readAll();
    const existing = current.find((record) => record.id === idOrName || record.name === idOrName);
    if (!existing) throw new Error("MCP server not found.");
    const deletedAt = now();
    writeAll(current.map((record) => record.id === existing.id ? { ...record, enabled: false, deletedAt, updatedAt: deletedAt } : record));
    return { ...existing, enabled: false, deletedAt, updatedAt: deletedAt };
  }

  return { get, list, readAll, softDelete, upsert, writeAll };
}

module.exports = { createCoreMcpFileRegistry };
```

- [ ] **Step 6: Add compatibility exports**

Replace `src/main/mcp/mcp-records.js` with alias exports to avoid two record implementations:

```js
"use strict";

const core = require("../../core/mcp/records.js");

module.exports = {
  MASK_SENTINEL: core.MASK,
  cleanObject: core.cleanObject,
  enabledMcpRecords: core.enabledCoreMcpRecords,
  maskMcpRecord: core.publicCoreMcpRecord,
  mcpFingerprint: core.coreMcpFingerprint,
  normalizeMcpRecord: core.normalizeCoreMcpRecord,
  normalizeMcpRegistry: core.normalizeCoreMcpRegistry,
  normalizeTransport: core.normalizeTransport,
  parseMcpImportJson: core.parseCoreMcpImportJson,
  sanitizeSecretText: core.sanitizeSecretText
};
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test tests/core-mcp-records.test.js tests/core-mcp-file-registry.test.js tests/mcp-records.test.js
node --check src/core/mcp/records.js
node --check src/core/mcp/file-registry.js
node --check src/main/mcp/mcp-records.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/mcp/records.js src/core/mcp/file-registry.js src/main/mcp/mcp-records.js tests/core-mcp-records.test.js tests/core-mcp-file-registry.test.js tests/mcp-records.test.js
git commit -m "feat(core-mcp): add core record registry"
```

---

### Task 2: Core MCP Service Boundary And Soft Delete Compatibility

**Files:**
- Create: `src/core/mcp/service.js`
- Modify: `src/main/mcp/mcp-service.js`
- Modify: `tests/mcp-service.test.js`
- Test: `tests/core-mcp-service.test.js`

**Interfaces:**
- Produces: `createCoreMcpService(deps)` with old methods `list/save/delete/setEnabled/test/importJson/fetchMarketplace/installTemplate/sync/refreshBridge/removeFromAgents/getEngineSpecs/fingerprint/awaitInitialization`.
- Produces: new methods `create/update/listTools/testConnection/getAgentConfigs/importAgentConfig/oauth`.
- Compatibility: `createMcpService(deps)` returns `createCoreMcpService(deps)`.

- [ ] **Step 1: Write failing service boundary tests**

Create `tests/core-mcp-service.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createCoreMcpService } = require("../src/core/mcp/service.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-mcp-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = { mcpServers: path.join(dir, "mia-mcp-servers.json"), runtime: dir };
  const manager = overrides.manager || {
    refresh: async () => ({ success: true, tools: [], errors: [] }),
    testServer: async (record) => ({ ok: true, success: true, status: "connected", code: "ok", tools: [{ server: record.name, name: "search" }], error: "" }),
    toolManifest: () => [{ server: "xhs", name: "search", inputSchema: {} }]
  };
  return {
    service: createCoreMcpService({
      runtimePaths: () => runtime,
      fs,
      manager,
      bridge: overrides.bridge || { start: async () => ({ callbackUrl: "http://127.0.0.1:3333/mcp/execute", manifestUrl: "http://127.0.0.1:3333/mcp/manifest", secret: "sec" }) },
      nativeSync: overrides.nativeSync || (async () => ({ success: true, statuses: {}, commands: [] })),
      connectionTester: overrides.connectionTester,
      agentConfigService: overrides.agentConfigService,
      oauthService: overrides.oauthService,
      now: () => 1710000000000,
      idFactory: (name) => `mcp_${name}`
    }),
    runtime
  };
}

test("delete soft-deletes and list hides deleted records by default", async (t) => {
  const { service, runtime } = setup(t);
  const saved = await service.save({ name: "xhs", transport: { type: "http", url: "http://127.0.0.1:18060/mcp" } });

  const deleted = await service.delete(saved.data.id);
  const listed = await service.list();
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(deleted.success, true);
  assert.deepEqual(listed.data.servers, []);
  assert.equal(stored[0].deletedAt, 1710000000000);
  assert.equal(stored[0].enabled, false);
});

test("failed test persists diagnostics but does not auto-disable existing server", async (t) => {
  const { service } = setup(t, {
    connectionTester: {
      testConnection: async () => ({
        ok: false,
        success: false,
        status: "auth_required",
        code: "auth_required",
        message: "OAuth login required",
        tools: [],
        auth: { needsAuth: true, method: "oauth", serverUrl: "https://example.com/mcp" }
      })
    }
  });
  const saved = await service.save({ name: "remote", enabled: true, transport: { type: "http", url: "https://example.com/mcp" } });
  const tested = await service.test(saved.data.id);

  assert.equal(tested.success, true);
  assert.equal(tested.data.enabled, true);
  assert.equal(tested.data.lastTestStatus, "auth_required");
  assert.equal(tested.data.lastError, "OAuth login required");
});

test("new methods delegate to agent discovery oauth and manager manifest", async (t) => {
  const calls = [];
  const { service } = setup(t, {
    agentConfigService: {
      getAgentConfigs: async () => [{ source: "codex", installed: true, servers: [] }],
      importAgentConfig: async (input) => ({ imported: 1, input })
    },
    oauthService: {
      checkStatus: async (input) => ({ authenticated: true, input }),
      login: async () => ({ loginUrl: "http://127.0.0.1/login" }),
      logout: async () => ({ authenticated: false })
    },
    manager: {
      refresh: async () => ({ success: true, tools: [], errors: [] }),
      testServer: async () => ({ ok: true, status: "connected", tools: [] }),
      toolManifest: () => { calls.push("manifest"); return [{ server: "xhs", name: "search" }]; }
    }
  });

  assert.equal((await service.listTools()).data.tools[0].name, "search");
  assert.equal((await service.getAgentConfigs()).data.sources[0].source, "codex");
  assert.equal((await service.importAgentConfig({ sourceAgent: "codex", serverName: "x" })).data.imported, 1);
  assert.equal((await service.oauth.checkStatus({ serverUrl: "https://example.com/mcp" })).data.authenticated, true);
  assert.deepEqual(calls, ["manifest"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/core-mcp-service.test.js
```

Expected: FAIL with `Cannot find module '../src/core/mcp/service.js'`.

- [ ] **Step 3: Implement `src/core/mcp/service.js`**

Create `src/core/mcp/service.js` by copying the current body of
`src/main/mcp/mcp-service.js`, then apply this exact refactor:

- Rename factory `createMcpService` to `createCoreMcpService`.
- Change imports from `./mcp-records.js` to `./records.js` and use the Core
  function names from Task 1.
- Import `createCoreMcpFileRegistry` from `./file-registry.js`.
- Replace the internal `loadRecords()` and `saveRecords(records)` helpers with:

```js
const registry = deps.registry || createCoreMcpFileRegistry({ runtimePaths, fs: fsImpl, now, idFactory });

function loadRecords(options = {}) {
  return options.includeDeleted === true
    ? registry.readAll()
    : registry.readAll().filter((record) => !record.deletedAt);
}

function saveRecords(records) {
  return registry.writeAll(records);
}
```

- Keep these functions from the old service with their current logic:
  `marketplaceTemplates`, `readJson`, `atomicWriteJson`, `ok`, `fail`,
  `sanitizeBridgeError`, `maskedBridgeInfo`, `mergeStatus`, `isErrorStatus`,
  `hasNativeErrors`, `hasNativeCommandsOrErrors`, `applyStatuses`,
  `refreshBridgeState`, `initializationTimeoutError`, `startInitialization`,
  `awaitInitialization`, `initialize`, `applyRuntimeChanges`, `resolveRecord`,
  `normalizeInputRecord`, `preserveMaskedObjectValues`,
  `preserveMaskedTransportSecrets`, `currentFingerprint`, `save`, `setEnabled`,
  `importJson`, `fetchMarketplace`, `installTemplate`, `refreshBridge`,
  `bridgeBaseUrl`, `getBridgeSpec`, `enabledRecords`, `fingerprint`,
  `getEngineSpecs`, `sync`, and `removeFromAgents`.
- Change `deleteServer(id)` from physical removal to `registry.softDelete(id)`;
  then call `applyRuntimeChanges(previousRecords, remainingVisibleRecords, {
  persistedRecords: allRecordsAfterSoftDelete })`.
- Change `testServer(idOrInput)` so failed tests persist diagnostics but never
  auto-disable the record. It writes:
  `lastTestStatus`, `lastTestCode`, `diagnostics`, `tools`, `lastCheckedAt`,
  `lastError`, and `oauth.authenticated` from the diagnostic result.
- Add `listTools()`, `getAgentConfigs()`, `importAgentConfig(input)`, and
  `oauth.checkStatus/login/logout` to the returned service object.
- Export exactly:

```js
module.exports = { createCoreMcpService };
```

- [ ] **Step 4: Make `src/main/mcp/mcp-service.js` a compatibility wrapper**

Replace its body with:

```js
"use strict";

const { createCoreMcpService } = require("../../core/mcp/service.js");

module.exports = {
  createMcpService: createCoreMcpService
};
```

- [ ] **Step 5: Update existing service tests for soft delete and no auto-disable**

In `tests/mcp-service.test.js`, change the delete assertion from expecting an empty stored file to expecting one soft-deleted disabled record:

```js
const storedAfterDelete = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
assert.equal(storedAfterDelete[0].deletedAt, 1710000000000);
assert.equal(storedAfterDelete[0].enabled, false);
```

Add this test:

```js
test("test failure stores diagnostic without disabling server", async (t) => {
  const { service } = setup(t, {
    manager: {
      testServer: async () => ({ success: false, status: "auth_required", code: "auth_required", message: "Login required", tools: [], error: "Login required" }),
      refresh: async () => ({ success: true, tools: [], errors: [] })
    }
  });
  const saved = await service.save({ name: "remote", enabled: true, transport: { type: "http", url: "https://example.com/mcp" } });
  const tested = await service.test(saved.data.id);
  assert.equal(tested.data.enabled, true);
  assert.equal(tested.data.lastTestStatus, "auth_required");
});
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/core-mcp-service.test.js tests/mcp-service.test.js tests/startup-mcp-initializer.test.js
node --check src/core/mcp/service.js
node --check src/main/mcp/mcp-service.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/mcp/service.js src/main/mcp/mcp-service.js tests/core-mcp-service.test.js tests/mcp-service.test.js tests/startup-mcp-initializer.test.js
git commit -m "feat(core-mcp): move mcp service ownership into core"
```

---

### Task 3: Structured Connection Tests And Runtime Env Resolution

**Files:**
- Create: `src/core/mcp/connection-test.js`
- Modify: `src/main/mcp/mcp-sdk-client.js`
- Modify: `tests/mcp-sdk-client.test.js`
- Test: `tests/core-mcp-connection-test.test.js`
- Modify: `tests/core-mcp-service.test.js`

**Interfaces:**
- Produces: `createCoreMcpConnectionTester(deps).testConnection(record, options) -> DiagnosticResult`
- Produces: `classifyMcpConnectionError(error, context) -> DiagnosticResult`
- Consumes: `processEnvStrings()`
- Consumes: optional `oauthService.authorizationHeadersForServer(record)`
- Compatibility: `manager.testServer(record)` returns both old `success/status/tools/error` fields and new `ok/code/message/details/auth`.

- [ ] **Step 1: Write failing diagnostics tests**

Create `tests/core-mcp-connection-test.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { classifyMcpConnectionError, createCoreMcpConnectionTester } = require("../src/core/mcp/connection-test.js");

test("classifies command not found errors", () => {
  const result = classifyMcpConnectionError(Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }), { command: "npx", durationMs: 12 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "command_not_found");
  assert.equal(result.details.command, "npx");
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
});

test("testConnection uses injected SDK transport and returns tools", async () => {
  const calls = [];
  const tester = createCoreMcpConnectionTester({
    loadSdk: async () => ({
      Client: class Client {
        async connect() { calls.push("connect"); }
        async listTools() { return { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] }; }
        async close() { calls.push("client.close"); }
      },
      StdioClientTransport: class StdioClientTransport {
        constructor(options) { calls.push(["stdio", options]); }
        async close() { calls.push("transport.close"); }
      },
      SSEClientTransport: class SSEClientTransport {},
      StreamableHTTPClientTransport: class StreamableHTTPClientTransport {}
    }),
    processEnvStrings: () => ({ PATH: "/usr/bin" }),
    timeoutMs: 1000
  });

  const result = await tester.testConnection({ name: "pw", transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] } });

  assert.equal(result.ok, true);
  assert.equal(result.status, "connected");
  assert.equal(result.tools[0].name, "search");
  assert.equal(calls[0][0], "stdio");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/core-mcp-connection-test.test.js
```

Expected: FAIL with `Cannot find module '../src/core/mcp/connection-test.js'`.

- [ ] **Step 3: Implement `src/core/mcp/connection-test.js`**

Create `src/core/mcp/agent-configs.js` with these rules:

- `parseClaudeMcpList(output)` parses lines matching
  `<name>: <command-or-url> - <status>`. Lines with names starting `plugin:`
  return `importable: false` and `importSkipReason: "Plugin-managed MCP"`.
- `parseCodexMcpListJson(output)` parses the `codex mcp list --json` array.
  It accepts `transport.env` object and `transport.env_vars` array.
- `parseOpenClawMcpListJson(output)` uses the same JSON shape as Codex and sets
  `source: "openclaw"` on each result.
- `parseHermesConfigYaml(content)` parses `mcp_servers` entries from Hermes
  `config.yaml`. Entries with `command` become stdio; entries with `url` become
  `http` unless their `type` is `sse`.
- `getAgentConfigs()` always returns four source objects in this order:
  `claude-code`, `codex`, `openclaw`, `hermes`.
- Failed CLI probes do not throw; they return `{ installed: false, servers: [],
  error }` for that source.

```js
"use strict";

const { defaultLoadSdk, toolManifestFor } = require("../../main/mcp/mcp-sdk-client.js");
const { normalizeCoreMcpRecord, sanitizeSecretText } = require("./records.js");

function hasAuthorizationHeader(headers = {}) { return Object.keys(headers || {}).some((key) => key.toLowerCase() === "authorization"); }
function headersFromError(error = {}) { return error.headers || error.response?.headers || {}; }
function headerValue(headers = {}, name) { return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || ""; }

function diagnostic(fields) {
  return {
    ok: fields.ok === true,
    success: fields.ok === true,
    status: fields.status || (fields.ok ? "connected" : "disconnected"),
    code: fields.code || (fields.ok ? "ok" : "connection_failed"),
    message: sanitizeSecretText(fields.message || ""),
    error: sanitizeSecretText(fields.message || ""),
    details: fields.details || {},
    tools: Array.isArray(fields.tools) ? fields.tools : [],
    auth: fields.auth || { needsAuth: false, method: "", serverUrl: "" }
  };
}

function classifyMcpConnectionError(error, context = {}) {
  const message = sanitizeSecretText(error?.message || error || "MCP connection failed.");
  const durationMs = Number(context.durationMs || 0);
  const httpStatus = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const headers = headersFromError(error);
  const wwwAuthenticate = headerValue(headers, "www-authenticate");
  if (error?.code === "ENOENT" || /ENOENT|not found|command not found/i.test(message)) {
    return diagnostic({ ok: false, code: "command_not_found", message, details: { command: context.command || "", durationMs } });
  }
  if (error?.code === "EACCES" || /permission denied|EACCES/i.test(message)) {
    return diagnostic({ ok: false, code: "permission_denied", message, details: { command: context.command || "", durationMs } });
  }
  if (error?.name === "AbortError" || error?.code === "ETIMEDOUT" || /timeout|timed out/i.test(message)) {
    return diagnostic({ ok: false, code: "timeout", message, details: { durationMs } });
  }
  if (httpStatus === 401 || /HTTP 401|401 Unauthorized/i.test(message)) {
    return diagnostic({
      ok: false,
      status: "auth_required",
      code: "auth_required",
      message: "MCP server requires authentication.",
      details: { httpStatus: 401, wwwAuthenticate: sanitizeSecretText(wwwAuthenticate), durationMs },
      auth: { needsAuth: true, method: "oauth", serverUrl: context.url || "" }
    });
  }
  if (httpStatus) return diagnostic({ ok: false, code: "http_error", message, details: { httpStatus, durationMs } });
  if (/initialize|tools\/list|JSON-RPC|protocol/i.test(message)) return diagnostic({ ok: false, code: "protocol_error", message, details: { durationMs } });
  return diagnostic({ ok: false, code: "connection_failed", message, details: { durationMs } });
}

function createCoreMcpConnectionTester(deps = {}) {
  const loadSdk = typeof deps.loadSdk === "function" ? deps.loadSdk : defaultLoadSdk;
  const processEnvStrings = typeof deps.processEnvStrings === "function" ? deps.processEnvStrings : () => process.env;
  const oauthService = deps.oauthService || null;
  const timeoutMs = Number(deps.timeoutMs || 15000);

  async function transportFor(record) {
    const sdk = await loadSdk();
    const env = processEnvStrings();
    const transport = record.transport || {};
    if (transport.type === "stdio") {
      return new sdk.StdioClientTransport({ command: transport.command, args: transport.args || [], env: { ...env, ...(transport.env || {}) } });
    }
    const headers = { ...(transport.headers || {}) };
    const oauthHeaders = oauthService?.authorizationHeadersForServer ? await oauthService.authorizationHeadersForServer(record) : {};
    Object.assign(headers, oauthHeaders);
    const bearerToken = transport.bearerTokenEnvVar ? String(env[transport.bearerTokenEnvVar] || "").trim() : "";
    if (bearerToken && !hasAuthorizationHeader(headers)) headers.Authorization = `Bearer ${bearerToken}`;
    const requestInit = Object.keys(headers).length ? { headers } : undefined;
    const options = requestInit ? { requestInit } : undefined;
    const url = new URL(transport.url);
    if (transport.type === "sse") return new sdk.SSEClientTransport(url, options);
    return new sdk.StreamableHTTPClientTransport(url, options);
  }

  async function testConnection(input) {
    const started = Date.now();
    let record = null;
    let client = null;
    let transport = null;
    try {
      record = normalizeCoreMcpRecord(input);
      if (!record) throw new Error("Invalid MCP server record");
      const sdk = await loadSdk();
      transport = await transportFor(record);
      client = new sdk.Client({ name: "mia-mcp-test", version: "1.0.0" }, { capabilities: {} });
      await Promise.race([
        (async () => {
          await client.connect(transport);
          const listed = await client.listTools();
          return listed;
        })(),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`Timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" })), timeoutMs))
      ]);
      const listed = await client.listTools();
      return diagnostic({ ok: true, status: "connected", code: "ok", tools: toolManifestFor(record.name, listed.tools || []), details: { durationMs: Date.now() - started } });
    } catch (error) {
      return classifyMcpConnectionError(error, {
        command: record?.transport?.command || input?.transport?.command || input?.command || "",
        url: record?.transport?.url || input?.transport?.url || input?.url || "",
        durationMs: Date.now() - started
      });
    } finally {
      await Promise.allSettled([client?.close?.(), transport?.close?.()]);
    }
  }

  return { testConnection };
}

module.exports = { classifyMcpConnectionError, createCoreMcpConnectionTester, diagnostic };
```

Implementation detail: avoid calling `client.listTools()` twice in final code. Store the result from the connect block and use it once.

- [ ] **Step 4: Wire SDK manager to structured tester**

Modify `src/main/mcp/mcp-sdk-client.js`:

```js
const { createCoreMcpConnectionTester } = require("../../core/mcp/connection-test.js");
```

Inside `createMcpSdkClientManager`, add:

```js
const connectionTester = deps.connectionTester || createCoreMcpConnectionTester({
  loadSdk,
  processEnvStrings,
  oauthService: deps.oauthService || null,
  timeoutMs: deps.connectionTestTimeoutMs || 15000
});
```

Replace the current `testServer` body with:

```js
async function testServer(input) {
  const result = await connectionTester.testConnection(input);
  if (!result.ok) logMasked("test failed for server", input, result.message || result.error);
  return result;
}
```

- [ ] **Step 5: Update SDK manager tests for structured shape**

In `tests/mcp-sdk-client.test.js`, keep old success assertions and add:

```js
assert.equal(result.ok, true);
assert.equal(result.code, "ok");
```

For the redaction failure test, assert:

```js
assert.equal(tested.ok, false);
assert.match(tested.message || tested.error, /\[redacted\]/);
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/core-mcp-connection-test.test.js tests/mcp-sdk-client.test.js tests/core-mcp-service.test.js tests/mcp-service.test.js
node --check src/core/mcp/connection-test.js
node --check src/main/mcp/mcp-sdk-client.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/mcp/connection-test.js src/main/mcp/mcp-sdk-client.js tests/core-mcp-connection-test.test.js tests/mcp-sdk-client.test.js tests/core-mcp-service.test.js tests/mcp-service.test.js
git commit -m "feat(core-mcp): add structured connection diagnostics"
```

---

### Task 4: OAuth Token Store And PKCE Flow

**Files:**
- Create: `src/core/mcp/oauth-token-store.js`
- Create: `src/core/mcp/oauth-service.js`
- Modify: `src/core/mcp/service.js`
- Modify: `src/core/mcp/connection-test.js`
- Test: `tests/core-mcp-oauth-service.test.js`
- Modify: `tests/core-mcp-connection-test.test.js`

**Interfaces:**
- Produces: `createCoreMcpOAuthTokenStore({ runtimePaths, fs, now })`
- Produces: `createCoreMcpOAuthService({ tokenStore, fetch, openExternal, createServer, now })`
- Produces: `oauthService.authorizationHeadersForServer(record) -> { Authorization } | {}`
- Produces: `oauthService.checkStatus({ serverId, serverUrl })`
- Produces: `oauthService.login({ serverId, serverUrl })`
- Produces: `oauthService.logout({ serverId, serverUrl })`

- [ ] **Step 1: Write failing OAuth tests**

Create `tests/core-mcp-oauth-service.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createCoreMcpOAuthTokenStore } = require("../src/core/mcp/oauth-token-store.js");
const { createCoreMcpOAuthService } = require("../src/core/mcp/oauth-service.js");

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-mcp-oauth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createCoreMcpOAuthTokenStore({
    runtimePaths: () => ({ runtime: dir, home: dir }),
    fs,
    now: () => 1710000000000
  });
}

test("token store writes outside public registry and redacts token material", async (t) => {
  const store = tempStore(t);
  await store.saveToken("https://example.com/mcp", { accessToken: "access", refreshToken: "refresh", expiresAt: 1710003600000, tokenType: "Bearer" });

  const loaded = await store.getToken("https://example.com/mcp");
  const view = await store.publicStatus("https://example.com/mcp");

  assert.equal(loaded.accessToken, "access");
  assert.equal(view.authenticated, true);
  assert.equal(view.accessToken, undefined);
});

test("authorizationHeadersForServer returns bearer header and refreshes expired token", async (t) => {
  const store = tempStore(t);
  await store.saveToken("https://example.com/mcp", { accessToken: "old", refreshToken: "refresh", expiresAt: 1709999999000, tokenType: "Bearer", tokenEndpoint: "https://auth.example/token" });
  const fetchCalls = [];
  const service = createCoreMcpOAuthService({
    tokenStore: store,
    now: () => 1710000000000,
    fetch: async (url) => {
      fetchCalls.push(String(url));
      return { ok: true, json: async () => ({ access_token: "new", refresh_token: "refresh2", expires_in: 3600, token_type: "Bearer" }) };
    }
  });

  const headers = await service.authorizationHeadersForServer({ transport: { type: "http", url: "https://example.com/mcp" } });

  assert.deepEqual(headers, { Authorization: "Bearer new" });
  assert.deepEqual(fetchCalls, ["https://auth.example/token"]);
});

test("logout deletes token and checkStatus reports unauthenticated", async (t) => {
  const store = tempStore(t);
  await store.saveToken("https://example.com/mcp", { accessToken: "access", expiresAt: 1710003600000, tokenType: "Bearer" });
  const service = createCoreMcpOAuthService({ tokenStore: store, now: () => 1710000000000 });

  assert.equal((await service.checkStatus({ serverUrl: "https://example.com/mcp" })).authenticated, true);
  await service.logout({ serverUrl: "https://example.com/mcp" });
  assert.equal((await service.checkStatus({ serverUrl: "https://example.com/mcp" })).authenticated, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/core-mcp-oauth-service.test.js
```

Expected: FAIL with missing OAuth modules.

- [ ] **Step 3: Implement token store**

Create `src/core/mcp/oauth-token-store.js`:

```js
"use strict";

const crypto = require("node:crypto");
const fsDefault = require("node:fs");
const path = require("node:path");

function tokenKey(serverUrl) {
  return crypto.createHash("sha256").update(String(serverUrl || "").trim()).digest("hex");
}

function createCoreMcpOAuthTokenStore(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const fs = deps.fs || fsDefault;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const filePath = () => path.join(runtimePaths().runtime || runtimePaths().home, "mcp-oauth-tokens.json");
  function readAll() { try { return JSON.parse(fs.readFileSync(filePath(), "utf8")); } catch { return {}; } }
  function writeAll(value) { fs.mkdirSync(path.dirname(filePath()), { recursive: true }); const tmp = `${filePath()}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, filePath()); }
  async function saveToken(serverUrl, token) { const all = readAll(); all[tokenKey(serverUrl)] = { serverUrl, ...token, updatedAt: now() }; writeAll(all); return all[tokenKey(serverUrl)]; }
  async function getToken(serverUrl) { return readAll()[tokenKey(serverUrl)] || null; }
  async function deleteToken(serverUrl) { const all = readAll(); delete all[tokenKey(serverUrl)]; writeAll(all); }
  async function publicStatus(serverUrl) { const token = await getToken(serverUrl); return { authenticated: Boolean(token?.accessToken && (!token.expiresAt || token.expiresAt > now())), expiresAt: token?.expiresAt || null, tokenType: token?.tokenType || "" }; }
  return { deleteToken, getToken, publicStatus, saveToken };
}

module.exports = { createCoreMcpOAuthTokenStore, tokenKey };
```

- [ ] **Step 4: Implement OAuth service**

Create `src/core/mcp/oauth-service.js` with these concrete behaviors:

```js
"use strict";

const crypto = require("node:crypto");

function base64Url(buffer) { return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function pkcePair() { const verifier = base64Url(crypto.randomBytes(32)); const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest()); return { verifier, challenge, method: "S256" }; }
function serverUrlFrom(input = {}) { return String(input.serverUrl || input.url || input.transport?.url || "").trim(); }
function expiresAtFrom(now, body = {}) { return body.expires_in ? now() + Number(body.expires_in) * 1000 : null; }

function createCoreMcpOAuthService(deps = {}) {
  const tokenStore = deps.tokenStore;
  if (!tokenStore) throw new Error("tokenStore dependency is required.");
  const fetchImpl = deps.fetch || fetch;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const openExternal = typeof deps.openExternal === "function" ? deps.openExternal : async () => {};

  async function refreshToken(serverUrl, token) {
    if (!token?.refreshToken || !token?.tokenEndpoint) return token;
    const response = await fetchImpl(token.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken })
    });
    if (!response.ok) return token;
    const body = await response.json();
    return tokenStore.saveToken(serverUrl, {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || token.refreshToken,
      expiresAt: expiresAtFrom(now, body),
      tokenType: body.token_type || "Bearer",
      tokenEndpoint: token.tokenEndpoint
    });
  }

  async function authorizationHeadersForServer(record = {}) {
    const serverUrl = serverUrlFrom(record);
    if (!serverUrl) return {};
    let token = await tokenStore.getToken(serverUrl);
    if (!token) return {};
    if (token.expiresAt && token.expiresAt <= now() + 60000) token = await refreshToken(serverUrl, token);
    if (!token?.accessToken) return {};
    return { Authorization: `${token.tokenType || "Bearer"} ${token.accessToken}` };
  }

  async function checkStatus(input = {}) {
    return tokenStore.publicStatus(serverUrlFrom(input));
  }

  async function logout(input = {}) {
    const serverUrl = serverUrlFrom(input);
    await tokenStore.deleteToken(serverUrl);
    return { authenticated: false };
  }

  async function login(input = {}) {
    const serverUrl = serverUrlFrom(input);
    if (!serverUrl) throw new Error("serverUrl is required for MCP OAuth login.");
    const auth = input.authorizationEndpoint || input.authorizationUrl;
    const tokenEndpoint = input.tokenEndpoint || "";
    if (!auth || !tokenEndpoint) throw new Error("OAuth authorizationEndpoint and tokenEndpoint are required until discovery is wired.");
    const pkce = pkcePair();
    const redirectUri = String(input.redirectUri || "http://127.0.0.1/callback");
    const state = base64Url(crypto.randomBytes(16));
    const loginUrl = new URL(auth);
    loginUrl.searchParams.set("response_type", "code");
    loginUrl.searchParams.set("client_id", input.clientId || "mia");
    loginUrl.searchParams.set("redirect_uri", redirectUri);
    loginUrl.searchParams.set("code_challenge", pkce.challenge);
    loginUrl.searchParams.set("code_challenge_method", pkce.method);
    loginUrl.searchParams.set("state", state);
    await openExternal(loginUrl.toString());
    return { loginUrl: loginUrl.toString(), state, tokenEndpoint, verifier: pkce.verifier };
  }

  return { authorizationHeadersForServer, checkStatus, login, logout, refreshToken };
}

module.exports = { createCoreMcpOAuthService, pkcePair };
```

This first pass intentionally supports explicit endpoints plus token refresh. The next step can add `.well-known` discovery without changing the public API.

- [ ] **Step 5: Wire OAuth into Core service and connection tester**

In `src/core/mcp/service.js`, when no `deps.oauthService` is supplied, construct:

```js
const { createCoreMcpOAuthTokenStore } = require("./oauth-token-store.js");
const { createCoreMcpOAuthService } = require("./oauth-service.js");
const tokenStore = deps.oauthTokenStore || createCoreMcpOAuthTokenStore({ runtimePaths, fs: deps.fs, now });
const oauthService = deps.oauthService || createCoreMcpOAuthService({
  tokenStore,
  fetch: deps.fetch,
  openExternal: deps.openExternal,
  now
});
```

Pass `oauthService` into `createCoreMcpConnectionTester` and `createMcpSdkClientManager` construction wherever the service creates those dependencies.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/core-mcp-oauth-service.test.js tests/core-mcp-connection-test.test.js tests/core-mcp-service.test.js tests/mcp-sdk-client.test.js
node --check src/core/mcp/oauth-token-store.js
node --check src/core/mcp/oauth-service.js
node --check src/core/mcp/service.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/mcp/oauth-token-store.js src/core/mcp/oauth-service.js src/core/mcp/service.js src/core/mcp/connection-test.js tests/core-mcp-oauth-service.test.js tests/core-mcp-connection-test.test.js tests/core-mcp-service.test.js tests/mcp-sdk-client.test.js
git commit -m "feat(core-mcp): add oauth token lifecycle"
```

---

### Task 5: External Agent Config Discovery

**Files:**
- Create: `src/core/mcp/agent-configs.js`
- Modify: `src/core/mcp/service.js`
- Test: `tests/core-mcp-agent-configs.test.js`
- Modify: `tests/core-mcp-service.test.js`

**Interfaces:**
- Produces: `createCoreMcpAgentConfigService({ runner, runtimePaths, fs, processEnvStrings })`
- Produces: `getAgentConfigs() -> [{ source, installed, servers, error }]`
- Produces: `importAgentConfig({ sourceAgent, serverName }) -> { imported, server }`
- Produces parser exports for tests: `parseClaudeMcpList`, `parseCodexMcpListJson`, `parseHermesConfigYaml`, `parseOpenClawMcpListJson`.

- [ ] **Step 1: Write failing discovery tests**

Create `tests/core-mcp-agent-configs.test.js`:

```js
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

test("parses Claude MCP list output", () => {
  const servers = parseClaudeMcpList("xhs: npx -y xhs-mcp - ✓ Connected\nplugin:skip: node skip.js - ✓ Connected\nbroken: node bad.js - ✗ Failed");
  assert.equal(servers[0].name, "xhs");
  assert.equal(servers[0].importable, true);
  assert.equal(servers[1].importable, false);
  assert.equal(servers[2].importSkipReason, "Failed");
});

test("parses Codex MCP JSON output", () => {
  const servers = parseCodexMcpListJson(JSON.stringify([
    { name: "pw", enabled: true, transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"], env: { A: "B" } } },
    { name: "remote", enabled: false, transport: { type: "http", url: "https://example.com/mcp" } }
  ]));
  assert.deepEqual(servers.map((item) => [item.name, item.importable]), [["pw", true], ["remote", false]]);
});

test("parses Hermes config yaml mcp_servers", () => {
  const servers = parseHermesConfigYaml("mcp_servers:\n  xhs:\n    url: http://127.0.0.1:18060/mcp\n  pw:\n    command: npx\n    args:\n      - -y\n      - '@playwright/mcp'\n");
  assert.deepEqual(servers.map((item) => item.name), ["xhs", "pw"]);
  assert.equal(servers[0].transport.type, "http");
  assert.equal(servers[1].transport.command, "npx");
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
      if (command === "openclaw") return { ok: false, stdout: "", stderr: "unsupported" };
      return { ok: false, stdout: "", stderr: "" };
    }
  });

  const sources = await service.getAgentConfigs();

  assert.deepEqual(sources.map((source) => source.source), ["claude-code", "codex", "openclaw", "hermes"]);
  assert.equal(sources.find((source) => source.source === "hermes").servers[0].name, "xhs");
  assert.equal(sources.find((source) => source.source === "openclaw").installed, false);
  assert.ok(commands.some(([command]) => command === "claude"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/core-mcp-agent-configs.test.js
```

Expected: FAIL with missing module.

- [ ] **Step 3: Implement `src/core/mcp/agent-configs.js`**

Create:

```js
"use strict";

const yaml = require("js-yaml");
const fsDefault = require("node:fs");
const path = require("node:path");
const { normalizeTransport, sanitizeSecretText } = require("./records.js");

function detected(source, name, transport, importable = true, importSkipReason = "") {
  return { source, name, transport, importable, importSkipReason };
}

function normalizeDetected(source, name, transportInput, importable = true, importSkipReason = "") {
  const transport = normalizeTransport(transportInput);
  if (!name || !transport) return null;
  return detected(source, name, transport, importable, importSkipReason);
}

function parseClaudeMcpList(output = "") {
  return String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const splitAt = line.lastIndexOf(" - ");
    if (splitAt < 0) return null;
    const left = line.slice(0, splitAt);
    const status = line.slice(splitAt + 3).replace(/^[✓✗!:\s-]+/, "").trim();
    const nameSep = left.indexOf(": ");
    if (nameSep < 0) return null;
    const name = left.slice(0, nameSep).trim();
    const commandOrUrl = left.slice(nameSep + 2).replace(/\s+\((HTTP|SSE)\)$/i, "").trim();
    const isUrl = /^https?:\/\//i.test(commandOrUrl);
    const transport = isUrl
      ? { type: commandOrUrl.endsWith("/sse") ? "sse" : "http", url: commandOrUrl }
      : { type: "stdio", command: commandOrUrl, args: [] };
    const pluginManaged = name.startsWith("plugin:");
    const connected = /^connected$/i.test(status);
    return normalizeDetected("claude-code", name, transport, connected && !pluginManaged, pluginManaged ? "Plugin-managed MCP" : connected ? "" : status);
  }).filter(Boolean);
}

function codexEnv(transport = {}) {
  if (transport.env && typeof transport.env === "object" && !Array.isArray(transport.env)) return transport.env;
  if (Array.isArray(transport.env_vars)) {
    return Object.fromEntries(transport.env_vars.map((entry) => [entry.name, entry.value]).filter(([name]) => name));
  }
  return {};
}

function parseCodexMcpListJson(output = "") {
  const entries = String(output || "").trim() ? JSON.parse(output) : [];
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const transport = entry.transport || {};
    const type = transport.type || (transport.url ? "http" : "stdio");
    const transportInput = type === "stdio"
      ? { type: "stdio", command: transport.command, args: transport.args || [], env: codexEnv(transport) }
      : { type, url: transport.url, headers: transport.headers || {} };
    const enabled = entry.enabled !== false;
    return normalizeDetected("codex", entry.name, transportInput, enabled, enabled ? "" : "Disabled");
  }).filter(Boolean);
}

function parseOpenClawMcpListJson(output = "") { return parseCodexMcpListJson(output).map((item) => ({ ...item, source: "openclaw" })); }

function parseHermesConfigYaml(content = "") {
  const parsed = yaml.load(String(content || "")) || {};
  const servers = parsed.mcp_servers && typeof parsed.mcp_servers === "object" ? parsed.mcp_servers : {};
  return Object.entries(servers).map(([name, spec]) => {
    const transportInput = spec.command
      ? { type: "stdio", command: spec.command, args: spec.args || [], env: spec.env || {} }
      : { type: spec.type || "http", url: spec.url, headers: spec.headers || {}, bearerTokenEnvVar: spec.bearer_token_env_var || spec.bearerTokenEnvVar || "" };
    return normalizeDetected("hermes", name, transportInput, true, "");
  }).filter(Boolean);
}

function defaultRunner(command, args = [], options = {}) {
  const { spawn } = require("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: options.env || process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve({ ok: false, stdout, stderr: `${stderr}\nTimed out` }); }, options.timeoutMs || 30000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr, code }); });
  });
}

function createCoreMcpAgentConfigService(deps = {}) {
  const fs = deps.fs || fsDefault;
  const runtimePaths = deps.runtimePaths || (() => ({}));
  const runner = deps.runner || defaultRunner;

  async function claudeConfigs() {
    const result = await runner("claude", ["mcp", "list"], { timeoutMs: 30000 });
    return { source: "claude-code", installed: result.ok, servers: result.ok ? parseClaudeMcpList(result.stdout) : [], error: result.ok ? "" : sanitizeSecretText(result.stderr) };
  }

  async function codexConfigs() {
    const result = await runner("codex", ["mcp", "list", "--json"], { timeoutMs: 30000 });
    return { source: "codex", installed: result.ok, servers: result.ok ? parseCodexMcpListJson(result.stdout) : [], error: result.ok ? "" : sanitizeSecretText(result.stderr) };
  }

  async function openclawConfigs() {
    const result = await runner("openclaw", ["mcp", "list", "--json"], { timeoutMs: 30000 });
    return { source: "openclaw", installed: result.ok, servers: result.ok ? parseOpenClawMcpListJson(result.stdout) : [], error: result.ok ? "" : sanitizeSecretText(result.stderr || "OpenClaw MCP list is not available.") };
  }

  async function hermesConfigs() {
    const configPath = path.join(runtimePaths().hermesHome || "", "config.yaml");
    let content = "";
    try { content = fs.readFileSync(configPath, "utf8"); } catch {}
    return { source: "hermes", installed: Boolean(content), servers: content ? parseHermesConfigYaml(content) : [], error: "" };
  }

  async function getAgentConfigs() {
    return Promise.all([claudeConfigs(), codexConfigs(), openclawConfigs(), hermesConfigs()]);
  }

  async function importAgentConfig(input = {}) {
    const sources = await getAgentConfigs();
    const source = sources.find((item) => item.source === input.sourceAgent);
    const server = source?.servers?.find((item) => item.name === input.serverName);
    if (!server) throw new Error("Discovered MCP server not found.");
    if (!server.importable) throw new Error(server.importSkipReason || "Discovered MCP server is not importable.");
    return { imported: 1, server };
  }

  return { getAgentConfigs, importAgentConfig };
}

module.exports = { createCoreMcpAgentConfigService, parseClaudeMcpList, parseCodexMcpListJson, parseHermesConfigYaml, parseOpenClawMcpListJson };
```

- [ ] **Step 4: Wire service default dependency**

In `src/core/mcp/service.js`, create the default discovery service:

```js
const { createCoreMcpAgentConfigService } = require("./agent-configs.js");
const agentConfigService = deps.agentConfigService || createCoreMcpAgentConfigService({
  runtimePaths,
  fs: deps.fs,
  runner: deps.agentConfigRunner,
  processEnvStrings: deps.processEnvStrings
});
```

Update `importAgentConfig` so it calls `agentConfigService.importAgentConfig`, then upserts the returned server into the Core registry:

```js
async function importAgentConfig(input) {
  try {
    const result = await agentConfigService.importAgentConfig(input);
    const server = result.server;
    const saved = await save({
      name: server.name,
      enabled: false,
      source: "agent-config",
      sourceAgent: input.sourceAgent,
      transport: server.transport
    });
    return ok({ imported: 1, server: saved.data });
  } catch (error) {
    return fail(error);
  }
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test tests/core-mcp-agent-configs.test.js tests/core-mcp-service.test.js
node --check src/core/mcp/agent-configs.js
node --check src/core/mcp/service.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/mcp/agent-configs.js src/core/mcp/service.js tests/core-mcp-agent-configs.test.js tests/core-mcp-service.test.js
git commit -m "feat(core-mcp): discover external agent mcp configs"
```

---

### Task 6: Core Wiring, IPC, And Preload Surface

**Files:**
- Modify: `src/core/mia-core.js`
- Modify: `src/shared/ipc-channels.js`
- Modify: `src/main/ipc/mcp-ipc.js`
- Modify: `src/preload.js`
- Modify: `tests/mcp-ipc-preload.test.js`
- Modify: `tests/mia-core-engines.test.js`

**Interfaces:**
- Consumes: `createCoreMcpService`
- Produces preload APIs:
  - `window.mia.mcp.listTools()`
  - `window.mia.mcp.getAgentConfigs()`
  - `window.mia.mcp.importAgentConfig(input)`
  - `window.mia.mcp.oauth.checkStatus(input)`
  - `window.mia.mcp.oauth.login(input)`
  - `window.mia.mcp.oauth.logout(input)`

- [ ] **Step 1: Write failing IPC/preload assertions**

In `tests/mcp-ipc-preload.test.js`, add source assertions:

```js
test("mcp ipc registers Core AION alignment methods", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "ipc", "mcp-ipc.js"), "utf8");
  assert.match(src, /McpListTools/);
  assert.match(src, /McpAgentConfigs/);
  assert.match(src, /McpImportAgentConfig/);
  assert.match(src, /McpOauthCheckStatus/);
  assert.match(src, /McpOauthLogin/);
  assert.match(src, /McpOauthLogout/);
});

test("preload exposes oauth and discovery methods", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  assert.match(src, /listTools:\s*\(\)\s*=>/);
  assert.match(src, /getAgentConfigs:\s*\(\)\s*=>/);
  assert.match(src, /importAgentConfig:\s*\(input\)\s*=>/);
  assert.match(src, /oauth:\s*\{/);
  assert.match(src, /checkStatus:\s*\(input\)\s*=>/);
  assert.match(src, /login:\s*\(input\)\s*=>/);
  assert.match(src, /logout:\s*\(input\)\s*=>/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/mcp-ipc-preload.test.js
```

Expected: FAIL because new channels are missing.

- [ ] **Step 3: Add channel constants**

In `src/shared/ipc-channels.js`, add next to existing MCP channels:

```js
McpListTools: "mcp:list-tools",
McpAgentConfigs: "mcp:agent-configs",
McpImportAgentConfig: "mcp:import-agent-config",
McpOauthCheckStatus: "mcp:oauth:check-status",
McpOauthLogin: "mcp:oauth:login",
McpOauthLogout: "mcp:oauth:logout",
```

- [ ] **Step 4: Register handlers**

In `src/main/ipc/mcp-ipc.js`, add:

```js
ipcMain.handle(IpcChannel.McpListTools, () => mcpService.listTools());
ipcMain.handle(IpcChannel.McpAgentConfigs, () => mcpService.getAgentConfigs());
ipcMain.handle(IpcChannel.McpImportAgentConfig, (_event, input) => mcpService.importAgentConfig(input || {}));
ipcMain.handle(IpcChannel.McpOauthCheckStatus, (_event, input) => mcpService.oauth.checkStatus(input || {}));
ipcMain.handle(IpcChannel.McpOauthLogin, (_event, input) => mcpService.oauth.login(input || {}));
ipcMain.handle(IpcChannel.McpOauthLogout, (_event, input) => mcpService.oauth.logout(input || {}));
```

- [ ] **Step 5: Expose preload methods**

In `src/preload.js`, extend `mcp`:

```js
listTools: () => ipcRenderer.invoke(IpcChannel.McpListTools),
getAgentConfigs: () => ipcRenderer.invoke(IpcChannel.McpAgentConfigs),
importAgentConfig: (input) => ipcRenderer.invoke(IpcChannel.McpImportAgentConfig, input),
oauth: {
  checkStatus: (input) => ipcRenderer.invoke(IpcChannel.McpOauthCheckStatus, input),
  login: (input) => ipcRenderer.invoke(IpcChannel.McpOauthLogin, input),
  logout: (input) => ipcRenderer.invoke(IpcChannel.McpOauthLogout, input)
}
```

- [ ] **Step 6: Ensure Mia Core constructs the Core MCP service**

In `src/core/mia-core.js`, replace the `createMcpService` import with:

```js
const { createCoreMcpService } = require("./mcp/service.js");
```

Then replace:

```js
const userMcpService = createMcpService({
```

with:

```js
const userMcpService = createCoreMcpService({
```

Pass these additional deps:

```js
fetch: fetchImpl,
processEnvStrings,
openExternal: async () => {},
agentConfigRunner: async (command, args, options = {}) => localAgentEngineService.runCommand
  ? localAgentEngineService.runCommand(command, args, options)
  : { ok: false, stdout: "", stderr: "Core command runner is not available." }
```

If `localAgentEngineService` has no generic runner, omit `agentConfigRunner`; the discovery service will use its default `spawn` runner.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test tests/mcp-ipc-preload.test.js tests/mia-core-engines.test.js
node --check src/core/mia-core.js
node --check src/shared/ipc-channels.js
node --check src/main/ipc/mcp-ipc.js
node --check src/preload.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/mia-core.js src/shared/ipc-channels.js src/main/ipc/mcp-ipc.js src/preload.js tests/mcp-ipc-preload.test.js tests/mia-core-engines.test.js
git commit -m "feat(core-mcp): expose core mcp ipc surface"
```

---

### Task 7: Engine Injection And Stale Session Protection

**Files:**
- Modify: `src/main/mcp/mcp-engine-sync.js`
- Modify: `src/core/mcp/service.js`
- Modify: `tests/mcp-engine-sync.test.js`
- Modify: `tests/claude-code-chat-adapter.test.js`
- Modify: `tests/codex-chat-adapter.test.js`
- Modify: `tests/openclaw-chat-adapter.test.js`
- Modify: `tests/engine-runtime-config-service.test.js`

**Interfaces:**
- Consumes: `service.getEngineSpecs(engineId, capabilities?)`
- Produces: status collector entries for unsupported transport/bridge-required cases.
- Preserves: `mcp.fingerprint()` in session reuse keys.

- [ ] **Step 1: Add engine sync tests for deleted records and OAuth headers**

In `tests/mcp-engine-sync.test.js`, add:

```js
test("engine specs ignore soft-deleted records", () => {
  const records = [
    { name: "active", enabled: true, transport: { type: "stdio", command: "npx", args: [] } },
    { name: "deleted", enabled: true, deletedAt: 171, transport: { type: "stdio", command: "node", args: [] } }
  ];
  const specs = mcpSpecsForClaudeSdk(records);
  assert.deepEqual(Object.keys(specs), ["active"]);
});

test("codex reports bridge-required status for http headers without bridge", () => {
  const statuses = [];
  const specs = mcpSpecsForCodex([
    { name: "remote", enabled: true, transport: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer token" } } }
  ], { statusCollector: statuses });

  assert.deepEqual(specs, {});
  assert.equal(statuses[0].reason, "bridge_required_for_http_headers");
});
```

- [ ] **Step 2: Run tests to verify they fail if deleted records leak**

Run:

```bash
node --test tests/mcp-engine-sync.test.js
```

Expected: FAIL if `mcp-engine-sync.js` still treats deleted records as enabled.

- [ ] **Step 3: Update engine sync enabled predicate**

In `src/main/mcp/mcp-engine-sync.js`, change:

```js
return (Array.isArray(records) ? records : []).filter((record) => record?.enabled !== false);
```

to:

```js
return (Array.isArray(records) ? records : []).filter((record) => record?.enabled !== false && !record?.deletedAt);
```

- [ ] **Step 4: Ensure Core service status collectors update sync states**

In `src/core/mcp/service.js`, inside `getEngineSpecs`, pass a `statusCollector` array to conversion helpers when none is provided:

```js
const statusCollector = Array.isArray(options.statusCollector) ? options.statusCollector : [];
const conversionOptions = { bridge: bridgeSpec, ...options, statusCollector };
```

When `statusCollector` receives entries, update record `sync[engineId]` on the next explicit `sync()` or `refreshBridge()` call. Do not write sync state during every `getEngineSpecs()` call; that method is called during chat turns and should not mutate files.

- [ ] **Step 5: Verify adapter session fingerprint tests still cover MCP**

Run:

```bash
node --test tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js tests/engine-runtime-config-service.test.js
```

Expected: PASS. Existing tests should still prove user MCP specs are merged with reserved built-ins and fingerprints are included in session reuse.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/mcp-engine-sync.js src/core/mcp/service.js tests/mcp-engine-sync.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js tests/engine-runtime-config-service.test.js
git commit -m "fix(core-mcp): prevent stale deleted mcp injection"
```

---

### Task 8: Renderer Diagnostics, OAuth, And Discovery UI

**Files:**
- Modify: `src/renderer/mcp/mcp-library.js`
- Modify: `src/renderer/styles/mcp.css`
- Modify: `tests/renderer-mcp-library.test.js`

**Interfaces:**
- Consumes: `window.mia.mcp.getAgentConfigs()`
- Consumes: `window.mia.mcp.importAgentConfig(input)`
- Consumes: `window.mia.mcp.oauth.checkStatus/login/logout(input)`
- Shows: structured `lastTestStatus`, `lastError`, `diagnostics.code`, OAuth authenticated state, discovered external configs.

- [ ] **Step 1: Add renderer source tests**

In `tests/renderer-mcp-library.test.js`, add:

```js
test("mcp renderer includes diagnostics oauth and discovery actions", () => {
  const src = read("src/renderer/mcp/mcp-library.js");
  assert.match(src, /getAgentConfigs/);
  assert.match(src, /importAgentConfig/);
  assert.match(src, /oauth\.login/);
  assert.match(src, /oauth\.logout/);
  assert.match(src, /data-mcp-action="oauth-login"/);
  assert.match(src, /data-mcp-action="oauth-logout"/);
  assert.match(src, /data-mcp-action="import-agent-config"/);
  assert.match(src, /lastTestStatus|diagnostics|lastError/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/renderer-mcp-library.test.js
```

Expected: FAIL because UI actions are missing.

- [ ] **Step 3: Extend renderer MCP state**

In `mcpState()`, add defaults:

```js
agentConfigs: [],
agentConfigsLoaded: false,
agentConfigsError: "",
oauthBusyId: ""
```

In `loadMcpServers`, fetch discovery in parallel:

```js
const [listResult, marketResult, agentConfigsResult] = await Promise.all([
  window.mia.mcp.list(),
  typeof window.mia.mcp.fetchMarketplace === "function" ? window.mia.mcp.fetchMarketplace() : Promise.resolve({ success: true, data: { templates: [] } }),
  typeof window.mia.mcp.getAgentConfigs === "function" ? window.mia.mcp.getAgentConfigs() : Promise.resolve({ success: true, data: { sources: [] } })
]);
```

Store:

```js
mcp.agentConfigs = Array.isArray(agentConfigsResult.data?.sources) ? agentConfigsResult.data.sources : [];
mcp.agentConfigsError = agentConfigsResult.success ? "" : String(agentConfigsResult.error || "MCP 外部配置加载失败");
```

- [ ] **Step 4: Render diagnostics on installed cards**

Add helper:

```js
function diagnosticHtml(server = {}) {
  const code = server.diagnostics?.code || server.lastTestCode || "";
  const error = server.lastError || server.diagnostics?.message || "";
  if (!code && !error) return "";
  return `<p class="mcp-diagnostic">${escapeHtml([code, error].filter(Boolean).join(" · "))}</p>`;
}
```

Call it from the installed card HTML below the transport summary.

- [ ] **Step 5: Render OAuth actions**

Add helper:

```js
function oauthActionHtml(server = {}) {
  if (server.lastTestStatus !== "auth_required" && !server.oauth?.authenticated) return "";
  const label = server.oauth?.authenticated ? "退出登录" : "登录";
  const action = server.oauth?.authenticated ? "oauth-logout" : "oauth-login";
  return `<button type="button" data-mcp-action="${action}" data-mcp-id="${escapeHtml(server.id)}">${label}</button>`;
}
```

Add it to the card actions.

- [ ] **Step 6: Render discovery import list**

In the custom tab, render agent configs before the raw JSON import control:

```js
function renderAgentConfigSources(mcp) {
  const rows = (mcp.agentConfigs || []).flatMap((source) => (source.servers || []).map((server) => ({ source, server })));
  if (!rows.length) return `<p class="mcp-empty">没有发现外部 Agent MCP 配置</p>`;
  return rows.map(({ source, server }) => `
    <article class="mcp-discovery-row">
      <strong>${escapeHtml(source.source)} / ${escapeHtml(server.name)}</strong>
      <span>${escapeHtml(server.transport?.type || "")}</span>
      <button type="button" data-mcp-action="import-agent-config" data-mcp-source="${escapeHtml(source.source)}" data-mcp-name="${escapeHtml(server.name)}" ${server.importable === false ? "disabled" : ""}>导入</button>
      ${server.importSkipReason ? `<small>${escapeHtml(server.importSkipReason)}</small>` : ""}
    </article>
  `).join("");
}
```

- [ ] **Step 7: Handle new actions**

In `handleMcpAction`, add:

```js
if (action === "oauth-login") return handleMcpOauth(id, "login");
if (action === "oauth-logout") return handleMcpOauth(id, "logout");
if (action === "import-agent-config") return handleImportAgentConfig(button.dataset.mcpSource, button.dataset.mcpName);
```

Implement:

```js
async function handleMcpOauth(id, mode) {
  const server = mcpState().servers.find((item) => item.id === id);
  if (!server) return;
  const fn = mode === "logout" ? window.mia.mcp.oauth?.logout : window.mia.mcp.oauth?.login;
  if (typeof fn !== "function") return alertText("MCP OAuth 暂不可用");
  const result = await fn({ serverId: server.id, serverUrl: server.transport?.url });
  if (!result?.success) return alertText(result?.error || "MCP OAuth 操作失败");
  await loadMcpServers({ force: true });
}

async function handleImportAgentConfig(sourceAgent, serverName) {
  const result = await window.mia.mcp.importAgentConfig({ sourceAgent, serverName });
  if (!result?.success) return alertText(result?.error || "导入外部 MCP 配置失败");
  await loadMcpServers({ force: true });
}
```

- [ ] **Step 8: Add styles**

Append to `src/renderer/styles/mcp.css`:

```css
.mcp-diagnostic {
  margin: 6px 0 0;
  color: var(--danger, #b42318);
  font-size: 12px;
  line-height: 1.35;
}

.mcp-discovery-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.mcp-discovery-row small {
  grid-column: 1 / -1;
  color: var(--muted);
}
```

- [ ] **Step 9: Run focused tests**

Run:

```bash
node --test tests/renderer-mcp-library.test.js
node --check src/renderer/mcp/mcp-library.js
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/mcp/mcp-library.js src/renderer/styles/mcp.css tests/renderer-mcp-library.test.js
git commit -m "feat(mcp): show diagnostics oauth and discovery"
```

---

### Task 9: End-To-End Verification And Documentation Update

**Files:**
- Modify: `docs/superpowers/specs/2026-06-18-custom-mcp-management-design.md`
- Modify: `docs/superpowers/specs/2026-06-25-mia-core-mcp-aion-alignment-design.md` if implementation changes the final contract.
- Test: focused MCP/Core/engine tests.

**Interfaces:**
- Verifies all public Core MCP methods.
- Verifies old IPC names remain compatible.
- Verifies no raw secrets leak in output files or test logs.

- [ ] **Step 1: Run the complete focused test set**

Run:

```bash
node --test \
  tests/core-mcp-records.test.js \
  tests/core-mcp-file-registry.test.js \
  tests/core-mcp-service.test.js \
  tests/core-mcp-connection-test.test.js \
  tests/core-mcp-oauth-service.test.js \
  tests/core-mcp-agent-configs.test.js \
  tests/mcp-records.test.js \
  tests/mcp-service.test.js \
  tests/mcp-sdk-client.test.js \
  tests/mcp-bridge-server.test.js \
  tests/mcp-engine-sync.test.js \
  tests/mcp-ipc-preload.test.js \
  tests/startup-mcp-initializer.test.js \
  tests/renderer-mcp-library.test.js \
  tests/claude-code-chat-adapter.test.js \
  tests/codex-chat-adapter.test.js \
  tests/openclaw-chat-adapter.test.js \
  tests/engine-runtime-config-service.test.js \
  tests/mia-core-engines.test.js
```

Expected: PASS.

- [ ] **Step 2: Run syntax checks**

Run:

```bash
node --check src/core/mcp/records.js
node --check src/core/mcp/file-registry.js
node --check src/core/mcp/service.js
node --check src/core/mcp/connection-test.js
node --check src/core/mcp/oauth-token-store.js
node --check src/core/mcp/oauth-service.js
node --check src/core/mcp/agent-configs.js
node --check src/main/mcp/mcp-records.js
node --check src/main/mcp/mcp-service.js
node --check src/main/mcp/mcp-sdk-client.js
node --check src/main/ipc/mcp-ipc.js
node --check src/preload.js
node --check src/renderer/mcp/mcp-library.js
```

Expected: no output and exit 0.

- [ ] **Step 3: Search for secret leaks in new code paths**

Run:

```bash
rg -n "accessToken|refreshToken|Authorization|Bearer" src/core/mcp src/main/mcp src/renderer/mcp tests/core-mcp-*.test.js tests/mcp-*.test.js
```

Expected:
- Matches in token store internals and tests are allowed.
- Renderer files must not contain code that renders `accessToken` or `refreshToken`.
- Public record projection tests must assert redaction.

- [ ] **Step 4: Update older custom MCP design to point at Core-first spec**

Add this banner under the title of `docs/superpowers/specs/2026-06-18-custom-mcp-management-design.md`:

```markdown
> Superseded for architecture by `docs/superpowers/specs/2026-06-25-mia-core-mcp-aion-alignment-design.md`.
> This document remains useful for product UI language and initial MCP bridge behavior, but Core-owned MCP is the shipping target.
```

- [ ] **Step 5: Manual smoke with temp Mia home**

Run:

```bash
MIA_HOME="$(mktemp -d)" node src/core/mia-core.js --daemon
```

In another shell, use the control API or Electron UI to:

```text
1. Add Playwright MCP from the marketplace template.
2. Run MCP test; expected status: connected and at least one tool listed.
3. Enable the server.
4. Run a Hermes or Claude Code turn that asks which MCP tools are available.
5. Disable the server.
6. Run the next turn and verify the disabled server is absent after fingerprint invalidation.
```

Expected:
- `mia-mcp-servers.json` exists only under the temp `MIA_HOME`.
- OAuth tokens, if any, exist only under `runtime/mcp-oauth-tokens.json`.
- Disabled or deleted servers are not present in engine specs.

- [ ] **Step 6: Commit docs and any verification fixes**

```bash
git add docs/superpowers/specs/2026-06-18-custom-mcp-management-design.md docs/superpowers/specs/2026-06-25-mia-core-mcp-aion-alignment-design.md
git commit -m "docs(mcp): mark core-owned mcp as shipping target"
```

If no docs changed beyond the banner, commit only the banner. If verification required code fixes, commit those fixes separately before this docs commit.

---

## Execution Order

Run tasks in order. Task 1 and Task 2 establish Core ownership without changing user-visible behavior. Task 3 makes failures diagnosable. Task 4 enables OAuth-protected HTTP MCP. Task 5 adds AION-style external config discovery. Task 6 exposes the Core API to Electron. Task 7 prevents stale/deleted MCP servers from leaking into agent sessions. Task 8 updates the UI. Task 9 proves the full A+B+C slice.

## Self-Review

- Spec coverage: A basic usability is covered by Tasks 1, 2, 3, 6, 7, 8, and 9. B configuration/diagnostics/discovery is covered by Tasks 1, 2, 3, 5, and 7. C OAuth is covered by Task 4 and surfaced in Tasks 6 and 8.
- Team MCP is explicitly excluded and has no implementation task.
- Type consistency: public service methods use `listTools`, `getAgentConfigs`, `importAgentConfig`, and `oauth.checkStatus/login/logout` consistently across Core service, IPC, preload, and renderer.
- Completeness scan: no task contains TBD/TODO/fill-in implementation steps, and parser/service steps either provide concrete code or an exact copy-and-edit source.
