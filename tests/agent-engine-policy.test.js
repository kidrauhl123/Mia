const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const {
  agentEnginePolicy,
  enginePermissionStoreTarget,
  nativeHomePathForEngine,
  resolveNativeSkillsDirs,
  normalizeEnginePermissionMode,
  shouldApplyNativePermissionConfig
} = require("../src/shared/agent-engine-policy.js");

test("agent engine policy keeps runtime scope decisions in one table", () => {
  assert.deepEqual(agentEnginePolicy("codex"), {
    id: "codex",
    homeStrategy: "native-user-home",
    nativeHomeSubdir: ".codex",
    nativeSkillsDirs: [".codex/skills"],
    permissionScope: "engine",
    permissionStore: "engine-map",
    permissionCodec: "codex-permission-profile",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "codex-permission-on-change"
  });

  assert.deepEqual(agentEnginePolicy("claude"), {
    id: "claude-code",
    homeStrategy: "native-engine-default",
    nativeHomeSubdir: "",
    nativeSkillsDirs: [".claude/skills"],
    permissionScope: "engine",
    permissionStore: "engine-map",
    permissionCodec: "claude-code-permission-mode",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "adapter-options"
  });

  assert.deepEqual(agentEnginePolicy("hermes"), {
    id: "hermes",
    homeStrategy: "native-user-home",
    nativeHomeSubdir: ".hermes",
    nativeSkillsDirs: [],
    permissionScope: "engine",
    permissionStore: "root-mode",
    permissionCodec: "hermes-approvals-mode",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "hermes-runtime-config"
  });

  assert.equal(agentEnginePolicy("open-claw").id, "hermes");
});

test("engine permission policy preserves each engine's native permission values", () => {
  assert.equal(normalizeEnginePermissionMode("hermes", "off"), "yolo");
  assert.equal(normalizeEnginePermissionMode("hermes", "default"), "ask");
  assert.equal(normalizeEnginePermissionMode("codex", ":danger-full-access"), ":danger-full-access");
  assert.equal(normalizeEnginePermissionMode("claude-code", "bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeEnginePermissionMode("openclaw", "bypassPermissions"), "ask");
  assert.equal(normalizeEnginePermissionMode("openclaw", ""), "ask");
});

test("policy identifies where permission settings are stored and applied", () => {
  assert.equal(enginePermissionStoreTarget("hermes"), "root-mode");
  assert.equal(enginePermissionStoreTarget("codex"), "engine-map");
  assert.equal(shouldApplyNativePermissionConfig("codex"), true);
  assert.equal(shouldApplyNativePermissionConfig("claude-code"), false);
  assert.equal(shouldApplyNativePermissionConfig("hermes"), false);
  assert.equal(shouldApplyNativePermissionConfig("openclaw"), false);
});

test("native home path is explicit only for engines that need Mia to pass one", () => {
  const userHome = path.join("/tmp", "mia-user");

  assert.equal(nativeHomePathForEngine("codex", userHome), path.join(userHome, ".codex"));
  assert.equal(nativeHomePathForEngine("claude-code", userHome), "");
  assert.equal(nativeHomePathForEngine("hermes", userHome), path.join(userHome, ".hermes"));
  assert.equal(nativeHomePathForEngine("openclaw", userHome), path.join(userHome, ".hermes"));
});

test("agent engine policy exposes native skill directory metadata", () => {
  assert.deepEqual(agentEnginePolicy("claude-code").nativeSkillsDirs, [".claude/skills"]);
  assert.deepEqual(agentEnginePolicy("codex").nativeSkillsDirs, [".codex/skills"]);
  assert.deepEqual(agentEnginePolicy("hermes").nativeSkillsDirs, []);
  assert.deepEqual(agentEnginePolicy("openclaw").nativeSkillsDirs, []);
});

test("native skill dir resolution prefers runtime and bot metadata over fallback policy", () => {
  assert.deepEqual(
    resolveNativeSkillsDirs("codex", {
      runtimeConfig: { nativeSkillsDirs: [".runtime-codex/skills"] }
    }),
    [".runtime-codex/skills"]
  );

  assert.deepEqual(
    resolveNativeSkillsDirs("hermes", {
      runtimeConfig: {
        agentMetadata: {
          native_skills_dirs: [".custom/skills"]
        }
      }
    }),
    [".custom/skills"]
  );

  assert.equal(
    resolveNativeSkillsDirs("claude-code", {
      bot: {
        engineConfig: {
          nativeSkillsDirs: null
        }
      }
    }),
    null
  );

  assert.deepEqual(resolveNativeSkillsDirs("codex"), [".codex/skills"]);
  assert.deepEqual(resolveNativeSkillsDirs("openclaw"), []);
});
