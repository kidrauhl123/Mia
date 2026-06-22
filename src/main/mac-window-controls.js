const macNativeChromeMetrics = Object.freeze({
  defaultTrafficLightPosition: Object.freeze({ x: 18, y: 18 }),
  railTrafficLightPosition: Object.freeze({ x: 10, y: 18 }),
  trafficLightPosition: Object.freeze({ x: 10, y: 18 }),
  hiddenTrafficLightPosition: Object.freeze({ x: -120, y: -120 }),
  railSafeAreaHeight: 64
});

function macNativeControlsPositionForLayout(layout = "rail") {
  return layout === "default"
    ? macNativeChromeMetrics.defaultTrafficLightPosition
    : macNativeChromeMetrics.railTrafficLightPosition;
}

function setMacNativeControlsPosition(win, position) {
  if (!win || process.platform !== "darwin" || typeof win.setWindowButtonPosition !== "function") return;
  try {
    // Keep undefined as an explicit reset path for callers that need to clear
    // a custom position; named layouts pass concrete TGSwift-derived points.
    win.setWindowButtonPosition(position === undefined ? null : position);
  } catch {
    // Older Electron builds may expose the method but reject position updates.
  }
}

function setMacNativeControlsLayout(win, layout = "rail") {
  setMacNativeControlsPosition(win, macNativeControlsPositionForLayout(layout));
}

function setMacNativeControlsVisible(win, visible, layout = "rail") {
  if (!win || process.platform !== "darwin") return;
  const show = Boolean(visible);
  if (typeof win.setWindowButtonVisibility === "function") {
    win.setWindowButtonVisibility(show);
  }
  if (typeof win.setWindowButtonPosition === "function") {
    try {
      const targetPosition = show
        ? macNativeControlsPositionForLayout(layout)
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

module.exports = {
  setMacNativeControlsVisible,
  setMacNativeControlsLayout,
  macNativeChromeMetrics,
  macNativeControlsPositionForLayout
};
