const { IpcChannel } = require("../../shared/ipc-channels");

function registerUtilIpc({ ipcMain, openLocalFile, revealLocalFile }) {
  if (!ipcMain) throw new Error("ipcMain dependency is required.");
  if (typeof openLocalFile !== "function") {
    throw new Error("openLocalFile dependency is required.");
  }
  if (typeof revealLocalFile !== "function") {
    throw new Error("revealLocalFile dependency is required.");
  }

  ipcMain.handle(IpcChannel.UtilOpenLocalFile, (_event, target) => openLocalFile(target));
  ipcMain.handle(IpcChannel.UtilRevealLocalFile, (_event, target) => revealLocalFile(target));
}

module.exports = { registerUtilIpc };
