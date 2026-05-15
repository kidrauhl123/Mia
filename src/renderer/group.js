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
    for (const memberId of group.members) {
      const item = document.createElement("div");
      item.className = "mention-item";
      item.textContent = "@" + (moduleState.fellowNamesById[memberId] || memberId);
      item.addEventListener("click", () => {
        const input = document.getElementById("group-input");
        const name = moduleState.fellowNamesById[memberId] || memberId;
        input.value = input.value + name + " ";
        picker.classList.add("hidden");
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
    await window.aimashi.groups.appendMessage(group.id, placeholderMsg);
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
    // T15 will implement the info drawer; for now just toggle a stub.
    const btn = document.getElementById("group-view-info");
    if (!btn) return;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    document.getElementById("group-view-info").addEventListener("click", () => {
      console.log("[group] info button clicked — T15 will implement drawer");
    });
  }

  global.aimashiGroup = {
    initGroupModule,
    renderGroupSidebarEntries,
    openGroup,
    bindCreateButton,
    openCreateDialog,
    moduleState,
  };
})(window);
