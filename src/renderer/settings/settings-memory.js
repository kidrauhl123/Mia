// Settings - simple Mia global memory editor.
(function () {
  "use strict";

  let state, els;
  let loadToken = 0;
  let wired = false;

  function initSettingsMemory(deps = {}) {
    state = deps.state;
    els = deps.els;
    wireEvents();
  }

  function escapeHtml(value = "") {
    if (window.miaMarkdown?.escapeHtml) return window.miaMarkdown.escapeHtml(value);
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function ensureMemorySettingsState() {
    if (!state) return {};
    if (!state.settingsMemory || typeof state.settingsMemory !== "object") state.settingsMemory = {};
    state.settingsMemory = {
      entries: [],
      loaded: false,
      loading: false,
      error: "",
      editingId: "",
      draftText: "",
      savingSettings: false,
      ...state.settingsMemory
    };
    return state.settingsMemory;
  }

  function activeEntry() {
    const panel = ensureMemorySettingsState();
    const id = String(panel.editingId || "");
    if (!id) return null;
    return (Array.isArray(panel.entries) ? panel.entries : []).find((entry) => String(entry.id || "") === id) || null;
  }

  function setSettingsSwitch(button, enabled) {
    if (!button) return;
    button.classList.toggle("active", Boolean(enabled));
    button.setAttribute("aria-checked", enabled ? "true" : "false");
  }

  function syncInputValue(input, value) {
    if (!input || document.activeElement === input) return;
    input.value = value || "";
  }

  function renderMemorySettings() {
    if (!state || !els) return;
    const panel = ensureMemorySettingsState();
    setSettingsSwitch(els.settingsMemoryEnabled, state.runtime?.memory?.enabled !== false);
    if (els.settingsMemoryEnabled) els.settingsMemoryEnabled.disabled = panel.savingSettings;
    syncInputValue(els.settingsMemoryDraftText, panel.draftText);

    const editing = Boolean(panel.editingId);
    if (els.settingsMemoryEditorTitle) {
      els.settingsMemoryEditorTitle.textContent = editing ? "编辑全局记忆" : "新增全局记忆";
    }
    if (els.settingsMemoryEditorMeta) {
      const entry = activeEntry();
      const updated = entry ? String(entry.updatedAt || entry.createdAt || "").slice(0, 16).replace("T", " ") : "";
      els.settingsMemoryEditorMeta.textContent = entry
        ? (updated ? `上次更新 ${updated}` : "正在编辑这条全局记忆")
        : "这里管理当前 Mia 用户的全局记忆；单个 Bot 的记忆放在联系人详情里。";
    }
    if (els.settingsMemorySave) {
      els.settingsMemorySave.textContent = editing ? "保存修改" : "保存记忆";
      els.settingsMemorySave.disabled = panel.loading || !String(panel.draftText || "").trim();
    }
    els.settingsMemoryCancelEdit?.classList.toggle("hidden", !editing);
    renderMemoryList(panel);
  }

  function renderMemoryList(panel) {
    if (!els?.settingsMemoryList) return;
    if (panel.loading) {
      els.settingsMemoryList.innerHTML = `<div class="settings-memory-empty">正在加载记忆...</div>`;
      return;
    }
    if (panel.error) {
      els.settingsMemoryList.innerHTML = `<div class="settings-memory-error">${escapeHtml(panel.error)}</div>`;
      return;
    }
    const entries = Array.isArray(panel.entries) ? panel.entries : [];
    if (!entries.length) {
      els.settingsMemoryList.innerHTML = `<div class="settings-memory-empty">暂无全局记忆</div>`;
      return;
    }
    els.settingsMemoryList.innerHTML = entries.map((entry) => {
      const id = escapeHtml(entry.id || "");
      const updated = String(entry.updatedAt || entry.createdAt || "").slice(0, 16).replace("T", " ");
      return `
        <article class="settings-memory-row" data-memory-id="${id}">
          ${updated ? `<div class="settings-memory-meta">${escapeHtml(updated)}</div>` : ""}
          <p>${escapeHtml(entry.text || "")}</p>
          <div class="settings-memory-actions">
            <button class="secondary icon-only" type="button" data-memory-action="edit" data-memory-id="${id}" title="编辑" aria-label="编辑">✎</button>
            <button class="secondary danger icon-only" type="button" data-memory-action="delete" data-memory-id="${id}" title="删除" aria-label="删除">×</button>
          </div>
        </article>
      `;
    }).join("");
  }

  async function loadMemorySettings() {
    if (!state || !window.mia?.memory?.listAll) return;
    const panel = ensureMemorySettingsState();
    const token = ++loadToken;
    panel.loading = true;
    panel.error = "";
    renderMemorySettings();
    try {
      const result = await window.mia.memory.listAll({ scopes: ["user"], limit: 250 });
      if (token !== loadToken) return;
      const entries = Array.isArray(result) ? result : (result?.entries || result?.memories || []);
      panel.entries = entries.filter((entry) => !entry.scope || entry.scope === "user");
      panel.loaded = true;
    } catch (error) {
      if (token !== loadToken) return;
      panel.entries = [];
      panel.error = error?.message || "记忆加载失败";
    } finally {
      if (token === loadToken) {
        panel.loading = false;
        renderMemorySettings();
      }
    }
  }

  function resetEditor() {
    const panel = ensureMemorySettingsState();
    panel.editingId = "";
    panel.draftText = "";
    renderMemorySettings();
  }

  function editEntry(memoryId) {
    const panel = ensureMemorySettingsState();
    const entry = (panel.entries || []).find((item) => String(item.id || "") === String(memoryId || ""));
    if (!entry) return;
    panel.editingId = entry.id;
    panel.draftText = entry.text || "";
    renderMemorySettings();
    els?.settingsMemoryDraftText?.focus?.();
  }

  async function saveDraft() {
    if (!window.mia?.memory) return;
    const panel = ensureMemorySettingsState();
    const text = String(panel.draftText || "").trim();
    if (!text) return;
    panel.loading = true;
    panel.error = "";
    renderMemorySettings();
    try {
      if (panel.editingId) {
        const entry = activeEntry();
        if (!entry) throw new Error("找不到正在编辑的记忆。");
        await window.mia.memory.update({
          memoryId: entry.id,
          botId: entry.botId || "mia",
          sessionId: entry.sessionId || "default",
          text
        });
      } else {
        await window.mia.memory.remember({
          botId: "mia",
          sessionId: "default",
          scope: "user",
          text
        });
      }
      resetEditor();
      await loadMemorySettings();
    } catch (error) {
      panel.error = error?.message || "记忆保存失败";
      panel.loading = false;
      renderMemorySettings();
    }
  }

  async function deleteEntry(memoryId) {
    if (!memoryId || !window.mia?.memory?.delete) return;
    if (!window.confirm?.("删除这条记忆？")) return;
    const panel = ensureMemorySettingsState();
    panel.loading = true;
    panel.error = "";
    renderMemorySettings();
    try {
      await window.mia.memory.delete({ memoryId });
      if (panel.editingId === memoryId) resetEditor();
      await loadMemorySettings();
    } catch (error) {
      panel.error = error?.message || "记忆删除失败";
      panel.loading = false;
      renderMemorySettings();
    }
  }

  async function saveMemoryEnabled(enabled) {
    if (!window.mia?.saveMemorySettings) return;
    const panel = ensureMemorySettingsState();
    panel.savingSettings = true;
    renderMemorySettings();
    try {
      const runtime = await window.mia.saveMemorySettings({ enabled: enabled !== false });
      if (runtime) state.runtime = runtime;
    } catch (error) {
      panel.error = error?.message || "记忆设置保存失败";
    } finally {
      panel.savingSettings = false;
      renderMemorySettings();
    }
  }

  function wireEvents() {
    if (wired || !els) return;
    wired = true;
    els.settingsMemoryEnabled?.addEventListener("click", () => {
      const next = els.settingsMemoryEnabled.getAttribute("aria-checked") !== "true";
      setSettingsSwitch(els.settingsMemoryEnabled, next);
      saveMemoryEnabled(next);
    });
    els.settingsMemoryDraftText?.addEventListener("input", () => {
      ensureMemorySettingsState().draftText = els.settingsMemoryDraftText.value;
      renderMemorySettings();
    });
    els.settingsMemorySave?.addEventListener("click", () => saveDraft());
    els.settingsMemoryCancelEdit?.addEventListener("click", () => resetEditor());
    els.settingsMemoryList?.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-memory-action]");
      if (!button) return;
      const id = button.dataset.memoryId || "";
      if (!id) return;
      if (button.dataset.memoryAction === "edit") editEntry(id);
      if (button.dataset.memoryAction === "delete") deleteEntry(id);
    });
  }

  window.miaSettingsMemory = {
    initSettingsMemory,
    loadMemorySettings,
    renderMemorySettings
  };
})();
