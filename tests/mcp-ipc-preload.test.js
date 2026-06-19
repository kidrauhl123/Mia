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

  const preload = read("src/preload.js");
  assert.match(preload, /mcp:\s*\{/);
  assert.match(preload, /list:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpList\)/);
  assert.match(preload, /setEnabled:\s*\(id,\s*enabled\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpSetEnabled,\s*id,\s*enabled\)/);
  assert.match(preload, /refreshBridge:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpRefreshBridge\)/);
  assert.match(preload, /removeFromAgents:\s*\(recordsOrIds\)\s*=>\s*ipcRenderer\.invoke\(IpcChannel\.McpRemoveFromAgents,\s*recordsOrIds\)/);

  const ipc = read("src/main/ipc/mcp-ipc.js");
  assert.match(ipc, /registerMcpIpc/);
  assert.match(ipc, /IpcChannel\.McpList/);
  assert.match(ipc, /IpcChannel\.McpRemoveFromAgents/);
});
