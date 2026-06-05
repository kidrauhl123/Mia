const DEFAULT_WINDOW_BOUNDS = Object.freeze({ width: 1040, height: 700 });
const MIN_WINDOW_BOUNDS = Object.freeze({ width: 500, height: 560 });
const MIN_VISIBLE_SIZE = Object.freeze({ width: 120, height: 80 });

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const width = finiteNumber(bounds.width);
  const height = finiteNumber(bounds.height);
  if (!width || !height || width <= 0 || height <= 0) return null;
  const next = {
    width: Math.round(width),
    height: Math.round(height)
  };
  const x = finiteNumber(bounds.x);
  const y = finiteNumber(bounds.y);
  if (x !== null && y !== null) {
    next.x = Math.round(x);
    next.y = Math.round(y);
  }
  return next;
}

function workAreaForBounds(screenApi, bounds) {
  const fallback = screenApi?.getPrimaryDisplay?.()?.workArea || { x: 0, y: 0, width: 1440, height: 900 };
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return fallback;
  try {
    return screenApi?.getDisplayMatching?.(bounds)?.workArea || fallback;
  } catch {
    return fallback;
  }
}

function hasVisibleArea(bounds, workArea) {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  const visibleWidth = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
  const visibleHeight = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
  return visibleWidth >= Math.min(MIN_VISIBLE_SIZE.width, bounds.width)
    && visibleHeight >= Math.min(MIN_VISIBLE_SIZE.height, bounds.height);
}

function fitBoundsToWorkArea(bounds, workArea) {
  const width = clamp(bounds.width, MIN_WINDOW_BOUNDS.width, Math.max(MIN_WINDOW_BOUNDS.width, workArea.width));
  const height = clamp(bounds.height, MIN_WINDOW_BOUNDS.height, Math.max(MIN_WINDOW_BOUNDS.height, workArea.height));
  const next = { width: Math.round(width), height: Math.round(height) };
  if (!hasVisibleArea({ ...bounds, width, height }, workArea)) return next;

  const visibleWidth = Math.min(MIN_VISIBLE_SIZE.width, width);
  const visibleHeight = Math.min(MIN_VISIBLE_SIZE.height, height);
  next.x = Math.round(clamp(bounds.x, workArea.x - width + visibleWidth, workArea.x + workArea.width - visibleWidth));
  next.y = Math.round(clamp(bounds.y, workArea.y, workArea.y + workArea.height - visibleHeight));
  return next;
}

function createWindowStateManager(deps = {}) {
  const {
    settingsStore,
    screen: screenApi,
    debounceMs = 250,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = deps;

  function initialWindowState() {
    const saved = settingsStore?.windowSettings?.() || {};
    const savedBounds = normalizeBounds(saved.bounds);
    if (!savedBounds) return { bounds: { ...DEFAULT_WINDOW_BOUNDS }, maximized: false };
    return {
      bounds: fitBoundsToWorkArea(savedBounds, workAreaForBounds(screenApi, savedBounds)),
      maximized: Boolean(saved.maximized)
    };
  }

  function snapshotWindow(win) {
    if (!win || win.isDestroyed?.()) return null;
    const rawBounds = typeof win.getNormalBounds === "function" ? win.getNormalBounds() : win.getBounds?.();
    const bounds = normalizeBounds(rawBounds);
    if (!bounds) return null;
    const fullscreen = Boolean(win.isFullScreen?.());
    return {
      bounds,
      maximized: !fullscreen && Boolean(win.isMaximized?.())
    };
  }

  function attachWindowStatePersistence(win) {
    if (!win || typeof win.on !== "function") return;
    let timer = null;
    const flush = () => {
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
      const snapshot = snapshotWindow(win);
      if (snapshot) settingsStore?.writeWindowSettings?.(snapshot);
    };
    const schedule = () => {
      if (timer) clearTimeoutFn(timer);
      timer = setTimeoutFn(flush, debounceMs);
    };
    win.on("resize", schedule);
    win.on("move", schedule);
    win.on("maximize", schedule);
    win.on("unmaximize", schedule);
    win.on("close", flush);
  }

  return { initialWindowState, attachWindowStatePersistence };
}

module.exports = {
  DEFAULT_WINDOW_BOUNDS,
  MIN_WINDOW_BOUNDS,
  createWindowStateManager
};
