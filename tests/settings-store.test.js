const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createSettingsStore } = require("../src/main/settings-store.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-settings-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const runtime = {
    appearanceSettings: path.join(home, "mia-appearance.json"),
    userProfile: path.join(home, "mia-user.json"),
    effortSettings: path.join(home, "mia-effort.json"),
    permissionSettings: path.join(home, "mia-permissions.json"),
    daemonSettings: path.join(home, "mia-daemon.json"),
    relaySettings: path.join(home, "mia-relay.json"),
    cloudSettings: path.join(home, "mia-cloud.json")
  };
  const writes = [];
  const store = createSettingsStore({
    runtimePaths: () => runtime,
    readJson,
    writeRuntimeConfig: (port) => writes.push(["runtime-config", port]),
    readConfiguredPort: () => 19001,
    getEngineState: () => ({ port: 0 }),
    MIA_DAEMON_DEFAULT_PORT: 27861,
    MIA_CLOUD_DEFAULT_URL: "https://cloud.example.test",
    normalizeAvatarCrop: (crop) => ({
      x: Number(crop?.x) || 50,
      y: Number(crop?.y) || 50,
      zoom: Number(crop?.zoom) || 1
    }),
    ...overrides
  });
  return { runtime, store, writes };
}

test("appearanceSettings merges saved appearance over defaults", (t) => {
  const { runtime, store } = setup(t);
  fs.mkdirSync(path.dirname(runtime.appearanceSettings), { recursive: true });
  fs.writeFileSync(runtime.appearanceSettings, JSON.stringify({ theme: "dark", showUserAvatar: false }));

  assert.deepEqual(store.appearanceSettings(), {
    ...store.defaultAppearanceSettings(),
    theme: "dark",
    showUserAvatar: false
  });
});

test("writeAppearanceSettings validates choices, colors, and boolean toggles", (t) => {
  const { runtime, store } = setup(t);

  const next = store.writeAppearanceSettings({
    theme: "neon",
    fontPreset: "mono",
    accentColor: "#AABBCC",
    userBubbleColor: "invalid",
    showHoverBackground: false,
    showUserAvatar: null,
    showAssistantAvatar: false,
    listStyle: "invalid",
    selectionStyle: "solid"
  });

  assert.deepEqual(next, {
    theme: "light",
    fontPreset: "mono",
    accentColor: "#aabbcc",
    userBubbleColor: "#dedcff",
    showHoverBackground: false,
    showUserAvatar: true,
    showAssistantAvatar: false,
    listStyle: "card",
    selectionStyle: "solid"
  });
  assert.deepEqual(readJson(runtime.appearanceSettings, {}), next);
});

test("userProfile merges saved profile over defaults", (t) => {
  const { runtime, store } = setup(t);
  fs.mkdirSync(path.dirname(runtime.userProfile), { recursive: true });
  fs.writeFileSync(runtime.userProfile, JSON.stringify({ displayName: "Alice", avatarText: "A" }));

  assert.deepEqual(store.userProfile(), {
    ...store.defaultUserProfile(),
    displayName: "Alice",
    avatarText: "A"
  });
});

test("writeUserProfile normalizes visible profile fields and avatar crop", (t) => {
  const { runtime, store } = setup(t);

  const next = store.writeUserProfile({
    displayName: "  Alice  ",
    avatarText: "alice",
    avatarColor: "  #123456  ",
    avatarImage: "  data:image/png;base64,abc  ",
    avatarCrop: { x: 12, y: 34, zoom: 2 }
  });

  assert.deepEqual(next, {
    displayName: "Alice",
    avatarText: "AL",
    avatarColor: "#123456",
    avatarImage: "data:image/png;base64,abc",
    avatarCrop: { x: 12, y: 34, zoom: 2 }
  });
  assert.deepEqual(readJson(runtime.userProfile, {}), next);
});
