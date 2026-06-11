const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const directoryPath = path.join(__dirname, "..", "src", "renderer", "bot", "bot-directory.js");

test("bot directory normalizes cloud identities and ignores local-only manifest bots", () => {
  const { isCloudIdentityBot, isCloudRuntimeKind, listOwnedBots } = require(directoryPath);

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
  assert.equal(isCloudIdentityBot(mia), true);
  assert.equal(isCloudRuntimeKind(mia.runtimeKind), true);

  assert.equal(codex, undefined);
});

test("bot directory keeps cloud identity fields for desktop-runtime bots", () => {
  const { isCloudIdentityBot, isCloudRuntimeKind, listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    cloudBots: [
      { id: "alice", name: "Alice Cloud", bio: "cloud copy", color: "#2563eb", runtimeKind: "desktop-local", runtimeLabel: "Office Mac" }
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
  assert.equal(bots[0].name, "Alice Cloud");
  assert.equal(bots[0].bio, "cloud copy");
  assert.equal(bots[0].runtimeKind, "desktop-local");
  assert.equal(bots[0].runtimeLabel, "Office Mac");
  assert.deepEqual(bots[0].sourceKinds, ["cloud"]);
  assert.equal(isCloudIdentityBot(bots[0]), true);
  assert.equal(isCloudRuntimeKind(bots[0].runtimeKind), false);
});

test("bot directory preserves cloud active runtime over a local mirror", () => {
  const { listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    cloudBots: [
      {
        id: "alice",
        name: "Alice Cloud",
        runtimeKind: "cloud-hermes",
        runtimeLabel: "Mia Cloud",
        agentEngine: "hermes"
      }
    ],
    localBots: [
      { key: "alice", name: "Alice Local", agentEngine: "codex", deviceName: "Mac" }
    ],
    runtime: {
      localDevice: { name: "Mac" }
    }
  });

  assert.equal(bots.length, 1);
  assert.equal(bots[0].runtimeKind, "cloud-hermes");
  assert.equal(bots[0].runtimeLabel, "Mia Cloud");
  assert.equal(bots[0].agentEngine, "hermes");
});

test("bot directory reads desktop active runtime from runtimeConfig", () => {
  const { listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    cloudBots: [
      {
        id: "nono",
        name: "nono",
        runtimeKind: "desktop-local",
        runtimeConfig: { agentEngine: "claude-code", deviceId: "mac-1", deviceName: "Office Mac" }
      }
    ],
    localBots: [
      { key: "nono", name: "nono", agentEngine: "hermes" }
    ],
    runtime: {
      localDevice: { id: "mac-1", name: "Office Mac" }
    }
  });

  assert.equal(bots.length, 1);
  assert.equal(bots[0].runtimeKind, "desktop-local");
  assert.equal(bots[0].agentEngine, "claude-code");
  assert.equal(bots[0].targetDeviceId, "mac-1");
  assert.equal(bots[0].runtimeLabel, "Office Mac");
});

test("bot directory compacts verbose Mia Desktop device labels", () => {
  const { listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    cloudBots: [
      {
        id: "nono",
        name: "nono",
        runtimeKind: "desktop-local",
        runtimeConfig: {
          agentEngine: "codex",
          deviceId: "mac-1",
          deviceName: "zuiyoudeMacBook-Pro.local Mia Desktop · 本机"
        }
      }
    ],
    runtime: {
      localDevice: { id: "mac-1", name: "zuiyoudeMacBook-Pro.local Mia Desktop" }
    }
  });

  assert.equal(bots[0].runtimeLabel, "zuiyoudeMacBook-Pro");
  assert.doesNotMatch(bots[0].runtimeLabel, /Mia Desktop|\.local|本机/);
});

test("bot directory ignores local-only desktop manifest bots", () => {
  const { listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    localBots: [
      { key: "mia", name: "Mia", agentEngine: "claude-code", deviceName: "Windows PC" }
    ],
    runtime: {
      localDevice: { name: "Windows PC" }
    }
  });

  assert.equal(bots.length, 0);
});

test("bot directory ignores stale local avatar mirrors", () => {
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
  assert.equal(bots[0].name, "空铃 Cloud");
  assert.equal(bots[0].avatarImage, "data:image/png;base64,real");
  assert.deepEqual(bots[0].avatarCrop, { x: 50, y: 50, zoom: 1 });
});

test("bot directory keeps cloud video avatar trim and ignores local mirrors", () => {
  const { listOwnedBots } = require(directoryPath);

  const bots = listOwnedBots({
    cloudBots: [
      {
        id: "jiangmei",
        name: "匠妹 Cloud",
        avatarImage: "https://mia.gifgif.cn/api/avatar-assets/jiangmei.avatar.mp4",
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
  assert.equal(bots[0].name, "匠妹 Cloud");
  assert.equal(bots[0].avatarImage, "https://mia.gifgif.cn/api/avatar-assets/jiangmei.avatar.mp4");
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
