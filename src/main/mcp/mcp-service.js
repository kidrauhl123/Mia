"use strict";

const crypto = require("node:crypto");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function success(data, extra = {}) {
  return {
    success: true,
    data,
    error: "",
    ...(isPlainObject(extra) ? extra : {})
  };
}

function failure(error) {
  return {
    success: false,
    data: null,
    error: error?.message || String(error || "MCP request failed")
  };
}

function inputId(input) {
  if (typeof input === "string") return input.trim();
  return String(input?.serverId || input?.id || "").trim();
}

function normalizeAgentConfigs(response = {}) {
  const configs = isPlainObject(response.configs) ? response.configs : {};
  const mcpServers = isPlainObject(configs.mcpServers) ? configs.mcpServers : {};
  const mcpServersSnake = isPlainObject(configs.mcp_servers) ? configs.mcp_servers : mcpServers;
  return {
    configs: {
      ...configs,
      mcpServers,
      mcp_servers: mcpServersSnake
    }
  };
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex").slice(0, 16);
}

function testData(response = {}) {
  const diagnostic = isPlainObject(response.diagnostic) ? response.diagnostic : {};
  const status = String(diagnostic.status || response.status || response.lastTestStatus || "").trim();
  return {
    ...response,
    ...diagnostic,
    ...(status ? { status, lastTestStatus: status } : {})
  };
}

function createMcpService(deps = {}) {
  const coreRequest = deps.coreRequest;
  const appendLog = typeof deps.appendLog === "function" ? deps.appendLog : () => {};
  const openExternal = typeof deps.openExternal === "function" ? deps.openExternal : async () => false;
  if (typeof coreRequest !== "function") throw new Error("coreRequest dependency is required.");

  let cachedAgentConfigs = normalizeAgentConfigs();
  let initializationPromise = null;

  async function request(method, route, body) {
    return coreRequest(method, route, body);
  }

  async function refreshAgentConfigs() {
    const response = await request("GET", "/api/mcp/agent-configs");
    cachedAgentConfigs = normalizeAgentConfigs(response);
    return cachedAgentConfigs;
  }

  function startInitialization() {
    if (!initializationPromise) {
      initializationPromise = refreshAgentConfigs().catch((error) => {
        initializationPromise = null;
        throw error;
      });
    }
    return initializationPromise;
  }

  function refreshInBackground(reason) {
    refreshAgentConfigs().catch((error) => {
      appendLog(`[MCP] Rust Core MCP cache refresh failed after ${reason}: ${error?.message || error}`);
    });
  }

  async function withEnvelope(operation, transform = (value) => value, refreshReason = "") {
    try {
      const response = await operation();
      if (refreshReason) refreshInBackground(refreshReason);
      const data = transform(response);
      return success(data, response);
    } catch (error) {
      return failure(error);
    }
  }

  async function initialize() {
    try {
      const response = await startInitialization();
      return success(response, response);
    } catch (error) {
      return failure(error);
    }
  }

  function awaitInitialization() {
    return startInitialization();
  }

  function getEngineSpecs(engineId = "hermes") {
    if (!initializationPromise) refreshInBackground("lazy getEngineSpecs");
    const configs = cachedAgentConfigs.configs || {};
    if (engineId === "hermes" || !engineId) {
      return isPlainObject(configs.mcp_servers) ? configs.mcp_servers : {};
    }
    return isPlainObject(configs.mcpServers) ? configs.mcpServers : {};
  }

  function fingerprint() {
    return `core-mcp:${hashJson(cachedAgentConfigs.configs)}`;
  }

  async function list() {
    return withEnvelope(() => request("GET", "/api/mcp/servers"));
  }

  async function save(input = {}) {
    const id = inputId(input);
    return withEnvelope(
      () => id
        ? request("PATCH", `/api/mcp/servers/${encodeURIComponent(id)}`, input || {})
        : request("POST", "/api/mcp/servers", input || {}),
      (response) => response?.server || response,
      "save"
    );
  }

  async function deleteServer(id) {
    return withEnvelope(
      () => request("DELETE", `/api/mcp/servers/${encodeURIComponent(String(id || ""))}`),
      (response) => response,
      "delete"
    );
  }

  async function setEnabled(id, enabled) {
    return withEnvelope(
      () => request("PATCH", `/api/mcp/servers/${encodeURIComponent(String(id || ""))}`, { enabled: Boolean(enabled) }),
      (response) => response?.server || response,
      "setEnabled"
    );
  }

  async function test(input) {
    const id = inputId(input);
    const body = isPlainObject(input) ? input : {};
    return withEnvelope(
      () => request("POST", `/api/mcp/servers/${encodeURIComponent(id)}/test`, body),
      testData,
      "test"
    );
  }

  async function importJson(input, options = {}) {
    return withEnvelope(
      () => request("POST", "/api/mcp/servers/import", { input, options }),
      (response) => response,
      "importJson"
    );
  }

  async function fetchMarketplace() {
    return withEnvelope(() => request("GET", "/api/mcp/marketplace"));
  }

  async function installTemplate(templateId, values = {}) {
    return withEnvelope(
      () => request("POST", "/api/mcp/servers/install-template", { templateId, values }),
      (response) => response?.server || response,
      "installTemplate"
    );
  }

  async function runManagedAction(id, action, values = {}) {
    return withEnvelope(
      () => request("POST", `/api/mcp/servers/${encodeURIComponent(String(id || ""))}/managed-actions/${encodeURIComponent(String(action || ""))}`, values || {}),
      (response) => response?.server || response,
      "runManagedAction"
    );
  }

  async function sync() {
    return withEnvelope(
      () => request("POST", "/api/mcp/sync", {}),
      (response) => response,
      "sync"
    );
  }

  async function refreshBridge() {
    return withEnvelope(
      () => request("POST", "/api/mcp/bridge/refresh", {}),
      (response) => response,
      "refreshBridge"
    );
  }

  async function removeFromAgents(recordsOrIds) {
    return withEnvelope(() => request("POST", "/api/mcp/agent-configs/remove", { recordsOrIds }));
  }

  async function listTools() {
    return withEnvelope(() => request("GET", "/api/mcp/tools"));
  }

  async function getAgentConfigs() {
    return withEnvelope(() => request("GET", "/api/mcp/agent-configs"));
  }

  async function importAgentConfig(input = {}) {
    return withEnvelope(
      () => request("POST", "/api/mcp/agent-configs/import", input || {}),
      (response) => response,
      "importAgentConfig"
    );
  }

  async function openOAuthAuthUrl(response = {}) {
    const authUrl = String(response.authUrl || response.auth_url || "").trim();
    if (!authUrl) return;
    try {
      const opened = await openExternal(authUrl);
      if (opened === false) appendLog("[MCP] OAuth authorization URL was not opened by the foreground adapter.");
    } catch (error) {
      appendLog(`[MCP] OAuth authorization URL open failed: ${error?.message || error}`);
    }
  }

  const oauth = {
    checkStatus: (input = {}) => withEnvelope(() => request("GET", `/api/mcp/oauth/${encodeURIComponent(inputId(input))}/status`)),
    login: (input = {}) => withEnvelope(async () => {
      const response = await request("POST", `/api/mcp/oauth/${encodeURIComponent(inputId(input))}/login`, input || {});
      await openOAuthAuthUrl(response);
      return response;
    }),
    logout: (input = {}) => withEnvelope(() => request("POST", `/api/mcp/oauth/${encodeURIComponent(inputId(input))}/logout`, {}))
  };

  return {
    awaitInitialization,
    create: save,
    delete: deleteServer,
    fetchMarketplace,
    fingerprint,
    getAgentConfigs,
    getEngineSpecs,
    importAgentConfig,
    importJson,
    initialize,
    installTemplate,
    list,
    listTools,
    oauth,
    refreshBridge,
    removeFromAgents,
    runManagedAction,
    save,
    setEnabled,
    sync,
    test,
    testConnection: test,
    update: save
  };
}

module.exports = { createMcpService };
