// Settings - choose the memory owner for newly created conversations.
(function () {
  "use strict";

  let state;
  let els;
  let reportError;
  let pendingMode = "";
  let saving = false;
  let wired = false;

  function normalizeMemoryMode(memory = {}) {
    const mode = String(memory?.mode || "").trim().toLowerCase();
    if (mode === "mia" || mode === "native") return mode;
    return memory?.enabled === false ? "native" : "mia";
  }

  function setSettingsSwitch(button, enabled) {
    if (!button) return;
    button.classList.toggle("active", Boolean(enabled));
    button.setAttribute("aria-checked", enabled ? "true" : "false");
  }

  function renderMemorySettings() {
    if (!state || !els) return;
    const mode = pendingMode || normalizeMemoryMode(state.runtime?.memory);
    setSettingsSwitch(els.settingsMemoryEnabled, mode === "mia");
    if (els.settingsMemoryEnabled) els.settingsMemoryEnabled.disabled = saving;
  }

  async function saveMemoryMode(mode) {
    const nextMode = mode === "native" ? "native" : "mia";
    const previousMode = normalizeMemoryMode(state?.runtime?.memory);
    if (!window.mia?.saveMemorySettings) {
      pendingMode = "";
      renderMemorySettings();
      reportError?.("记忆设置保存失败：当前版本不支持保存此设置。");
      return;
    }

    pendingMode = nextMode;
    saving = true;
    renderMemorySettings();
    try {
      const runtime = await window.mia.saveMemorySettings({ mode: nextMode });
      if (runtime && typeof runtime === "object") {
        state.runtime = runtime;
      } else {
        state.runtime = {
          ...(state.runtime || {}),
          memory: { mode: nextMode, enabled: nextMode === "mia" }
        };
      }
    } catch (error) {
      state.runtime = {
        ...(state.runtime || {}),
        memory: { mode: previousMode, enabled: previousMode === "mia" }
      };
      reportError?.(`记忆设置保存失败：${error?.message || error}`);
    } finally {
      pendingMode = "";
      saving = false;
      renderMemorySettings();
    }
  }

  function wireEvents() {
    if (wired || !els) return;
    wired = true;
    els.settingsMemoryEnabled?.addEventListener("click", () => {
      if (saving) return;
      const currentMode = normalizeMemoryMode(state?.runtime?.memory);
      saveMemoryMode(currentMode === "mia" ? "native" : "mia");
    });
  }

  function initMemorySettings(deps = {}) {
    state = deps.state;
    els = deps.els;
    reportError = deps.reportError;
    wireEvents();
    renderMemorySettings();
  }

  window.miaSettingsMemory = {
    initMemorySettings,
    initSettingsMemory: initMemorySettings,
    renderMemorySettings
  };
})();
