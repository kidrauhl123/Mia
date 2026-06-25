const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("MCP IPC channels and preload bridge are wired", () => {
  const channels = read("src/shared/ipc-channels.js");
  assert.match(channels, /McpList:\s*"mcp:list"/);
  assert.match(channels, /McpSave:\s*"mcp:save"/);
  assert.match(channels, /McpSetEnabled:\s*"mcp:set-enabled"/);
  assert.match(channels, /McpRefreshBridge:\s*"mcp:refresh-bridge"/);
  assert.match(channels, /McpRemoveFromAgents:\s*"mcp:remove-from-agents"/);
  assert.match(channels, /McpRunManagedAction:\s*"mcp:run-managed-action"/);

  const preload = read("src/preload.js");
  assert.match(preload, /mcp:\s*\{/);
  assert.match(preload, /list:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpList\)/);
  assert.match(preload, /setEnabled:\s*\(id,\s*enabled\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpSetEnabled,\s*id,\s*enabled\)/);
  assert.match(preload, /refreshBridge:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpRefreshBridge\)/);
  assert.match(preload, /removeFromAgents:\s*\(recordsOrIds\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpRemoveFromAgents,\s*recordsOrIds\)/);
  assert.match(preload, /runManagedAction:\s*\(id,\s*action,\s*values\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpRunManagedAction,\s*id,\s*action,\s*values\)/);

  const ipc = read("src/main/ipc/mcp-ipc.js");
  assert.match(ipc, /registerMcpIpc/);
  assert.match(ipc, /IpcChannel\.McpList/);
  assert.match(ipc, /IpcChannel\.McpRemoveFromAgents/);
  assert.match(ipc, /IpcChannel\.McpRunManagedAction/);
  assert.match(ipc, /mcpService\.runManagedAction\(String\(id \|\| ""\),\s*String\(action \|\| ""\),\s*values \|\| \{\}\)/);
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
  assert.match(src, /listTools:\s*\(\)\s*=>/);
  assert.match(src, /getAgentConfigs:\s*\(\)\s*=>/);
  assert.match(src, /importAgentConfig:\s*\(input\)\s*=>/);
  assert.match(src, /oauth:\s*\{/);
  assert.match(src, /checkStatus:\s*\(input\)\s*=>/);
  assert.match(src, /login:\s*\(input\)\s*=>/);
  assert.match(src, /logout:\s*\(input\)\s*=>/);
});
