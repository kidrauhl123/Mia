const { BrowserWindow, Menu, Notification } = require("electron");
const { IpcChannel } = require("../../shared/ipc-channels");
const { onboardingWindowBounds } = require("../onboarding-window-bounds.js");
const { setMacNativeControlsVisible } = require("../mac-window-controls.js");

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

function compactNotificationText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function desktopNotificationPayload(input = {}) {
  const conversationId = compactNotificationText(input.conversationId, 160);
  const messageId = compactNotificationText(input.messageId, 160);
  return {
    title: compactNotificationText(input.title || "Mia", 100) || "Mia",
    body: compactNotificationText(input.body || "新消息", 178) || "新消息",
    conversationId,
    messageId,
    silent: input.silent === true
  };
}

function restoreWindowForNotification(w) {
  if (!w || w.isDestroyed?.()) return;
  if (typeof w.isMinimized === "function" && w.isMinimized()) w.restore();
  w.show();
  w.focus();
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
    // Main app uses the native macOS traffic lights. Renderer-drawn controls are
    // only a fallback for non-mac shells and web/mock surfaces.
    if (typeof w.setBackgroundColor === "function") {
      w.setBackgroundColor(process.platform === "darwin" ? "#00000000" : "#f0f0f3");
    }
    setMacNativeControlsVisible(w, true);
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
    if (typeof w.setBackgroundColor === "function") {
      w.setBackgroundColor(process.platform === "darwin" ? "#00000000" : "#ffffff");
    }
    setMacNativeControlsVisible(w, true);
  });
  ipcMain.handle(IpcChannel.WindowNativeControlsVisible, (event, visible) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    setMacNativeControlsVisible(w, visible);
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
  ipcMain.handle(IpcChannel.DesktopNotificationShow, (event, input = {}) => {
    const supported = typeof Notification?.isSupported === "function" ? Notification.isSupported() : typeof Notification === "function";
    if (!supported) return { ok: false, reason: "unsupported" };
    const w = BrowserWindow.fromWebContents(event.sender);
    const payload = desktopNotificationPayload(input);
    try {
      const notification = new Notification({
        title: payload.title,
        body: payload.body,
        silent: payload.silent
      });
      notification.once("click", () => {
        restoreWindowForNotification(w);
        if (!w || w.isDestroyed?.()) return;
        w.webContents?.send(IpcChannel.DesktopNotificationClick, {
          conversationId: payload.conversationId,
          messageId: payload.messageId
        });
      });
      notification.show();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error?.message || "show_failed" };
    }
  });
}

module.exports = { registerWindowIpc, desktopNotificationPayload };
