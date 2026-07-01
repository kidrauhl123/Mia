"use strict";

function cleanText(value = "") {
  return String(value || "").replace(/\r/g, "").trim();
}

function cleanId(value = "") {
  return String(value || "").trim();
}

function normalizeHost(value = "") {
  const host = cleanText(value).replace(/\/+$/, "");
  return host || "";
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role = cleanText(message?.role || "user") || "user";
      const content = cleanText(message?.content || message?.text || "");
      if (!content) return null;
      return { role, content };
    })
    .filter(Boolean);
}

function normalizeProviderMemory(item = {}) {
  if (!item || typeof item !== "object") return null;
  const text = cleanText(item.memory || item.text || item.content || item.value || "");
  if (!text) return null;
  const confidence = Number(item.confidence ?? item.score ?? item.metadata?.confidence ?? 0.8);
  return {
    id: cleanId(item.id || item.memoryId || item.memory_id),
    text,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.8,
    event: cleanText(item.event || item.metadata?.event || ""),
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {}
  };
}

function normalizeProviderResult(result) {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray(result?.results)
      ? result.results
      : Array.isArray(result?.memories)
        ? result.memories
        : [];
  return rows
    .map(normalizeProviderMemory)
    .filter(Boolean)
    .filter((item) => !["NONE", "NOOP", "DELETE"].includes(String(item.event || "").toUpperCase()));
}

function disabledProvider(reason = "disabled") {
  const skipped = async () => ({ memories: [], raw: null, skipped: true, reason });
  return {
    name: "none",
    isAvailable: () => false,
    disabledReason: reason,
    initialize: async () => ({ ok: true, provider: "none", available: false, reason }),
    addMessages: skipped,
    prefetch: skipped,
    search: skipped,
    searchMemories: skipped,
    sync: skipped,
    write: skipped,
    update: skipped,
    archive: skipped,
    shutdown: async () => ({ ok: true })
  };
}

function createMem0HttpMemoryProvider(options = {}) {
  const env = options.env || process.env || {};
  const host = normalizeHost(options.host || env.MIA_MEMORY_MEM0_HOST || env.MEM0_HOST || "https://api.mem0.ai");
  const apiKey = cleanText(options.apiKey || env.MIA_MEMORY_MEM0_API_KEY || env.MEM0_API_KEY || "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(1000, Math.min(120000, Number(options.timeoutMs || env.MIA_MEMORY_PROVIDER_TIMEOUT_MS || 60000)));

  function isAvailable() {
    return Boolean(host && apiKey && typeof fetchImpl === "function");
  }

  function headers(extra = {}) {
    return {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
      ...extra
    };
  }

  async function request(path, body) {
    if (!isAvailable()) throw new Error("Mem0 provider is not configured.");
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(`${host}${path}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body || {}),
        signal: controller?.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Mem0 provider request failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`);
      }
      return await response.json();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function addMessages(input = {}) {
    const messages = normalizeMessages(input.messages);
    if (!messages.length) return { memories: [], raw: null };
    const payload = {
      messages,
      user_id: cleanId(input.userId),
      agent_id: cleanId(input.botId),
      run_id: cleanId(input.sessionId),
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
    };
    const raw = await request("/v3/memories/add/", payload);
    return { memories: normalizeProviderResult(raw), raw };
  }

  async function write(input = {}) {
    const messages = Array.isArray(input.messages) && input.messages.length
      ? input.messages
      : (input.text ? [{ role: "user", content: input.text }] : []);
    return addMessages({ ...input, messages });
  }

  async function search(input = {}) {
    const query = cleanText(input.query);
    if (!query) return { memories: [], raw: null };
    const raw = await request("/v3/memories/search/", {
      query,
      output_format: "v1.1",
      filters: {
        user_id: cleanId(input.userId),
        agent_id: cleanId(input.botId),
        run_id: cleanId(input.sessionId)
      }
    });
    return { memories: normalizeProviderResult(raw), raw };
  }

  async function unsupportedMutation(action) {
    return {
      memories: [],
      raw: null,
      skipped: true,
      reason: `Mem0-compatible provider does not expose ${action} through this adapter.`
    };
  }

  return {
    name: "mem0-http",
    isAvailable,
    initialize: async () => ({ ok: true, provider: "mem0-http", available: isAvailable() }),
    addMessages,
    prefetch: search,
    search,
    searchMemories: search,
    sync: addMessages,
    write,
    update: () => unsupportedMutation("update"),
    archive: () => unsupportedMutation("archive"),
    shutdown: async () => ({ ok: true })
  };
}

function createMiaMemoryProvider(options = {}) {
  const env = options.env || process.env || {};
  const provider = cleanText(options.provider || env.MIA_MEMORY_PROVIDER || "").toLowerCase();
  if (!provider || provider === "none" || provider === "disabled") return disabledProvider("disabled");
  if (provider === "mem0" || provider === "mem0-http" || provider === "mem0-compatible") {
    return createMem0HttpMemoryProvider(options);
  }
  return disabledProvider(`unsupported provider: ${provider}`);
}

module.exports = {
  createMem0HttpMemoryProvider,
  createMiaMemoryProvider,
  normalizeProviderResult
};
