const WINDOWS_TITLE_BAR_HEIGHT = 32;
const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = WINDOWS_TITLE_BAR_HEIGHT;
const WINDOWS_LIGHT_TITLE_BAR_COLOR = "#f2f4f7";
const WINDOWS_DARK_TITLE_BAR_COLOR = "#20232a";
const WINDOWS_LIGHT_SYMBOL_COLOR = "#24262d";
const WINDOWS_DARK_SYMBOL_COLOR = "#f2f4f8";

function windowsTitleBarOverlayForAppearance(appearance = {}) {
  const theme = appearance?.theme === "dark" ? "dark" : "light";
  return {
    color: theme === "dark" ? WINDOWS_DARK_TITLE_BAR_COLOR : WINDOWS_LIGHT_TITLE_BAR_COLOR,
    symbolColor: theme === "dark" ? WINDOWS_DARK_SYMBOL_COLOR : WINDOWS_LIGHT_SYMBOL_COLOR,
    height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT
  };
}

function applyWindowsTitleBarOverlay(win, appearance = {}) {
  if (process.platform !== "win32" || !win || win.isDestroyed?.()) return;
  const overlay = windowsTitleBarOverlayForAppearance(appearance);
  if (typeof win.setBackgroundColor === "function") {
    try { win.setBackgroundColor(overlay.color); } catch { /* ignore unsupported background updates */ }
  }
}

module.exports = {
  WINDOWS_TITLE_BAR_HEIGHT,
  WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
  WINDOWS_LIGHT_TITLE_BAR_COLOR,
  WINDOWS_DARK_TITLE_BAR_COLOR,
  windowsTitleBarOverlayForAppearance,
  applyWindowsTitleBarOverlay
};
