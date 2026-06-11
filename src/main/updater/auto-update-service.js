// In-app auto-update (macOS Squirrel.Mac / Windows NSIS via electron-updater).
//
// Feed is the generic HTTPS update source configured in package.json
// `build.publish` (https://mia.gifgif.cn/updates/). electron-builder bakes that
// into app-update.yml, so the runtime updater reads latest-mac.yml + the signed
// .zip from Mia's own origin instead of GitHub. Squirrel.Mac requires a valid
// Developer ID signature (notarization is NOT required for the update path),
// which the build now produces.
//
// Runs only in real installed builds. `app.isPackaged` already excludes
// `npm start` / tests, but the `electron-builder --dir` output is also
// "packaged" — set MIA_DISABLE_AUTO_UPDATE=1 when smoke-testing that unpacked
// .app so it never hits the live feed. The headless daemon never calls start(),
// and the updater singleton is required lazily here so it's never materialized
// in the daemon process.

const TAG = "[AutoUpdate]";

function versionFromInfo(info) {
  return String(info?.version || "").trim();
}

function serializeError(error) {
  return {
    message: String(error?.message || error || "检查更新失败"),
    code: error?.code || "",
  };
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function normalizeProgress(progress = {}) {
  return {
    percent: clampPercent(progress.percent),
    bytesPerSecond: Math.max(0, Number(progress.bytesPerSecond) || 0),
    transferred: Math.max(0, Number(progress.transferred) || 0),
    total: Math.max(0, Number(progress.total) || 0),
  };
}

function createAutoUpdateService(deps = {}) {
  const {
    // Lazy accessor so the electron-updater singleton is constructed only in
    // the foreground path, never on module load in the daemon process.
    getAutoUpdater,
    isPackaged,
    getMainWindow,
    getMainWindows,
    sendUpdateEvent,
    logger = console,
    disabled = process.env.MIA_DISABLE_AUTO_UPDATE === "1",
    // Re-check while the app stays open; most users update on relaunch, this
    // catches long-running sessions.
    checkIntervalMs = 6 * 60 * 60 * 1000,
    forceInstallDelayMs = 1200,
    setTimeoutFn = setTimeout,
    setIntervalFn = setInterval,
  } = deps;

  let started = false;
  let configured = false;
  let checkingPromise = null;
  let installScheduled = false;
  let windowInteractionLocked = false;
  let updater = null;

  function resolveUpdater() {
    if (!updater) updater = getAutoUpdater();
    return updater;
  }

  function disabledReason() {
    if (disabled) return "disabled";
    if (!isPackaged) return "dev/unpacked build";
    return "";
  }

  function enabled() {
    return !disabledReason();
  }

  function updatePayload(type, info = null, extra = {}) {
    return {
      type,
      status: type,
      version: versionFromInfo(info) || String(extra.version || "").trim(),
      mandatory: true,
      ...extra,
    };
  }

  function updateWindows() {
    if (typeof getMainWindows === "function") return getMainWindows().filter(Boolean);
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    return win ? [win] : [];
  }

  function setWindowInteractionLocked(locked) {
    if (windowInteractionLocked === locked) return;
    windowInteractionLocked = locked;
    for (const win of updateWindows()) {
      if (!win || win.isDestroyed?.()) continue;
      try { if (locked) win.show?.(); } catch { /* best effort */ }
      try { if (locked) win.focus?.(); } catch { /* best effort */ }
      try { win.setClosable?.(!locked); } catch { /* platform-specific */ }
      try { win.setMinimizable?.(!locked); } catch { /* platform-specific */ }
      try { win.setMaximizable?.(!locked); } catch { /* platform-specific */ }
    }
  }

  function emitUpdate(type, info = null, extra = {}) {
    if (["available", "downloading", "downloaded", "installing"].includes(type)) {
      setWindowInteractionLocked(true);
    }
    if (["not-available", "error"].includes(type)) {
      setWindowInteractionLocked(false);
    }
    const payload = updatePayload(type, info, extra);
    try {
      sendUpdateEvent?.(payload);
    } catch (error) {
      logger.warn?.(`${TAG} update event dispatch failed`, error);
    }
    return payload;
  }

  function forceInstall(info) {
    if (installScheduled) return;
    installScheduled = true;
    setTimeoutFn(() => {
      emitUpdate("installing", info, { progress: normalizeProgress({ percent: 100 }) });
      try {
        resolveUpdater().quitAndInstall(false, true);
      } catch (error) {
        installScheduled = false;
        logger.warn?.(`${TAG} quitAndInstall failed`, error);
        emitUpdate("error", info, { error: serializeError(error) });
      }
    }, forceInstallDelayMs);
  }

  function configureUpdater() {
    if (configured) return resolveUpdater();
    const autoUpdater = resolveUpdater();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => {
      emitUpdate("checking");
    });
    autoUpdater.on("error", (error) => {
      logger.warn?.(`${TAG} update check failed`, error);
      emitUpdate("error", null, { error: serializeError(error) });
    });
    autoUpdater.on("update-available", (info) => {
      logger.info?.(`${TAG} update available: ${info?.version}`);
      emitUpdate("available", info, { progress: normalizeProgress({ percent: 0 }) });
    });
    autoUpdater.on("update-not-available", (info) => {
      emitUpdate("not-available", info);
    });
    autoUpdater.on("download-progress", (progress) => {
      emitUpdate("downloading", null, { progress: normalizeProgress(progress) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      logger.info?.(`${TAG} update downloaded: ${info?.version}`);
      emitUpdate("downloaded", info, { progress: normalizeProgress({ percent: 100 }) });
      forceInstall(info);
    });
    configured = true;
    return autoUpdater;
  }

  function start() {
    if (started) return;
    started = true;
    if (!enabled()) {
      logger.info?.(`${TAG} skipped (${disabledReason()})`);
      return;
    }
    configureUpdater();
    checkForUpdates();
    setIntervalFn(checkForUpdates, checkIntervalMs);
  }

  function checkForUpdates() {
    const reason = disabledReason();
    if (reason) return Promise.resolve({ status: "disabled", reason });
    const autoUpdater = configureUpdater();
    if (checkingPromise) return checkingPromise;

    checkingPromise = new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        autoUpdater.removeListener("update-available", onAvailable);
        autoUpdater.removeListener("update-not-available", onNotAvailable);
        autoUpdater.removeListener("update-downloaded", onDownloaded);
        autoUpdater.removeListener("error", onError);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAvailable = (info) => {
        finish({ status: "available", version: versionFromInfo(info) });
      };
      const onNotAvailable = (info) => {
        finish({ status: "not-available", version: versionFromInfo(info) });
      };
      const onDownloaded = (info) => {
        finish({ status: "downloaded", version: versionFromInfo(info) });
      };
      const onError = (error) => {
        logger.warn?.(`${TAG} checkForUpdates rejected`, error);
        finish({ status: "error", error: serializeError(error) });
      };

      autoUpdater.once("update-available", onAvailable);
      autoUpdater.once("update-not-available", onNotAvailable);
      autoUpdater.once("update-downloaded", onDownloaded);
      autoUpdater.once("error", onError);

      try {
        Promise.resolve(autoUpdater.checkForUpdates())
          .then((result) => {
            if (settled) return;
            if (result?.downloadPromise) {
              finish({ status: "available", version: versionFromInfo(result.updateInfo) });
              return;
            }
            finish({ status: "not-available", version: versionFromInfo(result?.updateInfo) });
          })
          .catch(onError);
      } catch (error) {
        onError(error);
      }
    }).finally(() => {
      checkingPromise = null;
    });

    return checkingPromise;
  }

  return { start, checkForUpdates };
}

module.exports = { createAutoUpdateService };
