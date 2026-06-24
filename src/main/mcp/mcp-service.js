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
} = require("./mcp-engine-sync.js");
const {
  enabledMcpRecords,
  maskMcpRecord,
  mcpFingerprint,
  normalizeMcpRecord,
  normalizeMcpRegistry,
  parseMcpImportJson,
  sanitizeSecretText
} = require("./mcp-records.js");

const MASK_SENTINEL = "••••••••";
const MCP_MARKETPLACE_TEMPLATES = [
  {
    id: "xhs-local-http",
    name: "小红书 MCP",
    nativeName: "xiaohongshu-mcp",
    description: "连接 xpzouying/xiaohongshu-mcp 在本机运行的 HTTP MCP 服务。",
    category: "内容平台",
    homepage: "https://github.com/xpzouying/xiaohongshu-mcp",
    setupHint: "来自 xpzouying/xiaohongshu-mcp；按 README 先运行登录工具，再启动本地 MCP 服务，Mia 只负责连接。",
    setupCommands: ["go run cmd/login/main.go", "go run ."],
    expectedToolCount: 13,
    transport: {
      type: "http",
      url: "http://localhost:18060/mcp",
      headers: {}
    },
    requiredEnvKeys: []
  },
  {
    id: "chrome-devtools-cdp",
    name: "Chrome DevTools MCP",
    nativeName: "chrome-devtools-cdp",
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
    nativeName: "playwright-browser",
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

function marketplaceTemplateById(id) {
  const needle = String(id || "").trim();
  return MCP_MARKETPLACE_TEMPLATES.find((template) => template.id === needle) || null;
}

function withMarketplaceTemplateDefaults(input = {}) {
  const template = marketplaceTemplateById(input.registryId);
  if (!template) return input;
  const nativeName = input.nativeName && input.nativeName !== template.id
    ? input.nativeName
    : template.nativeName;
  return {
    ...template,
    ...input,
    description: input.description || template.description,
    nativeName,
    homepage: input.homepage || template.homepage || "",
    setupHint: input.setupHint || template.setupHint || "",
    setupCommands: Array.isArray(input.setupCommands) && input.setupCommands.length
      ? input.setupCommands
      : template.setupCommands || [],
    expectedToolCount: input.expectedToolCount || template.expectedToolCount || 0
  };
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

function createMcpService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const fsImpl = deps.fs || fs;
  const manager = deps.manager;
  const bridge = deps.bridge || null;
  const nativeSync = typeof deps.nativeSync === "function"
    ? deps.nativeSync
    : async () => ({ success: true, statuses: {}, commands: [] });
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const idFactory = typeof deps.idFactory === "function" ? deps.idFactory : () => `mcp_${crypto.randomUUID()}`;
  const nodePath = typeof deps.nodePath === "function" ? deps.nodePath : () => "";
  const stdioProxyScriptPath = typeof deps.stdioProxyScriptPath === "function"
    ? deps.stdioProxyScriptPath
    : () => path.join(__dirname, "mcp-stdio-proxy-server.js");
  const initializationTimeoutMs = Number.isFinite(Number(deps.initializationTimeoutMs))
    && Number(deps.initializationTimeoutMs) > 0
    ? Number(deps.initializationTimeoutMs)
    : 5000;

  let bridgeInfo = null;
  let initializationPromise = null;

  function recordsPath() {
    return runtimePaths().mcpServers;
  }

  function loadRecords() {
    const raw = readJson(fsImpl, recordsPath(), []);
    const rows = Array.isArray(raw) ? raw.map((record) => withMarketplaceTemplateDefaults(record)) : [];
    return normalizeMcpRegistry(rows, { now, idFactory });
  }

  function saveRecords(records) {
    const rows = Array.isArray(records) ? records.map((record) => withMarketplaceTemplateDefaults(record)) : [];
    const normalized = normalizeMcpRegistry(rows, { now, idFactory });
    atomicWriteJson(fsImpl, recordsPath(), normalized);
    return normalized;
  }

  function publicRecord(record) {
    return maskMcpRecord(record);
  }

  function publicServers(records = loadRecords()) {
    return records.map((record) => publicRecord(record));
  }

  function maskedBridgeInfo(info) {
    if (!info || typeof info !== "object") return null;
    return {
      ...info,
      secret: info.secret ? "••••••••" : ""
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
    const current = normalizeMcpRegistry(records, { now, idFactory });
    const refreshed = manager && typeof manager.refresh === "function"
      ? await manager.refresh(enabledMcpRecords(current))
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
    const storedRecords = normalizeMcpRegistry(options.persistedRecords || currentRecords, { now, idFactory });
    let bridgeState = await refreshBridgeState(options.bridgeRecords || storedRecords);
    const nativeResult = await nativeSync({
      previousRecords: normalizeMcpRegistry(previousRecords || [], { now, idFactory }),
      currentRecords: normalizeMcpRegistry(currentRecords || [], { now, idFactory })
    });
    const nativeStatuses = nativeResult?.statuses && typeof nativeResult.statuses === "object"
      ? nativeResult.statuses
      : {};
    const persistedBase = hasNativeErrors(nativeStatuses) && options.persistedRecordsOnError
      ? normalizeMcpRegistry(options.persistedRecordsOnError, { now, idFactory })
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
    return records.find((record) => record.id === needle || record.name === needle || record.nativeName === needle) || null;
  }

  function normalizeInputRecord(input, currentRecords) {
    const inputName = String(input?.name || "").trim();
    const inputNativeName = String(input?.nativeName || input?.native_name || "").trim();
    const existing = resolveRecord(currentRecords, input?.id)
      || currentRecords.find((record) => record.name === inputName || (inputNativeName && record.nativeName === inputNativeName))
      || null;
    const inputTransport = input?.transport && typeof input.transport === "object" ? input.transport : null;
    const existingTransport = existing?.transport && typeof existing.transport === "object" ? existing.transport : {};
    const mergedTransport = inputTransport
      ? preserveMaskedTransportSecrets(inputTransport, existingTransport)
      : undefined;
    const merged = normalizeMcpRecord({
      ...(existing || {}),
      ...(input || {}),
      ...(mergedTransport ? { transport: mergedTransport } : {}),
      id: String(input?.id || existing?.id || "").trim() || undefined,
      nativeName: input?.nativeName || input?.native_name || existing?.nativeName,
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
    return mcpFingerprint(records);
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
      const current = loadRecords();
      const existing = resolveRecord(current, id);
      if (!existing) throw new Error("MCP server not found.");
      const next = current.filter((record) => record.id !== existing.id);
      const runtime = await applyRuntimeChanges(current, next, {
        persistedRecordsOnError: current,
        bridgeRecordsOnError: current
      });
      return ok({
        bridge: runtime.bridgeState,
        servers: publicServers(runtime.records),
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
        : normalizeMcpRecord(idOrInput || {}, { now, idFactory });
      if (!record) throw new Error("MCP server not found.");
      const result = manager && typeof manager.testServer === "function"
        ? await manager.testServer(record)
        : { success: true, status: "connected", tools: [], error: "" };
      if (!existing) {
        return ok(publicRecord({
          ...record,
          status: result.status || "unknown",
          tools: Array.isArray(result.tools) ? result.tools : [],
          lastCheckedAt: now(),
          lastError: sanitizeSecretText(result.error || "")
        }));
      }
      const next = current.map((item) => (
        item.id === existing.id
          ? {
            ...item,
            status: String(result.status || "unknown"),
            tools: Array.isArray(result.tools) ? result.tools : [],
            lastCheckedAt: now(),
            lastError: sanitizeSecretText(result.error || ""),
            enabled: result.success ? item.enabled : false,
            updatedAt: now()
          }
          : item
      ));
      const saved = saveRecords(next);
      if (!result.success && existing.enabled !== false) {
        const runtime = await applyRuntimeChanges(current, saved, {
          availableIds: new Set([existing.id]),
          availableMessage: "Disabled in Mia after failed test."
        });
        return ok(publicRecord(resolveRecord(runtime.records, existing.id) || existing));
      }
      return ok(publicRecord(resolveRecord(saved, existing.id) || existing));
    } catch (error) {
      return fail(error);
    }
  }

  async function importJson(input, options = {}) {
    try {
      const current = loadRecords();
      const imported = parseMcpImportJson(input)
        .map((item) => normalizeMcpRecord({
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
        nativeName: values.nativeName || values.native_name || template.nativeName || template.id,
        description: template.description,
        registryId: template.id,
        source: "marketplace",
        enabled: values.enabled !== false,
        homepage: template.homepage || "",
        setupHint: template.setupHint || "",
        setupCommands: template.setupCommands || [],
        expectedToolCount: template.expectedToolCount || 0,
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
    return enabledMcpRecords(loadRecords());
  }

  function fingerprint() {
    return currentFingerprint(loadRecords());
  }

  function getEngineSpecs(engineId, options = {}) {
    startInitialization();
    const records = enabledRecords();
    const bridgeSpec = getBridgeSpec();
    if (engineId === "claude-code") return mcpSpecsForClaudeSdk(records, { bridge: bridgeSpec, ...options });
    if (engineId === "codex") return mcpSpecsForCodex(records, { bridge: bridgeSpec, ...options });
    if (engineId === "hermes") return mcpSpecsForHermes(records, { bridge: bridgeSpec, ...options });
    if (engineId === "openclaw") return mcpServersForOpenClawAcp(records, { bridge: bridgeSpec, ...options });
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
              return resolveRecord(current, value?.id || value?.name) || normalizeMcpRecord(value || {}, { now, idFactory });
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

  return {
    delete: deleteServer,
    enabledRecords,
    fetchMarketplace,
    fingerprint,
    getBridgeSpec,
    getEngineSpecs,
    importJson,
    initialize,
    awaitInitialization,
    installTemplate,
    list,
    refreshBridge,
    removeFromAgents,
    save,
    setEnabled,
    sync,
    test: testServer
  };
}

module.exports = { createMcpService };
