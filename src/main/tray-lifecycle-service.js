function safeActivityCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function createTrayLifecycleService(deps = {}) {
  const {
    app,
    Tray,
    Menu,
    nativeImage,
    platform = process.platform,
    iconPath,
    getCoreStatus = () => ({ running: false }),
    getActivityCount = () => 0,
    openMainWindow = () => {},
    quitMia = () => {},
    log = () => {}
  } = deps;

  let tray = null;

  function coreStatus() {
    const status = getCoreStatus() || {};
    return {
      ...status,
      running: status.running === true
    };
  }

  function showDockIfNeeded() {
    if (platform === "darwin" && app?.dock && typeof app.dock.show === "function") {
      app.dock.show();
    }
  }

  function openFromTray() {
    showDockIfNeeded();
    openMainWindow();
  }

  function trayImage() {
    const image = nativeImage.createFromPath(iconPath);
    if (image && typeof image.resize === "function") {
      return image.resize(platform === "darwin"
        ? { width: 16, height: 16 }
        : { width: 32, height: 32 });
    }
    return image;
  }

  function buildMenu() {
    const status = coreStatus();
    const activityCount = safeActivityCount(getActivityCount());
    return Menu.buildFromTemplate([
      {
        label: "Open Mia",
        click: openFromTray
      },
      {
        label: status.running ? "Mia Core: Running" : "Mia Core: Stopped",
        enabled: false
      },
      {
        label: `Background activity: ${activityCount}`,
        enabled: false
      },
      {
        label: "Quit Mia",
        click: () => quitMia()
      }
    ]);
  }

  function destroyTray() {
    if (!tray) return;
    try {
      tray.destroy();
    } finally {
      tray = null;
    }
  }

  function createOrUpdateTray() {
    if (!coreStatus().running) {
      destroyTray();
      return null;
    }
    if (!Tray || !Menu || !nativeImage || !iconPath) {
      log("Tray unavailable; keeping the main window visible.");
      return null;
    }
    if (!tray) {
      tray = new Tray(trayImage());
      tray.setToolTip("Mia Core running");
      if (typeof tray.on === "function") {
        tray.on("double-click", openFromTray);
        tray.on("click", () => {
          if (platform !== "darwin") openMainWindow();
        });
      }
    }
    tray.setContextMenu(buildMenu());
    return tray;
  }

  function refresh() {
    return createOrUpdateTray();
  }

  function setCoreRunning(running) {
    if (running === true) {
      createOrUpdateTray();
      return;
    }
    destroyTray();
  }

  function isTrayVisible() {
    return Boolean(tray);
  }

  return {
    createOrUpdateTray,
    refresh,
    destroyTray,
    isTrayVisible,
    setCoreRunning,
    _testOnlyTray: () => tray
  };
}

module.exports = { createTrayLifecycleService };
