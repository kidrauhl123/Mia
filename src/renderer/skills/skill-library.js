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

  const MARKET_SOURCE_LOGOS = {
    hermes: { label: "Hermes", mask: true },
    github: { label: "GitHub", mask: true },
    "skills-sh": { label: "skills.sh", src: "./assets/provider-icons/skills-sh.png" },
    clawhub: { label: "ClawHub", src: "./assets/provider-icons/clawhub.png" },
    "browse-sh": { label: "browse.sh", src: "./assets/provider-icons/browse-sh.svg" },
    claude: { label: "Claude", src: "./assets/provider-icons/claude.svg" },
    lobehub: { label: "LobeHub", src: "./assets/provider-icons/lobehub.svg" }
  };
  const MARKET_SKILL_PAGE_LIMIT = 120;
  const marketRefreshKeys = new Set();
  let modeToggleIndicatorHost = null;
  let modeToggleIndicatorResizeBound = false;

  function syncModeToggleIndicator(host) {
    modeToggleIndicatorHost = host || modeToggleIndicatorHost;
    if (!modeToggleIndicatorHost) return;

    const update = () => {
      const active = modeToggleIndicatorHost.querySelector("button.active");
      if (!active || typeof active.getBoundingClientRect !== "function") return;
      const hostRect = modeToggleIndicatorHost.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      modeToggleIndicatorHost.style.setProperty("--pill-x", `${activeRect.left - hostRect.left}px`);
      modeToggleIndicatorHost.style.setProperty("--pill-w", `${activeRect.width}px`);
      modeToggleIndicatorHost.style.setProperty("--pill-ready", "1");
    };

    if (typeof requestAnimationFrame === "function") requestAnimationFrame(update);
    else update();

    if (!modeToggleIndicatorResizeBound && typeof window !== "undefined") {
      modeToggleIndicatorResizeBound = true;
      window.addEventListener("resize", () => syncModeToggleIndicator(modeToggleIndicatorHost));
    }
  }

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

  function renderUnifiedSkillCard({ title, description, sourceHtml, actionHtml, className = "", attrs = "" }) {
    const cardClass = ["skill-card", className].filter(Boolean).join(" ");
    return `
      <article class="${escapeHtml(cardClass)}"${attrs ? ` ${attrs}` : ""}>
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(title || "Skill")}</strong>
            ${actionHtml || ""}
          </div>
          <p>${escapeHtml(description || "")}</p>
        </div>
        <span class="skill-card-source">${sourceHtml || ""}</span>
      </article>
    `;
  }

  function localSkillMarketSourceLabel(skill) {
    const explicit = String(skill?.marketSourceLabel || "").trim();
    if (explicit) return explicit;
    const sourceKey = marketSourceKey(skill);
    return marketSourceLogo(skill, sourceKey)?.label || "";
  }

  function skillSourceLogoHtml(skill) {
    const sourceLabel = localSkillMarketSourceLabel(skill);
    if (!sourceLabel && !skill?.marketUpstreamSource) return "";
    return marketSourceLogoHtml({
      sourceLabel,
      ownerLabel: sourceLabel,
      upstreamSource: skill.marketUpstreamSource || skill.upstreamSource || "",
      category: skill.category || ""
    });
  }

  function renderSkillCard(skill) {
    const sourceText = localSkillMarketSourceLabel(skill) || skill.pluginLabel || window.miaSkillHelpers.skillAuthorLabel(skill);
    return renderUnifiedSkillCard({
      title: window.miaSkillHelpers.skillDisplayName(skill),
      description: window.miaSkillHelpers.skillSummaryZh(skill),
      sourceHtml: `${skillSourceLogoHtml(skill)}<span class="skill-card-source-text">${escapeHtml(sourceText)}</span>`,
      actionHtml: `<button class="skill-card-action skill-card-action-use" type="button" data-skill-use="${escapeHtml(skill.id)}">使用</button>`,
      className: skill.id === state.selectedSkillId ? "featured" : "",
      attrs: `data-skill-select="${escapeHtml(skill.id)}"`
    });
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
    syncModeToggleIndicator(els.skillModeToggle);
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
        useSkillInComposer(button.dataset.skillUse);
      });
    });
  }

  // 「使用」: attach the skill to the conversation the user is currently viewing
  // on the messages page (no fellow picker). If no fellow conversation is open,
  // prompt them to open one first.
  function useSkillInComposer(skillId) {
    const skill = (state.skillLibrary.skills || []).find((item) => item.id === skillId);
    const name = skill ? window.miaSkillHelpers.skillDisplayName(skill) : skillId;
    const attached = window.miaUseSkillInActiveConversation?.({ id: skillId, name });
    if (!attached) window.alert("请先在消息页打开一个 Fellow 对话，再使用技能。");
  }

  function renderSkillPreview() {
    if (!state || !els || !els.skillPreviewDialog) return;
    els.skillPreviewDialog.classList.toggle("hidden", !state.skillPreviewOpen);
    const skill = state.selectedSkillDetail || state.skillLibrary.skills.find((item) => item.id === state.selectedSkillId);
    if (!skill) return;
    els.skillPreviewMark.className = `skill-dot ${window.miaSkillHelpers.skillTone(skill)}`;
    els.skillPreviewMark.textContent = window.miaSkillHelpers.skillInitials(skill.name);
    setText(els.skillPreviewTitle, window.miaSkillHelpers.skillDisplayName(skill));
    const previewMarketSource = localSkillMarketSourceLabel(skill);
    const previewSource = previewMarketSource
      ? `${skill.sourceLabel || "Local"} · ${previewMarketSource}`
      : (skill.sourceLabel || "Local");
    setText(els.skillPreviewMeta, `${skill.name || "Skill"} · ${previewSource} · ${skill.relPath || skill.category || ""}`);
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

  function installedLocalSkillForMarket(skill) {
    return (state.skillLibrary.skills || []).find((local) => local.name === skill.name) || null;
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

  function marketRequestParams() {
    return {
      category: state.skillCategoryFilter.trim(),
      q: state.skillFilter.trim(),
      limit: MARKET_SKILL_PAGE_LIMIT
    };
  }

  function marketQueryKey(params) {
    return JSON.stringify({
      category: params.category || "",
      q: params.q || "",
      limit: params.limit || MARKET_SKILL_PAGE_LIMIT
    });
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

  function normalizedMarketSourceValues(skill) {
    return [
      skill?.upstreamSource,
      skill?.sourceLabel,
      skill?.ownerLabel,
      skill?.category,
      skill?.id,
      skill?.relPath,
      skill?.marketSourceLabel,
      skill?.marketUpstreamSource,
      skill?.marketUpstreamId,
      skill?.marketUpstreamRepo,
      skill?.marketUpstreamPath
    ]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
  }

  function marketSourceValuesInclude(values, ...needles) {
    return [...values].some((value) => needles.some((needle) => value.includes(needle)));
  }

  function marketSourceKey(skill) {
    const values = new Set(normalizedMarketSourceValues(skill));
    if (values.has("official") || values.has("hermes") || values.has("hermes 官方") || values.has("hermes hub")) return "hermes";
    if (values.has("skills.sh") || values.has("skills-sh")) return "skills-sh";
    if (values.has("github")) return "github";
    if (values.has("clawhub")) return "clawhub";
    if (values.has("browse.sh") || values.has("browse-sh")) return "browse-sh";
    if (
      values.has("claude")
      || values.has("anthropic")
      || values.has("claude marketplace")
      || values.has("claude-marketplace")
      || values.has("anthropics/skills")
      || values.has("anthropic/skills")
      || marketSourceValuesInclude(values, "claude-marketplace", "anthropics/skills", "anthropic/skills")
    ) return "claude";
    if (values.has("lobehub")) return "lobehub";
    return "";
  }

  function marketSourceLogo(skill, sourceKey = marketSourceKey(skill)) {
    return MARKET_SOURCE_LOGOS[sourceKey] || null;
  }

  function marketSourceLogoHtml(skill) {
    const sourceKey = marketSourceKey(skill);
    const logo = marketSourceLogo(skill, sourceKey);
    if (!logo) return "";
    const className = `skill-source-logo skill-source-logo-${sourceKey}`;
    const title = logo.label ? ` title="${escapeHtml(logo.label)}"` : "";
    if (logo.mask) {
      return `<span class="${escapeHtml(className)}" aria-hidden="true"${title}><span class="skill-source-logo-mask"></span></span>`;
    }
    return `<span class="${escapeHtml(className)}" aria-hidden="true"${title}><img src="${escapeHtml(logo.src)}" alt=""></span>`;
  }

  function renderMarketCard(skill) {
    const installedSkill = installedLocalSkillForMarket(skill);
    const installing = state.installingSkillIds.has(skill.id);
    const action = installedSkill
      ? `<button class="skill-card-action skill-card-action-use" type="button" data-skill-use="${escapeHtml(installedSkill.id)}">使用</button>`
      : `<button class="skill-card-action skill-card-action-install" type="button" data-skill-install="${escapeHtml(skill.id)}"${installing ? " disabled" : ""}>${installing ? "…" : "添加"}</button>`;
    const meta = [skill.sourceLabel, formatInstallCount(skill.installCount)].filter(Boolean).join(" · ");
    return renderUnifiedSkillCard({
      title: skill.name,
      description: skill.description || "",
      sourceHtml: `${marketSourceLogoHtml(skill)}<span class="skill-card-source-text">${escapeHtml(meta)}</span>`,
      actionHtml: action,
      className: "market-card",
      attrs: `data-market-id="${escapeHtml(skill.id)}"`
    });
  }

  function renderMarketView() {
    setText(els.skillPageTitle, "技能市场");
    const params = marketRequestParams();
    const queryKey = marketQueryKey(params);
    renderChips(marketCategoryEntries());
    if (!cloudSignedIn()) {
      els.skillCardGrid.innerHTML = `<div class="skill-empty-state">登录 Mia Cloud 后即可浏览技能市场。</div>`;
      return;
    }
    // Lazy-load the catalog the first time the market is shown.
    if (state.skillMarket.queryKey !== queryKey && !state.skillMarket.loading) {
      loadMarketSkills(params);
      return;
    }
    if (!state.skillMarket.loaded && !state.skillMarket.loading) {
      loadMarketSkills(params);
      return;
    }
    if ((state.skillMarket.loading && !state.skillMarket.loaded) || state.skillMarket.queryKey !== queryKey) {
      els.skillCardGrid.innerHTML = `<div class="skill-empty-state">正在加载技能市场...</div>`;
      return;
    }
    if (state.skillMarket.error && !(state.skillMarket.skills || []).length) {
      els.skillCardGrid.innerHTML = `<div class="skill-empty-state">技能市场加载失败，请稍后重试。</div>`;
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
    els.skillCardGrid.querySelectorAll("[data-skill-use]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        useSkillInComposer(button.dataset.skillUse);
      });
    });
    els.skillCardGrid.querySelectorAll("[data-market-id]").forEach((card) => {
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        reportMarketSkill(card.dataset.marketId);
      });
    });
  }

  async function loadMarketSkills(params = marketRequestParams(), options = {}) {
    if (!state || !window.mia?.marketSkills) return;
    const queryKey = marketQueryKey(params);
    const forceRefresh = !!options.forceRefresh;
    const background = !!options.background;
    const hasCurrentPage = state.skillMarket.loaded && state.skillMarket.queryKey === queryKey;
    if (forceRefresh && marketRefreshKeys.has(queryKey)) return;
    if (forceRefresh) marketRefreshKeys.add(queryKey);
    if (background || hasCurrentPage) {
      state.skillMarket.refreshing = true;
    } else {
      state.skillMarket.loading = true;
      state.skillMarket.loaded = false;
    }
    state.skillMarket.error = "";
    state.skillMarket.queryKey = queryKey;
    renderSkillLibrary();
    let shouldRefresh = false;
    try {
      const data = forceRefresh
        ? await window.mia.marketSkills({ ...params, forceRefresh: true })
        : await window.mia.marketSkills(params);
      if (state.skillMarket.queryKey !== queryKey) return;
      state.skillMarket.skills = Array.isArray(data?.skills) ? data.skills : [];
      state.skillMarket.categories = Array.isArray(data?.categories) ? data.categories : [];
      state.skillMarket.cached = Boolean(data?.cached);
      state.skillMarket.stale = Boolean(data?.stale);
      state.skillMarket.updatedAt = data?.updatedAt || "";
      state.skillMarket.loaded = true;
      shouldRefresh = Boolean(data?.cached && data?.stale && !forceRefresh);
    } catch (error) {
      console.error("Failed to load skill market", error);
      if (state.skillMarket.queryKey !== queryKey) return;
      if (!background && !hasCurrentPage) state.skillMarket.skills = [];
      state.skillMarket.error = error?.message || "load failed";
      state.skillMarket.loaded = true;
    } finally {
      if (forceRefresh) marketRefreshKeys.delete(queryKey);
      if (state.skillMarket.queryKey === queryKey) {
        state.skillMarket.loading = false;
        state.skillMarket.refreshing = false;
        renderSkillLibrary();
      }
      if (shouldRefresh) loadMarketSkills(params, { forceRefresh: true, background: true });
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
