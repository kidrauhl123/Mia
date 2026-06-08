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
  let restartPromptOpen = false;
  let updater = null;

  function resolveUpdater() {
    if (!updater) updater = getAutoUpdater();
    return updater;
  }

  function enabled() {
    return Boolean(isPackaged) && !disabled;
  }

  function start() {
    if (started) return;
    started = true;
    if (!enabled()) {
      logger.info?.(`${TAG} skipped (${disabled ? "disabled" : "dev/unpacked build"})`);
      return;
    }
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
    checkForUpdates();
    setInterval(checkForUpdates, checkIntervalMs);
  }

  function checkForUpdates() {
    if (!enabled()) return;
    resolveUpdater()
      .checkForUpdates()
      .catch((error) => {
        logger.warn?.(`${TAG} checkForUpdates rejected`, error);
      });
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
