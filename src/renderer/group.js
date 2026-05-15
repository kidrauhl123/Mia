// Renderer-side group chat module.
// Loaded by <script src="./group.js"></script> from index.html, before app.js.

(function (global) {
  const promptsModule =
    typeof require !== "undefined"
      ? require("./group-prompts.js")
      : global.aimashiGroupPrompts;
  const conductorModule =
    typeof require !== "undefined"
      ? require("./conductor.js")
      : global.aimashiConductor;
  const { createConductor } = conductorModule || {};
  // parseMentions/filterRecentTurnsForFellow/etc. accessed via promptsModule when needed.

  const moduleState = {
    groups: [],
    activeGroupId: null,
    messagesByGroup: new Map(),
    fellows: [],
    fellowNamesById: {},
    promptTemplates: null,
    conductor: null,
    deps: null,
    personaWatcherBound: false,
  };

  async function initGroupModule(deps) {
    moduleState.deps = deps;
    moduleState.fellows = (deps.getFellows && deps.getFellows()) || [];
    moduleState.fellowNamesById = Object.fromEntries(
      moduleState.fellows.map((f) => [f.id || f.key, f.name])
    );
    try {
      moduleState.promptTemplates = await window.aimashi.groups.loadPrompts();
      moduleState.groups = await window.aimashi.groups.list();
    } catch (err) {
      console.error("[group] init failed:", err);
      moduleState.promptTemplates = null;
      moduleState.groups = [];
    }
    if (createConductor && moduleState.promptTemplates && deps.engineCall) {
      moduleState.conductor = createConductor({
        engineCall: deps.engineCall,
        dispatchTemplate: moduleState.promptTemplates.dispatch,
        summarizeTemplate: moduleState.promptTemplates.summarize,
      });
    }
    bindCreateButton();
    // Groups render into #personaList via app.js render() which calls listGroups()
    // Trigger a render if app.js has exposed one
    if (typeof deps.triggerRender === "function") deps.triggerRender();
  }

  // Called by app.js to inject group rows into #personaList
  function renderGroupSidebarEntries() {
    // No-op: groups are injected by app.js's render loop via listGroups()
    // This function is kept for backward compat; the real work is in app.js.
  }

  function bindCreateButton() {
    const btn = document.getElementById("createGroup");
    if (!btn) return;
    btn.disabled = false;
    // Remove prior listeners by cloning
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    document.getElementById("createGroup").addEventListener("click", () => {
      // Close the create menu first
      const menu = document.getElementById("fellowCreateMenu");
      if (menu) menu.classList.add("hidden");
      openCreateDialog();
    });
  }

  function bindPersonaListWatcher() {
    // Legacy: kept harmless. Group view switching is now handled via state.activeKey in app.js.
  }

  // ── Create dialog ──────────────────────────────────────────────────────────

  function openCreateDialog() {
    const dialog = document.getElementById("groupCreateDialog");
    if (!dialog) {
      console.error("[group] groupCreateDialog DOM missing");
      return;
    }
    const membersBox = document.getElementById("groupCreateMembers");
    const hostSelect = document.getElementById("groupCreateHost");
    const nameInput = document.getElementById("groupCreateName");
    const confirmBtn = document.getElementById("groupCreateConfirm");
    const cancelBtn = document.getElementById("groupCreateCancel");
    const closeBtn = document.getElementById("groupCreateClose");

    const selected = new Set();

    function refreshHostOptions() {
      hostSelect.innerHTML = "";
      for (const id of selected) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = moduleState.fellowNamesById[id] || id;
        hostSelect.appendChild(opt);
      }
    }

    // Build member rows
    membersBox.innerHTML = "";
    for (const fellow of moduleState.fellows) {
      const fellowId = fellow.id || fellow.key;
      const row = document.createElement("div");
      row.className = "group-create-member-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = fellowId;

      const avatarEl = document.createElement("span");
      avatarEl.className = "member-avatar";
      // Use avatarThumbBackgroundStyle if available from app.js scope; fall back to color
      if (typeof avatarThumbBackgroundStyle === "function") {
        const image = fellow.avatarImage || (typeof avatarAssetForKey === "function" ? avatarAssetForKey(fellowId) : "");
        avatarEl.style.cssText = avatarThumbBackgroundStyle(image, fellow.avatarCrop, fellow.color || "#5e5ce6");
      } else {
        avatarEl.style.background = fellow.color || "#5e5ce6";
      }

      const nameEl = document.createElement("span");
      nameEl.className = "member-name";
      nameEl.textContent = fellow.name || fellowId;

      row.appendChild(cb);
      row.appendChild(avatarEl);
      row.appendChild(nameEl);

      // Click anywhere on row toggles checkbox
      row.addEventListener("click", (e) => {
        if (e.target !== cb) cb.checked = !cb.checked;
        if (cb.checked) selected.add(fellowId);
        else selected.delete(fellowId);
        refreshHostOptions();
      });
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(fellowId);
        else selected.delete(fellowId);
        refreshHostOptions();
      });

      membersBox.appendChild(row);
    }

    nameInput.value = "";
    dialog.classList.remove("hidden");

    function close() {
      dialog.classList.add("hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onClose);
      closeBtn.removeEventListener("click", onClose);
      document.removeEventListener("keydown", onEsc);
      dialog.removeEventListener("click", onBackdropClick);
    }

    function onClose() { close(); }

    function onEsc(e) { if (e.key === "Escape") close(); }

    function onBackdropClick(e) {
      if (e.target === dialog) close();
    }

    async function onConfirm() {
      const members = [...selected];
      if (members.length < 2 || members.length > 5) {
        alert("成员数必须在 2 到 5 之间");
        return;
      }
      const hostFellowId = hostSelect.value || members[0];
      const name = nameInput.value.trim() || members
        .map((id) => moduleState.fellowNamesById[id] || id)
        .join(" · ");
      try {
        const group = await window.aimashi.groups.create({ name, members, hostFellowId });
        moduleState.groups.push(group);
        close();
        // Switch to new group via state
        if (moduleState.deps && typeof moduleState.deps.openGroup === "function") {
          moduleState.deps.openGroup(group.id);
        }
      } catch (e) {
        alert("建群失败：" + (e && e.message ? e.message : String(e)));
      }
    }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onClose);
    closeBtn.addEventListener("click", onClose);
    document.addEventListener("keydown", onEsc);
    dialog.addEventListener("click", onBackdropClick);
  }

  // ── Info dialog ────────────────────────────────────────────────────────────

  function openInfoDialog(group) {
    const dialog = document.getElementById("groupInfoDialog");
    if (!dialog) {
      console.error("[group] groupInfoDialog DOM missing");
      return;
    }
    const membersBox = document.getElementById("groupInfoMembers");
    const hostSelect = document.getElementById("groupInfoHost");
    const goalInput = document.getElementById("groupInfoGoal");
    const closeBtn = document.getElementById("groupInfoClose");
    const goalSaveBtn = document.getElementById("groupInfoGoalSave");
    const resetCtxBtn = document.getElementById("groupInfoResetCtx");

    function refreshMembers() {
      membersBox.innerHTML = "";
      for (const memberId of group.members) {
        const row = document.createElement("div");
        row.className = "group-info-member-row";
        const label = document.createElement("span");
        label.className = "group-info-member-name";
        label.textContent = (moduleState.fellowNamesById[memberId] || memberId) +
          (memberId === group.hostFellowId ? " 👑" : "");
        row.appendChild(label);
        if (group.members.length > 1) {
          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "group-info-remove-btn";
          removeBtn.textContent = "移除";
          removeBtn.addEventListener("click", () => removeMember(group, memberId));
          row.appendChild(removeBtn);
        }
        membersBox.appendChild(row);
      }
    }

    refreshMembers();

    hostSelect.innerHTML = "";
    for (const memberId of group.members) {
      const opt = document.createElement("option");
      opt.value = memberId;
      opt.textContent = moduleState.fellowNamesById[memberId] || memberId;
      if (memberId === group.hostFellowId) opt.selected = true;
      hostSelect.appendChild(opt);
    }
    hostSelect.onchange = async () => {
      const newHost = hostSelect.value;
      group.hostFellowId = newHost;
      try {
        await window.aimashi.groups.update(group.id, { hostFellowId: newHost });
      } catch (e) {
        console.warn("[group] host switch failed:", e);
        return;
      }
      renderActiveGroup(group);
      refreshMembers();
    };

    goalInput.value = (group.decorations && group.decorations.pinnedGoal) || "";
    goalSaveBtn.onclick = async () => {
      const goal = goalInput.value.trim();
      const decorations = { ...(group.decorations || {}), pinnedGoal: goal || null };
      group.decorations = decorations;
      try {
        await window.aimashi.groups.update(group.id, { decorations });
        goalSaveBtn.textContent = "已保存";
        setTimeout(() => { goalSaveBtn.textContent = "保存目标"; }, 1500);
      } catch (e) {
        console.warn("[group] save goal failed:", e);
      }
    };

    resetCtxBtn.onclick = async () => {
      if (!confirm("重置群上下文摘要？后续 Fellow 看不到旧摘要，得重新攒一遍。")) return;
      group.contextCard = null;
      try {
        await window.aimashi.groups.update(group.id, { contextCard: null });
        alert("已重置。");
      } catch (e) {
        console.warn("[group] reset context failed:", e);
      }
    };

    dialog.classList.remove("hidden");

    function close() {
      dialog.classList.add("hidden");
      closeBtn.removeEventListener("click", onClose);
      document.removeEventListener("keydown", onEsc);
      dialog.removeEventListener("click", onBackdropClick);
    }

    function onClose() { close(); }
    function onEsc(e) { if (e.key === "Escape") close(); }
    function onBackdropClick(e) { if (e.target === dialog) close(); }

    closeBtn.addEventListener("click", onClose);
    document.addEventListener("keydown", onEsc);
    dialog.addEventListener("click", onBackdropClick);
  }

  // ── openGroup: now just switches state.activeKey in app.js ────────────────

  function openGroup(groupId) {
    const group = moduleState.groups.find((g) => g.id === groupId);
    if (!group) {
      console.warn("[group] openGroup: not found", groupId);
      return;
    }
    moduleState.activeGroupId = groupId;
    if (moduleState.deps && typeof moduleState.deps.openGroup === "function") {
      moduleState.deps.openGroup(groupId);
    }
  }

  // ── renderActiveGroup: fills #chat with group messages ───────────────────

  async function renderActiveGroup(group) {
    const chatEl = document.getElementById("chat");
    if (!chatEl) return;

    // Ensure messages are loaded
    if (!moduleState.messagesByGroup.has(group.id)) {
      try {
        const messages = await window.aimashi.groups.listMessages(group.id);
        moduleState.messagesByGroup.set(group.id, messages);
      } catch (e) {
        console.warn("[group] listMessages failed:", e);
        moduleState.messagesByGroup.set(group.id, []);
      }
    }

    const messages = moduleState.messagesByGroup.get(group.id) || [];
    renderGroupMessagesIntoChat(group, messages, chatEl);
  }

  function renderGroupMessagesIntoChat(group, messages, chatEl) {
    if (!chatEl) return;
    chatEl.innerHTML = "";

    const runtime = (moduleState.deps && moduleState.deps.getRuntime && moduleState.deps.getRuntime()) || {};
    const allFellows = runtime.fellows || runtime.personas || [];

    for (const msg of messages) {
      const article = document.createElement("article");

      if (msg.role === "user") {
        article.className = "message user";
        const user = runtime.user || { avatarText: "B", avatarColor: "#111827" };
        const label = user.avatarText || "B";
        const color = user.avatarColor || "#111827";
        const userAvatarStyle = (typeof avatarThumbBackgroundStyle === "function" && user.avatarImage)
          ? avatarThumbBackgroundStyle(user.avatarImage, user.avatarCrop, color)
          : "";
        article.innerHTML = `
          <div class="avatar" style="background-color:${escapeHtmlSafe(color)};${userAvatarStyle}">${escapeHtmlSafe(label)}</div>
          <div class="message-stack"><div class="bubble">${escapeHtmlSafe(msg.content || "")}</div></div>
        `;
      } else if (msg.role === "fellow") {
        article.className = "message assistant";
        const fellow = allFellows.find((f) => (f.id || f.key) === msg.senderFellowId);
        const fellowName = moduleState.fellowNamesById[msg.senderFellowId] || msg.senderFellowId || "?";
        const fellowColor = fellow?.color || "#5e5ce6";
        const isHost = msg.senderFellowId === group.hostFellowId;
        let avatarStyle = "";
        if (typeof avatarThumbBackgroundStyle === "function") {
          const image = fellow?.avatarImage || (typeof avatarAssetForKey === "function" ? avatarAssetForKey(msg.senderFellowId) : "");
          avatarStyle = avatarThumbBackgroundStyle(image, fellow?.avatarCrop, fellowColor);
        }
        const senderLabel = fellowName + (isHost ? " 👑" : "");
        const bodyContent = msg.status === "streaming" ? "…" : escapeHtmlSafe(msg.content || "");
        const errorClass = msg.status === "error" ? " group-msg-error" : "";
        article.innerHTML = `
          <div class="avatar" style="background-color:${escapeHtmlSafe(fellowColor)};${avatarStyle}"></div>
          <div class="message-stack">
            <div class="group-msg-sender-label">${escapeHtmlSafe(senderLabel)}</div>
            <div class="bubble${errorClass}">${bodyContent}</div>
          </div>
        `;
      } else if (msg.role === "system") {
        article.className = "message group-system-msg";
        article.innerHTML = `<div class="group-system-text">${escapeHtmlSafe(msg.content || "")}</div>`;
      } else {
        continue;
      }

      chatEl.appendChild(article);
    }

    chatEl.scrollTop = chatEl.scrollHeight;
  }

  // ── sendInActiveGroup: reads from #chatInput, called by app.js submit ─────

  async function sendInActiveGroup() {
    const group = moduleState.groups.find((g) => g.id === moduleState.activeGroupId);
    if (!group) return;

    const inputEl = document.getElementById("chatInput");
    if (!inputEl) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    // Trigger app.js resize / send button update
    if (typeof resizeChatInput === "function") resizeChatInput();
    if (typeof renderSendButton === "function") renderSendButton();

    await sendInGroup(group, text);
  }

  async function sendInGroup(group, text) {
    const turnId = "t-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const mentions = parseMentionsFor(group, text);
    const userMsg = {
      id: "m-" + Date.now() + "-u",
      groupId: group.id,
      role: "user",
      content: text,
      mentions,
      turnId,
      createdAt: Date.now(),
      status: "complete",
    };
    await window.aimashi.groups.appendMessage(group.id, userMsg);
    const msgs = moduleState.messagesByGroup.get(group.id) || [];
    msgs.push(userMsg);
    moduleState.messagesByGroup.set(group.id, msgs);

    const chatEl = document.getElementById("chat");
    renderGroupMessagesIntoChat(group, msgs, chatEl);

    if (!moduleState.conductor) {
      console.warn("[group] conductor not initialized; only explicit @ will dispatch");
    }

    const members = moduleState.fellows.filter((f) => group.members.includes(f.id || f.key));

    let dispatch;
    if (moduleState.conductor) {
      dispatch = await moduleState.conductor.decideDispatch({
        group,
        members,
        fellowNamesById: moduleState.fellowNamesById,
        userMessage: userMsg,
        messages: msgs,
      });
    } else {
      dispatch = { speak: mentions.filter((id) => group.members.includes(id)) };
    }

    if (dispatch.degraded) {
      const sysMsg = {
        id: "m-" + Date.now() + "-sys",
        groupId: group.id,
        role: "system",
        content: "群助手暂时不在线，没 @ 到的消息暂不会被回应",
        mentions: [],
        turnId,
        createdAt: Date.now(),
        status: "complete",
      };
      await window.aimashi.groups.appendMessage(group.id, sysMsg);
      msgs.push(sysMsg);
      renderGroupMessagesIntoChat(group, msgs, chatEl);
      return;
    }

    await Promise.all(
      dispatch.speak.map((fellowId) => dispatchToFellow(group, fellowId, userMsg, turnId))
    );

    await maybeUpdateSummary(group);
  }

  function parseMentionsFor(group, text) {
    const fellows = moduleState.fellows
      .filter((f) => group.members.includes(f.id || f.key))
      .map((f) => ({ id: f.id || f.key, name: f.name || f.key }));
    if (!promptsModule || typeof promptsModule.parseMentions !== "function") return [];
    return promptsModule.parseMentions(text, fellows);
  }

  async function dispatchToFellow(group, fellowId, userMsg, turnId) {
    const msgs = moduleState.messagesByGroup.get(group.id) || [];
    const filterFn = promptsModule && promptsModule.filterRecentTurnsForFellow;
    const buildContext = promptsModule && promptsModule.buildFellowGroupContext;
    const recent = filterFn ? filterFn(msgs, fellowId, 3) : [];
    const contextBlock = buildContext
      ? buildContext({
          groupName: group.name,
          summary: group.contextCard ? group.contextCard.summary : null,
          recentForFellow: recent,
          fellowNamesById: moduleState.fellowNamesById,
        })
      : "";

    const placeholderMsg = {
      id: "m-" + Date.now() + "-" + fellowId,
      groupId: group.id,
      role: "fellow",
      senderFellowId: fellowId,
      content: "",
      mentions: [],
      turnId,
      createdAt: Date.now(),
      status: "streaming",
    };
    msgs.push(placeholderMsg);
    const chatEl = document.getElementById("chat");
    renderGroupMessagesIntoChat(group, msgs, chatEl);

    try {
      const result = await window.aimashi.sendChat({
        fellowKey: fellowId,
        sessionId: "group:" + group.id + ":" + fellowId,
        messages: [{ role: "user", content: userMsg.content }],
        group: { id: group.id, contextBlock },
      });
      placeholderMsg.content = extractAssistantContent(result);
      placeholderMsg.status = "complete";
    } catch (e) {
      placeholderMsg.content = "（响应失败：" + (e && e.message ? e.message : String(e)) + "）";
      placeholderMsg.status = "error";
    }
    try {
      await window.aimashi.groups.appendMessage(group.id, placeholderMsg);
    } catch (e) {
      console.warn("[group] appendMessage failed for fellow " + fellowId + ":", e);
    }
    renderGroupMessagesIntoChat(group, msgs, chatEl);
  }

  function extractAssistantContent(result) {
    if (!result) return "";
    if (typeof result === "string") return result;
    if (result.content && typeof result.content === "string") return result.content;
    const choice = Array.isArray(result.choices) ? result.choices[0] : null;
    if (choice && choice.message && typeof choice.message.content === "string") {
      return choice.message.content;
    }
    return "";
  }

  async function maybeUpdateSummary(group) {
    if (!moduleState.conductor || !promptsModule || typeof promptsModule.shouldSummarize !== "function") return;
    const msgs = moduleState.messagesByGroup.get(group.id) || [];
    if (!promptsModule.shouldSummarize(group, msgs)) return;
    const card = await moduleState.conductor.summarize({
      group,
      fellowNamesById: moduleState.fellowNamesById,
      messages: msgs,
    });
    if (!card) return;
    group.contextCard = card;
    try {
      await window.aimashi.groups.saveContextCard(group.id, card);
    } catch (e) {
      console.warn("[group] saveContextCard failed:", e);
    }
  }

  async function removeMember(group, memberId) {
    if (group.members.length <= 1) {
      alert("群里至少需要一个 Fellow");
      return;
    }
    const newMembers = group.members.filter((id) => id !== memberId);
    let newHost = group.hostFellowId;
    let hostChanged = false;
    if (memberId === group.hostFellowId) {
      newHost = newMembers[0];
      hostChanged = true;
    }
    group.members = newMembers;
    group.hostFellowId = newHost;
    try {
      await window.aimashi.groups.update(group.id, { members: newMembers, hostFellowId: newHost });
    } catch (e) {
      console.warn("[group] removeMember persist failed:", e);
      alert("移除失败：" + (e && e.message ? e.message : String(e)));
      return;
    }

    const msgs = moduleState.messagesByGroup.get(group.id) || [];
    const removedName = moduleState.fellowNamesById[memberId] || memberId;
    const sysContent = hostChanged
      ? `${removedName} 离开了群，${moduleState.fellowNamesById[newHost] || newHost} 成为群主`
      : `${removedName} 离开了群`;
    const sysMsg = {
      id: "m-" + Date.now() + "-leave",
      groupId: group.id,
      role: "system",
      content: sysContent,
      mentions: [],
      turnId: "t-sys-" + Date.now(),
      createdAt: Date.now(),
      status: "complete",
    };
    try {
      await window.aimashi.groups.appendMessage(group.id, sysMsg);
    } catch (e) {
      console.warn("[group] system bubble persist failed:", e);
    }
    msgs.push(sysMsg);
    const chatEl = document.getElementById("chat");
    renderGroupMessagesIntoChat(group, msgs, chatEl);

    if (newMembers.length === 1) {
      if (confirm("群里只剩 1 个 Fellow 了，转为单聊？")) {
        alert("请直接打开单聊和该 Fellow 对话。");
      }
    }
    // Refresh the info dialog with updated members
    openInfoDialog(group);
  }

  // ── Safe HTML escape (available before app.js loads) ─────────────────────

  function escapeHtmlSafe(value) {
    // If app.js's escapeHtml is already available, use it
    if (typeof escapeHtml === "function") return escapeHtml(value);
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  global.aimashiGroup = {
    initGroupModule,
    renderGroupSidebarEntries,
    openGroup,
    bindCreateButton,
    openCreateDialog,
    openInfoDialog,
    renderActiveGroup,
    sendInActiveGroup,
    removeMember,
    moduleState,
  };
})(window);
