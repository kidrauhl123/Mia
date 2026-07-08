"use strict";

const path = require("node:path");

const { extractLoadSkillRequests } = require("../shared/skill-load-protocol.js");

const MAX_SKILL_LOAD_ROUNDS = 3;
const REQUIRED_CORE_PLANNER_ERROR = "Rust Core skill runtime planner is required for AgentSession skill preparation.";

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
  if (!record || typeof record !== "object") return null;
  const id = cleanText(record.id || record.key || record.name);
  const name = cleanText(record.name || record.displayName || record.display_name || id);
  const displayName = cleanText(record.displayName || record.display_name || record.title || name || id);
  const summary = cleanText(record.summary || record.description || record.desc || "");
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
    displayName: displayName || name || id,
    description: cleanText(record.description || record.desc || summary),
    summary,
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
  if (!record || typeof record !== "object") return [];
  return uniqueStrings([
    record.id,
    record.name,
    record.id && String(record.id).split(":").pop()
  ]);
}

function normalizedManagedTargets(targets = []) {
  return uniqueStrings(targets).map((target) => target.replace(/\\/g, "/"));
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

function createAgentSessionSkillRuntimeAdapter(options = {}) {
  const listSkillRecordsForBot = typeof options.listSkillRecordsForBot === "function"
    ? options.listSkillRecordsForBot
    : (bot) => Array.isArray(bot?.skillRecords) ? bot.skillRecords : [];
  const resolveSkillRecord = typeof options.resolveSkillRecord === "function"
    ? options.resolveSkillRecord
    : () => null;
  const resolveSkillRuntimeWithCore = typeof options.resolveSkillRuntimeWithCore === "function"
    ? options.resolveSkillRuntimeWithCore
    : null;

  function skillRuntimeRecordForCore(record = {}) {
    const normalized = normalizeSkillRecord(record);
    if (!normalized) return null;
    return {
      id: normalized.id,
      name: normalized.name,
      displayName: normalized.displayName,
      description: normalized.description,
      summary: normalized.summary,
      body: normalized.body,
      sourcePath: normalized.sourcePath,
      linkName: normalized.linkName
    };
  }

  function skillRuntimeRequestForCore({
    bot = {},
    agentEngine = "",
    runtimeConfig = null,
    workspacePath = "",
    activeSkillIds = [],
    intentSkillIds = [],
    requestedSkillIds = []
  } = {}) {
    const records = stableSkillEntries(listSkillRecordsForBot(bot));
    const sessionSkillIds = uniqueStrings(records.map((record) => record.id));
    const seen = new Set(records.flatMap(skillAliases));
    for (const skillId of [...activeSkillIds, ...intentSkillIds, ...requestedSkillIds]) {
      const key = cleanText(skillId);
      if (!key || seen.has(key)) continue;
      const resolved = normalizeSkillRecord(resolveSkillRecord(key));
      if (!resolved) continue;
      records.push(resolved);
      for (const alias of skillAliases(resolved)) seen.add(alias);
    }
    return {
      agentEngine: cleanText(agentEngine || bot.agentEngine || bot.agent_engine || "hermes"),
      runtimeConfig: runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {},
      workspacePath: cleanText(workspacePath),
      sessionSkillIds,
      availableSkills: stableSkillEntries(records).map(skillRuntimeRecordForCore).filter(Boolean),
      activeSkillIds: uniqueStrings(activeSkillIds),
      intentSkillIds: uniqueStrings(intentSkillIds),
      requestedSkillIds: uniqueStrings(requestedSkillIds)
    };
  }

  function normalizeCoreRuntimeSkillState(response = {}) {
    if (!response || typeof response !== "object") return null;
    const deliveryMode = cleanText(response.deliveryMode || response.delivery_mode);
    if (!deliveryMode) return null;
    return {
      deliveryMode,
      nativeSkillsDirs: Array.isArray(response.nativeSkillsDirs) ? uniqueStrings(response.nativeSkillsDirs) : [],
      resolvedSkillIds: Array.isArray(response.resolvedSkillIds) ? uniqueStrings(response.resolvedSkillIds) : [],
      resolvedSkills: stableSkillEntries(response.resolvedSkills || []),
      turnSelectedSkills: stableSkillEntries(response.turnSelectedSkills || []),
      skillFingerprint: cleanText(response.skillFingerprint),
      skillExternalDirs: Array.isArray(response.skillExternalDirs) ? uniqueStrings(response.skillExternalDirs) : [],
      skillMaterialization: response.skillMaterialization || null,
      selectedSkillPrompt: cleanText(response.selectedSkillPrompt),
      initialPromptPrefix: cleanText(response.initialPromptPrefix),
      managedSkillTargets: Array.isArray(response.managedSkillTargets)
        ? normalizedManagedTargets(response.managedSkillTargets)
        : [],
      manifestPath: cleanText(response.manifestPath)
    };
  }

  async function resolveRuntimeSkillStateWithCore(input = {}) {
    if (!resolveSkillRuntimeWithCore) {
      throw new Error(REQUIRED_CORE_PLANNER_ERROR);
    }
    const response = await resolveSkillRuntimeWithCore(skillRuntimeRequestForCore(input));
    const state = normalizeCoreRuntimeSkillState(response);
    if (!state) {
      throw new Error("Rust Core skill runtime planner returned an invalid plan.");
    }
    return state;
  }

  async function prepareAgentSessionSkillRuntime(input = {}) {
    const baseInput = {
      bot: input.botSnapshot || input.bot || {},
      agentEngine: input.runtimeConfig?.agentEngine || input.runtimeConfig?.agent_engine || input.engineId,
      runtimeConfig: input.runtimeConfig || null,
      workspacePath: input.workspacePath || "",
      activeSkillIds: input.activeSkillIds || [],
      intentSkillIds: input.intentSkillIds || []
    };
    const state = await resolveRuntimeSkillStateWithCore({
      ...baseInput,
      requestedSkillIds: input.requestedSkillIds || []
    });

    const selectedSkillRoutingPrompt = cleanText(state.selectedSkillPrompt);
    const turnPromptPrefix = joinPromptBlocks([
      selectedSkillRoutingPrompt,
      state.skillMaterialization?.indexBlock,
      state.skillMaterialization?.loadedBlock
    ]);

    return {
      skillFingerprint: state.skillFingerprint,
      skillDeliveryMode: state.deliveryMode,
      ...(Array.isArray(state.skillExternalDirs) && state.skillExternalDirs.length
        ? { skillExternalDirs: state.skillExternalDirs.slice() }
        : {}),
      ...(cleanText(state.initialPromptPrefix) ? { initialPromptPrefix: cleanText(state.initialPromptPrefix) } : {}),
      ...(Array.isArray(state.managedSkillTargets)
        ? { managedSkillTargets: state.managedSkillTargets.slice() }
        : {}),
      ...(cleanText(state.manifestPath) ? { skillManifestPath: cleanText(state.manifestPath) } : {}),
      ...(turnPromptPrefix ? { turnPromptPrefix } : {}),
      ...(state.deliveryMode === "prompt-fallback"
        ? {
            skillFallback: {
              maxRounds: MAX_SKILL_LOAD_ROUNDS,
              detectRequests: extractLoadSkillRequests,
              materializePrompt: async (requestedSkillIds = []) => {
                const nextState = await resolveRuntimeSkillStateWithCore({
                  ...baseInput,
                  requestedSkillIds
                });
                return joinPromptBlocks([
                  selectedSkillRoutingPrompt,
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
    prepareAgentSessionSkillRuntime
  });
}

module.exports = Object.freeze({
  createAgentSessionSkillRuntimeAdapter,
  normalizeSkillRecord
});
