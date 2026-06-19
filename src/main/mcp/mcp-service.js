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
  return { success: false, data: null, error: String(error?.message || error || "Unknown error") };
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

  let bridgeInfo = null;

  function recordsPath() {
    return runtimePaths().mcpServers;
  }

  function loadRecords() {
    return normalizeMcpRegistry(readJson(fsImpl, recordsPath(), []), { now, idFactory });
  }

  function saveRecords(records) {
    const normalized = normalizeMcpRegistry(records, { now, idFactory });
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
    const statuses = nativeResult?.statuses && typeof nativeResult.statuses === "object"
      ? nativeResult.statuses
      : {};
    const nativeCommands = Array.isArray(nativeResult?.commands) ? nativeResult.commands : [];
    const sawNativeCommandsOrErrors = hasNativeCommandsOrErrors(statuses, nativeCommands);
    return records.map((record) => {
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
      errors: Array.isArray(refreshed?.errors) ? refreshed.errors : [],
      bridge: maskedBridgeInfo(bridgeInfo)
    };
  }

  async function applyRuntimeChanges(previousRecords, currentRecords, options = {}) {
    const storedRecords = normalizeMcpRegistry(options.persistedRecords || currentRecords, { now, idFactory });
    const bridgeState = await refreshBridgeState(storedRecords);
    const nativeResult = await nativeSync({
      previousRecords: normalizeMcpRegistry(previousRecords || [], { now, idFactory }),
      currentRecords: normalizeMcpRegistry(currentRecords || [], { now, idFactory })
    });
    const withStatuses = applyStatuses(storedRecords, nativeResult, {
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
    const merged = normalizeMcpRecord({
      ...(existing || {}),
      ...(input || {}),
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
      saveRecords(next);
      const runtime = await applyRuntimeChanges(current, next);
      return ok({ servers: publicServers(runtime.records), fingerprint: currentFingerprint(runtime.records) });
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

  async function importJson(input) {
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
      const next = current.filter((record) => !names.has(record.name)).concat(imported);
      const saved = saveRecords(next);
      return ok({ servers: publicServers(saved), imported: imported.length, fingerprint: currentFingerprint(saved) });
    } catch (error) {
      return fail(error);
    }
  }

  async function fetchMarketplace() {
    return ok({
      templates: [
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
        }
      ]
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
    return enabledMcpRecords(loadRecords());
  }

  function fingerprint() {
    return currentFingerprint(loadRecords());
  }

  function getEngineSpecs(engineId, options = {}) {
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
