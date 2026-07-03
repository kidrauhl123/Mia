const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("desktop preload can load local shared contracts", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");

  assert.match(preloadSource, /require\("\.\/shared\/ipc-channels"\)/);
  assert.match(channelSource, /UtilOpenLocalFile:\s*"util:open-local-file"/);
  assert.match(preloadSource, /openLocalFile: \(target\) => ipcRenderer\.invoke\(IpcChannel\.UtilOpenLocalFile, target\)/);
  assert.match(channelSource, /UtilRevealLocalFile:\s*"util:reveal-local-file"/);
  assert.match(preloadSource, /revealLocalFile: \(target\) => ipcRenderer\.invoke\(IpcChannel\.UtilRevealLocalFile, target\)/);
  assert.match(channelSource, /MemoryList:\s*"memory:list"/);
  assert.match(channelSource, /MemoryListAll:\s*"memory:list-all"/);
  assert.match(channelSource, /MemoryDelete:\s*"memory:delete"/);
  assert.match(channelSource, /MemorySettingsSave:\s*"memory:settings-save"/);
  assert.match(preloadSource, /memory:\s*\{/);
  assert.match(preloadSource, /list: \(payload\) => ipcRenderer\.invoke\(IpcChannel\.MemoryList, payload\)/);
  assert.match(preloadSource, /listAll: \(payload\) => ipcRenderer\.invoke\(IpcChannel\.MemoryListAll, payload\)/);
  assert.match(preloadSource, /remember: \(payload\) => ipcRenderer\.invoke\(IpcChannel\.MemoryRemember, payload\)/);
  assert.match(preloadSource, /update: \(payload\) => ipcRenderer\.invoke\(IpcChannel\.MemoryUpdate, payload\)/);
  assert.match(preloadSource, /forget: \(payload\) => ipcRenderer\.invoke\(IpcChannel\.MemoryForget, payload\)/);
  assert.match(preloadSource, /delete: \(payload\) => ipcRenderer\.invoke\(IpcChannel\.MemoryDelete, payload\)/);
  assert.match(preloadSource, /saveMemorySettings: \(settings\) => ipcRenderer\.invoke\(IpcChannel\.MemorySettingsSave, settings\)/);
  assert.match(preloadSource, /generateBotPet: \(payload\) => ipcRenderer\.invoke\(IpcChannel\.PetGenerate, payload\)/);
  assert.match(preloadSource, /placeBotPet: \(key\) => ipcRenderer\.invoke\(IpcChannel\.PetPlace, key\)/);
  assert.match(preloadSource, /recallBotPet: \(key\) => ipcRenderer\.invoke\(IpcChannel\.PetRecall, key\)/);
  assert.match(mainSource, /preload: path\.join\(__dirname, "preload\.js"\)[\s\S]*sandbox: false/);
});
