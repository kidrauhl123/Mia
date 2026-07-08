const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createRuntimeInitializerService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const randomBytes = deps.randomBytes || ((size) => crypto.randomBytes(size));
  const ensureEnginePlugins = deps.ensureEnginePlugins || (() => {});
  const defaultPermissionSettings = deps.defaultPermissionSettings || (() => ({ mode: "ask" }));
  const defaultEffortSettings = deps.defaultEffortSettings || (() => ({ level: "medium" }));
  const defaultCoreSettings = deps.defaultCoreSettings || deps.defaultDaemonSettings || (() => ({}));
  const defaultUserProfile = deps.defaultUserProfile || (() => ({}));
  const defaultAppearanceSettings = deps.defaultAppearanceSettings || (() => ({}));
  const getRuntimeStatus = deps.getRuntimeStatus || ((created) => ({ created }));

  function writeFileIfMissing(filePath, content, mode) {
    if (fsImpl.existsSync(filePath)) return false;
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const options = mode == null ? undefined : { mode };
    fsImpl.writeFileSync(filePath, content, options);
    return true;
  }

  function initializeRuntimeCore() {
    const p = runtimePaths();
    const created = [];
    fsImpl.mkdirSync(p.engine, { recursive: true });
    fsImpl.mkdirSync(p.home, { recursive: true });
    if (p.hermesHome) fsImpl.mkdirSync(p.hermesHome, { recursive: true });
    fsImpl.mkdirSync(p.pluginsDir, { recursive: true });
    fsImpl.mkdirSync(p.botDir, { recursive: true });
    fsImpl.rmSync(path.join(p.home, "souls"), { recursive: true, force: true });
    fsImpl.mkdirSync(p.petDir, { recursive: true });
    fsImpl.mkdirSync(p.petJobsDir, { recursive: true });
    ensureEnginePlugins();

    if (writeFileIfMissing(path.join(p.engine, "README.md"), [
      "# Mia Hermes Engine",
      "",
      "This directory is reserved for Mia's bundled or downloaded Hermes engine.",
      "Mia may launch a user-installed Hermes binary, but never writes into its checkout or home.",
      ""
    ].join("\n"))) {
      created.push("runtime/hermes-engine/README.md");
    }

    if (writeFileIfMissing(p.permissionSettings, JSON.stringify(defaultPermissionSettings(), null, 2) + "\n", 0o600)) {
      created.push("runtime/engine-home/mia-permissions.json");
    }

    if (writeFileIfMissing(p.effortSettings, JSON.stringify(defaultEffortSettings(), null, 2) + "\n", 0o600)) {
      created.push("runtime/engine-home/mia-effort.json");
    }

    const coreSettingsPath = p.coreSettings || p.daemonSettings;
    if (writeFileIfMissing(coreSettingsPath, JSON.stringify(defaultCoreSettings(), null, 2) + "\n", 0o600)) {
      created.push("runtime/engine-home/mia-core.json");
    }

    if (writeFileIfMissing(p.coreToken, `${randomBytes(32).toString("hex")}\n`, 0o600)) {
      created.push("runtime/engine-home/mia-core.key");
    }

    if (writeFileIfMissing(p.userProfile, JSON.stringify(defaultUserProfile(), null, 2) + "\n")) {
      created.push("runtime/engine-home/mia-user.json");
    }

    if (writeFileIfMissing(p.appearanceSettings, JSON.stringify(defaultAppearanceSettings(), null, 2) + "\n")) {
      created.push("runtime/engine-home/mia-appearance.json");
    }

    if (writeFileIfMissing(p.soul, [
      "# Mia Shared Soul",
      "",
      "你是 Mia 应用中的 Bot。这里是所有 Bot 共享的基础语气。",
      "具体名字、身份和关系写在 bots/<bot_id>.md。",
      "",
      "## Style",
      "- 直接、清楚、少客套",
      "- 不假装已经连接外部账号",
      "- 优先说明当前可执行的下一步",
      ""
    ].join("\n"))) {
      created.push("runtime/engine-home/SOUL.md");
    }

    return getRuntimeStatus(created);
  }

  return {
    initializeRuntimeCore,
    writeFileIfMissing
  };
}

module.exports = { createRuntimeInitializerService };
