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
    renderGroupSidebarEntries();
    bindCreateButton();
    bindPersonaListWatcher();
  }

  function renderGroupSidebarEntries() {
    const container = document.getElementById("groupList");
    if (!container) return;
    container.innerHTML = "";
    for (const group of moduleState.groups) {
      const item = document.createElement("div");
      item.className = "sidebar-item group-item";
      item.dataset.groupId = group.id;
      item.addEventListener("click", () => openGroup(group.id));

      const avatar = document.createElement("div");
      avatar.className = "group-avatar composite";
      const memberAvatars = (group.members || []).slice(0, 4);
      for (const memberId of memberAvatars) {
        const sub = document.createElement("div");
        sub.className = "group-avatar-sub";
        sub.textContent = (moduleState.fellowNamesById[memberId] || "?")[0] || "?";
        avatar.appendChild(sub);
      }
      item.appendChild(avatar);

      const meta = document.createElement("div");
      meta.className = "sidebar-item-meta";
      const title = document.createElement("div");
      title.className = "sidebar-item-title";
      title.textContent = group.name;
      meta.appendChild(title);
      const memberLine = document.createElement("div");
      memberLine.className = "sidebar-item-subtitle";
      memberLine.textContent = (group.members || [])
        .map((id) => moduleState.fellowNamesById[id] || id)
        .join(", ");
      meta.appendChild(memberLine);
      item.appendChild(meta);

      container.appendChild(item);
    }
  }

  function bindCreateButton() {
    const btn = document.getElementById("createGroup");
    if (!btn) return;
    btn.disabled = false;
    btn.addEventListener("click", openCreateDialog);
  }

  function bindPersonaListWatcher() {
    if (moduleState.personaWatcherBound) return;
    const list = document.getElementById("personaList");
    if (!list) return;
    list.addEventListener("click", () => {
      // If user clicked a 1v1 persona, hide the group view and let app.js show chatView
      const view = document.getElementById("group-view");
      if (view && !view.classList.contains("hidden")) {
        view.classList.add("hidden");
        moduleState.activeGroupId = null;
        const chatView = document.getElementById("chatView");
        if (chatView) chatView.classList.remove("hidden");
      }
    });
    moduleState.personaWatcherBound = true;
  }

  function openCreateDialog() {
    const dialog = document.getElementById("group-create-dialog");
    if (!dialog) {
      console.error("[group] create dialog DOM missing");
      return;
    }
    const membersBox = document.getElementById("group-create-members");
    const hostSelect = document.getElementById("group-create-host");
    const nameInput = document.getElementById("group-create-name");
    const confirmBtn = document.getElementById("group-create-confirm");
    const cancelBtn = document.getElementById("group-create-cancel");

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

    membersBox.innerHTML = "";
    for (const fellow of moduleState.fellows) {
      const row = document.createElement("label");
      row.className = "checkbox-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = fellow.id || fellow.key;
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(fellow.id || fellow.key);
        else selected.delete(fellow.id || fellow.key);
        refreshHostOptions();
      });
      row.appendChild(cb);
      const label = document.createElement("span");
      label.textContent = fellow.name || fellow.id || fellow.key;
      row.appendChild(label);
      membersBox.appendChild(row);
    }

    nameInput.value = "";
    dialog.classList.remove("hidden");

    function cleanup() {
      dialog.classList.add("hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
    }

    function onCancel() { cleanup(); }

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
        renderGroupSidebarEntries();
        cleanup();
        openGroup(group.id);
      } catch (e) {
        alert("建群失败：" + (e && e.message ? e.message : String(e)));
      }
    }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  }

  async function openGroup(groupId) {
    const group = moduleState.groups.find((g) => g.id === groupId);
    if (!group) {
      console.warn("[group] openGroup: not found", groupId);
      return;
    }
    moduleState.activeGroupId = groupId;

    // Hide the 1v1 chat view (it's controlled by app.js)
    const chatView = document.getElementById("chatView");
    if (chatView) chatView.classList.add("hidden");

    // Hide any other view; show group view
    // (Other views are managed by app.js; we only flip our own.)
    const view = document.getElementById("group-view");
    if (!view) {
      console.error("[group] group-view DOM missing");
      return;
    }
    view.classList.remove("hidden");

    const titleEl = document.getElementById("group-view-title");
    if (titleEl) titleEl.textContent = group.name;

    const messages = await window.aimashi.groups.listMessages(groupId);
    moduleState.messagesByGroup.set(groupId, messages);
    renderGroupMessages(group, messages);
    bindComposer(group);
    bindInfoButton(group);
  }

  function renderGroupMessages(group, messages) {
    const list = document.getElementById("group-message-list");
    if (!list) return;
    list.innerHTML = "";
    for (const msg of messages) {
      const row = document.createElement("div");
      row.className = "group-msg group-msg-" + msg.role;
      if (msg.role === "fellow") {
        const name = moduleState.fellowNamesById[msg.senderFellowId] || msg.senderFellowId;
        const isHost = msg.senderFellowId === group.hostFellowId;
        const header = document.createElement("div");
        header.className = "group-msg-sender";
        header.textContent = name + (isHost ? " 👑" : "");
        row.appendChild(header);
      }
      const body = document.createElement("div");
      body.className = "group-msg-body";
      if (msg.status === "error") body.classList.add("error");
      body.textContent = msg.content || (msg.status === "streaming" ? "…" : "");
      row.appendChild(body);
      list.appendChild(row);
    }
    list.scrollTop = list.scrollHeight;
  }

  function bindComposer(group) {
    const send = document.getElementById("group-send");
    const input = document.getElementById("group-input");
    if (!send || !input) return;

    // Replace nodes to clear prior listeners (defensive)
    const freshSend = send.cloneNode(true);
    send.parentNode.replaceChild(freshSend, send);
    const freshInput = input.cloneNode(true);
    input.parentNode.replaceChild(freshInput, input);

    const sendBtn = document.getElementById("group-send");
    const inputEl = document.getElementById("group-input");

    sendBtn.addEventListener("click", () => sendInGroup(group));
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendInGroup(group);
      }
      if (e.key === "@") {
        // Show picker on next tick so the @ char registers in input
        setTimeout(() => showMentionPicker(group), 0);
      }
    });
  }

  function showMentionPicker(group) {
    const picker = document.getElementById("group-mention-picker");
    if (!picker) return;
    picker.innerHTML = "";

    function close() {
      picker.classList.add("hidden");
      document.removeEventListener("click", outsideClick, true);
      document.removeEventListener("keydown", escKey);
    }
    function outsideClick(e) {
      if (!picker.contains(e.target) && e.target.id !== "group-input") close();
    }
    function escKey(e) {
      if (e.key === "Escape") close();
    }

    for (const memberId of group.members) {
      const item = document.createElement("div");
      item.className = "mention-item";
      item.textContent = "@" + (moduleState.fellowNamesById[memberId] || memberId);
      item.addEventListener("click", () => {
        const input = document.getElementById("group-input");
        const name = moduleState.fellowNamesById[memberId] || memberId;
        input.value = input.value + name + " ";
        close();
        input.focus();
      });
      picker.appendChild(item);
    }
    // Position near the input
    const input = document.getElementById("group-input");
    if (input) {
      const rect = input.getBoundingClientRect();
      picker.style.left = (rect.left + 8) + "px";
      picker.style.top = (rect.top - 240) + "px";
    }
    picker.classList.remove("hidden");
    // Defer listener attachment so the current keydown doesn't immediately close it
    setTimeout(() => {
      document.addEventListener("click", outsideClick, true);
      document.addEventListener("keydown", escKey);
    }, 0);
  }

  async function sendInGroup(group) {
    const input = document.getElementById("group-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

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
    renderGroupMessages(group, msgs);

    // Dispatch decision
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
      renderGroupMessages(group, msgs);
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
    renderGroupMessages(group, msgs);

    try {
      const result = await window.aimashi.sendChat({
        fellowKey: fellowId,
        messages: [{ role: "user", content: userMsg.content }],
        group: { id: group.id, contextBlock },
      });
      // chat:send returns OpenAI-style chat completion. Extract content.
      placeholderMsg.content = extractAssistantContent(result);
      placeholderMsg.status = "complete";
    } catch (e) {
      placeholderMsg.content = "（响应失败：" + (e && e.message ? e.message : String(e)) + "）";
      placeholderMsg.status = "error";
    }
    // Persist the now-completed (or errored) message
    try {
      await window.aimashi.groups.appendMessage(group.id, placeholderMsg);
    } catch (e) {
      console.warn("[group] appendMessage failed for fellow " + fellowId + ":", e);
    }
    renderGroupMessages(group, msgs);
  }

  function extractAssistantContent(result) {
    // chat:send returns chatCompletionResponse / openai-like shape.
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

  function bindInfoButton(group) {
    const btn = document.getElementById("group-view-info");
    if (!btn) return;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    document.getElementById("group-view-info").addEventListener("click", () => openInfoDrawer(group));
  }

  function openInfoDrawer(group) {
    const drawer = document.getElementById("group-info-drawer");
    if (!drawer) {
      console.error("[group] info drawer DOM missing");
      return;
    }
    const membersBox = document.getElementById("group-info-members");
    const hostSelect = document.getElementById("group-info-host");
    const goalInput = document.getElementById("group-info-goal");
    const closeBtn = document.getElementById("group-info-close");
    const goalSaveBtn = document.getElementById("group-info-goal-save");
    const resetCtxBtn = document.getElementById("group-info-reset-ctx");
    const backdrop = drawer.querySelector(".drawer-backdrop");

    // Members
    membersBox.innerHTML = "";
    for (const memberId of group.members) {
      const row = document.createElement("div");
      row.className = "member-row";
      const name = document.createElement("span");
      name.textContent = (moduleState.fellowNamesById[memberId] || memberId) +
        (memberId === group.hostFellowId ? " 👑" : "");
      row.appendChild(name);
      if (group.members.length > 1) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.textContent = "移除";
        removeBtn.addEventListener("click", () => removeMember(group, memberId));
        row.appendChild(removeBtn);
      }
      membersBox.appendChild(row);
    }

    // Host select
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
      renderGroupMessages(group, moduleState.messagesByGroup.get(group.id) || []);
      openInfoDrawer(group); // refresh crown display
    };

    // Goal
    goalInput.value = (group.decorations && group.decorations.pinnedGoal) || "";
    goalSaveBtn.onclick = async () => {
      const goal = goalInput.value.trim();
      const decorations = { ...(group.decorations || {}), pinnedGoal: goal || null };
      group.decorations = decorations;
      try {
        await window.aimashi.groups.update(group.id, { decorations });
      } catch (e) {
        console.warn("[group] save goal failed:", e);
      }
    };

    // Reset context
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

    // Close
    function close() { drawer.classList.add("hidden"); }
    closeBtn.onclick = close;
    if (backdrop) backdrop.onclick = close;

    drawer.classList.remove("hidden");
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
    renderGroupMessages(group, msgs);

    if (newMembers.length === 1) {
      if (confirm("群里只剩 1 个 Fellow 了，转为单聊？")) {
        // v1: 不实现自动迁移，仅提示
        alert("请直接打开单聊和该 Fellow 对话。");
      }
    }
    openInfoDrawer(group); // refresh
  }

  global.aimashiGroup = {
    initGroupModule,
    renderGroupSidebarEntries,
    openGroup,
    bindCreateButton,
    openCreateDialog,
    openInfoDrawer,
    removeMember,
    moduleState,
  };
})(window);
