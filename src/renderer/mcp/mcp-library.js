(function () {
  "use strict";

  let state, els, escapeHtml, setText;
  let layoutCards = () => {};
  let activeLoadPromise = null;
  let activeDialog = null;

  const MCP_TRANSPORT_TYPES = Object.freeze(["stdio", "http", "sse", "streamable_http"]);

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
    if (typeof state.mcp.formOpen !== "boolean") state.mcp.formOpen = false;
    if (typeof state.mcp.importOpen !== "boolean") state.mcp.importOpen = false;
    if (typeof state.mcp.formMode !== "string") state.mcp.formMode = "create";
    if (typeof state.mcp.importText !== "string") state.mcp.importText = "";
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

  function alertText(message) {
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(message);
      return;
    }
    console.warn(message);
  }

  function confirmAction(message) {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      return window.confirm(message);
    }
    return true;
  }

  function normalizeTransportType(value) {
    const type = String(value || "").trim().toLowerCase();
    return MCP_TRANSPORT_TYPES.includes(type) ? type : "stdio";
  }

  function parseLineList(value) {
    return String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseKeyValueLines(text, separatorPattern) {
    const out = {};
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const match = line.match(separatorPattern);
        if (match) out[match[1].trim()] = match[2].trim();
      });
    return out;
  }

  function serializeKeyValueLines(source = {}, separator = "=") {
    return Object.entries(source || {})
      .map(([key, value]) => `${key}${separator}${value}`)
      .join("\n");
  }

  function normalizeDialogTransport(transport = {}) {
    const type = normalizeTransportType(transport.type);
    if (type === "stdio") {
      return {
        type,
        command: String(transport.command || "").trim(),
        args: Array.isArray(transport.args) ? transport.args : [],
        env: transport.env && typeof transport.env === "object" ? transport.env : {}
      };
    }
    return {
      type,
      url: String(transport.url || "").trim(),
      headers: transport.headers && typeof transport.headers === "object" ? transport.headers : {},
      bearerTokenEnvVar: String(transport.bearerTokenEnvVar || transport.bearer_token_env_var || "").trim()
    };
  }

  function closeActiveDialog() {
    if (!activeDialog) return;
    const { overlay, onKeyDown } = activeDialog;
    if (typeof document !== "undefined" && onKeyDown) {
      document.removeEventListener("keydown", onKeyDown);
    }
    overlay?.remove?.();
    activeDialog = null;
    const mcp = mcpState();
    mcp.formOpen = false;
    mcp.importOpen = false;
  }

  function bindDialogClose(overlay) {
    if (!overlay || typeof document === "undefined") return;
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeActiveDialog();
    };
    document.addEventListener("keydown", onKeyDown);
    activeDialog = { overlay, onKeyDown };
    overlay.querySelectorAll("[data-mcp-close]").forEach((button) => {
      button.addEventListener("click", () => closeActiveDialog());
    });
  }

  function appendDialog(overlay) {
    if (!overlay || typeof document === "undefined" || !document.body) return false;
    closeActiveDialog();
    document.body.appendChild(overlay);
    bindDialogClose(overlay);
    return true;
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
        <div class="mcp-card-actions">
          <button type="button" data-mcp-action="test" data-mcp-id="${escapeHtml(server.id || "")}">测试</button>
          <button type="button" data-mcp-action="sync" data-mcp-id="${escapeHtml(server.id || "")}">同步</button>
          <button type="button" data-mcp-action="toggle" data-mcp-id="${escapeHtml(server.id || "")}">${server.enabled === false ? "启用" : "禁用"}</button>
          <button type="button" data-mcp-action="edit" data-mcp-id="${escapeHtml(server.id || "")}">编辑</button>
          <button type="button" data-mcp-action="delete" data-mcp-id="${escapeHtml(server.id || "")}">删除</button>
        </div>
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
        <div class="mcp-card-actions">
          <button type="button" data-mcp-action="install" data-mcp-template="${escapeHtml(template.id || "")}">安装</button>
        </div>
      </article>
    `;
  }

  function customEntryActions() {
    const mcp = mcpState();
    return [
      {
        id: "create",
        title: "新建服务",
        description: "录入 stdio、HTTP、SSE 或 streamable HTTP 服务。",
        buttonLabel: "打开表单",
        chips: [chip("mcp-chip-muted", "表单入口")]
      },
      {
        id: "import",
        title: "导入 JSON",
        description: "载入现有 mcpServers 配置。",
        buttonLabel: "导入 JSON",
        chips: [chip("mcp-chip-muted", "JSON"), chip("mcp-chip-muted", "导入")]
      },
      {
        id: "sync",
        title: "同步状态",
        description: "查看桥接与 Agent 同步结果。",
        buttonLabel: mcp.syncing ? "同步中..." : "立即同步",
        chips: [chip(mcp.syncing ? "mcp-chip-sync" : "mcp-chip-muted", mcp.syncing ? "同步中" : "待检查")]
      }
    ];
  }

  function renderCustomActionCard(action) {
    return `
      <article class="skill-card mcp-card mcp-action-card">
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(action.title)}</strong>
          </div>
          <p>${escapeHtml(action.description)}</p>
        </div>
        <span class="skill-card-source">
          <span class="mcp-inline-chips">${action.chips.join("")}</span>
        </span>
        <div class="mcp-card-actions">
          <button type="button" data-mcp-action="${escapeHtml(action.id)}">${escapeHtml(action.buttonLabel)}</button>
        </div>
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

  function bindMcpActionHandlers() {
    els.skillCardGrid.querySelectorAll("[data-mcp-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        handleMcpAction(
          button.dataset.mcpAction,
          button.dataset.mcpId || button.dataset.mcpTemplate || ""
        );
      });
    });
  }

  function renderGrid(html) {
    els.skillCardGrid.innerHTML = html;
    bindMcpActionHandlers();
    layoutCards();
  }

  function renderState(text) {
    renderGrid(`<div class="skill-empty-state">${escapeHtml(text)}</div>`);
  }

  function renderCards(items, renderItem) {
    renderGrid(items.map((item) => renderItem(item)).join(""));
  }

  function toggleTransportFields(form, type) {
    const isStdio = normalizeTransportType(type) === "stdio";
    form.querySelectorAll("[data-mcp-stdio]").forEach((node) => {
      node.hidden = !isStdio;
    });
    form.querySelectorAll("[data-mcp-url]").forEach((node) => {
      node.hidden = isStdio;
    });
  }

  function openMcpForm(server) {
    if (typeof document === "undefined" || !document.body) return;
    const mcp = mcpState();
    const isEdit = !!server;
    const transport = normalizeDialogTransport(server?.transport || {});
    const overlay = document.createElement("section");
    overlay.className = "mcp-dialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", isEdit ? "编辑 MCP 服务" : "添加 MCP 服务");
    overlay.innerHTML = `
      <div class="mcp-dialog-backdrop" data-mcp-close></div>
      <form class="mcp-dialog-panel" data-mcp-form>
        <header class="mcp-dialog-head">
          <h2>${isEdit ? "编辑 MCP 服务" : "添加 MCP 服务"}</h2>
          <button type="button" data-mcp-close aria-label="关闭">×</button>
        </header>
        <label>名称<input name="name" value="${escapeHtml(server?.name || "")}" required></label>
        <label>描述<input name="description" value="${escapeHtml(server?.description || "")}"></label>
        <label>传输类型
          <select name="type">
            ${MCP_TRANSPORT_TYPES.map((type) => (
              `<option value="${type}" ${transport.type === type ? "selected" : ""}>${type}</option>`
            )).join("")}
          </select>
        </label>
        <label data-mcp-stdio>命令<input name="command" value="${escapeHtml(transport.command || "")}"></label>
        <label data-mcp-stdio>参数<textarea name="args">${escapeHtml((transport.args || []).join("\n"))}</textarea></label>
        <label data-mcp-stdio>环境变量<textarea name="env">${escapeHtml(serializeKeyValueLines(transport.env || {}, "="))}</textarea></label>
        <label data-mcp-url>URL<input name="url" value="${escapeHtml(transport.url || "")}"></label>
        <label data-mcp-url>Headers<textarea name="headers">${escapeHtml(serializeKeyValueLines(transport.headers || {}, ": "))}</textarea></label>
        <label data-mcp-url>Bearer Token 环境变量<input name="bearerTokenEnvVar" value="${escapeHtml(transport.bearerTokenEnvVar || "")}"></label>
        <footer class="mcp-dialog-actions">
          <button type="button" data-mcp-close>取消</button>
          <button type="submit">${isEdit ? "保存" : "添加"}</button>
        </footer>
      </form>
    `;
    if (!appendDialog(overlay)) return;
    mcp.formOpen = true;
    mcp.formMode = isEdit ? "edit" : "create";
    mcp.formDraft = server || null;
    const form = overlay.querySelector("[data-mcp-form]");
    const typeSelect = form?.querySelector('select[name="type"]');
    toggleTransportFields(form, transport.type);
    typeSelect?.addEventListener("change", () => toggleTransportFields(form, typeSelect.value));
    form?.addEventListener("submit", (event) => submitMcpForm(event, {
      id: server?.id || "",
      enabled: server?.enabled !== false
    }));
  }

  async function submitMcpForm(event, options = {}) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form || typeof FormData === "undefined") return;
    const data = new FormData(form);
    const type = normalizeTransportType(data.get("type"));
    const transport = type === "stdio"
      ? {
        type,
        command: String(data.get("command") || "").trim(),
        args: parseLineList(data.get("args")),
        env: parseKeyValueLines(data.get("env"), /^([^=]+)=(.*)$/)
      }
      : {
        type,
        url: String(data.get("url") || "").trim(),
        headers: parseKeyValueLines(data.get("headers"), /^([^:]+):(.*)$/),
        bearerTokenEnvVar: String(data.get("bearerTokenEnvVar") || "").trim()
      };
    const result = await window.mia.mcp.save({
      id: String(options.id || "").trim(),
      name: String(data.get("name") || "").trim(),
      description: String(data.get("description") || "").trim(),
      enabled: options.enabled !== false,
      transport
    });
    if (!result?.success) {
      alertText(`保存失败：${result?.error || "未知错误"}`);
      return;
    }
    mcpState().activeTab = "installed";
    closeActiveDialog();
    await loadMcpServers({ force: true });
  }

  function openImportForm() {
    if (typeof document === "undefined" || !document.body) return;
    const mcp = mcpState();
    const overlay = document.createElement("section");
    overlay.className = "mcp-dialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "导入 MCP JSON");
    overlay.innerHTML = `
      <div class="mcp-dialog-backdrop" data-mcp-close></div>
      <form class="mcp-dialog-panel" data-mcp-import-form>
        <header class="mcp-dialog-head">
          <h2>导入 mcpServers JSON</h2>
          <button type="button" data-mcp-close aria-label="关闭">×</button>
        </header>
        <label>配置 JSON
          <textarea name="json" class="mcp-import-textarea">${escapeHtml(mcp.importText || '{\n  "mcpServers": {}\n}')}</textarea>
        </label>
        <footer class="mcp-dialog-actions">
          <button type="button" data-mcp-close>取消</button>
          <button type="submit">导入</button>
        </footer>
      </form>
    `;
    if (!appendDialog(overlay)) return;
    mcp.importOpen = true;
    const form = overlay.querySelector("[data-mcp-import-form]");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = String(new FormData(form).get("json") || "");
      mcp.importText = text;
      const result = await importMcpJson(text);
      if (result?.success) closeActiveDialog();
    });
  }

  async function importMcpJson(text) {
    const result = await window.mia.mcp.importJson(text);
    if (!result?.success) {
      alertText(`导入失败：${result?.error || "未知错误"}`);
      return result;
    }
    mcpState().activeTab = "installed";
    await loadMcpServers({ force: true });
    return result;
  }

  async function testMcpServer(id) {
    const result = await window.mia.mcp.test(id);
    if (!result?.success) alertText(`测试失败：${result?.error || "未知错误"}`);
    await loadMcpServers({ force: true });
  }

  async function syncMcpServers() {
    const mcp = mcpState();
    mcp.syncing = true;
    renderMcpLibrary();
    try {
      const result = await window.mia.mcp.sync();
      if (!result?.success) alertText(`同步失败：${result?.error || "未知错误"}`);
      await loadMcpServers({ force: true });
    } finally {
      mcp.syncing = false;
      renderMcpLibrary();
    }
  }

  async function toggleMcpServer(id) {
    const server = mcpState().servers.find((item) => item.id === id);
    if (!server) return;
    const result = await window.mia.mcp.setEnabled(id, !server.enabled);
    if (!result?.success) {
      alertText(`${server.enabled === false ? "启用" : "禁用"}失败：${result?.error || "未知错误"}`);
    }
    await loadMcpServers({ force: true });
  }

  async function deleteMcpServer(id) {
    if (!confirmAction("删除这个 MCP 服务？")) return;
    const result = await window.mia.mcp.delete(id);
    if (!result?.success) alertText(`删除失败：${result?.error || "未知错误"}`);
    await loadMcpServers({ force: true });
  }

  async function installTemplate(id) {
    const result = await window.mia.mcp.installTemplate(id, {});
    if (!result?.success) {
      alertText(`安装失败：${result?.error || "未知错误"}`);
      return;
    }
    mcpState().activeTab = "installed";
    await loadMcpServers({ force: true });
  }

  async function handleMcpAction(action, id) {
    if (action === "create") return openMcpForm(null);
    if (action === "import") return openImportForm();
    if (action === "edit") return openMcpForm(mcpState().servers.find((server) => server.id === id));
    if (action === "test") return testMcpServer(id);
    if (action === "sync") return syncMcpServers();
    if (action === "toggle") return toggleMcpServer(id);
    if (action === "delete") return deleteMcpServer(id);
    if (action === "install") return installTemplate(id);
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
