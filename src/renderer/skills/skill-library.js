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
  const MARKET_SKILL_PAGE_LIMIT = 72;
  const marketRefreshKeys = new Set();
  let modeToggleIndicatorHost = null;
  let modeToggleIndicatorResizeBound = false;
  let pageTurnDirection = 0;

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
      window.miaSkillHelpers.skillDisplayCategory(skill),
      skill.sourceLabel,
      skill.marketId,
      skill.marketNameZh,
      skill.marketSummaryZh,
      skill.marketCategoryZh,
      skill.relPath,
      ...(skill.tags || [])
    ].join(" ").toLowerCase();
    return (!needle || haystack.includes(needle))
      && (!category || String(window.miaSkillHelpers.skillDisplayCategory(skill) || "").toLowerCase() === category);
  }

  function visibleSkills() {
    if (!state) return [];
    return (state.skillLibrary.skills || []).filter(skillMatchesFilters);
  }

  function skillCategories() {
    const counts = new Map();
    for (const skill of (state.skillLibrary.skills || [])) {
      const category = window.miaSkillHelpers.skillDisplayCategory(skill);
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  async function selectSkill(skillId, openPreview = true) {
    if (!skillId || !state) return;
    state.selectedSkillId = skillId;
    const listed = state.skillLibrary.skills.find((skill) => skill.id === skillId);
    state.selectedSkillDetail = listed || null;
    renderSkillLibrary();
    if (openPreview) openLocalSkillModal(skillId);
    try {
      state.selectedSkillDetail = await window.mia.readSkill(skillId);
    } catch (error) {
      console.error("Failed to read skill", error);
    }
    renderSkillLibrary();
    if (openPreview && skillModal.kind === "local" && skillModal.skillId === skillId) renderSkillModal();
  }

  function skillEmptyText() {
    if (state.skillsLoading) return "正在扫描本地 Skill...";
    return "没有匹配的 Skill";
  }

  function renderUnifiedSkillCard({ title, description, sourceHtml, className = "", attrs = "" }) {
    const cardClass = ["skill-card", className].filter(Boolean).join(" ");
    return `
      <article class="${escapeHtml(cardClass)}"${attrs ? ` ${attrs}` : ""}>
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(title || "Skill")}</strong>
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
      category: window.miaSkillHelpers.skillDisplayCategory(skill)
    });
  }

  function renderSkillCard(skill) {
    const sourceText = localSkillMarketSourceLabel(skill) || skill.pluginLabel || window.miaSkillHelpers.skillAuthorLabel(skill);
    return renderUnifiedSkillCard({
      title: window.miaSkillHelpers.skillDisplayName(skill),
      description: window.miaSkillHelpers.skillSummaryZh(skill),
      sourceHtml: `${skillSourceLogoHtml(skill)}<span class="skill-card-source-text">${escapeHtml(sourceText)}</span>`,
      className: skill.id === state.selectedSkillId ? "featured" : "",
      attrs: `data-skill-select="${escapeHtml(skill.id)}"`
    });
  }

  function renderChips(entries) {
    const chipKeys = ["", ...entries.slice(0, 12).map(([category]) => category)];
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
        const next = button.dataset.skillFilter || "";
        if (state.skillCategoryFilter === next) return;
        const fromIndex = Math.max(0, chipKeys.indexOf(state.skillCategoryFilter || ""));
        const toIndex = Math.max(0, chipKeys.indexOf(next));
        pageTurnDirection = toIndex >= fromIndex ? 1 : -1;
        window.miaMasonryGrid?.capture(els.skillCardGrid, pageTurnDirection);
        state.skillCategoryFilter = next;
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
    pageTurnDirection = toMarket ? 1 : -1;
    window.miaMasonryGrid?.capture(els.skillCardGrid, pageTurnDirection);
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

  function layoutSkillCards() {
    const direction = pageTurnDirection;
    pageTurnDirection = 0;
    window.miaMasonryGrid?.layout(els.skillCardGrid, ".skill-card", { animate: direction });
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
    layoutSkillCards();
  }

  // 「使用」: attach the skill to the conversation the user is currently viewing
  // on the messages page (no bot picker). If no bot conversation is open,
  // prompt them to open one first.
  function useSkillInComposer(skillId) {
    const skill = (state.skillLibrary.skills || []).find((item) => item.id === skillId);
    const name = skill ? window.miaSkillHelpers.skillDisplayName(skill) : skillId;
    const attached = window.miaUseSkillInActiveConversation?.({ id: skillId, name });
    if (!attached) window.alert("请先在消息页打开一个 Bot 对话，再使用技能。");
  }

  function localSkillModalSourceText(skill) {
    const marketSource = localSkillMarketSourceLabel(skill);
    const author = String(skill.sourceLabel || window.miaSkillHelpers.skillAuthorLabel(skill) || "").trim();
    const base = (!author || author === "Local" || author === "Mia Runtime") ? "本机技能" : author;
    return marketSource ? `${base} · ${marketSource}` : base;
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
      if (state.skillMarketMode) loadMarketSkills(marketRequestParams(), { forceRefresh: true });
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

  function sameNonEmpty(a, b) {
    const left = String(a || "").trim();
    const right = String(b || "").trim();
    return !!left && !!right && left === right;
  }

  function installedLocalSkillForMarket(skill) {
    return (state.skillLibrary.skills || []).find((local) => {
      if (!local?.fromMarket) return false;
      if (local.source === "mia-official") return false;
      if (sameNonEmpty(local.marketId, skill.id)) return true;
      return sameNonEmpty(local.marketUpstreamId, skill.upstreamId);
    }) || null;
  }

  function formatInstallCount(n) {
    const value = Number(n) || 0;
    if (value <= 0) return "";
    if (value >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, "")}万人添加`;
    return `${value} 人添加`;
  }

  function hasCjk(text) {
    return /[\u3400-\u9fff]/.test(String(text || ""));
  }

  function marketDescriptionZh(skill) {
    const description = String(skill?.description || "").trim();
    if (description && hasCjk(description)) return description;
    const source = String(skill?.sourceLabel || skill?.ownerLabel || "社区来源").trim() || "社区来源";
    const tags = Array.isArray(skill?.tags) ? skill.tags.slice(0, 3).filter(Boolean).join("、") : "";
    const tail = tags ? `，标签：${tags}` : "";
    return `来自 ${source} 的技能，添加后会安装到本机技能库，并按该技能说明处理相关任务${tail}。`;
  }

  function marketCategoryEntries() {
    return (state.skillMarket.categories || []).map((entry) => [entry.category, entry.count]);
  }

  function marketRequestParams() {
    return {
      limit: MARKET_SKILL_PAGE_LIMIT
    };
  }

  function marketQueryKey(params) {
    return JSON.stringify({
      limit: params.limit || MARKET_SKILL_PAGE_LIMIT
    });
  }

  function visibleMarketSkills() {
    const needle = state.skillFilter.trim().toLowerCase();
    const category = state.skillCategoryFilter.trim();
    return (state.skillMarket.skills || []).filter((skill) => {
      if (category && String(skill.category || "") !== category) return false;
      if (!needle) return true;
      return [skill.name, skill.description, marketDescriptionZh(skill), skill.sourceLabel, skill.category]
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
    const meta = [skill.sourceLabel, formatInstallCount(skill.installCount)].filter(Boolean).join(" · ");
    return renderUnifiedSkillCard({
      title: skill.name_zh || skill.name,
      description: marketDescriptionZh(skill),
      sourceHtml: `${marketSourceLogoHtml(skill)}<span class="skill-card-source-text">${escapeHtml(meta)}</span>`,
      className: "market-card",
      attrs: `data-market-id="${escapeHtml(skill.id)}"`
    });
  }

  function renderMarketView() {
    setText(els.skillPageTitle, "技能市场");
    const params = marketRequestParams();
    const queryKey = marketQueryKey(params);
    renderChips(marketCategoryEntries());
    // Lazy-load the catalog the first time the market is shown.
    if (!state.skillMarket.loaded && !state.skillMarket.loading) {
      loadMarketSkills(params);
      return;
    }
    if (state.skillMarket.queryKey && state.skillMarket.queryKey !== queryKey && !state.skillMarket.loading) {
      loadMarketSkills(params);
      return;
    }
    if (state.skillMarket.loading && !state.skillMarket.loaded) {
      els.skillCardGrid.innerHTML = `<div class="skill-empty-state">正在加载技能市场...</div>`;
      layoutSkillCards();
      return;
    }
    if (state.skillMarket.error && !(state.skillMarket.skills || []).length) {
      els.skillCardGrid.innerHTML = `<div class="skill-empty-state">技能市场加载失败，请稍后重试。</div>`;
      layoutSkillCards();
      return;
    }
    const shown = visibleMarketSkills();
    els.skillCardGrid.innerHTML = shown.length
      ? shown.map((skill) => renderMarketCard(skill)).join("")
      : `<div class="skill-empty-state">没有匹配的技能</div>`;
    els.skillCardGrid.querySelectorAll("[data-market-id]").forEach((card) => {
      card.addEventListener("click", () => openMarketModal(card.dataset.marketId));
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        reportMarketSkill(card.dataset.marketId);
      });
    });
    layoutSkillCards();
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
      const categories = Array.isArray(data?.categories) ? data.categories : [];
      state.skillMarket.categories = categories;
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
    // Desktop install uses the unified market path: local snapshot when current,
    // cloud package download when the skill is new or newer than the snapshot.
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

  async function loadMarketSkillBody(skillId) {
    const skill = findMarketSkill(skillId);
    if (!skill || String(skill.body || "").trim() || skill.marketBodyLoading) return;
    if (typeof window.mia?.readMarketSkill !== "function") {
      skill.marketBodyError = "当前版本暂时无法读取技能正文。";
      renderSkillModal();
      return;
    }
    skill.marketBodyLoading = true;
    skill.marketBodyError = "";
    renderSkillModal();
    try {
      const detail = await window.mia.readMarketSkill(skillId);
      const current = findMarketSkill(skillId);
      if (!current) return;
      if (detail?.skill && typeof detail.skill === "object") Object.assign(current, detail.skill);
      current.body = String(detail?.body || current.body || "");
    } catch (error) {
      const current = findMarketSkill(skillId);
      if (current) current.marketBodyError = error?.message || "技能正文读取失败。";
    } finally {
      const current = findMarketSkill(skillId);
      if (current) current.marketBodyLoading = false;
      if (skillModal.kind === "market" && skillModal.skillId === skillId) renderSkillModal();
    }
  }

  // --- Shared skill detail modal ----------------------------------------
  // Market and local skill cards reuse this popup. It opens on the intro and
  // keeps a visible 「展开正文」 path to the raw SKILL.md body.
  let skillModal = { kind: "", skillId: "", showBody: false };
  let skillModalEl = null;

  function findMarketSkill(skillId) {
    return (state?.skillMarket?.skills || []).find((skill) => skill.id === skillId) || null;
  }

  function findLocalSkill(skillId) {
    if (state?.selectedSkillDetail?.id === skillId) return state.selectedSkillDetail;
    return (state?.skillLibrary?.skills || []).find((skill) => skill.id === skillId) || null;
  }

  function findModalSkill() {
    if (skillModal.kind === "local") return findLocalSkill(skillModal.skillId);
    if (skillModal.kind === "market") return findMarketSkill(skillModal.skillId);
    return null;
  }

  function ensureMarketModalEl() {
    if (skillModalEl) return skillModalEl;
    const el = document.createElement("div");
    el.id = "skillMarketModal";
    el.className = "skill-market-modal hidden";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML = `
      <div class="smm-backdrop" data-smm-close></div>
      <div class="smm-panel">
        <button class="smm-close" type="button" data-smm-close aria-label="关闭">×</button>
        <div class="smm-intro">
          <div class="smm-source-logo"></div>
          <div class="smm-title"></div>
          <div class="smm-meta"></div>
          <p class="smm-summary"></p>
        </div>
        <div class="smm-body hidden">
          <button class="smm-back" type="button">‹ 返回简介</button>
          <div class="smm-body-content"></div>
        </div>
        <div class="smm-actions">
          <button class="smm-body-toggle" type="button">展开正文</button>
          <button class="smm-add" type="button"></button>
        </div>
      </div>`;
    el.querySelectorAll("[data-smm-close]").forEach((node) => {
      node.addEventListener("click", closeMarketModal);
    });
    el.querySelector(".smm-body-toggle").addEventListener("click", () => {
      skillModal.showBody = !skillModal.showBody;
      renderSkillModal();
      if (skillModal.showBody && skillModal.kind === "market") loadMarketSkillBody(skillModal.skillId);
    });
    el.querySelector(".smm-back").addEventListener("click", () => {
      skillModal.showBody = false;
      renderSkillModal();
    });
    el.querySelector(".smm-add").addEventListener("click", () => {
      const skill = findModalSkill();
      if (!skill) return;
      if (skillModal.kind === "local") {
        useSkillInComposer(skill.id);
        closeMarketModal();
        return;
      }
      const installed = installedLocalSkillForMarket(skill);
      if (installed) {
        useSkillInComposer(installed.id);
        closeMarketModal();
      } else {
        installMarketSkill(skill.id);
      }
    });
    document.body.appendChild(el);
    skillModalEl = el;
    return el;
  }

  function onMarketModalKeydown(event) {
    if (event.key === "Escape") closeMarketModal();
  }

  function openMarketModal(skillId) {
    if (!skillId || !findMarketSkill(skillId)) return;
    skillModal = { kind: "market", skillId, showBody: false };
    ensureMarketModalEl().classList.remove("hidden");
    document.addEventListener("keydown", onMarketModalKeydown);
    renderSkillModal();
  }

  function openLocalSkillModal(skillId) {
    if (!skillId || !findLocalSkill(skillId)) return;
    skillModal = { kind: "local", skillId, showBody: false };
    ensureMarketModalEl().classList.remove("hidden");
    document.addEventListener("keydown", onMarketModalKeydown);
    renderSkillModal();
  }

  function closeMarketModal() {
    skillModal = { kind: "", skillId: "", showBody: false };
    if (skillModalEl) skillModalEl.classList.add("hidden");
    document.removeEventListener("keydown", onMarketModalKeydown);
  }

  function modalTitle(skill) {
    return skillModal.kind === "local"
      ? window.miaSkillHelpers.skillDisplayName(skill)
      : (skill.name_zh || skill.name || "技能");
  }

  function modalMeta(skill) {
    if (skillModal.kind === "local") {
      return [
        window.miaSkillHelpers.skillDisplayCategory(skill),
        localSkillModalSourceText(skill),
        skill.name || ""
      ].filter(Boolean).join(" · ");
    }
    const category = skill.category_zh || skill.category || "";
    const installs = formatInstallCount(skill.installCount);
    return [category, skill.sourceLabel, installs].filter(Boolean).join(" · ");
  }

  function modalSummary(skill) {
    return skillModal.kind === "local"
      ? window.miaSkillHelpers.skillSummaryZh(skill)
      : (skill.summary_zh || marketDescriptionZh(skill));
  }

  function modalSourceLogoHtml(skill) {
    return skillModal.kind === "local" ? skillSourceLogoHtml(skill) : marketSourceLogoHtml(skill);
  }

  function renderSkillModal() {
    if (!skillModalEl) return;
    const skill = findModalSkill();
    if (!skill) {
      closeMarketModal();
      return;
    }
    const installed = skillModal.kind === "market" ? installedLocalSkillForMarket(skill) : skill;
    const installing = skillModal.kind === "market" && state.installingSkillIds.has(skill.id);
    const hasBody = !!String(skill.body || "").trim();
    const bodyLoading = skillModal.kind === "market" && !!skill.marketBodyLoading;
    const bodyError = skillModal.kind === "market" ? String(skill.marketBodyError || "").trim() : "";

    skillModalEl.querySelector(".smm-source-logo").innerHTML = modalSourceLogoHtml(skill);
    setText(skillModalEl.querySelector(".smm-title"), modalTitle(skill));
    setText(skillModalEl.querySelector(".smm-meta"), modalMeta(skill));
    setText(skillModalEl.querySelector(".smm-summary"), modalSummary(skill));

    const intro = skillModalEl.querySelector(".smm-intro");
    const body = skillModalEl.querySelector(".smm-body");
    const bodyContent = skillModalEl.querySelector(".smm-body-content");
    const toggle = skillModalEl.querySelector(".smm-body-toggle");
    const add = skillModalEl.querySelector(".smm-add");

    if (skillModal.showBody) {
      intro.classList.add("hidden");
      body.classList.remove("hidden");
      bodyContent.innerHTML = hasBody
        ? window.miaSkillHelpers.renderSkillMarkdownSource(skill.body)
        : `<div class="skill-empty-state">${escapeHtml(bodyError || "正在读取完整正文...")}</div>`;
      bodyContent.querySelectorAll("a[href]").forEach((link) => {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noreferrer");
      });
      if (skillModal.kind === "market" && !hasBody && !bodyLoading && !bodyError) {
        loadMarketSkillBody(skill.id);
      }
    } else {
      intro.classList.remove("hidden");
      body.classList.add("hidden");
    }

    toggle.textContent = skillModal.showBody ? "收起正文" : "展开正文";
    toggle.disabled = false;
    add.disabled = installing;
    add.classList.toggle("smm-add-installed", !!installed);
    add.textContent = skillModal.kind === "local" || installed ? "使用" : installing ? "添加中…" : "添加";
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
    openSkillContextMenu,
    closeSkillContextMenu,
    renderSkillContextMenu,
    switchSkillMode,
    loadMarketSkills,
    installMarketSkill,
    openMarketModal,
    openLocalSkillModal,
    closeMarketModal,
  };
})();
