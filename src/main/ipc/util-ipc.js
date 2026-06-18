const { IpcChannel } = require("../../shared/ipc-channels");

function registerUtilIpc({ ipcMain, openLocalFile }) {
  if (!ipcMain) throw new Error("ipcMain dependency is required.");
  if (typeof openLocalFile !== "function") {
    throw new Error("openLocalFile dependency is required.");
  }

  ipcMain.handle(IpcChannel.UtilOpenLocalFile, (_event, target) => openLocalFile(target));
}

module.exports = { registerUtilIpc };
