const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

test("renderer app shell loads state module before the entrypoint", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(html, /<script src="\.\/app-state\.js"><\/script>[\s\S]*<script src="\.\/app\.js"><\/script>/);
  assert.match(appSource, /window\.aimashiAppState\.createInitialState/);
  assert.doesNotMatch(appSource, /const state = \{/);
  assert.doesNotMatch(appSource, /const fallbackSlashCommands = \[/);
});

test("logged-in message list uses social rows instead of local fellow rows", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /cloudSignedIn\s*\?\s*\[\]\s*:\s*visiblePersonas\.map/s);
});

test("fellow cloud rooms are not hidden from the sidebar", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.doesNotMatch(appSource, /if\s*\(\s*isFellow\s*\)\s*return\s+null/);
});

test("renderer app state factory owns default mutable state", () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/app-state.js"), "utf8");
  const localStorage = {
    getItem(key) {
      if (key === "aimashi.setupGuideDismissed.v2") return "1";
      if (key === "aimashi.onboardingStep") return "model";
      return "";
    }
  };
  const sandbox = {
    window: { aimashiAppState: null, innerWidth: 640, localStorage },
    localStorage,
    Set,
    Map
  };
  vm.runInNewContext(source, sandbox);

  const state = sandbox.window.aimashiAppState.createInitialState({
    localStorage,
    sidebarWidth: 300,
    windowWidth: 640
  });

  assert.equal(state.setupGuideDismissed, true);
  assert.equal(state.onboardingStep, "model");
  assert.equal(state.isNarrowWindow, true);
  assert.equal(state.sidebarWidth, 300);
  assert.equal(state.slashCommands[0].command, "/new");
  assert.notEqual(state.slashCommands, sandbox.window.aimashiAppState.fallbackSlashCommands);
});
