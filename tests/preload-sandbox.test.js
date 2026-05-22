const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("desktop preload can load local shared contracts", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");

  assert.match(preloadSource, /require\("\.\/shared\/ipc-channels"\)/);
  assert.match(mainSource, /preload: path\.join\(__dirname, "preload\.js"\)[\s\S]*sandbox: false/);
});
