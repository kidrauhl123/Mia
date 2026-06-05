"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { requireBot } = require("./bot-registry.js");

function createBotService({
  initializeRuntime,
  runtimePaths,
  botManifest,
  loadAgentSessionMap,
  saveAgentSessionMap,
  orphanTasksByBot = () => 0,
  emitTaskEvent = () => {},
  rescanScheduler = () => {},
  recallBotPet = () => {},
  pushBotToCloud = async () => {},
  deleteBotFromCloud = async () => {},
  appendCloudLog = () => {},
  getRuntimeStatus,
  petStatusForBot = () => null,
  warn = (...args) => console.warn(...args)
}) {
  const {
    normalizeBotEngineConfig,
    mergeBotEngineConfig,
    normalizeBotCapabilities,
    normalizeBot,
    normalizeAvatarCrop,
    loadBotManifest,
    saveBotManifest,
    botPersonaBody,
    botMetadata,
    botPersonaPath,
    readBotPersona,
    botKeyFromName
  } = botManifest;

  function writeBotSidecar(bot) {
    fs.writeFileSync(
      path.join(runtimePaths().botDir, `${bot.key}.bot.json`),
      JSON.stringify(botMetadata(bot), null, 2) + "\n"
    );
  }

  function getBotDetails(key) {
    initializeRuntime();
    const id = String(key || "").trim();
    const manifest = loadBotManifest();
    const { bot } = requireBot(manifest, id, "Bot not found.", { fallback: false });
    return {
      bot,
      personaText: bot.personaText || readBotPersona(bot.key, bot.name, bot.bio),
      pet: petStatusForBot(bot.key)
    };
  }

  function saveBot(botInput = {}) {
    const p = runtimePaths();
    const name = String(botInput.name || botInput.displayName || "").trim();
    if (!name) throw new Error("Bot name is required.");
    let key = botKeyFromName(botInput.key || botInput.id || name);

    const manifest = loadBotManifest();
    const bots = Array.isArray(manifest.bots) ? manifest.bots : [];
    let existingBot = bots.find((item) => item.key === key);
    if (!botInput.key && !botInput.id) {
      const existingKeys = new Set(bots.map((item) => item.key));
      const baseKey = key;
      let index = 2;
      while (existingKeys.has(key)) {
        const existing = bots.find((item) => item.key === key);
        if (existing && existing.name === name) break;
        key = `${baseKey}_${index}`;
        index += 1;
      }
      existingBot = bots.find((item) => item.key === key);
    }
    const next = normalizeBot({
      ...(existingBot || {}),
      key,
      name,
      account_id: key,
      route_profile: key,
      agentEngine: botInput.agentEngine || botInput.agent_engine || existingBot?.agentEngine || "hermes",
      engineConfig: normalizeBotEngineConfig(botInput.engineConfig || botInput.engine_config || existingBot?.engineConfig),
      platform: "api_server",
      color: botInput.color || botInput.avatarColor || existingBot?.color || "",
      avatarImage: botInput.avatarImage || botInput.avatar || "",
      avatarCrop: normalizeAvatarCrop(botInput.avatarCrop),
      bio: botInput.description || botInput.bio || bots.find((item) => item.key === key)?.bio || "",
      capabilities: normalizeBotCapabilities(botInput.capabilities || existingBot?.capabilities)
    });

    const hadExplicitPersona = Object.prototype.hasOwnProperty.call(botInput || {}, "personaText");
    const explicitText = hadExplicitPersona ? String(botInput.personaText || "").trim() : "";
    let body = "";
    if (hadExplicitPersona) {
      body = botPersonaBody(name, explicitText || next.bio);
    } else if (existingBot?.personaText) {
      body = String(existingBot.personaText || "").trim();
    } else if (fs.existsSync(botPersonaPath(key))) {
      body = readBotPersona(key, name, next.bio);
    } else {
      body = botPersonaBody(name, botInput.description || botInput.bio || "");
    }
    const nextWithPersona = normalizeBot({ ...next, personaText: body });
    const index = bots.findIndex((item) => item.key === key);
    if (index >= 0) bots[index] = nextWithPersona;
    else bots.push(nextWithPersona);
    manifest.bots = bots;
    saveBotManifest(manifest);
    fs.writeFileSync(path.join(p.botDir, `${key}.md`), body);
    writeBotSidecar(nextWithPersona);
    try {
      Promise.resolve(pushBotToCloud(nextWithPersona))
        .catch((error) => appendCloudLog(`Cloud bot push failed: ${error?.message || error}`));
    } catch (error) {
      appendCloudLog(`Cloud bot push failed: ${error?.message || error}`);
    }
    return getRuntimeStatus();
  }

  function saveBotEngineConfig(input = {}) {
    initializeRuntime();
    const key = String(input.key || input.botKey || input.botId || "").trim();
    if (!key) throw new Error("Bot key is required.");
    const manifest = loadBotManifest();
    const bots = Array.isArray(manifest.bots) ? manifest.bots : [];
    const index = bots.findIndex((item) => item.key === key);
    if (index < 0) throw new Error("Bot not found.");
    bots[index] = normalizeBot({
      ...bots[index],
      agentEngine: input.agentEngine || bots[index].agentEngine || "hermes",
      engineConfig: mergeBotEngineConfig(bots[index].engineConfig, input.engineConfig || input.engine_config)
    });
    manifest.bots = bots;
    saveBotManifest(manifest);
    writeBotSidecar(bots[index]);
    return getRuntimeStatus();
  }

  function setBotPinned(input = {}) {
    const key = String(input.key || input.botKey || input.botId || "").trim();
    if (!key) throw new Error("Bot key is required.");
    const manifest = loadBotManifest();
    const bots = Array.isArray(manifest.bots) ? manifest.bots : [];
    const index = bots.findIndex((item) => item.key === key);
    if (index < 0) throw new Error("Bot not found.");
    const pinned = Boolean(input.pinned);
    bots[index] = normalizeBot({
      ...bots[index],
      pinned,
      pinnedAt: pinned ? new Date().toISOString() : ""
    });
    manifest.bots = bots;
    saveBotManifest(manifest);
    writeBotSidecar(bots[index]);
    return getRuntimeStatus();
  }

  function setBotMuted(input = {}) {
    const key = String(input.key || input.botKey || input.botId || "").trim();
    if (!key) throw new Error("Bot key is required.");
    const manifest = loadBotManifest();
    const bots = Array.isArray(manifest.bots) ? manifest.bots : [];
    const index = bots.findIndex((item) => item.key === key);
    if (index < 0) throw new Error("Bot not found.");
    const muted = Boolean(input.muted);
    bots[index] = normalizeBot({
      ...bots[index],
      muted,
      mutedAt: muted ? new Date().toISOString() : ""
    });
    manifest.bots = bots;
    saveBotManifest(manifest);
    writeBotSidecar(bots[index]);
    return getRuntimeStatus();
  }

  function deleteBot(input = {}) {
    initializeRuntime();
    const key = String(input.key || input.botKey || input.botId || "").trim();
    if (!key) throw new Error("Bot key is required.");
    if (key === "mia") throw new Error("内置 Mia Bot 不能删除。");
    const p = runtimePaths();
    const manifest = loadBotManifest();
    const bots = Array.isArray(manifest.bots) ? manifest.bots : [];
    const bot = bots.find((item) => item.key === key);
    if (!bot) throw new Error("Bot not found.");
    manifest.bots = bots.filter((item) => item.key !== key);
    if (manifest.default_bot === key) manifest.default_bot = manifest.bots[0]?.key || "mia";
    saveBotManifest(manifest);
    for (const filePath of [
      path.join(p.botDir, `${key}.md`),
      path.join(p.botDir, `${key}.bot.json`)
    ]) {
      fs.rmSync(filePath, { force: true });
    }
    const agentSessions = loadAgentSessionMap();
    for (const sessionKey of Object.keys(agentSessions)) {
      if (sessionKey.split(":")[1] === key) delete agentSessions[sessionKey];
    }
    saveAgentSessionMap(agentSessions);
    try {
      const orphaned = orphanTasksByBot(key);
      if (orphaned > 0) {
        emitTaskEvent("orphaned", { botId: key, count: orphaned });
        rescanScheduler();
      }
    } catch (error) {
      warn("[tasks] orphan-by-bot failed", error);
    }
    recallBotPet(key);
    try {
      Promise.resolve(deleteBotFromCloud(key))
        .catch((error) => appendCloudLog(`Cloud bot delete failed: ${error?.message || error}`));
    } catch (error) {
      appendCloudLog(`Cloud bot delete failed: ${error?.message || error}`);
    }
    return getRuntimeStatus();
  }

  return {
    getBotDetails,
    saveBot,
    saveBotEngineConfig,
    setBotPinned,
    setBotMuted,
    deleteBot
  };
}

module.exports = {
  createBotService
};
