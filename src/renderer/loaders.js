// Runtime loaders module
// Extracted from app.js. The five async IPC-driven loaders that hydrate
// runtime data into state at startup (and on demand):
//
//   - loadModelCatalog        → state.modelCatalog (Hermes model catalog)
//   - loadCodexModels         → state.codexModels (Codex CLI model cache)
//   - loadEngineCapabilities  → state.engineCapabilities (probe Hermes for
//                                approval modes + effort levels) + render()
//   - loadSlashCommands       → state.slashCommands + state.agentSlashCommands
//   - loadSkills              → state.skillLibrary (and re-render skill UI)
//
// No DOM render of its own beyond delegating to extracted modules.
(function () {
  "use strict";

  const AGENT_SLASH_COMMAND_ENGINES = Object.freeze(["claude-code", "codex"]);

  let state;
  let render;

  function normalizeSlashCommandRows(rows = []) {
    return (Array.isArray(rows) ? rows : [])
      .filter((item) => item?.command || item?.name)
      .map((item) => ({
        ...item,
        command: String(item.command || item.name || "").startsWith("/")
          ? String(item.command || item.name || "")
          : `/${item.command || item.name}`,
        description: String(item.description || "")
      }));
  }

  function initLoaders(deps) {
    state = deps.state;
    render = deps.render;
  }

  function refreshOpenBotRuntimeSelector() {
    if (!state?.botDialogOpen) return;
    if (typeof window.miaBotDialog?.readSelectedRuntimeTarget !== "function") return;
    if (typeof window.miaBotDialog?.renderBotRuntimeTargetSelect !== "function") return;
    const selected = window.miaBotDialog.readSelectedRuntimeTarget();
    window.miaBotDialog.renderBotRuntimeTargetSelect({
      runtimeKind: selected.runtimeKind,
      deviceId: selected.targetDeviceId,
      deviceName: selected.targetDeviceName,
      agentEngine: selected.agentEngine
    }, { preservePrevious: true });
  }

  async function loadModelCatalog() {
    if (!state) return;
    try {
      const rows = await window.mia.loadModelCatalog();
      state.modelCatalog = Array.isArray(rows) && rows.length ? rows : window.miaModelHelpers.fallbackCatalogFromPresets();
    } catch (error) {
      console.error("Failed to load Hermes model catalog", error);
      state.modelCatalog = window.miaModelHelpers.fallbackCatalogFromPresets();
    }
  }

  async function loadCodexModels() {
    if (!state) return;
    try {
      if (!window.mia?.loadCodexModels) return;
      const rows = await window.mia.loadCodexModels();
      state.codexModels = Array.isArray(rows) ? rows : [];
    } catch (error) {
      console.error("Failed to load Codex model list", error);
      state.codexModels = [];
    }
  }

  async function loadEngineCapabilities() {
    if (!state) return;
    let caps = { approvalModes: ["ask", "yolo", "deny"], effortLevels: ["low", "medium", "high"] };
    try {
      if (window.mia.loadEngineCapabilities) {
        const res = await window.mia.loadEngineCapabilities();
        if (res && Array.isArray(res.approvalModes) && res.approvalModes.length
            && Array.isArray(res.effortLevels) && res.effortLevels.length) {
          caps = res;
          const codexModels = res.engines?.codex?.models;
          if (Array.isArray(codexModels) && codexModels.length) state.codexModels = codexModels;
        }
      }
    } catch (error) {
      console.error("Failed to load engine capabilities", error);
    }
    state.engineCapabilities = caps;
    refreshOpenBotRuntimeSelector();
    // `render()` calls syncEffortControl + syncPermissionControl which use
    // window.miaEngineOptions.effortOptions()/externalPermissionOptions()
    // — those read state.engineCapabilities.
    render();
  }

  async function loadSlashCommands() {
    if (!state) return;
    try {
      const rows = await window.mia.loadSlashCommands();
      state.slashCommands = normalizeSlashCommandRows(rows);
    } catch (error) {
      console.error("Failed to load Hermes slash commands", error);
      state.slashCommands = [];
    }
    await Promise.allSettled(AGENT_SLASH_COMMAND_ENGINES.map(async (engine) => {
      try {
        const registry = await window.mia.loadAgentCommands?.({ engine });
        const rows = Array.isArray(registry?.rows) ? registry.rows : (Array.isArray(registry) ? registry : []);
        state.agentSlashCommands[engine] = normalizeSlashCommandRows(rows);
      } catch (error) {
        console.error(`Failed to load ${engine} slash commands`, error);
        state.agentSlashCommands[engine] = [];
      }
    }));
  }

  async function loadSkills() {
    if (!state) return;
    state.skillsLoading = true;
    window.miaSkillLibrary.renderSkillLibrary();
    try {
      const library = await window.mia.loadSkills();
      const sources = Array.isArray(library?.sources)
        ? library.sources
        : (Array.isArray(library?.plugins) ? library.plugins : []);
      state.skillLibrary = {
        plugins: Array.isArray(library?.plugins) ? library.plugins : sources,
        sources,
        extensions: Array.isArray(library?.extensions) ? library.extensions : [],
        connectors: Array.isArray(library?.connectors) ? library.connectors : [],
        roots: Array.isArray(library?.roots) ? library.roots : [],
        skills: Array.isArray(library?.skills) ? library.skills : [],
        botPresets: Array.isArray(library?.botPresets) ? library.botPresets : []
      };
      if (!state.selectedSkillId || !state.skillLibrary.skills.some((skill) => skill.id === state.selectedSkillId)) {
        state.selectedSkillId = state.skillLibrary.skills[0]?.id || "";
        state.selectedSkillDetail = null;
      }
      if (state.selectedSkillId) await window.miaSkillLibrary.selectSkill(state.selectedSkillId, false);
    } catch (error) {
      console.error("Failed to load local skills", error);
      state.skillLibrary = { plugins: [], sources: [], extensions: [], connectors: [], roots: [], skills: [], botPresets: [] };
      state.selectedSkillId = "";
      state.selectedSkillDetail = null;
    } finally {
      state.skillsLoading = false;
      window.miaSkillLibrary.renderSkillLibrary();
      window.miaComposer.renderSkillPicker();
    }
  }

  window.miaLoaders = {
    initLoaders,
    loadModelCatalog,
    loadCodexModels,
    loadEngineCapabilities,
    loadSlashCommands,
    loadSkills,
  };
})();
