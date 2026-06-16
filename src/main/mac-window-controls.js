function setMacNativeControlsVisible(win, visible) {
  if (!win || process.platform !== "darwin") return;
  const show = Boolean(visible);
  const nativeTrafficLightPosition = { x: 12, y: 18 };
  if (typeof win.setWindowButtonVisibility === "function") {
    win.setWindowButtonVisibility(show);
  }
  if (typeof win.setWindowButtonPosition === "function") {
    try {
      win.setWindowButtonPosition(show ? nativeTrafficLightPosition : { x: -120, y: -120 });
    } catch {
      // Older Electron builds may expose the method but reject position updates.
      if (!show) {
        try { win.setWindowButtonPosition({ x: -120, y: -120 }); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = { setMacNativeControlsVisible };
