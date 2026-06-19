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

  const { MemberKind } = (typeof window !== "undefined" && window.miaConversationKinds) || require("../../shared/conversation-kinds.js");

  let state, els, mia;
  let fallbackSlashCommands;
  let loadSkills, renderAttachmentThumb, renderSendButton, resizeChatInput, openImagePreview;
  let appendTransientChat, cryptoRandomId;

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
    openImagePreview = deps.openImagePreview;
    appendTransientChat = deps.appendTransientChat;
    cryptoRandomId = deps.cryptoRandomId;
    installComposerInputAdapter();
  }

  function isRichComposerInput(input = els?.chatInput) {
    return Boolean(input && typeof input.getAttribute === "function" && input.getAttribute("contenteditable") === "true");
  }

  function editorContainsNode(editor, node) {
    if (!editor || !node) return false;
    return node === editor || editor.contains?.(node.nodeType === 3 ? node.parentNode : node);
  }

  function serializeComposerNode(node) {
    if (!node) return "";
    if (node.nodeType === 3) return String(node.nodeValue || "").replace(/\u00a0/g, " ");
    if (node.nodeType !== 1 && node.nodeType !== 11) return "";
    if (node.nodeType === 1) {
      const element = node;
      if (element.dataset?.pathRefToken) return String(element.dataset.pathRefToken || "");
      if (element.tagName === "BR") return "\n";
    }
    return Array.from(node.childNodes || []).map(serializeComposerNode).join("");
  }

  function composerInputPlainText(input = els?.chatInput) {
    if (!input) return "";
    if (isRichComposerInput(input)) return serializeComposerNode(input);
    return String(input.value || "");
  }

  function textFragmentForEditor(text) {
    if (typeof document === "undefined") return null;
    const fragment = document.createDocumentFragment();
    const parts = String(text || "").split("\n");
    parts.forEach((part, index) => {
      if (index > 0) fragment.appendChild(document.createElement("br"));
      if (part) fragment.appendChild(document.createTextNode(part));
    });
    return fragment;
  }

  function setRichComposerText(input, value) {
    input.innerHTML = "";
    const fragment = textFragmentForEditor(value);
    if (fragment) input.appendChild(fragment);
  }

  function selectionOffsetForPoint(input, container, offset) {
    if (!isRichComposerInput(input) || typeof document === "undefined" || !editorContainsNode(input, container)) {
      return composerInputPlainText(input).length;
    }
    try {
      const range = document.createRange();
      range.setStart(input, 0);
      range.setEnd(container, offset);
      return serializeComposerNode(range.cloneContents()).length;
    } catch {
      return composerInputPlainText(input).length;
    }
  }

  function richComposerSelectionOffset(input, edge = "start") {
    if (!isRichComposerInput(input) || typeof window === "undefined") return 0;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount) return composerInputPlainText(input).length;
    const range = selection.getRangeAt(0);
    const container = edge === "end" ? range.endContainer : range.startContainer;
    const offset = edge === "end" ? range.endOffset : range.startOffset;
    return selectionOffsetForPoint(input, container, offset);
  }

  function offsetPointInEditor(input, targetOffset) {
    const target = Math.max(0, Number(targetOffset) || 0);
    let cursor = 0;
    const childIndex = (node) => Array.prototype.indexOf.call(node.parentNode?.childNodes || [], node);

    function pointBefore(node) {
      return { node: node.parentNode || input, offset: Math.max(0, childIndex(node)) };
    }

    function pointAfter(node) {
      return { node: node.parentNode || input, offset: Math.max(0, childIndex(node) + 1) };
    }

    function walk(node) {
      if (node.nodeType === 3) {
        const text = String(node.nodeValue || "");
        if (target <= cursor + text.length) return { node, offset: Math.max(0, target - cursor) };
        cursor += text.length;
        return null;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return null;
      if (node.nodeType === 1) {
        const element = node;
        const token = element.dataset?.pathRefToken || "";
        if (token) {
          if (target <= cursor) return pointBefore(element);
          if (target < cursor + token.length) return pointAfter(element);
          cursor += token.length;
          return null;
        }
        if (element.tagName === "BR") {
          if (target <= cursor) return pointBefore(element);
          if (target <= cursor + 1) return pointAfter(element);
          cursor += 1;
          return null;
        }
      }
      for (const child of Array.from(node.childNodes || [])) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    }

    return walk(input) || { node: input, offset: input.childNodes.length };
  }

  function setRichComposerSelectionRange(input, start, end = start) {
    if (!isRichComposerInput(input) || typeof document === "undefined" || typeof window === "undefined") return;
    const range = document.createRange();
    const startPoint = offsetPointInEditor(input, start);
    const endPoint = offsetPointInEditor(input, end);
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    const selection = window.getSelection?.();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function currentRichComposerRange(input) {
    if (!isRichComposerInput(input) || typeof document === "undefined" || typeof window === "undefined") return null;
    const selection = window.getSelection?.();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      if (editorContainsNode(input, range.commonAncestorContainer)) return range;
    }
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range;
  }

  function insertRichComposerFragment(input, fragment, caretNode = null) {
    const range = currentRichComposerRange(input);
    if (!range || !fragment) return false;
    range.deleteContents();
    range.insertNode(fragment);
    if (caretNode && typeof window !== "undefined") {
      const nextRange = document.createRange();
      if (caretNode.nodeType === 3) nextRange.setStart(caretNode, caretNode.nodeValue.length);
      else nextRange.setStartAfter(caretNode);
      nextRange.collapse(true);
      const selection = window.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(nextRange);
    }
    return true;
  }

  function insertRichComposerText(input, text) {
    const fragment = textFragmentForEditor(text);
    if (!fragment) return false;
    const lastNode = fragment.lastChild;
    return insertRichComposerFragment(input, fragment, lastNode);
  }

  function installComposerInputAdapter() {
    const input = els?.chatInput;
    if (!isRichComposerInput(input) || input.dataset.miaComposerAdapter === "1") return;
    input.dataset.miaComposerAdapter = "1";
    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return composerInputPlainText(input);
      },
      set(value) {
        setRichComposerText(input, value);
      }
    });
    Object.defineProperty(input, "selectionStart", {
      configurable: true,
      get() {
        return richComposerSelectionOffset(input, "start");
      }
    });
    Object.defineProperty(input, "selectionEnd", {
      configurable: true,
      get() {
        return richComposerSelectionOffset(input, "end");
      }
    });
    input.setSelectionRange = (start, end = start) => setRichComposerSelectionRange(input, start, end);
    input.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-remove-path-ref]");
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        removePathPasteRef(button.dataset.removePathRef || "");
        return;
      }
      const chip = event.target?.closest?.("[data-path-ref-token]");
      if (!chip || !input.contains(chip)) return;
      event.preventDefault();
      event.stopPropagation();
      openPathPasteRefPreview(chip.dataset.pathRefToken || "");
    });
  }

  function filteredSlashCommands() {
    if (!state) return [];
    const filter = state.slashFilter.replace(/^\//, "").trim().toLowerCase();
    const engine = window.miaEngineOptions.activeAgentEngine();
    const commands = window.miaEngineOptions.isExternalAgentEngine(engine)
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
    if (!window.miaEngineOptions.isExternalAgentEngine(engine)) return null;
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
      context: { sessionId: window.miaSocial?.getActiveConversationId?.() || "" }
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
      <button type="button" class="slash-command-item${index === state.slashSelectedIndex ? " active" : ""}" data-command="${window.miaMarkdown.escapeHtml(item.command)}" data-slash-index="${index}">
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
      // Hover follows keyboard so we never paint two highlighted rows.
      button.addEventListener("mousemove", () => {
        const idx = Number(button.dataset.slashIndex || 0);
        if (idx === state.slashSelectedIndex) return;
        state.slashSelectedIndex = idx;
        renderSlashCommandMenu();
      });
    });
  }

  function renderComposerAddMenu() {
    if (!state || !els) return;
    els.composerAddMenu?.classList.toggle("hidden", !state.composerAddMenuOpen);
    els.composerAdd?.classList.toggle("active", state.composerAddMenuOpen);
    const addLottie = els.composerAdd?.querySelector("[data-lottie]");
    if (addLottie) window.miaLottieIcons?.setOpen(addLottie, state.composerAddMenuOpen);
    if (!els.composerAddMenu) return;
    els.composerAddMenu.innerHTML = `
      <button type="button" data-composer-add="attachment">添加附件</button>
      <button type="button" data-composer-add="skill">插件 / 技能</button>
    `;
  }

  function renderComposerAttachments() {
    if (!state || !els || !els.composerAttachments) return;
    const attachments = state.pendingAttachments;
    const composerCard = typeof els.composerAttachments.closest === "function"
      ? els.composerAttachments.closest(".composer-card")
      : null;
    composerCard?.classList?.toggle("has-attachments", attachments.length > 0);
    els.chatForm?.classList?.toggle("has-attachments", attachments.length > 0);
    els.composerAttachments.classList.toggle("hidden", attachments.length === 0);
    els.composerAttachments.innerHTML = attachments.map((attachment) => {
      const kind = attachment.kind || window.miaFormat.attachmentKind(attachment);
      const image = kind === "image" && (attachment.dataUrl || attachment.thumbnailDataUrl || attachment.previewDataUrl);
      return `
      <div class="composer-attachment${image ? " image" : ""}" title="${window.miaMarkdown.escapeHtml(attachment.path || attachment.name || "附件")}">
        <button class="composer-attachment-preview" type="button" data-attachment-preview="${window.miaMarkdown.escapeHtml(attachment.id)}" aria-label="预览附件">
          ${renderAttachmentThumb(attachment, "composer-attachment-thumb")}
        </button>
        <button class="composer-attachment-remove" type="button" data-attachment-remove="${window.miaMarkdown.escapeHtml(attachment.id)}" title="移除附件" aria-label="移除附件">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6.75 6.75L17.25 17.25M17.25 6.75L6.75 17.25" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    `;
    }).join("");
    els.composerAttachments.querySelectorAll("[data-attachment-preview]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const attachment = state.pendingAttachments.find((item) => item.id === button.dataset.attachmentPreview);
        const src = String(attachment?.dataUrl || attachment?.previewDataUrl || attachment?.thumbnailDataUrl || "").trim();
        if (!attachment || !src.startsWith("data:image/") || typeof openImagePreview !== "function") {
          els.chatInput?.focus();
          return;
        }
        openImagePreview(src, attachment.name || "图片预览", {
          onSave: (result = {}) => {
            updateComposerAttachmentImage(attachment.id, result.dataUrl || "");
          }
        });
      });
    });
    els.composerAttachments.querySelectorAll("[data-attachment-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== button.dataset.attachmentRemove);
        renderComposerAttachments();
        renderSendButton();
        els.chatInput?.focus();
      });
    });
  }

  function updateComposerAttachmentImage(id, dataUrl) {
    const nextDataUrl = String(dataUrl || "").trim();
    if (!id || !nextDataUrl.startsWith("data:image/")) return;
    state.pendingAttachments = state.pendingAttachments.map((attachment) => {
      if (attachment.id !== id) return attachment;
      return {
        ...attachment,
        mime: nextDataUrl.match(/^data:([^;,]+)/)?.[1] || attachment.mime || "image/png",
        size: dataUrlByteSize(nextDataUrl) || attachment.size || 0,
        kind: "image",
        dataUrl: nextDataUrl,
        thumbnailDataUrl: nextDataUrl
      };
    });
    renderComposerAttachments();
    renderSendButton();
    els.chatInput?.focus();
  }

  function dataUrlByteSize(value) {
    const match = String(value || "").match(/^data:[^,]+,([\s\S]*)$/);
    if (!match) return 0;
    const payload = match[1].replace(/\s+/g, "");
    return Math.max(0, Math.floor(payload.length * 3 / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0));
  }

  // Composer skill chips: skills temporarily attached to the next message(s)
  // via 「使用」 on the skills page. Removable; cleared by the user.
  function renderComposerSkills() {
    if (!state || !els || !els.composerSkills) return;
    // Chips belong to the conversation they were attached in. If the active
    // conversation changed (switched bot), drop them — a new conversation starts
    // empty. Self-heals on every render, so switching anywhere clears them.
    const activeConversationId = window.miaSocial?.getActiveConversationId?.() || "";
    if ((state.composerActiveSkills || []).length && state.composerSkillsConversationId !== activeConversationId) {
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
    // Bind the chips to the conversation that is active now (the caller navigated here
    // first), so renderComposerSkills clears them once the user switches away.
    state.composerSkillsConversationId = window.miaSocial?.getActiveConversationId?.() || "";
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
    const filtered = needle
      ? skills.filter((skill) => {
          const hay = [
            skill.name,
            skill.title,
            skill.description,
            window.miaSkillHelpers.skillDisplayName(skill),
            window.miaSkillHelpers.skillSummaryZh(skill),
            skill.pluginLabel,
            window.miaSkillHelpers.skillDisplayCategory(skill),
            ...(skill.tags || [])
          ].join(" ").toLowerCase();
          return hay.includes(needle);
        })
      : skills;
    if (!filtered.length && !skills.length) {
      els.skillPickerBody.innerHTML = `<div class="skill-picker-empty">${state.skillsLoading ? "正在加载…" : "没有匹配的 Skill"}</div>`;
      return;
    }
    els.skillPickerBody.innerHTML = `
      <section class="skill-picker-skills">
        <div class="skill-picker-list">
          ${filtered.length ? filtered.map((skill) => `
            <button class="skill-picker-item" type="button" data-skill-pick="${window.miaMarkdown.escapeHtml(skill.name)}">
              <strong>${window.miaMarkdown.escapeHtml(window.miaSkillHelpers.skillDisplayName(skill))}</strong>
              <small>${window.miaMarkdown.escapeHtml((window.miaSkillHelpers.skillSummaryZh(skill) || skill.description || "").slice(0, 108))}</small>
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

  function isMacPathPastePlatform(platform) {
    return /mac|iphone|ipad|ipod/i.test(String(platform || ""));
  }

  function currentPathPastePlatform() {
    if (typeof navigator === "undefined") return "";
    return navigator.userAgentData?.platform || navigator.platform || "";
  }

  function isPathPasteShortcut(event, platform = currentPathPastePlatform()) {
    if (!event || event.isComposing || event.repeat) return false;
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "").toLowerCase();
    if (key !== "v" && code !== "keyv") return false;
    if (isMacPathPastePlatform(platform)) {
      return Boolean(event.ctrlKey && !event.metaKey && !event.altKey);
    }
    return Boolean(event.altKey && !event.ctrlKey && !event.metaKey);
  }

  function stripWrappingQuotes(value) {
    const text = String(value || "").trim();
    if (text.length < 2) return text;
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return text.slice(1, -1).trim();
    }
    return text;
  }

  function normalizeFileUrlPath(value) {
    const text = String(value || "").trim();
    if (!/^file:/i.test(text)) return text;
    try {
      const url = new URL(text);
      let pathname = decodeURIComponent(url.pathname || "");
      if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
      return pathname || text;
    } catch {
      return text.replace(/^file:\/\//i, "");
    }
  }

  function normalizePathPasteLine(line) {
    return normalizeFileUrlPath(stripWrappingQuotes(line));
  }

  function normalizePathPasteText(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(normalizePathPasteLine)
      .filter(Boolean)
      .join("\n");
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function activeImagePathRefs() {
    return (state?.pathPasteRefs || []).filter((ref) => ref?.token && ref?.path && String(ref.kind || "") === "image");
  }

  function createPathPasteChip(ref) {
    if (typeof document === "undefined" || !ref?.token) return null;
    const chip = document.createElement("span");
    chip.className = "composer-path-ref";
    chip.contentEditable = "false";
    chip.dataset.pathRefToken = ref.token;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-label", `预览 ${ref.token}`);
    chip.title = ref.path || ref.token;
    chip.innerHTML = `
      <span class="composer-path-ref-icon" aria-hidden="true"></span>
      <span class="composer-path-ref-label"></span>
      <button type="button" class="composer-path-ref-remove" data-remove-path-ref="" aria-label=""></button>
    `;
    const label = chip.querySelector(".composer-path-ref-label");
    const button = chip.querySelector("[data-remove-path-ref]");
    if (label) label.textContent = ref.token;
    if (button) {
      button.dataset.removePathRef = ref.token;
      button.setAttribute("aria-label", `移除 ${ref.token}`);
      button.textContent = "×";
    }
    return chip;
  }

  async function openPathPasteRefPreview(token) {
    if (!state || !token) return false;
    const ref = (state.pathPasteRefs || []).find((item) => String(item?.token || "") === String(token));
    if (!ref?.path || typeof openImagePreview !== "function") return false;
    try {
      const attachment = typeof window !== "undefined" && typeof window.mia?.fetchFileAttachment === "function"
        ? await window.mia.fetchFileAttachment({ path: ref.path })
        : null;
      if (attachment?.error) throw new Error(attachment.message || "图片读取失败");
      const src = String(attachment?.dataUrl || attachment?.previewDataUrl || attachment?.thumbnailDataUrl || "").trim();
      if (!src.startsWith("data:image/")) throw new Error("这不是可预览的图片。");
      openImagePreview(src, attachment?.name || ref.path || ref.token);
      return true;
    } catch (error) {
      appendTransientChat?.("assistant", `图片预览失败: ${error?.message || error}`);
      return false;
    }
  }

  function insertPathPasteChip(ref) {
    const input = els?.chatInput;
    if (!isRichComposerInput(input)) return insertPathPasteText(ref?.token || "");
    const chip = createPathPasteChip(ref);
    if (!chip) return false;
    input.focus?.();
    const value = composerInputPlainText(input);
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || start;
    const beforeSpace = start > 0 && value[start - 1] && !/\s/.test(value[start - 1])
      ? document.createTextNode(" ")
      : null;
    const afterSpace = document.createTextNode(" ");
    const fragment = document.createDocumentFragment();
    if (beforeSpace) fragment.appendChild(beforeSpace);
    fragment.appendChild(chip);
    fragment.appendChild(afterSpace);
    const inserted = insertRichComposerFragment(input, fragment, afterSpace);
    if (!inserted) return false;
    afterComposerTextProgrammaticChange();
    return true;
  }

  function renderPathPasteRefs() {
    // Kept as the small public repaint hook; inline chips live inside chatInput.
  }

  function removePathPasteRef(token) {
    if (!state || !token) return false;
    const before = state.pathPasteRefs || [];
    const next = before.filter((ref) => String(ref?.token || "") !== String(token));
    if (next.length === before.length) return false;
    state.pathPasteRefs = next;
    if (isRichComposerInput()) {
      els.chatInput.querySelectorAll("[data-path-ref-token]").forEach((chip) => {
        if (chip.dataset.pathRefToken === token) chip.remove();
      });
    }
    renderPathPasteRefs();
    if (typeof renderSendButton === "function") renderSendButton();
    els?.chatInput?.focus?.();
    return true;
  }

  function handlePathPasteRefBackspace(event) {
    if (!event || !els?.chatInput || window.miaMessageHelpers?.isComposerComposing?.(event)) return false;
    if (event.key !== "Backspace" && event.key !== "Delete") return false;
    if (isRichComposerInput(els.chatInput)) {
      const body = composerInputPlainText(els.chatInput);
      const start = Number(els.chatInput.selectionStart) || 0;
      const end = Number(els.chatInput.selectionEnd) || start;
      if (start !== end) return false;
      const refs = activeImagePathRefs();
      const match = refs.find((ref) => (
        event.key === "Backspace"
          ? body.slice(Math.max(0, start - ref.token.length), start) === ref.token
          : body.slice(start, start + ref.token.length) === ref.token
      ));
      if (!match) return false;
      event.preventDefault?.();
      return removePathPasteRef(match.token);
    }
    const refs = activeImagePathRefs();
    if (event.key !== "Backspace" || !refs.length) return false;
    const start = Number(els.chatInput.selectionStart) || 0;
    const end = Number(els.chatInput.selectionEnd) || start;
    if (start !== end) return false;
    const body = String(els.chatInput.value || "");
    const match = refs.find((ref) => body.slice(Math.max(0, start - ref.token.length), start) === ref.token);
    if (!match) return false;
    event.preventDefault?.();
    els.chatInput.value = `${body.slice(0, start - match.token.length)}${body.slice(start)}`;
    els.chatInput.setSelectionRange?.(start - match.token.length, start - match.token.length);
    return removePathPasteRef(match.token);
  }

  function handleComposerEditorKeydown(event) {
    if (!event || !isRichComposerInput(els?.chatInput)) return false;
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault?.();
      return insertPathPasteText("\n");
    }
    return false;
  }

  function afterComposerTextProgrammaticChange() {
    if (typeof resizeChatInput === "function") resizeChatInput();
    updateSlashCommandState();
    updateMentionMenuState();
    if (typeof renderSendButton === "function") renderSendButton();
  }

  function insertPathPasteText(text) {
    if (!els || !els.chatInput) return false;
    const insert = String(text || "");
    if (!insert) return false;
    const input = els.chatInput;
    if (isRichComposerInput(input)) {
      input.focus?.();
      const inserted = insertRichComposerText(input, insert);
      if (!inserted) return false;
      afterComposerTextProgrammaticChange();
      return true;
    }
    const current = String(input.value || "");
    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : current.length;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : start;
    input.value = `${current.slice(0, start)}${insert}${current.slice(end)}`;
    const caret = start + insert.length;
    if (typeof input.setSelectionRange === "function") input.setSelectionRange(caret, caret);
    afterComposerTextProgrammaticChange();
    if (typeof input.focus === "function") input.focus();
    return true;
  }

  function pathPasteTokenInText(token, text) {
    if (!token) return false;
    return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}([^A-Za-z0-9_]|$)`).test(String(text || ""));
  }

  function nextPathPasteToken(kind = "path") {
    if (!state) return kind === "image" ? "IMG1" : "PATH1";
    const prefix = kind === "image" ? "IMG" : "PATH";
    const used = new Set((state.pathPasteRefs || []).map((ref) => String(ref.token || "")));
    let index = Math.max(1, Number(state.pathPasteNextIndex) || 1);
    let token = `${prefix}${index}`;
    while (used.has(token)) {
      index += 1;
      token = `${prefix}${index}`;
    }
    state.pathPasteNextIndex = index + 1;
    return token;
  }

  function insertPathPasteReference(pathText, kind = "path") {
    const pathValue = normalizePathPasteText(pathText);
    if (!pathValue) return false;
    if (!state || kind !== "image") return insertPathPasteText(pathValue);
    const existing = (state.pathPasteRefs || []).find((ref) => ref.path === pathValue && ref.kind === kind);
    const token = existing?.token || nextPathPasteToken(kind);
    if (!existing) {
      state.pathPasteRefs = [
        ...(state.pathPasteRefs || []),
        { token, path: pathValue, kind }
      ];
    }
    renderPathPasteRefs();
    if (typeof renderSendButton === "function") renderSendButton();
    return insertPathPasteChip({ token, path: pathValue, kind });
  }

  function insertPathPastePayload(payload = {}) {
    const text = normalizePathPasteText(payload.text || "");
    if (!text) return false;
    if (String(payload.kind || "") === "image") return insertPathPasteReference(text, "image");
    return insertPathPasteText(text);
  }

  function expandPathPasteRefsForSend(text) {
    if (!state || !Array.isArray(state.pathPasteRefs) || !state.pathPasteRefs.length) return text;
    const body = String(text || "").trimEnd();
    const refs = state.pathPasteRefs
      .filter((ref) => ref?.token && ref?.path && pathPasteTokenInText(ref.token, body))
      .slice(0, 20);
    if (!refs.length) return body;
    const missingTokens = refs
      .filter((ref) => !pathPasteTokenInText(ref.token, body))
      .map((ref) => ref.token);
    const visible = [body, missingTokens.join(" ")].filter(Boolean).join(body ? " " : "");
    const hidden = [
      "[[MIA_PATH_REFS_BEGIN]]",
      "The user-visible tokens above refer to these local file paths:",
      ...refs.map((ref) => `${ref.token}: ${ref.path}`),
      "[[MIA_PATH_REFS_END]]"
    ].join("\n");
    return `${visible}\n\n${hidden}`;
  }

  function clearPathPasteRefs() {
    if (!state) return;
    state.pathPasteRefs = [];
    state.pathPasteNextIndex = 1;
    if (isRichComposerInput()) {
      els.chatInput.querySelectorAll("[data-path-ref-token]").forEach((chip) => chip.remove());
    }
    renderPathPasteRefs();
  }

  function reconcilePathPasteRefsFromInput() {
    if (!state || !Array.isArray(state.pathPasteRefs) || !state.pathPasteRefs.length) return false;
    const body = composerInputPlainText(els?.chatInput);
    const next = state.pathPasteRefs.filter((ref) => ref?.token && pathPasteTokenInText(ref.token, body));
    if (next.length === state.pathPasteRefs.length) return false;
    state.pathPasteRefs = next;
    renderPathPasteRefs();
    return true;
  }

  function handleComposerPlainTextPaste(event) {
    if (!event || !isRichComposerInput(els?.chatInput)) return false;
    if (event.clipboardData?.files?.length) return false;
    const text = event.clipboardData?.getData?.("text/plain") || "";
    if (!text) return false;
    event.preventDefault?.();
    return insertPathPasteText(text);
  }

  async function pasteClipboardPathText() {
    const desktopReadText = typeof mia?.readClipboardText === "function"
      ? mia.readClipboardText
      : (typeof window !== "undefined" && typeof window.mia?.readClipboardText === "function" ? window.mia.readClipboardText : null);
    const browserReadText = typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function"
      ? navigator.clipboard.readText.bind(navigator.clipboard)
      : null;
    const readText = desktopReadText || browserReadText;
    if (typeof readText !== "function") {
      appendTransientChat?.("assistant", "当前环境无法读取剪贴板。");
      return false;
    }
    let clipboardText = "";
    try {
      clipboardText = await readText();
    } catch (error) {
      appendTransientChat?.("assistant", `剪贴板路径读取失败: ${error?.message || error}`);
      return false;
    }
    return insertPathPasteText(normalizePathPasteText(clipboardText));
  }

  function handlePathPasteShortcut(event) {
    if (!isPathPasteShortcut(event)) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    pasteClipboardPathText();
    return true;
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
      let dataUrl = "";
      try {
        thumbnailDataUrl = await thumbnailDataUrlForFile(file);
        if (String(file.type || "").startsWith("image/")) {
          dataUrl = await readFileAsDataUrl(file);
          if (!thumbnailDataUrl) thumbnailDataUrl = dataUrl;
        }
        filePath = await window.mia.filePathForFile?.(file);
        if (!filePath) {
          saved = await saveBrowserFileAttachment(file, thumbnailDataUrl, dataUrl);
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
        thumbnailDataUrl: saved?.thumbnailDataUrl || thumbnailDataUrl || "",
        dataUrl: dataUrl || ""
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

  async function saveBrowserFileAttachment(file, thumbnailDataUrl = "", dataUrl = "") {
    if (!file) return null;
    if (file.size > 25 * 1024 * 1024) {
      appendTransientChat("assistant", `附件「${file.name || "未命名"}」超过 25MB，暂时不能发送。`);
      return null;
    }
    const attachmentDataUrl = dataUrl || await readFileAsDataUrl(file);
    return window.mia.saveAttachment?.({
      name: file.name || "attachment",
      mime: file.type || "",
      size: file.size || 0,
      dataUrl: attachmentDataUrl,
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

  // ── @mention picker ─────────────────────────────────────────────────────
  //
  // Telegram-style: typing "@" in a group conversation pops a floating list
  // of members; arrow keys + Enter select; Esc closes. Picking inserts
  // "@<display name> " at the current "@..." token and lets send-pipeline's
  // existing parseMentions take it from there — there is no separate
  // "queued mentions" array, the text body itself is the source of truth.
  //
  // Token detection mirrors send-pipeline.MENTION_REGEX: ASCII identifier
  // chars (alnum, _, ., -) plus CJK ranges. The picker only opens when the
  // active conversation is a group and the @ is at start-of-text or
  // immediately after whitespace, so emails ("foo@bar.com") never trigger.

  const MENTION_TOKEN_CHAR = /[A-Za-z0-9_.\-一-龥぀-ヿ]/;

  function activeConversationMembers() {
    const social = typeof window !== "undefined" ? window.miaSocial : null;
    if (!social) return [];
    const conversationId = social.getActiveConversationId?.();
    if (!conversationId) return [];
    const conversation = social.getConversationById?.(conversationId);
    if (!conversation || conversation.type !== "group") return [];
    return social.getConversationMembers?.(conversationId) || [];
  }

  function mentionDisplayName(member) {
    if (!member) return "";
    if (member.member_kind === MemberKind.Bot) {
      return String(member.bot_name || member.member_ref || "").trim();
    }
    const social = typeof window !== "undefined" ? window.miaSocial : null;
    const myUserId = social?.getActiveConversationId ? (state?.runtime?.cloud?.user?.id || "") : "";
    if (myUserId && member.member_ref === myUserId) {
      return state?.runtime?.cloud?.user?.username || "我";
    }
    const friend = social?.friendById?.(member.member_ref);
    return friend?.username || friend?.account || member.member_ref;
  }

  function mentionInsertText(member) {
    const name = mentionDisplayName(member);
    if (member.member_kind === MemberKind.Bot) {
      // Bot names (including CJK) are matched by display name in
      // send-pipeline.parseMentions, so inserting the display name works.
      return name;
    }
    // Same path for user mentions.
    return name;
  }

  function detectMentionTokenAtCaret(value, cursor) {
    if (cursor <= 0) return null;
    let i = cursor - 1;
    while (i >= 0 && MENTION_TOKEN_CHAR.test(value[i])) i -= 1;
    if (i < 0 || value[i] !== "@") return null;
    // "@" must be at start of text or directly after whitespace so that
    // tokens like "foo@bar" never open the picker.
    if (i > 0 && !/\s/.test(value[i - 1])) return null;
    // Walk forward past any remaining token chars so a caret parked in the
    // middle of an existing "@token" replaces the WHOLE token, not just the
    // prefix to the left of the caret.
    let end = cursor;
    while (end < value.length && MENTION_TOKEN_CHAR.test(value[end])) end += 1;
    return { start: i, end, filter: value.slice(i + 1, end) };
  }

  function filteredMentionMembers() {
    if (!state) return [];
    const members = activeConversationMembers();
    if (!members.length) return [];
    const filter = String(state.mentionFilter || "").toLowerCase();
    return members
      .map((member) => ({ member, name: mentionDisplayName(member) }))
      .filter(({ name }) => name && (!filter || name.toLowerCase().includes(filter)));
  }

  function updateMentionMenuState() {
    if (!state || !els || !els.chatInput) return;
    const value = els.chatInput.value;
    const cursor = els.chatInput.selectionStart || 0;
    const token = detectMentionTokenAtCaret(value, cursor);
    if (!token || !activeConversationMembers().length) {
      if (state.mentionMenuOpen) {
        state.mentionMenuOpen = false;
        renderMentionMenu();
      }
      state.mentionStart = -1;
      state.mentionEnd = -1;
      state.mentionFilter = "";
      return;
    }
    state.mentionMenuOpen = true;
    state.mentionStart = token.start;
    state.mentionEnd = token.end;
    state.mentionFilter = token.filter;
    const items = filteredMentionMembers();
    if (state.mentionSelectedIndex >= items.length) {
      state.mentionSelectedIndex = Math.max(0, items.length - 1);
    }
    if (state.mentionSelectedIndex < 0) state.mentionSelectedIndex = 0;
    renderMentionMenu();
  }

  function renderMentionMenu() {
    if (!state || !els || !els.mentionMenu) return;
    els.mentionMenu.classList.toggle("hidden", !state.mentionMenuOpen);
    if (!state.mentionMenuOpen) {
      els.mentionMenu.innerHTML = "";
      return;
    }
    const items = filteredMentionMembers();
    if (!items.length) {
      els.mentionMenu.innerHTML = `<div class="mention-menu-empty">没有匹配的成员</div>`;
      return;
    }
    const escape = window.miaMarkdown.escapeHtml;
    const accent = window.miaMemberColor?.memberAccentColor || (() => "#5e5ce6");
    els.mentionMenu.innerHTML = items.map(({ member, name }, index) => {
      const ref = member.member_ref || "";
      const kindLabel = member.member_kind === MemberKind.Bot ? "Bot" : "User";
      const dot = `<span class="mention-menu-dot" style="background:${escape(accent(ref))}"></span>`;
      return `<button type="button" class="mention-menu-item${index === state.mentionSelectedIndex ? " active" : ""}" data-mention-index="${index}">${dot}<span class="mention-menu-name">${escape(name)}</span><span class="mention-menu-kind">${escape(kindLabel)}</span></button>`;
    }).join("");
    els.mentionMenu.querySelectorAll("[data-mention-index]").forEach((button) => {
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const idx = Number(button.dataset.mentionIndex || 0);
        const list = filteredMentionMembers();
        if (list[idx]) applyMentionPick(list[idx].member);
      });
      // Hover steers the keyboard selection so the bar follows the mouse
      // instead of showing two highlighted rows at once (one keyboard,
      // one mouse).
      button.addEventListener("mousemove", () => {
        const idx = Number(button.dataset.mentionIndex || 0);
        if (idx === state.mentionSelectedIndex) return;
        state.mentionSelectedIndex = idx;
        renderMentionMenu();
      });
    });
  }

  function applyMentionPick(member) {
    if (!state || !els || !els.chatInput) return;
    if (state.mentionStart < 0) return;
    const value = els.chatInput.value;
    // Replace the WHOLE @token, not just the prefix up to the caret —
    // otherwise a caret parked in the middle of an existing @kongling and
    // a pick of "kongling" yields "@kongling ling".
    const end = typeof state.mentionEnd === "number" && state.mentionEnd >= state.mentionStart
      ? state.mentionEnd
      : (els.chatInput.selectionStart || 0);
    const insert = `@${mentionInsertText(member)} `;
    const next = value.slice(0, state.mentionStart) + insert + value.slice(end);
    els.chatInput.value = next;
    const caret = state.mentionStart + insert.length;
    els.chatInput.setSelectionRange(caret, caret);
    state.mentionMenuOpen = false;
    state.mentionStart = -1;
    state.mentionEnd = -1;
    state.mentionFilter = "";
    state.mentionSelectedIndex = 0;
    renderMentionMenu();
    if (typeof resizeChatInput === "function") resizeChatInput();
    if (typeof renderSendButton === "function") renderSendButton();
    els.chatInput.focus();
  }

  function closeMentionMenu() {
    if (!state) return;
    state.mentionMenuOpen = false;
    state.mentionStart = -1;
    state.mentionEnd = -1;
    state.mentionFilter = "";
    state.mentionSelectedIndex = 0;
    renderMentionMenu();
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
    isPathPasteShortcut,
    normalizePathPasteText,
    insertPathPasteText,
    insertPathPasteReference,
    insertPathPastePayload,
    renderPathPasteRefs,
    handlePathPasteRefBackspace,
    handleComposerEditorKeydown,
    expandPathPasteRefsForSend,
    clearPathPasteRefs,
    reconcilePathPasteRefsFromInput,
    handleComposerPlainTextPaste,
    pasteClipboardPathText,
    handlePathPasteShortcut,
    addComposerFiles,
    thumbnailDataUrlForFile,
    readFileAsDataUrl,
    saveBrowserFileAttachment,
    commandTextForSend,
    sendSlashCommand,
    fillSlashCommand,
    updateMentionMenuState,
    renderMentionMenu,
    filteredMentionMembers,
    applyMentionPick,
    closeMentionMenu,
  };
})();
