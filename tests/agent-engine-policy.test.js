const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const {
  agentEnginePolicy,
  enginePermissionStoreTarget,
  nativeHomePathForEngine,
  normalizeEnginePermissionMode,
  shouldApplyNativePermissionConfig
} = require("../src/shared/agent-engine-policy.js");

test("agent engine policy keeps runtime scope decisions in one table", () => {
  assert.deepEqual(agentEnginePolicy("codex"), {
    id: "codex",
    homeStrategy: "native-user-home",
    nativeHomeSubdir: ".codex",
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
    permissionScope: "engine",
    permissionStore: "engine-map",
    permissionCodec: "claude-code-permission-mode",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "adapter-options"
  });

  assert.deepEqual(agentEnginePolicy("open-claw"), {
    id: "openclaw",
    homeStrategy: "native-engine-default",
    nativeHomeSubdir: "",
    permissionScope: "engine",
    permissionStore: "engine-map",
    permissionCodec: "openclaw-acp-permission-mode",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "adapter-options"
  });

  assert.deepEqual(agentEnginePolicy("hermes"), {
    id: "hermes",
    homeStrategy: "native-user-home",
    nativeHomeSubdir: ".hermes",
    permissionScope: "engine",
    permissionStore: "root-mode",
    permissionCodec: "hermes-approvals-mode",
    modelScope: "partner",
    effortScope: "partner",
    configApply: "hermes-runtime-config"
  });
});

test("engine permission policy preserves each engine's native permission values", () => {
  assert.equal(normalizeEnginePermissionMode("hermes", "off"), "yolo");
  assert.equal(normalizeEnginePermissionMode("hermes", "default"), "ask");
  assert.equal(normalizeEnginePermissionMode("codex", ":danger-full-access"), ":danger-full-access");
  assert.equal(normalizeEnginePermissionMode("claude-code", "bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeEnginePermissionMode("openclaw", "bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeEnginePermissionMode("openclaw", ""), "default");
});

test("policy identifies where permission settings are stored and applied", () => {
  assert.equal(enginePermissionStoreTarget("hermes"), "root-mode");
  assert.equal(enginePermissionStoreTarget("codex"), "engine-map");
  assert.equal(shouldApplyNativePermissionConfig("codex"), true);
  assert.equal(shouldApplyNativePermissionConfig("claude-code"), false);
  assert.equal(shouldApplyNativePermissionConfig("openclaw"), false);
  assert.equal(shouldApplyNativePermissionConfig("hermes"), false);
});

test("native home path is explicit only for engines that need Mia to pass one", () => {
  const userHome = path.join("/tmp", "mia-user");

  assert.equal(nativeHomePathForEngine("codex", userHome), path.join(userHome, ".codex"));
  assert.equal(nativeHomePathForEngine("claude-code", userHome), "");
  assert.equal(nativeHomePathForEngine("openclaw", userHome), "");
  assert.equal(nativeHomePathForEngine("hermes", userHome), path.join(userHome, ".hermes"));
});
