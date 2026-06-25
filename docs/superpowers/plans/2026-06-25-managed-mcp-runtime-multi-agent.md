# Managed MCP Runtime Multi-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mia's built-in MCP marketplace behave like mature AION/Lobster-style managed MCP: users connect from the app, Mia starts/tests/syncs supported servers, and enabled MCP is exposed to Hermes, Claude Code, Codex, and OpenClaw.

**Architecture:** Keep Mia Core as the MCP owner and split the work into catalog, records, wizard, managed runtime supervision, bridge refresh, IPC, renderer, and agent exposure. AION is the reference for Core-owned MCP records, Tools settings connect/test/toggle flows, OAuth-style status actions, and ACP session injection after filtering. LobsterAI is the reference for a small built-in registry, SDK transport startup, tool discovery, loopback bridge callbacks, and refreshing the OpenClaw plugin config after server changes.

**Tech Stack:** Node.js CommonJS, Electron main/preload IPC, existing Mia Core runtime paths, `node:test`, `@modelcontextprotocol/sdk`, built-in `child_process`, built-in `fs`, built-in `path`, built-in `http`, existing MCP bridge and engine-sync modules.

## Global Constraints

- Built-in marketplace supports only `native` and `managed` modes.
- No `external_assisted`, `external-assisted`, or "Mia only connects to a service you started yourself" built-in category is allowed.
- Unsupported or partially compatible MCP servers stay out of the built-in marketplace and can only be added through custom MCP.
- First built-in catalog includes exactly `xiaohongshu`, `playwright`, `context7`, `github`, `tavily`, and `firecrawl`.
- Deferred LobsterAI built-ins are not shown in the marketplace: Notion, Slack, Gmail, Google Drive, Google Calendar, Todoist, Canva, and GitLab.
- Marketplace connection is no-command by default: card -> required fields or managed action -> detect/test -> enable.
- Raw commands may appear only under an advanced diagnostics block.
- `xiaohongshu` is a managed connector: Mia locates or installs the local runtime, guides login, starts/stops the service, health-checks the endpoint, tests expected tools, and exposes it to all four agents after success.
- `playwright`, `context7`, `github`, `tavily`, and `firecrawl` are native stdio templates.
- `github` requires `GITHUB_PERSONAL_ACCESS_TOKEN`.
- `tavily` requires `TAVILY_API_KEY`.
- `firecrawl` requires `FIRECRAWL_API_KEY`.
- Global enabled MCP is exposed to Hermes, Claude Code, Codex, and OpenClaw.
- Conversation/session state saves an MCP snapshot; the MCP fingerprint participates in session reuse; disable/delete/change recreates stale sessions before the next prompt.
- Secrets are never exposed through renderer APIs, logs, diagnostics, public record projections, or bridge errors.
- Connection setup failures never crash Core startup and never block unrelated chats.
- Tests use temp runtime directories and fake child processes; tests do not write real user agent config files and do not run real `git`, `go`, or `npx`.

---

## Reference Baselines

- AION `ToolsModalContent.tsx`: add/import/test/toggle, OAuth login-style actions, one-key import, and built-in image-generation env sync.
- AION `/api/mcp/servers`, `/api/mcp/test-connection`, `/api/mcp/agent-configs`, `/api/mcp/oauth/*`: Core-owned server records with renderer as a client.
- AION `AgentRegistry` and `factory/acp.rs`: load enabled user MCP into ACP `session/new` after capability filtering.
- LobsterAI `src/renderer/data/mcpRegistry.ts`: curated built-in registry with commands/env fields kept in product-owned definitions.
- LobsterAI `src/main/libs/mcpServerManager.ts`: start enabled MCP servers through SDK transports, discover tools, and route tool calls.
- LobsterAI `src/main/main.ts` `startMcpBridge`: start enabled servers, start a loopback callback server, write bridge config, refresh/restart OpenClaw.

## File Structure

- Create `src/core/mcp/catalog.js`
  - Owns the first built-in MCP catalog, catalog lookup, required-input descriptors, and materializing records from built-in templates.

- Modify `src/core/mcp/records.js`
  - Normalize `managementMode`, `requiredInputs`, `connectionWizard`, and `managedRuntime`.
  - Redact required-input values, diagnostics, managed paths, and secrets in public projections.
  - Include management mode and transport in fingerprints for enabled records.

- Create `src/core/mcp/managed-connectors/xiaohongshu.js`
  - Defines the xiaohongshu managed connector contract: install directory, endpoint, install/login/start/stop/status actions, and expected tool count.

- Create `src/core/mcp/managed-connector-supervisor.js`
  - Process/runtime supervisor for managed MCP connectors.
  - Uses injected child process/fetch/fs dependencies for tests.
  - Starts enabled managed connectors before bridge refresh and exposes action results to service/UI.

- Modify `src/core/mcp/service.js`
  - Replace inline marketplace templates with `catalog.js`.
  - Change `installTemplate()` into app-owned connect flow: create disabled record, validate required fields, test, and enable only on success.
  - Add `runManagedAction(id, action, values)` for managed connector install/login/start/stop/test.
  - Start managed enabled records before SDK manager refresh.
  - Preserve existing custom MCP and import JSON behavior.

- Modify `src/core/mcp/engine-sync.js`
  - Keep existing bridge fallback behavior and expose structured unsupported entries consistently for Hermes, Codex, Claude Code, and OpenClaw.

- Modify `src/core/mia-core.js`
  - Construct Core MCP service with the managed supervisor and ensure all four adapters use the same service instance and fingerprint.

- Modify chat adapters and tests if the existing adapter tests show any missing fingerprint invalidation:
  - `src/main/agents/hermes-chat-adapter.js`
  - `src/main/agents/claude-code-chat-adapter.js`
  - `src/main/agents/codex-chat-adapter.js`
  - `src/main/agents/openclaw-chat-adapter.js`

- Modify `src/shared/ipc-channels.js`
  - Add `McpRunManagedAction`.

- Modify `src/main/ipc/mcp-ipc.js`
  - Register `mcp:run-managed-action`.

- Modify `src/preload.js`
  - Expose `window.mia.mcp.runManagedAction(id, action, values)`.

- Modify `src/renderer/mcp/mcp-library.js`
  - Replace one-click install with a connection wizard.
  - Render required fields, managed actions, test/enable states, per-agent exposure state, and advanced diagnostics.

- Modify `src/renderer/styles/mcp.css`
  - Style the wizard, field rows, managed action rows, exposure grid, and advanced diagnostics.

- Add tests:
  - `tests/core-mcp-catalog.test.js`
  - `tests/core-mcp-managed-connector-supervisor.test.js`
  - `tests/core-mcp-managed-service.test.js`

- Modify tests:
  - `tests/core-mcp-records.test.js`
  - `tests/core-mcp-service.test.js`
  - `tests/mcp-engine-sync.test.js`
  - `tests/mcp-ipc-preload.test.js`
  - `tests/renderer-mcp-library.test.js`
  - `tests/hermes-chat-adapter.test.js`
  - `tests/claude-code-chat-adapter.test.js`
  - `tests/codex-chat-adapter.test.js`
  - `tests/openclaw-chat-adapter.test.js`

---

### Task 1: Built-In Catalog And Record Shape

**Files:**
- Create: `src/core/mcp/catalog.js`
- Modify: `src/core/mcp/records.js`
- Test: `tests/core-mcp-catalog.test.js`
- Modify: `tests/core-mcp-records.test.js`

**Interfaces:**
- Produces: `builtinMcpTemplates() -> BuiltinMcpTemplate[]`
- Produces: `builtinMcpTemplateById(id: string) -> BuiltinMcpTemplate | null`
- Produces: `materializeBuiltinMcpRecord(template: BuiltinMcpTemplate, values: object, options: object) -> { record, missingRequiredInputs }`
- Produces record fields:
  - `managementMode: "native" | "managed" | "custom"`
  - `requiredInputs: Array<{ key, label, secret, target, required }>`
  - `connectionWizard: { state, nextAction, message, missingRequiredInputs, actions }`
  - `managedRuntime: { connectorId, endpoint, installDir, expectedToolCount, state, lastAction }`
- Consumes existing: `normalizeCoreMcpRecord(input, options)`, `publicCoreMcpRecord(record)`, `coreMcpFingerprint(records)`

- [ ] **Step 1: Write failing catalog tests**

Create `tests/core-mcp-catalog.test.js`:

```js
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
```

- [ ] **Step 2: Run the catalog test to verify it fails**

Run:

```bash
node --test tests/core-mcp-catalog.test.js
```

Expected output includes:

```text
not ok
Cannot find module '../src/core/mcp/catalog.js'
```

- [ ] **Step 3: Add the built-in catalog module**

Create `src/core/mcp/catalog.js` with this module shape:

```js
"use strict";

const { normalizeCoreMcpRecord } = require("./records.js");

const BUILTIN_MODES = Object.freeze(["native", "managed"]);

const BUILTIN_MCP_TEMPLATES = Object.freeze([
  {
    id: "xiaohongshu",
    name: "小红书 MCP",
    nativeName: "xiaohongshu",
    description: "Mia 管理的小红书本地 MCP，用于搜索、读取和发布相关小红书工作流。",
    category: "内容平台",
    managementMode: "managed",
    homepage: "https://github.com/xpzouying/xiaohongshu-mcp",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {} },
    requiredInputs: [],
    managedRuntime: {
      connectorId: "xiaohongshu",
      endpoint: "http://127.0.0.1:18060/mcp",
      installDir: "",
      expectedToolCount: 13,
      state: "not_installed",
      lastAction: ""
    },
    connectionWizard: {
      state: "needs_managed_action",
      nextAction: "install",
      message: "Mia 将安装或定位本地小红书 MCP，完成登录后启动并检测连接。",
      missingRequiredInputs: [],
      actions: [
        { id: "install", label: "安装组件" },
        { id: "login", label: "打开登录" },
        { id: "start", label: "启动服务" },
        { id: "test", label: "检测并启用" }
      ]
    }
  },
  {
    id: "playwright",
    name: "Playwright MCP",
    nativeName: "playwright",
    description: "浏览器自动化、截图、点击、输入和页面验证。",
    category: "浏览器自动化",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "@executeautomation/playwright-mcp-server"], env: {} },
    requiredInputs: []
  },
  {
    id: "context7",
    name: "Context7 MCP",
    nativeName: "context7",
    description: "为编程 Agent 提供库文档和版本化代码示例。",
    category: "开发",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], env: {} },
    requiredInputs: []
  },
  {
    id: "github",
    name: "GitHub MCP",
    nativeName: "github",
    description: "读取仓库、issue 和 pull request。",
    category: "开发",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {} },
    requiredInputs: [
      { key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub Personal Access Token", secret: true, target: "env", required: true }
    ]
  },
  {
    id: "tavily",
    name: "Tavily MCP",
    nativeName: "tavily",
    description: "联网搜索和网页检索。",
    category: "搜索",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "tavily-mcp@latest"], env: {} },
    requiredInputs: [
      { key: "TAVILY_API_KEY", label: "Tavily API Key", secret: true, target: "env", required: true }
    ]
  },
  {
    id: "firecrawl",
    name: "Firecrawl MCP",
    nativeName: "firecrawl",
    description: "网页抓取、结构化提取和站点爬取。",
    category: "网页抓取",
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "firecrawl-mcp@latest"], env: {} },
    requiredInputs: [
      { key: "FIRECRAWL_API_KEY", label: "Firecrawl API Key", secret: true, target: "env", required: true }
    ]
  }
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function builtinMcpTemplates() {
  return BUILTIN_MCP_TEMPLATES.map((template) => clone(template));
}

function builtinMcpTemplateById(id) {
  const needle = String(id || "").trim();
  const template = BUILTIN_MCP_TEMPLATES.find((item) => item.id === needle);
  return template ? clone(template) : null;
}

function inputValue(values = {}, key = "") {
  if (Object.prototype.hasOwnProperty.call(values, key)) return String(values[key] || "").trim();
  if (values.env && Object.prototype.hasOwnProperty.call(values.env, key)) return String(values.env[key] || "").trim();
  return "";
}

function materializeTransport(template, values = {}) {
  const transport = clone(template.transport || {});
  if (transport.type === "stdio") {
    transport.env = { ...(transport.env || {}) };
    for (const field of template.requiredInputs || []) {
      if (field.target === "env") transport.env[field.key] = inputValue(values, field.key);
    }
  }
  return transport;
}

function wizardForTemplate(template, missingRequiredInputs) {
  if (template.managementMode === "managed") {
    return clone(template.connectionWizard);
  }
  return {
    state: missingRequiredInputs.length ? "missing_required_inputs" : "ready_to_test",
    nextAction: missingRequiredInputs.length ? "enter_required_inputs" : "test",
    message: missingRequiredInputs.length ? "填写必填字段后，Mia 会检测连接并启用。" : "Mia 将检测连接，成功后启用到新对话。",
    missingRequiredInputs,
    actions: [{ id: "test", label: "检测并启用" }]
  };
}

function materializeBuiltinMcpRecord(template, values = {}, options = {}) {
  if (!template || !BUILTIN_MODES.includes(template.managementMode)) {
    throw new Error("Unsupported built-in MCP template.");
  }
  const requiredInputs = Array.isArray(template.requiredInputs) ? template.requiredInputs : [];
  const missingRequiredInputs = requiredInputs
    .filter((field) => field.required !== false && !inputValue(values, field.key))
    .map((field) => field.key);
  const record = normalizeCoreMcpRecord({
    id: values.id,
    name: values.name || template.name,
    nativeName: values.nativeName || template.nativeName || template.id,
    description: template.description,
    registryId: template.id,
    source: "marketplace",
    builtin: false,
    enabled: false,
    status: missingRequiredInputs.length ? "configuration_required" : "disconnected",
    managementMode: template.managementMode,
    requiredInputs,
    connectionWizard: wizardForTemplate(template, missingRequiredInputs),
    managedRuntime: template.managedRuntime || {},
    homepage: template.homepage || "",
    expectedToolCount: template.managedRuntime?.expectedToolCount || 0,
    transport: materializeTransport(template, values)
  }, options);
  if (!record) throw new Error("Built-in MCP template produced an invalid record.");
  return { record, missingRequiredInputs };
}

module.exports = {
  builtinMcpTemplates,
  builtinMcpTemplateById,
  materializeBuiltinMcpRecord
};
```

- [ ] **Step 4: Extend record normalization and redaction**

Modify `src/core/mcp/records.js` by adding helpers near the existing normalize helpers:

```js
const MCP_MANAGEMENT_MODES = new Set(["native", "managed", "custom"]);

function normalizeManagementMode(value, source = "") {
  const mode = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (MCP_MANAGEMENT_MODES.has(mode)) return mode;
  return source === "marketplace" ? "native" : "custom";
}

function normalizeRequiredInputs(input) {
  return Array.isArray(input)
    ? input.map((field) => ({
        key: String(field?.key || "").trim(),
        label: String(field?.label || field?.key || "").trim(),
        secret: field?.secret === true,
        target: String(field?.target || "env").trim() || "env",
        required: field?.required !== false
      })).filter((field) => field.key)
    : [];
}

function normalizeConnectionWizard(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    state: String(source.state || "idle").trim() || "idle",
    nextAction: String(source.nextAction || "").trim(),
    message: sanitizeSecretText(source.message || ""),
    missingRequiredInputs: Array.isArray(source.missingRequiredInputs)
      ? source.missingRequiredInputs.map((key) => String(key || "").trim()).filter(Boolean)
      : [],
    actions: Array.isArray(source.actions)
      ? source.actions.map((action) => ({
          id: String(action?.id || "").trim(),
          label: String(action?.label || action?.id || "").trim()
        })).filter((action) => action.id)
      : []
  };
}

function normalizeManagedRuntime(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    connectorId: String(source.connectorId || "").trim(),
    endpoint: String(source.endpoint || "").trim(),
    installDir: String(source.installDir || "").trim(),
    expectedToolCount: Number.isFinite(Number(source.expectedToolCount)) ? Number(source.expectedToolCount) : 0,
    state: String(source.state || "").trim(),
    lastAction: String(source.lastAction || "").trim()
  };
}
```

Then add these properties in the `return { ... }` object inside `normalizeCoreMcpRecord`:

```js
    managementMode: normalizeManagementMode(input.managementMode, input.source),
    requiredInputs: normalizeRequiredInputs(input.requiredInputs),
    connectionWizard: normalizeConnectionWizard(input.connectionWizard),
    managedRuntime: normalizeManagedRuntime(input.managedRuntime),
```

Then add this redaction in `publicCoreMcpRecord(record = {})` after the diagnostics redaction:

```js
  if (Array.isArray(copy.requiredInputs)) {
    copy.requiredInputs = copy.requiredInputs.map((field) => ({
      ...field,
      value: undefined
    }));
  }
  if (copy.managedRuntime && typeof copy.managedRuntime === "object") {
    copy.managedRuntime = {
      ...copy.managedRuntime,
      installDir: copy.managedRuntime.installDir ? "[managed]" : ""
    };
  }
  if (copy.connectionWizard && typeof copy.connectionWizard === "object") {
    copy.connectionWizard.message = sanitizeSecretText(copy.connectionWizard.message || "");
  }
```

- [ ] **Step 5: Extend record tests for management fields**

Append to `tests/core-mcp-records.test.js`:

```js
test("normalizes managed runtime fields and public projection redacts install dir", () => {
  const record = normalizeCoreMcpRecord({
    name: "小红书 MCP",
    nativeName: "xiaohongshu",
    managementMode: "managed",
    source: "marketplace",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
    requiredInputs: [{ key: "TOKEN", label: "Token", secret: true, target: "env" }],
    connectionWizard: { state: "needs_managed_action", nextAction: "install", message: "ready" },
    managedRuntime: {
      connectorId: "xiaohongshu",
      endpoint: "http://127.0.0.1:18060/mcp",
      installDir: "/Users/me/.mia/xhs",
      expectedToolCount: 13,
      state: "not_installed"
    }
  });

  assert.equal(record.managementMode, "managed");
  assert.equal(record.requiredInputs[0].key, "TOKEN");
  assert.equal(record.connectionWizard.nextAction, "install");
  assert.equal(record.managedRuntime.expectedToolCount, 13);

  const view = publicCoreMcpRecord(record);
  assert.equal(view.managedRuntime.installDir, "[managed]");
});
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/core-mcp-catalog.test.js tests/core-mcp-records.test.js
```

Expected output includes:

```text
# pass
```

- [ ] **Step 7: Commit**

Run:

```bash
git add src/core/mcp/catalog.js src/core/mcp/records.js tests/core-mcp-catalog.test.js tests/core-mcp-records.test.js
git commit -m "feat: define managed mcp catalog"
```

Expected output includes:

```text
[main
```

---

### Task 2: Native Marketplace Connect Flow

**Files:**
- Modify: `src/core/mcp/service.js`
- Test: `tests/core-mcp-service.test.js`
- Add test coverage in: `tests/core-mcp-managed-service.test.js`

**Interfaces:**
- Consumes: `builtinMcpTemplates()`, `builtinMcpTemplateById(id)`, `materializeBuiltinMcpRecord(template, values, options)`
- Produces: `fetchMarketplace() -> { success: true, data: { templates } }`
- Produces: `installTemplate(templateId: string, values: object) -> { success, data: publicRecord }`
- Produces behavior: native templates are saved disabled, tested, and enabled only when `manager.testServer()` or `connectionTester.testConnection()` returns `status: "connected"`.

- [ ] **Step 1: Write failing service tests for native templates**

Append to `tests/core-mcp-managed-service.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createCoreMcpService } = require("../src/core/mcp/service.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-managed-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = { mcpServers: path.join(dir, "mia-mcp-servers.json"), runtime: dir };
  const manager = overrides.manager || {
    refresh: async () => ({ success: true, tools: [], errors: [] }),
    testServer: async (record) => ({ ok: true, success: true, status: "connected", code: "ok", tools: [{ name: `${record.nativeName}_tool`, inputSchema: {} }], error: "" }),
    toolManifest: () => []
  };
  return {
    service: createCoreMcpService({
      runtimePaths: () => runtime,
      fs,
      manager,
      bridge: overrides.bridge || { start: async () => ({ callbackUrl: "http://127.0.0.1:3333/mcp/execute", manifestUrl: "http://127.0.0.1:3333/mcp/manifest", secret: "sec" }) },
      nativeSync: overrides.nativeSync || (async () => ({ success: true, statuses: {}, commands: [] })),
      managedSupervisor: overrides.managedSupervisor,
      now: () => 1710000000000,
      idFactory: (name) => `mcp_${String(name).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}`
    }),
    runtime
  };
}

test("marketplace exposes only supported native and managed templates", async (t) => {
  const { service } = setup(t);
  const result = await service.fetchMarketplace();
  assert.equal(result.success, true);
  assert.deepEqual(result.data.templates.map((item) => item.id), [
    "xiaohongshu",
    "playwright",
    "context7",
    "github",
    "tavily",
    "firecrawl"
  ]);
  assert.equal(result.data.templates.some((item) => String(item.managementMode).includes("external")), false);
});

test("native template with no required fields tests and enables", async (t) => {
  const calls = [];
  const { service, runtime } = setup(t, {
    manager: {
      refresh: async (records) => {
        calls.push(["refresh", records.map((record) => record.nativeName)]);
        return { success: true, tools: [], errors: [] };
      },
      testServer: async (record) => {
        calls.push(["test", record.nativeName, record.enabled]);
        return { ok: true, success: true, status: "connected", code: "ok", tools: [{ name: "browser_open", inputSchema: {} }], error: "" };
      },
      toolManifest: () => []
    }
  });

  const installed = await service.installTemplate("playwright", {});
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(installed.success, true);
  assert.equal(installed.data.enabled, true);
  assert.equal(installed.data.status, "connected");
  assert.equal(installed.data.managementMode, "native");
  assert.equal(installed.data.transport.command, "npx");
  assert.deepEqual(calls.find((call) => call[0] === "test"), ["test", "playwright", false]);
  assert.equal(stored[0].enabled, true);
});

test("native template requiring a secret saves disabled until field is supplied", async (t) => {
  const { service, runtime } = setup(t);
  const missing = await service.installTemplate("github", {});
  const storedMissing = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(missing.success, true);
  assert.equal(missing.data.enabled, false);
  assert.equal(missing.data.connectionWizard.state, "missing_required_inputs");
  assert.deepEqual(missing.data.connectionWizard.missingRequiredInputs, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  assert.equal(storedMissing[0].enabled, false);

  const ready = await service.installTemplate("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" });
  const storedReady = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(ready.success, true);
  assert.equal(ready.data.enabled, true);
  assert.equal(ready.data.transport.env.GITHUB_PERSONAL_ACCESS_TOKEN, "••••••••");
  assert.equal(storedReady[0].transport.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_secret");
});

test("native template stays disabled when connection test fails", async (t) => {
  const { service } = setup(t, {
    manager: {
      refresh: async () => ({ success: true, tools: [], errors: [] }),
      testServer: async () => ({ ok: false, success: false, status: "disconnected", code: "spawn_failed", error: "npx failed", tools: [] }),
      toolManifest: () => []
    }
  });

  const result = await service.installTemplate("context7", {});

  assert.equal(result.success, true);
  assert.equal(result.data.enabled, false);
  assert.equal(result.data.status, "disconnected");
  assert.equal(result.data.connectionWizard.state, "test_failed");
  assert.equal(result.data.lastTestCode, "spawn_failed");
});
```

- [ ] **Step 2: Run service tests to verify they fail**

Run:

```bash
node --test tests/core-mcp-managed-service.test.js
```

Expected output includes one of:

```text
not ok
external
```

or:

```text
not ok
Expected values to be strictly deep-equal
```

- [ ] **Step 3: Replace inline marketplace templates in service**

Modify the imports at the top of `src/core/mcp/service.js`:

```js
const {
  builtinMcpTemplates,
  builtinMcpTemplateById,
  materializeBuiltinMcpRecord
} = require("./catalog.js");
```

Delete `MCP_MARKETPLACE_TEMPLATES`, `marketplaceTemplates()`, `marketplaceTemplateById()`, and `withMarketplaceTemplateDefaults()`. Replace them with:

```js
function withMarketplaceTemplateDefaults(input = {}) {
  const template = builtinMcpTemplateById(input.registryId);
  if (!template) return input;
  return {
    ...input,
    description: input.description || template.description,
    nativeName: input.nativeName || input.native_name || template.nativeName,
    homepage: input.homepage || template.homepage || "",
    managementMode: input.managementMode || template.managementMode,
    requiredInputs: input.requiredInputs || template.requiredInputs || [],
    connectionWizard: input.connectionWizard || template.connectionWizard || {},
    managedRuntime: input.managedRuntime || template.managedRuntime || {},
    expectedToolCount: input.expectedToolCount || template.managedRuntime?.expectedToolCount || 0
  };
}
```

Replace `fetchMarketplace()` with:

```js
async function fetchMarketplace() {
  return ok({ templates: builtinMcpTemplates() });
}
```

- [ ] **Step 4: Implement native install/test/enable behavior**

Replace `installTemplate(templateId, values = {})` in `src/core/mcp/service.js` with:

```js
async function installTemplate(templateId, values = {}) {
  try {
    const template = builtinMcpTemplateById(templateId);
    if (!template) throw new Error("MCP template not found.");

    const current = loadRecords();
    const existing = resolveRecord(current, values.id || template.nativeName || template.name)
      || current.find((record) => record.registryId === template.id)
      || null;
    const materialized = materializeBuiltinMcpRecord(template, {
      ...values,
      id: existing?.id,
      name: values.name || existing?.name || template.name
    }, { now, idFactory });
    let record = {
      ...(existing || {}),
      ...materialized.record,
      createdAt: existing?.createdAt || materialized.record.createdAt,
      updatedAt: now()
    };

    const withoutExisting = current.filter((item) => item.id !== record.id && item.name !== record.name);
    let saved = saveRecords(withoutExisting.concat(record));

    if (materialized.missingRequiredInputs.length) {
      const runtime = await applyRuntimeChanges(current, saved, {
        availableIds: new Set([record.id]),
        availableMessage: "Waiting for required fields in Mia."
      });
      return ok(publicRecord(resolveRecord(runtime.records, record.id) || record));
    }

    if (record.managementMode === "managed") {
      return ok(publicRecord(resolveRecord(saved, record.id) || record));
    }

    const tested = await testServer(record);
    if (!tested.success) throw new Error(tested.error || "MCP connection test failed.");
    const testedRecord = normalizeCoreMcpRecord({
      ...record,
      ...tested.data,
      transport: record.transport,
      requiredInputs: record.requiredInputs,
      connectionWizard: tested.data.status === "connected"
        ? { state: "connected", nextAction: "", message: "Connected and enabled.", missingRequiredInputs: [], actions: [] }
        : { state: "test_failed", nextAction: "test", message: tested.data.lastError || "Connection test failed.", missingRequiredInputs: [], actions: [{ id: "test", label: "重新检测" }] },
      enabled: tested.data.status === "connected"
    }, { now, idFactory });
    saved = saveRecords(withoutExisting.concat(testedRecord));
    const runtime = await applyRuntimeChanges(current, saved, {
      availableIds: testedRecord.enabled ? new Set() : new Set([testedRecord.id]),
      availableMessage: testedRecord.enabled ? "" : "Connection test failed in Mia."
    });
    return ok(publicRecord(resolveRecord(runtime.records, testedRecord.id) || testedRecord));
  } catch (error) {
    return fail(error);
  }
}
```

- [ ] **Step 5: Run focused native marketplace tests**

Run:

```bash
node --test tests/core-mcp-catalog.test.js tests/core-mcp-managed-service.test.js tests/core-mcp-service.test.js
```

Expected output includes:

```text
# pass
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/core/mcp/service.js tests/core-mcp-managed-service.test.js tests/core-mcp-service.test.js
git commit -m "feat: connect native mcp templates from mia"
```

Expected output includes:

```text
[main
```

---

### Task 3: Managed Connector Supervisor For Xiaohongshu

**Files:**
- Create: `src/core/mcp/managed-connectors/xiaohongshu.js`
- Create: `src/core/mcp/managed-connector-supervisor.js`
- Test: `tests/core-mcp-managed-connector-supervisor.test.js`

**Interfaces:**
- Produces: `createXiaohongshuManagedConnector(deps) -> ManagedConnector`
- Produces: `createManagedConnectorSupervisor(deps) -> { status(record), runAction(record, action, values), ensureRunning(records), stop(recordId) }`
- `ManagedConnector.status(record) -> Promise<{ state, installed, running, endpoint, message }>`
- `ManagedConnector.runAction(record, action, values) -> Promise<{ ok, state, message, recordPatch }>`
- Consumes: record field `managedRuntime.connectorId === "xiaohongshu"`

- [ ] **Step 1: Write failing supervisor tests**

Create `tests/core-mcp-managed-connector-supervisor.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createManagedConnectorSupervisor } = require("../src/core/mcp/managed-connector-supervisor.js");
const { normalizeCoreMcpRecord } = require("../src/core/mcp/records.js");

function fakeChildProcess(calls) {
  return {
    spawn(command, args, options) {
      calls.push({ kind: "spawn", command, args, cwd: options?.cwd || "" });
      const child = new EventEmitter();
      child.pid = 1234;
      child.kill = () => {
        calls.push({ kind: "kill", pid: child.pid });
        child.emit("exit", 0);
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    },
    execFile(command, args, options, callback) {
      calls.push({ kind: "execFile", command, args, cwd: options?.cwd || "" });
      callback(null, "", "");
    }
  };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-xhs-supervisor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const supervisor = createManagedConnectorSupervisor({
    runtimePaths: () => ({ runtime: dir }),
    fs,
    path,
    childProcess: fakeChildProcess(calls),
    fetch: async () => ({ ok: true, status: 200 }),
    now: () => 1710000000000
  });
  const record = normalizeCoreMcpRecord({
    name: "小红书 MCP",
    nativeName: "xiaohongshu",
    managementMode: "managed",
    registryId: "xiaohongshu",
    enabled: false,
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
    managedRuntime: {
      connectorId: "xiaohongshu",
      endpoint: "http://127.0.0.1:18060/mcp",
      expectedToolCount: 13
    }
  });
  return { dir, calls, supervisor, record };
}

test("install action clones xiaohongshu connector into Mia runtime", async (t) => {
  const { dir, calls, supervisor, record } = setup(t);
  const result = await supervisor.runAction(record, "install", {});
  assert.equal(result.ok, true);
  assert.equal(result.state, "installed");
  assert.match(result.recordPatch.managedRuntime.installDir, /managed-mcp\/xiaohongshu-mcp$/);
  assert.deepEqual(calls[0], {
    kind: "execFile",
    command: "git",
    args: ["clone", "https://github.com/xpzouying/xiaohongshu-mcp", path.join(dir, "managed-mcp", "xiaohongshu-mcp")],
    cwd: dir
  });
});

test("login action runs the connector login command in managed directory", async (t) => {
  const { calls, supervisor, record } = setup(t);
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  const result = await supervisor.runAction(withInstallDir, "login", {});

  assert.equal(result.ok, true);
  assert.equal(result.state, "login_started");
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command === "go" && call.args.join(" ") === "run cmd/login/main.go"), true);
});

test("start action keeps a running child process and stop kills it", async (t) => {
  const { calls, supervisor, record } = setup(t);
  const installed = await supervisor.runAction(record, "install", {});
  const withInstallDir = normalizeCoreMcpRecord({ ...record, ...installed.recordPatch, transport: record.transport });

  const started = await supervisor.runAction(withInstallDir, "start", {});
  const stopped = await supervisor.stop(withInstallDir.id);

  assert.equal(started.ok, true);
  assert.equal(started.state, "running");
  assert.equal(calls.some((call) => call.kind === "spawn" && call.command === "go" && call.args.join(" ") === "run ."), true);
  assert.equal(stopped.ok, true);
  assert.equal(calls.some((call) => call.kind === "kill"), true);
});

test("ensureRunning starts enabled managed records before bridge refresh", async (t) => {
  const { supervisor, record } = setup(t);
  const installed = await supervisor.runAction(record, "install", {});
  const enabled = normalizeCoreMcpRecord({
    ...record,
    ...installed.recordPatch,
    enabled: true,
    transport: record.transport
  });

  const result = await supervisor.ensureRunning([enabled]);

  assert.equal(result.records[0].managedRuntime.state, "running");
  assert.deepEqual(result.errors, []);
});
```

- [ ] **Step 2: Run supervisor tests to verify they fail**

Run:

```bash
node --test tests/core-mcp-managed-connector-supervisor.test.js
```

Expected output includes:

```text
not ok
Cannot find module '../src/core/mcp/managed-connector-supervisor.js'
```

- [ ] **Step 3: Add the xiaohongshu connector**

Create `src/core/mcp/managed-connectors/xiaohongshu.js`:

```js
"use strict";

const DEFAULT_ENDPOINT = "http://127.0.0.1:18060/mcp";
const REPO_URL = "https://github.com/xpzouying/xiaohongshu-mcp";

function createXiaohongshuManagedConnector(deps = {}) {
  const fs = deps.fs || require("node:fs");
  const path = deps.path || require("node:path");
  const childProcess = deps.childProcess || require("node:child_process");
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  function installDir(record = {}) {
    const existing = String(record.managedRuntime?.installDir || "").trim();
    if (existing) return existing;
    return path.join(runtimePaths().runtime, "managed-mcp", "xiaohongshu-mcp");
  }

  function hasCheckout(dir) {
    return fs.existsSync(path.join(dir, "go.mod"));
  }

  function execFile(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(command, args, options, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  function spawn(command, args, options = {}) {
    const child = childProcess.spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return child;
  }

  async function status(record = {}) {
    const dir = installDir(record);
    const installed = hasCheckout(dir);
    return {
      state: installed ? String(record.managedRuntime?.state || "installed") : "not_installed",
      installed,
      running: false,
      endpoint: String(record.managedRuntime?.endpoint || DEFAULT_ENDPOINT),
      message: installed ? "Xiaohongshu MCP checkout is present." : "Xiaohongshu MCP checkout is not installed."
    };
  }

  async function runAction(record = {}, action = "") {
    const dir = installDir(record);
    const endpoint = String(record.managedRuntime?.endpoint || DEFAULT_ENDPOINT);
    if (action === "install") {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      if (!hasCheckout(dir)) {
        await execFile("git", ["clone", REPO_URL, dir], { cwd: runtimePaths().runtime });
      }
      return {
        ok: true,
        state: "installed",
        message: "Xiaohongshu MCP is installed.",
        recordPatch: { managedRuntime: { ...record.managedRuntime, installDir: dir, endpoint, state: "installed", lastAction: "install" } }
      };
    }
    if (action === "login") {
      const child = spawn("go", ["run", "cmd/login/main.go"], { cwd: dir });
      return {
        ok: true,
        state: "login_started",
        child,
        message: "Xiaohongshu login was started.",
        recordPatch: { managedRuntime: { ...record.managedRuntime, installDir: dir, endpoint, state: "login_started", lastAction: "login" } }
      };
    }
    if (action === "start") {
      const child = spawn("go", ["run", "."], { cwd: dir });
      return {
        ok: true,
        state: "running",
        child,
        message: "Xiaohongshu MCP service is running.",
        recordPatch: { managedRuntime: { ...record.managedRuntime, installDir: dir, endpoint, state: "running", lastAction: "start" } }
      };
    }
    throw new Error(`Unsupported xiaohongshu managed action: ${action}`);
  }

  return {
    id: "xiaohongshu",
    installDir,
    status,
    runAction
  };
}

module.exports = { createXiaohongshuManagedConnector };
```

- [ ] **Step 4: Add the managed supervisor**

Create `src/core/mcp/managed-connector-supervisor.js`:

```js
"use strict";

const { createXiaohongshuManagedConnector } = require("./managed-connectors/xiaohongshu.js");
const { normalizeCoreMcpRecord, sanitizeSecretText } = require("./records.js");

function mergeRecordPatch(record, patch, options = {}) {
  return normalizeCoreMcpRecord({
    ...record,
    ...(patch || {}),
    transport: patch?.transport || record.transport,
    managedRuntime: {
      ...(record.managedRuntime || {}),
      ...(patch?.managedRuntime || {})
    },
    connectionWizard: {
      ...(record.connectionWizard || {}),
      ...(patch?.connectionWizard || {})
    }
  }, options);
}

function createManagedConnectorSupervisor(deps = {}) {
  const connectors = {
    xiaohongshu: createXiaohongshuManagedConnector(deps)
  };
  const children = new Map();
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const idFactory = typeof deps.idFactory === "function" ? deps.idFactory : undefined;

  function connectorFor(record = {}) {
    const id = String(record.managedRuntime?.connectorId || "").trim();
    return connectors[id] || null;
  }

  async function status(record = {}) {
    const connector = connectorFor(record);
    if (!connector) return { state: "unsupported", installed: false, running: false, endpoint: "", message: "Managed connector is not supported." };
    const base = await connector.status(record);
    const running = children.has(record.id);
    return { ...base, running, state: running ? "running" : base.state };
  }

  async function runAction(record = {}, action = "", values = {}) {
    const connector = connectorFor(record);
    if (!connector) throw new Error("Managed connector is not supported.");
    if (action === "stop") return stop(record.id);
    const result = await connector.runAction(record, action, values);
    if (result.child && action === "start") {
      children.set(record.id, result.child);
      result.child.once?.("exit", () => children.delete(record.id));
    }
    return {
      ok: result.ok === true,
      state: String(result.state || ""),
      message: sanitizeSecretText(result.message || ""),
      recordPatch: result.recordPatch || {}
    };
  }

  async function ensureRunning(records = []) {
    const nextRecords = [];
    const errors = [];
    for (const record of records) {
      if (record.managementMode !== "managed" || record.enabled === false) {
        nextRecords.push(record);
        continue;
      }
      try {
        const current = await status(record);
        if (current.running) {
          nextRecords.push(record);
          continue;
        }
        const started = await runAction(record, "start", {});
        nextRecords.push(mergeRecordPatch(record, started.recordPatch, { now, idFactory }));
      } catch (error) {
        errors.push({ id: record.id, name: record.name, message: sanitizeSecretText(error?.message || error) });
        nextRecords.push(mergeRecordPatch(record, {
          managedRuntime: { ...(record.managedRuntime || {}), state: "error", lastAction: "start" },
          connectionWizard: { state: "managed_error", nextAction: "start", message: error?.message || "Managed connector failed to start." }
        }, { now, idFactory }));
      }
    }
    return { records: nextRecords, errors };
  }

  async function stop(recordId) {
    const child = children.get(recordId);
    if (!child) return { ok: true, state: "stopped", message: "Managed connector was not running.", recordPatch: {} };
    child.kill?.();
    children.delete(recordId);
    return { ok: true, state: "stopped", message: "Managed connector stopped.", recordPatch: { managedRuntime: { state: "stopped", lastAction: "stop" } } };
  }

  return { status, runAction, ensureRunning, stop };
}

module.exports = {
  createManagedConnectorSupervisor,
  mergeRecordPatch
};
```

- [ ] **Step 5: Run supervisor tests**

Run:

```bash
node --test tests/core-mcp-managed-connector-supervisor.test.js
```

Expected output includes:

```text
# pass
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/core/mcp/managed-connectors/xiaohongshu.js src/core/mcp/managed-connector-supervisor.js tests/core-mcp-managed-connector-supervisor.test.js
git commit -m "feat: supervise managed xiaohongshu mcp"
```

Expected output includes:

```text
[main
```

---

### Task 4: Managed Service Actions And Bridge Refresh

**Files:**
- Modify: `src/core/mcp/service.js`
- Test: `tests/core-mcp-managed-service.test.js`
- Modify: `tests/core-mcp-service.test.js`

**Interfaces:**
- Consumes: `managedSupervisor.runAction(record, action, values)`
- Consumes: `managedSupervisor.ensureRunning(records)`
- Produces: `runManagedAction(id: string, action: string, values: object) -> { success, data: publicRecord }`
- Produces behavior: enabled managed records are started before `manager.refresh(enabledRecords)`.
- Produces behavior: managed `test` enables the record only after connection test returns `connected`.

- [ ] **Step 1: Add failing service tests for managed actions**

Append to `tests/core-mcp-managed-service.test.js`:

```js
test("managed xiaohongshu install creates disabled record with managed actions", async (t) => {
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async () => ({ ok: true, state: "installed", message: "installed", recordPatch: { managedRuntime: { state: "installed", installDir: "/tmp/xhs" } } }),
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });

  const installed = await service.installTemplate("xiaohongshu", {});

  assert.equal(installed.success, true);
  assert.equal(installed.data.enabled, false);
  assert.equal(installed.data.managementMode, "managed");
  assert.equal(installed.data.managedRuntime.connectorId, "xiaohongshu");
  assert.equal(installed.data.connectionWizard.nextAction, "install");
});

test("runManagedAction updates xiaohongshu runtime state", async (t) => {
  const actions = [];
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => {
        actions.push([record.nativeName, action]);
        return {
          ok: true,
          state: action === "start" ? "running" : "installed",
          message: action,
          recordPatch: {
            managedRuntime: {
              ...record.managedRuntime,
              state: action === "start" ? "running" : "installed",
              installDir: "/tmp/xhs",
              lastAction: action
            }
          }
        };
      },
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});

  const started = await service.runManagedAction(installed.data.id, "start", {});

  assert.equal(started.success, true);
  assert.equal(started.data.managedRuntime.state, "running");
  assert.equal(started.data.connectionWizard.nextAction, "test");
  assert.deepEqual(actions, [["xiaohongshu", "start"]]);
});

test("runManagedAction test enables xiaohongshu after successful MCP test", async (t) => {
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => ({
        ok: true,
        state: action === "start" ? "running" : "installed",
        message: action,
        recordPatch: { managedRuntime: { ...record.managedRuntime, state: "running", installDir: "/tmp/xhs", lastAction: action } }
      }),
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});
  await service.runManagedAction(installed.data.id, "start", {});

  const tested = await service.runManagedAction(installed.data.id, "test", {});

  assert.equal(tested.success, true);
  assert.equal(tested.data.enabled, true);
  assert.equal(tested.data.status, "connected");
  assert.equal(tested.data.connectionWizard.state, "connected");
});

test("refreshBridge starts enabled managed records before manager refresh", async (t) => {
  const calls = [];
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => ({ ok: true, state: action, message: action, recordPatch: { managedRuntime: { ...record.managedRuntime, state: action } } }),
      ensureRunning: async (records) => {
        calls.push(["ensureRunning", records.map((record) => record.nativeName)]);
        return { records: records.map((record) => ({ ...record, managedRuntime: { ...record.managedRuntime, state: "running" } })), errors: [] };
      }
    },
    manager: {
      refresh: async (records) => {
        calls.push(["refresh", records.map((record) => `${record.nativeName}:${record.managedRuntime?.state || ""}`)]);
        return { success: true, tools: [], errors: [] };
      },
      testServer: async () => ({ ok: true, success: true, status: "connected", code: "ok", tools: [{ name: "search", inputSchema: {} }] }),
      toolManifest: () => []
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});
  await service.runManagedAction(installed.data.id, "test", {});
  await service.refreshBridge();

  assert.equal(calls.some((call) => call[0] === "ensureRunning"), true);
  assert.equal(calls.some((call) => call[0] === "refresh" && call[1].includes("xiaohongshu:running")), true);
});
```

- [ ] **Step 2: Run managed service tests to verify they fail**

Run:

```bash
node --test tests/core-mcp-managed-service.test.js
```

Expected output includes:

```text
not ok
service.runManagedAction is not a function
```

- [ ] **Step 3: Add supervisor dependency and managed refresh**

In `createCoreMcpService(deps = {})`, add:

```js
  const managedSupervisor = deps.managedSupervisor || null;
```

Replace the first lines of `refreshBridgeState(records = loadRecords())` with:

```js
    const current = normalizeCoreMcpRegistry(records, { now, idFactory });
    const managedResult = managedSupervisor && typeof managedSupervisor.ensureRunning === "function"
      ? await managedSupervisor.ensureRunning(enabledCoreMcpRecords(current))
      : { records: enabledCoreMcpRecords(current), errors: [] };
    const runtimeRecords = current.map((record) => {
      const updated = managedResult.records.find((item) => item.id === record.id);
      return updated || record;
    });
    const refreshed = manager && typeof manager.refresh === "function"
      ? await manager.refresh(enabledCoreMcpRecords(runtimeRecords))
      : { success: true, tools: [], errors: [] };
```

Then include managed errors in the returned error list:

```js
      errors: []
        .concat(Array.isArray(refreshed?.errors) ? refreshed.errors.map((error) => sanitizeBridgeError(error)) : [])
        .concat(Array.isArray(managedResult?.errors) ? managedResult.errors.map((error) => sanitizeBridgeError(error)) : []),
```

- [ ] **Step 4: Add managed action service method**

Add this function inside `createCoreMcpService`:

```js
  function nextManagedWizard(action, result, testStatus = "") {
    if (action === "install") {
      return { state: "needs_managed_action", nextAction: "login", message: result.message || "Installed.", missingRequiredInputs: [], actions: [{ id: "login", label: "打开登录" }, { id: "start", label: "启动服务" }, { id: "test", label: "检测并启用" }] };
    }
    if (action === "login") {
      return { state: "needs_managed_action", nextAction: "start", message: result.message || "Login started.", missingRequiredInputs: [], actions: [{ id: "start", label: "启动服务" }, { id: "test", label: "检测并启用" }] };
    }
    if (action === "start") {
      return { state: "ready_to_test", nextAction: "test", message: result.message || "Service started.", missingRequiredInputs: [], actions: [{ id: "test", label: "检测并启用" }] };
    }
    if (action === "test" && testStatus === "connected") {
      return { state: "connected", nextAction: "", message: "Connected and enabled.", missingRequiredInputs: [], actions: [] };
    }
    if (action === "test") {
      return { state: "test_failed", nextAction: "test", message: result.message || "Connection test failed.", missingRequiredInputs: [], actions: [{ id: "test", label: "重新检测" }] };
    }
    return { state: "needs_managed_action", nextAction: "start", message: result.message || "", missingRequiredInputs: [], actions: [{ id: "start", label: "启动服务" }, { id: "test", label: "检测并启用" }] };
  }

  async function runManagedAction(id, action, values = {}) {
    try {
      const current = loadRecords();
      const existing = resolveRecord(current, id);
      if (!existing) throw new Error("MCP server not found.");
      if (existing.managementMode !== "managed") throw new Error("MCP server is not managed by Mia.");
      if (!managedSupervisor || typeof managedSupervisor.runAction !== "function") {
        throw new Error("Managed MCP supervisor is not configured.");
      }

      let result = { ok: true, state: "", message: "", recordPatch: {} };
      let nextRecord = existing;
      if (action !== "test") {
        result = await managedSupervisor.runAction(existing, action, values || {});
        nextRecord = normalizeCoreMcpRecord({
          ...existing,
          ...result.recordPatch,
          transport: existing.transport,
          connectionWizard: nextManagedWizard(action, result),
          enabled: false,
          updatedAt: now()
        }, { now, idFactory });
      } else {
        const tested = await testServer(existing);
        if (!tested.success) throw new Error(tested.error || "MCP connection test failed.");
        nextRecord = normalizeCoreMcpRecord({
          ...existing,
          status: tested.data.status,
          lastTestStatus: tested.data.lastTestStatus || tested.data.status,
          lastTestCode: tested.data.lastTestCode,
          diagnostics: tested.data.diagnostics,
          tools: tested.data.tools,
          lastCheckedAt: tested.data.lastCheckedAt,
          lastError: tested.data.lastError,
          enabled: tested.data.status === "connected",
          connectionWizard: nextManagedWizard(action, tested.data, tested.data.status),
          updatedAt: now()
        }, { now, idFactory });
      }

      const saved = saveRecords(current.map((record) => record.id === existing.id ? nextRecord : record));
      const runtime = await applyRuntimeChanges(current, saved, {
        availableIds: nextRecord.enabled ? new Set() : new Set([nextRecord.id]),
        availableMessage: nextRecord.enabled ? "" : "Waiting for managed MCP setup in Mia."
      });
      return ok(publicRecord(resolveRecord(runtime.records, nextRecord.id) || nextRecord));
    } catch (error) {
      return fail(error);
    }
  }
```

Add `runManagedAction` to the returned service object.

- [ ] **Step 5: Run focused managed service tests**

Run:

```bash
node --test tests/core-mcp-managed-service.test.js tests/core-mcp-service.test.js
```

Expected output includes:

```text
# pass
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/core/mcp/service.js tests/core-mcp-managed-service.test.js tests/core-mcp-service.test.js
git commit -m "feat: run managed mcp actions"
```

Expected output includes:

```text
[main
```

---

### Task 5: Four-Agent Exposure And Fingerprint Verification

**Files:**
- Modify: `src/core/mcp/engine-sync.js`
- Modify if tests fail: `src/core/mia-core.js`
- Modify if tests fail: `src/main/agents/hermes-chat-adapter.js`
- Modify if tests fail: `src/main/agents/claude-code-chat-adapter.js`
- Modify if tests fail: `src/main/agents/codex-chat-adapter.js`
- Modify if tests fail: `src/main/agents/openclaw-chat-adapter.js`
- Modify: `tests/mcp-engine-sync.test.js`
- Modify: `tests/hermes-chat-adapter.test.js`
- Modify: `tests/claude-code-chat-adapter.test.js`
- Modify: `tests/codex-chat-adapter.test.js`
- Modify: `tests/openclaw-chat-adapter.test.js`

**Interfaces:**
- Consumes: `mcpService.getEngineSpecs(engineId, options)`
- Consumes: `mcpService.fingerprint()`
- Produces behavior: enabled managed HTTP MCP uses direct HTTP when an engine supports it, otherwise uses `mia-mcp-bridge`.
- Produces behavior: each adapter session cache key changes when `mcpService.fingerprint()` changes.

- [ ] **Step 1: Add engine-sync tests for xiaohongshu exposure**

Append to `tests/mcp-engine-sync.test.js`:

```js
test("managed HTTP MCP is exposed directly to OpenClaw when HTTP is supported", () => {
  const { mcpServersForOpenClawAcp } = require("../src/core/mcp/engine-sync.js");
  const servers = mcpServersForOpenClawAcp([
    {
      name: "小红书 MCP",
      nativeName: "xiaohongshu",
      enabled: true,
      managementMode: "managed",
      transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {} }
    }
  ], { supportsHttp: true });

  assert.deepEqual(servers, [{
    type: "http",
    name: "xiaohongshu",
    url: "http://127.0.0.1:18060/mcp",
    headers: []
  }]);
});

test("managed HTTP MCP uses Mia bridge for Hermes when URL MCP is unsupported", () => {
  const { mcpSpecsForHermes, bridgeMcpSpec } = require("../src/core/mcp/engine-sync.js");
  const bridge = bridgeMcpSpec({ command: "/usr/bin/node", scriptPath: "/app/mcp-stdio-proxy-server.js", bridgeUrl: "http://127.0.0.1:3333", secret: "sec" });
  const specs = mcpSpecsForHermes([
    {
      name: "小红书 MCP",
      nativeName: "xiaohongshu",
      enabled: true,
      managementMode: "managed",
      transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {} }
    }
  ], { hermesSupportsUrl: false, bridge });

  assert.deepEqual(Object.keys(specs), ["mia-mcp-bridge"]);
});

test("Codex and Claude receive native stdio built-ins without manual command steps", () => {
  const { mcpSpecsForCodex, mcpSpecsForClaudeSdk } = require("../src/core/mcp/engine-sync.js");
  const records = [{
    name: "Context7 MCP",
    nativeName: "context7",
    enabled: true,
    managementMode: "native",
    transport: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], env: {} }
  }];

  assert.equal(mcpSpecsForCodex(records).context7.command, "npx");
  assert.equal(mcpSpecsForClaudeSdk(records).context7.command, "npx");
});
```

- [ ] **Step 2: Run engine-sync tests**

Run:

```bash
node --test tests/mcp-engine-sync.test.js
```

Expected output includes:

```text
# pass
```

If this fails, fix only the engine conversion behavior that fails. Keep the bridge fallback behavior already present for SSE, HTTP headers, and unsupported HTTP engines.

- [ ] **Step 3: Add adapter fingerprint tests using existing helpers**

`tests/claude-code-chat-adapter.test.js` and `tests/codex-chat-adapter.test.js` already verify user MCP specs and stored fingerprints. Add only the missing managed HTTP assertions to those existing tests:

```js
assert.equal(queryCall.options.mcpServers.xiaohongshu.url, "http://127.0.0.1:18060/mcp");
assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), [
  "set-session", "claude-code", "alice", "s1", "sess_1", "fp1:mcp_fp"
]);
```

```js
assert.equal(appServerCall.mcpServers.xiaohongshu.url, "http://127.0.0.1:18060/mcp");
const setEntryCall = deps.calls.find((entry) => entry[0] === "set-entry");
assert.equal(setEntryCall[5], "mcp_fp");
```

`tests/openclaw-chat-adapter.test.js` already has `createDeps()` and ACP MCP injection tests. Add this managed HTTP variant after the existing capability test:

```js
test("ACP MCP injection exposes managed xiaohongshu HTTP when OpenClaw supports HTTP", async () => {
  const deps = createDeps({
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: { mcp: { transports: ["http"] } },
      agentInfo: { name: "openclaw-acp", version: "test" }
    },
    userMcpServers: [{ type: "http", name: "xiaohongshu", url: "http://127.0.0.1:18060/mcp", headers: [] }],
    mcpFingerprint: "mcp_fp"
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "bot", name: "Bot", engineConfig: {} },
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }]
  });

  const newSession = deps.calls.find((call) => call[0] === "acp-new-session")[1];
  assert.deepEqual(newSession.mcpServers, [{ type: "http", name: "xiaohongshu", url: "http://127.0.0.1:18060/mcp", headers: [] }]);
  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), ["set-session", "openclaw", "bot", "s1", "openclaw:mia:bot:s1:mcp_fp"]);
});
```

`tests/hermes-chat-adapter.test.js` currently validates scheduler MCP context rather than user MCP engine specs. Add this assertion only if the Hermes adapter exposes `getUserMcpSpecs` in its `createDeps()` helper during execution; otherwise Hermes is covered through `tests/mcp-engine-sync.test.js` because Hermes receives user MCP from `mcpSpecsForHermes()`.

- [ ] **Step 4: Run adapter tests**

Run:

```bash
node --test tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js
```

Expected output includes:

```text
# pass
```

- [ ] **Step 5: Patch adapters only where tests expose gaps**

If an adapter does not call `mcpService.fingerprint()` when computing the session key, add this pattern in that adapter's session-key builder:

```js
const mcpFingerprint = mcpService && typeof mcpService.fingerprint === "function"
  ? mcpService.fingerprint()
  : "";
const sessionKey = [
  conversationId,
  modelId,
  workspacePath,
  mcpFingerprint
].join(":");
```

If an adapter does not pass MCP specs into the engine session request, add this pattern at the point the request/session config is created:

```js
const mcpServers = mcpService && typeof mcpService.getEngineSpecs === "function"
  ? mcpService.getEngineSpecs(engineId, engineMcpOptions)
  : {};
```

Use the engine id already used in the adapter: `hermes`, `claude-code`, `codex`, or `openclaw`.

- [ ] **Step 6: Run full exposure tests**

Run:

```bash
node --test tests/mcp-engine-sync.test.js tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js
```

Expected output includes:

```text
# pass
```

- [ ] **Step 7: Commit**

Run:

```bash
git add src/core/mcp/engine-sync.js src/core/mia-core.js src/main/agents/hermes-chat-adapter.js src/main/agents/claude-code-chat-adapter.js src/main/agents/codex-chat-adapter.js src/main/agents/openclaw-chat-adapter.js tests/mcp-engine-sync.test.js tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js
git commit -m "test: verify mcp exposure across agents"
```

If no source files changed, run:

```bash
git add tests/mcp-engine-sync.test.js tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js
git commit -m "test: verify mcp exposure across agents"
```

Expected output includes:

```text
[main
```

---

### Task 6: IPC And Preload For Managed Actions

**Files:**
- Modify: `src/shared/ipc-channels.js`
- Modify: `src/main/ipc/mcp-ipc.js`
- Modify: `src/preload.js`
- Modify: `tests/mcp-ipc-preload.test.js`

**Interfaces:**
- Consumes: `mcpService.runManagedAction(id, action, values)`
- Produces IPC channel: `McpRunManagedAction: "mcp:run-managed-action"`
- Produces preload method: `window.mia.mcp.runManagedAction(id, action, values)`

- [ ] **Step 1: Add failing IPC/preload assertions**

Append to `tests/mcp-ipc-preload.test.js`:

```js
test("managed MCP action IPC and preload bridge are wired", () => {
  const channels = read("src/shared/ipc-channels.js");
  assert.match(channels, /McpRunManagedAction:\s*"mcp:run-managed-action"/);

  const preload = read("src/preload.js");
  assert.match(preload, /runManagedAction:\s*\(id,\s*action,\s*values\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpRunManagedAction,\s*id,\s*action,\s*values\)/);

  const ipc = read("src/main/ipc/mcp-ipc.js");
  assert.match(ipc, /IpcChannel\.McpRunManagedAction/);
  assert.match(ipc, /mcpService\.runManagedAction\(String\(id \|\| ""\),\s*String\(action \|\| ""\),\s*values \|\| \{\}\)/);
});
```

- [ ] **Step 2: Run IPC/preload test to verify it fails**

Run:

```bash
node --test tests/mcp-ipc-preload.test.js
```

Expected output includes:

```text
not ok
McpRunManagedAction
```

- [ ] **Step 3: Add channel constant**

In `src/shared/ipc-channels.js`, after `McpInstallTemplate`, add:

```js
    McpRunManagedAction: "mcp:run-managed-action",
```

- [ ] **Step 4: Register IPC handler**

In `src/main/ipc/mcp-ipc.js`, after the install-template handler, add:

```js
  ipcMain.handle(IpcChannel.McpRunManagedAction, (_event, id, action, values) => (
    mcpService.runManagedAction(String(id || ""), String(action || ""), values || {})
  ));
```

- [ ] **Step 5: Expose preload method**

In `src/preload.js`, inside `mcp: { ... }`, after `installTemplate`, add:

```js
    runManagedAction: (id, action, values) => ipcRenderer.invoke(IpcChannel.McpRunManagedAction, id, action, values),
```

- [ ] **Step 6: Run IPC/preload test**

Run:

```bash
node --test tests/mcp-ipc-preload.test.js
```

Expected output includes:

```text
# pass
```

- [ ] **Step 7: Commit**

Run:

```bash
git add src/shared/ipc-channels.js src/main/ipc/mcp-ipc.js src/preload.js tests/mcp-ipc-preload.test.js
git commit -m "feat: expose managed mcp actions over ipc"
```

Expected output includes:

```text
[main
```

---

### Task 7: Renderer Connection Wizard

**Files:**
- Modify: `src/renderer/mcp/mcp-library.js`
- Modify: `src/renderer/styles/mcp.css`
- Modify: `tests/renderer-mcp-library.test.js`

**Interfaces:**
- Consumes: `window.mia.mcp.fetchMarketplace()`
- Consumes: `window.mia.mcp.installTemplate(templateId, values)`
- Consumes: `window.mia.mcp.runManagedAction(id, action, values)`
- Produces UI behavior:
  - Template cards show `连接`, not `安装`.
  - Native required fields render inside a modal.
  - Secret fields use `<input type="password">`.
  - Managed xiaohongshu renders action buttons for install/login/start/test.
  - Raw commands are hidden unless the user opens advanced diagnostics.
  - Installed cards explain next action without saying the user must run commands.

- [ ] **Step 1: Add failing renderer tests**

Append to `tests/renderer-mcp-library.test.js` using the existing `createMcpHarness()` and `flushAsync()` helpers:

```js
test("marketplace template cards open a no-command connection wizard", async () => {
  const calls = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "marketplace",
      servers: [],
      templates: [{
        id: "github",
        name: "GitHub MCP",
        managementMode: "native",
        description: "GitHub",
        category: "开发",
        transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {} },
        requiredInputs: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub Personal Access Token", secret: true, target: "env", required: true }]
      }],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      installTemplate: async (id, values) => {
        calls.push({ id, values });
        return { success: true, data: { id: "mcp_github", name: "GitHub MCP", enabled: true, status: "connected", transport: { type: "stdio" } } };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();
  harness.els.skillCardGrid.querySelector('[data-mcp-action="connect-template"]').click();

  const form = harness.document.body.querySelector("[data-mcp-template-form]");
  assert.match(form.innerHTML, /GitHub Personal Access Token/);
  assert.equal(form.querySelector('input[name="GITHUB_PERSONAL_ACCESS_TOKEN"]').getAttribute("type"), "password");
  assert.doesNotMatch(form.innerHTML, /npx -y/);

  form.querySelector('input[name="GITHUB_PERSONAL_ACCESS_TOKEN"]').value = "ghp_secret";
  form.dispatch("submit");
  await flushAsync();

  assert.deepEqual(calls, [{ id: "github", values: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" } }]);
});

test("managed installed xiaohongshu card exposes app actions instead of setup commands", async () => {
  const actions = [];
  const state = {
    skillFilter: "",
    mcp: {
      activeTab: "installed",
      servers: [{
        id: "mcp_xhs",
        name: "小红书 MCP",
        nativeName: "xiaohongshu",
        managementMode: "managed",
        enabled: false,
        status: "disconnected",
        transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
        managedRuntime: { connectorId: "xiaohongshu", state: "installed", expectedToolCount: 13 },
        connectionWizard: {
          state: "ready_to_test",
          nextAction: "test",
          message: "Mia 已启动服务，可以检测。",
          actions: [{ id: "test", label: "检测并启用" }]
        },
        setupCommands: ["go run cmd/login/main.go", "go run ."],
        tools: []
      }],
      templates: [],
      loaded: true,
      loadAttempted: true,
      loading: false,
      error: "",
      serverError: "",
      templateError: ""
    }
  };
  const harness = createMcpHarness({
    state,
    mcpOverrides: {
      runManagedAction: async (id, action) => {
        actions.push([id, action]);
        return { success: true, data: { id, name: "小红书 MCP", enabled: true, status: "connected", transport: { type: "http" } } };
      }
    }
  });

  harness.context.window.miaMcpLibrary.renderMcpLibrary();

  assert.match(harness.els.skillCardGrid.innerHTML, /检测并启用/);
  assert.doesNotMatch(harness.els.skillCardGrid.innerHTML, /go run/);
  harness.els.skillCardGrid.querySelector('[data-mcp-managed-action="test"]').click();
  await flushAsync();

  assert.deepEqual(actions, [["mcp_xhs", "test"]]);
});
```

- [ ] **Step 2: Run renderer tests to verify they fail**

Run:

```bash
node --test tests/renderer-mcp-library.test.js
```

Expected output includes:

```text
not ok
connect-template
```

- [ ] **Step 3: Add wizard state and template field helpers**

In `src/renderer/mcp/mcp-library.js`, extend default MCP state:

```js
        templateWizardOpen: false,
        templateWizardBusy: false,
        activeTemplateId: "",
        managedBusyKey: ""
```

Add helper functions near `renderTemplateCard`:

```js
  function requiredInputHtml(field = {}) {
    const key = escapeHtml(field.key || "");
    const label = escapeHtml(field.label || field.key || "");
    const type = field.secret ? "password" : "text";
    return `<label>${label}<input name="${key}" type="${type}" autocomplete="off" ${field.required === false ? "" : "required"}></label>`;
  }

  function advancedDiagnosticsHtml(item = {}) {
    const transport = item.transport || {};
    if (transport.type !== "stdio" || !transport.command) return "";
    const command = [transport.command, ...(transport.args || [])].filter(Boolean).join(" ");
    return `
      <details class="mcp-advanced-diagnostics">
        <summary>高级诊断</summary>
        <code>${escapeHtml(command)}</code>
      </details>
    `;
  }
```

- [ ] **Step 4: Change template card action from install to connect**

In `renderTemplateCard(template)`, replace the action button with:

```js
          <button class="mcp-action-button mcp-action-primary" type="button" data-mcp-action="connect-template" data-mcp-template="${escapeHtml(template.id || "")}">连接</button>
```

Do not render `advancedDiagnosticsHtml(template)` on the marketplace card. Commands stay out of the default marketplace surface.

- [ ] **Step 5: Add connection wizard modal**

Add this function in `src/renderer/mcp/mcp-library.js`:

```js
  function openTemplateWizard(template) {
    if (typeof document === "undefined" || !document.body || !template) return;
    const mcp = mcpState();
    const overlay = document.createElement("section");
    overlay.className = "mcp-dialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", `连接 ${template.name || template.id || "MCP"}`);
    const fields = Array.isArray(template.requiredInputs) ? template.requiredInputs : [];
    const managed = template.managementMode === "managed";
    overlay.innerHTML = `
      <div class="mcp-dialog-backdrop" data-mcp-close></div>
      <form class="mcp-dialog-panel" data-mcp-template-form>
        <header class="mcp-dialog-head">
          <h2>${escapeHtml(template.name || template.id || "MCP 服务")}</h2>
          <button type="button" data-mcp-close aria-label="关闭">×</button>
        </header>
        <p class="mcp-dialog-copy">${escapeHtml(template.description || "")}</p>
        ${fields.map((field) => requiredInputHtml(field)).join("")}
        ${managed ? `<p class="mcp-dialog-copy">${escapeHtml(template.connectionWizard?.message || "Mia 会管理这个 MCP 的安装、登录、启动和检测。")}</p>` : ""}
        <footer class="mcp-dialog-actions">
          <button type="button" data-mcp-close>取消</button>
          <button type="submit">${managed ? "添加到 Mia" : "检测并启用"}</button>
        </footer>
      </form>
    `;
    if (!appendDialog(overlay)) return;
    mcp.templateWizardOpen = true;
    mcp.activeTemplateId = template.id || "";
    const form = overlay.querySelector("[data-mcp-template-form]");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const values = {};
      fields.forEach((field) => {
        values[field.key] = String(data.get(field.key) || "").trim();
      });
      const result = await window.mia.mcp.installTemplate(template.id, values);
      if (!result?.success) {
        alertText(`连接失败：${result?.error || "未知错误"}`);
        return;
      }
      mcp.activeTab = "installed";
      closeActiveDialog();
      await loadMcpServers({ force: true });
    });
  }
```

- [ ] **Step 6: Render managed wizard actions on installed cards**

Add helper:

```js
  function managedActionHtml(server = {}) {
    if (server.managementMode !== "managed") return "";
    const actions = Array.isArray(server.connectionWizard?.actions) ? server.connectionWizard.actions : [];
    if (!actions.length) return "";
    const busyKey = mcpState().managedBusyKey;
    return `
      <div class="mcp-managed-actions">
        <p>${escapeHtml(server.connectionWizard?.message || "")}</p>
        <div class="mcp-action-strip">
          ${actions.map((action) => {
            const key = `${server.id}:${action.id}`;
            const busy = busyKey === key;
            return `<button class="mcp-action-button ${action.id === server.connectionWizard?.nextAction ? "mcp-action-primary" : "mcp-action-secondary"}" type="button" data-mcp-managed-action="${escapeHtml(action.id)}" data-mcp-id="${escapeHtml(server.id || "")}" ${busy ? "disabled" : ""}>${escapeHtml(busy ? "处理中..." : action.label || action.id)}</button>`;
          }).join("")}
        </div>
      </div>
    `;
  }
```

In `renderServerCard(server)`, replace `renderServerSetupGuide(server)` with:

```js
        ${managedActionHtml(server)}
        ${advancedDiagnosticsHtml(server)}
```

Remove default rendering of `setupCommands` from installed cards. Keep the custom edit form available for custom MCP.

- [ ] **Step 7: Wire action handlers**

Add:

```js
  async function handleManagedAction(id, action) {
    const mcp = mcpState();
    if (!window.mia?.mcp?.runManagedAction) {
      alertText("MCP 托管操作暂不可用");
      return;
    }
    mcp.managedBusyKey = `${id}:${action}`;
    renderMcpLibrary();
    try {
      const result = await window.mia.mcp.runManagedAction(id, action, {});
      if (!result?.success) alertText(`操作失败：${result?.error || "未知错误"}`);
      await loadMcpServers({ force: true });
    } finally {
      mcp.managedBusyKey = "";
      renderMcpLibrary();
    }
  }
```

Update `bindMcpActionHandlers()` to bind managed buttons:

```js
    els.skillCardGrid.querySelectorAll("[data-mcp-managed-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (button.disabled) return;
        handleManagedAction(button.dataset.mcpId || "", button.dataset.mcpManagedAction || "");
      });
    });
```

Update `handleMcpAction`:

```js
    if (action === "connect-template") return openTemplateWizard(mcpState().templates.find((template) => template.id === id));
```

Keep `installTemplate(id)` only as a compatibility helper if another button still calls `install`.

- [ ] **Step 8: Add CSS for the wizard**

Append to `src/renderer/styles/mcp.css`:

```css
.mcp-dialog-copy {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
}

.mcp-managed-actions {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
}

.mcp-managed-actions p {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
}

.mcp-advanced-diagnostics {
  font-size: 12px;
  color: var(--muted);
}

.mcp-advanced-diagnostics code {
  display: block;
  margin-top: 6px;
  overflow-x: auto;
  white-space: nowrap;
}
```

If the file uses different CSS variables, use the existing MCP card variable names from nearby rules and keep the same dimensions.

- [ ] **Step 9: Run renderer tests**

Run:

```bash
node --test tests/renderer-mcp-library.test.js
```

Expected output includes:

```text
# pass
```

- [ ] **Step 10: Commit**

Run:

```bash
git add src/renderer/mcp/mcp-library.js src/renderer/styles/mcp.css tests/renderer-mcp-library.test.js
git commit -m "feat: add mcp connection wizard"
```

Expected output includes:

```text
[main
```

---

### Task 8: End-To-End Cleanup And Verification

**Files:**
- Verify: `src/core/mcp/catalog.js`
- Verify: `src/core/mcp/service.js`
- Verify: `src/renderer/mcp/mcp-library.js`
- Verify: `tests/*.test.js`

**Interfaces:**
- Consumes all previous task interfaces.
- Produces a clean test run and a codebase with no old external-assisted built-in marketplace remnants.

- [ ] **Step 1: Run the focused MCP suite**

Run:

```bash
node --test \
  tests/core-mcp-catalog.test.js \
  tests/core-mcp-records.test.js \
  tests/core-mcp-managed-connector-supervisor.test.js \
  tests/core-mcp-managed-service.test.js \
  tests/core-mcp-service.test.js \
  tests/mcp-engine-sync.test.js \
  tests/mcp-ipc-preload.test.js \
  tests/renderer-mcp-library.test.js \
  tests/hermes-chat-adapter.test.js \
  tests/claude-code-chat-adapter.test.js \
  tests/codex-chat-adapter.test.js \
  tests/openclaw-chat-adapter.test.js
```

Expected output includes:

```text
# pass
```

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected output includes:

```text
# pass
```

- [ ] **Step 3: Scan for forbidden built-in categories and old XHS copy**

Run:

```bash
rg -n "external-assisted|external_assisted|Mia 只负责连接|xhs-local-http|chrome-devtools-cdp" src/core/mcp src/renderer/mcp tests
```

Expected output:

```text
```

- [ ] **Step 4: Scan marketplace catalog for deferred Lobster entries**

Run:

```bash
rg -n "notion|slack|gmail|google drive|google calendar|todoist|canva|gitlab" src/core/mcp/catalog.js
```

Expected output:

```text
```

- [ ] **Step 5: Verify no secrets leak in public projections**

Run:

```bash
node --test tests/core-mcp-records.test.js tests/core-mcp-managed-service.test.js
```

Expected output includes:

```text
# pass
```

The tests must include assertions that raw values such as `ghp_secret`, `TAVILY_API_KEY=value`, and managed `installDir` do not appear in public records.

- [ ] **Step 6: Commit final verification changes if any were needed**

If Step 1 through Step 5 required code or test edits, run:

```bash
git add src/core/mcp src/renderer/mcp src/shared/ipc-channels.js src/main/ipc/mcp-ipc.js src/preload.js tests
git commit -m "test: verify managed mcp runtime"
```

Expected output includes:

```text
[main
```

If no edits were needed, do not create an empty commit.
