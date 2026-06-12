function setMacNativeControlsVisible(win, visible) {
  if (!win || process.platform !== "darwin") return;
  const show = Boolean(visible);
  if (typeof win.setWindowButtonVisibility === "function") {
    win.setWindowButtonVisibility(show);
  }
  if (typeof win.setWindowButtonPosition === "function") {
    try {
      win.setWindowButtonPosition(show ? null : { x: -120, y: -120 });
    } catch {
      // Older Electron builds may expose the method but reject null resets.
      if (!show) {
        try { win.setWindowButtonPosition({ x: -120, y: -120 }); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = { setMacNativeControlsVisible };
