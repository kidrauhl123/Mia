"use strict";

const { cleanText, createMiaMemoryStore } = require("./mia-memory-store.js");
const { syncNativeMemoryFiles } = require("./mia-native-memory-bridge.js");

function cleanLine(value) {
  return cleanText(value);
}

const EXPLICIT_MEMORY_PATTERNS = Object.freeze([
  /^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i,
  /^(?:please\s+)?keep\s+in\s+mind(?:\s+that)?\s+(.+)$/i,
  /^(?:please\s+)?note(?:\s+that)?\s+(.+)$/i,
  /^(?:please\s+)?make\s+a\s+note(?:\s+that)?\s+(.+)$/i,
  /^(?:\u8bf7)?(?:\u5e2e\u6211)?\u8bb0\u4f4f[\s:：，,。；;]*(.+)$/u,
  /^(?:\u8bf7)?(?:\u5e2e\u6211)?\u8bb0\u4e00\u4e0b[\s:：，,。；;]*(.+)$/u,
  /^\u4f60\u8981\u8bb0(?:\u4f4f|\u5f97)[\s:：，,。；;]*(.+)$/u,
  /^\u4ee5\u540e(?:\u8bf7)?\u8bb0\u5f97[\s:：，,。；;]*(.+)$/u
]);

function normalizeExplicitMemoryText(value = "") {
  return cleanLine(value)
    .replace(/^[\s"'`“”‘’.,;:：，。；、-]+/u, "")
    .replace(/[\s"'`“”‘’.,;:：，。；、-]+$/u, "")
    .trim()
    .slice(0, 1000);
}

function explicitMemoryCommandsFromMessages(messages = []) {
  const commands = [];
  for (const message of messages) {
    const role = cleanLine(message?.role || "user").toLowerCase();
    if (role !== "user") continue;
    const content = cleanLine(message?.content || "");
    if (!content) continue;
    for (const rawLine of content.split(/\n+/g)) {
      const line = cleanLine(rawLine);
      if (!line) continue;
      for (const pattern of EXPLICIT_MEMORY_PATTERNS) {
        const match = line.match(pattern);
        const text = normalizeExplicitMemoryText(match?.[1] || "");
        if (text.length >= 3) {
          commands.push(text);
          break;
        }
      }
    }
  }
  return [...new Set(commands)];
}

function createMiaMemoryService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const store = createMiaMemoryStore(deps);
  const memoryProvider = deps.memoryProvider || null;

  function cleanLines(lines) {
    return (Array.isArray(lines) ? lines : []).map(cleanLine).filter(Boolean);
  }

  function setSharedMemory(lines) {
    store.replaceScopeLines({ scope: "user", lines: cleanLines(lines) });
  }

  function setBotMemory(botId, lines) {
    const key = cleanLine(botId) || "mia";
    store.replaceScopeLines({ scope: "bot", botId: key, lines: cleanLines(lines) });
  }

  function readStore(userId = "") {
    return store.readStore(userId);
  }

  function searchMemories(input = {}) {
    return store.searchMemories(input);
  }

  function comparableMemoryText(value = "") {
    return cleanLine(value).toLowerCase().replace(/\s+/g, " ");
  }

  function providerSearchMethod() {
    if (!memoryProvider || memoryProvider.isAvailable?.() === false) return null;
    if (typeof memoryProvider.searchMemories === "function") return memoryProvider.searchMemories.bind(memoryProvider);
    if (typeof memoryProvider.search === "function") return memoryProvider.search.bind(memoryProvider);
    return null;
  }

  async function searchMemoriesDeep(input = {}) {
    const localMemories = searchMemories(input);
    const query = cleanLine(input.query || input.q || "");
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 20)));
    const searchProvider = providerSearchMethod();
    if (!query || !searchProvider || localMemories.length >= safeLimit) {
      return localMemories.slice(0, safeLimit);
    }

    const userId = store.currentUserId(input.userId);
    const botId = cleanLine(input.botId || input.botKey || "mia") || "mia";
    const sessionId = cleanLine(input.sessionId || "default") || "default";
    let providerResult = null;
    try {
      providerResult = await searchProvider({
        query,
        userId,
        botId,
        sessionId,
        limit: safeLimit,
        scopes: input.scopes,
        status: input.status || "active"
      });
    } catch {
      return localMemories.slice(0, safeLimit);
    }

    const providerMemories = Array.isArray(providerResult?.memories) ? providerResult.memories : [];
    if (!providerMemories.length) return localMemories.slice(0, safeLimit);

    const byId = new Map(localMemories.map((memory) => [memory.id, memory]));
    for (const providerMemory of providerMemories) {
      if (byId.size >= safeLimit) break;
      const text = cleanLine(providerMemory?.text || providerMemory?.memory || providerMemory?.content || "");
      const comparable = comparableMemoryText(text);
      if (!comparable) continue;
      const candidates = store.searchMemories({
        ...input,
        userId,
        botId,
        sessionId,
        status: input.status || "active",
        query: text,
        limit: Math.max(10, safeLimit)
      });
      const match = candidates.find((memory) => comparableMemoryText(memory?.text || "") === comparable);
      if (match && !byId.has(match.id)) byId.set(match.id, match);
    }

    return [...byId.values()].slice(0, safeLimit);
  }

  function rememberMemory(input = {}) {
    return store.rememberMemory(input);
  }

  function updateMemory(input = {}) {
    return store.updateMemory(input);
  }

  function forgetMemory(input = {}) {
    return store.forgetMemory(input);
  }

  function listMemories(input = {}) {
    return store.listMemories(input);
  }

  function listAllMemories(input = {}) {
    return store.listAllMemories(input);
  }

  function listSyncMemories(input = {}) {
    return store.listSyncMemories(input);
  }

  function applySyncedMemories(entries = [], input = {}) {
    return store.applySyncedMemories(entries, input);
  }

  function deleteMemory(input = {}) {
    return store.deleteMemory(input);
  }

  function syncNativeMemoryFilesForScope(input = {}) {
    return syncNativeMemoryFiles({
      ...input,
      runtimePaths,
      memoryService: {
        listMemories: store.listMemories
      },
      userId: store.currentUserId(input.userId)
    });
  }

  function normalizeProviderMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
      .map((message) => {
        const role = cleanLine(message?.role || "user") || "user";
        const content = cleanLine(message?.content || message?.text || "");
        return content ? { role, content } : null;
      })
      .filter(Boolean);
  }

  async function extractMemoriesFromMessages(input = {}) {
    const userId = store.currentUserId(input.userId);
    const botId = cleanLine(input.botId || input.botKey || "mia") || "mia";
    const sessionId = cleanLine(input.sessionId || "default") || "default";
    const scope = cleanLine(input.scope || "bot") || "bot";
    const messages = normalizeProviderMessages(input.messages);
    if (!messages.length) return { status: "skipped", provider: memoryProvider?.name || "none", memories: [] };

    if (!memoryProvider || typeof memoryProvider.addMessages !== "function" || memoryProvider.isAvailable?.() === false) {
      const explicitMemories = explicitMemoryCommandsFromMessages(messages).map((text) => rememberMemory({
        userId,
        botId,
        sessionId,
        scope,
        text,
        confidence: 0.95,
        source: "explicit_memory_command",
        originEngine: input.originEngine,
        sourceMessageIds: input.sourceMessageIds,
        linkedMemoryIds: input.linkedMemoryIds,
        metadata: {
          source: "explicit_command",
          extractor: "mia-local-explicit-v1"
        }
      }));
      if (explicitMemories.length) {
        return {
          status: "ok",
          provider: "local-explicit",
          memories: explicitMemories,
          raw: null
        };
      }
      return { status: "disabled", provider: memoryProvider?.name || "none", memories: [] };
    }

    const providerResult = await memoryProvider.addMessages({
      messages,
      userId,
      botId,
      sessionId,
      metadata: {
        source: "mia",
        scope,
        originEngine: cleanLine(input.originEngine || ""),
        ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {})
      }
    });
    const providerMemories = Array.isArray(providerResult?.memories) ? providerResult.memories : [];
    const memories = [];
    for (const item of providerMemories) {
      const text = cleanLine(item?.text || item?.memory || "");
      if (!text) continue;
      memories.push(rememberMemory({
        userId,
        botId,
        sessionId,
        scope,
        text,
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : 0.8,
        source: `provider:${memoryProvider.name || "external"}`,
        originEngine: input.originEngine,
        sourceMessageIds: input.sourceMessageIds,
        linkedMemoryIds: input.linkedMemoryIds || item?.linkedMemoryIds || item?.linked_memory_ids,
        metadata: {
          source: "provider",
          provider: memoryProvider.name || "external",
          providerMemoryId: item?.id || "",
          providerEvent: item?.event || "",
          providerMetadata: item?.metadata || {}
        }
      }));
    }
    return {
      status: "ok",
      provider: memoryProvider.name || "provider",
      memories,
      raw: providerResult?.raw || null
    };
  }

  return {
    applySyncedMemories,
    close: store.close,
    currentUserId: store.currentUserId,
    deleteMemory,
    extractMemoriesFromMessages,
    forgetMemory,
    listAllMemories,
    listMemories,
    listSyncMemories,
    readStore,
    rememberMemory,
    searchMemoriesDeep,
    searchMemories,
    setBotMemory,
    setSharedMemory,
    syncNativeMemoryFiles: syncNativeMemoryFilesForScope,
    updateMemory
  };
}

module.exports = {
  cleanLine,
  createMiaMemoryService
};
