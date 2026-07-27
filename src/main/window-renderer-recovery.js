"use strict";

const DEFAULT_RELOAD_DELAYS_MS = Object.freeze([250, 1_000]);
const DEFAULT_RETRY_WINDOW_MS = 60_000;
const IGNORED_LOAD_ERROR_CODES = new Set([-3]);
const RECOVERY_PAGE_PATH = "/renderer/recovery/renderer-crashed.html";

function isRendererRecoveryUrl(url = "") {
  return String(url).replaceAll("\\", "/").includes(RECOVERY_PAGE_PATH);
}

function installWindowRendererRecovery({
  clearTimeoutFn = clearTimeout,
  isShuttingDown = () => false,
  log = () => {},
  now = Date.now,
  reload,
  reloadDelaysMs = DEFAULT_RELOAD_DELAYS_MS,
  retryWindowMs = DEFAULT_RETRY_WINDOW_MS,
  setTimeoutFn = setTimeout,
  showFallback,
  webContents
} = {}) {
  if (!webContents || typeof webContents.on !== "function") {
    throw new Error("webContents dependency is required.");
  }
  if (typeof reload !== "function") throw new Error("reload dependency is required.");
  if (typeof showFallback !== "function") throw new Error("showFallback dependency is required.");

  let state = "idle";
  let timer = null;
  let disposed = false;
  let fallbackAttempted = false;
  let reloadAttempts = [];

  const currentUrl = () => {
    try {
      return typeof webContents.getURL === "function" ? webContents.getURL() : "";
    } catch {
      return "";
    }
  };

  const isUnavailable = () => (
    disposed
    || isShuttingDown()
    || (typeof webContents.isDestroyed === "function" && webContents.isDestroyed())
  );

  const pruneReloadAttempts = (timestamp) => {
    reloadAttempts = reloadAttempts.filter((attemptAt) => timestamp - attemptAt < retryWindowMs);
  };

  const loadFallback = (failure) => {
    if (isUnavailable()) return "ignored";
    if (fallbackAttempted || isRendererRecoveryUrl(currentUrl())) {
      state = "fallback";
      log("error", `[RendererRecovery] recovery page renderer failed reason=${failure.reason}`);
      return "fallback";
    }

    fallbackAttempted = true;
    state = "loading-fallback";
    log(
      "error",
      `[RendererRecovery] automatic reload limit reached source=${failure.source} reason=${failure.reason}`
    );
    Promise.resolve()
      .then(() => showFallback(failure))
      .catch((error) => {
        state = "fallback";
        log("error", "[RendererRecovery] failed to load recovery page", error);
      });
    return "fallback";
  };

  const scheduleReload = (failure) => {
    if (isUnavailable()) return "ignored";
    if (state === "scheduled") return "already-scheduled";

    const timestamp = now();
    pruneReloadAttempts(timestamp);
    if (reloadAttempts.length >= reloadDelaysMs.length) return loadFallback(failure);

    const attemptIndex = reloadAttempts.length;
    const attemptNumber = attemptIndex + 1;
    const delayMs = reloadDelaysMs[attemptIndex];
    reloadAttempts.push(timestamp);
    state = "scheduled";
    log(
      "warn",
      `[RendererRecovery] scheduling reload ${attemptNumber}/${reloadDelaysMs.length} `
        + `source=${failure.source} reason=${failure.reason} delayMs=${delayMs}`
    );

    timer = setTimeoutFn(() => {
      timer = null;
      if (isUnavailable()) {
        state = "idle";
        return;
      }
      state = "loading";
      Promise.resolve()
        .then(() => reload())
        .catch((error) => {
          state = "idle";
          log("error", "[RendererRecovery] reload request failed", error);
          scheduleReload({
            source: "reload",
            reason: "request-failed"
          });
        });
    }, delayMs);
    return "scheduled";
  };

  const onRenderProcessGone = (_event, details = {}) => {
    if (state === "loading") state = "idle";
    scheduleReload({
      exitCode: Number(details.exitCode || 0),
      reason: String(details.reason || "unknown"),
      source: "renderer"
    });
  };

  const onDidFailLoad = (
    _event,
    errorCode,
    errorDescription,
    validatedURL,
    isMainFrame
  ) => {
    if (!isMainFrame || IGNORED_LOAD_ERROR_CODES.has(Number(errorCode))) return;
    if (isRendererRecoveryUrl(validatedURL)) {
      state = "fallback";
      fallbackAttempted = true;
      log(
        "error",
        `[RendererRecovery] recovery page load failed code=${Number(errorCode || 0)} `
          + `reason=${String(errorDescription || "load-failed")}`
      );
      return;
    }
    if (state === "fallback") fallbackAttempted = false;
    if (state === "loading" || state === "loading-fallback") state = "idle";
    scheduleReload({
      errorCode: Number(errorCode || 0),
      reason: String(errorDescription || "load-failed"),
      source: "main-frame"
    });
  };

  const onDidFinishLoad = () => {
    const fallbackLoaded = isRendererRecoveryUrl(currentUrl());
    state = fallbackLoaded ? "fallback" : "idle";
    if (!fallbackLoaded) fallbackAttempted = false;
  };

  webContents.on("render-process-gone", onRenderProcessGone);
  webContents.on("did-fail-load", onDidFailLoad);
  webContents.on("did-finish-load", onDidFinishLoad);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      state = "disposed";
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
      webContents.removeListener?.("render-process-gone", onRenderProcessGone);
      webContents.removeListener?.("did-fail-load", onDidFailLoad);
      webContents.removeListener?.("did-finish-load", onDidFinishLoad);
    },
    state: () => state
  };
}

module.exports = {
  DEFAULT_RELOAD_DELAYS_MS,
  DEFAULT_RETRY_WINDOW_MS,
  installWindowRendererRecovery,
  isRendererRecoveryUrl
};
