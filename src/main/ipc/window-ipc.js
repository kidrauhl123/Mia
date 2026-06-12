const { BrowserWindow, Menu } = require("electron");
const { IpcChannel } = require("../../shared/ipc-channels");
const { onboardingWindowBounds } = require("../onboarding-window-bounds.js");

function windowState(w) {
  if (!w) return { focused: true, fullscreen: false, maximized: false };
  return {
    focused: w.isFocused(),
    fullscreen: w.isFullScreen(),
    maximized: Boolean(w.isMaximized?.())
  };
}

function toggleMaximized(w) {
  if (!w) return windowState(w);
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
  return windowState(w);
}

function registerWindowIpc({ ipcMain, startupTimer, runtimeLifecycle }) {
  ipcMain.on(IpcChannel.UiFirstPaint, (event) => {
    startupTimer.mark("renderer:first-paint");
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && typeof w.miaShowWhenReady === "function") w.miaShowWhenReady();
    if (w?.miaSkipAutomaticBackgroundStartup) return;
    runtimeLifecycle().scheduleBackgroundStartup();
  });

  ipcMain.handle(IpcChannel.WindowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(IpcChannel.WindowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(IpcChannel.WindowMaximize, (event) => {
    return toggleMaximized(BrowserWindow.fromWebContents(event.sender));
  });
  ipcMain.handle(IpcChannel.WindowGreen, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return windowState(w);
    if (process.platform !== "darwin") return toggleMaximized(w);
    w.setFullScreen(!w.isFullScreen());
    return windowState(w);
  });
  ipcMain.handle(IpcChannel.WindowShowMain, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    w.setMinimumSize(420, 560);
    w.setSize(1040, 700);
    w.center();
    // Main app paints its own grey chrome edge-to-edge and uses custom window
    // controls in the topbar, so hide the native traffic lights again.
    if (typeof w.setBackgroundColor === "function") w.setBackgroundColor("#f0f0f3");
    if (process.platform === "darwin" && typeof w.setWindowButtonVisibility === "function") {
      w.setWindowButtonVisibility(false);
    }
  });
  // Onboarding / agent-scan shows in a compact, narrow window. The renderer
  // drives this whenever it enters the setup guide, since the create-time
  // heuristic can't know the runtime agent-scan result.
  ipcMain.handle(IpcChannel.WindowOnboarding, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || w.isFullScreen()) return;
    w.setMinimumSize(onboardingWindowBounds.minWidth, onboardingWindowBounds.minHeight);
    w.setSize(onboardingWindowBounds.width, onboardingWindowBounds.height);
    w.center();
    // The onboarding view has no custom topbar controls, so it must read as a
    // real native window: white base (no grey band) + native traffic lights so
    // there's a close button. Reverted by window:show-main.
    if (typeof w.setBackgroundColor === "function") w.setBackgroundColor("#ffffff");
    if (process.platform === "darwin" && typeof w.setWindowButtonVisibility === "function") {
      w.setWindowButtonVisibility(true);
    }
  });
  ipcMain.handle(IpcChannel.WindowState, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    return windowState(w);
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
