"use strict";

const { normalizeCoreMcpRecord, sanitizeSecretText } = require("./records.js");

function mergeRecordPatch(record, patch, options = {}) {
  return normalizeCoreMcpRecord({
    ...record,
    ...(patch || {}),
    transport: patch?.transport || record.transport,
    managedRuntime: {
      ...(record.managedRuntime || {}),
      ...(patch?.managedRuntime || {})
    },
    connectionWizard: {
      ...(record.connectionWizard || {}),
      ...(patch?.connectionWizard || {})
    }
  }, options);
}

function createManagedConnectorSupervisor(deps = {}) {
  const connectors = {};
  const children = new Map();
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const idFactory = typeof deps.idFactory === "function" ? deps.idFactory : undefined;

  function connectorFor(record = {}) {
    const id = String(record.managedRuntime?.connectorId || "").trim();
    return connectors[id] || null;
  }

  async function status(record = {}) {
    const connector = connectorFor(record);
    if (!connector) {
      return {
        state: "unsupported",
        installed: false,
        running: false,
        endpoint: "",
        message: "Managed connector is not supported."
      };
    }
    const base = await connector.status(record);
    const running = children.has(record.id);
    return { ...base, running, state: running ? "running" : base.state };
  }

  async function runAction(record = {}, action = "", values = {}) {
    const connector = connectorFor(record);
    if (!connector) throw new Error("Managed connector is not supported.");
    if (action === "stop") return stop(record.id);
    if (action === "start" && children.has(record.id)) {
      return {
        ok: true,
        state: "running",
        message: "Managed connector is already running.",
        recordPatch: {
          managedRuntime: {
            ...(record.managedRuntime || {}),
            state: "running",
            lastAction: "start"
          }
        }
      };
    }
    let result;
    try {
      result = await connector.runAction(record, action, values);
    } catch (error) {
      throw new Error(sanitizeSecretText(error?.message || error));
    }
    if (result.child && action === "start") {
      children.set(record.id, result.child);
      result.child.once?.("exit", () => children.delete(record.id));
    }
    return {
      ok: result.ok === true,
      state: String(result.state || ""),
      message: sanitizeSecretText(result.message || ""),
      recordPatch: result.recordPatch || {}
    };
  }

  async function ensureRunning(records = []) {
    const nextRecords = [];
    const errors = [];
    for (const record of records) {
      if (record.managementMode !== "managed" || record.enabled === false) {
        nextRecords.push(record);
        continue;
      }
      try {
        const current = await status(record);
        if (current.running) {
          nextRecords.push(record);
          continue;
        }
        const started = await runAction(record, "start", {});
        nextRecords.push(mergeRecordPatch(record, started.recordPatch, { now, idFactory }));
      } catch (error) {
        errors.push({ id: record.id, name: record.name, message: sanitizeSecretText(error?.message || error) });
        nextRecords.push(mergeRecordPatch(record, {
          managedRuntime: { ...(record.managedRuntime || {}), state: "error", lastAction: "start" },
          connectionWizard: { state: "managed_error", nextAction: "start", message: error?.message || "Managed connector failed to start." }
        }, { now, idFactory }));
      }
    }
    return { records: nextRecords, errors };
  }

  async function stop(recordId) {
    const child = children.get(recordId);
    if (!child) {
      return {
        ok: true,
        state: "stopped",
        message: "Managed connector was not running.",
        recordPatch: { managedRuntime: { state: "stopped", lastAction: "stop" } }
      };
    }
    child.kill?.();
    children.delete(recordId);
    return {
      ok: true,
      state: "stopped",
      message: "Managed connector stopped.",
      recordPatch: { managedRuntime: { state: "stopped", lastAction: "stop" } }
    };
  }

  return { status, runAction, ensureRunning, stop };
}

module.exports = {
  createManagedConnectorSupervisor,
  mergeRecordPatch
};
