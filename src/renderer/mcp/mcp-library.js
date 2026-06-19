(function () {
  "use strict";

  let state, els, escapeHtml, setText;

  function initMcpLibrary(deps) {
    state = deps.state;
    els = deps.els;
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
  }

  function mcpState() {
    if (!state.mcp) {
      state.mcp = {
        activeTab: "installed",
        servers: [],
        templates: [],
        loading: false,
        syncing: false,
        error: "",
        selectedId: "",
        formOpen: false,
        formMode: "create",
        formDraft: null,
        importOpen: false,
        importText: ""
      };
    }
    return state.mcp;
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

  function hasLoadedRecords() {
    const mcp = mcpState();
    return !!(
      (Array.isArray(mcp.servers) && mcp.servers.length)
      || (Array.isArray(mcp.templates) && mcp.templates.length)
      || mcp.error
    );
  }

  async function loadMcpServers() {
    const mcp = mcpState();
    if (!window.mia || !window.mia.mcp || typeof window.mia.mcp.list !== "function") {
      mcp.error = "MCP 服务暂不可用";
      renderMcpLibrary();
      return;
    }
    mcp.loading = true;
    mcp.error = "";
    renderMcpLibrary();
    try {
      const [listResult, marketResult] = await Promise.all([
        window.mia.mcp.list(),
        typeof window.mia.mcp.fetchMarketplace === "function"
          ? window.mia.mcp.fetchMarketplace()
          : Promise.resolve({ success: true, data: { templates: [] } })
      ]);
      if (listResult?.success) mcp.servers = Array.isArray(listResult.data?.servers) ? listResult.data.servers : [];
      else mcp.error = String(listResult?.error || "MCP 服务加载失败");
      if (marketResult?.success) mcp.templates = Array.isArray(marketResult.data?.templates) ? marketResult.data.templates : [];
      else if (!mcp.error) mcp.error = String(marketResult?.error || "MCP 模板加载失败");
    } catch (error) {
      mcp.error = error?.message || "MCP 服务加载失败";
    } finally {
      mcp.loading = false;
      renderMcpLibrary();
    }
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

  function renderState(text) {
    els.skillCardGrid.innerHTML = `<div class="skill-empty-state">${escapeHtml(text)}</div>`;
  }

  function currentItems() {
    const mcp = mcpState();
    if (mcp.activeTab === "marketplace") return mcp.templates || [];
    if (mcp.activeTab === "custom") return customEntryActions();
    return mcp.servers || [];
  }

  function renderMcpLibrary() {
    const mcp = mcpState();
    setText(els.skillPageTitle, "MCP 服务");
    renderMcpTabs();
    if (!mcp.loading && !hasLoadedRecords()) {
      loadMcpServers();
      return;
    }
    if (mcp.loading) {
      renderState("正在加载 MCP 服务...");
      return;
    }

    const items = mcp.activeTab === "marketplace"
      ? filteredTemplates()
      : mcp.activeTab === "custom"
        ? filteredActions()
        : filteredServers();

    if (mcp.error && !currentItems().length) {
      renderState(mcp.error || "MCP 服务加载失败");
      return;
    }
    if (!items.length) {
      if (mcp.activeTab === "marketplace") renderState("暂无可用模板");
      else if (mcp.activeTab === "custom") renderState("没有匹配的入口");
      else renderState("暂无已安装 MCP 服务");
      return;
    }

    els.skillCardGrid.innerHTML = items.map((item) => {
      if (mcp.activeTab === "marketplace") return renderTemplateCard(item);
      if (mcp.activeTab === "custom") return renderCustomActionCard(item);
      return renderServerCard(item);
    }).join("");
  }

  window.miaMcpLibrary = {
    initMcpLibrary,
    loadMcpServers,
    renderMcpLibrary
  };
})();
