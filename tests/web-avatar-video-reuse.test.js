const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");

function extractFunctionSource(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  const open = source.indexOf("{", start);
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

test("web avatar videos are parked so innerHTML rebuilds can reuse playback state", () => {
  assert.match(source, /const parkedAvatarVideos = new Map\(\)/);
  assert.match(source, /function registerAvatarVideo\(src, video\)/);
  assert.match(source, /function adoptParkedAvatarVideo\(src\)/);

  const hydrateAvatarVideos = extractFunctionSource("hydrateAvatarVideos");
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
