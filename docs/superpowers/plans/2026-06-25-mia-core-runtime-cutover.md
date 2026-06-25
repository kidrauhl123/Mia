# Mia Core Runtime Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mia Core the single local runtime owner for model resolution, engine dispatch, and background process control, with `daemon` retained only as a legacy compatibility implementation detail.

**Architecture:** Introduce a `src/main/mia-core/` boundary that owns runtime profile resolution first, then routes Hermes, OpenClaw, and Codex through the same resolver. Renderer and cloud bot bindings will store stable provider/model references, while Core resolves those references into engine-native config, tokens, base URLs, and transport choices.

**Tech Stack:** Electron main process, Node.js CommonJS, vanilla renderer modules, `node:test`, Hermes runtime config YAML, OpenClaw CLI/ACP, Codex app-server runner.

## Global Constraints

- New domain code must say `Mia Core`; new `daemon` references are allowed only in compatibility wrappers, old env aliases, and tests that assert backward compatibility.
- Renderer bot runtime bindings must not store API keys, base URLs, or engine-native provider config. They store references such as `providerConnectionId`, `modelProfileId`, and `model`.
- Core is the only component that resolves provider/model references into `apiKey`, `baseUrl`, `apiMode`, or engine-native provider patches.
- Hermes, OpenClaw, and Codex must use the same Core model resolver.
- Existing saved bindings with `{ model: "mia-auto" }` and no provider metadata remain compatible.
- Do not revert unrelated dirty files: `src/renderer/index.html`, `src/renderer/styles.css`, `tests/renderer-shell.test.js`, `.playwright-cli/`, `output/`.
- Tests must use temp runtime directories and must not write real `~/Library/Application Support/Mia`.
- Use AION as the concrete reference implementation for provider/model ownership. Tasks that touch model/provider runtime must compare against the AION files listed in "AION Reference Anchors" before coding.

---

## File Structure

- Create `src/main/mia-core/model-runtime-resolver.js`
  - Owns AION-style provider/model resolution.
  - Consumes cloud account state, provider connections, model settings, and runtime config references.
  - Produces normalized runtime profiles for Hermes/OpenClaw/Codex.

- Create `src/main/mia-core/runtime-service.js`
  - Owns turn-level Core orchestration after adapter wiring is stable.
  - Extracts the bot/runtime merge currently embedded in `src/main.js`.

- Create `src/main/mia-core/local-process-control.js`
  - Exposes Core-named process control APIs.
  - Delegates to existing daemon modules during the compatibility window.

- Modify `src/main.js`
  - Constructs the Mia Core resolver and runtime service.
  - Stops defining provider/model resolution as loose top-level functions.
  - Imports Core process control names instead of daemon names.

- Modify `src/main/hermes-chat-adapter.js`
  - Uses Core model runtime resolution for every turn.
  - Writes Hermes runtime config from resolved Core profiles.

- Modify `src/main/openclaw-chat-adapter.js`
  - Uses Core-resolved profile metadata for Mia managed OpenClaw.
  - Keeps ACP explicit-only for Mia managed profiles unless the user configured Gateway transport.

- Modify `src/main/codex-chat-adapter.js`
  - Uses Core-resolved profiles before creating the Mia Codex proxy.

- Modify `src/main/runtime-config-normalizer.js`
  - Accepts new binding references.
  - Keeps old fields as read compatibility.
  - Stops normalizing renderer-provided engine-native connection fields as the preferred path.

- Modify `src/renderer/bot/bot-commands.js`
  - Saves model references, not provider secrets or engine-native config.
  - Keeps model selector display behavior intact.

- Create `docs/adr/2026-06-25-mia-core-runtime-owner.md`
  - Supersedes the daemon-first phase plan.

- Modify:
  - `docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md`
  - `docs/superpowers/plans/2026-06-24-mia-core-phase1.md`
  - `docs/superpowers/plans/2026-06-24-mia-core-phase1-implementation.md`
  - Add a superseded banner pointing to the new ADR/plan.

- Create tests:
  - `tests/mia-core-model-runtime-resolver.test.js`
  - `tests/mia-core-runtime-service.test.js`
  - `tests/mia-core-local-process-control.test.js`

- Modify tests:
  - `tests/runtime-config-normalizer.test.js`
  - `tests/bot-commands.test.js`
  - `tests/hermes-chat-adapter.test.js`
  - `tests/openclaw-chat-adapter.test.js`
  - `tests/codex-chat-adapter.test.js`
  - `tests/engine-runtime-config-service.test.js`
  - `tests/main-bot-runtime-dispatcher.test.js`

## AION Reference Anchors

Use these files as implementation references, not just conceptual inspiration:

- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-common/src/types.rs`
  - `ProviderWithModel { provider_id, model, use_model }` is the reference shape for Mia's Core profile reference.

- `/Users/jung/GitHub/mia-reference/AionUi/packages/desktop/src/common/adapter/apiModelMapper.ts`
  - `toApiModel()` maps a full frontend provider object down to `{ provider_id, model }`.
  - `fromApiModel()` reconstructs only display-safe frontend shape and does not restore secrets.

- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-conversation/src/task_options.rs`
  - Central parser makes interactive and cron paths derive the same provider/model.
  - Loose legacy parsing is allowed, but stale vendor-label fallback is explicitly rejected.

- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/factory/aionrs.rs`
  - Runtime factory loads provider config by `provider_id`, decrypts the key, resolves `use_model || model`, maps provider protocol, and only then builds the agent config.

- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-system/src/model_fetcher/mod.rs`
  - Model fetch loads provider config by ID and reports missing providers as provider-not-found errors.

Concrete rules to mirror in Mia:

- Renderer/runtime binding sends a compact profile reference, not provider secrets or base URL.
- Core re-resolves the provider row at execution time, then creates engine-native config.
- Interactive, cloud-triggered, and scheduled/background turns must share the same parser/resolver so they cannot diverge on provider identity.

---

### Task 1: Lock The Core-First Decision

**Files:**
- Create: `docs/adr/2026-06-25-mia-core-runtime-owner.md`
- Modify: `docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md`
- Modify: `docs/superpowers/plans/2026-06-24-mia-core-phase1.md`
- Modify: `docs/superpowers/plans/2026-06-24-mia-core-phase1-implementation.md`

**Interfaces:**
- Produces: A written architecture rule: `Mia Core is the local runtime owner; daemon is a legacy implementation detail`.
- Produces: A compatibility rule: old `MIA_DAEMON` env/LaunchAgent names may remain only as aliases until packaging migration.

- [ ] **Step 1: Create the ADR**

Add `docs/adr/2026-06-25-mia-core-runtime-owner.md`:

```markdown
# ADR 2026-06-25: Mia Core Owns Local Runtime

## Status

Accepted.

## Context

Mia currently has two runtime paths:

- global settings and native engine configuration;
- bot runtime bindings and per-turn cloud/desktop invocation configuration.

This split caused Hermes to receive `model=mia-auto` without the matching Mia provider identity, and caused OpenClaw to use ACP Gateway transport when Mia-managed local transport was the available path.

The previous Mia Core Phase 1 direction kept the daemon single-owner model as the primary runtime abstraction. That is no longer the target architecture.

## Decision

Mia Core is the single local runtime owner.

Renderer, cloud bridge, scheduler, and bot runtime binding code must call Mia Core contracts. They must not assemble engine-native provider configuration directly.

`daemon` remains only as a legacy process-control implementation detail while packaging and launch behavior migrate. New domain APIs, docs, and runtime contracts use Mia Core naming.

## Consequences

- Provider/model resolution moves into `src/main/mia-core/model-runtime-resolver.js`.
- Bot runtime bindings store references: `providerConnectionId`, `modelProfileId`, `model`, `agentEngine`, `effortLevel`, `permissionMode`, and device routing fields.
- Hermes, OpenClaw, and Codex all receive resolved model runtime profiles from Mia Core.
- Existing saved bindings with `model: "mia-auto"` continue to work through compatibility inference.
- Existing env aliases such as `MIA_DAEMON` continue to work until process packaging is renamed.
```

- [ ] **Step 2: Add superseded banners to old Phase 1 docs**

Insert this banner directly under each old document title:

```markdown
> Superseded on 2026-06-25 by `docs/adr/2026-06-25-mia-core-runtime-owner.md` and `docs/superpowers/plans/2026-06-25-mia-core-runtime-cutover.md`.
> This document is retained for historical context only; do not implement new daemon-first work from it.
```

- [ ] **Step 3: Verify the docs no longer present daemon-first as active**

Run:

```bash
rg -n "do not remove daemon|keeps existing daemon|daemon single-owner|daemon-first" docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md docs/superpowers/plans/2026-06-24-mia-core-phase1.md docs/superpowers/plans/2026-06-24-mia-core-phase1-implementation.md
```

Expected: matches are inside superseded historical text only, and each file has the superseded banner.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/2026-06-25-mia-core-runtime-owner.md docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md docs/superpowers/plans/2026-06-24-mia-core-phase1.md docs/superpowers/plans/2026-06-24-mia-core-phase1-implementation.md
git commit -m "docs: make mia core the runtime owner"
```

---

### Task 2: Add Core Model Runtime Resolver

**Files:**
- Create: `src/main/mia-core/model-runtime-resolver.js`
- Create: `tests/mia-core-model-runtime-resolver.test.js`

**Interfaces:**
- Produces:

```js
function createMiaCoreModelRuntimeResolver(deps)
```

- Produces:

```js
resolver.resolveModelRuntime(config, context)
```

- Produces:

```js
resolver.resolveMiaManagedModelSettings(settings)
```

- Produces:

```js
function isMiaManagedRuntime(runtime)
```

- `resolveModelRuntime()` returns `null` for native CLI defaults that do not require Core provider config.
- `resolveModelRuntime()` returns this shape for resolved profiles:

```js
{
  provider: "mia",
  providerConnectionId: "mia",
  providerLabel: "Mia",
  authType: "mia_account",
  model: "mia-auto",
  modelProfileId: "mia:mia-auto",
  apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
  apiKey: "cloud-token",
  baseUrl: "https://mia.example/api/me/model-proxy/v1",
  anthropicBaseUrl: "https://mia.example/api/me/model-proxy",
  apiMode: "chat_completions",
  managedByMia: true,
  source: "mia-core"
}
```

- [ ] **Step 1: Write failing resolver tests**

Create `tests/mia-core-model-runtime-resolver.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createMiaCoreModelRuntimeResolver,
  isMiaManagedRuntime
} = require("../src/main/mia-core/model-runtime-resolver.js");

function createResolver(overrides = {}) {
  return createMiaCoreModelRuntimeResolver({
    cloudStatus: () => ({ enabled: true, token: "cloud-token", url: "https://mia.example/" }),
    normalizeCloudUrl: (value) => String(value || "").replace(/\/+$/, ""),
    providerConnection: (id) => {
      if (id === "deepseek") {
        return {
          provider: "deepseek",
          providerLabel: "DeepSeek",
          authType: "api_key",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          apiKey: "deepseek-token",
          baseUrl: "https://api.deepseek.com/v1",
          apiMode: "chat_completions"
        };
      }
      return null;
    },
    modelSettings: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    ...overrides
  });
}

test("resolves profileless mia-auto binding through Mia Cloud", () => {
  const resolver = createResolver();

  const runtime = resolver.resolveModelRuntime({ model: "mia-auto" }, { engine: "hermes" });

  assert.equal(runtime.provider, "mia");
  assert.equal(runtime.providerConnectionId, "mia");
  assert.equal(runtime.model, "mia-auto");
  assert.equal(runtime.modelProfileId, "mia:mia-auto");
  assert.equal(runtime.apiKey, "cloud-token");
  assert.equal(runtime.baseUrl, "https://mia.example/api/me/model-proxy/v1");
  assert.equal(runtime.anthropicBaseUrl, "https://mia.example/api/me/model-proxy");
  assert.equal(runtime.managedByMia, true);
  assert.equal(isMiaManagedRuntime(runtime), true);
});

test("resolves provider connection references without renderer credentials", () => {
  const resolver = createResolver();

  const runtime = resolver.resolveModelRuntime({
    providerConnectionId: "deepseek",
    model: "deepseek-chat",
    modelProfileId: "deepseek:deepseek-chat"
  }, { engine: "hermes" });

  assert.deepEqual(runtime, {
    provider: "deepseek",
    providerConnectionId: "deepseek",
    providerLabel: "DeepSeek",
    authType: "api_key",
    model: "deepseek-chat",
    modelProfileId: "deepseek:deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiKey: "deepseek-token",
    baseUrl: "https://api.deepseek.com/v1",
    apiMode: "chat_completions",
    managedByMia: false,
    source: "mia-core"
  });
});

test("returns null for native codex default model", () => {
  const resolver = createResolver();

  assert.equal(resolver.resolveModelRuntime({
    providerConnectionId: "codex",
    model: ""
  }, { engine: "codex" }), null);
});

test("requires Mia Cloud login for Mia managed profiles", () => {
  const resolver = createResolver({
    cloudStatus: () => ({ enabled: false, token: "", url: "" })
  });

  assert.throws(
    () => resolver.resolveModelRuntime({ modelProfileId: "mia:mia-auto", model: "mia-auto" }),
    /请先登录 Mia Cloud/
  );
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test tests/mia-core-model-runtime-resolver.test.js
```

Expected: FAIL because `src/main/mia-core/model-runtime-resolver.js` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `src/main/mia-core/model-runtime-resolver.js`:

```js
"use strict";

function firstString(source = {}, keys = []) {
  for (const key of keys) {
    const value = String(source?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function normalizeProfileId(value = "") {
  return String(value || "").trim();
}

function isBuiltinMiaModel(model = "") {
  const id = String(model || "").trim();
  return id === "mia-auto" || id === "mia-default";
}

function isMiaManagedReference(config = {}) {
  const provider = firstString(config, ["providerConnectionId", "provider_connection_id", "provider", "modelProvider", "model_provider"]);
  const authType = firstString(config, ["authType", "auth_type"]);
  const profileId = normalizeProfileId(firstString(config, ["modelProfileId", "model_profile_id", "profileId", "profile_id"]));
  const model = firstString(config, ["model"]);
  return provider === "mia" || authType === "mia_account" || profileId.startsWith("mia:") || isBuiltinMiaModel(model);
}

function isMiaManagedRuntime(runtime = {}) {
  return Boolean(runtime && (runtime.managedByMia === true || runtime.provider === "mia" || runtime.authType === "mia_account"));
}

function createMiaCoreModelRuntimeResolver(deps = {}) {
  const cloudStatus = typeof deps.cloudStatus === "function" ? deps.cloudStatus : () => ({ enabled: false });
  const normalizeCloudUrl = typeof deps.normalizeCloudUrl === "function"
    ? deps.normalizeCloudUrl
    : (value) => String(value || "").replace(/\/+$/, "");
  const providerConnection = typeof deps.providerConnection === "function" ? deps.providerConnection : () => null;
  const modelSettings = typeof deps.modelSettings === "function" ? deps.modelSettings : () => ({});

  function resolveMiaCloud(config = {}) {
    const cloud = cloudStatus(true);
    if (!cloud?.enabled || !cloud.token || !cloud.url) {
      throw new Error("请先登录 Mia Cloud，再使用 Mia 托管模型。");
    }
    const model = firstString(config, ["model"]) || "mia-default";
    const cloudBaseUrl = normalizeCloudUrl(cloud.url);
    return {
      provider: "mia",
      providerConnectionId: "mia",
      providerLabel: firstString(config, ["providerLabel", "provider_label"]) || "Mia",
      authType: "mia_account",
      model,
      modelProfileId: firstString(config, ["modelProfileId", "model_profile_id"]) || `mia:${model}`,
      apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
      apiKey: cloud.token,
      baseUrl: `${cloudBaseUrl}/api/me/model-proxy/v1`,
      anthropicBaseUrl: `${cloudBaseUrl}/api/me/model-proxy`,
      apiMode: firstString(config, ["apiMode", "api_mode"]) || "chat_completions",
      managedByMia: true,
      source: "mia-core"
    };
  }

  function nativeCliDefault(config = {}, context = {}) {
    const engine = String(context?.engine || config.agentEngine || config.agent_engine || "").trim();
    const provider = firstString(config, ["providerConnectionId", "provider_connection_id", "provider"]);
    const model = firstString(config, ["model"]);
    return (engine === "codex" || engine === "claude-code" || engine === "openclaw")
      && (!model || model === "default")
      && (!provider || provider === engine || provider === "codex" || provider === "openclaw" || provider === "claude-code");
  }

  function resolveProviderConnection(config = {}, context = {}) {
    if (nativeCliDefault(config, context)) return null;
    const providerId = firstString(config, ["providerConnectionId", "provider_connection_id", "provider", "modelProvider", "model_provider"]);
    if (!providerId) return null;
    const connection = providerConnection(providerId);
    if (!connection) return null;
    const model = firstString(config, ["model"]) || firstString(modelSettings(), ["model"]);
    return {
      provider: connection.provider || providerId,
      providerConnectionId: connection.provider || providerId,
      providerLabel: connection.providerLabel || connection.provider_label || connection.provider || providerId,
      authType: connection.authType || connection.auth_type || "api_key",
      model,
      modelProfileId: firstString(config, ["modelProfileId", "model_profile_id"]) || (model ? `${providerId}:${model}` : providerId),
      apiKeyEnv: connection.apiKeyEnv || connection.api_key_env || "",
      apiKey: connection.apiKey || connection.api_key || "",
      baseUrl: connection.baseUrl || connection.base_url || "",
      apiMode: connection.apiMode || connection.api_mode || "",
      managedByMia: false,
      source: "mia-core"
    };
  }

  function resolveModelRuntime(config = {}, context = {}) {
    if (!config || typeof config !== "object") return null;
    if (isMiaManagedReference(config)) return resolveMiaCloud(config);
    return resolveProviderConnection(config, context);
  }

  function resolveMiaManagedModelSettings(settings = {}) {
    if (!isMiaManagedReference(settings)) return settings;
    const runtime = resolveMiaCloud(settings);
    return {
      ...settings,
      provider: runtime.provider,
      providerLabel: runtime.providerLabel,
      authType: runtime.authType,
      model: runtime.model,
      modelProfileId: runtime.modelProfileId,
      apiKeyEnv: runtime.apiKeyEnv,
      apiKey: runtime.apiKey,
      baseUrl: runtime.baseUrl,
      apiMode: runtime.apiMode
    };
  }

  return {
    resolveModelRuntime,
    resolveMiaManagedModelSettings
  };
}

module.exports = {
  createMiaCoreModelRuntimeResolver,
  isMiaManagedRuntime
};
```

- [ ] **Step 4: Run the resolver tests**

Run:

```bash
node --test tests/mia-core-model-runtime-resolver.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mia-core/model-runtime-resolver.js tests/mia-core-model-runtime-resolver.test.js
git commit -m "feat: add mia core model resolver"
```

---

### Task 3: Store Runtime Binding References Instead Of Engine Config

**Files:**
- Modify: `src/main/runtime-config-normalizer.js`
- Modify: `src/renderer/bot/bot-commands.js`
- Modify: `tests/runtime-config-normalizer.test.js`
- Modify: `tests/bot-commands.test.js`

**Interfaces:**
- Consumes: `providerConnectionId`, `modelProfileId`, and `model` shape from Task 2.
- Produces: normalized turn runtime config:

```js
{
  agentEngine: "hermes",
  deviceId: "device_123",
  deviceName: "MacBook",
  providerConnectionId: "mia",
  modelProfileId: "mia:mia-auto",
  model: "mia-auto",
  effortLevel: "medium",
  permissionMode: "ask"
}
```

- Backward compatible input fields: `provider`, `provider_label`, `auth_type`, `base_url`, `api_mode`, and `api_key_env`.
- Preferred output fields: `providerConnectionId`, `modelProfileId`, `model`; no renderer-provided `baseUrl`, `apiKeyEnv`, `apiMode`, `providerLabel`, or `authType` unless the caller explicitly passes legacy data and the test is asserting compatibility.

- [ ] **Step 1: Update normalizer failing tests**

Add to `tests/runtime-config-normalizer.test.js`:

```js
test("normalizeTurnRuntimeConfig prefers Core profile references", () => {
  assert.deepEqual(normalizeTurnRuntimeConfig({
    provider_connection_id: "mia",
    model_profile_id: "mia:mia-auto",
    model: "mia-auto",
    agent_engine: "openclaw",
    device_id: "mac-1",
    device_name: "MacBook Pro",
    effort_level: "medium",
    permission_mode: "ask",
    base_url: "https://renderer-should-not-own-this.example",
    api_key_env: "RENDERER_SHOULD_NOT_OWN_THIS"
  }), {
    agentEngine: "openclaw",
    deviceId: "mac-1",
    deviceName: "MacBook Pro",
    providerConnectionId: "mia",
    modelProfileId: "mia:mia-auto",
    model: "mia-auto",
    effortLevel: "medium",
    permissionMode: "ask"
  });
});
```

- [ ] **Step 2: Update bot command failing tests**

Add or replace assertions in `tests/bot-commands.test.js` so Mia Auto desktop binding expects references:

```js
assert.deepEqual(binding.config, {
  agentEngine: "hermes",
  deviceId: "mac-1",
  deviceName: "MacBook Pro",
  providerConnectionId: "mia",
  modelProfileId: "mia:mia-auto",
  model: "mia-auto",
  effortLevel: "medium",
  permissionMode: "ask",
  modelEntries: [
    {
      value: "mia-auto",
      label: "Auto",
      model: "mia-auto",
      provider: "mia",
      providerLabel: "Mia",
      authType: "mia_account",
      modelProfileId: "mia:mia-auto"
    }
  ]
});
assert.equal(Object.hasOwn(binding.config, "baseUrl"), false);
assert.equal(Object.hasOwn(binding.config, "apiKeyEnv"), false);
assert.equal(Object.hasOwn(binding.config, "apiMode"), false);
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
node --test tests/runtime-config-normalizer.test.js tests/bot-commands.test.js
```

Expected: FAIL because `providerConnectionId`, `agentEngine`, device fields, and secret-stripping are not fully normalized yet.

- [ ] **Step 4: Update `normalizeTurnRuntimeConfig()`**

Modify `src/main/runtime-config-normalizer.js`:

```js
const fields = [
  ["agentEngine", ["agentEngine", "agent_engine"]],
  ["deviceId", ["deviceId", "device_id", "targetDeviceId", "target_device_id"]],
  ["deviceName", ["deviceName", "device_name", "targetDeviceName", "target_device_name"]],
  ["model", ["model"]],
  ["providerConnectionId", ["providerConnectionId", "provider_connection_id", "provider", "modelProvider", "model_provider"]],
  ["modelProfileId", ["modelProfileId", "model_profile_id"]],
  ["effortLevel", ["effortLevel", "effort_level"]],
  ["permissionMode", ["permissionMode", "permission_mode"]]
];
```

Then remove preferred normalization of these renderer-provided engine-native fields:

```js
providerLabel
authType
apiKeyEnv
baseUrl
apiMode
```

Keep read compatibility inside `model-runtime-resolver.js`, not in normalized bot turn config.

- [ ] **Step 5: Update renderer binding patch generation**

In `src/renderer/bot/bot-commands.js`, replace metadata patch generation with reference patch generation:

```js
function runtimeProfilePatch(entry = {}, fallbackValue = "") {
  const provider = String(entry.provider || "").trim();
  const model = String(entry.model || fallbackValue || "").trim();
  const patch = { model };
  if (provider) patch.providerConnectionId = provider;
  const profileId = String(entry.modelProfileId || entry.model_profile_id || "").trim();
  if (profileId) patch.modelProfileId = profileId;
  else if (provider && model) patch.modelProfileId = `${provider}:${model}`;
  return patch;
}
```

Use `runtimeProfilePatch()` inside `patchForRuntimeField("model", ...)` and inside `desktopLocalRuntimeConfig()` for both Hermes and external engines.

- [ ] **Step 6: Run tests**

Run:

```bash
node --test tests/runtime-config-normalizer.test.js tests/bot-commands.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/runtime-config-normalizer.js src/renderer/bot/bot-commands.js tests/runtime-config-normalizer.test.js tests/bot-commands.test.js
git commit -m "feat: store core model profile references"
```

---

### Task 4: Wire Hermes, OpenClaw, And Codex Through Core Resolver

**Files:**
- Modify: `src/main.js`
- Modify: `src/main/hermes-chat-adapter.js`
- Modify: `src/main/openclaw-chat-adapter.js`
- Modify: `src/main/codex-chat-adapter.js`
- Modify: `tests/hermes-chat-adapter.test.js`
- Modify: `tests/openclaw-chat-adapter.test.js`
- Modify: `tests/codex-chat-adapter.test.js`
- Modify: `tests/engine-runtime-config-service.test.js`

**Interfaces:**
- Consumes: `createMiaCoreModelRuntimeResolver()` from Task 2.
- Consumes: binding reference shape from Task 3.
- Produces adapter dependency name:

```js
resolveModelRuntime(config, context)
```

- Keeps compatibility dependency:

```js
resolveManagedModelRuntime(config, context)
```

only as a short-lived alias in tests until all adapters are updated.

- [ ] **Step 1: Add adapter tests for Core resolver dependency**

Update Hermes tests to inject `resolveModelRuntime`:

```js
const writes = [];
const adapter = createHermesChatAdapter({
  // existing dependencies...
  resolveModelRuntime: () => ({
    provider: "mia",
    providerConnectionId: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    model: "mia-auto",
    modelProfileId: "mia:mia-auto",
    apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
    apiKey: "cloud-token",
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiMode: "chat_completions",
    managedByMia: true,
    source: "mia-core"
  }),
  writeModelRuntimeConfig: (settings) => writes.push(settings)
});
```

Expected assertion:

```js
assert.equal(writes[0].provider, "mia");
assert.equal(writes[0].model, "mia-auto");
assert.equal(writes[0].baseUrl, "https://mia.example/api/me/model-proxy/v1");
```

Update OpenClaw tests so Mia profile uses local transport by Core runtime:

```js
resolveModelRuntime: () => ({
  provider: "mia",
  providerConnectionId: "mia",
  model: "mia-auto",
  modelProfileId: "mia:mia-auto",
  apiKey: "cloud-token",
  baseUrl: "https://mia.example/api/me/model-proxy/v1",
  managedByMia: true
})
```

Expected OpenClaw command still includes:

```js
["agent", "--message", "hello", "--model", "mia/mia-auto", "--local"]
```

Update Codex tests so `ensureMiaCodexProxy` receives the Core runtime object.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --test tests/hermes-chat-adapter.test.js tests/openclaw-chat-adapter.test.js tests/codex-chat-adapter.test.js
```

Expected: FAIL because adapters still look for `resolveManagedModelRuntime`.

- [ ] **Step 3: Construct Core resolver in `src/main.js`**

Add import:

```js
const {
  createMiaCoreModelRuntimeResolver,
  isMiaManagedRuntime
} = require("./main/mia-core/model-runtime-resolver.js");
```

Create resolver after `providerConnections` and `settingsStore` are initialized:

```js
const miaCoreModelRuntimeResolver = createMiaCoreModelRuntimeResolver({
  cloudStatus,
  normalizeCloudUrl: settingsStore.normalizeCloudUrl,
  providerConnection: (provider) => providerConnections.get(provider),
  modelSettings
});

function resolveModelRuntime(config = {}, context = {}) {
  return miaCoreModelRuntimeResolver.resolveModelRuntime(config, context);
}

function resolveMiaManagedModelSettings(settings = {}) {
  return miaCoreModelRuntimeResolver.resolveMiaManagedModelSettings(settings);
}
```

Delete the old top-level implementations of `resolveManagedModelRuntime()` and `resolveMiaManagedModelSettings()`.

Temporarily keep this alias only if a test or adapter still requires it during the same task:

```js
function resolveManagedModelRuntime(config = {}, context = {}) {
  const runtime = resolveModelRuntime(config, context);
  return isMiaManagedRuntime(runtime) ? runtime : null;
}
```

- [ ] **Step 4: Update Hermes adapter**

In `src/main/hermes-chat-adapter.js`, change dependency:

```js
const resolveModelRuntime = deps.resolveModelRuntime || deps.resolveManagedModelRuntime || (() => null);
```

In `resolveTurnRuntimeConfig()`, use:

```js
const resolved = resolveModelRuntime(merged, { engine: "hermes", bot });
if (!resolved) return runtimeConfig;
writeModelRuntimeConfig({
  provider: resolved.provider,
  providerLabel: resolved.providerLabel || resolved.provider,
  authType: resolved.authType || "api_key",
  model: resolved.model,
  apiKeyEnv: resolved.apiKeyEnv || "",
  apiKey: resolved.apiKey || "",
  baseUrl: resolved.baseUrl || "",
  apiMode: resolved.apiMode || ""
});
return {
  ...(runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {}),
  provider: resolved.provider,
  providerConnectionId: resolved.providerConnectionId || resolved.provider,
  modelProfileId: resolved.modelProfileId || "",
  model: resolved.model
};
```

- [ ] **Step 5: Update OpenClaw adapter**

In `src/main/openclaw-chat-adapter.js`, change dependency:

```js
const resolveModelRuntime = deps.resolveModelRuntime || deps.resolveManagedModelRuntime || (() => null);
```

Replace `managedModel?.provider === "mia"` checks with:

```js
const { isMiaManagedRuntime } = require("./mia-core/model-runtime-resolver.js");
```

and:

```js
isMiaManagedRuntime(effectiveRuntime)
```

Keep explicit ACP override:

```js
if (transport === "acp" || transport === "gateway" || transport === "openclaw-acp") return false;
```

- [ ] **Step 6: Update Codex adapter**

In `src/main/codex-chat-adapter.js`, change dependency:

```js
const resolveModelRuntime = deps.resolveModelRuntime || deps.resolveManagedModelRuntime || (() => null);
```

Resolve:

```js
const modelRuntime = resolveModelRuntime(bot.engineConfig || {}, { engine: "codex", bot });
```

Use `isMiaManagedCodexModel(modelRuntime || {})` before `ensureMiaCodexProxy`.

- [ ] **Step 7: Update active adapter factories in `src/main.js`**

Pass the Core resolver into all three:

```js
resolveModelRuntime
```

and remove new usage of `resolveManagedModelRuntime` from factory wiring.

- [ ] **Step 8: Run adapter and config tests**

Run:

```bash
node --test tests/mia-core-model-runtime-resolver.test.js tests/hermes-chat-adapter.test.js tests/openclaw-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/engine-runtime-config-service.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main.js src/main/hermes-chat-adapter.js src/main/openclaw-chat-adapter.js src/main/codex-chat-adapter.js tests/hermes-chat-adapter.test.js tests/openclaw-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/engine-runtime-config-service.test.js
git commit -m "feat: route engine models through mia core"
```

---

### Task 5: Extract Mia Core Turn Runtime Service

**Files:**
- Create: `src/main/mia-core/runtime-service.js`
- Create: `tests/mia-core-runtime-service.test.js`
- Modify: `src/main.js`
- Modify: `tests/main-bot-runtime-dispatcher.test.js`

**Interfaces:**
- Consumes: `normalizeTurnRuntimeConfig()`
- Consumes: `resolveModelRuntime()`
- Produces:

```js
function createMiaCoreRuntimeService(deps)
```

- Produces:

```js
coreRuntime.botWithRuntimeConfig(bot, runtimeConfig, options)
coreRuntime.cloudBotSnapshotForTurn(snapshot, key, runtimeConfig)
coreRuntime.runBotTurn(params)
```

- [ ] **Step 1: Write failing service tests**

Create `tests/mia-core-runtime-service.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createMiaCoreRuntimeService } = require("../src/main/mia-core/runtime-service.js");

test("botWithRuntimeConfig applies normalized Core profile references", () => {
  const service = createMiaCoreRuntimeService({
    normalizeAgentEngine: (value) => value || "hermes",
    enginePermissionStoreTarget: () => "root-mode",
    sendWithChatEngineAdapter: async () => null
  });

  const bot = service.botWithRuntimeConfig(
    { key: "bot-a", engineConfig: { existing: "keep" } },
    {
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto",
      effortLevel: "medium",
      permissionMode: "ask"
    },
    { agentEngine: "hermes" }
  );

  assert.deepEqual(bot.engineConfig, {
    existing: "keep",
    providerConnectionId: "mia",
    modelProfileId: "mia:mia-auto",
    model: "mia-auto",
    effortLevel: "medium",
    permissionMode: "ask"
  });
});

test("cloudBotSnapshotForTurn accepts runtime-selected engine", () => {
  const service = createMiaCoreRuntimeService({
    normalizeAgentEngine: (value) => value === "open-claw" ? "openclaw" : (value || "hermes"),
    enginePermissionStoreTarget: () => "root-mode",
    sendWithChatEngineAdapter: async () => null
  });

  const bot = service.cloudBotSnapshotForTurn(
    { key: "bot-a", name: "Bot A" },
    "bot-a",
    { agentEngine: "open-claw" }
  );

  assert.equal(bot.agentEngine, "openclaw");
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test tests/mia-core-runtime-service.test.js
```

Expected: FAIL because `runtime-service.js` does not exist.

- [ ] **Step 3: Implement `runtime-service.js` by extracting pure helpers**

Create `src/main/mia-core/runtime-service.js`:

```js
"use strict";

function createMiaCoreRuntimeService(deps = {}) {
  const normalizeAgentEngine = typeof deps.normalizeAgentEngine === "function"
    ? deps.normalizeAgentEngine
    : (value) => String(value || "hermes").trim() || "hermes";
  const enginePermissionStoreTarget = typeof deps.enginePermissionStoreTarget === "function"
    ? deps.enginePermissionStoreTarget
    : () => "root-mode";

  function botWithRuntimeConfig(bot, runtimeConfig = {}, options = {}) {
    if (!runtimeConfig || !Object.keys(runtimeConfig).length) return bot;
    const agentEngine = normalizeAgentEngine(
      options.agentEngine || bot?.agentEngine || bot?.agent_engine || "hermes",
      "hermes"
    );
    const configForEngine = { ...runtimeConfig };
    if (enginePermissionStoreTarget(agentEngine) !== "root-mode") delete configForEngine.permissionMode;
    if (!Object.keys(configForEngine).length) return bot;
    return {
      ...bot,
      engineConfig: {
        ...(bot.engineConfig || bot.engine_config || {}),
        ...configForEngine
      }
    };
  }

  function cloudBotSnapshotForTurn(snapshot = null, key = "", runtimeConfig = null) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const botKey = String(snapshot.key || snapshot.id || key || "").trim();
    if (!botKey) return null;
    const requested = String(key || "").trim();
    if (requested && botKey !== requested) return null;
    const agentEngine = normalizeAgentEngine(
      snapshot.agentEngine || snapshot.agent_engine || snapshot.engine || runtimeConfig?.agentEngine || runtimeConfig?.agent_engine,
      "hermes"
    );
    return {
      ...snapshot,
      key: botKey,
      id: String(snapshot.id || botKey),
      name: String(snapshot.name || snapshot.displayName || snapshot.display_name || botKey),
      agentEngine,
      capabilities: snapshot.capabilities && typeof snapshot.capabilities === "object" ? snapshot.capabilities : {}
    };
  }

  return {
    botWithRuntimeConfig,
    cloudBotSnapshotForTurn
  };
}

module.exports = {
  createMiaCoreRuntimeService
};
```

- [ ] **Step 4: Wire pure helpers in `src/main.js`**

Import:

```js
const { createMiaCoreRuntimeService } = require("./main/mia-core/runtime-service.js");
```

Create:

```js
const miaCoreRuntime = createMiaCoreRuntimeService({
  normalizeAgentEngine,
  enginePermissionStoreTarget
});
```

Replace calls:

```js
cloudBotSnapshotForTurn(...)
botWithRuntimeConfig(...)
```

with:

```js
miaCoreRuntime.cloudBotSnapshotForTurn(...)
miaCoreRuntime.botWithRuntimeConfig(...)
```

Keep the old local functions only until all references are replaced, then delete them.

- [ ] **Step 5: Keep cloud dispatcher routed through Core shape**

Update `tests/main-bot-runtime-dispatcher.test.js` to assert runtime config uses `providerConnectionId`/`modelProfileId` and not renderer-native connection fields.

- [ ] **Step 6: Run service and dispatch tests**

Run:

```bash
node --test tests/mia-core-runtime-service.test.js tests/main-bot-runtime-dispatcher.test.js tests/runtime-config-normalizer.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/mia-core/runtime-service.js src/main.js tests/mia-core-runtime-service.test.js tests/main-bot-runtime-dispatcher.test.js
git commit -m "feat: introduce mia core turn runtime service"
```

---

### Task 6: Replace New Daemon Imports With Core Process Control

**Files:**
- Create: `src/main/mia-core/local-process-control.js`
- Create: `tests/mia-core-local-process-control.test.js`
- Modify: `src/main.js`

**Interfaces:**
- Produces:

```js
createMiaCoreControlServer
createMiaCoreTasksClient
createMiaCoreLocalEventsClient
createMiaCoreProcessLauncher
coreNeedsReplacement
```

- Consumes existing implementation:

```js
src/main/daemon/control-server.js
src/main/daemon/tasks-client.js
src/main/daemon/local-events-client.js
src/main/daemon/process-launcher.js
```

- [ ] **Step 1: Write compatibility wrapper test**

Create `tests/mia-core-local-process-control.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");

const coreProcess = require("../src/main/mia-core/local-process-control.js");

test("mia core process control exports core-named compatibility APIs", () => {
  assert.equal(typeof coreProcess.createMiaCoreControlServer, "function");
  assert.equal(typeof coreProcess.createMiaCoreTasksClient, "function");
  assert.equal(typeof coreProcess.createMiaCoreLocalEventsClient, "function");
  assert.equal(typeof coreProcess.createMiaCoreProcessLauncher, "function");
  assert.equal(typeof coreProcess.coreNeedsReplacement, "function");
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node --test tests/mia-core-local-process-control.test.js
```

Expected: FAIL because the wrapper does not exist.

- [ ] **Step 3: Add Core-named wrapper**

Create `src/main/mia-core/local-process-control.js`:

```js
"use strict";

const {
  createDaemonControlServer,
  daemonNeedsReplacement
} = require("../daemon/control-server.js");
const { createDaemonTasksClient } = require("../daemon/tasks-client.js");
const { createLocalEventsClient } = require("../daemon/local-events-client.js");
const { createDaemonProcessLauncher } = require("../daemon/process-launcher.js");

module.exports = {
  createMiaCoreControlServer: createDaemonControlServer,
  createMiaCoreTasksClient: createDaemonTasksClient,
  createMiaCoreLocalEventsClient: createLocalEventsClient,
  createMiaCoreProcessLauncher: createDaemonProcessLauncher,
  coreNeedsReplacement: daemonNeedsReplacement
};
```

- [ ] **Step 4: Update `src/main.js` imports**

Replace:

```js
const { createDaemonControlServer, daemonNeedsReplacement } = require("./main/daemon/control-server.js");
const { createDaemonTasksClient } = require("./main/daemon/tasks-client.js");
const { createLocalEventsClient } = require("./main/daemon/local-events-client.js");
const { createDaemonProcessLauncher } = require("./main/daemon/process-launcher.js");
```

with:

```js
const {
  createMiaCoreControlServer,
  createMiaCoreTasksClient,
  createMiaCoreLocalEventsClient,
  createMiaCoreProcessLauncher,
  coreNeedsReplacement
} = require("./main/mia-core/local-process-control.js");
```

Then rename local variables in `src/main.js` from `daemonControlServer`, `daemonTasksClient`, `localEventsClient`, and `daemonProcessLauncher` to `miaCoreControlServer`, `miaCoreTasksClient`, `miaCoreLocalEventsClient`, and `miaCoreProcessLauncher`.

Do not rename env vars in this task. Keep `MIA_DAEMON` as a compatibility alias until packaging migration.

- [ ] **Step 5: Run process-control tests**

Run:

```bash
node --test tests/mia-core-local-process-control.test.js tests/daemon-control-server.test.js tests/daemon-tasks-client.test.js tests/daemon-process-launcher.test.js tests/daemon-local-events.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mia-core/local-process-control.js src/main.js tests/mia-core-local-process-control.test.js
git commit -m "refactor: expose core-named process control"
```

---

### Task 7: End-To-End Runtime Verification

**Files:**
- Modify only if tests reveal a regression in files touched by Tasks 1-6.

**Interfaces:**
- Verifies Hermes, OpenClaw, and Codex use Core model profiles.
- Verifies old `mia-auto` bindings still work.
- Verifies `daemon` is no longer the active architecture concept.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
node --test \
  tests/mia-core-model-runtime-resolver.test.js \
  tests/mia-core-runtime-service.test.js \
  tests/mia-core-local-process-control.test.js \
  tests/runtime-config-normalizer.test.js \
  tests/bot-commands.test.js \
  tests/hermes-chat-adapter.test.js \
  tests/openclaw-chat-adapter.test.js \
  tests/codex-chat-adapter.test.js \
  tests/engine-runtime-config-service.test.js \
  tests/main-bot-runtime-dispatcher.test.js
```

Expected: PASS.

- [ ] **Step 2: Run syntax checks**

Run:

```bash
node --check src/main/mia-core/model-runtime-resolver.js
node --check src/main/mia-core/runtime-service.js
node --check src/main/mia-core/local-process-control.js
node --check src/main/runtime-config-normalizer.js
node --check src/main/hermes-chat-adapter.js
node --check src/main/openclaw-chat-adapter.js
node --check src/main/codex-chat-adapter.js
node --check src/renderer/bot/bot-commands.js
node --check src/main.js
```

Expected: no syntax errors.

- [ ] **Step 3: Check for unwanted new daemon domain usage**

Run:

```bash
rg -n "daemon" src/main/mia-core src/renderer/bot src/main/hermes-chat-adapter.js src/main/openclaw-chat-adapter.js src/main/codex-chat-adapter.js docs/adr/2026-06-25-mia-core-runtime-owner.md
```

Expected:

- No matches in new Mia Core domain code except comments explaining legacy compatibility.
- No matches in renderer bot runtime binding code.
- ADR matches only in the compatibility section.

- [ ] **Step 4: Check patch hygiene**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 5: Manual local smoke test after app restart**

Use a Mia Cloud logged-in account with `mia-auto` available.

Run these flows from the app:

- Hermes bot with Mia Auto.
- OpenClaw bot with Mia Auto.
- Codex bot with Mia Auto.

Expected:

- Hermes writes `model.provider: mia` and `model.default: mia-auto` into the effective runtime config before the turn.
- OpenClaw uses `openclaw agent --local --model mia/mia-auto` unless the bot explicitly sets `openclawTransport: "acp"`.
- Codex creates a Mia model proxy session and passes proxy `baseUrl`, `apiKey`, and model into the Codex app-server runner.
- The bot response returns to the Mia conversation in all three flows.

- [ ] **Step 6: Commit verification fixes only if needed**

```bash
git add <changed-files>
git commit -m "test: verify mia core runtime cutover"
```

---

## Cutover Order

Execute tasks in this order:

1. Task 1 locks the decision so the repo stops carrying two active architecture stories.
2. Task 2 creates the Core resolver without touching existing adapters.
3. Task 3 changes the binding schema so future turns carry references instead of engine config.
4. Task 4 routes Hermes, OpenClaw, and Codex through Core.
5. Task 5 extracts the turn-runtime service from `src/main.js`.
6. Task 6 removes new daemon imports from active Core-facing code while preserving old process behavior.
7. Task 7 verifies the full cutover.

Do not merge Task 3 without Task 4 in the same branch. A binding schema that stores only references is not usable until adapters resolve those references through Core.

## Self-Review

- Spec coverage: The plan covers the user's requested hard turn from daemon-first to Mia Core, AION-style provider/model ownership, Hermes/OpenClaw/Codex parity, renderer binding cleanup, and process-control compatibility.
- Placeholder scan: The plan avoids placeholder instructions and vague follow-up language. Each code task includes exact paths, signatures, tests, and commands.
- Type consistency: `providerConnectionId`, `modelProfileId`, `model`, `resolveModelRuntime()`, `isMiaManagedRuntime()`, and `createMiaCoreModelRuntimeResolver()` are used consistently across tasks.
