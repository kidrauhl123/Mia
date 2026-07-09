const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("main imports tray lifecycle and window close policy modules", () => {
  const main = read("src/main.js");

  assert.match(main, /const \{ app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray \} = require\("electron"\);/);
  assert.match(main, /const \{ createTrayLifecycleService \} = require\("\.\/main\/tray-lifecycle-service\.js"\);/);
  assert.match(main, /WINDOW_CLOSE_ACTIONS/);
  assert.match(main, /decideWindowClose/);
  assert.match(main, /windowClosePromptOptions/);
  assert.match(main, /dialogResultToWindowCloseChoice/);
});

test("main instantiates tray lifecycle service with Core and window actions", () => {
  const main = read("src/main.js");

  assert.match(main, /const trayLifecycleService = createTrayLifecycleService\(\{/);
  assert.match(main, /getCoreStatus: getDaemonStatus/);
  assert.match(main, /openMainWindow: showMainWindowFromTray/);
  assert.match(main, /quitMia: \(\) => requestFullMiaQuit\("tray"\)/);
  assert.match(main, /function markCoreRunningForTray\(running\)/);
  assert.match(main, /function syncTrayStateWithDaemonStatus\(status = getDaemonStatus\(\)\)/);
});

test("main wires BrowserWindow close through tray-gated close policy", () => {
  const main = read("src/main.js");

  assert.match(main, /win\.on\("close", \(event\) => \{\s*handleMainWindowClose\(event, win\);\s*\}\);/);
  assert.match(main, /function handleMainWindowClose\(event, win\)/);
  assert.match(main, /settingsStore\.windowSettings\(\)\.windowCloseBehavior/);
  assert.match(main, /dialog\.showMessageBox\(win, windowClosePromptOptions\(\)\)/);
  assert.match(main, /settingsStore\.writeWindowSettings\(\{ windowCloseBehavior: decision\.preferenceToWrite \}\)/);
});

test("main full quit path stops Core before removing tray and quitting", () => {
  const main = read("src/main.js");

  assert.match(main, /let explicitMiaQuitInProgress = false;/);
  assert.match(main, /let fullMiaQuitPromise = null;/);
  assert.match(main, /async function requestFullMiaQuit\(reason = "app"\)/);
  assert.match(main, /explicitMiaQuitInProgress = true;/);
  assert.match(main, /await stopDaemonService\(\);/);
  assert.match(main, /trayLifecycleService\.destroyTray\(\);/);
  assert.match(main, /app\.quit\(\);/);
});

test("main updates tray state from Core start, stop, and observed daemon status", () => {
  const main = read("src/main.js");

  assert.equal(countMatches(main, /markCoreRunningForTray\(true\);/g), 3);
  assert.match(main, /async function stopDaemonService\(\)[\s\S]*markCoreRunningForTray\(false\);[\s\S]*return result;/);
  assert.match(main, /async function getObservedDaemonStatus\(timeoutMs = 500\)[\s\S]*const status = await miaCoreControlServer\.observedStatus\(timeoutMs\);[\s\S]*syncTrayStateWithDaemonStatus\(status\);[\s\S]*return status;/);
});

test("main app lifecycle hooks preserve tray-visible background state", () => {
  const main = read("src/main.js");

  assert.match(main, /app\.on\("before-quit", \(event\) => \{/);
  assert.match(main, /event\.preventDefault\(\);[\s\S]*requestFullMiaQuit\("before-quit"\)/);
  assert.match(main, /app\.on\("window-all-closed", \(\) => \{[\s\S]*trayLifecycleService\.isTrayVisible\(\)[\s\S]*requestFullMiaQuit\("window-all-closed"\)/);
  assert.match(main, /app\.on\("activate", \(\) => \{[\s\S]*showMainWindowFromTray\(\)/);
});
