const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");

function extractFunctionSource(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  const signatureEnd = source.indexOf(") {", start);
  assert.ok(signatureEnd >= 0, `${name} must have a complete signature`);
  const open = source.indexOf("{", signatureEnd);
  assert.ok(open >= 0, `${name} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body was not closed`);
}

class FakeVideo {
  static onSetSrc = null;

  constructor(src = "") {
    this.attributes = new Map();
    this.dataset = {};
    this.className = "avatar-video";
    this.currentTime = 0;
    this.duration = 10;
    this.listeners = [];
    this.parentElement = null;
    this.isConnected = false;
    this.loop = true;
    this.playCount = 0;
    this.pauseCount = 0;
    if (src) this.setAttribute("src", src);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "src") {
      this.src = String(value);
      FakeVideo.onSetSrc?.(this);
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    this.listeners.push({ type, listener });
  }

  play() {
    this.playCount += 1;
    return { catch() {} };
  }

  pause() {
    this.pauseCount += 1;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.removeChild(this);
  }

  replaceWith(node) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children[index] = node;
    this.parentElement = null;
    this.isConnected = false;
    node.parentElement = parent;
    node.isConnected = parent.isConnected;
  }
}

class FakeRoot {
  constructor(children = []) {
    this.children = [];
    this.dataset = {};
    this.style = { cssText: "" };
    this.isConnected = true;
    children.forEach((child) => this.prepend(child));
    this.children.reverse();
  }

  get childNodes() {
    return this.children;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-avatar-media]") {
      return this.children.filter((node) => node.dataset?.avatarMedia);
    }
    if (selector !== "video.avatar-video" && selector !== ":scope > .avatar-video" && selector !== ".avatar-video") {
      return [];
    }
    return this.children.filter((node) => node.className === "avatar-video");
  }

  prepend(node) {
    if (node.parentElement) node.parentElement.removeChild(node);
    this.children.unshift(node);
    node.parentElement = this;
    node.isConnected = this.isConnected;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentElement = null;
    node.isConnected = false;
  }
}

function loadAvatarVideoHelpers() {
  const sandbox = {
    document: { createElement: () => new FakeVideo() },
    FakeVideo,
    globalThis: {}
  };
  vm.runInNewContext(`
    const avatarMedia = {
      isVideo: (src) => /\\.mp4$/i.test(String(src || "")),
      trimFromCrop: (crop = {}) => ({
        start: Number(crop.start ?? 0) || 0,
        duration: Number(crop.duration ?? 3) || 3
      })
    };
    function normalizeAvatarUrl(value) {
      return String(value || "").trim();
    }
    function isPublicImageSrc(value) {
      return /^\\/api\\/files\\//.test(String(value || ""));
    }
    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    const webNormalizeAvatarCrop = (crop = {}) => ({ ...(crop || {}) });
    ${extractFunctionSource("avatarVideoStyle")}
    const parkedAvatarVideos = new Map();
    ${extractFunctionSource("avatarMediaAttrs")}
    ${extractFunctionSource("parseAvatarCrop")}
    ${extractFunctionSource("registerAvatarVideo")}
    ${extractFunctionSource("adoptParkedAvatarVideo")}
    ${extractFunctionSource("assignAvatarVideoSrc")}
    ${extractFunctionSource("applyAvatarVideoAttributes")}
    ${extractFunctionSource("createAvatarVideoElement")}
    ${extractFunctionSource("copyAvatarVideoAttributes")}
    ${extractFunctionSource("removeAvatarChildrenExcept")}
    ${extractFunctionSource("removeAvatarVideos")}
    ${extractFunctionSource("avatarVideoSrc")}
    ${extractFunctionSource("isTrimmedAvatarAssetSrc")}
    ${extractFunctionSource("isTrimmedAvatarAssetVideo")}
    ${extractFunctionSource("hasReadyAvatarMetadata")}
    ${extractFunctionSource("shouldDelayAvatarVideoPlay")}
    ${extractFunctionSource("playAvatarVideo")}
    ${extractFunctionSource("syncAvatarVideo")}
    ${extractFunctionSource("ensureAvatarVideoSynced")}
    ${extractFunctionSource("hydrateAvatarMedia")}
    ${extractFunctionSource("hydrateAvatarVideos")}
    ${extractFunctionSource("applyAvatarMedia")}
    globalThis.avatarVideoHelpers = {
      applyAvatarMedia,
      hydrateAvatarVideos,
      registerAvatarVideo,
      syncAvatarVideo
    };
  `, sandbox);
  return sandbox.globalThis.avatarVideoHelpers;
}

test("web avatar videos are parked so innerHTML rebuilds can reuse playback state", () => {
  assert.match(source, /const parkedAvatarVideos = new Map\(\)/);
  assert.match(source, /function registerAvatarVideo\(src, video\)/);
  assert.match(source, /function adoptParkedAvatarVideo\(src\)/);
  assert.match(source, /function hydrateAvatarMedia\(root = document\)/);

  const hydrateAvatarVideos = extractFunctionSource("hydrateAvatarVideos");
  assert.match(
    hydrateAvatarVideos,
    /hydrateAvatarMedia\(root\)/,
    "video hydration must first mount data-avatar-media placeholders through applyAvatarMedia"
  );
  assert.match(
    hydrateAvatarVideos,
    /adoptParkedAvatarVideo\(src\)/,
    "hydration must look for a detached video with the same src"
  );
  assert.match(
    hydrateAvatarVideos,
    /\.replaceWith\(/,
    "hydration must replace fresh innerHTML-created videos with parked videos"
  );
  assert.match(
    hydrateAvatarVideos,
    /registerAvatarVideo\(src, video\)/,
    "hydration must keep every rendered video registered for the next rebuild"
  );
});

test("web avatar HTML defers video mounting until hydration", () => {
  const avatarHtml = extractFunctionSource("avatarHtml");
  const avatarMediaAttrs = extractFunctionSource("avatarMediaAttrs");
  assert.match(avatarMediaAttrs, /data-avatar-media/);
  assert.match(
    avatarHtml,
    /avatarMediaAttrs\(image, crop \|\| \{\}, color, text\)/,
    "video avatar markup must carry hydration data instead of an autoplaying video"
  );
  assert.doesNotMatch(
    avatarHtml,
    /avatarVideoHtml\(image, crop \|\| \{\}\)/,
    "innerHTML-rendered avatar markup must not create a fresh autoplaying video"
  );
});

test("applyAvatarMedia adopts parked web avatar videos instead of recreating them", () => {
  const applyAvatarMedia = extractFunctionSource("applyAvatarMedia");
  assert.match(
    applyAvatarMedia,
    /adoptParkedAvatarVideo\(src\)/,
    "single-slot avatar updates must reuse a detached video when the src matches"
  );
  assert.doesNotMatch(
    applyAvatarMedia,
    /querySelectorAll\?\.\("\\.avatar-video"\)\?\.\forEach\(\(node\) => node\.remove\(\)\)/,
    "applyAvatarMedia must not remove all videos before deciding whether the avatar is still the same video"
  );
});

test("hydrateAvatarVideos replaces fresh rebuilt videos with parked nodes", () => {
  const helpers = loadAvatarVideoHelpers();
  const src = "/api/files/avatar.mp4";
  const parked = new FakeVideo(src);
  parked.dataset.avatarHydrated = "true";
  parked.currentTime = 2.4;
  helpers.registerAvatarVideo(src, parked);

  const fresh = new FakeVideo(src);
  fresh.dataset.avatarStart = "0";
  fresh.dataset.avatarDuration = "3";
  const root = new FakeRoot([fresh]);

  helpers.hydrateAvatarVideos(root);

  assert.equal(root.children[0], parked);
  assert.equal(parked.currentTime, 2.4);
  assert.equal(fresh.isConnected, false);
  assert.equal(parked.isConnected, true);
});

test("applyAvatarMedia keeps the current web video node for same-slot updates", () => {
  const helpers = loadAvatarVideoHelpers();
  const root = new FakeRoot();
  const src = "/api/files/avatar.mp4";

  helpers.applyAvatarMedia(root, src, { start: 0, duration: 3 }, "#5e5ce6", "A");
  const firstVideo = root.children[0];
  firstVideo.currentTime = 1.7;
  helpers.applyAvatarMedia(root, src, { start: 0, duration: 3 }, "#5e5ce6", "A");

  assert.equal(root.children[0], firstVideo);
  assert.equal(root.children[0].currentTime, 1.7);
});

test("hydrateAvatarVideos mounts video placeholders without throwaway autoplay markup", () => {
  const helpers = loadAvatarVideoHelpers();
  const root = new FakeRoot();
  root.dataset = {
    avatarMedia: "1",
    avatarImage: "/api/files/avatar.mp4",
    avatarCrop: JSON.stringify({ start: 0, duration: 3 }),
    avatarColor: "#5e5ce6",
    avatarText: "A"
  };
  root.matches = (selector) => selector === "[data-avatar-media]";

  helpers.hydrateAvatarVideos(root);

  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].getAttribute("src"), "/api/files/avatar.mp4");
});

test("web avatar videos loop from zero when the asset is already trimmed", () => {
  const helpers = loadAvatarVideoHelpers();
  const video = new FakeVideo("/api/avatar-assets/abc.avatar.mp4");
  const seeks = [];
  let currentTime = 4.96;
  Object.defineProperty(video, "currentTime", {
    get() { return currentTime; },
    set(value) {
      seeks.push(value);
      currentTime = value;
    }
  });
  video.duration = 5.004;
  video.dataset.avatarStart = "7.26";
  video.dataset.avatarDuration = "4.94";

  helpers.syncAvatarVideo(video);
  video.listeners.find(({ type }) => type === "timeupdate").listener();

  assert.deepEqual(seeks, [0]);
});

test("web avatar videos keep the selected trim for ordinary video sources", () => {
  const helpers = loadAvatarVideoHelpers();
  const video = new FakeVideo("/api/files/avatar.mp4");
  const seeks = [];
  let currentTime = 2;
  Object.defineProperty(video, "currentTime", {
    get() { return currentTime; },
    set(value) {
      seeks.push(value);
      currentTime = value;
    }
  });
  video.duration = 5.004;
  video.dataset.avatarStart = "7.26";
  video.dataset.avatarDuration = "4.94";

  helpers.syncAvatarVideo(video);
  video.listeners.find(({ type }) => type === "loadedmetadata").listener();

  assert.equal(seeks.length, 1);
  assert.ok(Math.abs(seeks[0] - 4.904) < 0.0001);
});

test("web avatar videos do not autoplay from zero before a nonzero trim can seek", () => {
  const helpers = loadAvatarVideoHelpers();
  const video = new FakeVideo("/api/files/avatar.mp4");
  const seeks = [];
  let currentTime = 0;
  let duration = NaN;
  let readyState = 0;
  Object.defineProperty(video, "currentTime", {
    get() { return currentTime; },
    set(value) {
      seeks.push(value);
      currentTime = value;
    }
  });
  Object.defineProperty(video, "duration", {
    get() { return duration; },
    set(value) { duration = value; }
  });
  Object.defineProperty(video, "readyState", {
    get() { return readyState; },
    set(value) { readyState = value; }
  });
  video.dataset.avatarStart = "2.5";
  video.dataset.avatarDuration = "3";

  helpers.syncAvatarVideo(video);

  assert.equal(video.playCount, 0);
  assert.equal(video.pauseCount, 1);
  assert.deepEqual(seeks, []);

  duration = 12;
  readyState = 1;
  video.listeners.find(({ type }) => type === "loadedmetadata").listener();

  assert.deepEqual(seeks, [2.5]);
  assert.equal(video.playCount, 1);
});

test("web avatar videos wait for fresh metadata after the source changes", () => {
  const helpers = loadAvatarVideoHelpers();
  const root = new FakeRoot();

  helpers.applyAvatarMedia(root, "/api/files/old.mp4", { start: 0, duration: 3 }, "#5e5ce6", "A");
  const video = root.children[0];
  const seeks = [];
  let currentTime = 0;
  Object.defineProperty(video, "currentTime", {
    get() { return currentTime; },
    set(value) {
      seeks.push(value);
      currentTime = value;
    }
  });
  video.readyState = 2;
  video.duration = 12;
  video.playCount = 0;
  video.pauseCount = 0;

  helpers.applyAvatarMedia(root, "/api/files/new.mp4", { start: 5.9, duration: 4 }, "#5e5ce6", "A");

  assert.equal(root.children[0], video);
  assert.equal(video.getAttribute("src"), "/api/files/new.mp4");
  assert.equal(video.playCount, 0);
  assert.ok(video.pauseCount >= 1);
  assert.deepEqual(seeks, []);

  video.readyState = 1;
  video.duration = 12;
  video.listeners.find(({ type }) => type === "loadedmetadata").listener();

  assert.deepEqual(seeks, [5.9]);
  assert.equal(video.playCount, 1);
});

test("web avatar videos attach trim metadata handlers before assigning a new source", () => {
  const helpers = loadAvatarVideoHelpers();
  const root = new FakeRoot();
  const seeks = [];
  let targetVideo = null;

  FakeVideo.onSetSrc = (video) => {
    targetVideo = video;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get() { return 0; },
      set(value) { seeks.push(value); }
    });
    video.duration = 12;
    video.readyState = 1;
    video.listeners.find(({ type }) => type === "loadedmetadata")?.listener();
  };
  try {
    helpers.applyAvatarMedia(root, "/api/files/new.mp4", { start: 5.9, duration: 4 }, "#5e5ce6", "A");
  } finally {
    FakeVideo.onSetSrc = null;
  }

  assert.equal(root.children[0], targetVideo);
  assert.deepEqual(seeks, [5.9]);
  assert.equal(targetVideo.dataset.avatarPendingTrimSeek, undefined);
});
