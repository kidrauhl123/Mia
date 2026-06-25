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
        agentConfigs: [],
        agentConfigsLoaded: false,
        agentConfigsError: "",
        loaded: false,
        loadAttempted: false,
        loading: false,
        syncing: false,
        oauthBusyId: "",
        error: "",
        serverError: "",
        templateError: "",
        selectedId: "",
        formOpen: false,
        formMode: "create",
        formDraft: null,
        importOpen: false,
        importText: "",
        templateWizardOpen: false,
        templateWizardBusy: false,
        activeTemplateId: "",
        managedBusyKey: ""
      };
    }
    if (typeof state.mcp.loaded !== "boolean") state.mcp.loaded = false;
    if (typeof state.mcp.loadAttempted !== "boolean") state.mcp.loadAttempted = false;
    if (typeof state.mcp.serverError !== "string") state.mcp.serverError = "";
    if (typeof state.mcp.templateError !== "string") state.mcp.templateError = "";
    if (!Array.isArray(state.mcp.agentConfigs)) state.mcp.agentConfigs = [];
    if (typeof state.mcp.agentConfigsLoaded !== "boolean") state.mcp.agentConfigsLoaded = false;
    if (typeof state.mcp.agentConfigsError !== "string") state.mcp.agentConfigsError = "";
    if (typeof state.mcp.oauthBusyId !== "string") state.mcp.oauthBusyId = "";
    if (typeof state.mcp.formOpen !== "boolean") state.mcp.formOpen = false;
    if (typeof state.mcp.importOpen !== "boolean") state.mcp.importOpen = false;
    if (typeof state.mcp.formMode !== "string") state.mcp.formMode = "create";
    if (typeof state.mcp.importText !== "string") state.mcp.importText = "";
    if (typeof state.mcp.templateWizardOpen !== "boolean") state.mcp.templateWizardOpen = false;
    if (typeof state.mcp.templateWizardBusy !== "boolean") state.mcp.templateWizardBusy = false;
    if (typeof state.mcp.activeTemplateId !== "string") state.mcp.activeTemplateId = "";
    if (typeof state.mcp.managedBusyKey !== "string") state.mcp.managedBusyKey = "";
    return state.mcp;
  }

  function syncAggregateError(mcp) {
    mcp.error = String(mcp.serverError || mcp.templateError || mcp.agentConfigsError || "");
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
    mcp.templateWizardOpen = false;
    mcp.templateWizardBusy = false;
    mcp.activeTemplateId = "";
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
      mcp.agentConfigs = [];
      mcp.agentConfigsLoaded = true;
      mcp.agentConfigsError = "";
      syncAggregateError(mcp);
      renderMcpLibrary();
      return Promise.resolve(mcp);
    }
    mcp.loading = true;
    mcp.serverError = "";
    mcp.templateError = "";
    mcp.agentConfigsError = "";
    syncAggregateError(mcp);
    renderMcpLibrary();
    activeLoadPromise = (async () => {
      try {
        const agentConfigsPromise = typeof window.mia.mcp.getAgentConfigs === "function"
          ? window.mia.mcp.getAgentConfigs().catch((error) => ({
            success: false,
            error: error?.message || "MCP 外部配置加载失败"
          }))
          : Promise.resolve({ success: true, data: { sources: [] } });
        const [listResult, marketResult, agentConfigsResult] = await Promise.all([
          window.mia.mcp.list(),
          typeof window.mia.mcp.fetchMarketplace === "function"
            ? window.mia.mcp.fetchMarketplace()
            : Promise.resolve({ success: true, data: { templates: [] } }),
          agentConfigsPromise
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
        if (agentConfigsResult?.success) {
          mcp.agentConfigs = Array.isArray(agentConfigsResult.data?.sources) ? agentConfigsResult.data.sources : [];
          mcp.agentConfigsError = "";
        } else {
          mcp.agentConfigs = [];
          mcp.agentConfigsError = String(agentConfigsResult?.error || "MCP 外部配置加载失败");
        }
        mcp.agentConfigsLoaded = true;
        mcp.loaded = !mcp.serverError && !mcp.templateError;
      } catch (error) {
        mcp.loaded = false;
        mcp.servers = [];
        mcp.templates = [];
        mcp.agentConfigs = [];
        mcp.agentConfigsLoaded = true;
        mcp.agentConfigsError = "";
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
    syncMcpTabsIndicator();
  }

  function syncMcpTabsIndicator() {
    const row = els?.skillChipRow;
    if (!row) return;
    const update = () => {
      const active = row.querySelector("button.active");
      if (!active || typeof active.getBoundingClientRect !== "function") {
        row.style.setProperty("--pill-ready", "0");
        return;
      }
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

  function requiredInputHtml(field = {}) {
    const key = escapeHtml(field.key || "");
    const label = escapeHtml(field.label || field.key || "");
    const type = field.secret ? "password" : "text";
    return `<label>${label}<input name="${key}" type="${type}" autocomplete="off" ${field.required === false ? "" : "required"}></label>`;
  }

  function advancedDiagnosticsHtml(item = {}) {
    const commands = [];
    const transport = item.transport || {};
    if (transport.type === "stdio" && transport.command) {
      commands.push([transport.command, ...(transport.args || [])].filter(Boolean).join(" "));
    }
    if (Array.isArray(item.setupCommands)) {
      item.setupCommands.filter(Boolean).forEach((command) => commands.push(String(command)));
    }
    const details = [...new Set(commands.map((command) => String(command || "").trim()).filter(Boolean))];
    if (!details.length) return "";
    return `
      <details class="mcp-advanced-diagnostics">
        <summary>高级诊断</summary>
        <p>包含 ${details.length} 条本地命令诊断，默认隐藏。</p>
        ${details.map((command) => `<code>${escapeHtml(command)}</code>`).join("")}
      </details>
    `;
  }

  function renderServerSetupGuide(server = {}) {
    const url = transportSummary(server.transport || {});
    const expectedToolCount = Number(
      server.expectedToolCount
      || server.managedRuntime?.expectedToolCount
      || 0
    );
    const message = String(server.connectionWizard?.message || "").trim();
    const hasSetup = message || server.homepage || url || expectedToolCount > 0;
    const isDisconnected = String(server.status || "") === "disconnected";
    if (!hasSetup && !isDisconnected) return "";
    const rows = [];
    if (isDisconnected && !message) rows.push("<strong>服务尚未连接</strong>");
    if (message) rows.push(`<strong>${escapeHtml(message)}</strong>`);
    if (url) rows.push(`<span>连接地址 <code>${escapeHtml(url)}</code></span>`);
    if (expectedToolCount > 0) rows.push(`<span>连接成功后应发现 ${expectedToolCount} 个工具</span>`);
    if (server.homepage) rows.push(`<span>仓库 ${escapeHtml(server.homepage.replace(/^https?:\/\/github\.com\//, ""))}</span>`);
    return `<div class="mcp-setup-guide">${rows.join("")}</div>`;
  }

  function renderAvailabilityCheckHint() {
    return `<div class="mcp-check-hint">检测只验证配置可用，不代表实际运行时状态。</div>`;
  }

  function diagnosticHtml(server = {}) {
    const code = server.diagnostics?.code || server.lastTestCode || "";
    const error = server.lastError || server.diagnostics?.message || "";
    if (!code && !error && !server.lastTestStatus) return "";
    const text = [code, error || server.lastTestStatus].filter(Boolean).join(" · ");
    return text ? `<p class="mcp-diagnostic">${escapeHtml(text)}</p>` : "";
  }

  function oauthActionHtml(server = {}) {
    if (server.lastTestStatus !== "auth_required" && !server.oauth?.authenticated) return "";
    const mcp = mcpState();
    const id = escapeHtml(server.id || "");
    const isBusy = mcp.oauthBusyId === server.id;
    const isAuthenticated = !!server.oauth?.authenticated;
    const label = isBusy ? "处理中..." : (isAuthenticated ? "退出登录" : "登录");
    const disabled = isBusy ? "disabled" : "";
    if (isAuthenticated) {
      return `<button class="mcp-action-button mcp-action-secondary" type="button" data-mcp-action="oauth-logout" data-mcp-id="${id}" ${disabled}>${label}</button>`;
    }
    return `<button class="mcp-action-button mcp-action-secondary" type="button" data-mcp-action="oauth-login" data-mcp-id="${id}" ${disabled}>${label}</button>`;
  }

  function managedActionHtml(server = {}) {
    const actions = Array.isArray(server.connectionWizard?.actions) ? server.connectionWizard.actions : [];
    const isManaged = server.managementMode === "managed"
      || !!server.managedRuntime?.connectorId
      || actions.length > 0;
    if (!isManaged || !actions.length) return "";
    const busyKey = mcpState().managedBusyKey;
    return `
      <div class="mcp-managed-actions">
        ${server.connectionWizard?.message ? `<p>${escapeHtml(server.connectionWizard.message)}</p>` : ""}
        <div class="mcp-action-strip">
          ${actions.map((action) => {
            const key = `${server.id}:${action.id}`;
            const busy = busyKey === key;
            return `<button class="mcp-action-button ${action.id === server.connectionWizard?.nextAction ? "mcp-action-primary" : "mcp-action-secondary"}" type="button" data-mcp-managed-action="${escapeHtml(action.id)}" data-mcp-id="${escapeHtml(server.id || "")}" ${busy ? "disabled" : ""}>${escapeHtml(busy ? "处理中..." : action.label || action.id)}</button>`;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderServerCard(server) {
    const syncLabel = syncStatusLabel(server);
    const description = server.description || transportSummary(server.transport) || "未配置描述";
    const id = escapeHtml(server.id || "");
    const oauthAction = oauthActionHtml(server);
    const managedActions = managedActionHtml(server);
    return `
      <article class="skill-card mcp-card" data-mcp-id="${id}">
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(server.name || server.id || "MCP 服务")}</strong>
            ${server.enabled === false ? chip("mcp-chip-muted", "未加入新对话") : ""}
          </div>
          <p>${escapeHtml(description)}</p>
          ${diagnosticHtml(server)}
        </div>
        <span class="skill-card-source">
          <span class="mcp-inline-chips">
            ${chip("mcp-chip-transport", transportLabel(server.transport?.type))}
            ${chip(`mcp-chip-status mcp-status-${String(server.status || "unknown")}`, connectionStatusLabel(server.status))}
            ${syncLabel ? chip("mcp-chip-sync", syncLabel) : ""}
            ${chip("mcp-chip-tools", `${Number(server.tools?.length || 0)} 个工具`)}
          </span>
        </span>
        ${renderServerSetupGuide(server)}
        ${managedActions}
        ${advancedDiagnosticsHtml(server)}
        ${renderAvailabilityCheckHint()}
        <div class="mcp-card-actions mcp-server-actions" aria-label="MCP 服务操作">
          <div class="mcp-action-strip mcp-action-strip-primary">
            ${managedActions ? "" : `<button class="mcp-action-button mcp-action-secondary" type="button" data-mcp-action="test" data-mcp-id="${id}" title="检测 MCP 可用状态，不会启动外部服务">检测连接</button>`}
          </div>
          <div class="mcp-action-strip mcp-action-strip-secondary ${oauthAction ? "mcp-action-strip-auth" : ""}">
            ${oauthAction}
            <button class="mcp-action-button mcp-action-ghost" type="button" data-mcp-action="edit" data-mcp-id="${id}">配置</button>
            <button class="mcp-action-button mcp-action-danger" type="button" data-mcp-action="delete" data-mcp-id="${id}">删除</button>
          </div>
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
          <button class="mcp-action-button mcp-action-primary" type="button" data-mcp-action="connect-template" data-mcp-template="${escapeHtml(template.id || "")}">连接</button>
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
          <button class="mcp-action-button mcp-action-primary" type="button" data-mcp-action="${escapeHtml(action.id)}">${escapeHtml(action.buttonLabel)}</button>
        </div>
      </article>
    `;
  }

  function renderAgentConfigSources(mcp) {
    const rows = (mcp.agentConfigs || []).flatMap((source) => (
      (source.servers || []).map((server) => ({ source, server }))
    ));
    const statusHtml = mcp.agentConfigsError
      ? `<p class="mcp-empty">${escapeHtml(mcp.agentConfigsError)}</p>`
      : "";
    if (!rows.length) {
      return `
        <section class="mcp-discovery" aria-label="外部 Agent MCP 配置">
          <div class="mcp-discovery-head">
            <strong>外部 Agent 配置</strong>
            <span>${mcp.agentConfigsLoaded ? "已扫描" : "未扫描"}</span>
          </div>
          ${statusHtml || `<p class="mcp-empty">没有发现外部 Agent MCP 配置</p>`}
        </section>
      `;
    }
    return `
      <section class="mcp-discovery" aria-label="外部 Agent MCP 配置">
        <div class="mcp-discovery-head">
          <strong>外部 Agent 配置</strong>
          <span>${escapeHtml(`${rows.length} 项`)}</span>
        </div>
        ${statusHtml}
        ${rows.map(({ source, server }) => {
          const sourceName = String(source.source || source.name || "");
          const serverName = String(server.name || server.id || "");
          const importable = server.importable !== false;
          return `
            <article class="mcp-discovery-row">
              <strong>${escapeHtml(sourceName)} / ${escapeHtml(serverName)}</strong>
              <span>${escapeHtml(transportLabel(server.transport?.type))}</span>
              <button class="mcp-action-button mcp-action-secondary" type="button" data-mcp-action="import-agent-config" data-mcp-source="${escapeHtml(sourceName)}" data-mcp-name="${escapeHtml(serverName)}" ${importable ? "" : "disabled"}>导入</button>
              ${server.importSkipReason ? `<small>${escapeHtml(server.importSkipReason)}</small>` : ""}
            </article>
          `;
        }).join("")}
      </section>
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
        if (button.disabled || Object.prototype.hasOwnProperty.call(button.attributes || {}, "disabled")) return;
        handleMcpAction(
          button.dataset.mcpAction,
          button.dataset.mcpId || button.dataset.mcpTemplate || "",
          button
        );
      });
    });
    els.skillCardGrid.querySelectorAll("[data-mcp-managed-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (button.disabled || Object.prototype.hasOwnProperty.call(button.attributes || {}, "disabled")) return;
        handleManagedAction(button.dataset.mcpId || "", button.dataset.mcpManagedAction || "");
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

  function openTemplateWizard(template) {
    if (typeof document === "undefined" || !document.body || !template) return;
    const mcp = mcpState();
    const fields = Array.isArray(template.requiredInputs) ? template.requiredInputs : [];
    const managed = template.managementMode === "managed";
    const overlay = document.createElement("section");
    overlay.className = "mcp-dialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", `连接 ${template.name || template.id || "MCP"}`);
    overlay.innerHTML = `
      <div class="mcp-dialog-backdrop" data-mcp-close></div>
      <form class="mcp-dialog-panel" data-mcp-template-form>
        <header class="mcp-dialog-head">
          <h2>${escapeHtml(template.name || template.id || "MCP 服务")}</h2>
          <button type="button" data-mcp-close aria-label="关闭">×</button>
        </header>
        <p class="mcp-dialog-copy">${escapeHtml(template.description || "")}</p>
        ${fields.map((field) => requiredInputHtml(field)).join("")}
        ${managed ? `<p class="mcp-dialog-copy">${escapeHtml(template.connectionWizard?.message || "Mia 会管理这个 MCP 的安装、登录、启动和检测。")}</p>` : ""}
        <footer class="mcp-dialog-actions">
          <button type="button" data-mcp-close>取消</button>
          <button type="submit">${managed ? "添加到 Mia" : "检测并启用"}</button>
        </footer>
      </form>
    `;
    if (!appendDialog(overlay)) return;
    mcp.templateWizardOpen = true;
    mcp.activeTemplateId = template.id || "";
    const form = overlay.querySelector("[data-mcp-template-form]");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (typeof FormData === "undefined") return;
      if (!window.mia?.mcp?.installTemplate) {
        alertText("MCP 模板安装暂不可用");
        return;
      }
      const data = new FormData(form);
      const values = {};
      fields.forEach((field) => {
        values[field.key] = String(data.get(field.key) || "").trim();
      });
      mcp.templateWizardBusy = true;
      try {
        const result = await window.mia.mcp.installTemplate(template.id, values);
        if (!result?.success) {
          alertText(`连接失败：${result?.error || "未知错误"}`);
          return;
        }
        mcp.activeTab = "installed";
        closeActiveDialog();
        await loadMcpServers({ force: true });
      } finally {
        mcp.templateWizardBusy = false;
      }
    });
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
    let result = await window.mia.mcp.importJson(text);
    const duplicates = Array.isArray(result?.data?.duplicates) ? result.data.duplicates : [];
    if (result?.success && result?.data?.requiresConfirmation && duplicates.length) {
      const message = `已存在同名 MCP 服务：${duplicates.join("、")}。替换后会先清理旧服务的 Agent 同步状态，继续？`;
      if (!confirmAction(message)) return { success: false, error: "cancelled" };
      result = await window.mia.mcp.importJson(text, { replaceDuplicates: true });
    }
    if (!result?.success) {
      if (result?.error === "cancelled") return result;
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
      alertText(`${server.enabled === false ? "启用" : "停用"}失败：${result?.error || "未知错误"}`);
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

  async function handleManagedAction(id, action) {
    const mcp = mcpState();
    if (!window.mia?.mcp?.runManagedAction) {
      alertText("MCP 托管操作暂不可用");
      return;
    }
    mcp.managedBusyKey = `${id}:${action}`;
    renderMcpLibrary();
    try {
      const result = await window.mia.mcp.runManagedAction(id, action, {});
      if (!result?.success) alertText(`操作失败：${result?.error || "未知错误"}`);
      await loadMcpServers({ force: true });
    } finally {
      mcp.managedBusyKey = "";
      renderMcpLibrary();
    }
  }

  async function handleMcpOauth(id, mode) {
    const mcp = mcpState();
    const server = mcp.servers.find((item) => item.id === id);
    if (!server) return;
    const oauth = window.mia.mcp.oauth || {};
    const fn = mode === "logout" ? oauth.logout : oauth.login;
    if (typeof fn !== "function") {
      alertText("MCP OAuth 暂不可用");
      return;
    }
    mcp.oauthBusyId = id;
    renderMcpLibrary();
    try {
      const result = await fn({ serverId: server.id, serverUrl: server.transport?.url });
      if (!result?.success) {
        alertText(result?.error || "MCP OAuth 操作失败");
        return;
      }
      await loadMcpServers({ force: true });
    } finally {
      mcp.oauthBusyId = "";
      renderMcpLibrary();
    }
  }

  async function handleImportAgentConfig(sourceAgent, serverName) {
    const rows = (mcpState().agentConfigs || []).flatMap((source) => (
      (source.servers || []).map((server) => ({ source, server }))
    ));
    const match = rows.find(({ source, server }) => (
      String(source.source || source.name || "") === sourceAgent
        && String(server.name || server.id || "") === serverName
    ));
    if (match?.server?.importable === false) return;
    if (typeof window.mia.mcp.importAgentConfig !== "function") {
      alertText("外部 MCP 配置导入暂不可用");
      return;
    }
    const result = await window.mia.mcp.importAgentConfig({ sourceAgent, serverName });
    if (!result?.success) {
      alertText(result?.error || "导入外部 MCP 配置失败");
      return;
    }
    mcpState().activeTab = "installed";
    await loadMcpServers({ force: true });
  }

  async function handleMcpAction(action, id, button = null) {
    if (action === "create") return openMcpForm(null);
    if (action === "import") return openImportForm();
    if (action === "edit") return openMcpForm(mcpState().servers.find((server) => server.id === id));
    if (action === "test") return testMcpServer(id);
    if (action === "sync") return syncMcpServers();
    if (action === "toggle") return toggleMcpServer(id);
    if (action === "delete") return deleteMcpServer(id);
    if (action === "connect-template") return openTemplateWizard(mcpState().templates.find((template) => template.id === id));
    if (action === "install") return installTemplate(id);
    if (action === "oauth-login") return handleMcpOauth(id, "login");
    if (action === "oauth-logout") return handleMcpOauth(id, "logout");
    if (action === "import-agent-config") return handleImportAgentConfig(
      button?.dataset?.mcpSource || "",
      button?.dataset?.mcpName || ""
    );
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
      const discoveryHtml = activeFilterText() ? "" : renderAgentConfigSources(mcp);
      renderGrid(`${discoveryHtml}${customItems.map((item) => renderCustomActionCard(item)).join("")}`);
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
