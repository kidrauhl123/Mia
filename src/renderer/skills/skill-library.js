// Skill library UI module
// Extracted from app.js (formerly lines 2085-2574, minus syncTopbarClickCapture
// which is cross-domain — shared with group & session menus — and stays in app.js).
//
// Covers the entire Skill view: directory sidebar, filter chips, card grid,
// per-extension detail, selectSkill flow, preview pane, and context menu.
// Data helpers (skillTone, skillDisplayName, skillSummaryZh, markdown renderers,
// etc.) live in skill-helpers.js — this module consumes them via window.aimashiSkillHelpers.
//
// Defensive `if (!state || !els)` guards on the entry points keep early calls safe.
(function () {
  "use strict";

  let state, els, aimashi;
  let escapeHtml, setText, menuItemHtml;
  let syncTopbarClickCapture;
  let closeGroupContextMenu, showNarrowContent;
  let installExtension, deleteSkill, openSkillDirectory;

  function initSkillLibrary(deps) {
    state = deps.state;
    els = deps.els;
    aimashi = deps.aimashi || (typeof window !== "undefined" ? window.aimashi : null);
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
    menuItemHtml = deps.menuItemHtml;
    syncTopbarClickCapture = deps.syncTopbarClickCapture;
    closeGroupContextMenu = deps.closeGroupContextMenu;
    showNarrowContent = deps.showNarrowContent;
    installExtension = deps.installExtension;
    deleteSkill = deps.deleteSkill;
    openSkillDirectory = deps.openSkillDirectory;
  }

  function skillSourceStatusBase() {
    if (!state) return [];
    return (state.skillLibrary.skills || []).filter((skill) => {
      if (state.skillPluginFilter && skill.pluginId !== state.skillPluginFilter) return false;
      if (state.skillStatusFilter === "updates" && !window.aimashiSkillHelpers.skillHasUpdate(skill)) return false;
      return true;
    });
  }

  function skillMatchesFilters(skill) {
    if (!state) return false;
    const needle = state.skillFilter.trim().toLowerCase();
    const category = state.skillCategoryFilter.trim().toLowerCase();
    const haystack = [
      skill.name,
      skill.title,
      skill.description,
      window.aimashiSkillHelpers.skillDisplayName(skill),
      window.aimashiSkillHelpers.skillSummaryZh(skill),
      skill.category,
      skill.sourceLabel,
      skill.relPath,
      ...(skill.tags || [])
    ].join(" ").toLowerCase();
    if (state.skillPluginFilter && skill.pluginId !== state.skillPluginFilter) return false;
    if (state.skillStatusFilter === "updates" && !window.aimashiSkillHelpers.skillHasUpdate(skill)) return false;
    return (!needle || haystack.includes(needle)) && (!category || String(skill.category || "") === category);
  }

  function visibleSkills() {
    if (!state) return [];
    return (state.skillLibrary.skills || []).filter(skillMatchesFilters);
  }

  function skillCategories() {
    const counts = new Map();
    for (const skill of skillSourceStatusBase()) {
      const category = skill.category || "uncategorized";
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  async function selectSkill(skillId, openPreview = true) {
    if (!skillId || !state) return;
    state.selectedSkillId = skillId;
    const listed = state.skillLibrary.skills.find((skill) => skill.id === skillId);
    state.selectedSkillDetail = listed || null;
    if (openPreview) state.skillPreviewOpen = true;
    renderSkillLibrary();
    renderSkillPreview();
    try {
      state.selectedSkillDetail = await window.aimashi.readSkill(skillId);
    } catch (error) {
      console.error("Failed to read skill", error);
    }
    renderSkillLibrary();
    renderSkillPreview();
  }

  function renderSkillFilterRow(row) {
    const active = state.skillLibraryMode === "skills" && state.skillPluginFilter === row.pluginId && state.skillStatusFilter === row.status;
    return `
      <button class="skill-filter-row${row.child ? " child" : ""}${active ? " active" : ""}" type="button" data-skill-plugin="${escapeHtml(row.pluginId)}" data-skill-status="${escapeHtml(row.status)}">
        <span><strong>${escapeHtml(row.label)}</strong>${row.sub ? `<small>${escapeHtml(row.sub)}</small>` : ""}</span>
        <em>${row.count}</em>
      </button>
    `;
  }

  function renderExtensionNavRow(extension) {
    const active = state.skillLibraryMode === "extension" && state.selectedExtensionId === extension.id;
    return `
      <button class="skill-filter-row${active ? " active" : ""}" type="button" data-skill-extension="${escapeHtml(extension.id)}">
        <span>
          <strong>${escapeHtml(extension.label || extension.name)}</strong>
          <small>${escapeHtml(extension.engineLabel || extension.source || "Plugin")} · ${escapeHtml(extension.capabilitySummary || extension.status || "已发现")}</small>
        </span>
        <em>${escapeHtml(String(extension.skillCount || extension.commandCount || extension.toolCount || ""))}</em>
      </button>
    `;
  }

  function extensionDetailMeta(extension) {
    return [
      extension.engineLabel || extension.engine || "",
      extension.version ? `v${extension.version}` : "",
      extension.status || ""
    ].filter(Boolean).join(" · ");
  }

  function renderExtensionDetail(extension) {
    const relatedSkills = (state.skillLibrary.skills || []).filter((skill) => skill.extensionId === extension.id);
    const installing = state.installingExtensions.has(extension.id);
    const action = extension.installState === "installed"
      ? `<button class="extension-action installed" type="button" disabled aria-label="已安装">✓</button>`
      : extension.installable
        ? `<button class="extension-action" type="button" data-extension-install="${escapeHtml(extension.id)}" ${installing ? "disabled" : ""} aria-label="安装 ${escapeHtml(extension.label || extension.name || "插件")}">${installing ? "…" : "+"}</button>`
        : `<button class="extension-action unavailable" type="button" disabled title="${escapeHtml(extension.status || "暂不支持一键安装")}" aria-label="暂不支持一键安装">–</button>`;
    const stats = [
      ["Skills", extension.skillCount],
      ["Commands", extension.commandCount],
      ["Agents", extension.agentCount],
      ["Tools", extension.toolCount],
      ["Hooks", extension.hookCount],
      ["MCP", extension.mcpCount]
    ].filter(([, value]) => Number(value) > 0);
    return `
      <article class="extension-detail">
        <header>
          <div>
            <small>${escapeHtml(extension.engineLabel || "Plugin")}</small>
            <h2>${escapeHtml(extension.label || extension.name)}</h2>
            <p>${escapeHtml(extension.description || "")}</p>
          </div>
          <div class="extension-detail-actions">
            <span>${escapeHtml(extension.installState === "installed" ? "已安装" : (extension.status || "可安装"))}</span>
            ${action}
          </div>
        </header>
        <dl class="extension-detail-grid">
          <div><dt>状态</dt><dd>${escapeHtml(extension.status || "已发现")}</dd></div>
          <div><dt>路径</dt><dd title="${escapeHtml(extension.root || "")}">${escapeHtml(extension.root || "未知")}</dd></div>
          ${extension.pluginKind ? `<div><dt>类型</dt><dd>${escapeHtml(extension.pluginKind)}</dd></div>` : ""}
          ${stats.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}
        </dl>
        <section class="extension-skill-list">
          <h3>包含的 Skill</h3>
          ${relatedSkills.length ? relatedSkills.map((skill) => `
            <button type="button" data-skill-select="${escapeHtml(skill.id)}">
              <strong>${escapeHtml(window.aimashiSkillHelpers.skillDisplayName(skill))}</strong>
              <small>${escapeHtml(skill.category || skill.name || "Skill")}</small>
            </button>
          `).join("") : `<div class="skill-empty-state compact">这个插件没有可扫描到的 SKILL.md</div>`}
        </section>
      </article>
    `;
  }

  function directorySectionRows() {
    const skills = state.skillLibrary.skills || [];
    const connectors = state.skillLibrary.connectors || [];
    const extensions = state.skillLibrary.extensions || [];
    const available = extensions.filter((extension) => extension.installState !== "installed").length;
    return [
      { id: "plugins", label: "插件", sub: available ? `${available} 个可安装，${extensions.length - available} 个已安装` : "已安装或已发现的能力包", count: extensions.length },
      { id: "skills", label: "技能", sub: "本机可调用的 SKILL.md 能力", count: skills.length },
      { id: "connectors", label: "应用连接", sub: "Aimashi 自己管理的外部连接", count: connectors.length }
    ];
  }

  function renderDirectorySectionRow(row) {
    const active = state.directorySection === row.id;
    return `
      <button class="skill-filter-row${active ? " active" : ""}" type="button" data-directory-section="${escapeHtml(row.id)}">
        <span><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.sub)}</small></span>
        <em>${escapeHtml(String(row.count || 0))}</em>
      </button>
    `;
  }

  function directoryHaystack(item = {}) {
    return [
      item.label,
      item.name,
      item.description,
      item.status,
      item.source,
      item.sourceLabel,
      item.provider,
      item.engine,
      item.engineLabel,
      item.kind,
      item.scope,
      item.path,
      item.root,
      item.capabilitySummary
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function visibleConnectors() {
    const needle = state.skillFilter.trim().toLowerCase();
    const type = state.skillCategoryFilter.trim().toLowerCase();
    return (state.skillLibrary.connectors || []).filter((connector) => {
      if (type && String(connector.kind || "").toLowerCase() !== type) return false;
      return !needle || directoryHaystack(connector).includes(needle);
    });
  }

  function visibleExtensions() {
    const needle = state.skillFilter.trim().toLowerCase();
    const engine = state.skillCategoryFilter.trim().toLowerCase();
    return (state.skillLibrary.extensions || []).filter((extension) => {
      if (engine && String(extension.engine || "").toLowerCase() !== engine) return false;
      return !needle || directoryHaystack(extension).includes(needle);
    });
  }

  function countBy(items, keyFn) {
    const counts = new Map();
    for (const item of items) {
      const key = keyFn(item);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function renderConnectorCard(connector) {
    return `
      <article class="skill-card connector-card">
        <header>
          <strong>${escapeHtml(connector.label || connector.name || "应用连接")}</strong>
          <small>${escapeHtml([connector.sourceLabel || connector.source || "Local", connector.status || ""].filter(Boolean).join(" · "))}</small>
        </header>
        <p>${escapeHtml(connector.description || "本机真实发现的外部应用或 MCP 连接配置。")}</p>
        <footer>
          <span>${escapeHtml(connector.kind || "连接")}</span>
          ${connector.scope ? `<span>${escapeHtml(connector.scope)}</span>` : ""}
        </footer>
      </article>
    `;
  }

  function renderPluginCard(extension) {
    const installing = state.installingExtensions.has(extension.id);
    const action = extension.installState === "installed"
      ? `<button class="extension-action installed" type="button" disabled title="已安装" aria-label="已安装">✓</button>`
      : extension.installable
        ? `<button class="extension-action" type="button" data-extension-install="${escapeHtml(extension.id)}" ${installing ? "disabled" : ""} title="安装" aria-label="安装 ${escapeHtml(extension.label || extension.name || "插件")}">${installing ? "…" : "+"}</button>`
        : `<button class="extension-action unavailable" type="button" disabled title="${escapeHtml(extension.status || "暂不支持一键安装")}" aria-label="暂不支持一键安装">–</button>`;
    const iconLabel = window.aimashiSkillHelpers.skillInitials(extension.label || extension.name || extension.engineLabel || "Plugin");
    const icon = extension.iconUrl
      ? `<span class="plugin-icon"><img src="${escapeHtml(extension.iconUrl)}" alt="" loading="lazy"></span>`
      : `<span class="plugin-icon fallback ${escapeHtml(extension.engine || "plugin")}" aria-hidden="true">${escapeHtml(iconLabel)}</span>`;
    return `
      <article class="skill-card plugin-card${extension.id === state.selectedExtensionId ? " featured" : ""}" data-extension-select="${escapeHtml(extension.id)}">
        <header>
          ${icon}
          <div>
            <strong>${escapeHtml(extension.label || extension.name || "Plugin")}</strong>
            <p>${escapeHtml(extension.description || "")}</p>
          </div>
          ${action}
        </header>
      </article>
    `;
  }

  function skillEmptyText() {
    if (state.skillsLoading) return "正在扫描本地 Skill...";
    if (state.skillStatusFilter === "updates") return "当前没有可更新的 Skill";
    return "没有匹配的 Skill";
  }

  function renderSkillLibrary() {
    if (!state || !els || !els.skillNav || !els.skillCardGrid) return;
    const skills = state.skillLibrary.skills || [];
    const extensions = state.skillLibrary.extensions || [];
    const connectors = state.skillLibrary.connectors || [];
    if ((state.directorySection || "plugins") === "skills" && state.skillPluginFilter) {
      state.skillPluginFilter = "";
      state.skillStatusFilter = "all";
    }
    const shown = visibleSkills();
    const totalCount = skills.length;
    const activeExtension = extensions.find((extension) => extension.id === state.selectedExtensionId);
    const section = state.directorySection || "plugins";
    setText(
      els.skillPageTitle,
      state.skillsLoading
        ? "正在扫描能力"
        : section === "plugins" && state.skillLibraryMode === "extension" && activeExtension
          ? activeExtension.label || activeExtension.name
          : section === "connectors"
            ? "应用连接"
            : section === "plugins"
              ? "插件"
              : "技能"
    );

    if (section === "connectors") {
      const connectorKinds = countBy(connectors, (connector) => connector.kind || "connector");
      els.skillChipRow.innerHTML = [
        `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
        ...connectorKinds.map(([kind, count]) => `
          <button class="${state.skillCategoryFilter === kind ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(kind)}">
            ${escapeHtml(kind)} <span>${count}</span>
          </button>
        `)
      ].join("");
    } else if (section === "plugins" && state.skillLibraryMode === "extension" && activeExtension) {
      els.skillChipRow.innerHTML = `
        <button class="active" type="button" data-skill-filter="">插件详情</button>
        <button type="button" data-skill-filter="">${escapeHtml(activeExtension.engineLabel || activeExtension.engine || "Plugin")}</button>
        ${activeExtension.capabilitySummary ? `<button type="button" data-skill-filter="">${escapeHtml(activeExtension.capabilitySummary)}</button>` : ""}
      `;
    } else if (section === "plugins") {
      const engines = countBy(extensions, (extension) => extension.engine || extension.source || "plugin");
      els.skillChipRow.innerHTML = [
        `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
        ...engines.map(([engine, count]) => `
          <button class="${state.skillCategoryFilter === engine ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(engine)}">
            ${escapeHtml(engine)} <span>${count}</span>
          </button>
        `)
      ].join("");
    } else {
      const categories = skillCategories();
      els.skillChipRow.innerHTML = [
        `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
        ...categories.slice(0, 10).map(([category, count]) => `
          <button class="${state.skillCategoryFilter === category ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(category)}">
            ${escapeHtml(category)} <span>${count}</span>
          </button>
        `)
      ].join("");
    }

    els.skillNav.innerHTML = `
      <div class="skill-section-label">Directory</div>
      ${directorySectionRows().map((row) => renderDirectorySectionRow(row)).join("")}
    `;

    if (section === "connectors") {
      const visible = visibleConnectors();
      els.skillCardGrid.innerHTML = visible.length
        ? visible.map((connector) => renderConnectorCard(connector)).join("")
        : `<div class="skill-empty-state">${state.skillsLoading ? "正在扫描真实连接..." : "没有发现匹配的外部应用或 MCP 配置"}</div>`;
    } else if (section === "plugins") {
      const visible = visibleExtensions();
      els.skillCardGrid.innerHTML = state.skillLibraryMode === "extension" && activeExtension
        ? renderExtensionDetail(activeExtension)
        : visible.length
          ? visible.map((extension) => renderPluginCard(extension)).join("")
          : `<div class="skill-empty-state">${state.skillsLoading ? "正在扫描插件..." : "没有发现匹配的真实插件"}</div>`;
    } else {
      els.skillCardGrid.innerHTML = shown.length
        ? shown.map((skill) => `
          <article class="skill-card skill-row-card${skill.id === state.selectedSkillId ? " featured" : ""}" data-skill-select="${escapeHtml(skill.id)}">
            <header>
              <strong>${escapeHtml(window.aimashiSkillHelpers.skillDisplayName(skill))}</strong>
              <small>${escapeHtml(skill.pluginLabel || window.aimashiSkillHelpers.skillAuthorLabel(skill))}</small>
            </header>
            <p>${escapeHtml(window.aimashiSkillHelpers.skillSummaryZh(skill))}</p>
          </article>
        `).join("")
        : `<div class="skill-empty-state">${skillEmptyText()}</div>`;
    }

    els.skillNav.querySelectorAll("[data-directory-section]").forEach((button) => {
      button.addEventListener("click", () => {
        state.directorySection = button.dataset.directorySection || "plugins";
        state.skillLibraryMode = "skills";
        state.selectedExtensionId = "";
        state.skillPluginFilter = "";
        state.skillStatusFilter = "all";
        state.skillCategoryFilter = "";
        closeSkillContextMenu();
        showNarrowContent();
        renderSkillLibrary();
      });
    });

    els.skillNav.querySelectorAll("[data-skill-plugin]").forEach((button) => {
      button.addEventListener("click", () => {
        state.skillLibraryMode = "skills";
        state.selectedExtensionId = "";
        state.skillPluginFilter = button.dataset.skillPlugin || "";
        state.skillStatusFilter = button.dataset.skillStatus || "all";
        state.skillCategoryFilter = "";
        closeSkillContextMenu();
        showNarrowContent();
        renderSkillLibrary();
      });
    });
    els.skillNav.querySelectorAll("[data-skill-extension]").forEach((button) => {
      button.addEventListener("click", () => {
        state.directorySection = "plugins";
        state.skillLibraryMode = "extension";
        state.selectedExtensionId = button.dataset.skillExtension || "";
        state.skillCategoryFilter = "";
        closeSkillContextMenu();
        showNarrowContent();
        renderSkillLibrary();
      });
    });
    els.skillCardGrid.querySelectorAll("[data-skill-select]").forEach((card) => {
      card.addEventListener("click", () => selectSkill(card.dataset.skillSelect));
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openSkillContextMenu(card.dataset.skillSelect, event.clientX, event.clientY);
      });
    });
    els.skillCardGrid.querySelectorAll("[data-extension-install]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await installExtension(button.dataset.extensionInstall || "");
      });
    });
    els.skillCardGrid.querySelectorAll("[data-extension-select]").forEach((card) => {
      card.addEventListener("click", (event) => {
        if (event.target.closest("[data-extension-install]")) return;
        state.directorySection = "plugins";
        state.skillLibraryMode = "extension";
        state.selectedExtensionId = card.dataset.extensionSelect || "";
        state.skillCategoryFilter = "";
        closeSkillContextMenu();
        renderSkillLibrary();
      });
    });
    els.skillChipRow.querySelectorAll("[data-skill-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.skillCategoryFilter = button.dataset.skillFilter || "";
        closeSkillContextMenu();
        renderSkillLibrary();
      });
    });
    renderSkillContextMenu();
  }

  function renderSkillPreview() {
    if (!state || !els || !els.skillPreviewDialog) return;
    els.skillPreviewDialog.classList.toggle("hidden", !state.skillPreviewOpen);
    const skill = state.selectedSkillDetail || state.skillLibrary.skills.find((item) => item.id === state.selectedSkillId);
    if (!skill) return;
    els.skillPreviewMark.className = `skill-dot ${window.aimashiSkillHelpers.skillTone(skill)}`;
    els.skillPreviewMark.textContent = window.aimashiSkillHelpers.skillInitials(skill.name);
    setText(els.skillPreviewTitle, window.aimashiSkillHelpers.skillDisplayName(skill));
    setText(els.skillPreviewMeta, `${skill.name || "Skill"} · ${skill.sourceLabel || "Local"} · ${skill.relPath || skill.category || ""}`);
    els.skillPreviewBody.innerHTML = skill.body
      ? window.aimashiSkillHelpers.renderSkillMarkdownSource(skill.body)
      : `<div class="skill-empty-state">正在读取 SKILL.md...</div>`;
    els.skillPreviewBody.querySelectorAll("a[href]").forEach((link) => {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noreferrer");
    });
  }

  function openSkillContextMenu(skillId, x, y) {
    if (!skillId || !state) return;
    window.aimashiMessageMenu?.closeMessageContextMenu();
    closeGroupContextMenu();
    state.skillContextMenu = { open: true, x, y, skillId };
    renderSkillContextMenu();
  }

  function closeSkillContextMenu() {
    if (!state || !state.skillContextMenu.open) return;
    state.skillContextMenu = { open: false, x: 0, y: 0, skillId: "" };
    renderSkillContextMenu();
  }

  function renderSkillContextMenu() {
    if (!state || !els || !els.skillContextMenu) return;
    const menu = els.skillContextMenu;
    const skill = state.skillLibrary.skills.find((item) => item.id === state.skillContextMenu.skillId);
    const open = state.skillContextMenu.open && skill;
    menu.classList.toggle("hidden", !open);
    syncTopbarClickCapture();
    if (!open) return;
    const canDelete = skill.source === "aimashi";
    menu.innerHTML = `
      ${menuItemHtml({ icon: "preview", label: "预览", attrs: 'data-skill-action="preview"' })}
      ${menuItemHtml({ icon: "folderOpen", label: "打开目录", attrs: 'data-skill-action="open-directory"' })}
      <div class="skill-context-menu-separator" role="separator"></div>
      ${menuItemHtml({ icon: "delete", label: "删除", attrs: `data-skill-action="delete" ${canDelete ? "" : "disabled"}`, className: "danger" })}
    `;
    const rect = menu.getBoundingClientRect();
    const width = rect.width || 112;
    const height = rect.height || 122;
    menu.style.left = `${Math.max(8, Math.min(state.skillContextMenu.x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(state.skillContextMenu.y, window.innerHeight - height - 8))}px`;
    menu.querySelector('[data-skill-action="preview"]')?.addEventListener("click", () => {
      closeSkillContextMenu();
      selectSkill(skill.id);
    });
    menu.querySelector('[data-skill-action="delete"]')?.addEventListener("click", () => {
      closeSkillContextMenu();
      deleteSkill(skill.id);
    });
    menu.querySelector('[data-skill-action="open-directory"]')?.addEventListener("click", () => {
      closeSkillContextMenu();
      openSkillDirectory(skill.id);
    });
  }

  window.aimashiSkillLibrary = {
    initSkillLibrary,
    skillSourceStatusBase,
    skillMatchesFilters,
    visibleSkills,
    skillCategories,
    selectSkill,
    renderSkillFilterRow,
    renderExtensionNavRow,
    extensionDetailMeta,
    renderExtensionDetail,
    directorySectionRows,
    renderDirectorySectionRow,
    directoryHaystack,
    visibleConnectors,
    visibleExtensions,
    countBy,
    renderConnectorCard,
    renderPluginCard,
    skillEmptyText,
    renderSkillLibrary,
    renderSkillPreview,
    openSkillContextMenu,
    closeSkillContextMenu,
    renderSkillContextMenu,
  };
})();
