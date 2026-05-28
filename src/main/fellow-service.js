"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { requireFellow } = require("./fellow-registry.js");

function createFellowService({
  initializeRuntime,
  runtimePaths,
  fellowManifest,
  loadAgentSessionMap,
  saveAgentSessionMap,
  orphanTasksByFellow = () => 0,
  emitTaskEvent = () => {},
  rescanScheduler = () => {},
  recallFellowPet = () => {},
  pushFellowToCloud = async () => {},
  deleteFellowFromCloud = async () => {},
  appendCloudLog = () => {},
  getRuntimeStatus,
  petStatusForFellow = () => null,
  warn = (...args) => console.warn(...args)
}) {
  const {
    normalizeFellowEngineConfig,
    mergeFellowEngineConfig,
    normalizeFellowCapabilities,
    normalizeFellow,
    normalizeAvatarCrop,
    loadFellowManifest,
    saveFellowManifest,
    fellowPersonaBody,
    fellowMetadata,
    fellowPersonaPath,
    readFellowPersona,
    fellowKeyFromName
  } = fellowManifest;

  function writeFellowSidecar(fellow) {
    fs.writeFileSync(
      path.join(runtimePaths().fellowDir, `${fellow.key}.fellow.json`),
      JSON.stringify(fellowMetadata(fellow), null, 2) + "\n"
    );
  }

  function getFellowDetails(key) {
    initializeRuntime();
    const id = String(key || "").trim();
    const manifest = loadFellowManifest();
    const { fellow } = requireFellow(manifest, id, "Fellow not found.", { fallback: false });
    return {
      fellow,
      personaText: readFellowPersona(fellow.key, fellow.name, fellow.bio),
      pet: petStatusForFellow(fellow.key)
    };
  }

  function saveFellow(fellowInput = {}) {
    const p = runtimePaths();
    const name = String(fellowInput.name || "").trim();
    if (!name) throw new Error("Fellow name is required.");
    let key = fellowKeyFromName(fellowInput.key || name);

    const manifest = loadFellowManifest();
    const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
    const existingFellow = fellows.find((item) => item.key === key);
    if (!fellowInput.key) {
      const existingKeys = new Set(fellows.map((item) => item.key));
      const baseKey = key;
      let index = 2;
      while (existingKeys.has(key)) {
        const existing = fellows.find((item) => item.key === key);
        if (existing && existing.name === name) break;
        key = `${baseKey}_${index}`;
        index += 1;
      }
    }
    const next = normalizeFellow({
      ...(existingFellow || {}),
      key,
      name,
      account_id: key,
      route_profile: key,
      agentEngine: fellowInput.agentEngine || fellowInput.agent_engine || existingFellow?.agentEngine || "hermes",
      engineConfig: normalizeFellowEngineConfig(fellowInput.engineConfig || fellowInput.engine_config || existingFellow?.engineConfig),
      platform: "api_server",
      avatarImage: fellowInput.avatarImage || fellowInput.avatar || "",
      avatarCrop: normalizeAvatarCrop(fellowInput.avatarCrop),
      bio: fellowInput.description || fellowInput.bio || fellows.find((item) => item.key === key)?.bio || "",
      capabilities: normalizeFellowCapabilities(fellowInput.capabilities || existingFellow?.capabilities)
    });
    const index = fellows.findIndex((item) => item.key === key);
    if (index >= 0) fellows[index] = next;
    else fellows.push(next);
    manifest.fellows = fellows;
    saveFellowManifest(manifest);

    const hadExplicitPersona = Object.prototype.hasOwnProperty.call(fellowInput || {}, "personaText");
    const explicitText = hadExplicitPersona ? String(fellowInput.personaText || "").trim() : "";
    const body = hadExplicitPersona
      ? fellowPersonaBody(name, explicitText || next.bio)
      : fs.existsSync(fellowPersonaPath(key))
        ? readFellowPersona(key, name, next.bio)
        : fellowPersonaBody(name, fellowInput.description || fellowInput.bio || "");
    fs.writeFileSync(path.join(p.fellowDir, `${key}.md`), body);
    writeFellowSidecar(next);
    try {
      Promise.resolve(pushFellowToCloud(next))
        .catch((error) => appendCloudLog(`Cloud fellow push failed: ${error?.message || error}`));
    } catch (error) {
      appendCloudLog(`Cloud fellow push failed: ${error?.message || error}`);
    }
    return getRuntimeStatus();
  }

  function saveFellowEngineConfig(input = {}) {
    initializeRuntime();
    const key = String(input.key || input.fellowKey || "").trim();
    if (!key) throw new Error("Fellow key is required.");
    const manifest = loadFellowManifest();
    const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
    const index = fellows.findIndex((item) => item.key === key);
    if (index < 0) throw new Error("Fellow not found.");
    fellows[index] = normalizeFellow({
      ...fellows[index],
      agentEngine: input.agentEngine || fellows[index].agentEngine || "hermes",
      engineConfig: mergeFellowEngineConfig(fellows[index].engineConfig, input.engineConfig || input.engine_config)
    });
    manifest.fellows = fellows;
    saveFellowManifest(manifest);
    writeFellowSidecar(fellows[index]);
    return getRuntimeStatus();
  }

  function setFellowPinned(input = {}) {
    const key = String(input.key || input.fellowKey || "").trim();
    if (!key) throw new Error("Fellow key is required.");
    const manifest = loadFellowManifest();
    const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
    const index = fellows.findIndex((item) => item.key === key);
    if (index < 0) throw new Error("Fellow not found.");
    const pinned = Boolean(input.pinned);
    fellows[index] = normalizeFellow({
      ...fellows[index],
      pinned,
      pinnedAt: pinned ? new Date().toISOString() : ""
    });
    manifest.fellows = fellows;
    saveFellowManifest(manifest);
    writeFellowSidecar(fellows[index]);
    return getRuntimeStatus();
  }

  function setFellowMuted(input = {}) {
    const key = String(input.key || input.fellowKey || "").trim();
    if (!key) throw new Error("Fellow key is required.");
    const manifest = loadFellowManifest();
    const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
    const index = fellows.findIndex((item) => item.key === key);
    if (index < 0) throw new Error("Fellow not found.");
    const muted = Boolean(input.muted);
    fellows[index] = normalizeFellow({
      ...fellows[index],
      muted,
      mutedAt: muted ? new Date().toISOString() : ""
    });
    manifest.fellows = fellows;
    saveFellowManifest(manifest);
    writeFellowSidecar(fellows[index]);
    return getRuntimeStatus();
  }

  function deleteFellow(input = {}) {
    initializeRuntime();
    const key = String(input.key || input.fellowKey || "").trim();
    if (!key) throw new Error("Fellow key is required.");
    if (key === "mia") throw new Error("内置 Mia 伙伴不能删除。");
    const p = runtimePaths();
    const manifest = loadFellowManifest();
    const fellows = Array.isArray(manifest.fellows) ? manifest.fellows : [];
    const fellow = fellows.find((item) => item.key === key);
    if (!fellow) throw new Error("Fellow not found.");
    manifest.fellows = fellows.filter((item) => item.key !== key);
    if (manifest.default_fellow === key) manifest.default_fellow = manifest.fellows[0]?.key || "mia";
    saveFellowManifest(manifest);
    for (const filePath of [
      path.join(p.fellowDir, `${key}.md`),
      path.join(p.fellowDir, `${key}.fellow.json`)
    ]) {
      fs.rmSync(filePath, { force: true });
    }
    const agentSessions = loadAgentSessionMap();
    for (const sessionKey of Object.keys(agentSessions)) {
      if (sessionKey.split(":")[1] === key) delete agentSessions[sessionKey];
    }
    saveAgentSessionMap(agentSessions);
    try {
      const orphaned = orphanTasksByFellow(key);
      if (orphaned > 0) {
        emitTaskEvent("orphaned", { fellowId: key, count: orphaned });
        rescanScheduler();
      }
    } catch (error) {
      warn("[tasks] orphan-by-fellow failed", error);
    }
    recallFellowPet(key);
    try {
      Promise.resolve(deleteFellowFromCloud(key))
        .catch((error) => appendCloudLog(`Cloud fellow delete failed: ${error?.message || error}`));
    } catch (error) {
      appendCloudLog(`Cloud fellow delete failed: ${error?.message || error}`);
    }
    return getRuntimeStatus();
  }

  return {
    getFellowDetails,
    saveFellow,
    saveFellowEngineConfig,
    setFellowPinned,
    setFellowMuted,
    deleteFellow
  };
}

module.exports = {
  createFellowService
};
