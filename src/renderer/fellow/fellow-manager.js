// Fellow manager module
// Extracted from app.js. Contains the contact-list / contact-detail view,
// the per-fellow capability panel (plugins + skills + connectors), and the
// fellow right-click context menu. Heavy renderer-only module — no IPC of
// its own beyond what's injected.
//
// Defensive `if (!state || !els)` guards on every entry point.
(function () {
  "use strict";

  let state, els;
  let setText, formatConversationTime, hasPersistableMessages, sessionsForPersona;
  let loadSkills, showNarrowContent, render;
  let closeGroupContextMenu, openEditFellowDialog, deleteFellow, setFellowPinned;

  function initFellowManager(deps) {
    state = deps.state;
    els = deps.els;
    setText = deps.setText;
    formatConversationTime = deps.formatConversationTime;
    hasPersistableMessages = deps.hasPersistableMessages;
    sessionsForPersona = deps.sessionsForPersona;
    loadSkills = deps.loadSkills;
    showNarrowContent = deps.showNarrowContent;
    render = deps.render;
    closeGroupContextMenu = deps.closeGroupContextMenu;
    openEditFellowDialog = deps.openEditFellowDialog;
    deleteFellow = deps.deleteFellow;
    setFellowPinned = deps.setFellowPinned;
  }

  function fellowByKey(key) {
    if (!state) return null;
    const fellows = state.runtime?.fellows || state.runtime?.personas || [];
    return fellows.find((item) => item.key === key) || null;
  }

  function sortFellowsForSidebar(fellows = []) {
    return fellows
      .map((fellow, index) => ({ fellow, index }))
      .sort((a, b) => {
        const pinnedDiff = Number(Boolean(b.fellow.pinned)) - Number(Boolean(a.fellow.pinned));
        if (pinnedDiff) return pinnedDiff;
        if (a.fellow.pinned && b.fellow.pinned) {
          const timeDiff = String(b.fellow.pinnedAt || "").localeCompare(String(a.fellow.pinnedAt || ""));
          if (timeDiff) return timeDiff;
        }
        return a.index - b.index;
      })
      .map((item) => item.fellow);
  }

  function sortableConversationTime(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function sortMessageCardsForSidebar(rows = []) {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const pinnedDiff = Number(Boolean(b.row.pinned)) - Number(Boolean(a.row.pinned));
        if (pinnedDiff) return pinnedDiff;
        if (a.row.pinned && b.row.pinned) {
          const timeDiff = sortableConversationTime(b.row.pinnedAt) - sortableConversationTime(a.row.pinnedAt);
          if (timeDiff) return timeDiff;
        }
        const updatedDiff = sortableConversationTime(b.row.updatedAt) - sortableConversationTime(a.row.updatedAt);
        if (updatedDiff) return updatedDiff;
        return a.index - b.index;
      })
      .map((item) => item.row);
  }

  function contactSessionSummary(fellow) {
    if (!state) return { count: 0, preview: "", time: "" };
    const sessions = state.chatStore.sessions[fellow.key] || [];
    const meaningful = sessions.filter(hasPersistableMessages);
    const latest = sessions[0];
    const messages = latest?.messages || [];
    const last = [...messages].reverse().find((message) => String(message.content || "").trim() && !message.transient);
    const preview = last
      ? String(last.content || "")
      : (fellow.bio || "本地伙伴 · 暂无对话");
    return {
      count: meaningful.length || sessions.length,
      preview,
      time: formatConversationTime(latest?.updatedAt || latest?.createdAt)
    };
  }

  function contactPetLabel(pet = {}) {
    if (pet.placed) return "桌面中";
    if (pet.hasAsset) return "已生成桌宠";
    return "";
  }

  function openFellowChat(fellowKey) {
    if (!fellowKey || !state || !els) return;
    state.activeKey = fellowKey;
    state.activeContactKey = fellowKey;
    const latest = sessionsForPersona(fellowKey)[0];
    state.activeSessionIdByPersona[fellowKey] = latest?.id;
    state.activeView = "chat";
    state.sessionMenuOpen = false;
    window.aimashiSessionReadState.markPersonaRead(fellowKey);
    showNarrowContent();
    render();
    requestAnimationFrame(() => els.chatInput?.focus());
  }

  function defaultFellowCapabilities() {
    return {
      inheritEngineDefaults: true,
      enabledPlugins: [],
      disabledPlugins: [],
      enabledSkills: [],
      disabledSkills: [],
      enabledConnectors: []
    };
  }

  function normalizeCapabilityIds(input) {
    return Array.isArray(input)
      ? [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))]
      : [];
  }

  function fellowCapabilities(fellow = {}) {
    const raw = fellow.capabilities && typeof fellow.capabilities === "object" ? fellow.capabilities : {};
    return {
      ...defaultFellowCapabilities(),
      inheritEngineDefaults: raw.inheritEngineDefaults !== false && raw.inherit_engine_defaults !== false,
      enabledPlugins: normalizeCapabilityIds(raw.enabledPlugins || raw.enabled_plugins),
      disabledPlugins: normalizeCapabilityIds(raw.disabledPlugins || raw.disabled_plugins),
      enabledSkills: normalizeCapabilityIds(raw.enabledSkills || raw.enabled_skills),
      disabledSkills: normalizeCapabilityIds(raw.disabledSkills || raw.disabled_skills),
      enabledConnectors: normalizeCapabilityIds(raw.enabledConnectors || raw.enabled_connectors)
    };
  }

  function capabilityForEngine(item = {}, engine = "") {
    const itemEngine = String(item.engine || item.provider || "").trim();
    return !itemEngine || itemEngine === "aimashi" || itemEngine === engine || (engine === "hermes" && item.source === "hermes");
  }

  function engineLabel(engine = "") {
    if (engine === "aimashi") return "Aimashi";
    if (engine === "claude-code") return "Claude Code";
    if (engine === "codex") return "Codex";
    return "Hermes";
  }

  function fellowCapabilityItems(fellow = {}) {
    if (!state) return { plugins: [], skills: [], connectors: [] };
    const engine = fellow.agentEngine || fellow.agent_engine || "hermes";
    const plugins = (state.skillLibrary.extensions || [])
      .filter((item) => item.installState === "installed" && capabilityForEngine(item, engine))
      .slice(0, 24);
    const skills = (state.skillLibrary.skills || [])
      .filter((item) => capabilityForEngine(item, engine))
      .slice(0, 32);
    const connectors = (state.skillLibrary.connectors || [])
      .filter((item) => capabilityForEngine(item, engine))
      .slice(0, 16);
    return { plugins, skills, connectors };
  }

  function capabilityChecked(capabilities, id, enabledKey, disabledKey) {
    if (capabilities.inheritEngineDefaults) return !capabilities[disabledKey].includes(id);
    return capabilities[enabledKey].includes(id);
  }

  function renderCapabilityCheckbox({ item, checked, disabled, type }) {
    const title = item.label || item.name || item.id;
    const meta = item.engineLabel || item.sourceLabel || item.category || item.status || "";
    return `
      <label class="capability-row">
        <input type="checkbox" data-capability-type="${window.aimashiMarkdown.escapeHtml(type)}" data-capability-id="${window.aimashiMarkdown.escapeHtml(item.id)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
        <span>
          <strong>${window.aimashiMarkdown.escapeHtml(title)}</strong>
          ${meta ? `<small>${window.aimashiMarkdown.escapeHtml(meta)}</small>` : ""}
        </span>
      </label>
    `;
  }

  function renderFellowCapabilitiesPanel(fellow) {
    const capabilities = fellowCapabilities(fellow);
    const { plugins, skills, connectors } = fellowCapabilityItems(fellow);
    const disabled = capabilities.inheritEngineDefaults;
    const engine = fellow.agentEngine || fellow.agent_engine || "hermes";
    return `
      <section class="contact-capabilities">
        <header>
          <div>
            <strong>能力</strong>
            <p>${window.aimashiMarkdown.escapeHtml(engineLabel(engine))} · ${plugins.length} 插件 · ${skills.length} 技能 · ${connectors.length} 连接</p>
          </div>
          <label class="capability-default-toggle">
            <input type="checkbox" data-capability-default ${capabilities.inheritEngineDefaults ? "checked" : ""}>
            <span>使用引擎默认能力</span>
          </label>
        </header>
        <div class="capability-columns${disabled ? " inherited" : ""}">
          <section>
            <h3>插件</h3>
            ${plugins.length ? plugins.map((item) => renderCapabilityCheckbox({
              item,
              checked: capabilityChecked(capabilities, item.id, "enabledPlugins", "disabledPlugins"),
              disabled,
              type: "plugin"
            })).join("") : `<div class="capability-empty">当前引擎没有已安装插件</div>`}
          </section>
          <section>
            <h3>技能</h3>
            ${skills.length ? skills.map((item) => renderCapabilityCheckbox({
              item,
              checked: capabilityChecked(capabilities, item.id, "enabledSkills", "disabledSkills"),
              disabled,
              type: "skill"
            })).join("") : `<div class="capability-empty">当前引擎没有可选技能</div>`}
          </section>
          <section>
            <h3>应用连接</h3>
            ${connectors.length ? connectors.map((item) => renderCapabilityCheckbox({
              item,
              checked: capabilities.enabledConnectors.includes(item.id),
              disabled,
              type: "connector"
            })).join("") : `<div class="capability-empty">没有发现连接配置</div>`}
          </section>
        </div>
      </section>
    `;
  }

  function renderContacts() {
    if (!state || !els || !els.contactList || !els.contactDetail) return;
    if (!state.skillsLoading && !(state.skillLibrary.extensions || []).length && !(state.skillLibrary.skills || []).length) {
      loadSkills().catch(() => {});
    }
    const fellows = state.runtime?.fellows || state.runtime?.personas || [];
    if (!fellows.length) {
      els.contactList.innerHTML = `<div class="contact-empty">还没有联系人</div>`;
      els.contactDetail.innerHTML = `<div class="contact-empty detail-empty">添加一个伙伴后会显示在这里</div>`;
      return;
    }
    if (!fellows.some((fellow) => fellow.key === state.activeContactKey)) {
      state.activeContactKey = fellows[0].key;
    }
    const filter = state.contactFilter.trim().toLowerCase();
    const visibleContacts = sortFellowsForSidebar(filter
      ? fellows.filter((fellow) => `${fellow.name || ""} ${fellow.key || ""} ${fellow.bio || ""}`.toLowerCase().includes(filter))
      : fellows);
    els.contactList.innerHTML = "";
    for (const fellow of visibleContacts) {
      const summary = contactSessionSummary(fellow);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `contact-row${fellow.key === state.activeContactKey ? " active" : ""}`;
      button.innerHTML = `
        <span class="avatar fellow-photo" style="${window.aimashiAvatar.avatarThumbBackgroundStyle(fellow.avatarImage || window.aimashiAvatar.avatarAssetForKey(fellow.key), fellow.avatarCrop, fellow.color || "#5e5ce6")}"></span>
        <span class="contact-row-main">
          <strong>${window.aimashiMarkdown.escapeHtml(fellow.name)}</strong>
          <small>${window.aimashiMarkdown.escapeHtml(fellow.bio || "本地伙伴")}</small>
        </span>
        <span class="contact-row-side">${window.aimashiMarkdown.escapeHtml(summary.time || "")}</span>
      `;
      button.addEventListener("click", () => {
        state.activeContactKey = fellow.key;
        showNarrowContent();
        renderContacts();
      });
      button.addEventListener("dblclick", () => openFellowChat(fellow.key));
      els.contactList.appendChild(button);
    }
    if (!visibleContacts.length) {
      els.contactList.innerHTML = `<div class="contact-empty">没有匹配的联系人</div>`;
    }
    renderContactDetail(fellows.find((fellow) => fellow.key === state.activeContactKey) || visibleContacts[0] || fellows[0]);
  }

  function renderContactDetail(fellow) {
    if (!state || !els || !els.contactDetail || !fellow) return;
    const summary = contactSessionSummary(fellow);
    const engine = fellow.agentEngine || fellow.agent_engine || fellow.engine || "hermes";
    setText(els.contactPageTitle, fellow.name || "联系人");
    setText(els.contactPageMeta, `${summary.count} 个会话`);
    els.contactDetail.innerHTML = `
      <article class="contact-profile">
        <header class="contact-profile-head">
          <button class="contact-profile-avatar" type="button" data-contact-action="edit" title="编辑联系人头像" style="${window.aimashiAvatar.avatarBackgroundStyle(fellow.avatarImage || window.aimashiAvatar.avatarAssetForKey(fellow.key), fellow.avatarCrop, fellow.color || "#5e5ce6")}"></button>
          <div class="contact-profile-title">
            <h2>${window.aimashiMarkdown.escapeHtml(fellow.name || "联系人")}</h2>
            <div class="contact-engine-badge" title="Agent 引擎">
              <span>Agent</span>
              <strong>${window.aimashiMarkdown.escapeHtml(engineLabel(engine))}</strong>
            </div>
            <p>${window.aimashiMarkdown.escapeHtml(fellow.bio || "本地伙伴")}</p>
          </div>
          <div class="contact-actions">
            <button class="primary contact-message-action" type="button" data-contact-action="message" title="发消息" aria-label="发消息">${window.aimashiMarkdown.iconParkIcon("message", "contact-action-icon")}</button>
            <button class="secondary" type="button" data-contact-action="edit">编辑</button>
            ${fellow.key === "aimashi" ? "" : `<button class="secondary danger" type="button" data-contact-action="delete">删除伙伴</button>`}
          </div>
        </header>
        <section class="contact-note">
          <strong>最近内容</strong>
          <p>${window.aimashiMarkdown.escapeHtml(summary.preview)}</p>
        </section>
        ${renderFellowCapabilitiesPanel(fellow)}
      </article>
    `;
    els.contactDetail.querySelector('[data-contact-action="message"]')?.addEventListener("click", () => openFellowChat(fellow.key));
    els.contactDetail.querySelectorAll('[data-contact-action="edit"]').forEach((button) => {
      button.addEventListener("click", () => openEditFellowDialog(fellow.key));
    });
    els.contactDetail.querySelector('[data-contact-action="delete"]')?.addEventListener("click", async () => {
      await deleteFellow(fellow.key);
    });
    wireFellowCapabilities(fellow);
  }

  async function saveFellowCapabilities(fellow, capabilities) {
    if (!fellow?.key || !state) return;
    state.savingFellowCapabilities.add(fellow.key);
    try {
      state.runtime = await window.aimashi.saveFellow({
        ...fellow,
        capabilities
      });
    } catch (error) {
      window.alert(`保存能力设置失败：${error.message || error}`);
    } finally {
      state.savingFellowCapabilities.delete(fellow.key);
      renderContacts();
    }
  }

  function toggleCapabilityId(capabilities, id, enabledKey, disabledKey, checked) {
    const next = {
      ...capabilities,
      [enabledKey]: [...capabilities[enabledKey]],
      [disabledKey]: [...capabilities[disabledKey]]
    };
    if (next.inheritEngineDefaults) {
      next[disabledKey] = checked
        ? next[disabledKey].filter((item) => item !== id)
        : [...new Set([...next[disabledKey], id])];
    } else {
      next[enabledKey] = checked
        ? [...new Set([...next[enabledKey], id])]
        : next[enabledKey].filter((item) => item !== id);
    }
    return next;
  }

  function wireFellowCapabilities(fellow) {
    if (!els || !els.contactDetail || !fellow) return;
    const defaultToggle = els.contactDetail.querySelector("[data-capability-default]");
    defaultToggle?.addEventListener("change", async () => {
      const capabilities = fellowCapabilities(fellow);
      capabilities.inheritEngineDefaults = Boolean(defaultToggle.checked);
      await saveFellowCapabilities(fellow, capabilities);
    });
    els.contactDetail.querySelectorAll("[data-capability-type][data-capability-id]").forEach((input) => {
      input.addEventListener("change", async () => {
        const id = input.dataset.capabilityId || "";
        const type = input.dataset.capabilityType || "";
        let capabilities = fellowCapabilities(fellow);
        if (type === "plugin") {
          capabilities = toggleCapabilityId(capabilities, id, "enabledPlugins", "disabledPlugins", input.checked);
        } else if (type === "skill") {
          capabilities = toggleCapabilityId(capabilities, id, "enabledSkills", "disabledSkills", input.checked);
        } else if (type === "connector") {
          capabilities.enabledConnectors = input.checked
            ? [...new Set([...capabilities.enabledConnectors, id])]
            : capabilities.enabledConnectors.filter((item) => item !== id);
        }
        await saveFellowCapabilities(fellow, capabilities);
      });
    });
  }

  function petStatusForKey(key) {
    return state?.runtime?.pets?.[key] || { hasAsset: false, placed: false, petId: "" };
  }

  function openFellowContextMenu(fellowKey, x, y) {
    if (!fellowKey || !state) return;
    window.aimashiMessageMenu?.closeMessageContextMenu();
    closeGroupContextMenu();
    state.fellowContextMenu = { open: true, x, y, fellowKey };
    renderFellowContextMenu();
  }

  function closeFellowContextMenu() {
    if (!state || !state.fellowContextMenu.open) return;
    state.fellowContextMenu = { open: false, x: 0, y: 0, fellowKey: "" };
    renderFellowContextMenu();
  }

  function renderFellowContextMenu() {
    if (!state || !els || !els.fellowContextMenu) return;
    const menu = els.fellowContextMenu;
    const fellow = fellowByKey(state.fellowContextMenu.fellowKey);
    const open = state.fellowContextMenu.open && fellow;
    menu.classList.toggle("hidden", !open);
    if (!open) return;
    const pet = petStatusForKey(fellow.key);
    const petAction = pet.hasAsset
      ? pet.placed
        ? window.aimashiMarkdown.menuItemHtml({ icon: "message", label: `收回「${fellow.name}」`, attrs: 'data-fellow-action="recall"' })
        : window.aimashiMarkdown.menuItemHtml({ icon: "message", label: "放进桌面", attrs: 'data-fellow-action="place"' })
      : window.aimashiMarkdown.menuItemHtml({ icon: "addPic", label: "生成桌宠", attrs: 'data-fellow-action="generate-pet"' });
    menu.innerHTML = `
      ${window.aimashiMarkdown.menuItemHtml({ icon: "pin", label: fellow.pinned ? "取消置顶" : "置顶", attrs: 'data-fellow-action="pin"' })}
      ${window.aimashiMarkdown.menuItemHtml({ icon: "edit", label: "编辑", attrs: 'data-fellow-action="edit"' })}
      ${petAction}
      ${fellow.key === "aimashi" ? "" : `<div class="skill-context-menu-separator" role="separator"></div>${window.aimashiMarkdown.menuItemHtml({ icon: "delete", label: "删除伙伴", attrs: 'data-fellow-action="delete"', className: "danger" })}`}
    `;
    const rect = menu.getBoundingClientRect();
    const width = rect.width || 138;
    const height = rect.height || (fellow.key === "aimashi" ? 114 : 158);
    menu.style.left = `${Math.max(8, Math.min(state.fellowContextMenu.x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(state.fellowContextMenu.y, window.innerHeight - height - 8))}px`;
    menu.querySelector('[data-fellow-action="edit"]')?.addEventListener("click", () => {
      closeFellowContextMenu();
      openEditFellowDialog(fellow.key);
    });
    menu.querySelector('[data-fellow-action="pin"]')?.addEventListener("click", async () => {
      closeFellowContextMenu();
      await setFellowPinned(fellow.key, !fellow.pinned);
    });
    menu.querySelector('[data-fellow-action="generate-pet"]')?.addEventListener("click", () => {
      closeFellowContextMenu();
      window.aimashiPetDialog?.openPetGenerateDialog(fellow.key);
    });
    menu.querySelector('[data-fellow-action="place"]')?.addEventListener("click", async () => {
      closeFellowContextMenu();
      await window.aimashiPetDialog?.placeFellowPet(fellow.key);
    });
    menu.querySelector('[data-fellow-action="recall"]')?.addEventListener("click", async () => {
      closeFellowContextMenu();
      await window.aimashiPetDialog?.recallFellowPet(fellow.key);
    });
    menu.querySelector('[data-fellow-action="delete"]')?.addEventListener("click", async () => {
      closeFellowContextMenu();
      await deleteFellow(fellow.key);
    });
  }

  window.aimashiFellowManager = {
    initFellowManager,
    fellowByKey,
    sortFellowsForSidebar,
    sortableConversationTime,
    sortMessageCardsForSidebar,
    contactSessionSummary,
    contactPetLabel,
    openFellowChat,
    defaultFellowCapabilities,
    normalizeCapabilityIds,
    fellowCapabilities,
    capabilityForEngine,
    engineLabel,
    fellowCapabilityItems,
    capabilityChecked,
    renderCapabilityCheckbox,
    renderFellowCapabilitiesPanel,
    renderContacts,
    renderContactDetail,
    saveFellowCapabilities,
    toggleCapabilityId,
    wireFellowCapabilities,
    petStatusForKey,
    openFellowContextMenu,
    closeFellowContextMenu,
    renderFellowContextMenu,
  };
})();
