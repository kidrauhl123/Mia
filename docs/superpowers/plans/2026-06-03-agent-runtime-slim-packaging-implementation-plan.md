# Agent Runtime Slim Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the agent-runtime roadmap so default Mia packages do not bundle Hermes, while Mia safely supports local Hermes, Claude Code, Codex, and detection-only OpenClaw with Mia-owned session, memory, and MCP behavior.

**Architecture:** Keep each concern behind an existing or new main-process service boundary. Build from the already completed agent inventory branch, then add optional Hermes install, explicit runtime isolation, Mia memory injection, unified `mia-app` MCP, and finally default slim packaging with explicit `with-hermes` fallback builds.

**Tech Stack:** Electron main process, Node CommonJS, Node test runner, Electron preload IPC, plain browser renderer modules, Python venv installer for Hermes, stdio MCP server, electron-builder packaging.

---

## Execution Rules

- Work in an isolated git worktree. Do not touch the dirty `/Users/jung/GitHub/Mia` main checkout.
- Preserve the existing Phase 1 commits on branch `agent-inventory-phase-1`.
- Commit after every task.
- Run the focused tests named in each task before committing.
- Full `npm test` currently fails on Cloud release and production gate artifacts unrelated to this roadmap. Track that separately; do not weaken those gates.

## Completed Dependency

Phase 1 is complete on branch `agent-inventory-phase-1`:

- `runtimeStatus.agentInventory` exists.
- Onboarding/settings show Hermes, Claude Code, Codex, and OpenClaw.
- Hermes has an install action.
- OpenClaw is detection-only.
- No-agent users can continue.

Phase 1 verification:

```bash
node --test \
  tests/local-agent-engine-service.test.js \
  tests/project-structure-check.test.js \
  tests/renderer-shell.test.js \
  tests/renderer-setup-guide.test.js \
  tests/shared-contracts.test.js \
  tests/engine-install-service.test.js
```

Expected: all focused tests pass.

## File Structure

### Phase 2: Optional Hermes Installer

- Create: `src/main/hermes-install-source-service.js`  
  Owns source selection, mirror metadata, checksum parsing, and install manifest normalization.
- Create: `tests/hermes-install-source-service.test.js`  
  Unit coverage for official source, mirror source, checksum failure, and manifest shape.
- Modify: `src/main/engine-install-service.js`  
  Uses `hermes-install-source-service`, records install metadata, supports repair/reinstall, and exposes install status.
- Modify: `tests/engine-install-service.test.js`  
  Adds official install, mirror install, checksum mismatch, repair, and cancellation tests.
- Modify: `src/main.js`  
  Wires installer status into `runtimeStatus`; keeps IPC ownership thin.
- Modify: `src/shared/ipc-channels.js`, `src/preload.js`  
  Adds explicit repair IPC used by onboarding and settings.
- Modify: `src/renderer/app.js`, `src/renderer/onboarding/setup-guide.js`  
  Renders install progress, retry, repair, and failure state.
- Modify: `tests/renderer-shell.test.js`, `tests/renderer-setup-guide.test.js`  
  Covers install progress and failure UI.

### Phase 3: Runtime and Session Isolation

- Create: `src/main/agent-runtime-profile-service.js`  
  Owns Hermes, Codex, and Claude Code runtime profile construction.
- Create: `tests/agent-runtime-profile-service.test.js`  
  Proves owned homes are created and native session/history/native memory files are excluded.
- Modify: `src/main/scheduler-mcp-bridge.js`  
  Delegates Codex home creation to `agent-runtime-profile-service`.
- Modify: `src/main/codex-chat-adapter.js`  
  Fails visibly if Mia-owned Codex home cannot be created.
- Modify: `src/main/claude-code-chat-adapter.js`  
  Uses per-run Mia profile/plugin settings and avoids global Claude writes.
- Modify: `src/main/hermes-chat-adapter.js`, `src/main/engine-runtime-config-service.js`  
  Uses Mia-owned `HERMES_HOME` consistently.
- Modify: adapter tests and `tests/project-structure-check.test.js`  
  Locks boundaries.

### Phase 4: Mia Memory System

- Create: `src/main/mia-memory-service.js`  
  Owns shared user memory, per-Fellow memory, bounded block generation, and persistence.
- Create: `tests/mia-memory-service.test.js`  
  Covers storage, scoping, escaping, bounds, and no native memory reads.
- Modify: `src/main/runtime-paths.js`  
  Adds memory storage paths.
- Modify: `src/main/mia-runtime-context.js`  
  Separates runtime context from memory block composition.
- Modify: `src/main/hermes-chat-adapter.js`, `src/main/claude-code-chat-adapter.js`, `src/main/codex-chat-adapter.js`  
  Injects one Mia memory block per turn.
- Modify: adapter tests  
  Proves exactly one memory block and stable delimiters.

### Phase 5: Unified Mia App MCP

- Create: `src/main/mia-app-mcp-server.js`  
  Replaces scheduler-only MCP with scheduler, skills, social/group, and Fellow tools.
- Create: `src/main/mia-app-mcp-bridge.js`  
  Materializes server script, context, daemon URL, scoped token, and MCP spec.
- Create: `tests/mia-app-mcp-server.test.js`, `tests/mia-app-mcp-bridge.test.js`  
  Covers tool schemas, daemon calls, permission classes, and backward scheduler compatibility.
- Modify: `src/main/scheduler-mcp-bridge.js`  
  Becomes compatibility wrapper or thin alias.
- Modify: `src/main/engine-runtime-config-service.js`, `src/main/codex-chat-adapter.js`, `src/main/claude-code-chat-adapter.js`, `src/main/hermes-chat-adapter.js`  
  Uses `mia-app` MCP spec.
- Modify: `tests/scheduler-mcp-bridge.test.js`, adapter tests, daemon route tests  
  Proves compatibility and permissions.

### Phase 6: Default Slim Packaging

- Modify: `package.json`  
  Default `dist:mac` and `dist:win` no longer build Hermes. Add explicit `dist:mac:with-hermes` and `dist:win:with-hermes`.
- Create: `electron-builder.with-hermes.json`  
  Owns fallback bundled Hermes resources.
- Modify: `src/check.js`  
  Stops requiring default bundled Hermes and checks fallback path explicitly.
- Create: `tests/packaging-hermes-runtime.test.js`  
  Static tests for scripts and electron-builder resources.
- Modify: `scripts/audit-cloud-productization.js` or add a dedicated package audit helper  
  Verifies default packaged resources do not contain `hermes-runtime`.
- Modify: packaging docs if present.

## Task 1: Phase 2 Install Source Service

**Files:**
- Create: `src/main/hermes-install-source-service.js`
- Create: `tests/hermes-install-source-service.test.js`
- Modify: `tests/project-structure-check.test.js`

- [ ] **Step 1: Write failing tests for install source normalization**

Add `tests/hermes-install-source-service.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createHermesInstallSourceService,
  sha256Hex
} = require("../src/main/hermes-install-source-service.js");

test("official source records upstream identity and package spec", () => {
  const service = createHermesInstallSourceService({
    env: {},
    officialPackage: "hermes-agent",
    officialRepoUrl: "https://github.com/NousResearch/hermes-agent",
    officialRef: "main",
    officialExtras: "web"
  });

  const source = service.resolveInstallSource();

  assert.equal(source.kind, "official-github-archive");
  assert.equal(source.package, "hermes-agent");
  assert.equal(source.ref, "main");
  assert.equal(source.extras, "web");
  assert.equal(source.url, "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz");
  assert.equal(source.requirement, "hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/main.tar.gz");
  assert.equal(source.checksum, "");
});

test("mirror source keeps upstream identity and checksum", () => {
  const service = createHermesInstallSourceService({
    env: {
      MIA_ENGINE_MIRROR_URL: "https://cdn.example.test/hermes-main.tar.gz",
      MIA_ENGINE_SHA256: "a".repeat(64)
    },
    officialPackage: "hermes-agent",
    officialRepoUrl: "https://github.com/NousResearch/hermes-agent",
    officialRef: "main",
    officialExtras: "web"
  });

  const source = service.resolveInstallSource();

  assert.equal(source.kind, "mia-mirror");
  assert.equal(source.url, "https://cdn.example.test/hermes-main.tar.gz");
  assert.equal(source.upstreamUrl, "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz");
  assert.equal(source.checksum, "a".repeat(64));
  assert.equal(source.requirement, "hermes-agent[web] @ https://cdn.example.test/hermes-main.tar.gz");
});

test("verifyChecksum rejects mismatched archive bytes", () => {
  const service = createHermesInstallSourceService({
    env: { MIA_ENGINE_SHA256: "b".repeat(64) }
  });

  assert.throws(
    () => service.verifyChecksum(Buffer.from("archive"), "b".repeat(64)),
    /Hermes archive checksum mismatch/
  );
});

test("sha256Hex hashes bytes in lowercase hex", () => {
  assert.equal(
    sha256Hex(Buffer.from("hello")),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test tests/hermes-install-source-service.test.js
```

Expected: fail because `src/main/hermes-install-source-service.js` does not exist.

- [ ] **Step 3: Implement install source service**

Create `src/main/hermes-install-source-service.js`:

```js
const crypto = require("node:crypto");

function clean(value) {
  return String(value || "").trim();
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertSha256(value) {
  const checksum = clean(value).toLowerCase();
  if (!checksum) return "";
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error("Hermes archive checksum must be a 64-character sha256 hex string.");
  }
  return checksum;
}

function createHermesInstallSourceService(deps = {}) {
  const env = deps.env || process.env;
  const officialPackage = clean(deps.officialPackage || env.MIA_ENGINE_PACKAGE || "hermes-agent");
  const officialRepoUrl = clean(deps.officialRepoUrl || env.MIA_ENGINE_REPO || "https://github.com/NousResearch/hermes-agent").replace(/\/+$/, "");
  const officialRef = clean(deps.officialRef || env.MIA_ENGINE_REF || "main");
  const officialExtras = clean(deps.officialExtras || env.MIA_ENGINE_EXTRAS || "web");

  function officialUrl() {
    const explicit = clean(deps.officialUrl || env.MIA_ENGINE_URL);
    if (explicit) return explicit;
    return `${officialRepoUrl}/archive/${encodeURIComponent(officialRef)}.tar.gz`;
  }

  function requirementFor(url, extras = officialExtras) {
    const extraPart = extras ? `[${extras}]` : "";
    return `${officialPackage}${extraPart} @ ${url}`;
  }

  function resolveInstallSource() {
    const upstreamUrl = officialUrl();
    const mirrorUrl = clean(deps.mirrorUrl || env.MIA_ENGINE_MIRROR_URL);
    const checksum = assertSha256(deps.checksum || env.MIA_ENGINE_SHA256);
    const url = mirrorUrl || upstreamUrl;
    return {
      kind: mirrorUrl ? "mia-mirror" : "official-github-archive",
      package: officialPackage,
      repo: officialRepoUrl,
      ref: officialRef,
      extras: officialExtras,
      url,
      upstreamUrl,
      requirement: requirementFor(url),
      baseRequirement: requirementFor(url, ""),
      checksum
    };
  }

  function verifyChecksum(bytes, expected = "") {
    const checksum = assertSha256(expected);
    if (!checksum) return true;
    const actual = sha256Hex(bytes);
    if (actual !== checksum) {
      throw new Error(`Hermes archive checksum mismatch: expected ${checksum}, got ${actual}.`);
    }
    return true;
  }

  return {
    officialUrl,
    requirementFor,
    resolveInstallSource,
    verifyChecksum
  };
}

module.exports = {
  createHermesInstallSourceService,
  sha256Hex
};
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test tests/hermes-install-source-service.test.js
```

Expected: pass.

- [ ] **Step 5: Add project boundary guard**

Modify `tests/project-structure-check.test.js` to assert install source parsing is not in `main.js`:

```js
test("Hermes install source selection lives behind a main service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const sourceService = fs.readFileSync(path.join(root, "src/main/hermes-install-source-service.js"), "utf8");
  assert.match(sourceService, /function createHermesInstallSourceService/);
  assert.doesNotMatch(mainSource, /function resolveInstallSource/);
  assert.doesNotMatch(mainSource, /MIA_ENGINE_MIRROR_URL/);
});
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
node --test tests/hermes-install-source-service.test.js tests/project-structure-check.test.js
```

Expected: pass.

Commit:

```bash
git add src/main/hermes-install-source-service.js tests/hermes-install-source-service.test.js tests/project-structure-check.test.js
git commit -m "feat: add Hermes install source service"
```

## Task 2: Phase 2 Installer Metadata, Checksum, Repair, and Cancel

**Files:**
- Modify: `src/main/engine-install-service.js`
- Modify: `tests/engine-install-service.test.js`

- [ ] **Step 1: Write failing installer metadata tests**

Add tests to `tests/engine-install-service.test.js`:

```js
test("installFromOfficialPackage records source metadata and checksum", (t) => {
  const { runtime, service } = setup(t, {
    officialPython: "/opt/python3.11",
    installSourceService: {
      resolveInstallSource: () => ({
        kind: "mia-mirror",
        package: "hermes-agent",
        repo: "https://github.com/NousResearch/hermes-agent",
        ref: "main",
        url: "https://cdn.example.test/hermes.tar.gz",
        upstreamUrl: "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz",
        extras: "web",
        requirement: "hermes-agent[web] @ https://cdn.example.test/hermes.tar.gz",
        baseRequirement: "hermes-agent @ https://cdn.example.test/hermes.tar.gz",
        checksum: "a".repeat(64)
      })
    },
    spawnSync: (command, args, options) => {
      if (args[0] === "-c" && String(args[1] || "").includes("version_info")) {
        return { status: 0, stdout: "3.11.8\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  service.installFromOfficialPackage();

  assert.deepEqual(readJson(service.engineMarkerPath(), {}).source, "mia-mirror");
  const marker = readJson(path.join(runtime.engine, "mia-runtime.json"), {});
  assert.equal(marker.url, "https://cdn.example.test/hermes.tar.gz");
  assert.equal(marker.upstream_url, "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz");
  assert.equal(marker.checksum_sha256, "a".repeat(64));
});

test("repair removes broken managed install before reinstalling", (t) => {
  const { calls, runtime, service } = setup(t);
  fs.mkdirSync(runtime.engine, { recursive: true });
  fs.writeFileSync(path.join(runtime.engine, "broken.txt"), "broken");

  service.repair();

  assert.equal(fs.existsSync(path.join(runtime.engine, "broken.txt")), false);
  assert.ok(calls.some((call) => call.type === "stopEngine"));
});

test("install throws a user-visible cancellation error when signal is aborted", (t) => {
  const controller = new AbortController();
  controller.abort();
  const { service } = setup(t);

  assert.throws(
    () => service.install({ signal: controller.signal }),
    /Hermes install cancelled/
  );
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test tests/engine-install-service.test.js
```

Expected: fail on missing `installSourceService`, `repair`, or `install({ signal })` support.

- [ ] **Step 3: Update engine install service**

Modify `src/main/engine-install-service.js`:

```js
const { createHermesInstallSourceService } = require("./hermes-install-source-service.js");
```

Inside `createEngineInstallService`, add:

```js
const installSourceService = deps.installSourceService || createHermesInstallSourceService({
  env,
  officialPackage,
  officialRepoUrl,
  officialRef,
  officialUrl,
  officialExtras
});

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error("Hermes install cancelled.");
    error.code = "MIA_HERMES_INSTALL_CANCELLED";
    throw error;
  }
}
```

Call `throwIfCancelled(signal)` before each destructive or long-running installer step. Change `installFromOfficialPackage` signature to:

```js
function installFromOfficialPackage(options = {}) {
  const { signal = null } = options;
  throwIfCancelled(signal);
  initializeRuntime();
  stopEngine();
  const source = installSourceService.resolveInstallSource();
  // use source.requirement and source.baseRequirement instead of packageSpec/basePackageSpec
}
```

Write marker fields with stable names:

```js
fsImpl.writeFileSync(engineMarkerPath(), JSON.stringify({
  product: "mia",
  source: source.kind,
  package: source.package,
  repo: source.repo,
  ref: source.ref,
  url: source.url,
  upstream_url: source.upstreamUrl,
  extras: source.extras || null,
  checksum_sha256: source.checksum || "",
  python,
  spec: source.requirement,
  installed_at: now().toISOString()
}, null, 2) + "\n");
```

Add:

```js
function repair(options = {}) {
  initializeRuntime();
  stopEngine();
  fsImpl.rmSync(runtimePaths().engine, { recursive: true, force: true });
  return install(options);
}

function install(options = {}) {
  throwIfCancelled(options.signal);
  if (devEngineSource) return installFromDevSource(options);
  return installFromOfficialPackage(options);
}
```

Return `repair` from the service.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test tests/hermes-install-source-service.test.js tests/engine-install-service.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine-install-service.js tests/engine-install-service.test.js
git commit -m "feat: record optional Hermes install metadata"
```

## Task 3: Phase 2 Installer Runtime Status and UI

**Files:**
- Modify: `src/main.js`
- Modify: `src/shared/ipc-channels.js`
- Modify: `src/preload.js`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/onboarding/setup-guide.js`
- Modify: `tests/renderer-shell.test.js`
- Modify: `tests/renderer-setup-guide.test.js`

- [ ] **Step 1: Write source guards for installer UI**

Add to `tests/renderer-shell.test.js`:

```js
test("renderer exposes Hermes install retry and repair states", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");

  assert.match(preloadSource, /repairEngine/);
  assert.match(appSource, /function renderHermesInstallState/);
  assert.match(appSource, /data-setup-action="repair-hermes"/);
  assert.match(appSource, /data-setup-action="retry-install-hermes"/);
});
```

Add to `tests/renderer-setup-guide.test.js`:

```js
test("setup guide renders broken Hermes with repair action", () => {
  const html = render({
    runtime: {
      fellows: [],
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: true, usableInMia: false, installable: true, installAction: "repair-hermes", health: "broken", source: "mia-managed" }
      ])
    }
  });

  assert.match(html, /Hermes/);
  assert.match(html, /data-setup-action="repair-hermes"/);
  assert.match(html, /修复 Hermes/);
});
```

- [ ] **Step 2: Run failing renderer tests**

Run:

```bash
node --test tests/renderer-shell.test.js tests/renderer-setup-guide.test.js
```

Expected: fail because repair IPC/UI is missing.

- [ ] **Step 3: Add IPC wiring**

Add channel in `src/shared/ipc-channels.js`:

```js
EngineRepair: "engine:repair",
```

Add preload method in `src/preload.js`:

```js
repairEngine: () => ipcRenderer.invoke(IpcChannel.EngineRepair),
```

Add handler in `src/main.js`:

```js
ipcMain.handle(IpcChannel.EngineRepair, () => engineInstallService.repair());
```

- [ ] **Step 4: Render repair/retry actions**

In `src/renderer/onboarding/setup-guide.js`, update `agentAction(agent)`:

```js
if (agent.id === "hermes" && agent.installAction === "repair-hermes") {
  return { action: "repair-hermes", label: "修复 Hermes" };
}
if (agent.id === "hermes" && agent.installAction === "install-hermes") {
  return { action: "install-hermes", label: "安装 Hermes" };
}
```

In `src/renderer/app.js`, add:

```js
function renderHermesInstallState(runtime = state.runtime) {
  const hermes = runtime?.agentInventory?.agents?.find((agent) => agent.id === "hermes");
  if (!hermes) return "";
  if (hermes.health === "broken") return "Hermes 安装不完整，可修复或重装。";
  if (hermes.source === "mia-managed" && hermes.usableInMia) return "Hermes 已安装到 Mia 私有目录。";
  if (hermes.source === "system" && !hermes.usableInMia) return "检测到系统 Hermes，Mia 仍需要私有运行环境。";
  return "";
}
```

In setup action handler, treat `repair-hermes` like install but call `window.mia.repairEngine()`:

```js
if (action === "repair-hermes") {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "修复中…";
  try {
    state.runtime = await window.mia.repairEngine();
    state.agentSetupSkipped = false;
    try { localStorage.removeItem(AGENT_SETUP_SKIPPED_KEY); } catch { /* ignore */ }
    render();
  } catch (error) {
    appendTransientChat("assistant", `Hermes repair failed: ${error.message}`);
    await refreshRuntime();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
  return true;
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test tests/renderer-shell.test.js tests/renderer-setup-guide.test.js tests/shared-contracts.test.js
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/preload.js src/shared/ipc-channels.js src/renderer/app.js src/renderer/onboarding/setup-guide.js tests/renderer-shell.test.js tests/renderer-setup-guide.test.js
git commit -m "feat: expose Hermes install repair UI"
```

## Task 4: Phase 3 Runtime Profile Isolation

**Files:**
- Create: `src/main/agent-runtime-profile-service.js`
- Create: `tests/agent-runtime-profile-service.test.js`
- Modify: `src/main/scheduler-mcp-bridge.js`
- Modify: `src/main/codex-chat-adapter.js`
- Modify: `src/main/claude-code-chat-adapter.js`
- Modify: `src/main/hermes-chat-adapter.js`
- Modify: `tests/codex-chat-adapter.test.js`
- Modify: `tests/claude-code-chat-adapter.test.js`
- Modify: `tests/hermes-chat-adapter.test.js`
- Modify: `tests/project-structure-check.test.js`

- [ ] **Step 1: Write failing runtime profile tests**

Create `tests/agent-runtime-profile-service.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAgentRuntimeProfileService } = require("../src/main/agent-runtime-profile-service.js");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agent-profile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = { runtime: path.join(dir, "runtime"), home: path.join(dir, "runtime", "engine-home") };
  const userHome = path.join(dir, "user-home");
  fs.mkdirSync(path.join(userHome, ".codex", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(userHome, ".codex", "auth.json"), "{}");
  fs.writeFileSync(path.join(userHome, ".codex", "history.jsonl"), "{}\n");
  fs.writeFileSync(path.join(userHome, ".codex", "session_index.jsonl"), "{}\n");
  const service = createAgentRuntimeProfileService({
    runtimePaths: () => runtime,
    homeDir: () => userHome
  });
  return { dir, runtime, userHome, service };
}

test("codex profile links auth but excludes native sessions and history", (t) => {
  const { service, userHome } = setup(t);

  const profile = service.ensureCodexProfile();

  assert.equal(profile.env.CODEX_HOME, profile.home);
  assert.equal(fs.lstatSync(path.join(profile.home, "auth.json")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(profile.home, "sessions")), false);
  assert.equal(fs.existsSync(path.join(profile.home, "history.jsonl")), false);
  assert.equal(fs.existsSync(path.join(profile.home, "session_index.jsonl")), false);
  assert.equal(profile.userHome, path.join(userHome, ".codex"));
});

test("hermes profile uses Mia-owned home", (t) => {
  const { service, runtime } = setup(t);

  const profile = service.ensureHermesProfile();

  assert.equal(profile.env.HERMES_HOME, runtime.home);
  assert.equal(profile.env.MIA_HOME, runtime.home);
  assert.ok(fs.existsSync(runtime.home));
});
```

- [ ] **Step 2: Run failing profile tests**

Run:

```bash
node --test tests/agent-runtime-profile-service.test.js
```

Expected: fail because service does not exist.

- [ ] **Step 3: Implement runtime profile service**

Create `src/main/agent-runtime-profile-service.js` with:

```js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEX_BLOCKED_STATE = new Set(["sessions", "history.jsonl", "session_index.jsonl", "memory", "memories"]);

function createAgentRuntimeProfileService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const fsImpl = deps.fs || fs;
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();

  function linkSafeUserState(userHome, miaHome) {
    if (!fsImpl.existsSync(userHome)) return;
    fsImpl.mkdirSync(miaHome, { recursive: true });
    for (const name of fsImpl.readdirSync(userHome)) {
      if (name === "config.toml") continue;
      if (CODEX_BLOCKED_STATE.has(name)) continue;
      const target = path.join(userHome, name);
      const link = path.join(miaHome, name);
      try { fsImpl.rmSync(link, { recursive: true, force: true }); } catch { /* missing */ }
      const stat = fsImpl.statSync(target);
      fsImpl.symlinkSync(target, link, stat.isDirectory() ? "dir" : "file");
    }
  }

  function ensureCodexProfile() {
    const home = path.join(runtimePaths().runtime, "codex-home");
    const userHome = path.join(homeDir(), ".codex");
    fsImpl.mkdirSync(home, { recursive: true });
    linkSafeUserState(userHome, home);
    return { home, userHome, env: { CODEX_HOME: home } };
  }

  function ensureHermesProfile() {
    const p = runtimePaths();
    fsImpl.mkdirSync(p.home, { recursive: true });
    return { home: p.home, env: { HERMES_HOME: p.home, MIA_HOME: p.home } };
  }

  function claudeRunProfile() {
    const home = path.join(runtimePaths().runtime, "claude-code-home");
    fsImpl.mkdirSync(home, { recursive: true });
    return { home, env: { MIA_CLAUDE_HOME: home } };
  }

  return { ensureCodexProfile, ensureHermesProfile, claudeRunProfile };
}

module.exports = { createAgentRuntimeProfileService, CODEX_BLOCKED_STATE };
```

- [ ] **Step 4: Wire Codex fail-closed behavior**

Change `src/main/codex-chat-adapter.js` so `ensureCodexHome()` failure throws:

```js
let codexHomePath = "";
try {
  codexHomePath = ensureCodexHome();
} catch (error) {
  throw new Error(`Mia Codex profile setup failed: ${error?.message || error}`);
}
if (!codexHomePath) throw new Error("Mia Codex profile setup failed: missing CODEX_HOME.");
const env = { ...baseEnv, CODEX_HOME: codexHomePath };
```

Update `tests/codex-chat-adapter.test.js` with:

```js
test("sendChat fails closed when Mia Codex home cannot be created", async () => {
  const adapter = createCodexChatAdapter({
    ...baseDeps(),
    shellCommandPath: () => "/bin/codex",
    ensureCodexHome: () => { throw new Error("disk denied"); }
  });

  await assert.rejects(
    () => adapter.sendChat({ fellow: fellow(), sessionId: "s1", messages: [{ role: "user", content: "hi" }] }),
    /Mia Codex profile setup failed: disk denied/
  );
});
```

- [ ] **Step 5: Run focused profile and adapter tests**

Run:

```bash
node --test \
  tests/agent-runtime-profile-service.test.js \
  tests/codex-chat-adapter.test.js \
  tests/claude-code-chat-adapter.test.js \
  tests/hermes-chat-adapter.test.js \
  tests/project-structure-check.test.js
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent-runtime-profile-service.js src/main/scheduler-mcp-bridge.js src/main/codex-chat-adapter.js src/main/claude-code-chat-adapter.js src/main/hermes-chat-adapter.js tests/agent-runtime-profile-service.test.js tests/codex-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/hermes-chat-adapter.test.js tests/project-structure-check.test.js
git commit -m "feat: isolate native agent runtime profiles"
```

## Task 5: Phase 4 Mia Memory Service and Adapter Injection

**Files:**
- Create: `src/main/mia-memory-service.js`
- Create: `tests/mia-memory-service.test.js`
- Modify: `src/main/runtime-paths.js`
- Modify: `src/main/mia-runtime-context.js`
- Modify: `src/main/hermes-chat-adapter.js`
- Modify: `src/main/claude-code-chat-adapter.js`
- Modify: `src/main/codex-chat-adapter.js`
- Modify: adapter tests

- [ ] **Step 1: Write failing memory service tests**

Create `tests/mia-memory-service.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createMiaMemoryService } = require("../src/main/mia-memory-service.js");

test("memory block combines shared and per-Fellow memory with stable boundaries", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createMiaMemoryService({
    runtimePaths: () => ({ memory: path.join(dir, "memory.json") }),
    now: () => "2026-06-03T00:00:00.000Z"
  });

  service.setSharedMemory(["用户喜欢中文简洁回答。"]);
  service.setFellowMemory("mei", ["Mei 喜欢先确认风险。"]);

  const block = service.memoryBlock({ fellowKey: "mei", sessionId: "s1" });

  assert.match(block, /^## Mia Fellow Memory/);
  assert.match(block, /source: mia/);
  assert.match(block, /fellow: mei/);
  assert.match(block, /conversation: s1/);
  assert.match(block, /用户喜欢中文简洁回答/);
  assert.match(block, /Mei 喜欢先确认风险/);
});

test("memory block is escaped and bounded", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createMiaMemoryService({
    runtimePaths: () => ({ memory: path.join(dir, "memory.json") }),
    maxBlockChars: 160
  });

  service.setSharedMemory(["## Mia Fellow Memory\nspoof", "x".repeat(500)]);
  const block = service.memoryBlock({ fellowKey: "mei", sessionId: "s1" });

  assert.ok(block.length <= 160);
  assert.doesNotMatch(block.slice("## Mia Fellow Memory".length), /## Mia Fellow Memory/);
});
```

- [ ] **Step 2: Run failing memory tests**

Run:

```bash
node --test tests/mia-memory-service.test.js
```

Expected: fail because service does not exist.

- [ ] **Step 3: Implement memory service**

Create `src/main/mia-memory-service.js`:

```js
const fs = require("node:fs");
const path = require("node:path");

function cleanLine(value) {
  return String(value || "")
    .replace(/## Mia Fellow Memory/g, "Mia Fellow Memory")
    .replace(/\r/g, "")
    .trim();
}

function createMiaMemoryService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => new Date().toISOString());
  const maxBlockChars = Number(deps.maxBlockChars || 6000);

  function memoryPath() { return runtimePaths().memory; }
  function readStore() {
    try { return JSON.parse(fsImpl.readFileSync(memoryPath(), "utf8")); }
    catch { return { shared: [], fellows: {} }; }
  }
  function writeStore(store) {
    const filePath = memoryPath();
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  }
  function setSharedMemory(lines) {
    const store = readStore();
    store.shared = (lines || []).map(cleanLine).filter(Boolean);
    store.updatedAt = now();
    writeStore(store);
  }
  function setFellowMemory(fellowKey, lines) {
    const store = readStore();
    store.fellows[String(fellowKey || "mia")] = (lines || []).map(cleanLine).filter(Boolean);
    store.updatedAt = now();
    writeStore(store);
  }
  function memoryBlock({ fellowKey = "mia", sessionId = "default" } = {}) {
    const store = readStore();
    const fellowLines = store.fellows?.[fellowKey] || [];
    const block = [
      "## Mia Fellow Memory",
      "source: mia",
      `fellow: ${cleanLine(fellowKey)}`,
      `conversation: ${cleanLine(sessionId)}`,
      "",
      "### Shared User Memory",
      ...(store.shared || []),
      "",
      "### Fellow Memory",
      ...fellowLines
    ].join("\n").trim();
    return block.slice(0, maxBlockChars);
  }

  return { memoryBlock, readStore, setFellowMemory, setSharedMemory };
}

module.exports = { createMiaMemoryService };
```

- [ ] **Step 4: Add runtime path**

Modify `src/main/runtime-paths.js`:

```js
memory: path.join(home, "mia-memory.json"),
```

- [ ] **Step 5: Inject memory in adapters**

Add a dependency `memoryBlock` to each chat adapter with default `() => ""`. For each `sendChat`, compute:

```js
const miaMemory = memoryBlock({ fellowKey: fellow.key, sessionId });
```

Inject `[miaRuntimeContext, miaMemory, persona]` through the adapter's strongest instruction channel. For Hermes, this should be a system message before user messages. For Claude Code, append to `systemPrompt.append`. For Codex, place it before persona/user text in the prompt.

Guard duplication:

```js
function appendOnce(base, block) {
  const text = String(base || "");
  const addition = String(block || "").trim();
  if (!addition || text.includes("## Mia Fellow Memory")) return text;
  return [text.trim(), addition].filter(Boolean).join("\n\n");
}
```

- [ ] **Step 6: Add adapter tests**

Each adapter test should assert:

```js
assert.equal((prompt.match(/## Mia Fellow Memory/g) || []).length, 1);
assert.match(prompt, /source: mia/);
```

Also add tests where the user prompt contains `## Mia Fellow Memory`; expected adapter output still has exactly one Mia-generated memory block.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
node --test \
  tests/mia-memory-service.test.js \
  tests/hermes-chat-adapter.test.js \
  tests/claude-code-chat-adapter.test.js \
  tests/codex-chat-adapter.test.js \
  tests/runtime-initializer-service.test.js
```

Expected: pass.

Commit:

```bash
git add src/main/mia-memory-service.js src/main/runtime-paths.js src/main/mia-runtime-context.js src/main/hermes-chat-adapter.js src/main/claude-code-chat-adapter.js src/main/codex-chat-adapter.js tests/mia-memory-service.test.js tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/runtime-initializer-service.test.js
git commit -m "feat: add Mia memory injection"
```

## Task 6: Phase 5 Unified Mia App MCP

**Files:**
- Create: `src/main/mia-app-mcp-server.js`
- Create: `src/main/mia-app-mcp-bridge.js`
- Create: `tests/mia-app-mcp-server.test.js`
- Create: `tests/mia-app-mcp-bridge.test.js`
- Modify: `src/main/scheduler-mcp-bridge.js`
- Modify: `src/main/engine-runtime-config-service.js`
- Modify: `src/main/codex-chat-adapter.js`
- Modify: `src/main/claude-code-chat-adapter.js`
- Modify: adapter and scheduler tests

- [ ] **Step 1: Write failing MCP bridge tests**

Create `tests/mia-app-mcp-bridge.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createMiaAppMcpBridge } = require("../src/main/mia-app-mcp-bridge.js");

test("Mia app MCP spec exposes stdio command and scoped daemon token", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-app-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceServer = path.join(dir, "source-server.js");
  fs.writeFileSync(sourceServer, "process.exit(0);\n");
  const bridge = createMiaAppMcpBridge({
    runtimePaths: () => ({ runtime: path.join(dir, "runtime") }),
    daemonStatus: () => ({ baseUrl: "http://127.0.0.1:18000" }),
    daemonToken: () => "daemon-token",
    nodePath: () => "/opt/node",
    serverScriptPath: () => sourceServer
  });

  const spec = bridge.getSpec({ fellowId: "mei", sessionId: "s1" });

  assert.equal(spec.type, "stdio");
  assert.equal(spec.command, "/opt/node");
  assert.equal(spec.env.MIA_DAEMON_URL, "http://127.0.0.1:18000");
  assert.equal(spec.env.MIA_DAEMON_TOKEN, "daemon-token");
  assert.equal(spec.env.MIA_APP_CONTEXT_FILE.endsWith("context.json"), true);
  assert.deepEqual(spec.args, [path.join(dir, "runtime", "mia-app-mcp", "mia-app-mcp-server.js")]);
});
```

- [ ] **Step 2: Write failing MCP server schema tests**

Create `tests/mia-app-mcp-server.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { toolDefinitions, permissionClassForTool } = require("../src/main/mia-app-mcp-server.js");

test("mia-app MCP exposes scheduler, skills, social, and fellow tools", () => {
  const names = toolDefinitions().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "conversation_create_group",
    "conversation_list",
    "conversation_post_message",
    "fellow_list",
    "schedule_create",
    "schedule_delete",
    "schedule_list",
    "schedule_pause",
    "schedule_resume",
    "schedule_update",
    "skill_install",
    "skill_search",
    "skill_show"
  ]);
});

test("write tools require permission", () => {
  assert.equal(permissionClassForTool("schedule_list"), "read");
  assert.equal(permissionClassForTool("skill_search"), "read");
  assert.equal(permissionClassForTool("skill_install"), "write");
  assert.equal(permissionClassForTool("conversation_create_group"), "write");
  assert.equal(permissionClassForTool("conversation_post_message"), "write");
});
```

- [ ] **Step 3: Run failing MCP tests**

Run:

```bash
node --test tests/mia-app-mcp-bridge.test.js tests/mia-app-mcp-server.test.js
```

Expected: fail because modules do not exist.

- [ ] **Step 4: Implement MCP server definitions**

Create `src/main/mia-app-mcp-server.js` with tool definitions and permission classification:

```js
const READ_TOOLS = new Set(["schedule_list", "skill_search", "skill_show", "conversation_list", "fellow_list"]);
const WRITE_TOOLS = new Set(["schedule_create", "schedule_update", "schedule_delete", "schedule_pause", "schedule_resume", "skill_install", "conversation_create_group", "conversation_post_message"]);

function toolDefinitions() {
  return [
    { name: "schedule_create", description: "Create a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_list", description: "List Mia scheduled tasks.", inputSchema: { type: "object" } },
    { name: "schedule_update", description: "Update a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_delete", description: "Delete a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_pause", description: "Pause a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_resume", description: "Resume a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "skill_search", description: "Search Mia skill marketplace.", inputSchema: { type: "object" } },
    { name: "skill_show", description: "Show Mia skill details.", inputSchema: { type: "object" } },
    { name: "skill_install", description: "Install a Mia skill for the current user.", inputSchema: { type: "object" } },
    { name: "conversation_list", description: "List Mia conversations available to the current user.", inputSchema: { type: "object" } },
    { name: "conversation_create_group", description: "Create a Mia group conversation.", inputSchema: { type: "object" } },
    { name: "conversation_post_message", description: "Post a message into a Mia conversation.", inputSchema: { type: "object" } },
    { name: "fellow_list", description: "List Mia Fellows and basic runtime metadata.", inputSchema: { type: "object" } }
  ];
}

function permissionClassForTool(name) {
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  return "unknown";
}

module.exports = { permissionClassForTool, toolDefinitions };
```

- [ ] **Step 5: Implement MCP bridge**

Create `src/main/mia-app-mcp-bridge.js` mirroring scheduler bridge materialization but using `mia-app-mcp` paths and `MIA_APP_CONTEXT_FILE`.

The returned spec must use:

```js
{
  type: "stdio",
  command,
  args: [runtimeServerScriptPath],
  env: {
    MIA_DAEMON_URL: baseUrl,
    MIA_DAEMON_TOKEN: daemonToken(),
    MIA_APP_CONTEXT_FILE: contextPath()
  },
  alwaysLoad: true
}
```

- [ ] **Step 6: Wire adapters to `mia-app` while preserving scheduler compatibility**

Adapters should pass:

```js
mcpServers: { "mia-app": miaAppMcpSpec, "mia-scheduler": schedulerCompatSpec }
```

until scheduler compatibility tests are migrated. Hermes config should include `mia-app` and may keep `mia-scheduler` during compatibility.

- [ ] **Step 7: Run focused MCP and adapter tests**

Run:

```bash
node --test \
  tests/mia-app-mcp-bridge.test.js \
  tests/mia-app-mcp-server.test.js \
  tests/scheduler-mcp-bridge.test.js \
  tests/hermes-chat-adapter.test.js \
  tests/claude-code-chat-adapter.test.js \
  tests/codex-chat-adapter.test.js \
  tests/engine-runtime-config-service.test.js
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/main/mia-app-mcp-server.js src/main/mia-app-mcp-bridge.js src/main/scheduler-mcp-bridge.js src/main/engine-runtime-config-service.js src/main/hermes-chat-adapter.js src/main/claude-code-chat-adapter.js src/main/codex-chat-adapter.js tests/mia-app-mcp-server.test.js tests/mia-app-mcp-bridge.test.js tests/scheduler-mcp-bridge.test.js tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/engine-runtime-config-service.test.js
git commit -m "feat: add unified Mia app MCP"
```

## Task 7: Phase 6 Default Slim Packaging

**Files:**
- Modify: `package.json`
- Modify: `src/check.js`
- Create: `tests/packaging-hermes-runtime.test.js`
- Modify: `scripts/audit-cloud-productization.js` if packaged audit remains coupled to app.asar checks

- [ ] **Step 1: Write failing packaging tests**

Create `tests/packaging-hermes-runtime.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function packageJson() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

function withHermesConfig() {
  return JSON.parse(fs.readFileSync(path.join(root, "electron-builder.with-hermes.json"), "utf8"));
}

test("default desktop package scripts do not build Hermes runtime", () => {
  const pkg = packageJson();
  assert.doesNotMatch(pkg.scripts["dist:mac"], /hermes:runtime/);
  assert.doesNotMatch(pkg.scripts["dist:win"], /hermes:runtime/);
  assert.match(pkg.scripts["dist:mac:with-hermes"], /hermes:runtime:mac-arm64/);
  assert.match(pkg.scripts["dist:win:with-hermes"], /hermes:runtime:win-x64/);
});

test("default electron-builder resources exclude Hermes runtime", () => {
  const pkg = packageJson();
  const fallback = withHermesConfig();
  assert.doesNotMatch(JSON.stringify(pkg.build.mac || {}), /vendor\/hermes-runtime/);
  assert.doesNotMatch(JSON.stringify(pkg.build.win || {}), /vendor\/hermes-runtime/);
  assert.match(JSON.stringify(fallback), /vendor\/hermes-runtime/);
});
```

- [ ] **Step 2: Run failing packaging tests**

Run:

```bash
node --test tests/packaging-hermes-runtime.test.js
```

Expected: fail because default scripts and resources still include Hermes.

- [ ] **Step 3: Change package scripts**

Modify `package.json` scripts:

```json
"dist:mac": "electron-builder --mac dir zip --publish never && node scripts/create-mac-dmg.js",
"dist:mac:with-hermes": "npm run hermes:runtime:mac-arm64 && electron-builder --mac dir zip --config.extraMetadata.hermesBundled=true --publish never && node scripts/create-mac-dmg.js",
"dist:win": "electron-builder --win nsis --publish never",
"dist:win:with-hermes": "npm run hermes:runtime:win-x64 && electron-builder --win nsis --config.extraMetadata.hermesBundled=true --publish never"
```

Move Hermes `extraResources` out of default `build.mac` and `build.win`. Create `electron-builder.with-hermes.json`:

```json
{
  "mac": {
    "extraResources": [
      { "from": "vendor/hermes-runtime/mac-arm64", "to": "hermes-runtime", "filter": ["**/*"] }
    ]
  },
  "win": {
    "extraResources": [
      { "from": "vendor/hermes-runtime/win-x64", "to": "hermes-runtime", "filter": ["**/*"] }
    ]
  },
  "extraMetadata": {
    "hermesBundled": true
  }
}
```

Then use:

```json
"dist:mac:with-hermes": "npm run hermes:runtime:mac-arm64 && electron-builder --mac dir zip --config electron-builder.with-hermes.json --publish never && node scripts/create-mac-dmg.js",
"dist:win:with-hermes": "npm run hermes:runtime:win-x64 && electron-builder --win nsis --config electron-builder.with-hermes.json --publish never"
```

- [ ] **Step 4: Update structure check**

Change `src/check.js` so default runtime path helpers can still resolve a bundled runtime if one exists, but the structure check no longer requires default package resources to include it. Add an assertion that default `package.json` excludes Hermes.

- [ ] **Step 5: Run focused packaging checks**

Run:

```bash
node --test tests/packaging-hermes-runtime.test.js
npm run check
```

Expected: pass.

- [ ] **Step 6: Build default package directory and audit resources**

Run:

```bash
npm run pack
```

Expected: app directory builds without running `scripts/build-hermes-runtime.sh`.

Then inspect:

```bash
find release -path '*hermes-runtime*' -maxdepth 6
```

Expected: no output for default package.

- [ ] **Step 7: Commit**

```bash
git add package.json src/check.js tests/packaging-hermes-runtime.test.js electron-builder.with-hermes.json
git commit -m "feat: remove Hermes from default desktop packages"
```

## Task 8: Completion Audit for the Whole Goal

**Files:**
- Modify docs only if audit reveals missing acceptance evidence.

- [ ] **Step 1: Run focused roadmap tests**

Run:

```bash
node --test \
  tests/local-agent-engine-service.test.js \
  tests/hermes-install-source-service.test.js \
  tests/engine-install-service.test.js \
  tests/agent-runtime-profile-service.test.js \
  tests/mia-memory-service.test.js \
  tests/mia-app-mcp-server.test.js \
  tests/mia-app-mcp-bridge.test.js \
  tests/packaging-hermes-runtime.test.js \
  tests/project-structure-check.test.js \
  tests/hermes-chat-adapter.test.js \
  tests/claude-code-chat-adapter.test.js \
  tests/codex-chat-adapter.test.js \
  tests/renderer-shell.test.js \
  tests/renderer-setup-guide.test.js \
  tests/shared-contracts.test.js
```

Expected: pass.

- [ ] **Step 2: Run project structure check**

Run:

```bash
npm run check
```

Expected: pass.

- [ ] **Step 3: Run default package smoke**

Run:

```bash
npm run pack
find release -path '*hermes-runtime*' -maxdepth 6
```

Expected: build succeeds and `find` prints no default package Hermes runtime path.

- [ ] **Step 4: Run explicit fallback package smoke**

Run:

```bash
npm run dist:mac:with-hermes
find release -path '*hermes-runtime*' -maxdepth 6
```

Expected: fallback build succeeds and `find` prints a `hermes-runtime` path only for the fallback output.

- [ ] **Step 5: Full test suite**

Run:

```bash
npm test
```

Expected: any remaining failures must be release/production gates already documented by Cloud productization tests. If new roadmap tests fail, fix them before claiming completion.

- [ ] **Step 6: Manual matrix evidence**

Record manual evidence for:

```text
no-agent machine:
  - inventory shows no usable agents
  - skip path works
  - Hermes optional install can be started

Claude Code machine:
  - Mia detects claude
  - Mia chat works
  - official Claude outside Mia keeps normal config/history

Codex machine:
  - Mia detects codex
  - Mia chat works with Mia CODEX_HOME
  - official Codex outside Mia keeps normal config/history

Hermes machine:
  - Mia detects Hermes
  - Mia runs Hermes with Mia-owned HERMES_HOME
  - official Hermes outside Mia keeps normal memory/session behavior
```

- [ ] **Step 7: Final commit or integration**

If audit passes, run:

```bash
git status --short
git log --oneline --decorate --max-count=20
```

Expected: clean worktree and roadmap commits visible.

Then decide merge/PR workflow.

## Self-Review

Spec coverage:

- Default package excludes Hermes: Task 7.
- Explicit fallback package keeps Hermes possible: Task 7.
- Optional Hermes install with metadata, repair, checksum, mirror: Tasks 1 to 3.
- Compatible native Agent detection and no-agent UI: completed Phase 1 plus Task 3 repair state.
- Session isolation: Task 4.
- Mia memory system: Task 5.
- Unified Mia app MCP and permissions: Task 6.
- Completion evidence: Task 8.

Type consistency:

- `mia-app` is the MCP server name used by bridge and adapter tasks.
- `CODEX_HOME`, `HERMES_HOME`, and `MIA_HOME` are the environment keys used by profile tasks.
- `## Mia Fellow Memory` is the stable memory delimiter used by service and adapter tasks.
- `dist:mac:with-hermes` and `dist:win:with-hermes` are the explicit fallback script names used by packaging tasks.
