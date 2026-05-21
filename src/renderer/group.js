// Renderer-side group chat module.
// Loaded by <script src="./group.js"></script> from index.html, before app.js.

(function (global) {
  const promptsModule = (typeof window !== "undefined" && window.aimashiGroupPrompts)
    ? window.aimashiGroupPrompts
    : (typeof require !== "undefined" ? require("./group-prompts.js") : {});
  const conductorModule = (typeof window !== "undefined" && window.aimashiConductor)
    ? window.aimashiConductor
    : (typeof require !== "undefined" ? require("./conductor.js") : {});
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
    typingFellowIds: new Set(),
    relayToken: 0,
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const STAGGER_MS = 300;
  const MAX_RELAY_TURNS = 6;

  function currentFellows() {
    if (moduleState.deps && typeof moduleState.deps.getFellows === "function") {
      return moduleState.deps.getFellows();
    }
    return moduleState.fellows || [];
  }

  function currentFellowNamesById() {
    const map = {};
    for (const f of currentFellows()) {
      map[f.id || f.key] = f.name || f.key;
    }
    return map;
  }

  function triggerRender() {
    if (moduleState.deps && typeof moduleState.deps.triggerRender === "function") {
      moduleState.deps.triggerRender();
    }
  }

  async function initGroupModule(deps) {
    moduleState.deps = deps;
    moduleState.fellows = (deps.getFellows && deps.getFellows()) || [];
    moduleState.fellowNamesById = Object.fromEntries(
      moduleState.fellows.map((f) => [f.id || f.key, f.name])
    );
    try {
      moduleState.promptTemplates = await window.aimashi.groups.loadPrompts();
      moduleState.groups = await window.aimashi.groups.list();
      await Promise.all(moduleState.groups.map(async (group) => {
        try {
          moduleState.messagesByGroup.set(group.id, await window.aimashi.groups.listMessages(group.id));
        } catch (e) {
          console.warn("[group] listMessages failed for preview:", e);
          moduleState.messagesByGroup.set(group.id, []);
        }
      }));
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
        relayTemplate: moduleState.promptTemplates.relay,
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
    const countEl = document.getElementById("groupCreateCount");
    const confirmBtn = document.getElementById("groupCreateConfirm");
    const cancelBtn = document.getElementById("groupCreateCancel");
    const closeBtn = document.getElementById("groupCreateClose");

    const MAX_MEMBERS = 5;
    const selected = new Set();
    const fellowNamesById = currentFellowNamesById();

    function refreshHostOptions() {
      const prev = hostSelect.value;
      hostSelect.innerHTML = "";
      for (const id of selected) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = fellowNamesById[id] || id;
        hostSelect.appendChild(opt);
      }
      if (selected.has(prev)) hostSelect.value = prev;
    }

    function refreshCount() {
      if (countEl) countEl.textContent = String(selected.size);
      if (confirmBtn) confirmBtn.disabled = selected.size < 2;
    }

    // Build member rows
    membersBox.innerHTML = "";
    const fellows = currentFellows();
    if (fellows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "group-create-members-empty";
      empty.textContent = "还没有 Fellow，先去创建一个";
      membersBox.appendChild(empty);
    }
    for (const fellow of fellows) {
      const fellowId = fellow.id || fellow.key;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "group-create-member-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.dataset.fellowId = fellowId;

      const avatarEl = document.createElement("span");
      avatarEl.className = "member-avatar";
      if (typeof window.aimashiAvatar?.avatarThumbBackgroundStyle === "function") {
        const image = fellow.avatarImage || (typeof window.aimashiAvatar?.avatarAssetForKey === "function" ? window.aimashiAvatar.avatarAssetForKey(fellowId) : "");
        avatarEl.style.cssText = window.aimashiAvatar.avatarThumbBackgroundStyle(image, fellow.avatarCrop, fellow.color || "#5e5ce6");
      } else {
        avatarEl.style.background = fellow.color || "#5e5ce6";
      }

      const nameEl = document.createElement("span");
      nameEl.className = "member-name";
      nameEl.textContent = fellow.name || fellowId;

      const checkEl = document.createElement("span");
      checkEl.className = "member-check";
      checkEl.setAttribute("aria-hidden", "true");

      row.appendChild(avatarEl);
      row.appendChild(nameEl);
      row.appendChild(checkEl);

      row.addEventListener("click", () => {
        if (selected.has(fellowId)) {
          selected.delete(fellowId);
          row.classList.remove("is-selected");
          row.setAttribute("aria-selected", "false");
        } else {
          if (selected.size >= MAX_MEMBERS) return;
          selected.add(fellowId);
          row.classList.add("is-selected");
          row.setAttribute("aria-selected", "true");
        }
        refreshHostOptions();
        refreshCount();
      });

      membersBox.appendChild(row);
    }

    nameInput.value = "";
    refreshCount();
    dialog.classList.remove("hidden");
    setTimeout(() => { try { membersBox.querySelector(".group-create-member-row")?.focus(); } catch {} }, 0);

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
        .map((id) => fellowNamesById[id] || id)
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
    const nameInput = document.getElementById("groupInfoName");
    const nameSaveBtn = document.getElementById("groupInfoNameSave");
    const goalInput = document.getElementById("groupInfoGoal");
    const closeBtn = document.getElementById("groupInfoClose");
    const goalSaveBtn = document.getElementById("groupInfoGoalSave");
    const resetCtxBtn = document.getElementById("groupInfoResetCtx");

    const infoFellowNamesById = currentFellowNamesById();
    if (nameInput) nameInput.value = group.name || "";
    if (nameInput && nameSaveBtn) {
      nameSaveBtn.onclick = async () => {
        const name = nameInput.value.trim() || "未命名群聊";
        group.name = name;
        try {
          Object.assign(group, await window.aimashi.groups.update(group.id, { name }));
          nameSaveBtn.textContent = "已保存";
          setTimeout(() => { nameSaveBtn.textContent = "保存群名"; }, 1500);
          triggerRender();
        } catch (e) {
          console.warn("[group] save name failed:", e);
          alert("保存群名失败：" + (e && e.message ? e.message : String(e)));
        }
      };
    }

    function refreshMembers() {
      membersBox.innerHTML = "";
      for (const memberId of group.members) {
        const row = document.createElement("div");
        row.className = "group-info-member-row";
        const label = document.createElement("span");
        label.className = "group-info-member-name";
        label.textContent = (infoFellowNamesById[memberId] || memberId) +
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

    // Render addable-members section
    const addableBox = document.getElementById("groupInfoAddable");
    function refreshAddable() {
      if (!addableBox) return;
      addableBox.innerHTML = "";
      if (group.members.length >= 5) {
        const full = document.createElement("p");
        full.className = "group-info-addable-full";
        full.textContent = "已满员（最多 5 位 Fellow）";
        addableBox.appendChild(full);
        return;
      }
      const eligible = currentFellows().filter((f) => {
        const fid = f.id || f.key;
        return !group.members.includes(fid);
      });
      if (eligible.length === 0) {
        const none = document.createElement("p");
        none.className = "group-info-addable-full";
        none.textContent = "没有可添加的 Fellow";
        addableBox.appendChild(none);
        return;
      }
      for (const fellow of eligible) {
        const fellowId = fellow.id || fellow.key;
        const row = document.createElement("div");
        row.className = "group-create-member-row group-info-add-row";
        const avatarEl = document.createElement("span");
        avatarEl.className = "member-avatar";
        if (typeof window.aimashiAvatar?.avatarThumbBackgroundStyle === "function") {
          const image = fellow.avatarImage || (typeof window.aimashiAvatar?.avatarAssetForKey === "function" ? window.aimashiAvatar.avatarAssetForKey(fellowId) : "");
          avatarEl.style.cssText = window.aimashiAvatar.avatarThumbBackgroundStyle(image, fellow.avatarCrop, fellow.color || "#5e5ce6");
        } else {
          avatarEl.style.background = fellow.color || "#5e5ce6";
        }
        const nameEl = document.createElement("span");
        nameEl.className = "member-name";
        nameEl.textContent = fellow.name || fellowId;
        const addIndicator = document.createElement("span");
        addIndicator.className = "group-info-add-indicator";
        addIndicator.textContent = "+";
        row.appendChild(avatarEl);
        row.appendChild(nameEl);
        row.appendChild(addIndicator);
        row.addEventListener("click", async () => {
          if (group.members.length >= 5) return;
          const newMembers = [...group.members, fellowId];
          group.members = newMembers;
          try {
            Object.assign(group, await window.aimashi.groups.update(group.id, { members: newMembers }));
            triggerRender();
          } catch (e) {
            console.warn("[group] addMember persist failed:", e);
            group.members = newMembers.filter((id) => id !== fellowId);
            return;
          }
          const fellowName = infoFellowNamesById[fellowId] || fellow.name || fellowId;
          const sysMsg = {
            id: "m-" + Date.now() + "-join",
            groupId: group.id,
            role: "system",
            content: fellowName + " 加入了群",
            mentions: [],
            turnId: "t-sys-" + Date.now(),
            createdAt: Date.now(),
            status: "complete",
          };
          try {
            Object.assign(group, await window.aimashi.groups.appendMessage(group.id, sysMsg));
          } catch (e) {
            console.warn("[group] system bubble persist failed:", e);
          }
          const msgs = moduleState.messagesByGroup.get(group.id) || [];
          msgs.push(sysMsg);
          triggerRender();
          const chatEl = document.getElementById("chat");
          if (chatEl) renderGroupMessagesIntoChat(group, msgs, chatEl);
          openInfoDialog(group);
        });
        addableBox.appendChild(row);
      }
    }
    refreshAddable();

    hostSelect.innerHTML = "";
    for (const memberId of group.members) {
      const opt = document.createElement("option");
      opt.value = memberId;
      opt.textContent = infoFellowNamesById[memberId] || memberId;
      if (memberId === group.hostFellowId) opt.selected = true;
      hostSelect.appendChild(opt);
    }
    hostSelect.onchange = async () => {
      const newHost = hostSelect.value;
      group.hostFellowId = newHost;
      try {
        Object.assign(group, await window.aimashi.groups.update(group.id, { hostFellowId: newHost }));
        triggerRender();
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
        Object.assign(group, await window.aimashi.groups.update(group.id, { decorations }));
        goalSaveBtn.textContent = "已保存";
        setTimeout(() => { goalSaveBtn.textContent = "保存目标"; }, 1500);
        triggerRender();
      } catch (e) {
        console.warn("[group] save goal failed:", e);
      }
    };

    resetCtxBtn.onclick = async () => {
      if (!confirm("重置群上下文摘要？后续 Fellow 看不到旧摘要，得重新攒一遍。")) return;
      group.contextCard = null;
      try {
        Object.assign(group, await window.aimashi.groups.update(group.id, { contextCard: null }));
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

    // Preserve the user's scroll position: only auto-scroll to the bottom if
    // they were already near it (within 80px). Otherwise leave their viewport
    // alone so reading history isn't yanked back down by streaming updates.
    const wasNearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;

    chatEl.innerHTML = "";

    const runtime = (moduleState.deps && moduleState.deps.getRuntime && moduleState.deps.getRuntime()) || {};
    const allFellows = runtime.fellows || runtime.personas || [];

    // Reuse the same markdown renderer as 1v1 so **bold** / `code` / links work
    // identically. Fall back to escaped plain text if it's not available yet.
    const renderBody = (content) => {
      if (!content) return "";
      if (typeof renderMarkdown === "function") {
        try { return window.aimashiMarkdown.renderMarkdown(content); } catch { /* fall through */ }
      }
      return escapeHtmlSafe(content);
    };

    for (const msg of messages) {
      const article = document.createElement("article");

      if (msg.role === "user") {
        article.className = "message user";
        const user = runtime.user || { avatarText: "B", avatarColor: "#111827" };
        const label = user.avatarText || "B";
        const color = user.avatarColor || "#111827";
        const userAvatarStyle = (typeof window.aimashiAvatar?.avatarThumbBackgroundStyle === "function" && user.avatarImage)
          ? window.aimashiAvatar.avatarThumbBackgroundStyle(user.avatarImage, user.avatarCrop, color)
          : "";
        article.innerHTML = `
          <div class="avatar" style="background-color:${escapeHtmlSafe(color)};${userAvatarStyle}">${escapeHtmlSafe(label)}</div>
          <div class="message-stack"><div class="bubble">${renderBody(msg.content)}</div></div>
        `;
      } else if (msg.role === "fellow") {
        article.className = "message assistant";
        const fellow = allFellows.find((f) => (f.id || f.key) === msg.senderFellowId);
        const fellowName = currentFellowNamesById()[msg.senderFellowId] || msg.senderFellowId || "?";
        const fellowColor = fellow?.color || "#5e5ce6";
        const isHost = msg.senderFellowId === group.hostFellowId;
        let avatarStyle = "";
        if (typeof window.aimashiAvatar?.avatarThumbBackgroundStyle === "function") {
          const image = fellow?.avatarImage || (typeof window.aimashiAvatar?.avatarAssetForKey === "function" ? window.aimashiAvatar.avatarAssetForKey(msg.senderFellowId) : "");
          avatarStyle = window.aimashiAvatar.avatarThumbBackgroundStyle(image, fellow?.avatarCrop, fellowColor);
        }
        const senderLabel = fellowName + (isHost ? " 👑" : "");
        const bodyContent = msg.status === "streaming" ? "…" : renderBody(msg.content);
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

    if (wasNearBottom) {
      chatEl.scrollTop = chatEl.scrollHeight;
    }
  }

  // ── Typing indicator helpers ──────────────────────────────────────────────

  function escapeText(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => (
      c === "&" ? "&amp;" :
      c === "<" ? "&lt;" :
      c === ">" ? "&gt;" :
      c === '"' ? "&quot;" : "&#39;"
    ));
  }

  function refreshGroupTypingStatus() {
    const group = moduleState.groups.find((g) => g.id === moduleState.activeGroupId);
    if (!group) return;
    const meta = document.getElementById("activeChatMeta");
    if (!meta) return;
    const namesById = currentFellowNamesById();
    const ids = [...moduleState.typingFellowIds];
    if (ids.length === 0) {
      meta.textContent = "群聊 · " + ((group.members || []).length + 1) + " 人";
      return;
    }
    let label;
    if (ids.length <= 2) {
      label = ids.map((id) => namesById[id] || id).join("、");
    } else {
      label = (namesById[ids[0]] || ids[0]) + "、" + (namesById[ids[1]] || ids[1]) + " 等 " + ids.length + " 位";
    }
    meta.innerHTML = '<span class="typing-status">' +
      escapeText(label) + ' 正在输入' +
      '<span class="typing-dots"><i></i><i></i><i></i></span>' +
      '</span>';
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
    moduleState.relayToken++; // invalidate any prior relay loop
    const myRelayToken = moduleState.relayToken;
    moduleState.typingFellowIds.clear();
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
    Object.assign(group, await window.aimashi.groups.appendMessage(group.id, userMsg));
    const msgs = moduleState.messagesByGroup.get(group.id) || [];
    msgs.push(userMsg);
    moduleState.messagesByGroup.set(group.id, msgs);
    triggerRender();

    const chatEl = document.getElementById("chat");
    renderGroupMessagesIntoChat(group, msgs, chatEl);

    if (!moduleState.conductor) {
      console.warn("[group] conductor not initialized; only explicit @ will dispatch");
    }

    const members = currentFellows().filter((f) => group.members.includes(f.id || f.key));

    let dispatch;
    if (moduleState.conductor) {
      try {
        dispatch = await moduleState.conductor.decideDispatch({
          group,
          members,
          fellowNamesById: currentFellowNamesById(),
          userMessage: userMsg,
          messages: msgs,
        });
      } catch (err) {
        console.error("[group] decideDispatch threw", err);
        dispatch = { speak: [], degraded: true };
      }
      if (members.length > 0 && dispatch.speak && dispatch.speak.length === 0 && !dispatch.degraded) {
        console.warn("[group] dispatch returned empty speak list despite non-empty members:", members.map((f) => f.id || f.key));
      }
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
      Object.assign(group, await window.aimashi.groups.appendMessage(group.id, sysMsg));
      msgs.push(sysMsg);
      triggerRender();
      renderGroupMessagesIntoChat(group, msgs, chatEl);
      return;
    }

    const dispatchPromises = [];
    for (let i = 0; i < dispatch.speak.length; i++) {
      if (i > 0) await sleep(STAGGER_MS);
      dispatchPromises.push(
        dispatchToFellow(group, dispatch.speak[i], userMsg, turnId)
          .catch((err) => console.error("[group] dispatch error", err))
      );
    }
    await Promise.all(dispatchPromises);

    // Relay: after initial Fellow replies, keep asking conductor if anyone else should chime in.
    // Bounded by MAX_RELAY_TURNS and interruptible via relayToken.
    let relayedTurns = 0;
    while (
      relayedTurns < MAX_RELAY_TURNS &&
      moduleState.relayToken === myRelayToken &&
      moduleState.conductor &&
      typeof moduleState.conductor.decideRelay === "function"
    ) {
      const currentMsgs = moduleState.messagesByGroup.get(group.id) || [];
      let relayDispatch;
      try {
        relayDispatch = await moduleState.conductor.decideRelay({
          group,
          members: currentFellows().filter((f) => group.members.includes(f.id || f.key)),
          fellowNamesById: currentFellowNamesById(),
          messages: currentMsgs,
        });
      } catch {
        break;
      }
      // Token check after each await — user may have interrupted
      if (moduleState.relayToken !== myRelayToken) break;
      if (!relayDispatch || !relayDispatch.speak || relayDispatch.speak.length === 0) {
        break;
      }
      // Stagger the relay fellow starts the same way.
      // Important: the user message passed to dispatchToFellow during relay must NOT
      // be the original user prompt (e.g. "你俩玩成语接龙") — otherwise each Fellow
      // sees that prompt fresh and re-opens the game from scratch. Instead, give them
      // a clear continuation cue plus what the last non-self Fellow just said.
      const relayPromises = [];
      for (let i = 0; i < relayDispatch.speak.length; i++) {
        if (moduleState.relayToken !== myRelayToken) break;
        if (i > 0) await sleep(STAGGER_MS);
        const fellowId = relayDispatch.speak[i];
        const namesById = currentFellowNamesById();
        const latestMsgs = moduleState.messagesByGroup.get(group.id) || [];
        const lastOther = [...latestMsgs].reverse().find(
          (m) => m.role === "fellow" && m.senderFellowId !== fellowId && m.content && m.status !== "streaming"
        );
        const relayCue = lastOther
          ? `（群聊正在自由对话。${namesById[lastOther.senderFellowId] || lastOther.senderFellowId} 刚说："${lastOther.content}" 请直接接续刚才的对话，不要重新开场。）`
          : "（群聊正在自由对话。请基于群上下文接续，不要重新开场。）";
        const relayUserMsg = { ...userMsg, content: relayCue, mentions: [] };
        relayPromises.push(
          dispatchToFellow(group, fellowId, relayUserMsg, turnId)
            .catch((err) => console.error("[group] relay dispatch error", err))
        );
      }
      await Promise.all(relayPromises);
      relayedTurns += 1;
    }

    // Soft wrap-up when the relay hit the hard cap (not when the LLM ended
    // naturally and not when the user interrupted). Host Fellow says one line
    // in-persona, checking with the user whether to keep going. Avoids the
    // abrupt mid-game cut-off when 6 turns runs out.
    if (
      relayedTurns >= MAX_RELAY_TURNS &&
      moduleState.relayToken === myRelayToken &&
      group.hostFellowId
    ) {
      const wrapupCue = "（你们已经在群里自由接了好几轮了。请基于你的人设，用一句自然的话问用户：是想继续看你们接下去，还是先聊点别的。承接前面对话，不要重新开场，也不要解释规则。）";
      const wrapupMsg = { ...userMsg, content: wrapupCue, mentions: [] };
      await dispatchToFellow(group, group.hostFellowId, wrapupMsg, turnId)
        .catch((err) => console.error("[group] wrapup dispatch error", err));
    }

    await maybeUpdateSummary(group);
  }

  function parseMentionsFor(group, text) {
    const fellows = currentFellows()
      .filter((f) => group.members.includes(f.id || f.key))
      .map((f) => ({ id: f.id || f.key, name: f.name || f.key }));
    if (!promptsModule || typeof promptsModule.parseMentions !== "function") return [];
    return promptsModule.parseMentions(text, fellows);
  }

  async function dispatchToFellow(group, fellowId, userMsg, turnId) {
    const msgs = moduleState.messagesByGroup.get(group.id) || [];
    const buildContext = promptsModule && promptsModule.buildFellowGroupContext;
    // Show the Fellow the full recent group conversation, not just turns they
    // were @-mentioned in. Otherwise they can't see what other Fellows just
    // said, which breaks free-flowing chat / relay games (成语接龙 等).
    // Older history is compressed into the summary card; capping the live tail
    // at 30 keeps token cost bounded.
    const summaryCutoffId = group.contextCard ? group.contextCard.summaryUpToMsgId : null;
    let liveTail;
    if (summaryCutoffId) {
      const cutoffIdx = msgs.findIndex((m) => m.id === summaryCutoffId);
      liveTail = cutoffIdx >= 0 ? msgs.slice(cutoffIdx + 1) : msgs.slice();
    } else {
      liveTail = msgs.slice();
    }
    const recent = liveTail
      .filter((m) => !(m.role === "fellow" && m.senderFellowId === fellowId && m.status === "streaming"))
      .slice(-30);
    const contextBlock = buildContext
      ? buildContext({
          groupName: group.name,
          summary: group.contextCard ? group.contextCard.summary : null,
          recentForFellow: recent,
          fellowNamesById: currentFellowNamesById(),
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
    moduleState.typingFellowIds.add(fellowId);
    refreshGroupTypingStatus();
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
    } finally {
      moduleState.typingFellowIds.delete(fellowId);
      refreshGroupTypingStatus();
    }
    try {
      Object.assign(group, await window.aimashi.groups.appendMessage(group.id, placeholderMsg));
    } catch (e) {
      console.warn("[group] appendMessage failed for fellow " + fellowId + ":", e);
    }
    triggerRender();
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
      fellowNamesById: currentFellowNamesById(),
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
      Object.assign(group, await window.aimashi.groups.update(group.id, { members: newMembers, hostFellowId: newHost }));
      triggerRender();
    } catch (e) {
      console.warn("[group] removeMember persist failed:", e);
      alert("移除失败：" + (e && e.message ? e.message : String(e)));
      return;
    }

    const msgs = moduleState.messagesByGroup.get(group.id) || [];
    const removeFellowNames = currentFellowNamesById();
    const removedName = removeFellowNames[memberId] || memberId;
    const sysContent = hostChanged
      ? `${removedName} 离开了群，${removeFellowNames[newHost] || newHost} 成为群主`
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
      Object.assign(group, await window.aimashi.groups.appendMessage(group.id, sysMsg));
    } catch (e) {
      console.warn("[group] system bubble persist failed:", e);
    }
    msgs.push(sysMsg);
    triggerRender();
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
    if (typeof window.aimashiMarkdown?.escapeHtml === "function") return window.aimashiMarkdown.escapeHtml(value);
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
