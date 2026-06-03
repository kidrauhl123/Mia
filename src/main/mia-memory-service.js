const fs = require("node:fs");
const path = require("node:path");

const MIA_MEMORY_HEADER = "## Mia Fellow Memory";

function cleanLine(value) {
  return String(value || "")
    .replace(/## Mia Fellow Memory/g, "Mia Fellow Memory")
    .replace(/\r/g, "")
    .trim();
}

function createMiaMemoryService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => new Date().toISOString());
  const maxBlockChars = Number(deps.maxBlockChars || 6000);

  function memoryPath() {
    return runtimePaths().memory;
  }

  function readStore() {
    try {
      const store = JSON.parse(fsImpl.readFileSync(memoryPath(), "utf8"));
      return {
        shared: Array.isArray(store.shared) ? store.shared : [],
        fellows: store.fellows && typeof store.fellows === "object" ? store.fellows : {},
        updatedAt: store.updatedAt || ""
      };
    } catch {
      return { shared: [], fellows: {}, updatedAt: "" };
    }
  }

  function writeStore(store) {
    const filePath = memoryPath();
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  }

  function cleanLines(lines) {
    return (Array.isArray(lines) ? lines : []).map(cleanLine).filter(Boolean);
  }

  function setSharedMemory(lines) {
    const store = readStore();
    store.shared = cleanLines(lines);
    store.updatedAt = now();
    writeStore(store);
  }

  function setFellowMemory(fellowKey, lines) {
    const store = readStore();
    const key = cleanLine(fellowKey) || "mia";
    store.fellows[key] = cleanLines(lines);
    store.updatedAt = now();
    writeStore(store);
  }

  function memoryBlock({ fellowKey = "mia", sessionId = "default" } = {}) {
    const store = readStore();
    const key = cleanLine(fellowKey) || "mia";
    const shared = cleanLines(store.shared);
    const fellowLines = cleanLines(store.fellows?.[key]);
    if (!shared.length && !fellowLines.length) return "";

    const block = [
      MIA_MEMORY_HEADER,
      "source: mia",
      `fellow: ${key}`,
      `conversation: ${cleanLine(sessionId) || "default"}`,
      "",
      "### Shared User Memory",
      ...shared,
      "",
      "### Fellow Memory",
      ...fellowLines
    ].join("\n").trim();
    return block.slice(0, maxBlockChars);
  }

  return {
    memoryBlock,
    readStore,
    setFellowMemory,
    setSharedMemory
  };
}

module.exports = {
  MIA_MEMORY_HEADER,
  cleanLine,
  createMiaMemoryService
};
