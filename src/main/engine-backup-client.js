"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

function cancelledError() {
  const error = new Error("Engine backup download cancelled.");
  error.code = "MIA_ENGINE_INSTALL_CANCELLED";
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

function isChildPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeArchivePath(value = "") {
  const name = String(value || "").replace(/\\/g, "/");
  if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "";
  const parts = name.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return "";
  return parts.join("/");
}

function validateArchiveEntries(zip) {
  for (const entry of zip.getEntries()) {
    const safeName = safeArchivePath(entry.entryName);
    if (!safeName) throw new Error(`Engine backup contains an unsafe path: ${entry.entryName}`);
    const unixMode = (Number(entry.header?.attr || 0) >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new Error(`Engine backup must not contain symbolic links: ${entry.entryName}`);
    }
  }
}

function validateEntry(manifest, engineId, targetKey, expected = {}) {
  if (Number(manifest?.schemaVersion) !== 1) {
    throw new Error("Mia engine backup manifest schema is not supported.");
  }
  const engine = manifest?.engines?.[engineId];
  if (!engine || typeof engine !== "object") {
    throw new Error(`Mia engine backup manifest has no ${engineId} entry.`);
  }
  if (expected.version && String(engine.version || "") !== String(expected.version)) {
    throw new Error(`${engineId} backup version mismatch: expected ${expected.version}, received ${engine.version || "missing"}.`);
  }
  if (expected.runtimeVersion && String(engine.runtimeVersion || "") !== String(expected.runtimeVersion)) {
    throw new Error(`${engineId} backup runtime version mismatch: expected ${expected.runtimeVersion}, received ${engine.runtimeVersion || "missing"}.`);
  }
  const target = engine.targets?.[targetKey];
  if (!target || typeof target !== "object") {
    throw new Error(`Mia engine backup does not support ${engineId} on ${targetKey}.`);
  }
  const url = String(target.url || "").trim();
  const sha256 = String(target.sha256 || "").trim().toLowerCase();
  const archiveRoot = safeArchivePath(target.archiveRoot || "");
  if (!url || !/^[a-f0-9]{64}$/.test(sha256) || !archiveRoot) {
    throw new Error(`Mia engine backup entry is incomplete for ${engineId} on ${targetKey}.`);
  }
  return {
    engineId,
    targetKey,
    version: String(engine.version || ""),
    runtimeVersion: String(engine.runtimeVersion || ""),
    url,
    sha256,
    archiveRoot,
    bytes: Number(target.bytes || 0)
  };
}

function sourceStream(body) {
  if (!body) throw new Error("Engine backup response has no body.");
  if (typeof Readable.fromWeb === "function" && typeof body.getReader === "function") {
    return Readable.fromWeb(body);
  }
  return Readable.from(body);
}

function createEngineBackupClient(deps = {}) {
  const fsImpl = deps.fs || fs;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const Zip = deps.AdmZip || require("adm-zip");
  const manifestUrl = String(deps.manifestUrl || "").trim();
  const allowInsecure = deps.allowInsecure === true;

  if (typeof fetchImpl !== "function") throw new Error("fetch is required for engine backup downloads.");
  if (!manifestUrl) throw new Error("Mia engine backup manifest URL is not configured.");

  function assertRemoteUrl(value, label) {
    const parsed = new URL(value);
    if (!allowInsecure && parsed.protocol !== "https:") {
      throw new Error(`${label} must use HTTPS.`);
    }
    return parsed.href;
  }

  async function fetchManifest(signal) {
    throwIfCancelled(signal);
    const response = await fetchImpl(assertRemoteUrl(manifestUrl, "Engine backup manifest URL"), {
      signal,
      cache: "no-store"
    });
    if (!response?.ok) throw new Error(`Unable to download Mia engine backup manifest (HTTP ${response?.status || "unknown"}).`);
    return response.json();
  }

  async function download(entry, archivePath, options = {}) {
    throwIfCancelled(options.signal);
    const response = await fetchImpl(assertRemoteUrl(entry.url, "Engine backup URL"), {
      signal: options.signal,
      cache: "no-store"
    });
    if (!response?.ok) throw new Error(`Unable to download ${entry.engineId} backup (HTTP ${response?.status || "unknown"}).`);
    const headerBytes = Number(response.headers?.get?.("content-length") || 0);
    const totalBytes = headerBytes || entry.bytes || 0;
    const hash = crypto.createHash("sha256");
    let downloadedBytes = 0;
    let lastPercent = -1;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        if (options.signal?.aborted) return callback(cancelledError());
        hash.update(chunk);
        downloadedBytes += chunk.length;
        const percent = totalBytes ? Math.min(65, 5 + Math.floor((downloadedBytes / totalBytes) * 60)) : 25;
        if (percent !== lastPercent) {
          lastPercent = percent;
          options.onProgress?.({ stage: "download", percent, downloadedBytes, totalBytes });
        }
        callback(null, chunk);
      }
    });
    await pipeline(sourceStream(response.body), meter, fsImpl.createWriteStream(archivePath));
    const actual = hash.digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(`${entry.engineId} backup checksum mismatch.`);
    }
  }

  async function install(options = {}) {
    const {
      engineId,
      targetKey,
      destination,
      expectedVersion,
      expectedRuntimeVersion,
      signal,
      validate,
      prepare,
      onProgress
    } = options;
    if (!engineId || !targetKey || !destination || typeof validate !== "function") {
      throw new Error("Engine backup install requires engineId, targetKey, destination, and validate.");
    }
    const manifest = await fetchManifest(signal);
    const entry = validateEntry(manifest, engineId, targetKey, {
      version: expectedVersion,
      runtimeVersion: expectedRuntimeVersion
    });
    const parent = path.dirname(destination);
    fsImpl.mkdirSync(parent, { recursive: true });
    const workDir = fsImpl.mkdtempSync(path.join(parent, `.mia-${engineId}-`));
    const archivePath = path.join(workDir, "backup.zip");
    const extractDir = path.join(workDir, "extracted");
    const previous = path.join(parent, `.${path.basename(destination)}.previous-${process.pid}-${Date.now()}`);
    let movedPrevious = false;
    try {
      onProgress?.({ stage: "manifest", percent: 3 });
      await download(entry, archivePath, { signal, onProgress });
      throwIfCancelled(signal);
      onProgress?.({ stage: "extract", percent: 70 });
      const zip = new Zip(archivePath);
      validateArchiveEntries(zip);
      fsImpl.mkdirSync(extractDir, { recursive: true });
      zip.extractAllTo(extractDir, true);
      const extractedRoot = path.resolve(extractDir, ...entry.archiveRoot.split("/"));
      if (!isChildPath(extractDir, extractedRoot) || !fsImpl.existsSync(extractedRoot)) {
        throw new Error(`${engineId} backup archive root is missing: ${entry.archiveRoot}.`);
      }
      await prepare?.(extractedRoot);
      onProgress?.({ stage: "verify", percent: 85 });
      await validate(extractedRoot);
      throwIfCancelled(signal);
      if (fsImpl.existsSync(destination)) {
        fsImpl.renameSync(destination, previous);
        movedPrevious = true;
      }
      try {
        fsImpl.renameSync(extractedRoot, destination);
      } catch (error) {
        if (movedPrevious && !fsImpl.existsSync(destination)) fsImpl.renameSync(previous, destination);
        throw error;
      }
      if (movedPrevious) fsImpl.rmSync(previous, { recursive: true, force: true });
      onProgress?.({ stage: "installed", percent: 92 });
      return entry;
    } finally {
      if (movedPrevious && fsImpl.existsSync(previous) && !fsImpl.existsSync(destination)) {
        try { fsImpl.renameSync(previous, destination); } catch { /* best effort rollback */ }
      }
      try { fsImpl.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
    }
  }

  return { fetchManifest, install };
}

module.exports = {
  createEngineBackupClient,
  safeArchivePath,
  validateArchiveEntries,
  validateEntry
};
