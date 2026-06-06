const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const directoryPath = path.join(__dirname, "..", "src", "renderer", "bot", "bot-directory.js");

test("bot directory normalizes cloud and device bots into one product model", () => {
  const { listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    cloudBots: [
      { id: "mia", name: "Mia", bio: "云端 Agent", color: "#2563eb" }
    ],
    localBots: [
      { key: "codex", name: "Codex", agentEngine: "codex", deviceName: "Jung MacBook" }
    ],
    runtime: {
      localDevice: { name: "Jung MacBook" },
      cloud: { enabled: true }
    }
  });

  const mia = bots.find((bot) => bot.key === "mia");
  const codex = bots.find((bot) => bot.key === "codex");

  assert.equal(mia.name, "Mia");
  assert.equal(mia.runtimeKind, "cloud-hermes");
  assert.equal(mia.runtimeLabel, "Mia Cloud");
  assert.equal(mia.agentEngine, "hermes");
  assert.equal(mia.canEditIdentity, true);
  assert.equal(mia.canDelete, true);
  assert.equal(mia.cloudOnly, undefined);

  assert.equal(codex.runtimeKind, "desktop-local");
  assert.equal(codex.runtimeLabel, "Jung MacBook");
  assert.equal(codex.agentEngine, "codex");
  assert.equal(codex.canEditIdentity, true);
  assert.equal(codex.canConfigureCapabilities, true);
});

test("bot directory treats a cloud-mirrored device bot as one desktop-runtime bot", () => {
  const { listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    cloudBots: [
      { id: "alice", name: "Alice Cloud", bio: "cloud copy", color: "#2563eb" }
    ],
    localBots: [
      { key: "alice", name: "Alice Local", bio: "local copy", agentEngine: "claude-code" }
    ],
    runtime: {
      localDevice: { name: "Office Mac" }
    }
  });

  assert.equal(bots.length, 1);
  assert.equal(bots[0].key, "alice");
  assert.equal(bots[0].name, "Alice Local");
  assert.equal(bots[0].bio, "local copy");
  assert.equal(bots[0].runtimeKind, "desktop-local");
  assert.equal(bots[0].runtimeLabel, "Office Mac");
  assert.deepEqual(bots[0].sourceKinds, ["cloud", "desktop"]);
});

test("bot directory keeps cloud real avatar when local mirror only has a legacy preset", () => {
  const { listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    cloudBots: [
      { id: "kongling", name: "空铃 Cloud", avatarImage: "data:image/png;base64,real", avatarCrop: { x: 50, y: 50, zoom: 1 } }
    ],
    localBots: [
      { key: "kongling", name: "空铃 Local", avatarImage: "./assets/avatars/12.png", avatarCrop: { x: 47, y: 17, zoom: 1.8 } }
    ]
  });

  assert.equal(bots.length, 1);
  assert.equal(bots[0].name, "空铃 Local");
  assert.equal(bots[0].avatarImage, "data:image/png;base64,real");
  assert.deepEqual(bots[0].avatarCrop, { x: 50, y: 50, zoom: 1 });
});

test("bot directory keeps cloud video avatar trim when local mirror is stale", () => {
  const { listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    cloudBots: [
      {
        id: "jiangmei",
        name: "匠妹 Cloud",
        avatarImage: "https://aiweb.buytb01.com/api/avatar-assets/jiangmei.avatar.mp4",
        avatarCrop: { x: 36, y: 100, zoom: 1.09, start: 7.26, duration: 4.94 }
      }
    ],
    localBots: [
      {
        key: "jiangmei",
        name: "匠妹 Local",
        avatarImage: "./assets/avatars/12.png",
        avatarCrop: { x: 50, y: 50, zoom: 1 }
      }
    ]
  });

  assert.equal(bots.length, 1);
  assert.equal(bots[0].name, "匠妹 Local");
  assert.equal(bots[0].avatarImage, "https://aiweb.buytb01.com/api/avatar-assets/jiangmei.avatar.mp4");
  assert.deepEqual(bots[0].avatarCrop, { x: 36, y: 100, zoom: 1.09, start: 7.26, duration: 4.94 });
});

test("bot directory attaches as a browser global", () => {
  const source = fs.readFileSync(directoryPath, "utf8");
  const window = {};
  const context = vm.createContext({ window, globalThis: window });
  vm.runInContext(source, context, { filename: directoryPath });

  assert.equal(typeof window.miaBotDirectory.listOwnedBots, "function");
  assert.equal(window.miaBotDirectory.runtimeLabelFor({ runtimeKind: "cloud-hermes" }), "Mia Cloud");
  assert.equal(window["mia" + "FellowDirectory"], undefined);
});
