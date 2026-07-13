const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const modulePath = path.join(__dirname, "..", "src", "renderer", "helpers", "avatar-thumbnail.js");

function loadAvatarThumbnails({ imageWidth = 2000, imageHeight = 1000, failImage = false } = {}) {
  assert.equal(fs.existsSync(modulePath), true, "avatar thumbnail module must exist");
  const drawCalls = [];
  let imageLoads = 0;

  class TestImage {
    constructor() {
      this.naturalWidth = imageWidth;
      this.naturalHeight = imageHeight;
      this.width = imageWidth;
      this.height = imageHeight;
    }

    set src(value) {
      this._src = value;
      imageLoads += 1;
      queueMicrotask(() => failImage ? this.onerror?.() : this.onload?.());
    }
  }

  const context2d = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    clearRect() {},
    drawImage(...args) { drawCalls.push(args); }
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return {
        width: 0,
        height: 0,
        getContext(kind) {
          assert.equal(kind, "2d");
          return context2d;
        },
        toDataURL(type) {
          assert.equal(type, "image/png");
          return "data:image/png;base64,thumbnail";
        }
      };
    }
  };
  const window = { Image: TestImage };
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    Image: TestImage,
    queueMicrotask,
    console,
    Promise,
    Map,
    Math,
    Number,
    String
  });
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), context, { filename: modulePath });
  return {
    thumbnails: window.miaAvatarThumbnails,
    drawCalls,
    context2d,
    imageLoads: () => imageLoads
  };
}

test("avatar thumbnail crop matches object-fit cover and the saved crop", () => {
  const { thumbnails } = loadAvatarThumbnails();

  assert.deepEqual(
    { ...thumbnails.thumbnailSourceRect(2000, 1000, { x: 50, y: 50, zoom: 1 }) },
    { x: 500, y: 0, width: 1000, height: 1000 }
  );
  assert.deepEqual(
    { ...thumbnails.thumbnailSourceRect(1000, 1000, { x: 100, y: 0, zoom: 1.25 }) },
    { x: 200, y: 0, width: 800, height: 800 }
  );
});

test("avatar thumbnails only rasterize still bitmap sources", () => {
  const { thumbnails } = loadAvatarThumbnails();

  assert.equal(thumbnails.supportsThumbnail("data:image/png;base64,AAAA"), true);
  assert.equal(thumbnails.supportsThumbnail("file:///avatar.jpg"), true);
  assert.equal(thumbnails.supportsThumbnail("data:image/svg+xml,%3Csvg%3E"), false);
  assert.equal(thumbnails.supportsThumbnail("file:///avatar.gif"), false);
  assert.equal(thumbnails.supportsThumbnail("file:///avatar.mp4"), false);
  assert.equal(thumbnails.supportsThumbnail("emoji:books"), false);
});

test("avatar thumbnail rendering bakes the crop with high-quality smoothing and caches it", async () => {
  const { thumbnails, drawCalls, context2d, imageLoads } = loadAvatarThumbnails();
  const src = "data:image/jpeg;base64,photo";
  const crop = { x: 50, y: 50, zoom: 1.25 };

  const first = await thumbnails.renderThumbnail(src, crop);
  const second = await thumbnails.renderThumbnail(src, crop);

  assert.equal(first, "data:image/png;base64,thumbnail");
  assert.equal(second, first);
  assert.equal(imageLoads(), 1, "same source and crop should decode once");
  assert.equal(drawCalls.length, 1, "same source and crop should rasterize once");
  assert.equal(context2d.imageSmoothingEnabled, true);
  assert.equal(context2d.imageSmoothingQuality, "high");
  assert.deepEqual(drawCalls[0].slice(1), [600, 100, 800, 800, 0, 0, 256, 256]);
  assert.equal(thumbnails.cachedThumbnail(src, crop), first);
});

test("avatar thumbnail failures keep using the original without repeated decode attempts", async () => {
  const { thumbnails, imageLoads } = loadAvatarThumbnails({ failImage: true });
  const src = "https://cdn.example.test/avatar";

  assert.equal(await thumbnails.renderThumbnail(src), "");
  assert.equal(await thumbnails.renderThumbnail(src), "");
  assert.equal(imageLoads(), 1);
  assert.equal(thumbnails.cachedThumbnail(src), "");
});
