(function attachMcpContracts(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaMcpContracts = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildMcpContracts() {
  const MCP_TRANSPORTS = Object.freeze(["stdio", "http", "sse", "streamable_http"]);
  const MCP_ENGINE_IDS = Object.freeze(["hermes", "claude-code", "codex"]);
  const MCP_CONNECTION_STATUSES = Object.freeze(["unknown", "connected", "disconnected", "unsupported", "auth_required"]);
  const MCP_SYNC_STATUSES = Object.freeze(["pending", "synced", "available", "unsupported", "error"]);
  const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|bearer|cookie|session)/i;

  return Object.freeze({
    MCP_TRANSPORTS,
    MCP_ENGINE_IDS,
    MCP_CONNECTION_STATUSES,
    MCP_SYNC_STATUSES,
    SENSITIVE_KEY_PATTERN
  });
});
