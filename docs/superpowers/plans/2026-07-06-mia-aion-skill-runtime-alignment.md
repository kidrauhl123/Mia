# Mia AION Skill Runtime Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Mia's mixed local skill delivery/runtime seams with one Skill Runtime Owner, native-link Claude/Codex, shared fallback Hermes/OpenClaw, and remove `cloud-hermes`.

**Architecture:** Introduce `src/main/mia-core/skill-runtime-owner.js` as the sole seam that resolves Bot skill state, chooses `native-link` versus `prompt-fallback`, computes `skillFingerprint`, and reconciles workspace-managed links. Extend ACP session plumbing to carry `skillFingerprint` and managed fallback prompt hooks, then delete Claude bridge plugin, Hermes global `external_dirs`, native context skill files, and all `cloud-hermes` aliases/branches.

**Tech Stack:** Node.js CommonJS, Electron main/renderer, ACP AgentSession, filesystem symlink management, `node:test`, YAML config rendering

## Global Constraints

- Remove `cloud-hermes` logic, data compatibility aliases, and dead runtime branches.
- Engines without proven support will use prompt fallback through the same seam.
- The runtime must not infer an independent skill set from engine state, global user homes, or engine-native config directories.
- The supported cloud runtime after this work is `cloud-claude-code`.
- Delete only paths recorded in Mia's managed manifest.
- If future runtime research proves that Hermes or OpenClaw support workspace native skill discovery, that must be enabled by changing engine metadata and native-link tests, not by introducing a new special-case skill delivery path.

---

## File Structure

- Create: `src/main/mia-core/skill-runtime-owner.js`
  Own Bot skill resolution, delivery-mode selection, `skillFingerprint`, workspace reconcile, and prompt-fallback materialization helpers.
- Create: `tests/skill-runtime-owner.test.js`
  Cover delivery-mode resolution, deterministic fingerprints, and managed link cleanup rules.
- Modify: `src/shared/agent-engine-policy.js`
  Add `nativeSkillsDirs` metadata for each local engine.
- Modify: `src/main/agent-session/agent-session-contract.js`
  Add `skillFingerprint` to the AgentSession key seam.
- Modify: `src/main/agent-session/agent-session-manager.js`
  Pass `skillFingerprint` through descriptors without altering queue semantics.
- Modify: `src/main/agent-session-runtime-preparer.js`
  Call `Skill Runtime Owner`, reconcile native skill dirs for Claude/Codex, and surface fallback prompt hooks for Hermes/OpenClaw.
- Modify: `src/main/agent-session/native-input-policy.js`
  Allow controlled per-turn fallback fields for managed ACP skill retries.
- Modify: `src/main/agent-session/acp-agent-session.js`
  Add per-turn prompt prefixes and managed `[LOAD_SKILL: ...]` retry handling before terminal events fire.
- Modify: `src/main/bot-execution-core.js`
  Pass `skillFingerprint` plus managed fallback payloads into AgentSession turns, while keeping adapter-only prompt materialization on non-managed paths.
- Modify: `src/main/social/local-bot-responder.js`
  Pass `skillFingerprint` plus managed fallback payloads into background/local managed AgentSession turns.
- Modify: `src/main.js`
  Stop instantiating Claude bridge skill transport and stop passing Hermes `externalSkillDirs`.
- Modify: `src/main/engine-runtime-config-service.js`
  Remove Hermes `externalSkillDirs` plumbing and tests that assert `skills.external_dirs`.
- Delete: `src/main/claude-bridge-plugin-service.js`
  Remove the global Claude bridge skill transport.
- Delete: `src/main/mia-native-context-bridge.js`
  Remove unused `IDENTITY.md` / `TOOLS.md` skill transport.
- Modify: `src/shared/bot-runtime-control.js`, `src/shared/cloud-runtime.js`, `src/cloud-agent/dispatcher.js`
  Remove `cloud-hermes` aliasing and runtime branches.
- Modify: `src/renderer/bot/bot-directory.js`, `src/renderer/bot/bot-dialog.js`, `src/renderer/bot/bot-store.js`, `src/renderer/bot/starter-engine-bots.js`, `src/renderer/bot/bot-commands.js`, `src/web/app.js`
  Remove UI/runtime normalization paths that still accept `cloud-hermes`.
- Delete or update tests: `tests/claude-bridge-plugin-service.test.js`, `tests/mia-native-context-bridge.test.js`, `tests/project-structure-check.test.js`, `tests/engine-runtime-config-service.test.js`, `tests/agent-engine-policy.test.js`, `tests/agent-session-contract.test.js`, `tests/agent-session-runtime-preparer.test.js`, `tests/native-input-policy.test.js`, `tests/acp-agent-session.test.js`, `tests/bot-execution-core.test.js`, `tests/starter-engine-bots.test.js`, `tests/renderer-shell.test.js`, `tests/cloud-agent-dispatcher.test.js`

### Task 1: Add Engine Skill Metadata And Skill Runtime Owner

**Files:**
- Create: `src/main/mia-core/skill-runtime-owner.js`
- Create: `tests/skill-runtime-owner.test.js`
- Modify: `src/shared/agent-engine-policy.js`
- Test: `tests/agent-engine-policy.test.js`

**Interfaces:**
- Consumes: `agentEnginePolicy(engine: string): EngineRuntimePolicy`
- Produces: `createSkillRuntimeOwner(options): { resolveRuntimeSkillState(input): SkillRuntimeState }`
- Produces: `resolveRuntimeSkillState({ bot, agentEngine, activeSkillIds, intentSkillIds, requestedSkillIds }): { deliveryMode: "native-link" | "prompt-fallback", nativeSkillsDirs: string[], resolvedSkillIds: string[], resolvedSkills: Array<{ id: string, name: string, sourcePath: string, body: string }>, skillFingerprint: string, skillMaterialization: null | { indexBlock: string, loadedBlock: string, loadedSkillIds: string[] }, initialPromptPrefix: string }`

- [ ] **Step 1: Write the failing tests for engine metadata and delivery-mode resolution**

```js
test("agent engine policy exposes native skill directory metadata", () => {
  assert.deepEqual(agentEnginePolicy("claude-code").nativeSkillsDirs, [".claude/skills"]);
  assert.deepEqual(agentEnginePolicy("codex").nativeSkillsDirs, [".codex/skills"]);
  assert.equal(agentEnginePolicy("hermes").nativeSkillsDirs, null);
  assert.equal(agentEnginePolicy("openclaw").nativeSkillsDirs, null);
});

test("skill runtime owner resolves native-link and prompt-fallback deterministically", () => {
  const owner = createSkillRuntimeOwner({
    listSkillRecordsForBot: (bot) => bot.skillRecords || [],
    materializePromptFallback: ({ resolvedSkillIds }) => ({
      indexBlock: `INDEX:${resolvedSkillIds.join(",")}`,
      loadedBlock: "",
      loadedSkillIds: []
    })
  });

  const nativeState = owner.resolveRuntimeSkillState({
    bot: {
      capabilities: { enabledSkills: ["pdf"] },
      skillRecords: [{ id: "pdf", name: "pdf", sourcePath: "/skills/pdf", body: "# pdf" }]
    },
    agentEngine: "claude-code",
    activeSkillIds: [],
    intentSkillIds: [],
    requestedSkillIds: []
  });

  assert.equal(nativeState.deliveryMode, "native-link");
  assert.deepEqual(nativeState.nativeSkillsDirs, [".claude/skills"]);
  assert.equal(nativeState.skillMaterialization, null);
  assert.match(nativeState.skillFingerprint, /^[a-f0-9]{16}$/);

  const fallbackState = owner.resolveRuntimeSkillState({
    bot: {
      capabilities: { enabledSkills: ["xlsx"] },
      skillRecords: [{ id: "xlsx", name: "xlsx", sourcePath: "/skills/xlsx", body: "# xlsx" }]
    },
    agentEngine: "hermes",
    activeSkillIds: [],
    intentSkillIds: [],
    requestedSkillIds: []
  });

  assert.equal(fallbackState.deliveryMode, "prompt-fallback");
  assert.deepEqual(fallbackState.nativeSkillsDirs, []);
  assert.equal(fallbackState.skillMaterialization.indexBlock, "INDEX:xlsx");
});
```

- [ ] **Step 2: Run the targeted tests to confirm the seam does not exist yet**

Run: `node --test tests/agent-engine-policy.test.js tests/skill-runtime-owner.test.js`

Expected: FAIL with a missing `skill-runtime-owner.js` module error and missing `nativeSkillsDirs` assertions in `agent-engine-policy.test.js`.

- [ ] **Step 3: Implement the metadata table and pure Skill Runtime Owner**

```js
const crypto = require("node:crypto");
const { agentEnginePolicy, normalizeAgentEngine } = require("../../shared/agent-engine-policy.js");

function hashSkillFingerprint(parts = []) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

function createSkillRuntimeOwner(options = {}) {
  const listSkillRecordsForBot = typeof options.listSkillRecordsForBot === "function"
    ? options.listSkillRecordsForBot
    : () => [];
  const materializePromptFallback = typeof options.materializePromptFallback === "function"
    ? options.materializePromptFallback
    : () => ({ indexBlock: "", loadedBlock: "", loadedSkillIds: [] });

  function resolveRuntimeSkillState({
    bot = {},
    agentEngine = "",
    activeSkillIds = [],
    intentSkillIds = [],
    requestedSkillIds = []
  } = {}) {
    const engine = normalizeAgentEngine(agentEngine || bot.agentEngine || bot.agent_engine || "hermes");
    const policy = agentEnginePolicy(engine);
    const nativeSkillsDirs = Array.isArray(policy.nativeSkillsDirs) ? policy.nativeSkillsDirs.slice() : [];
    const records = listSkillRecordsForBot(bot);
    const enabled = new Set((bot.capabilities?.enabledSkills || []).map((id) => String(id || "").trim()).filter(Boolean));
    for (const id of [...activeSkillIds, ...intentSkillIds, ...requestedSkillIds]) enabled.add(String(id || "").trim());
    const resolvedSkills = records.filter((record) => enabled.has(String(record.id || "").trim()));
    const resolvedSkillIds = resolvedSkills.map((record) => String(record.id || "").trim()).filter(Boolean).sort();
    const deliveryMode = nativeSkillsDirs.length ? "native-link" : "prompt-fallback";
    const skillFingerprint = hashSkillFingerprint([deliveryMode, resolvedSkillIds]);
    const skillMaterialization = deliveryMode === "prompt-fallback"
      ? materializePromptFallback({ bot, engine, resolvedSkillIds, resolvedSkills, activeSkillIds, intentSkillIds, requestedSkillIds })
      : null;

    return {
      deliveryMode,
      nativeSkillsDirs,
      resolvedSkillIds,
      resolvedSkills,
      skillFingerprint,
      skillMaterialization,
      initialPromptPrefix: ""
    };
  }

  return { resolveRuntimeSkillState };
}
```

```js
const ENGINE_RUNTIME_POLICIES = Object.freeze({
  [EngineId.Hermes]: Object.freeze({
    id: EngineId.Hermes,
    homeStrategy: "native-user-home",
    nativeHomeSubdir: ".hermes",
    nativeSkillsDirs: null,
    permissionScope: "engine",
    permissionStore: "root-mode",
    permissionCodec: "hermes-approvals-mode",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "hermes-runtime-config"
  }),
  [EngineId.ClaudeCode]: Object.freeze({
    id: EngineId.ClaudeCode,
    homeStrategy: "native-engine-default",
    nativeHomeSubdir: "",
    nativeSkillsDirs: Object.freeze([".claude/skills"]),
    permissionScope: "engine",
    permissionStore: "engine-map",
    permissionCodec: "claude-code-permission-mode",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "adapter-options"
  }),
  [EngineId.Codex]: Object.freeze({
    id: EngineId.Codex,
    homeStrategy: "native-user-home",
    nativeHomeSubdir: ".codex",
    nativeSkillsDirs: Object.freeze([".codex/skills"]),
    permissionScope: "engine",
    permissionStore: "engine-map",
    permissionCodec: "codex-permission-profile",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "codex-permission-on-change"
  }),
  [EngineId.OpenClaw]: Object.freeze({
    id: EngineId.OpenClaw,
    homeStrategy: "native-engine-default",
    nativeHomeSubdir: "",
    nativeSkillsDirs: null,
    permissionScope: "engine",
    permissionStore: "engine-map",
    permissionCodec: "openclaw-acp-permission-mode",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "adapter-options"
  })
});
```

- [ ] **Step 4: Run the tests until the pure seam passes**

Run: `node --test tests/agent-engine-policy.test.js tests/skill-runtime-owner.test.js`

Expected: PASS with both files green and deterministic `skillFingerprint` assertions succeeding.

- [ ] **Step 5: Commit the seam introduction**

```bash
git add src/shared/agent-engine-policy.js src/main/mia-core/skill-runtime-owner.js tests/agent-engine-policy.test.js tests/skill-runtime-owner.test.js
git commit -m "feat: add skill runtime owner seam"
```

### Task 2: Reconcile Native Workspace Skills And Add Session Fingerprints

**Files:**
- Modify: `src/main/mia-core/skill-runtime-owner.js`
- Modify: `src/main/agent-session/agent-session-contract.js`
- Modify: `src/main/agent-session/agent-session-manager.js`
- Modify: `src/main/agent-session-runtime-preparer.js`
- Test: `tests/skill-runtime-owner.test.js`
- Test: `tests/agent-session-contract.test.js`
- Test: `tests/agent-session-runtime-preparer.test.js`

**Interfaces:**
- Consumes: `resolveRuntimeSkillState(...)`
- Produces: `reconcileWorkspaceSkills({ workspacePath, engineId, state }): Promise<{ manifestPath: string, managedTargets: string[] }>`
- Produces: `prepareAgentSessionSkillRuntime({ engineId, conversationId, botId, botSnapshot, runtimeConfig, workspacePath }): Promise<{ skillFingerprint: string, skillDeliveryMode: "native-link" | "prompt-fallback", initialPromptPrefix: string, turnPromptPrefix?: string, skillFallback?: object }>`
- Produces: `prepare({ engineId, conversationId, botId, botSnapshot, runtimeConfig, workspacePath }): Promise<{ runtimeKey?: string, env?: object, mcpFingerprint?: string, mcpServers?: object[], refreshMcpContext?: Function, initialPromptPrefix?: string, skillFingerprint?: string, skillDeliveryMode?: "native-link" | "prompt-fallback" }>`
- Produces: `createAgentSessionKey({ conversationId, engineId, workspacePath, runtimeKey, mcpFingerprint, skillFingerprint }): string`

- [ ] **Step 1: Write the failing tests for manifest cleanup, runtime preparation, and session keys**

```js
test("createAgentSessionKey includes skillFingerprint after runtime and MCP segments", () => {
  assert.equal(
    createAgentSessionKey({
      conversationId: "conversation_1",
      engineId: "claude",
      workspacePath: "/repo",
      mcpFingerprint: "mcp:abc",
      skillFingerprint: "skills:def"
    }),
    "conversation_1::claude::/repo::mcp:abc::skills:def"
  );
});

test("reconcileWorkspaceSkills deletes only Mia-managed stale links", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skill-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "skills", "user-owned"));

  const owner = createSkillRuntimeOwner({
    listSkillRecordsForBot: () => [],
    materializePromptFallback: () => ({ indexBlock: "", loadedBlock: "", loadedSkillIds: [] })
  });

  const state = {
    deliveryMode: "native-link",
    nativeSkillsDirs: [".claude/skills"],
    resolvedSkills: [{ id: "pdf", name: "pdf", sourcePath: path.join(dir, "source-pdf") }],
    resolvedSkillIds: ["pdf"],
    skillFingerprint: "abc123"
  };

  fs.mkdirSync(state.resolvedSkills[0].sourcePath);
  await fs.promises.mkdir(path.join(dir, ".mia"), { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, ".mia", "skill-runtime.json"),
    JSON.stringify({ managedTargets: [".claude/skills/stale-skill"] }, null, 2)
  );
  fs.mkdirSync(path.join(dir, ".claude", "skills", "stale-skill"));

  const result = await owner.reconcileWorkspaceSkills({ workspacePath: dir, engineId: "claude-code", state });

  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "pdf")), true);
  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "stale-skill")), false);
  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "user-owned")), true);
  assert.equal(result.manifestPath, path.join(dir, ".mia", "skill-runtime.json"));
});

test("prepare wires Claude native skills and exposes skillFingerprint", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agent-session-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const preparer = createAgentSessionRuntimePreparer({
    resolveManagedModelRuntime: () => null,
    skillRuntimeOwner: {
      async prepareAgentSessionSkillRuntime() {
        fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
        fs.mkdirSync(path.join(dir, ".claude", "skills", "pdf"));
        return {
          skillFingerprint: "skills:1234",
          skillDeliveryMode: "native-link",
          initialPromptPrefix: ""
        };
      }
    }
  });

  const runtime = await preparer.prepare({
    engineId: "claude",
    conversationId: "conversation_1",
    botId: "bot1",
    botSnapshot: { key: "bot1", agentEngine: "claude-code" },
    runtimeConfig: { agentEngine: "claude-code" },
    workspacePath: dir
  });

  assert.equal(runtime.skillFingerprint, "skills:1234");
  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "pdf")), true);
});
```

- [ ] **Step 2: Run the targeted tests to verify the missing reconcile and fingerprint behavior**

Run: `node --test tests/skill-runtime-owner.test.js tests/agent-session-contract.test.js tests/agent-session-runtime-preparer.test.js`

Expected: FAIL because `reconcileWorkspaceSkills` is undefined, `skillFingerprint` is ignored by `createAgentSessionKey`, and the runtime preparer never exposes native skill state.

- [ ] **Step 3: Implement workspace reconcile, manifest ownership, and session key expansion**

```js
const MANAGED_SKILL_MANIFEST = [".mia", "skill-runtime.json"];

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function managedManifestPath(workspacePath = "") {
  return path.join(String(workspacePath || "").trim(), ...MANAGED_SKILL_MANIFEST);
}

async function reconcileWorkspaceSkills({ workspacePath = "", engineId = "", state = {} } = {}) {
  if (state.deliveryMode !== "native-link") {
    return { manifestPath: managedManifestPath(workspacePath), managedTargets: [] };
  }

  const manifestFile = managedManifestPath(workspacePath);
  const previous = readJson(manifestFile, { managedTargets: [] });
  const managedTargets = [];

  for (const relDir of state.nativeSkillsDirs || []) {
    const baseDir = path.join(workspacePath, relDir);
    fs.mkdirSync(baseDir, { recursive: true });
    for (const skill of state.resolvedSkills || []) {
      const target = path.join(baseDir, String(skill.name || skill.id || "").trim());
      if (!fs.existsSync(target)) fs.symlinkSync(skill.sourcePath, target, "dir");
      managedTargets.push(path.relative(workspacePath, target));
    }
  }

  for (const rel of previous.managedTargets || []) {
    if (managedTargets.includes(rel)) continue;
    fs.rmSync(path.join(workspacePath, rel), { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify({ skillFingerprint: state.skillFingerprint, managedTargets }, null, 2) + "\n");
  return { manifestPath: manifestFile, managedTargets };
}

async function prepareAgentSessionSkillRuntime(input = {}) {
  const state = resolveRuntimeSkillState({
    bot: input.botSnapshot,
    agentEngine: input.runtimeConfig?.agentEngine || input.engineId,
    activeSkillIds: [],
    intentSkillIds: [],
    requestedSkillIds: []
  });

  if (input.workspacePath && state.deliveryMode === "native-link") {
    await reconcileWorkspaceSkills({
      workspacePath: input.workspacePath,
      engineId: input.engineId,
      state
    });
  }

  return {
    skillFingerprint: state.skillFingerprint,
    skillDeliveryMode: state.deliveryMode,
    initialPromptPrefix: state.initialPromptPrefix,
    ...(state.deliveryMode === "prompt-fallback"
      ? {
          turnPromptPrefix: state.initialPromptPrefix,
          skillFallback: {
            maxRounds: 3,
            detectRequests: (text) => extractLoadSkillRequests(text),
            materializePrompt: async (requestedSkillIds) => (
              materializePromptFallback({
                bot: input.botSnapshot,
                engine: input.engineId,
                resolvedSkillIds: state.resolvedSkillIds,
                resolvedSkills: state.resolvedSkills,
                activeSkillIds: [],
                intentSkillIds: [],
                requestedSkillIds
              }).loadedBlock
            ),
            fallbackText: (requestedSkillIds) => `无法加载所请求的技能：${requestedSkillIds.join(", ")}`
          }
        }
      : {})
  };
}
```

```js
function createAgentSessionKey({
  conversationId,
  engineId,
  workspacePath,
  runtimeKey = "",
  mcpFingerprint = "",
  skillFingerprint = ""
} = {}) {
  const normalizedSkillFingerprint = String(skillFingerprint || "").trim();
  return [
    normalizedConversationId,
    normalizedEngineId,
    normalizedWorkspacePath,
    normalizedRuntimeKey,
    normalizedMcpFingerprint,
    normalizedSkillFingerprint
  ]
    .filter((part, index) => index < 3 || part)
    .join("::");
}
```

```js
const skillRuntimeOwner = options.skillRuntimeOwner || null;

async function prepareAgentSessionSkillRuntime(input = {}) {
  if (!skillRuntimeOwner || typeof skillRuntimeOwner.prepareAgentSessionSkillRuntime !== "function") {
    return {};
  }
  return skillRuntimeOwner.prepareAgentSessionSkillRuntime(input);
}

const skillRuntime = await prepareAgentSessionSkillRuntime({
  engineId,
  conversationId: context.botId,
  botId: context.botId,
  botSnapshot: input.botSnapshot,
  runtimeConfig,
  workspacePath: input.workspacePath
});

if (skillRuntime.skillFingerprint) result.skillFingerprint = skillRuntime.skillFingerprint;
if (skillRuntime.skillDeliveryMode) result.skillDeliveryMode = skillRuntime.skillDeliveryMode;
if (typeof skillRuntime.initialPromptPrefix === "string" && skillRuntime.initialPromptPrefix) {
  result.initialPromptPrefix = result.initialPromptPrefix
    ? `${result.initialPromptPrefix}\n\n${skillRuntime.initialPromptPrefix}`
    : skillRuntime.initialPromptPrefix;
}
```

- [ ] **Step 4: Run the tests until native-link preparation is stable**

Run: `node --test tests/skill-runtime-owner.test.js tests/agent-session-contract.test.js tests/agent-session-runtime-preparer.test.js`

Expected: PASS with native workspace links present, stale Mia-managed links removed, and session keys differentiating skill changes.

- [ ] **Step 5: Commit the native-link workspace seam**

```bash
git add src/main/mia-core/skill-runtime-owner.js src/main/agent-session/agent-session-contract.js src/main/agent-session/agent-session-manager.js src/main/agent-session-runtime-preparer.js tests/skill-runtime-owner.test.js tests/agent-session-contract.test.js tests/agent-session-runtime-preparer.test.js
git commit -m "feat: reconcile native skill links and fingerprint sessions"
```

### Task 3: Add Managed ACP Prompt Fallback For Hermes And OpenClaw

**Files:**
- Modify: `src/main/agent-session/native-input-policy.js`
- Modify: `src/main/agent-session/acp-agent-session.js`
- Modify: `src/main/bot-execution-core.js`
- Modify: `src/main/social/local-bot-responder.js`
- Modify: `src/main/agent-session-runtime-preparer.js`
- Test: `tests/native-input-policy.test.js`
- Test: `tests/acp-agent-session.test.js`
- Test: `tests/bot-execution-core.test.js`

**Interfaces:**
- Consumes: `prepare({ ... }): { skillFingerprint?: string, skillDeliveryMode?: "native-link" | "prompt-fallback", initialPromptPrefix?: string, turnPromptPrefix?: string, skillFallback?: { maxRounds?: number, detectRequests(text: string): string[], materializePrompt(requestedSkillIds: string[]): Promise<string>, fallbackText(requestedSkillIds: string[]): string } }`
- Produces: `prepareNativeTurnInput(input): { turnId: string, text: string, attachments?: object[], fileReferences?: object[], turnPromptPrefix?: string, skillFallback?: object }`
- Produces: `AcpAgentSession.sendUserInput(payload)` with an internal retry loop for managed `prompt-fallback` sessions before emitting terminal events

- [ ] **Step 1: Write the failing tests for allowed fields, ACP retry loops, and managed payload passthrough**

```js
test("prepareNativeTurnInput allows managed prompt-fallback metadata", () => {
  const prepared = prepareNativeTurnInput({
    turnId: "turn-1",
    text: "hello",
    turnPromptPrefix: "## Prompt Fallback",
    skillFallback: {
      maxRounds: 2,
      detectRequests: () => ["demo-skill"],
      materializePrompt: async () => "## Loaded demo",
      fallbackText: () => "unable"
    }
  });

  assert.equal(prepared.turnPromptPrefix, "## Prompt Fallback");
  assert.equal(typeof prepared.skillFallback.detectRequests, "function");
});

test("sendUserInput retries a managed prompt when the agent requests LOAD_SKILL", async () => {
  const deferred = createDeferred();
  let promptCount = 0;
  const { session, state } = createSession({
    onPrompt: async ({ params, onSessionUpdate }) => {
      promptCount += 1;
      if (promptCount === 1) {
        await onSessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "msg-1",
            content: { type: "text", text: "[LOAD_SKILL: demo-skill]" }
          }
        });
        deferred.resolve({ stopReason: "end_turn" });
        return;
      }
      assert.match(params.prompt[0].text, /## Loaded demo/);
      deferred.resolve({ stopReason: "end_turn" });
    }
  });

  await session.sendUserInput({
    turnId: "turn-1",
    text: "hello",
    turnPromptPrefix: "## Prompt Fallback",
    skillFallback: {
      maxRounds: 2,
      detectRequests: (text) => text.includes("demo-skill") ? ["demo-skill"] : [],
      materializePrompt: async () => "## Loaded demo",
      fallbackText: () => "unresolved"
    }
  });

  assert.equal(promptCount, 2);
});

test("managed AgentSession turns carry prompt-fallback metadata from runtime preparation", async () => {
  const { core, calls } = makeCore({
    prepareAgentSessionRuntime: async () => ({
      skillFingerprint: "skills:abc",
      skillDeliveryMode: "prompt-fallback",
      turnPromptPrefix: "## Prompt Fallback",
      skillFallback: {
        maxRounds: 2,
        detectRequests: () => [],
        materializePrompt: async () => "",
        fallbackText: () => ""
      }
    })
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-1", content: "hello" }]
  });

  assert.equal(calls.agentSession[0].skillFingerprint, "skills:abc");
  assert.equal(calls.agentSession[0].turnPromptPrefix, "## Prompt Fallback");
  assert.equal(typeof calls.agentSession[0].skillFallback.detectRequests, "function");
});
```

- [ ] **Step 2: Run the fallback tests to confirm managed ACP turns cannot do this yet**

Run: `node --test tests/native-input-policy.test.js tests/acp-agent-session.test.js tests/bot-execution-core.test.js`

Expected: FAIL because `turnPromptPrefix` and `skillFallback` are rejected by `prepareNativeTurnInput`, `AcpAgentSession` only prepends a once-per-session prefix, and managed turn payloads never carry fallback hooks.

- [ ] **Step 3: Implement per-turn fallback payloads and the ACP retry loop**

```js
const ALLOWED_KEYS = new Set([
  "turnId",
  "text",
  "attachments",
  "fileReferences",
  "workspacePath",
  "cwd",
  "sessionId",
  "initializationMetadata",
  "turnPromptPrefix",
  "skillFallback"
]);
```

```js
function prependTurnPrompt(prefix, text) {
  const cleanedPrefix = String(prefix || "").trim();
  const cleanedText = String(text || "");
  return cleanedPrefix ? `${cleanedPrefix}\n\n${cleanedText}` : cleanedText;
}

this.activeAssistantText = "";

async function runPromptWithFallbackLoop(nativeTurn, promptRequestFactory) {
  const skillFallback = nativeTurn.skillFallback && typeof nativeTurn.skillFallback === "object"
    ? nativeTurn.skillFallback
    : null;
  const maxRounds = Number(skillFallback?.maxRounds || 0);
  let requestedSkillIds = [];
  let promptText = prependTurnPrompt(nativeTurn.turnPromptPrefix, nativeTurn.text);

  for (let round = 0; round <= maxRounds; round += 1) {
    this.activeAssistantText = "";
    const response = await this.client.prompt(promptRequestFactory(promptText));
    const assistantText = this.activeAssistantText;
    const loadRequests = skillFallback?.detectRequests?.(assistantText) || [];
    const nextRequests = loadRequests.filter((id) => !requestedSkillIds.includes(id));
    if (!nextRequests.length) return { response, visibleText: assistantText };
    if (round === maxRounds) {
      return { response, visibleText: skillFallback.fallbackText(nextRequests) };
    }
    requestedSkillIds = [...requestedSkillIds, ...nextRequests];
    const retryPrompt = await skillFallback.materializePrompt(requestedSkillIds);
    promptText = prependTurnPrompt([nativeTurn.turnPromptPrefix, retryPrompt].filter(Boolean).join("\n\n"), nativeTurn.text);
  }
}

if (event.kind === "assistant-delta" && typeof event.payload?.text === "string") {
  this.activeAssistantText += event.payload.text;
}
```

```js
const runtime = typeof prepareAgentSessionRuntime === "function"
  ? await prepareAgentSessionRuntime({
      engineId: agentSessionSpec.engineId,
      conversationId: descriptor.conversationId,
      botId: botForTurn.key || botForTurn.id || key,
      botSnapshot: botForTurn,
      runtimeConfig: turnRuntimeConfig,
      workspacePath
    })
  : null;

if (runtime?.skillFingerprint) descriptor.skillFingerprint = String(runtime.skillFingerprint || "").trim();

const accepted = await agentSessionManager.sendUserInput({
  ...descriptor,
  ...rawCurrentTurn,
  ...(typeof runtime?.turnPromptPrefix === "string" ? { turnPromptPrefix: runtime.turnPromptPrefix } : {}),
  ...(runtime?.skillFallback ? { skillFallback: runtime.skillFallback } : {})
});
```

- [ ] **Step 4: Run the fallback tests until managed Hermes/OpenClaw turns converge without leaking LOAD_SKILL markers**

Run: `node --test tests/native-input-policy.test.js tests/acp-agent-session.test.js tests/bot-execution-core.test.js`

Expected: PASS with managed ACP turns retrying internally, `message-completed` firing only after the final pass, and no raw `[LOAD_SKILL: ...]` markers surfacing to the user.

- [ ] **Step 5: Commit the managed fallback protocol**

```bash
git add src/main/agent-session/native-input-policy.js src/main/agent-session/acp-agent-session.js src/main/bot-execution-core.js src/main/social/local-bot-responder.js src/main/agent-session-runtime-preparer.js tests/native-input-policy.test.js tests/acp-agent-session.test.js tests/bot-execution-core.test.js
git commit -m "feat: add ACP prompt fallback skill loop"
```

### Task 4: Remove Legacy Local Skill Bridges

**Files:**
- Modify: `src/main.js`
- Modify: `src/main/engine-runtime-config-service.js`
- Modify: `tests/project-structure-check.test.js`
- Modify: `tests/engine-runtime-config-service.test.js`
- Delete: `src/main/claude-bridge-plugin-service.js`
- Delete: `tests/claude-bridge-plugin-service.test.js`
- Delete: `src/main/mia-native-context-bridge.js`
- Delete: `tests/mia-native-context-bridge.test.js`

**Interfaces:**
- Consumes: `createAgentSessionRuntimePreparer(...)`
- Produces: `createEngineRuntimeConfigService(...)` with no `externalSkillDirs` dependency
- Produces: no Claude bridge skill service and no native context file skill transport in production code

- [ ] **Step 1: Write the failing structure and config tests that codify the deletion**

```js
test("Claude bridge plugin skill transport is deleted", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

  assert.equal(fs.existsSync(path.join(root, "src/main/claude-bridge-plugin-service.js")), false);
  assert.doesNotMatch(mainSource, /createClaudeBridgePluginService/);
  assert.doesNotMatch(mainSource, /ensureClaudeBridgePlugin/);
});

test("engine runtime config no longer writes Hermes external skill directories", () => {
  const service = createEngineRuntimeConfigService({
    runtimePaths: () => ({ home: dir, runtime: dir, engine: dir }),
    readJson: () => ({}),
    randomBytes: (size) => Buffer.alloc(size, 1),
    defaultModelSettings: () => ({ provider: "mia", model: "mia-auto", apiKeyEnv: "", apiKey: "", baseUrl: "", apiMode: "" }),
    permissionSettings: () => ({ mode: "ask" }),
    effortSettings: () => ({ level: "medium" }),
    engineSource: () => "user",
    getMiaAppMcpSpec: () => null,
    getSchedulerMcpSpec: () => null,
    getUserMcpSpecs: () => [],
    resolveModelRuntime: () => null
  });

  service.writeRuntimeConfig(18789);
  const parsed = yaml.load(fs.readFileSync(path.join(dir, "config.yaml"), "utf8"));
  assert.equal(parsed.skills, undefined);
});
```

- [ ] **Step 2: Run the local cleanup tests before deleting the old seams**

Run: `node --test tests/project-structure-check.test.js tests/engine-runtime-config-service.test.js`

Expected: FAIL because `main.js` still instantiates `createClaudeBridgePluginService`, `engine-runtime-config-service.js` still writes `skills.external_dirs`, and the deleted files still exist.

- [ ] **Step 3: Delete the bridge modules and remove Hermes global skill-directory plumbing**

```js
const engineRuntimeConfigService = createEngineRuntimeConfigService({
  runtimePaths,
  readJson,
  randomBytes: (size) => crypto.randomBytes(size),
  defaultModelSettings: () => settingsStore?.defaultModelSettings() || {
    provider: "",
    model: "",
    apiKeyEnv: "",
    apiKey: "",
    baseUrl: "",
    apiMode: ""
  },
  permissionSettings: () => settingsStore?.permissionSettings() || { mode: "ask" },
  effortSettings: () => settingsStore?.effortSettings() || { level: "medium" },
  engineSource: engineInstallService.engineSource,
  getMiaAppMcpSpec: () => miaAppMcpBridge.getSpec(),
  getSchedulerMcpSpec: () => schedulerMcpBridge.getSpec(),
  getUserMcpSpecs: () => userMcpService.getEngineSpecs("hermes", { hermesSupportsUrl: true }),
  resolveModelRuntime: (settings, context) => resolveModelRuntime(settings, context)
});
```

```js
function createEngineRuntimeConfigService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  const readJson = deps.readJson || (() => ({}));
  const randomBytes = deps.randomBytes || (() => Buffer.alloc(0));
  const defaultModelSettings = deps.defaultModelSettings || (() => ({}));
  const permissionSettings = deps.permissionSettings || (() => ({ mode: "ask" }));
  const effortSettings = deps.effortSettings || (() => ({ level: "medium" }));
  const engineSource = deps.engineSource || (() => "user");
  const getMiaAppMcpSpec = deps.getMiaAppMcpSpec || (() => null);
  const getSchedulerMcpSpec = deps.getSchedulerMcpSpec || (() => null);
  const getUserMcpSpecs = deps.getUserMcpSpecs || (() => []);
  const resolveModelRuntime = deps.resolveModelRuntime || (() => null);

  // Remove externalSkillDirs support entirely. Bot skill delivery now belongs
  // to Skill Runtime Owner and workspace/session preparation.
}
```

- [ ] **Step 4: Run the cleanup tests until no local skill transport path remains outside Skill Runtime Owner**

Run: `node --test tests/project-structure-check.test.js tests/engine-runtime-config-service.test.js`

Expected: PASS with no bridge service file, no `createClaudeBridgePluginService` wiring, no `skills.external_dirs` output, and no native context bridge file in the tree.

- [ ] **Step 5: Commit the local bridge deletion**

```bash
git add src/main.js src/main/engine-runtime-config-service.js tests/project-structure-check.test.js tests/engine-runtime-config-service.test.js
git rm src/main/claude-bridge-plugin-service.js tests/claude-bridge-plugin-service.test.js src/main/mia-native-context-bridge.js tests/mia-native-context-bridge.test.js
git commit -m "refactor: delete legacy local skill bridges"
```

### Task 5: Remove Cloud Hermes And Legacy Runtime Aliases

**Files:**
- Modify: `src/shared/bot-runtime-control.js`
- Modify: `src/shared/cloud-runtime.js`
- Modify: `src/cloud-agent/dispatcher.js`
- Modify: `src/renderer/bot/bot-directory.js`
- Modify: `src/renderer/bot/bot-dialog.js`
- Modify: `src/renderer/bot/bot-store.js`
- Modify: `src/renderer/bot/starter-engine-bots.js`
- Modify: `src/renderer/bot/bot-commands.js`
- Modify: `src/web/app.js`
- Modify: `tests/cloud-agent-dispatcher.test.js`
- Modify: `tests/starter-engine-bots.test.js`
- Modify: `tests/renderer-shell.test.js`
- Modify: `tests/bot-dialog-runtime.test.js`
- Delete: `src/cloud-agent/hermes-im-client.js`, `src/cloud-agent/hermes-worker-manager.js`, `src/cloud-agent/cloud-hermes-model.js`, `tests/cloud-agent-hermes-im-client.test.js`, `tests/cloud-agent-hermes-client.test.js`

**Interfaces:**
- Consumes: cloud/runtime binding reads and renderer runtime normalization
- Produces: only `cloud-claude-code` as a valid cloud runtime kind
- Produces: persisted `cloud-hermes` bindings are treated as invalid/cleaned, not normalized into active runtime selections

- [ ] **Step 1: Write the failing tests that reject `cloud-hermes` across shared and renderer code**

```js
test("normalizeRuntimeKind no longer maps cloud-hermes to a supported runtime", () => {
  assert.equal(normalizeRuntimeKind("cloud-hermes"), "");
  assert.equal(normalizeRuntimeKind("cloud_hermes"), "");
  assert.equal(normalizeRuntimeKind("cloud-claude-code"), "cloud-claude-code");
});

test("starter engine bots do not backfill legacy cloud-hermes aliases", async () => {
  const result = await ensureStarterEngineBots({
    state,
    social,
    api,
    commands
  });

  assert.equal(result.updated.some((entry) => entry.runtimeKind === "cloud-hermes"), false);
});

test("active cloud bot conversations stop normalizing legacy cloud-hermes runtime aliases", () => {
  const activeContext = extractFunctionSource(appSource, "activeConversationBotContext");
  assert.doesNotMatch(activeContext, /cloud-hermes/);
});
```

- [ ] **Step 2: Run the cloud-runtime tests before removing the aliases**

Run: `node --test tests/cloud-agent-dispatcher.test.js tests/starter-engine-bots.test.js tests/renderer-shell.test.js tests/bot-dialog-runtime.test.js`

Expected: FAIL because shared runtime helpers and renderer code still accept `cloud-hermes`, and the dispatcher still defines a legacy runtime constant.

- [ ] **Step 3: Remove aliasing, runtime branches, and legacy runtime-only files**

```js
function normalizeRuntimeKind(value, fallback = "cloud-claude-code") {
  const raw = String(value || fallback || "cloud-claude-code").trim();
  return raw === "cloud-claude-code" ? raw : (fallback === "cloud-claude-code" ? "cloud-claude-code" : raw);
}
```

```js
const CLOUD_CLAUDE_CODE_RUNTIME_KIND = "cloud-claude-code";

function normalizeRuntimeKind(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (raw === CLOUD_CLAUDE_CODE_RUNTIME_KIND || raw === "mia-cloud" || raw === "miacloud") return CLOUD_CLAUDE_CODE_RUNTIME_KIND;
  return "";
}
```

```js
const CLOUD_CLAUDE_CODE_RUNTIME_KIND = "cloud-claude-code";

// Delete LEGACY_CLOUD_HERMES_RUNTIME_KIND and all branches keyed off it.
// Delete Hermes IM worker/client orchestration that exists only for cloud-hermes.
```

```js
function normalizeRuntimeKind(value, fallback = "desktop-local") {
  const raw = String(value || "").trim();
  if (raw === "cloud-claude-code") return "cloud-claude-code";
  if (raw === "desktop-local") return "desktop-local";
  return fallback === "cloud-claude-code" ? "cloud-claude-code" : "desktop-local";
}
```

- [ ] **Step 4: Run the cloud-runtime tests until only `cloud-claude-code` survives**

Run: `node --test tests/cloud-agent-dispatcher.test.js tests/starter-engine-bots.test.js tests/renderer-shell.test.js tests/bot-dialog-runtime.test.js`

Expected: PASS with no `cloud-hermes` normalization path, no legacy dispatcher constant, and no renderer/runtime helper that still treats `cloud-hermes` as valid.

- [ ] **Step 5: Commit the cloud runtime cleanup**

```bash
git add src/shared/bot-runtime-control.js src/shared/cloud-runtime.js src/cloud-agent/dispatcher.js src/renderer/bot/bot-directory.js src/renderer/bot/bot-dialog.js src/renderer/bot/bot-store.js src/renderer/bot/starter-engine-bots.js src/renderer/bot/bot-commands.js src/web/app.js tests/cloud-agent-dispatcher.test.js tests/starter-engine-bots.test.js tests/renderer-shell.test.js tests/bot-dialog-runtime.test.js
git rm src/cloud-agent/hermes-im-client.js src/cloud-agent/hermes-worker-manager.js src/cloud-agent/cloud-hermes-model.js tests/cloud-agent-hermes-im-client.test.js tests/cloud-agent-hermes-client.test.js
git commit -m "refactor: remove cloud-hermes runtime"
```

## Self-Review

### Spec Coverage

- Skill Runtime Owner seam: Task 1
- Engine metadata with `nativeSkillsDirs`: Task 1
- `skillFingerprint` and session invalidation: Task 2
- Native-link workspace reconcile with managed manifest cleanup: Task 2
- Shared managed fallback for Hermes/OpenClaw: Task 3
- Delete Claude bridge plugin and Hermes `external_dirs`: Task 4
- Delete native context skill transport: Task 4
- Remove `cloud-hermes` aliases and runtime branches: Task 5

No spec section is uncovered.

### Placeholder Scan

- No `TBD`, `TODO`, `FIXME`, `XXX`, or “implement later” markers remain.
- Every code-changing step contains concrete code blocks.
- Every test step includes an exact command and an expected failure or pass condition.

### Type Consistency

- `skillFingerprint` is introduced once in Task 2 and reused with the same name in later tasks.
- `resolveRuntimeSkillState`, `reconcileWorkspaceSkills`, `turnPromptPrefix`, and `skillFallback` keep the same names and shapes across tasks.
- `skillDeliveryMode` uses only `"native-link"` and `"prompt-fallback"` across all tasks.
