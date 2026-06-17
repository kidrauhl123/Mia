const macNativeChromeMetrics = Object.freeze({
  trafficLightPosition: Object.freeze({ x: 10, y: 18 }),
  hiddenTrafficLightPosition: Object.freeze({ x: -120, y: -120 }),
  railSafeAreaHeight: 64
});

function setMacNativeControlsVisible(win, visible) {
  if (!win || process.platform !== "darwin") return;
  const show = Boolean(visible);
  if (typeof win.setWindowButtonVisibility === "function") {
    win.setWindowButtonVisibility(show);
  }
  if (typeof win.setWindowButtonPosition === "function") {
    try {
      const targetPosition = show
        ? macNativeChromeMetrics.trafficLightPosition
        : macNativeChromeMetrics.hiddenTrafficLightPosition;
      win.setWindowButtonPosition(targetPosition);
    } catch {
      // Older Electron builds may expose the method but reject position updates.
      if (!show) {
        try { win.setWindowButtonPosition(macNativeChromeMetrics.hiddenTrafficLightPosition); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = { setMacNativeControlsVisible, macNativeChromeMetrics };
