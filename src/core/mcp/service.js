"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { MCP_ENGINE_IDS } = require("../../shared/mcp-contracts.js");
const {
  bridgeMcpSpec,
  mcpServersForOpenClawAcp,
  mcpSpecsForClaudeSdk,
  mcpSpecsForCodex,
  mcpSpecsForHermes
} = require("./engine-sync.js");
const { createCoreMcpConnectionTester } = require("./connection-test.js");
const { createCoreMcpAgentConfigService, publicAgentConfigSources } = require("./agent-configs.js");
const { createCoreMcpOAuthService } = require("./oauth-service.js");
const { createCoreMcpOAuthTokenStore } = require("./oauth-token-store.js");
const {
  MASK,
  coreMcpFingerprint,
  enabledCoreMcpRecords,
  normalizeCoreMcpRecord,
  normalizeCoreMcpRegistry,
  parseCoreMcpImportJson,
  publicCoreMcpRecord,
  sanitizeSecretText
} = require("./records.js");
const { createCoreMcpFileRegistry } = require("./file-registry.js");

const MASK_SENTINEL = MASK;
const MCP_MARKETPLACE_TEMPLATES = [
  {
    id: "xhs-local-http",
    name: "小红书 MCP",
    description: "连接本机运行的小红书 MCP HTTP 服务。",
    category: "内容平台",
    transport: {
      type: "http",
      url: "http://127.0.0.1:18060/mcp",
      headers: {}
    },
    requiredEnvKeys: []
  },
  {
    id: "chrome-devtools-cdp",
    name: "Chrome DevTools MCP",
    description: "通过 Chromium/Chrome 远程调试端口提供浏览器检查、截图和交互测试。默认连接 http://127.0.0.1:9222。",
    category: "浏览器自动化",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@0.16.0", "--browser-url=http://127.0.0.1:9222"],
      env: {}
    },
    requiredEnvKeys: []
  },
  {
    id: "playwright-browser",
    name: "Playwright MCP",
    description: "启动 Playwright MCP 浏览器服务，用于打开本地页面、截图、点击、输入和验证前端交互。",
    category: "浏览器自动化",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: {}
    },
    requiredEnvKeys: []
  }
];

function marketplaceTemplates() {
  return MCP_MARKETPLACE_TEMPLATES.map((template) => JSON.parse(JSON.stringify(template)));
}

function readJson(fsImpl, filePath, fallback) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(fsImpl, filePath, value) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsImpl.renameSync(tmp, filePath);
}

function ok(data) {
  return { success: true, data, error: "" };
}

function fail(error) {
  return { success: false, data: null, error: sanitizeSecretText(error?.message || error || "Unknown error") };
}

function sanitizeBridgeError(error) {
  if (typeof error === "string") return sanitizeSecretText(error);
  if (!error || typeof error !== "object") return sanitizeSecretText(error);
  const next = { ...error };
  if (typeof next.error === "string") next.error = sanitizeSecretText(next.error);
  if (typeof next.message === "string") next.message = sanitizeSecretText(next.message);
  if (typeof next.error !== "string" && typeof next.message !== "string") {
    next.error = sanitizeSecretText(String(error));
  }
  return next;
}

function createCoreLocalManager({ connectionTester } = {}) {
  return {
    async refresh() {
      return { success: true, tools: [], errors: [] };
    },
    async testServer(record) {
      if (connectionTester && typeof connectionTester.testConnection === "function") {
        return connectionTester.testConnection(record);
      }
      return { ok: true, success: true, status: "connected", code: "ok", tools: [], error: "" };
    },
    toolManifest() {
      return [];
    }
  };
}

function createCoreMcpService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const fsImpl = deps.fs || fs;
  const bridge = deps.bridge || null;
  const nativeSync = typeof deps.nativeSync === "function"
    ? deps.nativeSync
    : async () => ({ success: true, statuses: {}, commands: [] });
  const agentConfigService = deps.agentConfigService || createCoreMcpAgentConfigService({
    runtimePaths,
    fs: fsImpl,
    runner: deps.agentConfigRunner,
    processEnvStrings: deps.processEnvStrings
  });
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const idFactory = typeof deps.idFactory === "function" ? deps.idFactory : () => `mcp_${crypto.randomUUID()}`;
  const nodePath = typeof deps.nodePath === "function" ? deps.nodePath : () => "";
  const stdioProxyScriptPath = typeof deps.stdioProxyScriptPath === "function"
    ? deps.stdioProxyScriptPath
    : () => path.join(__dirname, "../../main/mcp/mcp-stdio-proxy-server.js");
  const initializationTimeoutMs = Number.isFinite(Number(deps.initializationTimeoutMs))
    && Number(deps.initializationTimeoutMs) > 0
    ? Number(deps.initializationTimeoutMs)
    : 5000;

  const registry = deps.registry || createCoreMcpFileRegistry({ runtimePaths, fs: fsImpl, now, idFactory });
  const oauthTokenStore = deps.oauthTokenStore || createCoreMcpOAuthTokenStore({ runtimePaths, fs: fsImpl, now });
  const oauthService = deps.oauthService || createCoreMcpOAuthService({
    tokenStore: oauthTokenStore,
    fetch: deps.fetch,
    openExternal: deps.openExternal,
    createServer: deps.createServer,
    now
  });
  const connectionTester = deps.connectionTester || (!deps.manager ? createCoreMcpConnectionTester({
    loadSdk: deps.loadSdk,
    processEnvStrings: deps.processEnvStrings,
    oauthService,
    timeoutMs: deps.connectionTestTimeoutMs
  }) : null);
  const manager = deps.manager || (
    typeof deps.managerFactory === "function"
      ? deps.managerFactory({
        loadSdk: deps.loadSdk,
        processEnvStrings: deps.processEnvStrings,
        appendLog: deps.appendLog,
        authorizeToolCall: deps.authorizeToolCall,
        connectionTester,
        oauthService,
        connectionTestTimeoutMs: deps.connectionTestTimeoutMs
      })
      : createCoreLocalManager({ connectionTester })
  );

  let bridgeInfo = null;
  let initializationPromise = null;

  function loadRecords(options = {}) {
    return options.includeDeleted === true
      ? registry.readAll()
      : registry.readAll().filter((record) => !record.deletedAt);
  }

  function saveRecords(records) {
    const visibleIds = new Set();
    const visibleNames = new Set();
    for (const record of normalizeCoreMcpRegistry(records, { now, idFactory })) {
      visibleIds.add(record.id);
      visibleNames.add(record.name);
    }
    const preservedDeleted = registry.readAll().filter((record) => (
      record.deletedAt
      && !visibleIds.has(record.id)
      && !visibleNames.has(record.name)
    ));
    return registry.writeAll(preservedDeleted.concat(records));
  }

  function publicRecord(record) {
    return publicCoreMcpRecord(record);
  }

  function publicServers(records = loadRecords()) {
    return records.map((record) => publicRecord(record));
  }

  function maskedBridgeInfo(info) {
    if (!info || typeof info !== "object") return null;
    return {
      ...info,
      secret: info.secret ? MASK_SENTINEL : ""
    };
  }

  function mergeStatus(sync = {}, statusEntry = {}) {
    return {
      status: String(statusEntry.status || "pending"),
      message: sanitizeSecretText(statusEntry.message || statusEntry.error || "")
    };
  }

  function isErrorStatus(statusEntry = {}) {
    return String(statusEntry.status || "").trim().toLowerCase() === "error";
  }

  function hasNativeErrors(statuses = {}) {
    return Object.values(statuses || {}).some((statusEntry) => isErrorStatus(statusEntry));
  }

  function hasNativeCommandsOrErrors(statuses = {}, nativeCommands = []) {
    if (Array.isArray(nativeCommands) && nativeCommands.length) return true;
    return Object.values(statuses || {}).some((statusEntry) => (
      isErrorStatus(statusEntry)
      || (Array.isArray(statusEntry?.commands) && statusEntry.commands.length > 0)
    ));
  }

  function applyStatuses(records, nativeResult = {}, options = {}) {
    const availableIds = options.availableIds || new Set();
    const availableMessage = sanitizeSecretText(options.availableMessage || "");
    const statusRecordIds = options.statusRecordIds instanceof Set ? options.statusRecordIds : null;
    const statuses = nativeResult?.statuses && typeof nativeResult.statuses === "object"
      ? nativeResult.statuses
      : {};
    const nativeCommands = Array.isArray(nativeResult?.commands) ? nativeResult.commands : [];
    const sawNativeCommandsOrErrors = hasNativeCommandsOrErrors(statuses, nativeCommands);
    return records.map((record) => {
      if (statusRecordIds && !statusRecordIds.has(record.id)) {
        return record;
      }
      const nextSync = { ...(record.sync || {}) };
      for (const engineId of MCP_ENGINE_IDS) {
        const statusEntry = statuses[engineId];
        if (availableIds.has(record.id) && (engineId === "codex" || engineId === "claude-code")) {
          if (statusEntry && isErrorStatus(statusEntry)) {
            nextSync[engineId] = mergeStatus(nextSync[engineId], statusEntry);
            continue;
          }
          if (statusEntry || !sawNativeCommandsOrErrors) {
            nextSync[engineId] = { status: "available", message: availableMessage };
            continue;
          }
        }
        if (statusEntry) {
          nextSync[engineId] = mergeStatus(nextSync[engineId], statusEntry);
        }
      }
      return { ...record, sync: nextSync, updatedAt: now() };
    });
  }

  async function refreshBridgeState(records = loadRecords()) {
    const current = normalizeCoreMcpRegistry(records, { now, idFactory });
    const refreshed = manager && typeof manager.refresh === "function"
      ? await manager.refresh(enabledCoreMcpRecords(current))
      : { success: true, tools: [], errors: [] };
    if (bridge && typeof bridge.start === "function") {
      bridgeInfo = await bridge.start();
    }
    return {
      tools: Array.isArray(refreshed?.tools) ? refreshed.tools : [],
      errors: Array.isArray(refreshed?.errors) ? refreshed.errors.map((error) => sanitizeBridgeError(error)) : [],
      bridge: maskedBridgeInfo(bridgeInfo)
    };
  }

  function initializationTimeoutError(timeoutMs) {
    const error = new Error(`Timed out after ${timeoutMs}ms waiting for MCP initialization.`);
    error.code = "MCP_INIT_TIMEOUT";
    return error;
  }

  function startInitialization() {
    if (!initializationPromise) {
      initializationPromise = refreshBridgeState(loadRecords()).catch((error) => {
        initializationPromise = null;
        throw error;
      });
      initializationPromise.catch(() => {});
    }
    return initializationPromise;
  }

  function awaitInitialization(options = {}) {
    const requestedTimeoutMs = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : initializationTimeoutMs;
    const pending = startInitialization();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(initializationTimeoutError(timeoutMs));
      }, timeoutMs);
      pending.then((value) => {
        if (settled) return;
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        if (settled) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async function initialize(options = {}) {
    try {
      return ok(await awaitInitialization(options));
    } catch (error) {
      return fail(error);
    }
  }

  async function applyRuntimeChanges(previousRecords, currentRecords, options = {}) {
    const storedRecords = normalizeCoreMcpRegistry(options.persistedRecords || currentRecords, { now, idFactory });
    let bridgeState = await refreshBridgeState(options.bridgeRecords || storedRecords);
    const nativeResult = await nativeSync({
      previousRecords: normalizeCoreMcpRegistry(previousRecords || [], { now, idFactory }),
      currentRecords: normalizeCoreMcpRegistry(currentRecords || [], { now, idFactory })
    });
    const nativeStatuses = nativeResult?.statuses && typeof nativeResult.statuses === "object"
      ? nativeResult.statuses
      : {};
    const persistedBase = hasNativeErrors(nativeStatuses) && options.persistedRecordsOnError
      ? normalizeCoreMcpRegistry(options.persistedRecordsOnError, { now, idFactory })
      : storedRecords;
    if (hasNativeErrors(nativeStatuses) && options.bridgeRecordsOnError) {
      bridgeState = await refreshBridgeState(options.bridgeRecordsOnError);
    }
    const withStatuses = applyStatuses(persistedBase, nativeResult, {
      statusRecordIds: options.statusRecordIds,
      availableIds: options.availableIds || new Set(),
      availableMessage: options.availableMessage || ""
    });
    const persisted = saveRecords(withStatuses);
    return {
      bridgeState,
      native: nativeResult || { success: true, statuses: {}, commands: [] },
      records: persisted
    };
  }

  function resolveRecord(records, idOrName) {
    const needle = String(idOrName || "").trim();
    return records.find((record) => record.id === needle || record.name === needle) || null;
  }

  function normalizeInputRecord(input, currentRecords) {
    const existing = resolveRecord(currentRecords, input?.id) || currentRecords.find((record) => record.name === String(input?.name || "").trim()) || null;
    const inputTransport = input?.transport && typeof input.transport === "object" ? input.transport : null;
    const existingTransport = existing?.transport && typeof existing.transport === "object" ? existing.transport : {};
    const mergedTransport = inputTransport
      ? preserveMaskedTransportSecrets(inputTransport, existingTransport)
      : undefined;
    const merged = normalizeCoreMcpRecord({
      ...(existing || {}),
      ...(input || {}),
      ...(mergedTransport ? { transport: mergedTransport } : {}),
      id: String(input?.id || existing?.id || "").trim() || undefined,
      createdAt: existing?.createdAt,
      tools: Array.isArray(input?.tools) ? input.tools : existing?.tools,
      status: input?.status || existing?.status,
      sync: input?.sync || existing?.sync,
      lastCheckedAt: input?.lastCheckedAt ?? existing?.lastCheckedAt,
      lastError: input?.lastError ?? existing?.lastError,
      originalJson: input?.originalJson ?? existing?.originalJson
    }, { now, idFactory });
    if (!merged) throw new Error("MCP server record is invalid.");
    return { existing, record: { ...merged, updatedAt: now() } };
  }

  function preserveMaskedObjectValues(input = {}, existing = {}) {
    const out = {};
    for (const [key, value] of Object.entries(input || {})) {
      out[key] = String(value) === MASK_SENTINEL && Object.prototype.hasOwnProperty.call(existing || {}, key)
        ? existing[key]
        : value;
    }
    return out;
  }

  function preserveMaskedTransportSecrets(inputTransport = {}, existingTransport = {}) {
    const next = { ...inputTransport };
    if (inputTransport.env && typeof inputTransport.env === "object") {
      next.env = preserveMaskedObjectValues(inputTransport.env, existingTransport.env || {});
    }
    if (inputTransport.headers && typeof inputTransport.headers === "object") {
      next.headers = preserveMaskedObjectValues(inputTransport.headers, existingTransport.headers || {});
    }
    return next;
  }

  function currentFingerprint(records = loadRecords()) {
    return coreMcpFingerprint(records);
  }

  async function list() {
    try {
      const records = loadRecords();
      return ok({ servers: publicServers(records), fingerprint: currentFingerprint(records) });
    } catch (error) {
      return fail(error);
    }
  }

  async function save(input = {}) {
    try {
      const current = loadRecords();
      const { record } = normalizeInputRecord(input, current);
      const next = current.filter((item) => item.id !== record.id && item.name !== record.name);
      next.push(record);
      const saved = saveRecords(next);
      const runtime = await applyRuntimeChanges(current, saved, {
        availableIds: record.enabled === false ? new Set([record.id]) : new Set(),
        availableMessage: record.enabled === false ? "Disabled in Mia." : ""
      });
      const finalRecord = resolveRecord(runtime.records, record.id) || record;
      return ok(publicRecord(finalRecord));
    } catch (error) {
      return fail(error);
    }
  }

  async function setEnabled(id, enabled) {
    try {
      const current = loadRecords();
      const existing = resolveRecord(current, id);
      if (!existing) throw new Error("MCP server not found.");
      const next = current.map((record) => (
        record.id === existing.id
          ? { ...record, enabled: enabled === true, updatedAt: now() }
          : record
      ));
      const saved = saveRecords(next);
      const runtime = await applyRuntimeChanges(current, saved, {
        availableIds: enabled === true ? new Set() : new Set([existing.id]),
        availableMessage: enabled === true ? "" : "Disabled in Mia."
      });
      const finalRecord = resolveRecord(runtime.records, existing.id);
      return ok(publicRecord(finalRecord || existing));
    } catch (error) {
      return fail(error);
    }
  }

  async function deleteServer(id) {
    try {
      const previousRecords = loadRecords();
      const existing = resolveRecord(previousRecords, id);
      if (!existing) throw new Error("MCP server not found.");
      await registry.softDelete(existing.id);
      const allRecordsAfterSoftDelete = loadRecords({ includeDeleted: true });
      const remainingVisibleRecords = allRecordsAfterSoftDelete.filter((record) => !record.deletedAt);
      const runtime = await applyRuntimeChanges(previousRecords, remainingVisibleRecords, {
        persistedRecords: allRecordsAfterSoftDelete
      });
      return ok({
        bridge: runtime.bridgeState,
        servers: publicServers(runtime.records.filter((record) => !record.deletedAt)),
        fingerprint: currentFingerprint(runtime.records)
      });
    } catch (error) {
      return fail(error);
    }
  }

  async function testServer(idOrInput) {
    try {
      const current = loadRecords();
      const existing = typeof idOrInput === "string" ? resolveRecord(current, idOrInput) : null;
      const record = existing
        ? existing
        : normalizeCoreMcpRecord(idOrInput || {}, { now, idFactory });
      if (!record) throw new Error("MCP server not found.");
      const result = connectionTester && typeof connectionTester.testConnection === "function"
        ? await connectionTester.testConnection(record)
        : manager && typeof manager.testServer === "function"
          ? await manager.testServer(record)
          : { success: true, status: "connected", tools: [], error: "" };
      const diagnosticMessage = sanitizeSecretText(result?.message || result?.error || "");
      const nextRecord = {
        ...record,
        status: String(result?.status || "unknown"),
        lastTestStatus: String(result?.status || "unknown"),
        lastTestCode: result?.code ?? null,
        diagnostics: result && typeof result === "object" ? result : {},
        tools: Array.isArray(result?.tools) ? result.tools : [],
        lastCheckedAt: now(),
        lastError: diagnosticMessage,
        oauth: {
          ...(record.oauth && typeof record.oauth === "object" ? record.oauth : {}),
          authenticated: result?.auth?.authenticated === true
        },
        updatedAt: now()
      };
      if (!existing) {
        return ok(publicRecord(nextRecord));
      }
      const saved = saveRecords(current.map((item) => (
        item.id === existing.id
          ? { ...item, ...nextRecord, enabled: item.enabled }
          : item
      )));
      return ok(publicRecord(resolveRecord(saved, existing.id) || nextRecord));
    } catch (error) {
      return fail(error);
    }
  }

  async function importJson(input, options = {}) {
    try {
      const current = loadRecords();
      const imported = parseCoreMcpImportJson(input)
        .map((item) => normalizeCoreMcpRecord({
          ...item,
          enabled: false,
          originalJson: typeof input === "string" ? input : JSON.stringify(item)
        }, { now, idFactory }))
        .filter(Boolean);
      const names = new Set(imported.map((record) => record.name));
      const duplicates = current.filter((record) => names.has(record.name));
      if (duplicates.length && options?.replaceDuplicates !== true) {
        return ok({
          servers: publicServers(current),
          imported: 0,
          duplicates: duplicates.map((record) => record.name),
          requiresConfirmation: true,
          fingerprint: currentFingerprint(current)
        });
      }
      const next = current.filter((record) => !names.has(record.name)).concat(imported);
      if (duplicates.length) {
        const runtime = await applyRuntimeChanges(current, next, {
          persistedRecordsOnError: current,
          bridgeRecordsOnError: current
        });
        return ok({
          servers: publicServers(runtime.records),
          imported: imported.length,
          replaced: duplicates.length,
          duplicates: duplicates.map((record) => record.name),
          fingerprint: currentFingerprint(runtime.records)
        });
      }
      const saved = saveRecords(next);
      return ok({ servers: publicServers(saved), imported: imported.length, replaced: 0, fingerprint: currentFingerprint(saved) });
    } catch (error) {
      return fail(error);
    }
  }

  async function fetchMarketplace() {
    return ok({
      templates: marketplaceTemplates()
    });
  }

  async function installTemplate(templateId, values = {}) {
    try {
      const market = await fetchMarketplace();
      const template = market?.data?.templates?.find((item) => item.id === String(templateId || ""));
      if (!template) throw new Error("MCP template not found.");
      const name = String(values.name || template.name || "").trim() || template.id;
      return save({
        name,
        description: template.description,
        registryId: template.id,
        source: "marketplace",
        enabled: values.enabled !== false,
        transport: {
          ...template.transport,
          ...(values.transport && typeof values.transport === "object" ? values.transport : {})
        }
      });
    } catch (error) {
      return fail(error);
    }
  }

  async function refreshBridge() {
    try {
      return ok(await refreshBridgeState(loadRecords()));
    } catch (error) {
      return fail(error);
    }
  }

  function bridgeBaseUrl() {
    if (!bridgeInfo) return "";
    if (bridgeInfo.manifestUrl) return String(bridgeInfo.manifestUrl).replace(/\/mcp\/manifest$/, "");
    if (bridgeInfo.callbackUrl) return String(bridgeInfo.callbackUrl).replace(/\/mcp\/execute$/, "");
    return "";
  }

  function getBridgeSpec() {
    if (!bridgeInfo) return null;
    const command = String(nodePath() || "").trim();
    const bridgeUrl = bridgeBaseUrl();
    if (!command || !bridgeUrl || !bridgeInfo.secret) return null;
    return bridgeMcpSpec({
      command,
      scriptPath: stdioProxyScriptPath(),
      bridgeUrl,
      secret: bridgeInfo.secret
    });
  }

  function enabledRecords() {
    return enabledCoreMcpRecords(loadRecords());
  }

  function fingerprint() {
    return currentFingerprint(loadRecords());
  }

  function getEngineSpecs(engineId, options = {}) {
    startInitialization();
    const records = enabledRecords();
    const bridgeSpec = getBridgeSpec();
    const statusCollector = Array.isArray(options.statusCollector) ? options.statusCollector : [];
    const conversionOptions = { bridge: bridgeSpec, ...options, statusCollector };
    if (engineId === "claude-code") return mcpSpecsForClaudeSdk(records, conversionOptions);
    if (engineId === "codex") return mcpSpecsForCodex(records, conversionOptions);
    if (engineId === "hermes") return mcpSpecsForHermes(records, conversionOptions);
    if (engineId === "openclaw") return mcpServersForOpenClawAcp(records, conversionOptions);
    return {};
  }

  async function sync() {
    try {
      const current = loadRecords();
      const runtime = await applyRuntimeChanges(current, current);
      return ok({ servers: publicServers(runtime.records), fingerprint: currentFingerprint(runtime.records) });
    } catch (error) {
      return fail(error);
    }
  }

  async function removeFromAgents(recordsOrIds) {
    try {
      const current = loadRecords();
      const values = Array.isArray(recordsOrIds) ? recordsOrIds : (recordsOrIds ? [recordsOrIds] : []);
      const targets = values.length
        ? values
            .map((value) => {
              if (typeof value === "string") return resolveRecord(current, value);
              return resolveRecord(current, value?.id || value?.name) || normalizeCoreMcpRecord(value || {}, { now, idFactory });
            })
            .filter(Boolean)
        : current.filter((record) => record.enabled !== false);
      const persistedRecords = current.slice();
      const runtime = await applyRuntimeChanges(targets, [], {
        persistedRecords,
        statusRecordIds: new Set(targets.map((record) => record.id)),
        availableIds: new Set(targets.map((record) => record.id)),
        availableMessage: "Removed from native agents."
      });
      return ok({ servers: publicServers(runtime.records), fingerprint: currentFingerprint(runtime.records) });
    } catch (error) {
      return fail(error);
    }
  }

  async function listTools() {
    try {
      const tools = manager && typeof manager.toolManifest === "function" ? manager.toolManifest() : [];
      return ok({ tools: Array.isArray(tools) ? tools : [] });
    } catch (error) {
      return fail(error);
    }
  }

  async function getAgentConfigs() {
    try {
      const sources = agentConfigService && typeof agentConfigService.getAgentConfigs === "function"
        ? await agentConfigService.getAgentConfigs()
        : [];
      return ok({ sources: publicAgentConfigSources(sources) });
    } catch (error) {
      return fail(error);
    }
  }

  async function importAgentConfig(input = {}) {
    try {
      if (!agentConfigService || typeof agentConfigService.importAgentConfig !== "function") {
        throw new Error("Agent config service is not configured.");
      }
      const result = await agentConfigService.importAgentConfig(input);
      const server = result?.server;
      if (!server || server.importable === false) {
        throw new Error(server?.importSkipReason || "Discovered MCP server is not importable.");
      }
      const saved = await save({
        name: server.name,
        enabled: false,
        source: "agent-config",
        sourceAgent: input.sourceAgent,
        transport: server.transport
      });
      if (!saved.success) throw new Error(saved.error || "Failed to import MCP server.");
      return ok({ imported: 1, server: saved.data });
    } catch (error) {
      return fail(error);
    }
  }

  async function checkOauthStatus(input = {}) {
    try {
      if (!oauthService || typeof oauthService.checkStatus !== "function") {
        return ok({ authenticated: false });
      }
      return ok(await oauthService.checkStatus(input));
    } catch (error) {
      return fail(error);
    }
  }

  async function loginOauth(input = {}) {
    try {
      if (!oauthService || typeof oauthService.login !== "function") {
        throw new Error("OAuth service is not configured.");
      }
      return ok(await oauthService.login(input));
    } catch (error) {
      return fail(error);
    }
  }

  async function logoutOauth(input = {}) {
    try {
      if (!oauthService || typeof oauthService.logout !== "function") {
        return ok({ authenticated: false });
      }
      return ok(await oauthService.logout(input));
    } catch (error) {
      return fail(error);
    }
  }

  return {
    awaitInitialization,
    create: save,
    delete: deleteServer,
    enabledRecords,
    fetchMarketplace,
    fingerprint,
    getAgentConfigs,
    getBridgeSpec,
    getEngineSpecs,
    importAgentConfig,
    importJson,
    initialize,
    installTemplate,
    list,
    listTools,
    oauth: {
      checkStatus: checkOauthStatus,
      login: loginOauth,
      logout: logoutOauth
    },
    refreshBridge,
    removeFromAgents,
    save,
    setEnabled,
    sync,
    test: testServer,
    testConnection: testServer,
    update: save
  };
}

module.exports = { createCoreMcpService };
