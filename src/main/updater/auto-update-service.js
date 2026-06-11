// In-app auto-update (macOS Squirrel.Mac via electron-updater).
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

function createAutoUpdateService(deps = {}) {
  const {
    // Lazy accessor so the electron-updater singleton is constructed only in
    // the foreground path, never on module load in the daemon process.
    getAutoUpdater,
    dialog,
    isPackaged,
    getMainWindow,
    logger = console,
    disabled = process.env.MIA_DISABLE_AUTO_UPDATE === "1",
    // Re-check while the app stays open; most users update on relaunch, this
    // catches long-running sessions.
    checkIntervalMs = 6 * 60 * 60 * 1000,
  } = deps;

  let started = false;
  let configured = false;
  let checkingPromise = null;
  let restartPromptOpen = false;
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

  function configureUpdater() {
    if (configured) return resolveUpdater();
    const autoUpdater = resolveUpdater();
    autoUpdater.autoDownload = true;
    // If the user dismisses the restart prompt, still apply on next quit.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("error", (error) => {
      // Update failures are routine (offline, no newer release) — warn, never nag.
      logger.warn?.(`${TAG} update check failed`, error);
    });
    autoUpdater.on("update-available", (info) => {
      logger.info?.(`${TAG} update available: ${info?.version}`);
    });
    autoUpdater.on("update-downloaded", (info) => {
      logger.info?.(`${TAG} update downloaded: ${info?.version}`);
      promptRestart(info);
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
    setInterval(checkForUpdates, checkIntervalMs);
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

  function promptRestart(info) {
    if (restartPromptOpen) return;
    restartPromptOpen = true;
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    const options = {
      type: "info",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1,
      title: "Mia 有新版本",
      message: `Mia ${info?.version || ""} 已下载完成`.trim(),
      detail: "重启后即可使用新版本。",
    };
    const onChoice = (result) => {
      if (result?.response === 0) {
        resolveUpdater().quitAndInstall();
      } else {
        // Let a later download cycle prompt again; quit-time install still applies.
        restartPromptOpen = false;
      }
    };
    const promise = win
      ? dialog.showMessageBox(win, options)
      : dialog.showMessageBox(options);
    promise.then(onChoice).catch((error) => {
      restartPromptOpen = false;
      logger.warn?.(`${TAG} restart prompt failed`, error);
    });
  }

  return { start, checkForUpdates };
}

module.exports = { createAutoUpdateService };
