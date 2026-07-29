"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadWebAppearance() {
  const source = fs.readFileSync(path.join(ROOT, "src/web/appearance.js"), "utf8");
  const values = new Map();
  const storage = new Map();
  const documentElement = {
    dataset: {},
    style: {
      setProperty(name, value) { values.set(name, String(value)); },
      removeProperty(name) { values.delete(name); },
      getPropertyValue(name) { return values.get(name) || ""; }
    }
  };
  const sandbox = {
    console,
    JSON,
    document: { documentElement },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    window: {}
  };
  vm.runInNewContext(source, sandbox, { filename: "web-appearance.js" });
  return { appearance: sandbox.window.miaAppearance, documentElement };
}

test("web appearance chooses contrasting text for light and dark user bubbles", () => {
  const { appearance, documentElement } = loadWebAppearance();

  assert.equal(documentElement.style.getPropertyValue("--user-bubble-color"), "#eeffde");
  assert.equal(documentElement.style.getPropertyValue("--user-bubble-text"), "rgba(0, 0, 0, 0.90)");

  appearance.update({ userBubbleColor: "#123456" });
  assert.equal(documentElement.style.getPropertyValue("--user-bubble-color"), "#123456");
  assert.equal(documentElement.style.getPropertyValue("--user-bubble-text"), "#ffffff");
});

test("web user bubble CSS uses the computed contrast variable", () => {
  const css = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");

  assert.match(css, /\.chat \.message\.user \.bubble\s*\{[^}]*color:\s*var\(--user-bubble-text,\s*var\(--text\)\);/s);
  assert.match(css, /\.message\.user \.bubble\s*\{[^}]*color:\s*var\(--user-bubble-text,\s*#fff\);/s);
});
