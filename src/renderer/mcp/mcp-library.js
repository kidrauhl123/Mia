(function () {
  "use strict";

  let state, els, setText;
  let activeLoadPromise = null;

  const MCP_TRANSPORT_TYPES = Object.freeze(["stdio", "http", "sse", "streamable_http"]);

  function initMcpLibrary(deps) {
    state = deps.state;
    els = deps.els;
    setText = deps.setText;
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
    window.miaReactDialogs?.publish?.({ dialog: { kind: "closed" } });
    const mcp = mcpState();
    mcp.formOpen = false;
    mcp.templateWizardOpen = false;
    mcp.templateWizardBusy = false;
    mcp.activeTemplateId = "";
  }

  function closeMessageDialog() {
    window.miaReactDialogs?.publish?.({ message: null });
  }

  function alertText(message) {
    const text = String(message || "").trim();
    if (typeof document === "undefined" || !document.body) {
      if (typeof window !== "undefined" && typeof window.alert === "function") window.alert(text);
      else console.warn(text);
      return;
    }
    window.miaReactDialogs?.publish?.({
      message: {
        close: closeMessageDialog,
        text: text || "操作失败，请重试。"
      }
    });
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
    window.miaReactSkills?.publish?.({
      chips: [{
        active: false,
        id: "mcp:create",
        label: "自定义 MCP",
        select: () => handleMcpAction("create", "")
      }],
      mode: "mcp"
    });
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
    if (/endpoint health check failed/i.test(text)) return `${managedActionLabel(action)}失败，请重试。`;
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

  function shouldStartManagedBeforeTest(server = {}) {
    if (!isManagedServer(server) || isServerConnected(server)) return false;
    const state = String(server.managedRuntime?.state || "").trim().toLowerCase();
    return state !== "running" && state !== "healthy";
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
    if (preferred === "test" && shouldStartManagedBeforeTest(server)) return "start";
    if (preferred && actions.some((action) => action.id === preferred)) return preferred;
    if (isManagedServer(server) && ["install", "login", "start", "test", "stop"].includes(preferred)) return preferred;
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
    const showCustomActions = server && !isInstalledBuiltIn(server);
    const targetId = server?.id || template?.id || "";
    const actions = [{
      className: `mcp-action-button ${action.action === "disconnect-server" ? "mcp-action-secondary" : "mcp-action-primary"}`,
      disabled: action.disabled,
      id: `${targetId}:${action.action}`,
      label: action.label,
      run: () => handleMcpAction(action.action, targetId)
    }];
    if (showCustomActions) {
      actions.push(
        {
          className: "mcp-action-button mcp-action-ghost",
          disabled: false,
          id: `${targetId}:edit`,
          label: "配置",
          run: () => handleMcpAction("edit", targetId)
        },
        {
          className: "mcp-action-button mcp-action-danger",
          disabled: false,
          id: `${targetId}:delete`,
          label: "删除",
          run: () => handleMcpAction("delete", targetId)
        }
      );
    }
    return {
      actions,
      className: "mcp-card mcp-connection-card",
      description,
      id: `${item.kind}:${targetId}`,
      open: () => {},
      sourceLogo: null,
      sourceText: "",
      statusClass,
      statusLabel: label,
      title
    };
  }

  function renderGrid(cards, emptyText = "") {
    window.miaReactSkills?.publish?.({
      cards,
      emptyText,
      pageDirection: 0
    });
  }

  function renderState(text) {
    renderGrid([], text);
  }

  function renderCards(items, renderItem) {
    renderGrid(items.map((item) => renderItem(item)));
  }

  function openMcpForm(server) {
    const mcp = mcpState();
    const isEdit = !!server;
    const transport = normalizeDialogTransport(server?.transport || {});
    closeActiveDialog();
    mcp.formOpen = true;
    mcp.formMode = isEdit ? "edit" : "create";
    mcp.formDraft = server || null;
    const options = { id: server?.id || "", enabled: server?.enabled !== false };
    window.miaReactDialogs?.publish?.({
      dialog: {
        close: closeActiveDialog,
        id: options.id,
        initial: {
          args: (transport.args || []).join("\n"),
          bearerTokenEnvVar: transport.bearerTokenEnvVar || "",
          command: transport.command || "",
          description: server?.description || "",
          env: serializeKeyValueLines(transport.env || {}, "="),
          headers: serializeKeyValueLines(transport.headers || {}, ": "),
          name: server?.name || "",
          type: transport.type,
          url: transport.url || ""
        },
        kind: "mcp-form",
        submit: (values) => submitMcpForm(values, options),
        title: isEdit ? "编辑 MCP 服务" : "添加 MCP 服务"
      }
    });
  }

  async function submitMcpForm(values, options = {}) {
    const type = normalizeTransportType(values.type);
    const transport = type === "stdio"
      ? {
        type,
        command: String(values.command || "").trim(),
        args: parseLineList(values.args),
        env: parseKeyValueLines(values.env, /^([^=]+)=(.*)$/)
      }
      : {
        type,
        url: String(values.url || "").trim(),
        headers: parseKeyValueLines(values.headers, /^([^:]+):(.*)$/),
        bearerTokenEnvVar: String(values.bearerTokenEnvVar || "").trim()
      };
    const result = await window.mia.mcp.save({
      id: String(options.id || "").trim(),
      name: String(values.name || "").trim(),
      description: String(values.description || "").trim(),
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
    if (!template) return;
    const mcp = mcpState();
    const fields = Array.isArray(template.requiredInputs) ? template.requiredInputs : [];
    closeActiveDialog();
    mcp.templateWizardOpen = true;
    mcp.activeTemplateId = template.id || "";
    const publishWizard = (busy = false) => window.miaReactDialogs?.publish?.({
      dialog: {
        busy,
        close: closeActiveDialog,
        copy: template.description || "",
        fields: fields.map((field) => ({
          key: field.key || "",
          label: field.label || field.key || "",
          required: field.required !== false,
          secret: !!field.secret
        })),
        id: template.id || "",
        kind: "mcp-template",
        submit: async (values) => {
          if (!window.mia?.mcp?.installTemplate) {
            alertText("MCP 连接暂不可用");
            return;
          }
          mcp.templateWizardBusy = true;
          publishWizard(true);
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
            if (mcp.templateWizardOpen) publishWizard(false);
          }
        },
        title: template.name || template.id || "MCP 服务"
      }
    });
    publishWizard(false);
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
      if (result?.success && action === "start") {
        const followUpAction = nextManagedAction(result.data || {});
        if (followUpAction === "test") {
          mcp.managedBusyKey = `${id}:test`;
          renderMcpLibrary();
          const tested = await window.mia.mcp.runManagedAction(id, "test", {});
          if (!tested?.success) alertText(managedFailureMessage("test", tested?.error || "未知错误"));
        }
      }
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
