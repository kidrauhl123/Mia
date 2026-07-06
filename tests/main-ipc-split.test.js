const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("main process delegates window and tasks IPC registration to modules", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const windowIpc = fs.readFileSync(path.join(root, "src/main/ipc/window-ipc.js"), "utf8");
  const tasksIpc = fs.readFileSync(path.join(root, "src/main/ipc/tasks-ipc.js"), "utf8");
  const utilIpc = fs.readFileSync(path.join(root, "src/main/ipc/util-ipc.js"), "utf8");

  assert.match(mainSource, /registerWindowIpc\(\{/);
  assert.match(mainSource, /registerTasksIpc\(\{/);
  assert.match(mainSource, /registerUtilIpc\(\{/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(IpcChannel\.WindowClose/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(IpcChannel\.TasksList/);
  assert.match(windowIpc, /function registerWindowIpc/);
  assert.match(tasksIpc, /function registerTasksIpc/);
  assert.match(utilIpc, /function registerUtilIpc/);
  assert.match(utilIpc, /IpcChannel\.UtilOpenLocalFile/);
  assert.match(utilIpc, /IpcChannel\.UtilRevealLocalFile/);
});

test("main delegates agent workspace settings to Core", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

  assert.match(
    mainSource,
    /IpcChannel\.EngineWorkspaceGet[\s\S]*readAgentWorkspaceFromCore\(\)/,
    "foreground workspace reads must go through Core"
  );
  assert.match(
    mainSource,
    /IpcChannel\.EngineWorkspacePick[\s\S]*writeAgentWorkspaceToCore\(picked\)/,
    "foreground workspace writes must go through Core"
  );
  assert.doesNotMatch(
    mainSource,
    /if \(picked\) \{[\s\S]*settingsStore\.writeAgentWorkspace\(picked\)/,
    "foreground picker must not write agent workspace settings directly"
  );
});
