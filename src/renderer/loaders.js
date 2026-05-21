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

  let state;
  let render;
  let fallbackSlashCommands = [];

  function initLoaders(deps) {
    state = deps.state;
    render = deps.render;
    fallbackSlashCommands = deps.fallbackSlashCommands || [];
  }

  async function loadModelCatalog() {
    if (!state) return;
    try {
      const rows = await window.aimashi.loadModelCatalog();
      state.modelCatalog = Array.isArray(rows) && rows.length ? rows : window.aimashiModelHelpers.fallbackCatalogFromPresets();
    } catch (error) {
      console.error("Failed to load Hermes model catalog", error);
      state.modelCatalog = window.aimashiModelHelpers.fallbackCatalogFromPresets();
    }
  }

  async function loadCodexModels() {
    if (!state) return;
    try {
      if (!window.aimashi?.loadCodexModels) return;
      const rows = await window.aimashi.loadCodexModels();
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
      if (window.aimashi.loadEngineCapabilities) {
        const res = await window.aimashi.loadEngineCapabilities();
        if (res && Array.isArray(res.approvalModes) && res.approvalModes.length
            && Array.isArray(res.effortLevels) && res.effortLevels.length) {
          caps = res;
        }
      }
    } catch (error) {
      console.error("Failed to load engine capabilities", error);
    }
    state.engineCapabilities = caps;
    // `render()` calls syncEffortControl + syncPermissionControl which use
    // window.aimashiEngineOptions.effortOptions()/externalPermissionOptions()
    // — those read state.engineCapabilities.
    render();
  }

  async function loadSlashCommands() {
    if (!state) return;
    try {
      const rows = await window.aimashi.loadSlashCommands();
      state.slashCommands = Array.isArray(rows) && rows.length ? rows : fallbackSlashCommands;
    } catch (error) {
      console.error("Failed to load Hermes slash commands", error);
      state.slashCommands = fallbackSlashCommands;
    }
    await Promise.allSettled(["claude-code", "codex"].map(async (engine) => {
      try {
        const registry = await window.aimashi.loadAgentCommands?.({ engine });
        const rows = Array.isArray(registry?.rows) ? registry.rows : (Array.isArray(registry) ? registry : []);
        state.agentSlashCommands[engine] = rows
          .filter((item) => item?.command || item?.name)
          .map((item) => ({
            ...item,
            command: String(item.command || item.name || "").startsWith("/")
              ? String(item.command || item.name || "")
              : `/${item.command || item.name}`,
            description: String(item.description || "")
          }));
      } catch (error) {
        console.error(`Failed to load ${engine} slash commands`, error);
        state.agentSlashCommands[engine] = [];
      }
    }));
  }

  async function loadSkills() {
    if (!state) return;
    state.skillsLoading = true;
    window.aimashiSkillLibrary.renderSkillLibrary();
    try {
      const library = await window.aimashi.loadSkills();
      const sources = Array.isArray(library?.sources)
        ? library.sources
        : (Array.isArray(library?.plugins) ? library.plugins : []);
      state.skillLibrary = {
        plugins: Array.isArray(library?.plugins) ? library.plugins : sources,
        sources,
        extensions: Array.isArray(library?.extensions) ? library.extensions : [],
        connectors: Array.isArray(library?.connectors) ? library.connectors : [],
        roots: Array.isArray(library?.roots) ? library.roots : [],
        skills: Array.isArray(library?.skills) ? library.skills : []
      };
      if (!state.selectedSkillId || !state.skillLibrary.skills.some((skill) => skill.id === state.selectedSkillId)) {
        state.selectedSkillId = state.skillLibrary.skills[0]?.id || "";
        state.selectedSkillDetail = null;
      }
      if (state.selectedSkillId) await window.aimashiSkillLibrary.selectSkill(state.selectedSkillId, false);
    } catch (error) {
      console.error("Failed to load local skills", error);
      state.skillLibrary = { plugins: [], sources: [], extensions: [], connectors: [], roots: [], skills: [] };
      state.selectedSkillId = "";
      state.selectedSkillDetail = null;
    } finally {
      state.skillsLoading = false;
      window.aimashiSkillLibrary.renderSkillLibrary();
      window.aimashiComposer.renderSkillPicker();
    }
  }

  window.aimashiLoaders = {
    initLoaders,
    loadModelCatalog,
    loadCodexModels,
    loadEngineCapabilities,
    loadSlashCommands,
    loadSkills,
  };
})();
