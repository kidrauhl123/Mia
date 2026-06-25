"use strict";

const fsDefault = require("node:fs");
const path = require("node:path");
const {
  normalizeCoreMcpRecord,
  normalizeCoreMcpRegistry
} = require("./records.js");

function readJson(fsImpl, filePath, fallback) {
  try { return JSON.parse(fsImpl.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function atomicWriteJson(fsImpl, filePath, value) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsImpl.renameSync(tmp, filePath);
}

function createCoreMcpFileRegistry(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const fsImpl = deps.fs || fsDefault;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const idFactory = typeof deps.idFactory === "function" ? deps.idFactory : undefined;
  const normalizeOptions = () => ({ now, ...(idFactory ? { idFactory } : {}) });
  const pathForRecords = () => runtimePaths().mcpServers;

  function readAll() {
    return normalizeCoreMcpRegistry(readJson(fsImpl, pathForRecords(), []), normalizeOptions());
  }

  function writeAll(records) {
    const normalized = normalizeCoreMcpRegistry(records, normalizeOptions());
    atomicWriteJson(fsImpl, pathForRecords(), normalized);
    return normalized;
  }

  async function list(options = {}) {
    return readAll().filter((record) => options.includeDeleted === true || !record.deletedAt);
  }

  async function get(idOrName) {
    const needle = String(idOrName || "").trim();
    return readAll().find((record) => record.id === needle || record.name === needle) || null;
  }

  async function upsert(input = {}) {
    const current = readAll();
    const existing = input.id ? current.find((record) => record.id === input.id) : current.find((record) => record.name === String(input.name || "").trim());
    const record = normalizeCoreMcpRecord({ ...(existing || {}), ...(input || {}), id: input.id || existing?.id, createdAt: existing?.createdAt }, normalizeOptions());
    if (!record) throw new Error("MCP server record is invalid.");
    return writeAll(current.filter((item) => item.id !== record.id && item.name !== record.name).concat({ ...record, updatedAt: now() })).find((item) => item.id === record.id);
  }

  async function softDelete(idOrName) {
    const current = readAll();
    const existing = current.find((record) => record.id === idOrName || record.name === idOrName);
    if (!existing) throw new Error("MCP server not found.");
    const deletedAt = now();
    writeAll(current.map((record) => record.id === existing.id ? { ...record, enabled: false, deletedAt, updatedAt: deletedAt } : record));
    return { ...existing, enabled: false, deletedAt, updatedAt: deletedAt };
  }

  return { get, list, readAll, softDelete, upsert, writeAll };
}

module.exports = { createCoreMcpFileRegistry };
