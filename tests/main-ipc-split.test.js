const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("main process delegates window and util IPC while scheduling uses Core HTTP adapter", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const windowIpc = fs.readFileSync(path.join(root, "src/main/ipc/window-ipc.js"), "utf8");
  const utilIpc = fs.readFileSync(path.join(root, "src/main/ipc/util-ipc.js"), "utf8");

  assert.match(mainSource, /registerWindowIpc\(\{/);
  assert.match(mainSource, /registerUtilIpc\(\{/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(IpcChannel\.WindowClose/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(IpcChannel\.TasksList/);
  assert.doesNotMatch(mainSource, /registerTasksIpc/);
  assert.match(windowIpc, /function registerWindowIpc/);
  assert.match(utilIpc, /function registerUtilIpc/);
  assert.match(utilIpc, /IpcChannel\.UtilOpenLocalFile/);
  assert.match(utilIpc, /IpcChannel\.UtilRevealLocalFile/);
});

test("main delegates agent workspace settings to Core", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const runtimePathsSource = fs.readFileSync(path.join(root, "src/main/runtime-paths.js"), "utf8");
  const settingsStoreSource = fs.readFileSync(path.join(root, "src/main/settings-store.js"), "utf8");
  const readHelper = mainSource.match(/async function readAgentWorkspaceFromCore\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  const writeHelper = mainSource.match(/async function writeAgentWorkspaceToCore\(workspacePath\) \{[\s\S]*?\n\}/)?.[0] || "";

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
  assert.match(
    readHelper,
    /forwardMiaCoreHttpRequest\([\s\S]*route:\s*"\/api\/agent-workspace"/,
    "foreground workspace reads must use Rust Core HTTP"
  );
  assert.match(
    writeHelper,
    /forwardMiaCoreHttpRequest\([\s\S]*method:\s*"POST"[\s\S]*route:\s*"\/api\/agent-workspace"/,
    "foreground workspace writes must use Rust Core HTTP"
  );
  assert.doesNotMatch(
    writeHelper,
    /settingsStore\.writeAgentWorkspace/,
    "foreground Core workspace helper must not write local settings-store directly"
  );
  assert.doesNotMatch(
    `${runtimePathsSource}\n${settingsStoreSource}`,
    /workspaceSettings|mia-workspace\.json|function\s+agentWorkspace|function\s+writeAgentWorkspace/,
    "agent workspace persistence must not return to local JSON settings"
  );
});

test("main delegates memory settings to Core", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const runtimePathsSource = fs.readFileSync(path.join(root, "src/main/runtime-paths.js"), "utf8");
  const settingsStoreSource = fs.readFileSync(path.join(root, "src/main/settings-store.js"), "utf8");
  const readHelper = mainSource.match(/async function readMemorySettingsFromCore\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  const writeHelper = mainSource.match(/async function writeMemorySettingsToCore\(settings = \{\}\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(
    mainSource,
    /IpcChannel\.MemorySettingsSave[\s\S]*writeMemorySettingsToCore\(settings \|\| \{\}\)/,
    "foreground memory settings save must go through Core"
  );
  assert.match(
    readHelper,
    /forwardMiaCoreHttpRequest\([\s\S]*route:\s*"\/api\/memory\/settings"/,
    "foreground memory settings reads must use Rust Core HTTP"
  );
  assert.match(
    writeHelper,
    /forwardMiaCoreHttpRequest\([\s\S]*method:\s*"POST"[\s\S]*route:\s*"\/api\/memory\/settings"/,
    "foreground memory settings writes must use Rust Core HTTP"
  );
  assert.match(
    writeHelper,
    /body:\s*\{ mode \}/,
    "foreground memory settings writes must send the canonical mode"
  );
  assert.doesNotMatch(
    writeHelper,
    /body:\s*\{ enabled:/,
    "foreground memory settings writes must not send the retired boolean contract"
  );
  assert.doesNotMatch(
    writeHelper,
    /settingsStore\.writeMemorySettings/,
    "foreground memory settings helper must not write local settings-store directly"
  );
  assert.doesNotMatch(
    `${runtimePathsSource}\n${settingsStoreSource}`,
    /memorySettings|mia-memory-settings\.json|function\s+writeMemorySettings|function\s+memorySettings/,
    "memory settings persistence must not return to local JSON settings"
  );
});

test("main no longer exposes foreground memory CRUD", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

  assert.doesNotMatch(mainSource, /IpcChannel\.Memory(?:List|ListAll|Remember|Update|Forget|Delete)/);
  assert.doesNotMatch(mainSource, /route:\s*"\/api\/mia\/memory\/(?:list|remember|update|forget|delete)"/);
  assert.doesNotMatch(mainSource, /function (?:list|listAll|remember|update|forget|delete)CoreMemory/);
  assert.doesNotMatch(mainSource, /miaMemoryService|syncNativeMemoryFiles|scheduleCloudMemorySync/);
});
