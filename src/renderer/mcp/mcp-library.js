(function () {
  "use strict";

  let state, els, escapeHtml, setText;
  let layoutCards = () => {};
  let activeLoadPromise = null;

  function initMcpLibrary(deps) {
    state = deps.state;
    els = deps.els;
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
    layoutCards = typeof deps.layoutCards === "function" ? deps.layoutCards : () => {};
  }

  function mcpState() {
    if (!state.mcp) {
      state.mcp = {
        activeTab: "installed",
        servers: [],
        templates: [],
        loaded: false,
        loadAttempted: false,
        loading: false,
        syncing: false,
        error: "",
        serverError: "",
        templateError: "",
        selectedId: "",
        formOpen: false,
        formMode: "create",
        formDraft: null,
        importOpen: false,
        importText: ""
      };
    }
    if (typeof state.mcp.loaded !== "boolean") state.mcp.loaded = false;
    if (typeof state.mcp.loadAttempted !== "boolean") state.mcp.loadAttempted = false;
    if (typeof state.mcp.serverError !== "string") state.mcp.serverError = "";
    if (typeof state.mcp.templateError !== "string") state.mcp.templateError = "";
    return state.mcp;
  }

  function syncAggregateError(mcp) {
    mcp.error = String(mcp.serverError || mcp.templateError || "");
  }

  function setMcpTab(tab) {
    const mcp = mcpState();
    mcp.activeTab = tab === "marketplace" || tab === "custom" ? tab : "installed";
    renderMcpLibrary();
  }

  function activeFilterText() {
    return String(state?.skillFilter || "").trim().toLowerCase();
  }

  function matchesFilter(values) {
    const needle = activeFilterText();
    if (!needle) return true;
    return values.join(" ").toLowerCase().includes(needle);
  }

  async function loadMcpServers(options = {}) {
    const mcp = mcpState();
    const force = options.force === true;
    if (mcp.loading && activeLoadPromise) return activeLoadPromise;
    if (!force && mcp.loadAttempted) return activeLoadPromise || Promise.resolve(mcp);
    if (!window.mia || !window.mia.mcp || typeof window.mia.mcp.list !== "function") {
      mcp.loaded = false;
      mcp.loadAttempted = true;
      mcp.serverError = "MCP 服务暂不可用";
      mcp.templateError = "";
      syncAggregateError(mcp);
      renderMcpLibrary();
      return Promise.resolve(mcp);
    }
    mcp.loading = true;
    mcp.serverError = "";
    mcp.templateError = "";
    syncAggregateError(mcp);
    renderMcpLibrary();
    activeLoadPromise = (async () => {
      try {
        const [listResult, marketResult] = await Promise.all([
          window.mia.mcp.list(),
          typeof window.mia.mcp.fetchMarketplace === "function"
            ? window.mia.mcp.fetchMarketplace()
            : Promise.resolve({ success: true, data: { templates: [] } })
        ]);
        if (listResult?.success) {
          mcp.servers = Array.isArray(listResult.data?.servers) ? listResult.data.servers : [];
          mcp.serverError = "";
        } else {
          mcp.servers = [];
          mcp.serverError = String(listResult?.error || "MCP 服务加载失败");
        }
        if (marketResult?.success) {
          mcp.templates = Array.isArray(marketResult.data?.templates) ? marketResult.data.templates : [];
          mcp.templateError = "";
        } else {
          mcp.templates = [];
          mcp.templateError = String(marketResult?.error || "MCP 模板加载失败");
        }
        mcp.loaded = !mcp.serverError && !mcp.templateError;
      } catch (error) {
        mcp.loaded = false;
        mcp.servers = [];
        mcp.templates = [];
        mcp.serverError = error?.message || "MCP 服务加载失败";
        mcp.templateError = "";
      } finally {
        mcp.loadAttempted = true;
        mcp.loading = false;
        syncAggregateError(mcp);
        renderMcpLibrary();
        activeLoadPromise = null;
      }
      return mcp;
    })();
    return activeLoadPromise;
  }

  function renderMcpTabs() {
    const mcp = mcpState();
    const tabs = [
      ["installed", "已安装", Array.isArray(mcp.servers) ? mcp.servers.length : 0],
      ["marketplace", "市场", Array.isArray(mcp.templates) ? mcp.templates.length : 0],
      ["custom", "自定义", ""]
    ];
    els.skillChipRow.innerHTML = tabs.map(([id, label, count]) => `
      <button class="${mcp.activeTab === id ? "active" : ""}" type="button" data-mcp-tab="${id}">
        ${escapeHtml(label)}${count === "" ? "" : ` <span>${count}</span>`}
      </button>
    `).join("");
    els.skillChipRow.querySelectorAll("[data-mcp-tab]").forEach((button) => {
      button.addEventListener("click", () => setMcpTab(button.dataset.mcpTab));
    });
  }

  function transportLabel(type) {
    const value = String(type || "").trim().toLowerCase();
    if (value === "streamable_http") return "streamable HTTP";
    if (value === "stdio") return "STDIO";
    if (value === "sse") return "SSE";
    if (value === "http") return "HTTP";
    return value || "unknown";
  }

  function transportSummary(transport = {}) {
    if (transport.type === "stdio") return [transport.command, ...(transport.args || [])].filter(Boolean).join(" ");
    return transport.url || "";
  }

  function connectionStatusLabel(status) {
    if (status === "connected") return "已连接";
    if (status === "auth_required") return "需要认证";
    if (status === "unsupported") return "不支持";
    if (status === "disconnected") return "未连接";
    return "状态未知";
  }

  function syncStatusLabel(entry = {}) {
    const statuses = Object.values(entry.sync || {});
    if (statuses.some((item) => String(item?.status || "") === "error")) return "同步异常";
    if (statuses.some((item) => String(item?.status || "") === "unsupported")) return "部分不支持";
    if (statuses.some((item) => String(item?.status || "") === "available")) return "待同步";
    if (statuses.some((item) => String(item?.status || "") === "pending")) return "同步中";
    if (statuses.some((item) => String(item?.status || "") === "synced")) return "已同步";
    return "";
  }

  function chip(className, label) {
    return `<span class="mcp-chip ${escapeHtml(className)}">${escapeHtml(label)}</span>`;
  }

  function renderServerCard(server) {
    const syncLabel = syncStatusLabel(server);
    const description = server.description || transportSummary(server.transport) || "未配置描述";
    return `
      <article class="skill-card mcp-card" data-mcp-id="${escapeHtml(server.id || "")}">
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(server.name || server.id || "MCP 服务")}</strong>
            ${server.enabled === false ? chip("mcp-chip-muted", "已停用") : ""}
          </div>
          <p>${escapeHtml(description)}</p>
        </div>
        <span class="skill-card-source">
          <span class="mcp-inline-chips">
            ${chip("mcp-chip-transport", transportLabel(server.transport?.type))}
            ${chip(`mcp-chip-status mcp-status-${String(server.status || "unknown")}`, connectionStatusLabel(server.status))}
            ${syncLabel ? chip("mcp-chip-sync", syncLabel) : ""}
            ${chip("mcp-chip-tools", `${Number(server.tools?.length || 0)} 个工具`)}
          </span>
        </span>
      </article>
    `;
  }

  function renderTemplateCard(template) {
    return `
      <article class="skill-card mcp-card mcp-template-card" data-mcp-template-id="${escapeHtml(template.id || "")}">
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(template.name || template.id || "MCP 模板")}</strong>
          </div>
          <p>${escapeHtml(template.description || "可安装的 MCP 模板")}</p>
        </div>
        <span class="skill-card-source">
          <span class="mcp-inline-chips">
            ${chip("mcp-chip-transport", transportLabel(template.transport?.type))}
            ${template.category ? chip("mcp-chip-muted", template.category) : ""}
            ${chip("mcp-chip-market", "模板")}
          </span>
        </span>
      </article>
    `;
  }

  function customEntryActions() {
    const mcp = mcpState();
    return [
      {
        id: "create",
        title: "新建服务",
        description: "录入 stdio、HTTP 或 SSE 服务。",
        chips: [chip("mcp-chip-muted", "表单入口")]
      },
      {
        id: "import",
        title: "导入 JSON",
        description: "载入现有 MCP 配置。",
        chips: [chip("mcp-chip-muted", "JSON"), chip("mcp-chip-muted", "导入")]
      },
      {
        id: "sync",
        title: "同步状态",
        description: "查看桥接与 Agent 同步结果。",
        chips: [chip(mcp.syncing ? "mcp-chip-sync" : "mcp-chip-muted", mcp.syncing ? "同步中" : "待检查")]
      }
    ];
  }

  function renderCustomActionCard(action) {
    return `
      <article class="skill-card mcp-card mcp-action-card" data-mcp-action="${escapeHtml(action.id)}">
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(action.title)}</strong>
          </div>
          <p>${escapeHtml(action.description)}</p>
        </div>
        <span class="skill-card-source">
          <span class="mcp-inline-chips">${action.chips.join("")}</span>
        </span>
      </article>
    `;
  }

  function filteredServers() {
    return (mcpState().servers || []).filter((server) => matchesFilter([
      server.id,
      server.name,
      server.description,
      server.transport?.type,
      transportSummary(server.transport),
      connectionStatusLabel(server.status)
    ]));
  }

  function filteredTemplates() {
    return (mcpState().templates || []).filter((template) => matchesFilter([
      template.id,
      template.name,
      template.description,
      template.category,
      template.transport?.type
    ]));
  }

  function filteredActions() {
    return customEntryActions().filter((action) => matchesFilter([
      action.id,
      action.title,
      action.description
    ]));
  }

  function renderGrid(html) {
    els.skillCardGrid.innerHTML = html;
    layoutCards();
  }

  function renderState(text) {
    renderGrid(`<div class="skill-empty-state">${escapeHtml(text)}</div>`);
  }

  function renderCards(items, renderItem) {
    renderGrid(items.map((item) => renderItem(item)).join(""));
  }

  function renderMcpLibrary() {
    const mcp = mcpState();
    setText(els.skillPageTitle, "MCP 服务");
    renderMcpTabs();

    if (mcp.activeTab === "custom") {
      const customItems = filteredActions();
      if (!customItems.length) {
        renderState("没有匹配的入口");
        return;
      }
      renderCards(customItems, renderCustomActionCard);
      return;
    }

    if (mcp.activeTab === "marketplace") {
      const templates = Array.isArray(mcp.templates) ? mcp.templates : [];
      if (!mcp.loadAttempted && !mcp.loading) {
        renderState("正在加载 MCP 模板...");
        return;
      }
      if (mcp.loading && !templates.length) {
        renderState("正在加载 MCP 模板...");
        return;
      }
      if (mcp.templateError && !templates.length) {
        renderState(mcp.templateError || "MCP 模板加载失败");
        return;
      }
      const shownTemplates = filteredTemplates();
      if (!shownTemplates.length) {
        renderState(templates.length ? "没有匹配的模板" : "暂无可用模板");
        return;
      }
      renderCards(shownTemplates, renderTemplateCard);
      return;
    }

    const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
    if (!mcp.loadAttempted && !mcp.loading) {
      renderState("正在加载 MCP 服务...");
      return;
    }
    if (mcp.loading && !servers.length) {
      renderState("正在加载 MCP 服务...");
      return;
    }
    if (mcp.serverError && !servers.length) {
      renderState(mcp.serverError || "MCP 服务加载失败");
      return;
    }
    const shownServers = filteredServers();
    if (!shownServers.length) {
      renderState(servers.length ? "没有匹配的 MCP 服务" : "暂无已安装 MCP 服务");
      return;
    }
    renderCards(shownServers, renderServerCard);
  }

  window.miaMcpLibrary = {
    initMcpLibrary,
    loadMcpServers,
    renderMcpLibrary
  };
})();
