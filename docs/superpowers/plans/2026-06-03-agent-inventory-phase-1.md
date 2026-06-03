# Agent Inventory Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Mia's first local agent inventory surface for Hermes, Claude Code, Codex, and OpenClaw, with a user-triggered Hermes install entry and a skip path when no agent is available.

**Architecture:** Extend the existing main-process `local-agent-engine-service` so one cached probe produces both the new `agentInventory` model and the legacy `agentEngines` object. Expose the inventory through `runtimeStatus`, then render it in onboarding and settings without changing chat adapters, memory policy, MCP wiring, or packaging. Keep Hermes installation on the existing `engineInstallService.install()` path.

**Tech Stack:** Electron main process, Node CommonJS, `spawnSync`, existing Mia runtime status IPC, plain browser JavaScript renderer modules, Node test runner.

---

## Scope Check

The approved spec covers six subsystems. This plan implements only Phase 1:

- Agent detection for `claude`, `codex`, `hermes`, and OpenClaw command candidates.
- A normalized inventory model in `runtimeStatus.agentInventory`.
- Onboarding/settings UI that shows installed/missing states.
- A no-agent skip path.
- Hermes install remains user-triggered through the current installer.

This plan does not:

- Remove Hermes from `package.json`, `electron-builder` resources, or `dist:mac`.
- Make Mia launch an official system Hermes CLI directly.
- Change Claude Code, Codex, or Hermes memory injection.
- Rename `mia-scheduler` to `mia-app`.
- Add OpenClaw as a runnable chat engine.

Those are separate implementation plans because they touch runtime isolation, memory, MCP permissions, and distribution risk.

## Preflight Constraints

The current working tree has unrelated dirty files:

```text
 M src/renderer/app.js
 M src/renderer/index.html
 M src/renderer/social/social-groups.js
 M src/renderer/social/social.js
 M tests/renderer-social.test.js
?? packages/shared/self-identity.js
?? tests/shared-self-identity.test.js
```

Execution should use a clean git worktree before touching code. If execution happens in the current dirty tree, reread `git diff -- src/renderer/app.js src/renderer/index.html` immediately before editing and avoid committing unrelated hunks. Do not revert or overwrite the existing dirty changes.

## File Structure

Modify:

- `src/main/local-agent-engine-service.js`: Own all local CLI path probing, version probing, cache state, inventory normalization, and legacy `agentEngines` compatibility.
- `tests/local-agent-engine-service.test.js`: Unit-test inventory shape, Hermes source separation, OpenClaw detection, missing-agent summary, and cache reset.
- `src/main.js`: Pass Hermes runtime source dependencies into `createLocalAgentEngineService()` and include `agentInventory` in `getRuntimeStatus()`.
- `tests/project-structure-check.test.js`: Guard that inventory logic remains in the local agent service, not `main.js`.
- `src/renderer/app-state.js`: Add persisted `agentSetupSkipped` state.
- `tests/renderer-shell.test.js`: Guard state default and renderer wiring.
- `src/renderer/onboarding/setup-guide.js`: Render inventory rows, OpenClaw detection-only state, Hermes install CTA, and skip path.
- `tests/renderer-setup-guide.test.js`: Browser-module tests for onboarding inventory rendering and skip behavior.
- `src/renderer/app.js`: Rewire `renderChat()` to display setup guide when appropriate, handle new setup actions, and render no-agent state after skip.
- `src/renderer/index.html`: Add the OpenClaw settings row.
- `src/renderer/styles.css`: Add OpenClaw dots/logos and no-agent/setup button layout refinements.

Do not create a separate `agent-inventory-service.js` in this phase. The existing `local-agent-engine-service` is already the boundary tested by `project-structure-check`.

## Inventory Model

`runtimeStatus.agentInventory` should have this shape:

```js
{
  generatedAt: 1710000000000,
  agents: [
    {
      id: "hermes",
      label: "Hermes",
      commands: ["hermes"],
      command: "hermes",
      installed: true,
      usableInMia: true,
      installable: true,
      installAction: "",
      detectionOnly: false,
      path: "/opt/homebrew/bin/hermes",
      version: "hermes 0.1.0",
      source: "mia-managed",
      health: "ready",
      system: {
        available: true,
        path: "/opt/homebrew/bin/hermes",
        version: "hermes 0.1.0"
      }
    }
  ],
  summary: {
    installedCount: 1,
    usableCount: 1,
    missingCount: 3,
    hasUsableAgent: true,
    recommendedAction: "continue"
  }
}
```

Definitions:

- `installed`: A command or Mia-managed runtime exists.
- `usableInMia`: Mia can use this agent as a chat runtime in the current code.
- `detectionOnly`: Mia can detect this agent but cannot run it as a chat engine yet.
- `source`: One of `"mia-bundled"`, `"mia-managed"`, `"system"`, `"missing"`.
- `health`: One of `"ready"`, `"detected"`, `"missing"`.
- Hermes system command detection is not the same as Hermes chat usability. Until runtime isolation is implemented, system Hermes may be detected while `usableInMia` remains false unless Mia has a bundled or managed Hermes runtime.

## Tasks

### Task 1: Add Failing Inventory Tests

**Files:**
- Modify: `tests/local-agent-engine-service.test.js`

- [ ] **Step 1: Add tests for the normalized inventory**

Append these tests after the existing `localAgentEngines reports Hermes default...` test:

```js
test("agentInventory separates system Hermes detection from Mia Hermes usability", (t) => {
  let now = 1000;
  const { service } = makeService(t, {
    now: () => now,
    isHermesInstalled: () => true,
    hermesSource: () => "managed",
    spawnSync: (command, args) => {
      if (command === "zsh" && args[1] === "command -v hermes") {
        return { status: 0, stdout: "/bin/hermes\n", stderr: "" };
      }
      if (command === "zsh" && args[1] === "command -v claude") {
        return { status: 0, stdout: "/bin/claude\n", stderr: "" };
      }
      if (command === "zsh" && args[1] === "command -v codex") {
        return { status: 0, stdout: "/bin/codex\n", stderr: "" };
      }
      if (command === "zsh" && args[1] === "command -v openclaw") {
        return { status: 0, stdout: "/bin/openclaw\n", stderr: "" };
      }
      if (command === "/bin/hermes") return { status: 0, stdout: "hermes 0.4.0\n", stderr: "" };
      if (command === "/bin/claude") return { status: 0, stdout: "claude 1.2.3\n", stderr: "" };
      if (command === "/bin/codex") return { status: 0, stdout: "codex 2.3.4\n", stderr: "" };
      if (command === "/bin/openclaw") return { status: 0, stdout: "openclaw 0.1.0\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  const inventory = service.agentInventory();
  now += 1000;
  const cached = service.agentInventory();
  const agentsById = Object.fromEntries(inventory.agents.map((agent) => [agent.id, agent]));

  assert.equal(cached, inventory);
  assert.equal(inventory.summary.installedCount, 4);
  assert.equal(inventory.summary.usableCount, 3);
  assert.equal(inventory.summary.missingCount, 0);
  assert.equal(inventory.summary.hasUsableAgent, true);
  assert.equal(inventory.summary.recommendedAction, "continue");
  assert.equal(agentsById.hermes.installed, true);
  assert.equal(agentsById.hermes.usableInMia, true);
  assert.equal(agentsById.hermes.source, "mia-managed");
  assert.deepEqual(agentsById.hermes.system, {
    available: true,
    path: "/bin/hermes",
    version: "hermes 0.4.0"
  });
  assert.equal(agentsById["claude-code"].usableInMia, true);
  assert.equal(agentsById.codex.usableInMia, true);
  assert.equal(agentsById.openclaw.installed, true);
  assert.equal(agentsById.openclaw.usableInMia, false);
  assert.equal(agentsById.openclaw.detectionOnly, true);
});

test("agentInventory recommends Hermes install when no usable agent is detected", (t) => {
  const { service } = makeService(t, {
    isHermesInstalled: () => false,
    hermesSource: () => "",
    spawnSync: () => ({ status: 1, stdout: "", stderr: "" })
  });

  const inventory = service.agentInventory();
  const agentsById = Object.fromEntries(inventory.agents.map((agent) => [agent.id, agent]));
  const legacy = service.localAgentEngines();

  assert.equal(inventory.summary.installedCount, 0);
  assert.equal(inventory.summary.usableCount, 0);
  assert.equal(inventory.summary.missingCount, 4);
  assert.equal(inventory.summary.hasUsableAgent, false);
  assert.equal(inventory.summary.recommendedAction, "install-hermes");
  assert.equal(agentsById.hermes.installable, true);
  assert.equal(agentsById.hermes.installAction, "install-hermes");
  assert.equal(agentsById.hermes.health, "missing");
  assert.equal(agentsById.openclaw.installable, false);
  assert.equal(legacy.hermes.available, false);
  assert.equal(legacy.claudeCode.available, false);
  assert.equal(legacy.codex.available, false);
  assert.equal(legacy.openClaw.available, false);
});
```

- [ ] **Step 2: Run the targeted failing tests**

Run:

```bash
node --test tests/local-agent-engine-service.test.js
```

Expected: FAIL with `service.agentInventory is not a function`.

### Task 2: Implement Inventory in Local Agent Service

**Files:**
- Modify: `src/main/local-agent-engine-service.js`
- Modify: `tests/local-agent-engine-service.test.js`

- [ ] **Step 1: Add agent definitions near `SYSTEM_CLI_PATH_SEGMENTS`**

Insert this block after `SYSTEM_CLI_PATH_SEGMENTS`:

```js
const AGENT_DEFINITIONS = Object.freeze([
  {
    id: "hermes",
    legacyKey: "hermes",
    label: "Hermes",
    commands: ["hermes"],
    installable: true,
    detectionOnly: false
  },
  {
    id: "claude-code",
    legacyKey: "claudeCode",
    label: "Claude Code",
    commands: ["claude"],
    installable: false,
    detectionOnly: false
  },
  {
    id: "codex",
    legacyKey: "codex",
    label: "Codex",
    commands: ["codex"],
    installable: false,
    detectionOnly: false
  },
  {
    id: "openclaw",
    legacyKey: "openClaw",
    label: "OpenClaw",
    commands: ["openclaw", "claw"],
    installable: false,
    detectionOnly: true
  }
]);
```

- [ ] **Step 2: Add Hermes dependency functions and cache state**

Inside `createLocalAgentEngineService`, replace the single cache declaration with this:

```js
  const isHermesInstalled = typeof deps.isHermesInstalled === "function"
    ? deps.isHermesInstalled
    : () => false;
  const hermesSource = typeof deps.hermesSource === "function"
    ? deps.hermesSource
    : () => "";
  const cacheMs = Number.isFinite(Number(deps.cacheMs)) ? Number(deps.cacheMs) : 15000;
  let agentInventoryCache = { at: 0, value: null };
  let agentEngineCache = { at: 0, value: null };
```

- [ ] **Step 3: Replace `resetCache` with a cache reset for both views**

Use this implementation:

```js
  function resetCache() {
    agentInventoryCache = { at: 0, value: null };
    agentEngineCache = { at: 0, value: null };
  }
```

- [ ] **Step 4: Add command candidate probing helpers before `localAgentEngines`**

Insert these functions above `localAgentEngines()`:

```js
  function firstCommandPath(commands) {
    for (const command of commands) {
      const found = shellCommandPath(command);
      if (found) {
        return {
          command,
          path: found,
          version: commandVersion(found)
        };
      }
    }
    return { command: commands[0] || "", path: "", version: "" };
  }

  function miaHermesSource() {
    const source = String(hermesSource() || "").trim();
    if (source === "bundled") return "mia-bundled";
    if (source === "managed") return "mia-managed";
    return "";
  }

  function miaHermesUsable() {
    const source = miaHermesSource();
    return Boolean(source && isHermesInstalled());
  }

  function agentStatus(definition) {
    const probe = firstCommandPath(definition.commands);
    const systemAvailable = Boolean(probe.path);
    const hermesRuntimeUsable = definition.id === "hermes" ? miaHermesUsable() : false;
    const installed = Boolean(systemAvailable || hermesRuntimeUsable);
    const usableInMia = definition.id === "hermes"
      ? hermesRuntimeUsable
      : Boolean(systemAvailable && !definition.detectionOnly);
    const source = definition.id === "hermes" && hermesRuntimeUsable
      ? miaHermesSource()
      : systemAvailable
        ? "system"
        : "missing";
    const health = usableInMia ? "ready" : installed ? "detected" : "missing";
    return {
      id: definition.id,
      label: definition.label,
      commands: definition.commands.slice(),
      command: probe.command,
      installed,
      usableInMia,
      installable: Boolean(definition.installable),
      installAction: definition.id === "hermes" && !usableInMia ? "install-hermes" : "",
      detectionOnly: Boolean(definition.detectionOnly),
      path: probe.path,
      version: probe.version,
      source,
      health,
      system: {
        available: systemAvailable,
        path: probe.path,
        version: probe.version
      }
    };
  }

  function agentInventory() {
    const at = now();
    if (agentInventoryCache.value && at - agentInventoryCache.at < cacheMs) return agentInventoryCache.value;
    const agents = AGENT_DEFINITIONS.map(agentStatus);
    const installedCount = agents.filter((agent) => agent.installed).length;
    const usableCount = agents.filter((agent) => agent.usableInMia).length;
    const value = {
      generatedAt: at,
      agents,
      summary: {
        installedCount,
        usableCount,
        missingCount: agents.length - installedCount,
        hasUsableAgent: usableCount > 0,
        recommendedAction: usableCount > 0 ? "continue" : "install-hermes"
      }
    };
    agentInventoryCache = { at, value };
    return value;
  }

  function inventoryAgent(id) {
    return agentInventory().agents.find((agent) => agent.id === id) || null;
  }
```

- [ ] **Step 5: Replace `localAgentEngines()` with a compatibility view**

Replace the existing `localAgentEngines()` function with:

```js
  function localAgentEngines() {
    const at = now();
    if (agentEngineCache.value && at - agentEngineCache.at < cacheMs) return agentEngineCache.value;
    const hermes = inventoryAgent("hermes") || {};
    const claudeCode = inventoryAgent("claude-code") || {};
    const codex = inventoryAgent("codex") || {};
    const openClaw = inventoryAgent("openclaw") || {};
    const value = {
      hermes: {
        id: "hermes",
        label: "默认",
        available: Boolean(hermes.usableInMia),
        installed: Boolean(hermes.installed),
        path: hermes.path || "",
        version: hermes.version || "",
        source: hermes.source || "missing",
        system: hermes.system || { available: false, path: "", version: "" }
      },
      claudeCode: {
        id: "claude-code",
        label: "Claude Code",
        available: Boolean(claudeCode.usableInMia),
        installed: Boolean(claudeCode.installed),
        path: claudeCode.path || "",
        version: claudeCode.version || ""
      },
      codex: {
        id: "codex",
        label: "Codex",
        available: Boolean(codex.usableInMia),
        installed: Boolean(codex.installed),
        path: codex.path || "",
        version: codex.version || ""
      },
      openClaw: {
        id: "openclaw",
        label: "OpenClaw",
        available: Boolean(openClaw.usableInMia),
        installed: Boolean(openClaw.installed),
        path: openClaw.path || "",
        version: openClaw.version || "",
        detectionOnly: true
      }
    };
    agentEngineCache = { at, value };
    return value;
  }
```

- [ ] **Step 6: Export `agentInventory` from the service instance**

In the returned object, add `agentInventory`:

```js
  return {
    agentInventory,
    cliPathEnv,
    cliPathSegments,
    commandNameOnly,
    commandVersion,
    localAgentEngines,
    processEnvWithCliPath,
    resetCache,
    shellCommandPath
  };
```

- [ ] **Step 7: Update the existing legacy test expectation**

In `tests/local-agent-engine-service.test.js`, change the existing test name from:

```js
test("localAgentEngines reports Hermes default and caches CLI probes until reset", (t) => {
```

to:

```js
test("localAgentEngines reports the legacy engine view and caches CLI probes until reset", (t) => {
```

Then change these assertions:

```js
  assert.equal(first.hermes.available, true);
  assert.deepEqual(first.hermes.system, { available: false, disabled: true });
```

to:

```js
  assert.equal(first.hermes.available, false);
  assert.deepEqual(first.hermes.system, { available: false, path: "", version: "" });
```

Finally, change the last call-count assertion from:

```js
  assert.equal(calls.filter((call) => call[0] === "zsh").length, 4);
```

to:

```js
  assert.equal(calls.filter((call) => call[0] === "zsh").length, 10);
```

The legacy test does not pass Hermes install deps, so Hermes should no longer appear usable by default. The service now probes `hermes`, `claude`, `codex`, `openclaw`, and `claw` during each uncached inventory build; the cached second read performs no probes, then `resetCache()` causes the same five shell probes again.

- [ ] **Step 8: Run targeted tests**

Run:

```bash
node --test tests/local-agent-engine-service.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit service and tests in a clean worktree**

Run:

```bash
git add src/main/local-agent-engine-service.js tests/local-agent-engine-service.test.js
git commit -m "feat: add local agent inventory"
```

Expected: commit succeeds and does not include renderer/social dirty files.

### Task 3: Add Inventory to Runtime Status

**Files:**
- Modify: `src/main.js`
- Modify: `tests/project-structure-check.test.js`

- [ ] **Step 1: Pass Hermes runtime source deps into the local agent service**

In `src/main.js`, replace:

```js
const localAgentEngineService = createLocalAgentEngineService({
  homeDir: () => os.homedir(),
  env: process.env,
  spawnSync
});
```

with:

```js
const localAgentEngineService = createLocalAgentEngineService({
  homeDir: () => os.homedir(),
  env: process.env,
  spawnSync,
  isHermesInstalled: () => engineInstallService.isInstalled(),
  hermesSource: () => engineInstallService.engineSource()
});
```

- [ ] **Step 2: Include inventory in `getRuntimeStatus()`**

Inside `getRuntimeStatus(created = [])`, add a local before the returned object:

```js
  const agentInventory = localAgentEngineService.agentInventory();
```

Then replace the existing `agentEngines` property with both properties:

```js
    agentInventory,
    agentEngines: localAgentEngineService.localAgentEngines(),
```

- [ ] **Step 3: Strengthen the project structure test**

In `tests/project-structure-check.test.js`, inside the `"local Agent CLI discovery..."` test, add:

```js
  assert.match(localAgentSource, /function agentInventory/, "local Agent engine service should own normalized inventory");
  assert.doesNotMatch(mainSource, /function agentInventory/, "main must not own normalized local Agent inventory");
```

- [ ] **Step 4: Run structure tests**

Run:

```bash
node --test tests/project-structure-check.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit runtime status wiring**

Run:

```bash
git add src/main.js tests/project-structure-check.test.js
git commit -m "feat: expose agent inventory in runtime status"
```

Expected: commit succeeds in the clean worktree.

### Task 4: Add Persisted Skip State and Renderer Tests

**Files:**
- Modify: `src/renderer/app-state.js`
- Modify: `tests/renderer-shell.test.js`
- Create: `tests/renderer-setup-guide.test.js`

- [ ] **Step 1: Add skip-state tests**

In `tests/renderer-shell.test.js`, update the `"renderer app state factory owns default mutable state"` test. Add this branch to the fake `localStorage.getItem`:

```js
      if (key === "mia.agentSetupSkipped.v1") return "1";
```

Then add this assertion after `assert.equal(state.setupGuideDismissed, true);`:

```js
  assert.equal(state.agentSetupSkipped, true);
```

- [ ] **Step 2: Implement skip state**

In `src/renderer/app-state.js`, add this constant below `SETUP_GUIDE_DISMISSED_KEY`:

```js
  const AGENT_SETUP_SKIPPED_KEY = "mia.agentSetupSkipped.v1";
```

In `createInitialState`, add this property after `setupGuideDismissed`:

```js
      agentSetupSkipped: readLocal(storage, AGENT_SETUP_SKIPPED_KEY) === "1",
```

In the exported object, add the new key:

```js
    AGENT_SETUP_SKIPPED_KEY,
```

- [ ] **Step 3: Create setup guide module tests**

Create `tests/renderer-setup-guide.test.js` with:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadSetupGuide(state) {
  const source = fs.readFileSync(path.join(root, "src/renderer/onboarding/setup-guide.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "src/renderer/onboarding/setup-guide.js" });
  sandbox.window.miaSetupGuide.initSetupGuide({ state, escapeHtml });
  return sandbox.window.miaSetupGuide;
}

function inventory(agents, summary = {}) {
  return {
    agents,
    summary: {
      installedCount: agents.filter((agent) => agent.installed).length,
      usableCount: agents.filter((agent) => agent.usableInMia).length,
      missingCount: agents.filter((agent) => !agent.installed).length,
      hasUsableAgent: agents.some((agent) => agent.usableInMia),
      recommendedAction: agents.some((agent) => agent.usableInMia) ? "continue" : "install-hermes",
      ...summary
    }
  };
}

test("setup guide renders no-agent inventory with Hermes install and skip actions", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, installable: true, installAction: "install-hermes", health: "missing", source: "missing" },
        { id: "claude-code", label: "Claude Code", installed: false, usableInMia: false, installable: false, health: "missing", source: "missing" },
        { id: "codex", label: "Codex", installed: false, usableInMia: false, installable: false, health: "missing", source: "missing" },
        { id: "openclaw", label: "OpenClaw", installed: false, usableInMia: false, installable: false, detectionOnly: true, health: "missing", source: "missing" }
      ]),
      fellows: []
    },
    onboardingStep: "engine",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.equal(guide.shouldShowSetupGuide({ messages: [] }), true);
  assert.match(html, /本机 Agent/);
  assert.match(html, /data-setup-action="install-hermes"/);
  assert.match(html, /data-setup-action="continue-no-agent"/);
  assert.match(html, /OpenClaw/);
  assert.doesNotMatch(html, /使用 OpenClaw/);
});

test("setup guide allows installed Claude Code and Codex while keeping OpenClaw detection-only", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, installable: true, installAction: "install-hermes", health: "missing", source: "missing" },
        { id: "claude-code", label: "Claude Code", installed: true, usableInMia: true, installable: false, path: "/bin/claude", version: "claude 1.2.3", health: "ready", source: "system" },
        { id: "codex", label: "Codex", installed: true, usableInMia: true, installable: false, path: "/bin/codex", version: "codex 2.3.4", health: "ready", source: "system" },
        { id: "openclaw", label: "OpenClaw", installed: true, usableInMia: false, installable: false, detectionOnly: true, path: "/bin/openclaw", version: "openclaw 0.1.0", health: "detected", source: "system" }
      ]),
      fellows: []
    },
    onboardingStep: "engine",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.match(html, /使用 Claude Code/);
  assert.match(html, /使用 Codex/);
  assert.match(html, /已检测到，暂未接入 Mia 聊天/);
  assert.doesNotMatch(html, /使用 OpenClaw/);
});

test("setup guide stays hidden after user skips agent setup", () => {
  const state = {
    runtime: { fellows: [], agentInventory: inventory([]) },
    onboardingStep: "done",
    agentSetupSkipped: true,
    setupGuideDismissed: true
  };
  const guide = loadSetupGuide(state);

  assert.equal(guide.shouldShowSetupGuide({ messages: [] }), false);
});
```

- [ ] **Step 4: Run the expected failing setup tests**

Run:

```bash
node --test tests/renderer-shell.test.js tests/renderer-setup-guide.test.js
```

Expected: FAIL because `agentSetupSkipped` and the new setup guide strings/actions do not exist yet.

### Task 5: Render Inventory in Setup Guide

**Files:**
- Modify: `src/renderer/onboarding/setup-guide.js`

- [ ] **Step 1: Replace `detectedLocalAgentLabels` with inventory-aware implementation**

Replace the existing function with:

```js
  function inventoryAgents(runtime = state?.runtime) {
    const agents = runtime?.agentInventory?.agents;
    if (Array.isArray(agents) && agents.length) return agents;
    const engines = runtime?.agentEngines || {};
    return [
      {
        id: "hermes",
        label: "Hermes",
        installed: Boolean(runtime?.engineInstalled),
        usableInMia: Boolean(runtime?.engineInstalled),
        installable: true,
        installAction: runtime?.engineInstalled ? "" : "install-hermes",
        source: runtime?.engineSource || "missing",
        health: runtime?.engineInstalled ? "ready" : "missing"
      },
      {
        id: "claude-code",
        label: "Claude Code",
        installed: Boolean(engines.claudeCode?.installed || engines.claudeCode?.available),
        usableInMia: Boolean(engines.claudeCode?.available),
        installable: false,
        path: engines.claudeCode?.path || "",
        version: engines.claudeCode?.version || "",
        source: engines.claudeCode?.available ? "system" : "missing",
        health: engines.claudeCode?.available ? "ready" : "missing"
      },
      {
        id: "codex",
        label: "Codex",
        installed: Boolean(engines.codex?.installed || engines.codex?.available),
        usableInMia: Boolean(engines.codex?.available),
        installable: false,
        path: engines.codex?.path || "",
        version: engines.codex?.version || "",
        source: engines.codex?.available ? "system" : "missing",
        health: engines.codex?.available ? "ready" : "missing"
      },
      {
        id: "openclaw",
        label: "OpenClaw",
        installed: Boolean(engines.openClaw?.installed || engines.openClaw?.available),
        usableInMia: false,
        installable: false,
        detectionOnly: true,
        path: engines.openClaw?.path || "",
        version: engines.openClaw?.version || "",
        source: engines.openClaw?.installed ? "system" : "missing",
        health: engines.openClaw?.installed ? "detected" : "missing"
      }
    ];
  }

  function detectedLocalAgentLabels(runtime = state?.runtime) {
    return inventoryAgents(runtime)
      .filter((agent) => agent.usableInMia)
      .map((agent) => agent.label);
  }
```

- [ ] **Step 2: Update visibility rules for skip state**

Replace `shouldShowSetupGuide` with:

```js
  function shouldShowSetupGuide({ messages }) {
    if (!state || !state.runtime) return false;
    const fellows = state.runtime.fellows || state.runtime.personas || [];
    if (fellows.length === 0) return !state.agentSetupSkipped;
    if (state.setupGuideDismissed) return false;
    if (messages.length > 0) return false;
    return false;
  }
```

This keeps the guide as a first-run takeover only. After the first fellow exists, the app should not keep showing this old guide above empty conversations.

- [ ] **Step 3: Replace `engineChoiceRow` with inventory row rendering**

Replace `engineChoiceRow` with:

```js
  function versionLabel(agent) {
    const version = String(agent.version || "").trim();
    if (!version) return "";
    return version.split(/\s+/).slice(0, 2).join(" ");
  }

  function agentStatusText(agent) {
    if (agent.id === "hermes" && agent.usableInMia) {
      if (agent.source === "mia-bundled") return "随 Mia 安装包内置，可用于本机聊天";
      if (agent.source === "mia-managed") return "Mia 独立副本已安装，可用于本机聊天";
      return "Hermes 可用于本机聊天";
    }
    if (agent.usableInMia) {
      const parts = [agent.path || "已检测到", versionLabel(agent)].filter(Boolean);
      return parts.join(" · ");
    }
    if (agent.installed && agent.detectionOnly) return "已检测到，暂未接入 Mia 聊天";
    if (agent.id === "hermes" && agent.installed) return "已检测到系统 Hermes，当前 Mia 仍需要独立副本";
    if (agent.id === "hermes") return "未安装，可安装到 Mia 私有目录";
    if (agent.id === "claude-code") return "未检测到，需要先安装 Claude Code";
    if (agent.id === "codex") return "未检测到，需要先安装 Codex CLI";
    return "未检测到";
  }

  function agentAction(agent) {
    if (agent.usableInMia && ["hermes", "claude-code", "codex"].includes(agent.id)) {
      return { action: "use-engine", label: `使用 ${agent.label}` };
    }
    if (agent.id === "hermes" && agent.installAction === "install-hermes") {
      return { action: "install-hermes", label: "安装 Hermes" };
    }
    return null;
  }

  function engineChoiceRow(agent) {
    const available = Boolean(agent.usableInMia);
    const stateClass = available ? "" : " unavailable";
    const action = agentAction(agent);
    const actionAttr = action ? `data-setup-action="${action.action}" data-engine="${agent.id}"` : "";
    const button = action
      ? `<button class="setup-engine-action${available ? " primary" : ""}" type="button" ${actionAttr}>${escapeHtml(action.label)}</button>`
      : "";
    return `
      <div class="setup-engine-row${stateClass}" data-engine-id="${escapeHtml(agent.id)}">
        <span class="setup-engine-dot ${escapeHtml(agent.id)}"></span>
        <div class="setup-engine-body">
          <strong>${escapeHtml(agent.label)}</strong>
          <small>${escapeHtml(agentStatusText(agent))}</small>
        </div>
        ${button}
      </div>
    `;
  }
```

- [ ] **Step 4: Replace the default `renderSetupGuide()` body**

Inside `renderSetupGuide()`, keep the existing first lines through the `create-fellow` branch, then replace the old Hermes/Claude/Codex row construction with:

```js
    const agents = inventoryAgents(runtime);
    const hasUsableAgent = agents.some((agent) => agent.usableInMia);
    const kicker = hasUsableAgent ? "第 1 步 / 共 2 步" : "本机 Agent";
    const title = hasUsableAgent ? "选个 Agent 引擎" : "这台电脑还没有可用 Agent";
    const body = hasUsableAgent
      ? "这是你的第一个伙伴默认会用的引擎，以后任意时候都能换。"
      : "可以先安装 Hermes，也可以跳过安装进入 Mia。";

    return `
      <article class="setup-guide">
        <div class="setup-guide-main">
          <span class="setup-kicker">${escapeHtml(kicker)}</span>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(body)}</p>
        </div>
        <div class="setup-engine-list">
          ${agents.map(engineChoiceRow).join("")}
        </div>
        ${hasUsableAgent ? "" : `
          <div class="setup-actions" style="justify-content: flex-start;">
            <button class="setup-action secondary" type="button" data-setup-action="continue-no-agent">暂不安装，继续进入 Mia</button>
          </div>
        `}
      </article>
    `;
```

- [ ] **Step 5: Run setup-guide tests**

Run:

```bash
node --test tests/renderer-setup-guide.test.js
```

Expected: PASS for setup-guide tests; `renderer-shell` may still fail until app state from Task 4 is implemented.

### Task 6: Wire Setup Actions and No-Agent State in App

**Files:**
- Modify: `src/renderer/app-state.js`
- Modify: `src/renderer/app.js`
- Modify: `tests/renderer-shell.test.js`

- [ ] **Step 1: Finish app-state implementation**

Apply the `app-state.js` changes described in Task 4 Step 2.

- [ ] **Step 2: Add source-level renderer guards**

Append this test to `tests/renderer-shell.test.js`:

```js
test("renderer chat uses setup guide and supports no-agent continuation", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /window\.miaSetupGuide\?\.shouldShowSetupGuide/);
  assert.match(appSource, /renderNoAgentGuide/);
  assert.match(appSource, /continue-no-agent/);
  assert.match(appSource, /AGENT_SETUP_SKIPPED_KEY/);
});
```

- [ ] **Step 3: Add `hasUsableLocalAgent` and no-agent guide**

In `src/renderer/app.js`, add these functions below `renderCloudLoginGuide()`:

```js
function hasUsableLocalAgent(runtime = state.runtime) {
  const inventory = runtime?.agentInventory;
  if (inventory?.summary) return Boolean(inventory.summary.hasUsableAgent);
  const engines = runtime?.agentEngines || {};
  return Boolean(runtime?.engineInstalled || engines.claudeCode?.available || engines.codex?.available);
}

function renderNoAgentGuide() {
  return `
    <div class="cloud-login-guide no-agent-guide">
      <h2>本机 Agent 尚未连接</h2>
      <p>你可以继续浏览联系人、任务和 Skill。要开始本机聊天，请安装 Hermes 或配置已有 Agent。</p>
      <div class="setup-actions">
        <button type="button" class="primary" data-setup-action="install-hermes">安装 Hermes</button>
        <button type="button" class="secondary" data-setup-action="open-agent-settings">查看本机引擎</button>
      </div>
    </div>
  `;
}
```

- [ ] **Step 4: Rewire `renderChat()`**

Replace the current `renderChat()` with:

```js
function renderChat() {
  const activeConversationId = window.miaSocial?.getActiveConversationId?.();
  if (activeConversationId) {
    if (window.miaSocial && typeof window.miaSocial.renderConversationChat === "function") {
      window.miaSocial.renderConversationChat(els.chat);
    }
    return;
  }
  const messages = [];
  if (window.miaSetupGuide?.shouldShowSetupGuide?.({ messages })) {
    els.chat.innerHTML = window.miaSetupGuide.renderSetupGuide();
    return;
  }
  if (state.agentSetupSkipped && !hasUsableLocalAgent()) {
    els.chat.innerHTML = renderNoAgentGuide();
    return;
  }
  if (state.runtime?.cloud?.enabled) {
    els.chat.innerHTML = "";
    return;
  }
  els.chat.innerHTML = renderCloudLoginGuide();
}
```

- [ ] **Step 5: Add setup actions**

In `handleSetupGuideAction(button)`, after the `"open-model-settings"` branch, insert:

```js
  if (action === "open-agent-settings") {
    state.settingsOpen = true;
    state.activeSettingsTab = "model";
    renderView();
    return true;
  }
  if (action === "continue-no-agent") {
    state.agentSetupSkipped = true;
    state.setupGuideDismissed = true;
    try {
      localStorage.setItem(window.miaAppState.AGENT_SETUP_SKIPPED_KEY, "1");
      localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, "1");
    } catch { /* ignore */ }
    advanceOnboarding("done");
    renderChat();
    return true;
  }
```

- [ ] **Step 6: Clear skip state after successful Hermes install**

Inside the `"install-hermes"` success branch, before `afterEnginePicked("hermes");`, add:

```js
      state.agentSetupSkipped = false;
      try { localStorage.removeItem(window.miaAppState.AGENT_SETUP_SKIPPED_KEY); } catch { /* ignore */ }
```

- [ ] **Step 7: Run renderer tests**

Run:

```bash
node --test tests/renderer-shell.test.js tests/renderer-setup-guide.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit renderer onboarding state**

Run in a clean worktree:

```bash
git add src/renderer/app-state.js src/renderer/onboarding/setup-guide.js src/renderer/app.js tests/renderer-shell.test.js tests/renderer-setup-guide.test.js
git commit -m "feat: add agent inventory onboarding"
```

Expected: commit succeeds without unrelated renderer/social changes.

### Task 7: Update Settings Engine Inventory UI

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles.css`
- Modify: `tests/renderer-shell.test.js`

- [ ] **Step 1: Add OpenClaw row in settings**

In `src/renderer/index.html`, after the Codex engine row, insert:

```html
              <div class="engine-row static" data-engine-row="openclaw">
                <span class="engine-row-logo openclaw" aria-hidden="true"></span>
                <span class="engine-row-body">
                  <strong>OpenClaw</strong>
                  <small id="engineRowOpenClaw">检测中...</small>
                </span>
              </div>
```

- [ ] **Step 2: Add the DOM reference**

In the `els` object in `src/renderer/app.js`, add:

```js
  engineRowOpenClaw: document.getElementById("engineRowOpenClaw"),
```

- [ ] **Step 3: Replace `renderEngineDetection()` with inventory-aware status rendering**

Use this implementation:

```js
function agentInventoryById(runtime) {
  const agents = runtime?.agentInventory?.agents || [];
  return Object.fromEntries(agents.map((agent) => [agent.id, agent]));
}

function shortAgentVersion(agent) {
  const version = String(agent?.version || "").trim();
  if (!version) return "";
  return version.split(/\s+/).slice(0, 2).join(" ");
}

function detectedAgentLine(agent) {
  if (!agent) return "未检测到";
  if (agent.usableInMia) {
    const parts = [agent.path || "已检测到", shortAgentVersion(agent)].filter(Boolean);
    return parts.join(" · ");
  }
  if (agent.installed && agent.detectionOnly) return "已检测到 · 暂未接入 Mia 聊天";
  if (agent.installed) return "已检测到 · 当前不可直接用于 Mia";
  return "未检测到";
}

function renderEngineDetection(runtime) {
  const engines = runtime?.agentEngines || {};
  const inventory = agentInventoryById(runtime);

  if (els.engineRowHermes) {
    const hermes = inventory.hermes;
    const source = hermes?.source || runtime?.engineSource;
    let line;
    if (hermes?.usableInMia && source === "mia-bundled") {
      line = runtime?.engineRunning ? "随安装包内置 · 运行中" : "随安装包内置 · 就绪";
    } else if (hermes?.usableInMia && source === "mia-managed") {
      line = runtime?.engineRunning ? "独立副本运行中" : "独立副本已安装";
    } else if (hermes?.installed) {
      line = "已检测到系统 Hermes · Mia 当前需要独立副本";
    } else {
      line = "未安装 · 点开后可安装独立副本";
    }
    els.engineRowHermes.textContent = line;
  }

  if (els.engineRowClaude) {
    els.engineRowClaude.textContent = detectedAgentLine(inventory["claude-code"] || engines.claudeCode);
  }

  if (els.engineRowCodex) {
    els.engineRowCodex.textContent = detectedAgentLine(inventory.codex || engines.codex);
  }

  if (els.engineRowOpenClaw) {
    els.engineRowOpenClaw.textContent = detectedAgentLine(inventory.openclaw || engines.openClaw);
  }
}
```

- [ ] **Step 4: Add OpenClaw styles**

In `src/renderer/styles.css`, add this near the existing setup-engine dots:

```css
.setup-engine-dot.openclaw  { background: #7c3aed; }
```

Add this near existing `.engine-row-logo` variants:

```css
.engine-row-logo.openclaw {
  background: linear-gradient(135deg, #1f2937, #7c3aed);
  color: #fff;
}

.engine-row-logo.openclaw::before {
  content: "OC";
  font-size: 10px;
  font-weight: 800;
}
```

- [ ] **Step 5: Add source-level renderer assertions**

Append these assertions to the `"renderer chat uses setup guide..."` test from Task 6:

```js
  const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const stylesSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(appSource, /engineRowOpenClaw/);
  assert.match(htmlSource, /id="engineRowOpenClaw"/);
  assert.match(stylesSource, /engine-row-logo\.openclaw/);
```

- [ ] **Step 6: Run renderer tests**

Run:

```bash
node --test tests/renderer-shell.test.js tests/renderer-setup-guide.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit settings UI**

Run:

```bash
git add src/renderer/index.html src/renderer/app.js src/renderer/styles.css tests/renderer-shell.test.js
git commit -m "feat: show OpenClaw in agent inventory UI"
```

Expected: commit succeeds in a clean worktree.

### Task 8: Verification and Handoff Notes

**Files:**
- Read only unless a verification failure points to a concrete previous-task mistake.

- [ ] **Step 1: Run focused test set**

Run:

```bash
node --test \
  tests/local-agent-engine-service.test.js \
  tests/project-structure-check.test.js \
  tests/renderer-shell.test.js \
  tests/renderer-setup-guide.test.js \
  tests/shared-contracts.test.js
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run structural check**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 4: Confirm packaging is unchanged in Phase 1**

Run:

```bash
git diff HEAD -- package.json
```

Expected: no diff. `package.json` should still contain the existing `dist:mac` Hermes runtime build command. This is intentional for Phase 1.

- [ ] **Step 5: Manual smoke check in Electron**

Run:

```bash
npm start
```

Expected manual observations:

- First-run chat surface shows Hermes, Claude Code, Codex, and OpenClaw inventory when no fellow exists.
- If no usable agent exists, the guide shows `安装 Hermes` and `暂不安装，继续进入 Mia`.
- Clicking skip enters a no-agent state instead of silently using cloud Hermes.
- Settings -> 模型 -> 本机引擎 shows Hermes, Claude Code, Codex, and OpenClaw rows.
- Clicking `安装 Hermes` still uses the existing Hermes installer and refreshes runtime state.

## Self-Review

Spec coverage:

- Local inventory for Claude Code, Codex, Hermes, OpenClaw: covered by Tasks 1, 2, 3, 5, and 7.
- First launch inventory UI: covered by Tasks 4, 5, and 6.
- Hermes install recommendation when no agent exists: covered by Tasks 5 and 6.
- User can skip install: covered by Tasks 4 and 6.
- Other agents detection-only for install: covered by Tasks 1, 5, and 7.
- No cloud Hermes default for desktop: covered by Task 6 no-agent state.
- No package-size change yet: explicitly verified in Task 8.

Intentional gaps:

- Optional official/system Hermes launch is not implemented here.
- Runtime home isolation is not changed here.
- Mia-owned memory injection is not implemented here.
- Unified `mia-app` MCP is not implemented here.
- Removing bundled Hermes from release builds is not implemented here.

Placeholder scan:

- The plan contains exact file paths, function names, code snippets, test commands, and expected outcomes.
- The plan does not contain open implementation markers.

Type consistency:

- Main process uses `agentInventory()` and `localAgentEngines()`.
- Runtime status property is `agentInventory`.
- Renderer inventory IDs are `hermes`, `claude-code`, `codex`, and `openclaw`.
- Legacy engine keys remain `hermes`, `claudeCode`, `codex`, and new `openClaw`.
- Skip state key is `mia.agentSetupSkipped.v1`.
