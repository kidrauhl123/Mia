const { BrowserWindow, Menu } = require("electron");
const { IpcChannel } = require("../../shared/ipc-channels");

function registerWindowIpc({ ipcMain, startupTimer, runtimeLifecycle }) {
  ipcMain.on(IpcChannel.UiFirstPaint, () => {
    startupTimer.mark("renderer:first-paint");
    runtimeLifecycle().scheduleBackgroundStartup();
  });

  ipcMain.handle(IpcChannel.WindowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(IpcChannel.WindowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(IpcChannel.WindowGreen, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    w.setFullScreen(!w.isFullScreen());
  });
  ipcMain.handle(IpcChannel.WindowState, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return { focused: true, fullscreen: false };
    return { focused: w.isFocused(), fullscreen: w.isFullScreen() };
  });
  ipcMain.handle(IpcChannel.EditContextMenu, (event, point = {}) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    Menu.buildFromTemplate([
      { label: "剪切", role: "cut" },
      { label: "复制", role: "copy" },
      { label: "粘贴", role: "paste" }
    ]).popup({
      window: w,
      x: Number.isFinite(point.x) ? Math.round(point.x) : undefined,
      y: Number.isFinite(point.y) ? Math.round(point.y) : undefined
    });
  });
}

module.exports = { registerWindowIpc };
