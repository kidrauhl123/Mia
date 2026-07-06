"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  agentEnginePolicy,
  normalizeAgentEngine
} = require("../../shared/agent-engine-policy.js");
const { extractLoadSkillRequests } = require("../../shared/skill-load-protocol.js");

const MANAGED_SKILL_MANIFEST_RELATIVE_PATH = path.join(".mia", "skill-runtime.json");
const MAX_SKILL_LOAD_ROUNDS = 3;

function cleanText(value = "") {
  return String(value || "").trim();
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = cleanText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeSkillRecord(record = {}) {
  const id = cleanText(record.id || record.key || record.name);
  const name = cleanText(record.name || record.displayName || record.display_name || id);
  const sourcePath = cleanText(
    record.sourcePath
    || record.source_path
    || (record.filePath ? path.dirname(record.filePath) : "")
  );
  const linkName = cleanText(
    record.linkName
    || record.link_name
    || (id.includes(":") ? id.split(":").pop() : id)
    || name
    || (sourcePath ? path.basename(sourcePath) : "")
  );
  if (!id && !name) return null;
  return {
    id: id || name,
    name: name || id,
    description: cleanText(record.description || record.desc || ""),
    body: cleanText(record.body || record.raw || ""),
    sourcePath,
    linkName
  };
}

function stableSkillEntries(records = []) {
  return (Array.isArray(records) ? records : [])
    .map(normalizeSkillRecord)
    .filter(Boolean)
    .sort((left, right) => {
      const leftKey = `${left.id}\n${left.linkName}\n${left.sourcePath}`;
      const rightKey = `${right.id}\n${right.linkName}\n${right.sourcePath}`;
      return leftKey.localeCompare(rightKey);
    });
}

function skillAliases(record = {}) {
  return uniqueStrings([
    record.id,
    record.name,
    record.id && String(record.id).split(":").pop()
  ]);
}

function mergeBotEnabledSkills(bot = {}, extraSkillIds = []) {
  const currentIds = Array.isArray(bot?.capabilities?.enabledSkills)
    ? bot.capabilities.enabledSkills
    : [];
  const enabledSkills = uniqueStrings([...currentIds, ...extraSkillIds]);
  return {
    ...(bot || {}),
    capabilities: {
      ...(bot?.capabilities || {}),
      enabledSkills
    }
  };
}

function hashSkillFingerprint(value = null) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function fallbackMaterialization() {
  return {
    indexBlock: "",
    loadedBlock: "",
    loadedSkillIds: []
  };
}

function managedManifestPath(workspacePath = "") {
  return path.join(cleanText(workspacePath), MANAGED_SKILL_MANIFEST_RELATIVE_PATH);
}

function readManagedManifest(manifestPath = "") {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedManagedTargets(targets = []) {
  return uniqueStrings(targets).map((target) => target.replace(/\\/g, "/"));
}

function targetPathMatchesSource(targetPath = "", sourcePath = "") {
  try {
    if (!fs.existsSync(targetPath)) return false;
    const stat = fs.lstatSync(targetPath);
    if (!stat.isSymbolicLink()) return false;
    const linkedTarget = fs.readlinkSync(targetPath);
    const resolvedLinkedTarget = path.resolve(path.dirname(targetPath), linkedTarget);
    return resolvedLinkedTarget === path.resolve(sourcePath);
  } catch {
    return false;
  }
}

function ensureManagedSkillLink({ targetPath = "", sourcePath = "", targetRelativePath = "", previousManagedTargets = new Set() } = {}) {
  if (!targetPath || !sourcePath) return false;
  let sourceExists = false;
  try {
    sourceExists = fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory();
  } catch {
    sourceExists = false;
  }
  if (!sourceExists) return false;

  if (targetPathMatchesSource(targetPath, sourcePath)) return true;

  if (fs.existsSync(targetPath)) {
    if (!previousManagedTargets.has(targetRelativePath)) {
      return false;
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  fs.symlinkSync(sourcePath, targetPath, "dir");
  return true;
}

function joinPromptBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => cleanText(block))
    .filter(Boolean)
    .join("\n\n");
}

function fallbackForUnresolvedSkillLoad(ids = []) {
  const label = Array.isArray(ids) && ids.length ? ids.join("、") : "对应 Skill";
  return `我没能加载到 ${label} 的完整指南。请确认这个 Skill 已安装或已添加到这个 Bot 的能力列表。`;
}

function createSkillRuntimeOwner(options = {}) {
  const listSkillRecordsForBot = typeof options.listSkillRecordsForBot === "function"
    ? options.listSkillRecordsForBot
    : (bot) => Array.isArray(bot?.skillRecords) ? bot.skillRecords : [];
  const materializePromptFallback = typeof options.materializePromptFallback === "function"
    ? options.materializePromptFallback
    : fallbackMaterialization;

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
    const mergedBot = mergeBotEnabledSkills(bot, [
      ...activeSkillIds,
      ...intentSkillIds,
      ...requestedSkillIds
    ]);
    const records = stableSkillEntries(listSkillRecordsForBot(mergedBot));
    const requestedAliases = new Set(uniqueStrings([
      ...(Array.isArray(mergedBot?.capabilities?.enabledSkills) ? mergedBot.capabilities.enabledSkills : []),
      ...activeSkillIds,
      ...intentSkillIds,
      ...requestedSkillIds
    ]));
    const resolvedSkills = records.filter((record) => {
      if (!requestedAliases.size) return true;
      return skillAliases(record).some((alias) => requestedAliases.has(alias));
    });
    const resolvedSkillIds = resolvedSkills.map((record) => record.id);
    const deliveryMode = nativeSkillsDirs.length > 0 ? "native-link" : "prompt-fallback";
    const skillMaterialization = deliveryMode === "prompt-fallback"
      ? (materializePromptFallback({
          bot: mergedBot,
          engine,
          resolvedSkillIds,
          resolvedSkills,
          activeSkillIds: uniqueStrings(activeSkillIds),
          intentSkillIds: uniqueStrings(intentSkillIds),
          requestedSkillIds: uniqueStrings(requestedSkillIds)
        }) || fallbackMaterialization())
      : null;
    const skillFingerprint = hashSkillFingerprint({
      deliveryMode,
      nativeSkillsDirs,
      resolvedSkills: resolvedSkills.map((record) => ({
        id: record.id,
        name: record.name,
        linkName: record.linkName,
        sourcePath: record.sourcePath,
        bodyHash: hashSkillFingerprint(record.body)
      }))
    });

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

  async function reconcileWorkspaceSkills({ workspacePath = "", state = {} } = {}) {
    const normalizedWorkspacePath = cleanText(workspacePath);
    const manifestPath = normalizedWorkspacePath ? managedManifestPath(normalizedWorkspacePath) : "";
    const previousManifest = manifestPath ? readManagedManifest(manifestPath) : {};
    const previousManagedTargets = new Set(normalizedManagedTargets(previousManifest.managedTargets));
    const managedTargets = [];

    if (normalizedWorkspacePath && state?.deliveryMode === "native-link") {
      for (const relativeDir of Array.isArray(state.nativeSkillsDirs) ? state.nativeSkillsDirs : []) {
        const normalizedRelativeDir = cleanText(relativeDir);
        if (!normalizedRelativeDir) continue;
        const nativeSkillDir = path.join(normalizedWorkspacePath, normalizedRelativeDir);
        fs.mkdirSync(nativeSkillDir, { recursive: true });
        for (const skill of stableSkillEntries(state.resolvedSkills)) {
          if (!skill.sourcePath || !skill.linkName) continue;
          const targetRelativePath = path.join(normalizedRelativeDir, skill.linkName).replace(/\\/g, "/");
          const targetPath = path.join(normalizedWorkspacePath, targetRelativePath);
          const linked = ensureManagedSkillLink({
            targetPath,
            sourcePath: skill.sourcePath,
            targetRelativePath,
            previousManagedTargets
          });
          if (linked) managedTargets.push(targetRelativePath);
        }
      }
    }

    const nextManagedTargets = normalizedManagedTargets(managedTargets);
    for (const targetRelativePath of previousManagedTargets) {
      if (nextManagedTargets.includes(targetRelativePath)) continue;
      fs.rmSync(path.join(normalizedWorkspacePath, targetRelativePath), { recursive: true, force: true });
    }

    if (manifestPath) {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          skillFingerprint: cleanText(state.skillFingerprint),
          managedTargets: nextManagedTargets
        }, null, 2) + "\n",
        "utf8"
      );
    }

    return {
      manifestPath,
      managedTargets: nextManagedTargets
    };
  }

  async function prepareAgentSessionSkillRuntime(input = {}) {
    const baseInput = {
      bot: input.botSnapshot || input.bot || {},
      agentEngine: input.runtimeConfig?.agentEngine || input.runtimeConfig?.agent_engine || input.engineId,
      activeSkillIds: input.activeSkillIds || [],
      intentSkillIds: input.intentSkillIds || []
    };
    const state = resolveRuntimeSkillState({
      ...baseInput,
      requestedSkillIds: input.requestedSkillIds || []
    });

    if (cleanText(input.workspacePath)) {
      await reconcileWorkspaceSkills({
        workspacePath: input.workspacePath,
        engineId: input.engineId,
        state
      });
    }

    const turnPromptPrefix = joinPromptBlocks([
      state.skillMaterialization?.indexBlock,
      state.skillMaterialization?.loadedBlock
    ]);

    return {
      skillFingerprint: state.skillFingerprint,
      skillDeliveryMode: state.deliveryMode,
      ...(cleanText(state.initialPromptPrefix) ? { initialPromptPrefix: cleanText(state.initialPromptPrefix) } : {}),
      ...(turnPromptPrefix ? { turnPromptPrefix } : {}),
      ...(state.deliveryMode === "prompt-fallback"
        ? {
            skillFallback: {
              maxRounds: MAX_SKILL_LOAD_ROUNDS,
              detectRequests: extractLoadSkillRequests,
              materializePrompt: async (requestedSkillIds = []) => {
                const nextState = resolveRuntimeSkillState({
                  ...baseInput,
                  requestedSkillIds
                });
                return joinPromptBlocks([
                  nextState.skillMaterialization?.indexBlock,
                  nextState.skillMaterialization?.loadedBlock
                ]);
              },
              fallbackText: fallbackForUnresolvedSkillLoad
            }
          }
        : {})
    };
  }

  return Object.freeze({
    MANAGED_SKILL_MANIFEST_RELATIVE_PATH,
    hashSkillFingerprint,
    managedManifestPath,
    prepareAgentSessionSkillRuntime,
    reconcileWorkspaceSkills,
    resolveRuntimeSkillState
  });
}

module.exports = Object.freeze({
  MANAGED_SKILL_MANIFEST_RELATIVE_PATH,
  createSkillRuntimeOwner,
  hashSkillFingerprint,
  managedManifestPath,
  normalizeSkillRecord
});
