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
  isCoreMcpExposureReady,
  normalizeCoreMcpRecord,
  normalizeCoreMcpRegistry,
  parseCoreMcpImportJson,
  publicCoreMcpRecord,
  sanitizeSecretText
} = require("./records.js");
const { createCoreMcpFileRegistry } = require("./file-registry.js");
const {
  builtinMcpTemplates,
  builtinMcpTemplateById,
  materializeBuiltinMcpRecord
} = require("./catalog.js");

const MASK_SENTINEL = MASK;

function isLegacyPlaywrightTransport(transport = {}) {
  return String(transport?.type || "") === "stdio"
    && String(transport?.command || "") === "npx"
    && Array.isArray(transport?.args)
    && transport.args.some((arg) => String(arg || "").includes("@executeautomation/playwright-mcp-server"));
}

function withMarketplaceTemplateDefaults(input = {}) {
  const template = builtinMcpTemplateById(input.registryId);
  if (!template) return input;
  const shouldMigratePlaywright = template.id === "playwright" && isLegacyPlaywrightTransport(input.transport);
  return {
    ...input,
    ...(shouldMigratePlaywright ? {
      transport: template.transport,
      enabled: false,
      status: "disconnected",
      lastTestStatus: "disconnected",
      lastTestCode: null,
      diagnostics: { message: "" },
      tools: [],
      lastError: ""
    } : {}),
    description: input.description || template.description,
    nativeName: input.nativeName || input.native_name || template.nativeName,
    homepage: input.homepage || template.homepage || "",
    managementMode: input.managementMode || template.managementMode,
    requiredInputs: input.requiredInputs || template.requiredInputs || [],
    connectionWizard: shouldMigratePlaywright
      ? {
        state: "ready_to_test",
        nextAction: "test",
        message: "Mia 将检测连接，成功后启用到新对话。",
        missingRequiredInputs: [],
        actions: [{ id: "test", label: "检测并启用" }]
      }
      : input.connectionWizard || template.connectionWizard || {},
    managedRuntime: input.managedRuntime || template.managedRuntime || {},
    expectedToolCount: input.expectedToolCount || template.managedRuntime?.expectedToolCount || 0
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

function failWithData(error, data) {
  return { success: false, data, error: sanitizeSecretText(error?.message || error || "Unknown error") };
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

function sanitizeManagedValue(value) {
  if (typeof value === "string") return sanitizeSecretText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeManagedValue(item));
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = sanitizeManagedValue(entry);
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
  const managedSupervisor = deps.managedSupervisor || null;
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

  function applyMarketplaceDefaults(records = []) {
    const rows = Array.isArray(records) ? records : [];
    return normalizeCoreMcpRegistry(rows.map((record) => withMarketplaceTemplateDefaults(record)), { now, idFactory });
  }

  function loadRecords(options = {}) {
    const records = applyMarketplaceDefaults(registry.readAll());
    return options.includeDeleted === true
      ? records
      : records.filter((record) => !record.deletedAt);
  }

  function saveRecords(records) {
    const visibleIds = new Set();
    const visibleNames = new Set();
    const normalizedRecords = applyMarketplaceDefaults(records);
    for (const record of normalizedRecords) {
      visibleIds.add(record.id);
      visibleNames.add(record.name);
    }
    const preservedDeleted = registry.readAll().filter((record) => (
      record.deletedAt
      && !visibleIds.has(record.id)
      && !visibleNames.has(record.name)
    ));
    return registry.writeAll(preservedDeleted.concat(normalizedRecords).map((record) => withMarketplaceTemplateDefaults(record)));
  }

  function publicRecord(record) {
    return publicCoreMcpRecord(record);
  }

  function publicServers(records = loadRecords()) {
    return records.map((record) => publicRecord(record));
  }

  function publicBridgeState(state = {}) {
    return {
      tools: Array.isArray(state?.tools) ? state.tools : [],
      errors: Array.isArray(state?.errors) ? state.errors : [],
      bridge: maskedBridgeInfo(state?.bridge || bridgeInfo)
    };
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

  function mergeManagedRecordState(record, updatedRecord) {
    if (!updatedRecord || updatedRecord.id !== record.id) return record;
    const next = { ...record };
    const managedKeys = [
      "managedRuntime",
      "connectionWizard",
      "status",
      "lastTestStatus",
      "lastTestCode",
      "diagnostics",
      "tools",
      "lastCheckedAt",
      "lastError",
      "enabled",
      "oauth",
      "sync"
    ];
    for (const key of managedKeys) {
      if (Object.prototype.hasOwnProperty.call(updatedRecord, key)) {
        next[key] = sanitizeManagedValue(updatedRecord[key]);
      }
    }
    next.updatedAt = now();
    return normalizeCoreMcpRecord(next, { now, idFactory }) || record;
  }

  function mergeManagedRecords(records = [], updatedRecords = []) {
    const updates = new Map((Array.isArray(updatedRecords) ? updatedRecords : []).map((record) => [record.id, record]));
    return normalizeCoreMcpRegistry(records.map((record) => mergeManagedRecordState(record, updates.get(record.id))), { now, idFactory });
  }

  function managedRefreshFailureMatchers(errors = []) {
    const failedIds = new Set();
    const failedNames = new Set();
    for (const error of Array.isArray(errors) ? errors : []) {
      if (!error || typeof error !== "object") continue;
      const id = String(error.id || "").trim();
      const name = String(error.name || "").trim();
      if (id) failedIds.add(id);
      if (name) failedNames.add(name);
    }
    return { failedIds, failedNames };
  }

  function isManagedRefreshFailure(record, matchers) {
    if (!record || record.managementMode !== "managed") return false;
    if (matchers.failedIds.has(record.id)) return true;
    return matchers.failedNames.has(record.name) || matchers.failedNames.has(record.nativeName);
  }

  function isManagedExposureReady(record) {
    return isCoreMcpExposureReady(record);
  }

  function canEnableManagedRecord(record) {
    return isManagedExposureReady(record);
  }

  function isMarketplaceBuiltInRecord(record = {}) {
    const registryId = String(record.registryId || "").trim();
    return !!builtinMcpTemplateById(registryId) || (
      record.source === "marketplace"
      && ["native", "managed"].includes(String(record.managementMode || ""))
    );
  }

  function missingRequiredInputKeys(record = {}) {
    const requiredInputs = Array.isArray(record.requiredInputs) ? record.requiredInputs : [];
    const transport = record.transport && typeof record.transport === "object" ? record.transport : {};
    const env = transport.env && typeof transport.env === "object" ? transport.env : {};
    return requiredInputs
      .filter((field) => field?.required !== false)
      .filter((field) => {
        if (String(field?.target || "env") !== "env") return false;
        return !String(env[field.key] || "").trim();
      })
      .map((field) => field.key);
  }

  function canEnableNativeBuiltInRecord(record = {}) {
    const status = String(record.status || "").trim().toLowerCase();
    const lastTestStatus = String(record.lastTestStatus || "").trim().toLowerCase();
    return status === "connected"
      && lastTestStatus === "connected";
  }

  function nativeBuiltInEnableError(record = {}) {
    if (record.managementMode !== "native" || !isMarketplaceBuiltInRecord(record)) return "";
    if (missingRequiredInputKeys(record).length) {
      return "请先完成这个 MCP 的必填配置。";
    }
    if (!canEnableNativeBuiltInRecord(record)) {
      return "连接检测未通过，暂时不能启用。";
    }
    return "";
  }

  function managedEnsureFailureRecords(records = [], error) {
    const message = sanitizeSecretText(error?.message || error || "Managed MCP startup failed.");
    return normalizeCoreMcpRegistry(
      records
        .filter((record) => record?.managementMode === "managed")
        .map((record) => normalizeCoreMcpRecord({
          ...record,
          managedRuntime: {
            ...(record?.managedRuntime && typeof record.managedRuntime === "object" ? sanitizeManagedValue(record.managedRuntime) : {}),
            state: "error"
          },
          connectionWizard: managedActionFailureWizard(
            record,
            String(record?.connectionWizard?.nextAction || "").trim() || "start",
            message
          ),
          lastError: message,
          updatedAt: now()
        }, { now, idFactory })),
      { now, idFactory }
    );
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
    const enabledCurrentRecords = enabledCoreMcpRecords(current);
    let managedResult = { records: enabledCurrentRecords, errors: [] };
    if (managedSupervisor && typeof managedSupervisor.ensureRunning === "function") {
      try {
        managedResult = await managedSupervisor.ensureRunning(enabledCurrentRecords);
      } catch (error) {
        const failedManagedRecords = managedEnsureFailureRecords(enabledCurrentRecords, error);
        managedResult = {
          records: failedManagedRecords,
          errors: failedManagedRecords.map((record) => ({
            id: record.id,
            name: record.nativeName || record.name,
            message: sanitizeSecretText(error?.message || error || "Managed MCP startup failed.")
          }))
        };
      }
    }
    const runtimeRecords = mergeManagedRecords(current, managedResult.records);
    const refreshFailureMatchers = managedRefreshFailureMatchers(managedResult.errors);
    const refreshableRecords = enabledCoreMcpRecords(runtimeRecords).filter((record) => !isManagedRefreshFailure(record, refreshFailureMatchers));
    const nativeSyncRecords = runtimeRecords.filter((record) => !isManagedRefreshFailure(record, refreshFailureMatchers));
    const refreshed = refreshableRecords.length > 0 && manager && typeof manager.refresh === "function"
      ? await manager.refresh(refreshableRecords)
      : { success: true, tools: [], errors: [] };
    if (bridge && typeof bridge.start === "function") {
      bridgeInfo = await bridge.start();
    }
    return {
      tools: Array.isArray(refreshed?.tools) ? refreshed.tools : [],
      errors: []
        .concat(Array.isArray(refreshed?.errors) ? refreshed.errors.map((error) => sanitizeBridgeError(error)) : [])
        .concat(Array.isArray(managedResult?.errors) ? managedResult.errors.map((error) => sanitizeBridgeError(error)) : []),
      bridge: maskedBridgeInfo(bridgeInfo),
      records: runtimeRecords,
      nativeSyncRecords
    };
  }

  function initializationTimeoutError(timeoutMs) {
    const error = new Error(`Timed out after ${timeoutMs}ms waiting for MCP initialization.`);
    error.code = "MCP_INIT_TIMEOUT";
    return error;
  }

  function startInitialization() {
    if (!initializationPromise) {
      initializationPromise = refreshBridgeState(loadRecords())
        .then((state) => {
          if (Array.isArray(state?.records)) saveRecords(state.records);
          return publicBridgeState(state);
        })
        .catch((error) => {
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
      currentRecords: normalizeCoreMcpRegistry(bridgeState.nativeSyncRecords || currentRecords || [], { now, idFactory })
    });
    const nativeStatuses = nativeResult?.statuses && typeof nativeResult.statuses === "object"
      ? nativeResult.statuses
      : {};
    const persistedBase = hasNativeErrors(nativeStatuses) && options.persistedRecordsOnError
      ? mergeManagedRecords(normalizeCoreMcpRegistry(options.persistedRecordsOnError, { now, idFactory }), bridgeState.records)
      : normalizeCoreMcpRegistry(bridgeState.records || storedRecords, { now, idFactory });
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
      bridgeState: publicBridgeState(bridgeState),
      native: nativeResult || { success: true, statuses: {}, commands: [] },
      records: persisted
    };
  }

  function resolveRecord(records, idOrName) {
    const needle = String(idOrName || "").trim();
    return records.find((record) => record.id === needle || record.name === needle || record.nativeName === needle) || null;
  }

  function normalizeInputRecord(input, currentRecords) {
    const initialInput = input || {};
    const inputName = String(initialInput?.name || "").trim();
    const inputNativeName = String(initialInput?.nativeName || initialInput?.native_name || "").trim();
    const existing = resolveRecord(currentRecords, initialInput?.id)
      || currentRecords.find((record) => record.name === inputName || (inputNativeName && record.nativeName === inputNativeName))
      || null;
    const sourceInput = withMarketplaceTemplateDefaults(stripPublicBuiltInRuntimePatches(initialInput, existing));
    const inputTransport = sourceInput?.transport && typeof sourceInput.transport === "object" ? sourceInput.transport : null;
    const existingTransport = existing?.transport && typeof existing.transport === "object" ? existing.transport : {};
    const mergedTransport = inputTransport
      ? preserveMaskedTransportSecrets(inputTransport, existingTransport)
      : undefined;
    const merged = normalizeCoreMcpRecord({
      ...(existing || {}),
      ...(sourceInput || {}),
      ...(mergedTransport ? { transport: mergedTransport } : {}),
      id: String(sourceInput?.id || existing?.id || "").trim() || undefined,
      nativeName: sourceInput?.nativeName || sourceInput?.native_name || existing?.nativeName,
      createdAt: existing?.createdAt,
      tools: Array.isArray(sourceInput?.tools) ? sourceInput.tools : existing?.tools,
      status: sourceInput?.status || existing?.status,
      sync: sourceInput?.sync || existing?.sync,
      lastCheckedAt: sourceInput?.lastCheckedAt ?? existing?.lastCheckedAt,
      lastError: sourceInput?.lastError ?? existing?.lastError,
      originalJson: sourceInput?.originalJson ?? existing?.originalJson
    }, { now, idFactory });
    if (!merged) throw new Error("MCP server record is invalid.");
    return { existing, record: { ...merged, updatedAt: now() } };
  }

  function stripPublicBuiltInRuntimePatches(input = {}, existing = null) {
    const registryId = String(input.registryId || existing?.registryId || "").trim();
    const isBuiltIn = !!builtinMcpTemplateById(registryId)
      || (existing && isMarketplaceBuiltInRecord(existing));
    if (!isBuiltIn) return input;
    const next = { ...input };
    if (existing?.managedRuntime) next.managedRuntime = existing.managedRuntime;
    else delete next.managedRuntime;
    if (existing?.connectionWizard) next.connectionWizard = existing.connectionWizard;
    if (Array.isArray(existing?.requiredInputs)) next.requiredInputs = existing.requiredInputs;
    return next;
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
      if (enabled === true && existing.managementMode === "managed" && !canEnableManagedRecord(existing)) {
        return failWithData("连接检测未通过，暂时不能启用。", publicRecord(existing));
      }
      if (enabled === true) {
        const builtInError = nativeBuiltInEnableError(existing);
        if (builtInError) return failWithData(builtInError, publicRecord(existing));
      }
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
      const isBuiltInNative = record.managementMode === "native" && isMarketplaceBuiltInRecord(record);
      const testedStatus = String(result?.status || "unknown");
      const nextRecord = {
        ...record,
        status: testedStatus,
        lastTestStatus: testedStatus,
        lastTestCode: result?.code ?? null,
        diagnostics: result && typeof result === "object" ? result : {},
        tools: Array.isArray(result?.tools) ? result.tools : [],
        lastCheckedAt: now(),
        lastError: diagnosticMessage,
        oauth: {
          ...(record.oauth && typeof record.oauth === "object" ? record.oauth : {}),
          authenticated: result?.auth?.authenticated === true
        },
        ...(isBuiltInNative ? {
          connectionWizard: testedStatus === "connected"
            ? { state: "connected", nextAction: "", message: "Connected and enabled.", missingRequiredInputs: [], actions: [] }
            : { state: "test_failed", nextAction: "test", message: diagnosticMessage || "Connection test failed.", missingRequiredInputs: [], actions: [{ id: "test", label: "重新检测" }] }
        } : {}),
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
    return ok({ templates: builtinMcpTemplates() });
  }

  async function installTemplate(templateId, values = {}) {
    try {
      const template = builtinMcpTemplateById(templateId);
      if (!template) throw new Error("MCP template not found.");
      const current = loadRecords();
      const existing = resolveRecord(current, values.id || template.nativeName || template.name)
        || current.find((record) => record.registryId === template.id)
        || null;
      const materialized = materializeBuiltinMcpRecord(template, {
        ...values,
        id: existing?.id,
        name: values.name || existing?.name || template.name
      }, { now, idFactory });
      let record = {
        ...(existing || {}),
        ...materialized.record,
        createdAt: existing?.createdAt || materialized.record.createdAt,
        updatedAt: now()
      };

      const withoutExisting = current.filter((item) => item.id !== record.id && item.name !== record.name);
      let saved = saveRecords(withoutExisting.concat(record));

      if (materialized.missingRequiredInputs.length) {
        const runtime = await applyRuntimeChanges(current, saved, {
          availableIds: new Set([record.id]),
          availableMessage: "Waiting for required fields in Mia."
        });
        return ok(publicRecord(resolveRecord(runtime.records, record.id) || record));
      }

      if (record.managementMode === "managed") {
        return ok(publicRecord(resolveRecord(saved, record.id) || record));
      }

      const tested = await testServer(record);
      if (!tested.success) throw new Error(tested.error || "MCP connection test failed.");
      const testedRecord = normalizeCoreMcpRecord({
        ...record,
        ...tested.data,
        transport: record.transport,
        requiredInputs: record.requiredInputs,
        connectionWizard: tested.data.status === "connected"
          ? { state: "connected", nextAction: "", message: "Connected and enabled.", missingRequiredInputs: [], actions: [] }
          : { state: "test_failed", nextAction: "test", message: tested.data.lastError || "Connection test failed.", missingRequiredInputs: [], actions: [{ id: "test", label: "重新检测" }] },
        enabled: tested.data.status === "connected"
      }, { now, idFactory });
      saved = saveRecords(withoutExisting.concat(testedRecord));
      const runtime = await applyRuntimeChanges(current, saved, {
        availableIds: testedRecord.enabled ? new Set() : new Set([testedRecord.id]),
        availableMessage: testedRecord.enabled ? "" : "Connection test failed in Mia."
      });
      return ok(publicRecord(resolveRecord(runtime.records, testedRecord.id) || testedRecord));
    } catch (error) {
      return fail(error);
    }
  }

  function nextManagedWizard(action, result, testStatus = "") {
    if (action === "install") {
      return { state: "needs_managed_action", nextAction: "login", message: result.message || "Installed.", missingRequiredInputs: [], actions: [{ id: "login", label: "打开登录" }, { id: "start", label: "启动服务" }, { id: "test", label: "检测并启用" }] };
    }
    if (action === "login") {
      return { state: "needs_managed_action", nextAction: "start", message: result.message || "Login started.", missingRequiredInputs: [], actions: [{ id: "start", label: "启动服务" }, { id: "test", label: "检测并启用" }] };
    }
    if (action === "start") {
      return { state: "ready_to_test", nextAction: "test", message: result.message || "Service started.", missingRequiredInputs: [], actions: [{ id: "test", label: "检测并启用" }] };
    }
    if (action === "test" && testStatus === "connected") {
      return { state: "connected", nextAction: "", message: "Connected and enabled.", missingRequiredInputs: [], actions: [] };
    }
    if (action === "test") {
      return { state: "test_failed", nextAction: "test", message: result.message || "Connection test failed.", missingRequiredInputs: [], actions: [{ id: "test", label: "重新检测" }] };
    }
    return { state: "needs_managed_action", nextAction: "start", message: result.message || "", missingRequiredInputs: [], actions: [{ id: "start", label: "启动服务" }, { id: "test", label: "检测并启用" }] };
  }

  function managedFallbackActions(nextAction = "") {
    if (nextAction === "install") return [{ id: "install", label: "安装组件" }];
    if (nextAction === "login") return [{ id: "login", label: "打开登录" }, { id: "start", label: "启动服务" }, { id: "test", label: "检测并启用" }];
    if (nextAction === "start") return [{ id: "start", label: "启动服务" }, { id: "test", label: "检测并启用" }];
    if (nextAction === "test") return [{ id: "test", label: "检测并启用" }];
    return nextAction ? [{ id: nextAction, label: nextAction }] : [];
  }

  function managedActionFailureWizard(existing, action, message, patch = {}) {
    const text = String(message || "").trim();
    const shouldRestart = String(action || "").trim() === "test"
      && /endpoint health check failed/i.test(text);
    const nextAction = shouldRestart ? "start" : (String(action || "").trim() || "start");
    const wizard = {
      ...(existing?.connectionWizard && typeof existing.connectionWizard === "object" ? existing.connectionWizard : {}),
      ...(patch && typeof patch === "object" ? sanitizeManagedValue(patch) : {}),
      state: "managed_error",
      nextAction,
      message,
      missingRequiredInputs: Array.isArray(patch?.missingRequiredInputs) ? sanitizeManagedValue(patch.missingRequiredInputs) : [],
      ...(shouldRestart ? {
        actions: [{ id: "start", label: "启动服务" }, { id: "test", label: "检测并启用" }]
      } : {})
    };
    const actions = Array.isArray(wizard.actions) ? wizard.actions : [];
    if (!actions.some((entry) => entry?.id === nextAction)) {
      wizard.actions = managedFallbackActions(nextAction);
    }
    return wizard;
  }

  function managedActionPatch(recordPatch = {}) {
    const patch = recordPatch && typeof recordPatch === "object"
      ? sanitizeManagedValue(recordPatch)
      : {};
    return {
      ...patch,
      transport: undefined
    };
  }

  function mergeManagedActionRecord(existing, patch = {}, overrides = {}) {
    return normalizeCoreMcpRecord({
      ...existing,
      ...patch,
      ...overrides,
      transport: existing.transport,
      updatedAt: now()
    }, { now, idFactory });
  }

  async function persistManagedActionResult(current, existing, nextRecord, options = {}) {
    const saved = saveRecords(current.map((record) => record.id === existing.id ? nextRecord : record));
    const runtime = await applyRuntimeChanges(current, saved, {
      availableIds: options.availableIds || new Set([nextRecord.id]),
      availableMessage: options.availableMessage || "Waiting for managed MCP setup in Mia."
    });
    return resolveRecord(runtime.records, nextRecord.id) || nextRecord;
  }

  async function persistManagedActionError(current, existing, action, error) {
    const message = sanitizeSecretText(error?.message || error || "Managed MCP action failed.");
    const nextRecord = mergeManagedActionRecord(existing, {}, {
      enabled: false,
      connectionWizard: managedActionFailureWizard(existing, action, message),
      managedRuntime: {
        ...(existing?.managedRuntime && typeof existing.managedRuntime === "object" ? sanitizeManagedValue(existing.managedRuntime) : {}),
        state: "error",
        lastAction: String(action || "").trim()
      },
      lastError: message
    });
    const finalRecord = await persistManagedActionResult(current, existing, nextRecord);
    return failWithData(message, publicRecord(finalRecord));
  }

  async function runManagedAction(id, action, values = {}) {
    try {
      const current = loadRecords();
      const existing = resolveRecord(current, id);
      if (!existing) throw new Error("MCP server not found.");
      if (existing.managementMode !== "managed") throw new Error("MCP server is not managed by Mia.");
      if (!managedSupervisor || typeof managedSupervisor.runAction !== "function") {
        throw new Error("Managed MCP supervisor is not configured.");
      }

      let result = { ok: true, state: "", message: "", recordPatch: {} };
      let nextRecord = existing;
      if (action !== "test") {
        try {
          result = await managedSupervisor.runAction(existing, action, values || {});
        } catch (error) {
          return await persistManagedActionError(current, existing, action, error);
        }
        const patch = managedActionPatch(result?.recordPatch);
        if (result?.ok === false) {
          const message = sanitizeSecretText(result?.message || "Managed MCP action failed.");
          nextRecord = mergeManagedActionRecord(existing, patch, {
            enabled: false,
            connectionWizard: managedActionFailureWizard(existing, action, message, patch.connectionWizard),
          });
          const finalRecord = await persistManagedActionResult(current, existing, nextRecord);
          return failWithData(message, publicRecord(finalRecord));
        }
        nextRecord = mergeManagedActionRecord(existing, patch, {
          connectionWizard: nextManagedWizard(action, result),
          enabled: false,
          lastError: ""
        });
      } else {
        let patch = {};
        try {
          result = await managedSupervisor.runAction(existing, action, values || {});
        } catch (error) {
          return await persistManagedActionError(current, existing, action, error);
        }
        patch = managedActionPatch(result?.recordPatch);
        if (result?.ok === false) {
          const message = sanitizeSecretText(result?.message || "Managed MCP action failed.");
          nextRecord = mergeManagedActionRecord(existing, patch, {
            enabled: false,
            connectionWizard: managedActionFailureWizard(existing, action, message, patch.connectionWizard),
            lastError: message
          });
          const finalRecord = await persistManagedActionResult(current, existing, nextRecord);
          return failWithData(message, publicRecord(finalRecord));
        }
        const workingRecord = mergeManagedActionRecord(existing, patch, {
          enabled: false
        });
        const tested = await testServer(workingRecord);
        if (!tested.success) throw new Error(tested.error || "MCP connection test failed.");
        nextRecord = mergeManagedActionRecord(workingRecord, {}, {
          status: tested.data.status,
          lastTestStatus: tested.data.lastTestStatus || tested.data.status,
          lastTestCode: tested.data.lastTestCode,
          diagnostics: tested.data.diagnostics,
          tools: tested.data.tools,
          lastCheckedAt: tested.data.lastCheckedAt,
          lastError: tested.data.lastError,
          enabled: tested.data.status === "connected",
          connectionWizard: nextManagedWizard(action, tested.data, tested.data.status),
          managedRuntime: workingRecord.managedRuntime
        });
      }

      const saved = saveRecords(current.map((record) => record.id === existing.id ? nextRecord : record));
      const runtime = await applyRuntimeChanges(current, saved, {
        availableIds: nextRecord.enabled ? new Set() : new Set([nextRecord.id]),
        availableMessage: nextRecord.enabled ? "" : "Waiting for managed MCP setup in Mia."
      });
      return ok(publicRecord(resolveRecord(runtime.records, nextRecord.id) || nextRecord));
    } catch (error) {
      return fail(error);
    }
  }

  async function refreshBridge() {
    try {
      const state = await refreshBridgeState(loadRecords());
      if (Array.isArray(state?.records)) saveRecords(state.records);
      return ok(publicBridgeState(state));
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
    return enabledCoreMcpRecords(loadRecords()).filter((record) => isManagedExposureReady(record));
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
    runManagedAction,
    save,
    setEnabled,
    sync,
    test: testServer,
    testConnection: testServer,
    update: save
  };
}

module.exports = { createCoreMcpService };
