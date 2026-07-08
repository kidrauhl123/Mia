const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("MCP IPC channels remain available while preload routes through Core HTTP", () => {
  const channels = read("src/shared/ipc-channels.js");
  assert.match(channels, /McpList:\s*"mcp:list"/);
  assert.match(channels, /McpSave:\s*"mcp:save"/);
  assert.match(channels, /McpSetEnabled:\s*"mcp:set-enabled"/);
  assert.match(channels, /McpRefreshBridge:\s*"mcp:refresh-bridge"/);
  assert.match(channels, /McpRemoveFromAgents:\s*"mcp:remove-from-agents"/);
  assert.match(channels, /McpRunManagedAction:\s*"mcp:run-managed-action"/);

  const preload = read("src/preload.js");
  assert.match(preload, /mcp:\s*\{/);
  assert.match(preload, /list:\s*\(\)\s*=>\s*mcpCoreOk\(miaCoreGet\("\/api\/mcp\/servers"\)\)/);
  assert.match(preload, /setEnabled:\s*\(id,\s*enabled\)\s*=>\s*mcpCoreOk\(miaCorePatch\(`\/api\/mcp\/servers\/\$\{encodeURIComponent\(id\)\}`,\s*\{\s*enabled:\s*Boolean\(enabled\)\s*\}\)\)/);
  assert.match(preload, /refreshBridge:\s*\(\)\s*=>\s*mcpCoreOk\(miaCorePost\("\/api\/mcp\/bridge\/refresh",\s*\{\}\)\)/);
  assert.match(preload, /removeFromAgents:\s*\(recordsOrIds\)\s*=>\s*mcpCoreOk\(miaCorePost\("\/api\/mcp\/agent-configs\/remove",\s*\{\s*recordsOrIds\s*\}\)\)/);
  assert.match(preload, /runManagedAction:\s*\(id,\s*action,\s*values\)\s*=>\s*mcpCoreOk\(miaCorePost\(`\/api\/mcp\/servers\/\$\{encodeURIComponent\(id\)\}\/managed-actions\/\$\{encodeURIComponent\(action\)\}`,\s*values \|\| \{\}\)\)/);

  const ipc = read("src/main/ipc/mcp-ipc.js");
  assert.match(ipc, /registerMcpIpc/);
  assert.match(ipc, /IpcChannel\.McpList/);
  assert.match(ipc, /IpcChannel\.McpRemoveFromAgents/);
  assert.match(ipc, /IpcChannel\.McpRunManagedAction/);
  assert.match(ipc, /mcpService\.runManagedAction\(String\(id \|\| ""\),\s*String\(action \|\| ""\),\s*values \|\| \{\}\)/);
});

test("Electron main wires MCP through the Rust Core HTTP adapter", () => {
  const src = read("src/main.js");
  assert.match(src, /createMcpService\(\{\s*coreRequest:\s*forwardMiaCoreHttpRequest/);
  assert.doesNotMatch(src, /createManagedConnectorSupervisor/);
  assert.doesNotMatch(src, /createMcpSdkClientManager/);
  assert.doesNotMatch(src, /createCoreMcpOAuth/);
});

test("mcp ipc registers Core AION alignment methods", () => {
  const src = read("src/main/ipc/mcp-ipc.js");
  assert.match(src, /McpListTools/);
  assert.match(src, /McpAgentConfigs/);
  assert.match(src, /McpImportAgentConfig/);
  assert.match(src, /McpOauthCheckStatus/);
  assert.match(src, /McpOauthLogin/);
  assert.match(src, /McpOauthLogout/);
});

test("preload exposes oauth and discovery methods", () => {
  const src = read("src/preload.js");
  assert.match(src, /listTools:\s*\(\)\s*=>\s*mcpCoreOk\(miaCoreGet\("\/api\/mcp\/tools"\)\)/);
  assert.match(src, /getAgentConfigs:\s*\(\)\s*=>\s*mcpCoreOk\(miaCoreGet\("\/api\/mcp\/agent-configs"\)\)/);
  assert.match(src, /importAgentConfig:\s*\(input\)\s*=>\s*mcpCoreOk\(miaCorePost\("\/api\/mcp\/agent-configs\/import",\s*input \|\| \{\}\)\)/);
  assert.match(src, /oauth:\s*\{/);
  assert.match(src, /checkStatus:\s*\(input\)\s*=>\s*mcpCoreOk\(miaCoreGet\(`\/api\/mcp\/oauth\/\$\{encodeURIComponent\(mcpInputId\(input\)\)\}\/status`\)\)/);
  assert.match(src, /login:\s*\(input\)\s*=>\s*mcpCoreOk\(miaCorePost\(`\/api\/mcp\/oauth\/\$\{encodeURIComponent\(mcpInputId\(input\)\)\}\/login`,\s*input \|\| \{\}\)\)/);
  assert.match(src, /logout:\s*\(input\)\s*=>\s*mcpCoreOk\(miaCorePost\(`\/api\/mcp\/oauth\/\$\{encodeURIComponent\(mcpInputId\(input\)\)\}\/logout`,\s*\{\}\)\)/);
});
