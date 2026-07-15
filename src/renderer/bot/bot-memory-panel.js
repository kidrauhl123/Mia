// Per-Bot Mia memory panel for the contact detail surface.
// It presents the bounded memory document as entries while keeping document
// serialization and mutation ownership in Rust Core.
(function () {
  "use strict";

  let state;
  let renderContacts;

  function initBotMemoryPanel(deps = {}) {
    state = deps.state;
    renderContacts = deps.renderContacts;
  }

  function botKey(bot = {}) {
    return String(bot.key || bot.id || "").trim();
  }

  function botId(bot = {}) {
    // Mia memory follows the stable Bot key used by conversations. Cloud
    // contact IDs can be a separate remote identity for the same Bot.
    return String(bot.key || bot.id || "").trim();
  }

  function escapeHtml(value) {
    return window.miaMarkdown?.escapeHtml?.(String(value ?? "")) || String(value ?? "");
  }

  function memoryEntriesCache() {
    if (!(state?.botMemoryEntries instanceof Map)) state.botMemoryEntries = new Map();
    return state.botMemoryEntries;
  }

  function memoryLoadingKeys() {
    if (!(state?.botMemoryLoadingKeys instanceof Set)) state.botMemoryLoadingKeys = new Set();
    return state.botMemoryLoadingKeys;
  }

  function openPanelKeys() {
    if (!(state?.openMemoryPanelKeys instanceof Set)) state.openMemoryPanelKeys = new Set();
    return state.openMemoryPanelKeys;
  }

  function currentEditor() {
    const fallback = { botKey: "", entryIndex: -1, oldText: "", draft: "", saving: false, error: "" };
    if (!state?.botMemoryEditor || typeof state.botMemoryEditor !== "object") state.botMemoryEditor = fallback;
    return state.botMemoryEditor;
  }

  function clearEditor() {
    if (!state) return;
    state.botMemoryEditor = { botKey: "", entryIndex: -1, oldText: "", draft: "", saving: false, error: "" };
  }

  function normalizeMemoryResponse(response = {}) {
    const data = response?.data && typeof response.data === "object" ? response.data : response;
    return {
      mode: String(data?.mode || "mia").toLowerCase() === "native" ? "native" : "mia",
      entries: Array.isArray(data?.entries) ? data.entries.map((entry) => String(entry || "")).filter(Boolean) : [],
      usedChars: Number(data?.usedChars || data?.used_chars || 0),
      limitChars: Number(data?.limitChars || data?.limit_chars || 2200),
      revision: Number(data?.revision || 0),
      updatedAt: String(data?.updatedAt || data?.updated_at || ""),
      error: "",
      loadedAt: Date.now()
    };
  }

  function panelData(bot) {
    const key = botKey(bot);
    const data = memoryEntriesCache().get(key) || null;
    if (!data && key) loadBotMemory(bot);
    return data;
  }

  async function loadBotMemory(bot, options = {}) {
    const key = botKey(bot);
    const id = botId(bot);
    if (!key || !id || !state) return null;
    const cache = memoryEntriesCache();
    const loading = memoryLoadingKeys();
    const cached = cache.get(key) || null;
    const stillFresh = cached && Date.now() - Number(cached.loadedAt || 0) < 10_000;
    if (loading.has(key) || (!options.force && stillFresh)) return cached;
    const api = window.mia?.social?.getBotMemory;
    if (typeof api !== "function") {
      const unavailable = { mode: "mia", entries: [], error: "记忆功能暂不可用", loadedAt: Date.now() };
      cache.set(key, unavailable);
      renderContacts?.();
      return unavailable;
    }
    loading.add(key);
    try {
      const result = await api(id);
      if (result?.ok === false) throw new Error(result.error || "读取记忆失败");
      const data = normalizeMemoryResponse(result);
      cache.set(key, data);
      return data;
    } catch (error) {
      const failed = {
        ...(cached || { mode: "mia", entries: [], usedChars: 0, limitChars: 2200, revision: 0, updatedAt: "" }),
        error: "暂时无法读取记忆",
        loadedAt: Date.now()
      };
      cache.set(key, failed);
      return failed;
    } finally {
      loading.delete(key);
      renderContacts?.();
    }
  }

  function memorySummary(data, loading) {
    if (data?.mode === "native") return "由原生 Agent 管理";
    if (!data && loading) return "正在读取记忆";
    if (data?.error) return data.error;
    const count = Array.isArray(data?.entries) ? data.entries.length : 0;
    if (!count) return "还没有记录";
    return `${count} 条记忆 · ${data.usedChars || 0}/${data.limitChars || 2200} 字`;
  }

  function renderMemoryEntry(bot, entry, index) {
    const key = botKey(bot);
    const editor = currentEditor();
    const editing = editor.botKey === key && editor.entryIndex === index;
    if (editing) {
      return `
        <li class="contact-memory-entry editing">
          <span class="contact-memory-index" aria-hidden="true">${index + 1}</span>
          <div class="contact-memory-entry-editor">
            <textarea data-memory-edit-draft maxlength="2200" aria-label="编辑第 ${index + 1} 条记忆">${escapeHtml(editor.draft)}</textarea>
            ${editor.error ? `<p class="contact-memory-editor-error" role="alert">${escapeHtml(editor.error)}</p>` : ""}
            <div class="contact-memory-editor-actions">
              <button class="secondary" type="button" data-memory-action="cancel" ${editor.saving ? "disabled" : ""}>取消</button>
              <button class="primary" type="button" data-memory-action="save" ${editor.saving ? "disabled" : ""}>${editor.saving ? "保存中" : "保存"}</button>
            </div>
          </div>
        </li>
      `;
    }
    return `
      <li class="contact-memory-entry">
        <span class="contact-memory-index" aria-hidden="true">${index + 1}</span>
        <p>${escapeHtml(entry)}</p>
        <button class="contact-memory-edit" type="button" data-memory-edit-index="${index}" title="编辑这条记忆" aria-label="编辑第 ${index + 1} 条记忆">
          ${window.miaMarkdown.iconParkIcon("edit", "contact-memory-edit-icon")}
        </button>
      </li>
    `;
  }

  function renderBotMemoryPanel(bot = {}) {
    const key = botKey(bot);
    const data = panelData(bot);
    const loading = memoryLoadingKeys().has(key);
    const isOpen = openPanelKeys().has(key);
    let body = "";
    if (data?.mode === "native") {
      body = '<p class="contact-memory-state">Mia 记忆已关闭；已有记录会保留，重新开启后可查看和编辑。</p>';
    } else if (!data && loading) {
      body = '<p class="contact-memory-state">正在读取这位伙伴的记忆…</p>';
    } else if (data?.error && !data.entries?.length) {
      body = `<p class="contact-memory-state error">${escapeHtml(data.error)}</p>`;
    } else if (!data?.entries?.length) {
      body = '<p class="contact-memory-state">这位伙伴还没有长期记忆。</p>';
    } else {
      body = `
        ${data.error ? `<p class="contact-memory-state error">${escapeHtml(data.error)}</p>` : ""}
        <ol class="contact-memory-list">
          ${data.entries.map((entry, index) => renderMemoryEntry(bot, entry, index)).join("")}
        </ol>
      `;
    }
    return `
      <details class="contact-memory accordion-details" data-memory-panel-key="${escapeHtml(key)}"${isOpen ? " open" : ""}>
        <summary>
          <div>
            <strong>🧠 记忆</strong>
            <p>${escapeHtml(memorySummary(data, loading))}</p>
          </div>
          <span class="runtime-target-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="accordion-body">${body}</div>
      </details>
    `;
  }

  function editEntry(bot, index) {
    const data = panelData(bot);
    const entry = data?.entries?.[index];
    if (typeof entry !== "string") return;
    state.botMemoryEditor = {
      botKey: botKey(bot),
      entryIndex: index,
      oldText: entry,
      draft: entry,
      saving: false,
      error: ""
    };
    openPanelKeys().add(botKey(bot));
    renderContacts?.();
  }

  async function saveEntry(bot) {
    const editor = currentEditor();
    const key = botKey(bot);
    if (editor.botKey !== key || editor.entryIndex < 0 || editor.saving) return;
    const content = String(editor.draft || "").trim();
    if (!content) {
      editor.error = "记忆内容不能为空";
      renderContacts?.();
      return;
    }
    if (content === editor.oldText) {
      clearEditor();
      renderContacts?.();
      return;
    }
    const api = window.mia?.social?.replaceBotMemoryEntry;
    if (typeof api !== "function") {
      editor.error = "记忆编辑功能暂不可用";
      renderContacts?.();
      return;
    }
    editor.saving = true;
    editor.error = "";
    renderContacts?.();
    try {
      const result = await api(botId(bot), { oldText: editor.oldText, content });
      if (result?.ok === false) throw new Error(result.error || "保存失败");
      memoryEntriesCache().set(key, normalizeMemoryResponse(result));
      clearEditor();
    } catch {
      const active = currentEditor();
      if (active.botKey === key) {
        active.saving = false;
        active.error = "保存失败，记忆可能已更新，请重新打开后再试。";
      }
    } finally {
      const active = currentEditor();
      if (active.botKey === key) active.saving = false;
      renderContacts?.();
    }
  }

  function wireBotMemoryPanel(bot, root) {
    if (!root || !state) return;
    const panel = root.querySelector(".contact-memory");
    panel?.addEventListener("toggle", () => {
      const key = botKey(bot);
      if (panel.open) {
        openPanelKeys().add(key);
        loadBotMemory(bot, { force: true });
      } else {
        openPanelKeys().delete(key);
      }
    });
    root.querySelectorAll("[data-memory-edit-index]").forEach((button) => {
      button.addEventListener("click", () => editEntry(bot, Number(button.dataset.memoryEditIndex)));
    });
    root.querySelector("[data-memory-edit-draft]")?.addEventListener("input", (event) => {
      const editor = currentEditor();
      if (editor.botKey === botKey(bot)) editor.draft = event.target.value;
    });
    root.querySelector('[data-memory-action="cancel"]')?.addEventListener("click", () => {
      clearEditor();
      renderContacts?.();
    });
    root.querySelector('[data-memory-action="save"]')?.addEventListener("click", () => saveEntry(bot));
  }

  window.miaBotMemoryPanel = {
    initBotMemoryPanel,
    renderBotMemoryPanel,
    wireBotMemoryPanel,
    loadBotMemory
  };
})();
