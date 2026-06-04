const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createRuntimeInitializerService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const randomBytes = deps.randomBytes || ((size) => crypto.randomBytes(size));
  const ensureEnginePlugins = deps.ensureEnginePlugins || (() => {});
  const writeRuntimeConfig = deps.writeRuntimeConfig || (() => {});
  const readConfiguredPort = deps.readConfiguredPort || (() => 8642);
  const defaultModelSettings = deps.defaultModelSettings || (() => ({}));
  const defaultProviderStore = deps.defaultProviderStore || (() => ({ providers: {} }));
  const defaultPermissionSettings = deps.defaultPermissionSettings || (() => ({ mode: "ask" }));
  const defaultEffortSettings = deps.defaultEffortSettings || (() => ({ level: "medium" }));
  const defaultDaemonSettings = deps.defaultDaemonSettings || (() => ({}));
  const defaultUserProfile = deps.defaultUserProfile || (() => ({}));
  const defaultAppearanceSettings = deps.defaultAppearanceSettings || (() => ({}));
  const loadFellowManifest = deps.loadFellowManifest || (() => ({ fellows: [] }));
  const saveFellowManifest = deps.saveFellowManifest || (() => {});
  const fellowPersonaBody = deps.fellowPersonaBody || ((name, bio) => `${name || "Mia"}\n\n${bio || ""}`);
  const fellowMetadata = deps.fellowMetadata || ((fellow) => fellow);
  const ensureClaudeBridgePlugin = deps.ensureClaudeBridgePlugin || (() => {});
  const appendEngineLog = deps.appendEngineLog || (() => {});
  const getRuntimeStatus = deps.getRuntimeStatus || ((created) => ({ created }));

  function writeFileIfMissing(filePath, content, mode) {
    if (fsImpl.existsSync(filePath)) return false;
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const options = mode == null ? undefined : { mode };
    fsImpl.writeFileSync(filePath, content, options);
    return true;
  }

  function migrateLegacyPersonas(created) {
    const p = runtimePaths();
    const manifest = loadFellowManifest();
    const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
    const hadFellowManifest = fsImpl.existsSync(p.fellowManifest);
    saveFellowManifest({ ...manifest, fellows });
    if (!hadFellowManifest) {
      created.push("runtime/engine-home/fellows/manifest.json");
    }

    for (const fellow of fellows) {
      const mdPath = path.join(p.fellowDir, `${fellow.key}.md`);
      const metaPath = path.join(p.fellowDir, `${fellow.key}.fellow.json`);
      const legacyMdPath = path.join(p.legacyPersonaDir, `${fellow.key}.md`);
      let body = "";
      if (fsImpl.existsSync(mdPath)) {
        body = fsImpl.readFileSync(mdPath, "utf8");
      } else if (fsImpl.existsSync(legacyMdPath)) {
        body = fsImpl.readFileSync(legacyMdPath, "utf8");
      } else {
        body = fellow.personaText || fellow.persona_text || fellowPersonaBody(fellow.name, fellow.bio);
      }
      if (writeFileIfMissing(mdPath, body)) {
        created.push(`runtime/engine-home/fellows/${fellow.key}.md`);
      }
      if (writeFileIfMissing(metaPath, JSON.stringify(fellowMetadata(fellow), null, 2) + "\n")) {
        created.push(`runtime/engine-home/fellows/${fellow.key}.fellow.json`);
      }
    }
  }

  function initializeRuntimeCore() {
    const p = runtimePaths();
    const created = [];
    fsImpl.mkdirSync(p.engine, { recursive: true });
    fsImpl.mkdirSync(p.home, { recursive: true });
    fsImpl.mkdirSync(p.pluginsDir, { recursive: true });
    fsImpl.mkdirSync(p.fellowDir, { recursive: true });
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

    if (!fsImpl.existsSync(p.apiKey)) {
      writeFileIfMissing(p.apiKey, `${randomBytes(32).toString("hex")}\n`, 0o600);
      created.push("runtime/engine-home/api-server.key");
    }

    const configExisted = fsImpl.existsSync(p.config);
    writeRuntimeConfig(readConfiguredPort());
    if (!configExisted) {
      created.push("runtime/engine-home/config.yaml");
    }

    if (writeFileIfMissing(p.modelSettings, JSON.stringify({
      ...defaultModelSettings()
    }, null, 2) + "\n", 0o600)) {
      created.push("runtime/engine-home/mia-model.json");
    }

    if (writeFileIfMissing(p.providerConnections, JSON.stringify(defaultProviderStore(), null, 2) + "\n", 0o600)) {
      created.push("runtime/engine-home/mia-providers.json");
    }

    if (writeFileIfMissing(p.permissionSettings, JSON.stringify(defaultPermissionSettings(), null, 2) + "\n", 0o600)) {
      created.push("runtime/engine-home/mia-permissions.json");
    }

    if (writeFileIfMissing(p.effortSettings, JSON.stringify(defaultEffortSettings(), null, 2) + "\n", 0o600)) {
      created.push("runtime/engine-home/mia-effort.json");
    }

    if (writeFileIfMissing(p.daemonSettings, JSON.stringify(defaultDaemonSettings(), null, 2) + "\n", 0o600)) {
      created.push("runtime/engine-home/mia-daemon.json");
    }

    if (writeFileIfMissing(p.daemonToken, `${randomBytes(32).toString("hex")}\n`, 0o600)) {
      created.push("runtime/engine-home/mia-daemon.key");
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
      "你是 Mia 应用中的 Fellow。这里是所有 Fellow 共享的基础语气。",
      "具体名字、身份和关系写在 fellows/<fellow_id>.md。",
      "",
      "## Style",
      "- 直接、清楚、少客套",
      "- 不假装已经连接外部账号",
      "- 优先说明当前可执行的下一步",
      ""
    ].join("\n"))) {
      created.push("runtime/engine-home/SOUL.md");
    }

    migrateLegacyPersonas(created);

    try {
      ensureClaudeBridgePlugin();
    } catch (error) {
      appendEngineLog(`Claude bridge plugin setup failed: ${error?.message || error}`);
    }

    return getRuntimeStatus(created);
  }

  return {
    initializeRuntimeCore,
    migrateLegacyPersonas,
    writeFileIfMissing
  };
}

module.exports = { createRuntimeInitializerService };
