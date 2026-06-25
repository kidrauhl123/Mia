(function () {
  "use strict";

  let state, els, escapeHtml, setText;
  let layoutCards = () => {};
  let activeLoadPromise = null;
  let activeDialog = null;
  let activeMessageDialog = null;

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
        templateWizardOpen: false,
        templateWizardBusy: false,
        activeTemplateId: "",
        managedBusyKey: "",
        connectBusyId: ""
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
    if (typeof state.mcp.formMode !== "string") state.mcp.formMode = "create";
    if (typeof state.mcp.templateWizardOpen !== "boolean") state.mcp.templateWizardOpen = false;
    if (typeof state.mcp.templateWizardBusy !== "boolean") state.mcp.templateWizardBusy = false;
    if (typeof state.mcp.activeTemplateId !== "string") state.mcp.activeTemplateId = "";
    if (typeof state.mcp.managedBusyKey !== "string") state.mcp.managedBusyKey = "";
    if (typeof state.mcp.connectBusyId !== "string") state.mcp.connectBusyId = "";
    return state.mcp;
  }

  function syncAggregateError(mcp) {
    mcp.error = String(mcp.serverError || mcp.templateError || "");
  }

  function activeFilterText() {
    return String(state?.skillFilter || "").trim().toLowerCase();
  }

  function matchesFilter(values) {
    const needle = activeFilterText();
    if (!needle) return true;
    return values.join(" ").toLowerCase().includes(needle);
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

  function closeMessageDialog() {
    if (!activeMessageDialog) return;
    const { overlay, onKeyDown } = activeMessageDialog;
    if (typeof document !== "undefined" && onKeyDown) {
      document.removeEventListener("keydown", onKeyDown);
    }
    overlay?.remove?.();
    activeMessageDialog = null;
  }

  function appendMessageDialog(overlay) {
    if (!overlay || typeof document === "undefined" || !document.body) return false;
    closeMessageDialog();
    document.body.appendChild(overlay);
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeMessageDialog();
    };
    document.addEventListener("keydown", onKeyDown);
    activeMessageDialog = { overlay, onKeyDown };
    overlay.querySelectorAll("[data-mcp-message-close]").forEach((button) => {
      button.addEventListener("click", () => closeMessageDialog());
    });
    return true;
  }

  function alertText(message) {
    const text = String(message || "").trim();
    if (typeof document === "undefined" || !document.body) {
      if (typeof window !== "undefined" && typeof window.alert === "function") window.alert(text);
      else console.warn(text);
      return;
    }
    const overlay = document.createElement("section");
    overlay.className = "mcp-dialog mcp-message-dialog";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "MCP 提示");
    overlay.innerHTML = `
      <div class="mcp-dialog-backdrop" data-mcp-message-close></div>
      <div class="mcp-dialog-panel mcp-message-panel" data-mcp-alert>
        <p>${escapeHtml(text || "操作失败，请重试。")}</p>
        <footer class="mcp-dialog-actions">
          <button class="mcp-dialog-primary" type="button" data-mcp-message-close>确定</button>
        </footer>
      </div>
    `;
    if (!appendMessageDialog(overlay)) return;
    const button = overlay.querySelector("button[data-mcp-message-close]");
    button?.focus?.();
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
        mcp.agentConfigs = [];
        mcp.agentConfigsError = "";
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
    const row = els?.skillChipRow;
    if (!row) return;
    row.classList?.add?.("mcp-toolbar-row");
    row.setAttribute?.("aria-label", "MCP 操作");
    row.innerHTML = `
      <button type="button" data-mcp-toolbar-action="create">自定义 MCP</button>
    `;
    row.querySelectorAll("[data-mcp-toolbar-action]").forEach((button) => {
      button.addEventListener("click", () => handleMcpAction(button.dataset.mcpToolbarAction || "", ""));
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

  function requiredInputHtml(field = {}) {
    const key = escapeHtml(field.key || "");
    const label = escapeHtml(field.label || field.key || "");
    const type = field.secret ? "password" : "text";
    return `<label>${label}<input name="${key}" type="${type}" autocomplete="off" ${field.required === false ? "" : "required"}></label>`;
  }

  function managedActionLabel(action = "") {
    const labels = {
      install: "安装",
      login: "登录",
      start: "启动",
      test: "检测",
      connect: "连接"
    };
    return labels[String(action || "").trim()] || "操作";
  }

  function isVerboseDiagnostic(value = "") {
    const text = String(value || "").trim();
    return text.length > 100
      || /[\r\n]/.test(text)
      || /\b(Command failed|fatal:|ENOENT|spawn|git clone|go run|npm |npx )\b/i.test(text)
      || /\/Users\/|Application Support/i.test(text);
  }

  function managedFailureMessage(action = "", detail = "") {
    const text = String(detail || "").trim();
    if (!text) return `${managedActionLabel(action)}失败，请重试。`;
    if (/runtime download failed|runtime download is not available|archive did not contain/i.test(text)) {
      return "小红书运行组件下载失败，请检查网络后重试。";
    }
    if (/spawn go ENOENT|go is not installed|go missing/i.test(text)) {
      return "缺少小红书运行组件，请检查网络后重试。";
    }
    if (isVerboseDiagnostic(text)) return `${managedActionLabel(action)}失败，请重试。`;
    return text;
  }

  function isInstalledBuiltIn(server = {}) {
    return !!server.registryId
      || server.source === "marketplace"
      || !!server.managedRuntime?.connectorId
      || ["native", "managed"].includes(String(server.managementMode || ""));
  }

  function normalizeMcpIdentity(value = "") {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^mcp[_-]/, "")
      .replace(/\s*mcp$/i, "")
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
  }

  function identityKeys(item = {}) {
    return [
      item.registryId,
      item.nativeName,
      item.managedRuntime?.connectorId,
      item.id,
      item.name
    ]
      .map(normalizeMcpIdentity)
      .filter(Boolean);
  }

  function findServerForTemplate(template = {}, servers = []) {
    const templateKeys = new Set(identityKeys(template));
    if (!templateKeys.size) return null;
    return servers.find((server) => identityKeys(server).some((key) => templateKeys.has(key))) || null;
  }

  function mcpItemFilterValues(item = {}) {
    const server = item.server || {};
    const template = item.template || {};
    return [
      server.id,
      server.name,
      server.description,
      server.registryId,
      server.nativeName,
      template.id,
      template.name,
      template.description,
      template.category,
      item.statusLabel
    ];
  }

  function unifiedMcpItems() {
    const mcp = mcpState();
    const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
    const templates = Array.isArray(mcp.templates) ? mcp.templates : [];
    const usedServerIds = new Set();
    const items = [];

    templates.forEach((template) => {
      const server = findServerForTemplate(template, servers);
      if (server) {
        usedServerIds.add(server.id);
        items.push({ kind: "server", server, template });
        return;
      }
      items.push({ kind: "template", template });
    });

    servers.forEach((server) => {
      if (!usedServerIds.has(server.id)) items.push({ kind: "server", server, template: null });
    });

    return items.map((item) => ({
      ...item,
      statusLabel: simpleConnectionLabel(item.server, item.template)
    }));
  }

  function filteredMcpItems() {
    return unifiedMcpItems().filter((item) => matchesFilter(mcpItemFilterValues(item)));
  }

  function isManagedServer(server = {}) {
    return server.managementMode === "managed" || !!server.managedRuntime?.connectorId;
  }

  function isAuthRequired(server = {}) {
    return server.lastTestStatus === "auth_required" || server.status === "auth_required";
  }

  function isConfigurationRequired(server = {}) {
    return server.status === "configuration_required"
      || server.connectionWizard?.state === "missing_required_inputs"
      || (Array.isArray(server.connectionWizard?.missingRequiredInputs) && server.connectionWizard.missingRequiredInputs.length > 0);
  }

  function isConnectionError(server = {}) {
    return server.status === "error"
      || server.lastTestStatus === "error"
      || server.connectionWizard?.state === "managed_error"
      || server.connectionWizard?.state === "test_failed"
      || server.managedRuntime?.state === "error";
  }

  function isServerConnected(server = {}) {
    return server.enabled !== false && (
      server.status === "connected"
        || server.lastTestStatus === "connected"
        || server.connectionWizard?.state === "connected"
    );
  }

  function simpleConnectionLabel(server = null, template = null) {
    if (!server) return "未连接";
    const mcp = mcpState();
    if (mcp.connectBusyId === server.id || String(mcp.managedBusyKey || "").startsWith(`${server.id}:`)) return "连接中";
    if (isConnectionError(server)) return "连接失败";
    if (isConfigurationRequired(server)) return "需要配置";
    if (isAuthRequired(server)) return "需要登录";
    if (isServerConnected(server)) return "已连接";
    return template ? "未连接" : "未连接";
  }

  function simpleStatusClass(label = "") {
    if (label === "已连接") return "connected";
    if (label === "连接失败") return "error";
    if (label === "需要登录" || label === "需要配置" || label === "连接中") return "attention";
    return "idle";
  }

  function nextManagedAction(server = {}) {
    const actions = Array.isArray(server.connectionWizard?.actions) ? server.connectionWizard.actions : [];
    const preferred = String(server.connectionWizard?.nextAction || "").trim();
    if (preferred && actions.some((action) => action.id === preferred)) return preferred;
    return actions[0]?.id || "";
  }

  function primaryActionForServer(server = {}) {
    const mcp = mcpState();
    const busy = mcp.connectBusyId === server.id || String(mcp.managedBusyKey || "").startsWith(`${server.id}:`);
    if (busy) return { action: "connect-server", label: "连接中...", disabled: true };
    if (isServerConnected(server)) return { action: "disconnect-server", label: "断开", disabled: false };
    if (isAuthRequired(server)) return { action: "oauth-login", label: "登录", disabled: false };
    return { action: "connect-server", label: "连接", disabled: false };
  }

  function primaryActionForItem(item = {}) {
    if (item.kind === "template") return { action: "connect-template", label: "连接", disabled: false };
    return primaryActionForServer(item.server || {});
  }

  function renderConnectionCard(item = {}) {
    const server = item.server || null;
    const template = item.template || null;
    const source = server || template || {};
    const title = source.name || source.id || "MCP 服务";
    const description = source.description || "Mia 已准备好这个 MCP，点击连接即可使用。";
    const label = item.statusLabel || simpleConnectionLabel(server, template);
    const statusClass = simpleStatusClass(label);
    const action = primaryActionForItem(item);
    const idAttr = server
      ? `data-mcp-id="${escapeHtml(server.id || "")}"`
      : `data-mcp-template-id="${escapeHtml(template?.id || "")}"`;
    const actionTargetAttr = server
      ? `data-mcp-id="${escapeHtml(server.id || "")}"`
      : `data-mcp-template="${escapeHtml(template?.id || "")}"`;
    const showCustomActions = server && !isInstalledBuiltIn(server);
    return `
      <article class="skill-card mcp-card mcp-connection-card" ${idAttr}>
        <div class="skill-card-head">
          <div class="skill-card-titlerow">
            <strong>${escapeHtml(title)}</strong>
            <span class="mcp-connect-status mcp-connect-status-${escapeHtml(statusClass)}">${escapeHtml(label)}</span>
          </div>
          <p>${escapeHtml(description)}</p>
        </div>
        <div class="mcp-card-actions" aria-label="MCP 服务操作">
          <button class="mcp-action-button ${action.action === "disconnect-server" ? "mcp-action-secondary" : "mcp-action-primary"}" type="button" data-mcp-action="${escapeHtml(action.action)}" ${actionTargetAttr} ${action.disabled ? "disabled" : ""}>${escapeHtml(action.label)}</button>
          ${showCustomActions ? `
            <div class="mcp-card-secondary-actions">
              <button class="mcp-action-button mcp-action-ghost" type="button" data-mcp-action="edit" data-mcp-id="${escapeHtml(server.id || "")}">配置</button>
              <button class="mcp-action-button mcp-action-danger" type="button" data-mcp-action="delete" data-mcp-id="${escapeHtml(server.id || "")}">删除</button>
            </div>
          ` : ""}
        </div>
      </article>
    `;
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
          <button class="mcp-dialog-primary" type="submit">${isEdit ? "保存" : "添加"}</button>
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
    closeActiveDialog();
    await loadMcpServers({ force: true });
  }

  function openTemplateWizard(template) {
    if (typeof document === "undefined" || !document.body || !template) return;
    const mcp = mcpState();
    const fields = Array.isArray(template.requiredInputs) ? template.requiredInputs : [];
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
        <footer class="mcp-dialog-actions">
          <button type="button" data-mcp-close>取消</button>
          <button class="mcp-dialog-primary" type="submit">连接</button>
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
        alertText("MCP 连接暂不可用");
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
          alertText(managedFailureMessage("connect", result?.error || "未知错误"));
          return;
        }
        closeActiveDialog();
        await loadMcpServers({ force: true });
      } finally {
        mcp.templateWizardBusy = false;
      }
    });
  }

  async function testMcpServer(id) {
    const result = await window.mia.mcp.test(id);
    if (!result?.success) alertText(`测试失败：${result?.error || "未知错误"}`);
    await loadMcpServers({ force: true });
  }

  async function connectTemplate(id) {
    const template = mcpState().templates.find((item) => item.id === id);
    if (!template) return;
    const fields = Array.isArray(template.requiredInputs) ? template.requiredInputs : [];
    if (fields.length) return openTemplateWizard(template);
    return installTemplate(id);
  }

  async function connectMcpServer(id) {
    const mcp = mcpState();
    const server = mcp.servers.find((item) => item.id === id);
    if (!server) return;

    const template = (mcp.templates || []).find((item) => (
      item.id === server.registryId || findServerForTemplate(item, [server]) === server
    ));
    if (isConfigurationRequired(server) && template) return openTemplateWizard(template);
    if (isAuthRequired(server)) return handleMcpOauth(id, "login");

    const managedAction = isManagedServer(server) ? nextManagedAction(server) : "";
    if (managedAction) return handleManagedAction(id, managedAction);

    mcp.connectBusyId = id;
    renderMcpLibrary();
    try {
      const result = await window.mia.mcp.test(id);
      if (!result?.success) {
        alertText(managedFailureMessage("connect", result?.error || "未知错误"));
        return;
      }
      const testedStatus = String(result.data?.status || result.data?.lastTestStatus || "").trim();
      if (!testedStatus || testedStatus === "connected") {
        const enabled = await window.mia.mcp.setEnabled(id, true);
        if (!enabled?.success) alertText(managedFailureMessage("connect", enabled?.error || "未知错误"));
      } else if (testedStatus === "auth_required") {
        alertText("需要登录后再连接。");
      } else {
        alertText("连接失败，请重试。");
      }
      await loadMcpServers({ force: true });
    } finally {
      mcp.connectBusyId = "";
      renderMcpLibrary();
    }
  }

  async function disconnectMcpServer(id) {
    const mcp = mcpState();
    const server = mcp.servers.find((item) => item.id === id);
    if (!server) return;
    mcp.connectBusyId = id;
    renderMcpLibrary();
    try {
      const result = await window.mia.mcp.setEnabled(id, false);
      if (!result?.success) alertText(`断开失败：${result?.error || "未知错误"}`);
      await loadMcpServers({ force: true });
    } finally {
      mcp.connectBusyId = "";
      renderMcpLibrary();
    }
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
      alertText(managedFailureMessage("connect", result?.error || "未知错误"));
      return;
    }
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
      if (!result?.success) alertText(managedFailureMessage(action, result?.error || "未知错误"));
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
        alertText(managedFailureMessage("login", result?.error || "MCP OAuth 操作失败"));
        return;
      }
      await loadMcpServers({ force: true });
    } finally {
      mcp.oauthBusyId = "";
      renderMcpLibrary();
    }
  }

  async function handleMcpAction(action, id) {
    if (action === "create") return openMcpForm(null);
    if (action === "edit") return openMcpForm(mcpState().servers.find((server) => server.id === id));
    if (action === "test") return testMcpServer(id);
    if (action === "connect-server") return connectMcpServer(id);
    if (action === "disconnect-server") return disconnectMcpServer(id);
    if (action === "delete") return deleteMcpServer(id);
    if (action === "connect-template") return connectTemplate(id);
    if (action === "install") return installTemplate(id);
    if (action === "oauth-login") return handleMcpOauth(id, "login");
    if (action === "oauth-logout") return handleMcpOauth(id, "logout");
  }

  function renderMcpLibrary() {
    const mcp = mcpState();
    setText(els.skillPageTitle, "MCP 服务");
    renderMcpTabs();

    const items = unifiedMcpItems();
    if (!mcp.loadAttempted && !mcp.loading) {
      renderState("正在加载 MCP 服务...");
      return;
    }
    if (mcp.loading && !items.length) {
      renderState("正在加载 MCP 服务...");
      return;
    }
    if (mcp.error && !items.length) {
      renderState(mcp.error || "MCP 服务加载失败");
      return;
    }
    const shownItems = filteredMcpItems();
    if (!shownItems.length) {
      renderState(items.length ? "没有匹配的 MCP 服务" : "暂无可连接 MCP 服务");
      return;
    }
    renderCards(shownItems, renderConnectionCard);
  }

  window.miaMcpLibrary = {
    initMcpLibrary,
    loadMcpServers,
    renderMcpLibrary
  };
})();
