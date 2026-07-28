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
  let chipRowIndicatorResizeBound = false;
  let pageTurnDirection = 0;
  const SKILL_MODE_ORDER = Object.freeze({ market: 0, mine: 1, mcp: 2 });

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

  function scrollChipButtonIntoView(button, behavior = "smooth") {
    const row = els?.skillChipRow;
    if (!button || !row) return;
    const rowWidth = Number(row.clientWidth) || 0;
    const scrollWidth = Number(row.scrollWidth) || 0;
    if (scrollWidth <= rowWidth || rowWidth <= 0) return;
    const prefersReducedMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rowRect = typeof row.getBoundingClientRect === "function" ? row.getBoundingClientRect() : { left: 0 };
    const buttonRect = typeof button.getBoundingClientRect === "function" ? button.getBoundingClientRect() : { left: 0, width: 0 };
    const buttonLeft = Number.isFinite(button.offsetLeft)
      ? button.offsetLeft
      : (Number(buttonRect.left) || 0) - (Number(rowRect.left) || 0) + (Number(row.scrollLeft) || 0);
    const buttonWidth = Number.isFinite(button.offsetWidth) && button.offsetWidth > 0
      ? button.offsetWidth
      : (Number(buttonRect.width) || 0);
    const maxLeft = Math.max(0, scrollWidth - rowWidth);
    const targetLeft = Math.max(0, Math.min(maxLeft, buttonLeft - Math.max(0, rowWidth - buttonWidth) / 2));
    if (Math.abs((Number(row.scrollLeft) || 0) - targetLeft) < 1) return;
    try {
      row.scrollTo?.({
        left: targetLeft,
        top: Number(row.scrollTop) || 0,
        behavior: prefersReducedMotion ? "auto" : behavior
      });
    } catch {
      row.scrollLeft = targetLeft;
    }
    if (typeof row.scrollTo !== "function") row.scrollLeft = targetLeft;
  }

  function syncChipRowIndicator(behavior = "auto") {
    const row = els?.skillChipRow;
    if (!row) return;

    const update = () => {
      const active = row.querySelector("button.active");
      if (!active || typeof active.getBoundingClientRect !== "function") {
        row.style.setProperty("--pill-ready", "0");
        return;
      }
      scrollChipButtonIntoView(active, behavior);
      const activeRect = active.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const pillX = Number.isFinite(active.offsetLeft)
        ? active.offsetLeft
        : (activeRect.left - rowRect.left + row.scrollLeft);
      const pillW = Number.isFinite(active.offsetWidth) && active.offsetWidth > 0
        ? active.offsetWidth
        : activeRect.width;
      row.style.setProperty("--pill-x", `${pillX}px`);
      row.style.setProperty("--pill-w", `${pillW}px`);
      row.style.setProperty("--pill-ready", "1");
    };

    if (typeof requestAnimationFrame === "function") requestAnimationFrame(update);
    else update();

    if (!chipRowIndicatorResizeBound && typeof window !== "undefined") {
      chipRowIndicatorResizeBound = true;
      window.addEventListener("resize", () => syncChipRowIndicator("auto"));
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
    const category = currentSkillMode() === "mine" ? "" : state.skillCategoryFilter.trim().toLowerCase();
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

  function localSkillMarketSourceLabel(skill) {
    const explicit = String(skill?.marketSourceLabel || "").trim();
    if (explicit) return explicit;
    const sourceKey = marketSourceKey(skill);
    return marketSourceLogo(skill, sourceKey)?.label || "";
  }

  function skillSourceLogoView(skill) {
    const sourceLabel = localSkillMarketSourceLabel(skill);
    if (!sourceLabel && !skill?.marketUpstreamSource) return null;
    return marketSourceLogoView({
      sourceLabel,
      ownerLabel: sourceLabel,
      upstreamSource: skill.marketUpstreamSource || skill.upstreamSource || "",
      category: window.miaSkillHelpers.skillDisplayCategory(skill)
    });
  }

  function renderSkillCard(skill) {
    const sourceText = localSkillMarketSourceLabel(skill) || skill.pluginLabel || window.miaSkillHelpers.skillAuthorLabel(skill);
    return {
      actions: [],
      className: skill.id === state.selectedSkillId ? "featured" : "",
      description: window.miaSkillHelpers.skillSummaryZh(skill),
      id: `local:${skill.id}`,
      open: () => selectSkill(skill.id),
      openContextMenu: (x, y) => openSkillContextMenu(skill.id, x, y),
      sourceLogo: skillSourceLogoView(skill),
      sourceText,
      statusClass: "",
      statusLabel: "",
      title: window.miaSkillHelpers.skillDisplayName(skill),
    };
  }

  function publishSkillGrid(cards, emptyText = "") {
    window.miaReactSkills?.publish?.({
      cards,
      emptyText,
      pageDirection: pageTurnDirection
    });
  }

  function renderChips(entries) {
    const mode = currentSkillMode();
    const categoryEntries = entries.slice(0, 12);
    const chipKeys = ["", "__mine__", ...categoryEntries.map(([category]) => category)];
    const scopeChips = isSkillCollectionMode(mode)
      ? [
          {
            active: mode === "market" && !state.skillCategoryFilter,
            id: "scope:all",
            label: "全部",
            select: () => {
              if (currentSkillMode() === "market" && !state.skillCategoryFilter) return;
              pageTurnDirection = currentSkillMode() === "mine" ? -1 : 1;
              window.miaMasonryGrid?.capture(els.skillCardGrid, pageTurnDirection);
              state.skillCapabilityMode = "market";
              state.skillMarketMode = true;
              state.skillCategoryFilter = "";
              closeSkillContextMenu();
              renderSkillLibrary();
            }
          },
          {
            active: mode === "mine",
            id: "scope:mine",
            label: "我的技能",
            select: () => switchSkillMode("mine")
          }
        ]
      : [];
    const chips = [
      ...scopeChips,
      ...categoryEntries.map(([category, count]) => ({
        active: mode === "market" && state.skillCategoryFilter === category,
        ariaLabel: count ? `${category}，${count} 个技能` : category,
        id: `category:${category}`,
        label: category,
        select: () => {
          const next = category;
          const modeNow = currentSkillMode();
          if (modeNow === "market" && state.skillCategoryFilter === next) return;
          const fromKey = modeNow === "mine" ? "__mine__" : (state.skillCategoryFilter || "");
          const fromIndex = Math.max(0, chipKeys.indexOf(fromKey));
          const toIndex = Math.max(0, chipKeys.indexOf(next));
          pageTurnDirection = toIndex >= fromIndex ? 1 : -1;
          window.miaMasonryGrid?.capture(els.skillCardGrid, pageTurnDirection);
          state.skillCapabilityMode = "market";
          state.skillMarketMode = true;
          state.skillCategoryFilter = next;
          closeSkillContextMenu();
          renderSkillLibrary();
        }
      }))
    ];
    window.miaReactSkills?.publish?.({ chips, mode: "skills" });
  }

  function currentSkillMode() {
    const explicit = String(state?.skillCapabilityMode || "").trim();
    if (explicit === "market" || explicit === "mine" || explicit === "mcp") return explicit;
    return state?.skillMarketMode ? "market" : "mine";
  }

  function isSkillCollectionMode(mode = currentSkillMode()) {
    return mode === "market" || mode === "mine";
  }

  function renderModeToggle() {
    if (!els.skillModeToggle) return;
    const mode = currentSkillMode();
    const skillActive = isSkillCollectionMode(mode);
    window.miaReactSkills?.publish?.({
      mode: mode === "mcp" ? "mcp" : "skills",
      modeTabs: [
        {
          active: skillActive,
          id: "skills",
          label: "技能",
          select: () => switchSkillMode(skillActive ? mode : "market")
        },
        {
          active: mode === "mcp",
          id: "mcp",
          label: "MCP 服务",
          select: () => switchSkillMode("mcp")
        }
      ]
    });
  }

  function switchSkillMode(nextMode) {
    const mode = nextMode === true
      ? "market"
      : nextMode === false
        ? "mine"
        : nextMode === "mcp"
          ? "mcp"
          : nextMode === "mine"
            ? "mine"
            : "market";
    const modeNow = currentSkillMode();
    if (modeNow === mode) return;
    pageTurnDirection = (SKILL_MODE_ORDER[mode] || 0) >= (SKILL_MODE_ORDER[modeNow] || 0) ? 1 : -1;
    window.miaMasonryGrid?.capture(els.skillCardGrid, pageTurnDirection);
    state.skillCapabilityMode = mode;
    state.skillMarketMode = mode === "market";
    state.skillCategoryFilter = "";
    closeSkillContextMenu();
    renderSkillLibrary();
    if (mode === "market" && !state.skillMarket.loaded && !state.skillMarket.loading) loadMarketSkills();
  }

  function skillScrollContainer() {
    return els?.skillCardGrid?.closest?.(".skills-layout") || null;
  }

  function preserveSkillScroll(fn) {
    const scroller = skillScrollContainer();
    const top = scroller ? scroller.scrollTop : 0;
    const left = scroller ? scroller.scrollLeft : 0;
    const restore = () => {
      if (!scroller || scroller.isConnected === false) return;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.min(top, maxTop);
      scroller.scrollLeft = left;
    };
    fn();
    restore();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        restore();
        requestAnimationFrame(restore);
      });
    }
  }

  function renderSkillLibrary(options = {}) {
    if (!state || !els || !els.skillChipRow || !els.skillCardGrid) return;
    const render = () => {
      renderModeToggle();
      if (currentSkillMode() === "mcp") {
        const startedLoad = ensureMcpLibraryLoaded();
        if (!startedLoad && window.miaMcpLibrary && window.miaMcpLibrary.renderMcpLibrary) window.miaMcpLibrary.renderMcpLibrary();
      } else if (currentSkillMode() === "market") renderMarketView();
      else renderLocalView();
      renderSkillContextMenu();
    };
    if (options.preserveScroll) preserveSkillScroll(render);
    else render();
  }

  function layoutSkillCards() {
    const direction = pageTurnDirection;
    pageTurnDirection = 0;
    window.miaMasonryGrid?.layout(els.skillCardGrid, ".skill-card", { animate: direction });
  }

  function ensureMcpLibraryLoaded() {
    const mcp = state?.mcp;
    if (!window.miaMcpLibrary || typeof window.miaMcpLibrary.loadMcpServers !== "function") return false;
    if (mcp?.loading || mcp?.loadAttempted) return false;
    window.miaMcpLibrary.loadMcpServers();
    return true;
  }

  function renderLocalView() {
    setText(els.skillPageTitle, state.skillsLoading ? "正在扫描能力" : "技能");
    renderChips(marketCategoryEntries());
    const shown = visibleSkills();
    publishSkillGrid(shown.map((skill) => renderSkillCard(skill)), shown.length ? "" : skillEmptyText());
    pageTurnDirection = 0;
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
      if (currentSkillMode() === "market") loadMarketSkills(marketRequestParams(), { forceRefresh: true });
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

  function marketSourceLogoView(skill) {
    const key = marketSourceKey(skill);
    const logo = marketSourceLogo(skill, key);
    if (!logo) return null;
    return {
      key,
      label: logo.label || "",
      mask: !!logo.mask,
      src: logo.src || ""
    };
  }

  function renderMarketCard(skill) {
    const meta = [skill.sourceLabel, formatInstallCount(skill.installCount)].filter(Boolean).join(" · ");
    return {
      actions: [],
      className: "market-card",
      description: marketDescriptionZh(skill),
      id: `market:${skill.id}`,
      open: () => openMarketModal(skill.id),
      openContextMenu: () => reportMarketSkill(skill.id),
      sourceLogo: marketSourceLogoView(skill),
      sourceText: meta,
      statusClass: "",
      statusLabel: "",
      title: skill.name_zh || skill.name,
    };
  }

  function renderMarketView() {
    setText(els.skillPageTitle, "技能");
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
      publishSkillGrid([], "正在加载技能...");
      pageTurnDirection = 0;
      return;
    }
    if (state.skillMarket.error && !(state.skillMarket.skills || []).length) {
      publishSkillGrid([], "技能加载失败，请稍后重试。");
      pageTurnDirection = 0;
      return;
    }
    const shown = visibleMarketSkills();
    publishSkillGrid(shown.map((skill) => renderMarketCard(skill)), shown.length ? "" : "没有匹配的技能");
    pageTurnDirection = 0;
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
    const preserveExistingScroll = background || hasCurrentPage;
    if (!preserveExistingScroll) renderSkillLibrary();
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
        renderSkillLibrary({ preserveScroll: preserveExistingScroll });
      }
      if (shouldRefresh) loadMarketSkills(params, { forceRefresh: true, background: true });
    }
  }

  async function installMarketSkill(skillId) {
    if (!skillId || !state || state.installingSkillIds.has(skillId)) return;
    // Desktop install uses the unified market path: local snapshot when current,
    // cloud package download when the skill is new or newer than the snapshot.
    state.installingSkillIds.add(skillId);
    renderMarketSkillInstallState(skillId);
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
      renderMarketSkillInstallState(skillId);
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

  function renderMarketSkillInstallState(skillId) {
    renderSkillLibrary();
    if (skillModal.kind === "market" && skillModal.skillId === skillId) renderSkillModal();
  }

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

  function onMarketModalKeydown(event) {
    if (event.key === "Escape") closeMarketModal();
  }

  function openMarketModal(skillId) {
    if (!skillId || !findMarketSkill(skillId)) return;
    skillModal = { kind: "market", skillId, showBody: false };
    document.addEventListener("keydown", onMarketModalKeydown);
    renderSkillModal();
  }

  function openLocalSkillModal(skillId) {
    if (!skillId || !findLocalSkill(skillId)) return;
    skillModal = { kind: "local", skillId, showBody: false };
    document.addEventListener("keydown", onMarketModalKeydown);
    renderSkillModal();
  }

  function closeMarketModal() {
    skillModal = { kind: "", skillId: "", showBody: false };
    window.miaReactDialogs?.publish?.({ dialog: { kind: "closed" } });
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

  function modalSourceLogoView(skill) {
    return skillModal.kind === "local" ? skillSourceLogoView(skill) : marketSourceLogoView(skill);
  }

  function renderSkillModal() {
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

    const primary = () => {
      const current = findModalSkill();
      if (!current) return;
      if (skillModal.kind === "local") {
        useSkillInComposer(current.id);
        closeMarketModal();
        return;
      }
      const currentInstalled = installedLocalSkillForMarket(current);
      if (currentInstalled) {
        useSkillInComposer(currentInstalled.id);
        closeMarketModal();
      } else {
        installMarketSkill(current.id);
      }
    };
    window.miaReactDialogs?.publish?.({
      dialog: {
        actionDisabled: installing,
        actionInstalled: !!installed,
        actionLabel: skillModal.kind === "local" || installed ? "使用" : installing ? "添加中…" : "添加",
        back: () => {
          skillModal.showBody = false;
          renderSkillModal();
        },
        bodyHtml: hasBody ? window.miaSkillHelpers.renderSkillMarkdownSource(skill.body) : "",
        bodyState: bodyError || (bodyLoading ? "正在读取完整正文..." : "正在读取完整正文..."),
        close: closeMarketModal,
        kind: "skill",
        meta: modalMeta(skill),
        primary,
        showBody: skillModal.showBody,
        sourceLogo: modalSourceLogoView(skill),
        summary: modalSummary(skill),
        title: modalTitle(skill),
        toggleBody: () => {
          skillModal.showBody = !skillModal.showBody;
          renderSkillModal();
          if (skillModal.showBody && skillModal.kind === "market") loadMarketSkillBody(skillModal.skillId);
        }
      }
    });
    if (skillModal.showBody && skillModal.kind === "market" && !hasBody && !bodyLoading && !bodyError) {
      loadMarketSkillBody(skill.id);
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
    openSkillContextMenu,
    closeSkillContextMenu,
    renderSkillContextMenu,
    layoutSkillCards,
    switchSkillMode,
    loadMarketSkills,
    installMarketSkill,
    openMarketModal,
    openLocalSkillModal,
    closeMarketModal,
  };
})();
