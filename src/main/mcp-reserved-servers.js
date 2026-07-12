const RESERVED_MCP_SERVER_NAMES = new Set([
  "mia-app"
]);

function mergeMcpServersWithReservedBuiltIns({ userServers = {}, builtInServers = {} } = {}) {
  const merged = {};
  for (const [name, spec] of Object.entries(userServers || {})) {
    const serverName = String(name || "").trim();
    if (!serverName || RESERVED_MCP_SERVER_NAMES.has(serverName)) continue;
    merged[serverName] = spec;
  }
  for (const [name, spec] of Object.entries(builtInServers || {})) {
    const serverName = String(name || "").trim();
    if (!serverName || spec == null) continue;
    merged[serverName] = spec;
  }
  return merged;
}

module.exports = {
  RESERVED_MCP_SERVER_NAMES,
  mergeMcpServersWithReservedBuiltIns
};
