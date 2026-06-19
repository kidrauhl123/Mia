"use strict";

const { IpcChannel } = require("../../shared/ipc-channels.js");

function registerMcpIpc({ ipcMain, mcpService }) {
  if (!ipcMain) throw new Error("ipcMain dependency is required.");
  if (!mcpService) throw new Error("mcpService dependency is required.");

  ipcMain.handle(IpcChannel.McpList, () => mcpService.list());
  ipcMain.handle(IpcChannel.McpSave, (_event, input) => mcpService.save(input || {}));
  ipcMain.handle(IpcChannel.McpDelete, (_event, id) => mcpService.delete(String(id || "")));
  ipcMain.handle(IpcChannel.McpSetEnabled, (_event, id, enabled) => mcpService.setEnabled(String(id || ""), enabled === true));
  ipcMain.handle(IpcChannel.McpTest, (_event, input) => mcpService.test(input));
  ipcMain.handle(IpcChannel.McpImportJson, (_event, input, options) => mcpService.importJson(input, options || {}));
  ipcMain.handle(IpcChannel.McpFetchMarketplace, () => mcpService.fetchMarketplace());
  ipcMain.handle(IpcChannel.McpInstallTemplate, (_event, templateId, values) => mcpService.installTemplate(String(templateId || ""), values || {}));
  ipcMain.handle(IpcChannel.McpSync, () => mcpService.sync());
  ipcMain.handle(IpcChannel.McpRefreshBridge, () => mcpService.refreshBridge());
  ipcMain.handle(IpcChannel.McpRemoveFromAgents, (_event, recordsOrIds) => mcpService.removeFromAgents(recordsOrIds));
}

module.exports = { registerMcpIpc };
