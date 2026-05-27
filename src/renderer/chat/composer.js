// Chat composer module — slash menu, add menu, attachments, skill picker
// Extracted from app.js. Covers everything that happens in the chat
// composer below the message list: slash command suggestions, the "+" add
// menu (attachments / skills), pending attachment chips, and the modal
// skill picker (with plugin sidebar + search).
//
// The submit handler itself stays in app.js because it touches session
// persist + cloud push (the high-coupling chat send pipeline).
//
// Defensive `if (!state || !els)` guards on every entry.
(function () {
  "use strict";

  let state, els, mia;
  let fallbackSlashCommands;
  let loadSkills, renderAttachmentThumb, renderSendButton, resizeChatInput;
  let appendTransientChat, cryptoRandomId, activeSession;

  // Module-local hover-close timer for the skill picker.
  let skillPickerHoverCloseTimer = 0;

  function initComposer(deps) {
    state = deps.state;
    els = deps.els;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
    fallbackSlashCommands = deps.fallbackSlashCommands || [];
    loadSkills = deps.loadSkills;
    renderAttachmentThumb = deps.renderAttachmentThumb;
    renderSendButton = deps.renderSendButton;
    resizeChatInput = deps.resizeChatInput;
    appendTransientChat = deps.appendTransientChat;
    cryptoRandomId = deps.cryptoRandomId;
    activeSession = deps.activeSession;
  }

  function filteredSlashCommands() {
    if (!state) return [];
    const filter = state.slashFilter.replace(/^\//, "").trim().toLowerCase();
    const engine = window.miaEngineOptions.activeAgentEngine();
    const commands = engine === "claude-code" || engine === "codex"
      ? (state.agentSlashCommands[engine] || [])
      : (state.slashCommands || fallbackSlashCommands);
    if (!filter) return commands;
    return commands.filter((item) => `${item.command} ${item.description}`.toLowerCase().includes(filter));
  }

  function externalSlashInvocation(text) {
    if (!state) return null;
    const input = String(text || "").trim();
    const command = input.split(/\s+/)[0]?.toLowerCase() || "";
    if (!command.startsWith("/")) return null;
    const argsText = input.slice(command.length).trim();
    const args = argsText ? argsText.split(/\s+/).filter(Boolean) : [];
    const engine = window.miaEngineOptions.activeAgentEngine();
    if (engine !== "claude-code" && engine !== "codex") return null;
    const found = (state.agentSlashCommands[engine] || []).find((item) => String(item.command || "").toLowerCase() === command);
    return found ? { engine, command, args, item: found } : null;
  }

  async function outgoingMessageForSubmit(text) {
    const invocation = externalSlashInvocation(text);
    if (!invocation || invocation.item.type !== "custom") return text;
    const result = await window.mia.executeAgentCommand?.({
      engine: invocation.engine,
      commandName: invocation.command,
      commandPath: invocation.item.path,
      args: invocation.args,
      context: { sessionId: activeSession()?.id || "" }
    });
    if (result?.type !== "custom" || !String(result.content || "").trim()) return text;
    return String(result.content || "").trim();
  }

  function updateSlashCommandState() {
    if (!state || !els) return;
    const value = els.chatInput.value;
    const cursor = els.chatInput.selectionStart || 0;
    const before = value.slice(0, cursor);
    const line = before.split(/\n/).pop() || "";
    const shouldOpen = /^\/[A-Za-z0-9_:/.-]*$/.test(line);
    state.slashMenuOpen = shouldOpen;
    state.slashFilter = shouldOpen ? line : "";
    if (shouldOpen && state.slashFilter.length <= 1) state.slashSelectedIndex = 0;
    const commands = filteredSlashCommands();
    if (state.slashSelectedIndex >= commands.length) state.slashSelectedIndex = Math.max(0, commands.length - 1);
    renderSlashCommandMenu();
  }

  function renderSlashCommandMenu() {
    if (!state || !els || !els.slashCommandMenu) return;
    const commands = filteredSlashCommands();
    els.slashCommandMenu.classList.toggle("hidden", !state.slashMenuOpen);
    if (!state.slashMenuOpen) {
      els.slashCommandMenu.innerHTML = "";
      return;
    }
    if (!commands.length) {
      els.slashCommandMenu.innerHTML = `<div class="slash-command-empty">没有匹配的命令</div>`;
      return;
    }
    els.slashCommandMenu.innerHTML = commands.map((item, index) => `
      <button type="button" class="slash-command-item${index === state.slashSelectedIndex ? " active" : ""}" data-command="${window.miaMarkdown.escapeHtml(item.command)}">
        <span class="slash-command-token">${window.miaMarkdown.escapeHtml(item.command)}</span>
        <span class="slash-command-description">${window.miaMarkdown.escapeHtml(item.description)}</span>
      </button>
    `).join("");
    els.slashCommandMenu.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const command = commands.find((item) => item.command === button.dataset.command);
        if (command) sendSlashCommand(command);
      });
    });
  }

  function renderComposerAddMenu() {
    if (!state || !els) return;
    els.composerAddMenu?.classList.toggle("hidden", !state.composerAddMenuOpen);
    els.composerAdd?.classList.toggle("active", state.composerAddMenuOpen);
    if (!els.composerAddMenu) return;
    els.composerAddMenu.innerHTML = `
      <button type="button" data-composer-add="attachment">添加附件</button>
      <button type="button" data-composer-add="skill">插件 / 技能</button>
    `;
  }

  function renderComposerAttachments() {
    if (!state || !els || !els.composerAttachments) return;
    const attachments = state.pendingAttachments;
    els.composerAttachments.classList.toggle("hidden", attachments.length === 0);
    els.composerAttachments.innerHTML = attachments.map((attachment) => `
      <div class="composer-attachment${attachment.thumbnailDataUrl ? " image" : ""}" title="${window.miaMarkdown.escapeHtml(attachment.path || attachment.name)}">
        <span class="composer-attachment-kind">${renderAttachmentThumb(attachment, "composer-attachment-thumb")}</span>
        <span class="composer-attachment-name">${window.miaMarkdown.escapeHtml(attachment.name || "附件")}</span>
        <span class="composer-attachment-size">${window.miaMarkdown.escapeHtml(window.miaFormat.formatBytes(attachment.size))}</span>
        <button type="button" data-attachment-remove="${window.miaMarkdown.escapeHtml(attachment.id)}" title="移除附件" aria-label="移除附件">×</button>
      </div>
    `).join("");
    els.composerAttachments.querySelectorAll("[data-attachment-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== button.dataset.attachmentRemove);
        renderComposerAttachments();
        renderSendButton();
        els.chatInput?.focus();
      });
    });
  }

  // Composer skill chips: skills temporarily attached to the next message(s)
  // via 「使用」 on the skills page. Removable; cleared by the user.
  function renderComposerSkills() {
    if (!state || !els || !els.composerSkills) return;
    // Chips belong to the conversation they were attached in. If the active
    // room changed (switched fellow), drop them — a new conversation starts
    // empty. Self-heals on every render, so switching anywhere clears them.
    const activeRoomId = window.miaSocial?.getActiveRoomId?.() || "";
    if ((state.composerActiveSkills || []).length && state.composerSkillsRoomId !== activeRoomId) {
      state.composerActiveSkills = [];
      state.composerSkillSelected = false;
    }
    const skills = state.composerActiveSkills || [];
    els.composerSkills.classList.toggle("hidden", skills.length === 0);
    // Last chip is the Backspace target; "selected" highlights it before delete.
    els.composerSkills.innerHTML = skills.map((skill, index) => {
      const selected = state.composerSkillSelected && index === skills.length - 1;
      return `<span class="composer-skill${selected ? " selected" : ""}" title="${window.miaMarkdown.escapeHtml(skill.name || skill.id)}">${window.miaMarkdown.escapeHtml(skill.name || skill.id)}</span>`;
    }).join("");
  }

  function addComposerSkill(skill) {
    if (!state || !skill || !skill.id) return;
    // Bind the chips to the room that is active now (the caller navigated here
    // first), so renderComposerSkills clears them once the user switches away.
    state.composerSkillsRoomId = window.miaSocial?.getActiveRoomId?.() || "";
    state.composerActiveSkills = state.composerActiveSkills || [];
    if (!state.composerActiveSkills.some((item) => item.id === skill.id)) {
      state.composerActiveSkills = [...state.composerActiveSkills, { id: String(skill.id), name: skill.name || skill.id }];
    }
    state.composerSkillSelected = false;
    renderComposerSkills();
    els.chatInput?.focus();
  }

  // Backspace at the very start of an empty selection: first press selects the
  // last chip, second press deletes it. Any other key clears the selection.
  function handleComposerSkillBackspace(event) {
    if (!state || !els?.chatInput) return;
    const skills = state.composerActiveSkills || [];
    if (event.key === "Backspace" && els.chatInput.selectionStart === 0 && els.chatInput.selectionEnd === 0 && skills.length) {
      event.preventDefault();
      if (state.composerSkillSelected) {
        state.composerActiveSkills = skills.slice(0, -1);
        state.composerSkillSelected = false;
      } else {
        state.composerSkillSelected = true;
      }
      renderComposerSkills();
      return true;
    }
    if (state.composerSkillSelected && event.key !== "Backspace") {
      state.composerSkillSelected = false;
      renderComposerSkills();
    }
    return false;
  }

  function closeComposerAddMenu() {
    if (!state || !state.composerAddMenuOpen) return;
    state.composerAddMenuOpen = false;
    renderComposerAddMenu();
  }

  function composerSkillMenuItem() {
    return els?.composerAddMenu?.querySelector('[data-composer-add="skill"]') || null;
  }

  function targetIsSkillPickerZone(target) {
    if (!(target instanceof Node)) return false;
    return Boolean(els?.skillPicker?.contains(target) || composerSkillMenuItem()?.contains(target));
  }

  function cancelSkillPickerHoverClose() {
    if (!skillPickerHoverCloseTimer) return;
    clearTimeout(skillPickerHoverCloseTimer);
    skillPickerHoverCloseTimer = 0;
  }

  function scheduleSkillPickerHoverClose() {
    cancelSkillPickerHoverClose();
    skillPickerHoverCloseTimer = window.setTimeout(() => {
      skillPickerHoverCloseTimer = 0;
      closeSkillPicker();
    }, 120);
  }

  function openSkillPicker() {
    if (!state || !els) return;
    cancelSkillPickerHoverClose();
    if (!state.skillLibrary.skills?.length && !state.skillsLoading) {
      loadSkills();
    }
    state.skillPickerOpen = true;
    state.skillPickerFilter = "";
    const firstPlugin = (state.skillLibrary.plugins || []).find((plugin) => plugin.skillCount > 0);
    if (!state.skillPickerPluginId && firstPlugin) state.skillPickerPluginId = firstPlugin.id;
    if (els.skillPickerSearch) els.skillPickerSearch.value = "";
    renderSkillPicker();
    setTimeout(() => els.skillPickerSearch?.focus(), 0);
  }

  function closeSkillPicker() {
    cancelSkillPickerHoverClose();
    if (!state || !state.skillPickerOpen) return;
    state.skillPickerOpen = false;
    renderSkillPicker();
  }

  function renderSkillPicker() {
    if (!state || !els || !els.skillPicker) return;
    els.skillPicker.classList.toggle("hidden", !state.skillPickerOpen);
    if (!state.skillPickerOpen || !els.skillPickerBody) return;
    const needle = String(state.skillPickerFilter || "").trim().toLowerCase();
    const skills = state.skillLibrary.skills || [];
    const plugins = (state.skillLibrary.plugins || []).filter((plugin) => plugin.skillCount > 0);
    if (!state.skillPickerPluginId && plugins.length) state.skillPickerPluginId = plugins[0].id;
    if (state.skillPickerPluginId && plugins.length && !plugins.some((plugin) => plugin.id === state.skillPickerPluginId)) {
      state.skillPickerPluginId = plugins[0].id;
    }
    const filtered = needle
      ? skills.filter((skill) => {
          const hay = [
            skill.name,
            skill.title,
            skill.description,
            skill.pluginLabel,
            skill.category,
            ...(skill.tags || [])
          ].join(" ").toLowerCase();
          return hay.includes(needle);
        })
      : skills.filter((skill) => !state.skillPickerPluginId || skill.pluginId === state.skillPickerPluginId);
    if (!filtered.length && !plugins.length) {
      els.skillPickerBody.innerHTML = `<div class="skill-picker-empty">${state.skillsLoading ? "正在加载…" : "没有匹配的 Skill"}</div>`;
      return;
    }
    const pluginCounts = skills.reduce((acc, skill) => {
      const pluginId = skill.pluginId || "_other";
      acc[pluginId] = (acc[pluginId] || 0) + 1;
      return acc;
    }, {});
    const currentPlugin = plugins.find((plugin) => plugin.id === state.skillPickerPluginId);
    els.skillPickerBody.innerHTML = `
      <aside class="skill-picker-plugins">
        ${plugins.map((plugin) => `
          <button class="${plugin.id === state.skillPickerPluginId ? "active" : ""}" type="button" data-skill-picker-plugin="${window.miaMarkdown.escapeHtml(plugin.id)}">
            <span>${window.miaMarkdown.escapeHtml(plugin.label || plugin.name)}</span>
            <em>${pluginCounts[plugin.id] || plugin.skillCount || 0}</em>
          </button>
        `).join("")}
      </aside>
      <section class="skill-picker-skills">
        <header>
          <span>${window.miaMarkdown.escapeHtml(needle ? "搜索结果" : (currentPlugin?.label || "Skills"))}</span>
          <em>${filtered.length}</em>
        </header>
        <div class="skill-picker-list">
          ${filtered.length ? filtered.map((skill) => `
            <button class="skill-picker-item" type="button" data-skill-pick="${window.miaMarkdown.escapeHtml(skill.name)}">
              <strong>${window.miaMarkdown.escapeHtml(skill.name)}</strong>
              <small>${window.miaMarkdown.escapeHtml((skill.description || window.miaSkillHelpers.skillSummaryZh(skill) || "").slice(0, 108))}</small>
            </button>
          `).join("") : `<div class="skill-picker-empty">${state.skillsLoading ? "正在加载…" : "没有匹配的 Skill"}</div>`}
        </div>
      </section>
    `;
  }

  function insertSkillIntoComposer(name) {
    if (!els || !els.chatInput) return;
    const trigger = `/${name} `;
    const current = els.chatInput.value || "";
    els.chatInput.value = current.trim().startsWith("/")
      ? current.replace(/^\s*\/[A-Za-z0-9_:/.-]+(?:\s+)?/, trigger)
      : `${trigger}${current}`;
    els.chatInput.focus();
    resizeChatInput();
    renderSendButton();
  }

  async function addComposerFiles(fileList) {
    if (!state || !els) return;
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    const existing = new Set(state.pendingAttachments.map((item) => item.path || `${item.name}:${item.size}`));
    const next = [];
    for (const file of files.slice(0, 20)) {
      let filePath = "";
      let saved = null;
      let thumbnailDataUrl = "";
      try {
        thumbnailDataUrl = await thumbnailDataUrlForFile(file);
        filePath = await window.mia.filePathForFile?.(file);
        if (!filePath) {
          saved = await saveBrowserFileAttachment(file, thumbnailDataUrl);
          filePath = saved?.path || "";
        }
        if (!filePath && !saved) continue;
      } catch (error) {
        appendTransientChat("assistant", `附件「${file.name || "未命名"}」读取失败: ${error.message}`);
        continue;
      }
      const key = filePath || `${file.name}:${file.size}`;
      if (existing.has(key)) continue;
      existing.add(key);
      next.push({
        id: saved?.id || cryptoRandomId(),
        name: saved?.name || file.name || (filePath ? filePath.split(/[\\/]/).pop() : "附件"),
        path: filePath || "",
        mime: saved?.mime || file.type || "",
        size: saved?.size || file.size || 0,
        kind: saved?.kind || window.miaFormat.attachmentKind(file),
        thumbnailDataUrl: saved?.thumbnailDataUrl || thumbnailDataUrl || ""
      });
    }
    if (!next.length) return;
    state.pendingAttachments = [...state.pendingAttachments, ...next].slice(0, 20);
    renderComposerAttachments();
    renderSendButton();
    els.chatInput?.focus();
  }

  function thumbnailDataUrlForFile(file) {
    if (!file || !String(file.type || "").startsWith("image/")) return Promise.resolve("");
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          const max = 180;
          const scale = Math.min(1, max / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
          const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
          const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.72));
        } catch {
          resolve("");
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve("");
      };
      image.src = url;
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")));
      reader.addEventListener("error", () => reject(reader.error || new Error("读取附件失败")));
      reader.readAsDataURL(file);
    });
  }

  async function saveBrowserFileAttachment(file, thumbnailDataUrl = "") {
    if (!file) return null;
    if (file.size > 25 * 1024 * 1024) {
      appendTransientChat("assistant", `附件「${file.name || "未命名"}」超过 25MB，暂时不能发送。`);
      return null;
    }
    const dataUrl = await readFileAsDataUrl(file);
    return window.mia.saveAttachment?.({
      name: file.name || "attachment",
      mime: file.type || "",
      size: file.size || 0,
      dataUrl,
      thumbnailDataUrl
    });
  }

  function commandTextForSend(command) {
    return String(command.command || "").trim();
  }

  async function sendSlashCommand(command) {
    if (!state || !els) return;
    const text = commandTextForSend(command);
    if (!text) return;
    els.chatInput.value = text;
    resizeChatInput();
    state.slashMenuOpen = false;
    state.slashFilter = "";
    renderSlashCommandMenu();
    els.chatForm.requestSubmit();
  }

  function fillSlashCommand(command) {
    if (!state || !els) return;
    const value = els.chatInput.value;
    const cursor = els.chatInput.selectionStart || 0;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const lineStart = before.lastIndexOf("\n") + 1;
    els.chatInput.value = `${value.slice(0, lineStart)}${command.command} ${after}`;
    const next = lineStart + command.command.length + 1;
    els.chatInput.setSelectionRange(next, next);
    resizeChatInput();
    state.slashMenuOpen = false;
    renderSlashCommandMenu();
    els.chatInput.focus();
  }

  window.miaComposer = {
    initComposer,
    filteredSlashCommands,
    externalSlashInvocation,
    outgoingMessageForSubmit,
    updateSlashCommandState,
    renderSlashCommandMenu,
    renderComposerAddMenu,
    renderComposerAttachments,
    renderComposerSkills,
    addComposerSkill,
    handleComposerSkillBackspace,
    closeComposerAddMenu,
    composerSkillMenuItem,
    targetIsSkillPickerZone,
    cancelSkillPickerHoverClose,
    scheduleSkillPickerHoverClose,
    openSkillPicker,
    closeSkillPicker,
    renderSkillPicker,
    insertSkillIntoComposer,
    addComposerFiles,
    thumbnailDataUrlForFile,
    readFileAsDataUrl,
    saveBrowserFileAttachment,
    commandTextForSend,
    sendSlashCommand,
    fillSlashCommand,
  };
})();
