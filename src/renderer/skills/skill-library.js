// Skill library UI module
// Single full-width skill grid: search + category pills + skill cards.
// Plugins / connectors / extensions were removed — those data types are
// 永远为空 today and return with the future Cloud registry (sub-project B).
// Data helpers live in skill-helpers.js (window.aimashiSkillHelpers).
(function () {
  "use strict";

  let state, els, aimashi;
  let escapeHtml, setText, menuItemHtml;
  let syncTopbarClickCapture;
  let closeGroupContextMenu, showNarrowContent;
  let deleteSkill, openSkillDirectory;

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
    deleteSkill = deps.deleteSkill;
    openSkillDirectory = deps.openSkillDirectory;
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
    return (!needle || haystack.includes(needle)) && (!category || String(skill.category || "") === category);
  }

  function visibleSkills() {
    if (!state) return [];
    return (state.skillLibrary.skills || []).filter(skillMatchesFilters);
  }

  function skillCategories() {
    const counts = new Map();
    for (const skill of (state.skillLibrary.skills || [])) {
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

  function skillEmptyText() {
    if (state.skillsLoading) return "正在扫描本地 Skill...";
    return "没有匹配的 Skill";
  }

  function renderSkillCard(skill) {
    const tone = window.aimashiSkillHelpers.skillTone(skill);
    const initials = window.aimashiSkillHelpers.skillInitials(skill.name);
    return `
      <article class="skill-card${skill.id === state.selectedSkillId ? " featured" : ""}" data-skill-select="${escapeHtml(skill.id)}">
        <header>
          <span class="skill-card-icon ${escapeHtml(tone)}" aria-hidden="true">${escapeHtml(initials)}</span>
          <div class="skill-card-head">
            <strong>${escapeHtml(window.aimashiSkillHelpers.skillDisplayName(skill))}</strong>
            <small>${escapeHtml(skill.pluginLabel || window.aimashiSkillHelpers.skillAuthorLabel(skill))}</small>
          </div>
        </header>
        <p>${escapeHtml(window.aimashiSkillHelpers.skillSummaryZh(skill))}</p>
      </article>
    `;
  }

  function renderSkillLibrary() {
    if (!state || !els || !els.skillChipRow || !els.skillCardGrid) return;
    setText(els.skillPageTitle, state.skillsLoading ? "正在扫描能力" : "技能");

    const categories = skillCategories();
    els.skillChipRow.innerHTML = [
      `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
      ...categories.slice(0, 12).map(([category, count]) => `
        <button class="${state.skillCategoryFilter === category ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(category)}">
          ${escapeHtml(category)} <span>${count}</span>
        </button>
      `)
    ].join("");

    const shown = visibleSkills();
    els.skillCardGrid.innerHTML = shown.length
      ? shown.map((skill) => renderSkillCard(skill)).join("")
      : `<div class="skill-empty-state">${skillEmptyText()}</div>`;

    els.skillCardGrid.querySelectorAll("[data-skill-select]").forEach((card) => {
      card.addEventListener("click", () => selectSkill(card.dataset.skillSelect));
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openSkillContextMenu(card.dataset.skillSelect, event.clientX, event.clientY);
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
    closeGroupContextMenu?.();
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
    skillMatchesFilters,
    visibleSkills,
    skillCategories,
    selectSkill,
    renderSkillCard,
    skillEmptyText,
    renderSkillLibrary,
    renderSkillPreview,
    openSkillContextMenu,
    closeSkillContextMenu,
    renderSkillContextMenu,
  };
})();
