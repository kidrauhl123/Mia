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
    cloudSettings: path.join(home, "mia-cloud.json"),
    windowSettings: path.join(home, "mia-window.json")
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

test("appearanceSettings defaults both chat avatar toggles off", (t) => {
  const { store } = setup(t);

  const appearance = store.appearanceSettings();

  assert.equal(appearance.showUserAvatar, false);
  assert.equal(appearance.showAssistantAvatar, false);
});

test("appearanceSettings falls back from removed font presets", (t) => {
  const { runtime, store } = setup(t);
  fs.mkdirSync(path.dirname(runtime.appearanceSettings), { recursive: true });
  fs.writeFileSync(runtime.appearanceSettings, JSON.stringify({ fontPreset: "mono" }));

  assert.equal(store.appearanceSettings().fontPreset, "system");
});

test("appearanceSettings folds legacy flush list style back to cards", (t) => {
  const { runtime, store } = setup(t);
  fs.mkdirSync(path.dirname(runtime.appearanceSettings), { recursive: true });
  fs.writeFileSync(runtime.appearanceSettings, JSON.stringify({ listStyle: "flush" }));

  assert.equal(store.appearanceSettings().listStyle, "card");
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
    selectionStyle: "solid",
    workspaceBackgroundColor: "#ABCDEF",
    workspaceBackgroundImage: "data:image/png;base64,abc123"
  });

  assert.deepEqual(next, {
    theme: "light",
    fontPreset: "system",
    accentColor: "#aabbcc",
    userBubbleColor: "#dedcff",
    showHoverBackground: false,
    showUserAvatar: false,
    showAssistantAvatar: false,
    listStyle: "card",
    selectionStyle: "solid",
    workspaceBackgroundColor: "#abcdef",
    workspaceBackgroundImage: "data:image/png;base64,abc123"
  });
  assert.deepEqual(readJson(runtime.appearanceSettings, {}), next);
});

test("writeAppearanceSettings preserves saved bottom board fields on partial saves", (t) => {
  const { store } = setup(t);

  store.writeAppearanceSettings({
    workspaceBackgroundColor: "#2CA1FF",
    workspaceBackgroundImage: "data:image/png;base64,abc123"
  });
  const next = store.writeAppearanceSettings({ theme: "dark" });

  assert.equal(next.theme, "dark");
  assert.equal(next.workspaceBackgroundColor, "#2ca1ff");
  assert.equal(next.workspaceBackgroundImage, "data:image/png;base64,abc123");
});

test("writeAppearanceSettings rejects invalid bottom board image data", (t) => {
  const { store } = setup(t);

  const next = store.writeAppearanceSettings({
    workspaceBackgroundColor: "not-a-color",
    workspaceBackgroundImage: "https://example.test/bg.png"
  });

  assert.equal(next.workspaceBackgroundColor, "");
  assert.equal(next.workspaceBackgroundImage, "");
});

test("writeAppearanceSettings accepts the serif font preset", (t) => {
  const { store } = setup(t);

  const next = store.writeAppearanceSettings({ fontPreset: "serif" });

  assert.equal(next.fontPreset, "serif");
});

test("writeAppearanceSettings rejects removed font presets", (t) => {
  const { store } = setup(t);

  assert.equal(store.writeAppearanceSettings({ fontPreset: "sf-pro" }).fontPreset, "system");
  assert.equal(store.writeAppearanceSettings({ fontPreset: "mono" }).fontPreset, "system");
});

test("normalizeEffortLevel keeps OpenClaw CLI thinking levels", (t) => {
  const { store } = setup(t);

  assert.equal(store.normalizeEffortLevel("adaptive", "openclaw"), "adaptive");
  assert.equal(store.normalizeEffortLevel("max", "openclaw"), "max");
  assert.equal(store.normalizeEffortLevel("none", "openclaw"), "off");
  assert.equal(store.normalizeStoredEffortLevel("adaptive"), "adaptive");
  assert.equal(store.normalizeStoredEffortLevel("off"), "off");
});

test("windowSettings reads and writes normalized bounds", (t) => {
  const { runtime, store } = setup(t);

  assert.deepEqual(store.windowSettings(), store.defaultWindowSettings());

  const next = store.writeWindowSettings({
    bounds: { x: 12.4, y: 20.8, width: 1039.7, height: 700.2 },
    maximized: true
  });

  assert.deepEqual(next, {
    bounds: { x: 12, y: 21, width: 1040, height: 700 },
    maximized: true
  });
  assert.deepEqual(readJson(runtime.windowSettings, {}), next);
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

test("fresh userProfile has no hard-coded personal identity", (t) => {
  const { store } = setup(t);

  assert.deepEqual(store.userProfile(), {
    displayName: "",
    avatarText: "",
    avatarColor: "",
    avatarImage: "",
    avatarCrop: { x: 50, y: 50, zoom: 1 },
    statusBadge: null
  });
});

test("writeUserProfile keeps empty profile fields empty", (t) => {
  const { runtime, store } = setup(t);

  const next = store.writeUserProfile({
    displayName: "",
    avatarText: "",
    avatarColor: "",
    avatarImage: "",
    avatarCrop: null
  });

  assert.equal(next.displayName, "");
  assert.equal(next.avatarText, "");
  assert.deepEqual(readJson(runtime.userProfile, {}), next);
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
    avatarCrop: { x: 12, y: 34, zoom: 2 },
    statusBadge: null
  });
  assert.deepEqual(readJson(runtime.userProfile, {}), next);
});

test("writeUserProfile preserves status badge choices", (t) => {
  const { runtime, store } = setup(t);
  const badge = { kind: "lottie", assetId: "rainbow", label: "彩虹动画", loop: "always" };

  const next = store.writeUserProfile({ statusBadge: badge });

  assert.deepEqual(next.statusBadge, badge);
  assert.deepEqual(readJson(runtime.userProfile, {}).statusBadge, badge);
});

test("daemon settings are always enabled and ignore stale disable writes", (t) => {
  const { runtime, store } = setup(t);
  fs.mkdirSync(path.dirname(runtime.daemonSettings), { recursive: true });
  fs.writeFileSync(runtime.daemonSettings, JSON.stringify({ enabled: false, host: "localhost", port: 27862 }));

  assert.equal(store.daemonSettings().enabled, true);

  const next = store.writeDaemonSettings({ enabled: false, host: "localhost", port: 27863 });

  assert.deepEqual(next, { enabled: true, host: "localhost", port: 27863 });
  assert.equal(readJson(runtime.daemonSettings, {}).enabled, true);
});

test("cursor-only writeCloudSettings cannot wipe credentials after a failed read", (t) => {
  const { runtime, store } = setup(t);
  // Signed-in state on disk.
  store.writeCloudSettings({ enabled: true, token: "tok_alive", user: { id: "u1" }, lastEventSeq: 10 });
  // Simulate the concurrent-writer window: the file reads as corrupt JSON.
  fs.writeFileSync(runtime.cloudSettings, "{\"enab");

  // Both processes do this on every cloud event.
  const result = store.writeCloudSettings({ lastEventSeq: 11 });

  // The wipe (enabled:false token:"" user:null lastEventSeq:0) must NOT be persisted.
  assert.equal(result.token, "");
  assert.equal(readJson(runtime.cloudSettings, null), null); // file untouched (still corrupt)
});

test("explicit logout still clears credentials and resets the cursor", (t) => {
  const { runtime, store } = setup(t);
  store.writeCloudSettings({ enabled: true, token: "tok_alive", user: { id: "u1" }, lastEventSeq: 10 });

  const next = store.writeCloudSettings({ enabled: false, token: "", user: null });

  assert.equal(next.enabled, false);
  assert.equal(next.token, "");
  assert.equal(next.user, null);
  assert.equal(next.lastEventSeq, 0);
  assert.deepEqual(readJson(runtime.cloudSettings, {}).token, "");
});

test("writeCloudSettings replaces the file atomically without tmp leftovers", (t) => {
  const { runtime, store } = setup(t);
  store.writeCloudSettings({ enabled: true, token: "tok_alive", user: { id: "u1" }, lastEventSeq: 1 });
  store.writeCloudSettings({ lastEventSeq: 2 });

  assert.equal(readJson(runtime.cloudSettings, {}).lastEventSeq, 2);
  assert.equal(readJson(runtime.cloudSettings, {}).token, "tok_alive");
  const leftovers = fs.readdirSync(path.dirname(runtime.cloudSettings)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});
