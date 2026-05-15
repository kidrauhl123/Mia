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

  function openGroup(groupId) {
    // T14 will implement the group chat view; for now log only.
    console.log("[group] open group", groupId, "— T14 will implement view");
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
