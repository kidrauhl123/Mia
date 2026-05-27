// Skill library UI module
// Single full-width skill grid: search + category pills + skill cards.
// Plugins / connectors / extensions were removed — those data types are
// 永远为空 today and return with the future Cloud registry (sub-project B).
// Data helpers live in skill-helpers.js (window.miaSkillHelpers).
(function () {
  "use strict";

  let state, els, mia;
  let escapeHtml, setText, menuItemHtml;
  let syncTopbarClickCapture;
  let closeGroupContextMenu, showNarrowContent;
  let deleteSkill, openSkillDirectory;

  function initSkillLibrary(deps) {
    state = deps.state;
    els = deps.els;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
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
      window.miaSkillHelpers.skillDisplayName(skill),
      window.miaSkillHelpers.skillSummaryZh(skill),
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
      state.selectedSkillDetail = await window.mia.readSkill(skillId);
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
    const tone = window.miaSkillHelpers.skillTone(skill);
    const initials = window.miaSkillHelpers.skillInitials(skill.name);
    return `
      <article class="skill-card${skill.id === state.selectedSkillId ? " featured" : ""}" data-skill-select="${escapeHtml(skill.id)}">
        <span class="skill-card-icon ${escapeHtml(tone)}" aria-hidden="true">${escapeHtml(initials)}</span>
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(window.miaSkillHelpers.skillDisplayName(skill))}</strong>
            <button class="skill-card-action" type="button" data-skill-use="${escapeHtml(skill.id)}">使用</button>
          </div>
          <p>${escapeHtml(window.miaSkillHelpers.skillSummaryZh(skill))}</p>
        </div>
        <span class="skill-card-source">${escapeHtml(skill.pluginLabel || window.miaSkillHelpers.skillAuthorLabel(skill))}</span>
      </article>
    `;
  }

  function renderChips(entries) {
    els.skillChipRow.innerHTML = [
      `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
      ...entries.slice(0, 12).map(([category, count]) => `
        <button class="${state.skillCategoryFilter === category ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(category)}">
          ${escapeHtml(category)} <span>${count}</span>
        </button>
      `)
    ].join("");
    els.skillChipRow.querySelectorAll("[data-skill-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.skillCategoryFilter = button.dataset.skillFilter || "";
        closeSkillContextMenu();
        renderSkillLibrary();
      });
    });
  }

  function renderModeToggle() {
    if (!els.skillModeToggle) return;
    const market = !!state.skillMarketMode;
    els.skillModeToggle.innerHTML = `
      <button class="${market ? "active" : ""}" type="button" role="tab" data-skill-mode="market">技能市场</button>
      <button class="${market ? "" : "active"}" type="button" role="tab" data-skill-mode="mine">我的技能</button>
    `;
    els.skillModeToggle.querySelectorAll("[data-skill-mode]").forEach((button) => {
      button.addEventListener("click", () => switchSkillMode(button.dataset.skillMode === "market"));
    });
  }

  function switchSkillMode(toMarket) {
    if (!!state.skillMarketMode === !!toMarket) return;
    state.skillMarketMode = !!toMarket;
    state.skillCategoryFilter = "";
    closeSkillContextMenu();
    renderSkillLibrary();
    if (toMarket && !state.skillMarket.loaded && !state.skillMarket.loading) loadMarketSkills();
  }

  function renderSkillLibrary() {
    if (!state || !els || !els.skillChipRow || !els.skillCardGrid) return;
    renderModeToggle();
    if (state.skillMarketMode) renderMarketView();
    else renderLocalView();
    renderSkillContextMenu();
  }

  function renderLocalView() {
    setText(els.skillPageTitle, state.skillsLoading ? "正在扫描能力" : "技能");
    renderChips(skillCategories());
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
    els.skillCardGrid.querySelectorAll("[data-skill-use]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        useSkillInComposer(button.dataset.skillUse, event.clientX, event.clientY);
      });
    });
  }

  // Attach the skill as a composer chip and open that Fellow's chat (Marvis-style).
  // Await navigation first so the chip binds to the destination room, not the
  // one we're leaving (openFellowChat resolves the cloud room asynchronously).
  async function attachSkillToComposer(fellowKey, skillId) {
    const skill = (state.skillLibrary.skills || []).find((item) => item.id === skillId);
    const name = skill ? window.miaSkillHelpers.skillDisplayName(skill) : skillId;
    await window.miaFellowManager?.openFellowChat?.(fellowKey);
    window.miaComposer?.addComposerSkill?.({ id: skillId, name });
  }

  // 「使用」: jump to the current chat with the skill chipped on; if no chat is
  // active and there are multiple Fellows, pop a picker.
  function useSkillInComposer(skillId, x, y) {
    const fellows = window.miaFellowManager?.allOwnedFellows?.() || [];
    if (!fellows.length) { window.alert("还没有可用的 Fellow，请先创建一个再使用技能。"); return; }
    if (state.activeKey && fellows.some((f) => f.key === state.activeKey)) {
      attachSkillToComposer(state.activeKey, skillId);
    } else if (fellows.length === 1) {
      attachSkillToComposer(fellows[0].key, skillId);
    } else {
      openUseSkillPicker(skillId, x, y);
    }
  }

  // "使用" → pick a Fellow → enable the skill on it and open that chat.
  function openUseSkillPicker(skillId, x, y) {
    document.querySelector(".skill-use-picker")?.remove();
    const fellows = window.miaFellowManager?.allOwnedFellows?.() || [];
    const picker = document.createElement("div");
    picker.className = "skill-use-picker";
    picker.innerHTML = fellows.length
      ? `<div class="skill-use-picker-label">用哪个 Fellow 使用？</div>` +
        fellows.map((fellow) => `<button type="button" data-use-fellow="${escapeHtml(fellow.key)}">${escapeHtml(fellow.name || fellow.key)}</button>`).join("")
      : `<div class="skill-use-picker-label">还没有可用的 Fellow</div>`;
    document.body.appendChild(picker);
    const width = picker.offsetWidth || 200;
    const height = picker.offsetHeight || 120;
    picker.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    picker.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
    const close = (event) => {
      if (event && picker.contains(event.target)) return;
      picker.remove();
      document.removeEventListener("mousedown", close, true);
    };
    picker.querySelectorAll("[data-use-fellow]").forEach((button) => {
      button.addEventListener("click", () => {
        picker.remove();
        document.removeEventListener("mousedown", close, true);
        attachSkillToComposer(button.dataset.useFellow, skillId);
      });
    });
    setTimeout(() => document.addEventListener("mousedown", close, true), 0);
  }

  function renderSkillPreview() {
    if (!state || !els || !els.skillPreviewDialog) return;
    els.skillPreviewDialog.classList.toggle("hidden", !state.skillPreviewOpen);
    const skill = state.selectedSkillDetail || state.skillLibrary.skills.find((item) => item.id === state.selectedSkillId);
    if (!skill) return;
    els.skillPreviewMark.className = `skill-dot ${window.miaSkillHelpers.skillTone(skill)}`;
    els.skillPreviewMark.textContent = window.miaSkillHelpers.skillInitials(skill.name);
    setText(els.skillPreviewTitle, window.miaSkillHelpers.skillDisplayName(skill));
    setText(els.skillPreviewMeta, `${skill.name || "Skill"} · ${skill.sourceLabel || "Local"} · ${skill.relPath || skill.category || ""}`);
    els.skillPreviewBody.innerHTML = skill.body
      ? window.miaSkillHelpers.renderSkillMarkdownSource(skill.body)
      : `<div class="skill-empty-state">正在读取 SKILL.md...</div>`;
    els.skillPreviewBody.querySelectorAll("a[href]").forEach((link) => {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noreferrer");
    });
  }

  function openSkillContextMenu(skillId, x, y) {
    if (!skillId || !state) return;
    window.miaMessageMenu?.closeMessageContextMenu();
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
    const canDelete = skill.source === "mia";
    // Only skills you authored locally are publishable — not ones downloaded
    // from the market (.mia-market.json) or shipped with the app.
    const canPublish = skill.source === "mia" && !skill.fromMarket;
    menu.innerHTML = `
      ${menuItemHtml({ icon: "preview", label: "预览", attrs: 'data-skill-action="preview"' })}
      ${menuItemHtml({ icon: "folderOpen", label: "打开目录", attrs: 'data-skill-action="open-directory"' })}
      ${canPublish ? menuItemHtml({ icon: "edit", label: "发布到市场", attrs: 'data-skill-action="publish"' }) : ""}
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
    menu.querySelector('[data-skill-action="publish"]')?.addEventListener("click", () => {
      closeSkillContextMenu();
      publishLocalSkill(skill.id);
    });
  }

  async function publishLocalSkill(skillId) {
    const category = window.prompt("发布到市场 —— 填写分类（如 办公学习 / 生活日常）：", "uncategorized");
    if (category === null) return;
    try {
      const published = await window.mia.publishSkill({ skillId, category: category.trim() || "uncategorized", version: "1.0.0" });
      window.alert(published ? `已发布「${published.name}」到市场。` : "发布失败。");
      state.skillMarket.loaded = false;
      if (state.skillMarketMode) loadMarketSkills();
    } catch (error) {
      window.alert(`发布失败：${error?.message || error}`);
    }
  }

  async function reportMarketSkill(skillId) {
    const reason = window.prompt("举报这个技能的原因：", "");
    if (reason === null) return;
    try {
      await window.mia.reportMarketSkill({ skillId, reason });
      window.alert("已提交举报，我们会尽快处理。");
    } catch (error) {
      window.alert(`举报失败：${error?.message || error}`);
    }
  }

  // ---- Marketplace (探索发现) ----

  function cloudSignedIn() {
    return Boolean(state.runtime?.cloud?.enabled);
  }

  function marketSkillInstalled(skill) {
    return (state.skillLibrary.skills || []).some((local) => local.name === skill.name);
  }

  function formatInstallCount(n) {
    const value = Number(n) || 0;
    if (value <= 0) return "";
    if (value >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, "")}万人添加`;
    return `${value} 人添加`;
  }

  function marketCategoryEntries() {
    return (state.skillMarket.categories || []).map((entry) => [entry.category, entry.count]);
  }

  function visibleMarketSkills() {
    const needle = state.skillFilter.trim().toLowerCase();
    const category = state.skillCategoryFilter.trim();
    return (state.skillMarket.skills || []).filter((skill) => {
      if (category && String(skill.category || "") !== category) return false;
      if (!needle) return true;
      return [skill.name, skill.description, skill.sourceLabel, skill.category]
        .join(" ").toLowerCase().includes(needle);
    });
  }

  function renderMarketCard(skill) {
    const tone = window.miaSkillHelpers.skillTone(skill);
    const initials = window.miaSkillHelpers.skillInitials(skill.name);
    const installed = marketSkillInstalled(skill);
    const installing = state.installingSkillIds.has(skill.id);
    const action = installed
      ? `<span class="skill-card-action installed">已添加</span>`
      : `<button class="skill-card-action" type="button" data-skill-install="${escapeHtml(skill.id)}"${installing ? " disabled" : ""}>${installing ? "…" : "添加"}</button>`;
    const meta = [skill.sourceLabel, formatInstallCount(skill.installCount)].filter(Boolean).join(" · ");
    return `
      <article class="skill-card market-card" data-market-id="${escapeHtml(skill.id)}">
        <span class="skill-card-icon ${escapeHtml(tone)}" aria-hidden="true">${escapeHtml(initials)}</span>
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(skill.name)}</strong>
            ${action}
          </div>
          <p>${escapeHtml(skill.description || "")}</p>
        </div>
        <span class="skill-card-source">${escapeHtml(meta)}</span>
      </article>
    `;
  }

  function renderMarketView() {
    setText(els.skillPageTitle, "技能市场");
    renderChips(marketCategoryEntries());
    if (!cloudSignedIn()) {
      els.skillCardGrid.innerHTML = `<div class="skill-empty-state">登录 Mia Cloud 后即可浏览技能市场。</div>`;
      return;
    }
    // Lazy-load the catalog the first time the market is shown.
    if (!state.skillMarket.loaded && !state.skillMarket.loading) {
      loadMarketSkills();
      return;
    }
    if (state.skillMarket.loading) {
      els.skillCardGrid.innerHTML = `<div class="skill-empty-state">正在加载技能市场...</div>`;
      return;
    }
    const shown = visibleMarketSkills();
    els.skillCardGrid.innerHTML = shown.length
      ? shown.map((skill) => renderMarketCard(skill)).join("")
      : `<div class="skill-empty-state">没有匹配的技能</div>`;
    els.skillCardGrid.querySelectorAll("[data-skill-install]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        installMarketSkill(button.dataset.skillInstall);
      });
    });
    els.skillCardGrid.querySelectorAll("[data-market-id]").forEach((card) => {
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        reportMarketSkill(card.dataset.marketId);
      });
    });
  }

  async function loadMarketSkills() {
    if (!state || !window.mia?.marketSkills) return;
    state.skillMarket.loading = true;
    renderSkillLibrary();
    try {
      const data = await window.mia.marketSkills({});
      state.skillMarket.skills = Array.isArray(data?.skills) ? data.skills : [];
      state.skillMarket.categories = Array.isArray(data?.categories) ? data.categories : [];
      state.skillMarket.loaded = true;
    } catch (error) {
      console.error("Failed to load skill market", error);
      state.skillMarket.skills = [];
    } finally {
      state.skillMarket.loading = false;
      renderSkillLibrary();
    }
  }

  async function installMarketSkill(skillId) {
    if (!skillId || !state || state.installingSkillIds.has(skillId)) return;
    const entry = state.skillMarket.skills.find((skill) => skill.id === skillId);
    const owner = entry?.ownerLabel || "未知来源";
    const ok = window.confirm(`添加「${entry?.name || skillId}」？\n\n来源：${owner}\n技能会作为可执行能力安装到本机，且未经审核。确认从该来源安装？`);
    if (!ok) return;
    state.installingSkillIds.add(skillId);
    renderSkillLibrary();
    try {
      const result = await window.mia.installMarketSkill(skillId);
      if (result?.library) state.skillLibrary = result.library;
      const entry = state.skillMarket.skills.find((skill) => skill.id === skillId);
      if (entry && result?.skill) entry.installCount = result.skill.installCount;
    } catch (error) {
      console.error("Failed to install skill", error);
      window.alert(`安装失败：${error?.message || error}`);
    } finally {
      state.installingSkillIds.delete(skillId);
      renderSkillLibrary();
    }
  }

  window.miaSkillLibrary = {
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
    switchSkillMode,
    loadMarketSkills,
    installMarketSkill,
  };
})();
