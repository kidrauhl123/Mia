const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

test("window resize work is coalesced to one animation frame", () => {
  const source = read("src/renderer/app.js");
  const schedulerStart = source.indexOf("function scheduleWindowResizeLayout()");
  const schedulerEnd = source.indexOf('window.addEventListener("resize", scheduleWindowResizeLayout)', schedulerStart);
  const scheduler = source.slice(schedulerStart, schedulerEnd);

  assert.ok(schedulerStart >= 0, "resize scheduler should exist");
  assert.ok(schedulerEnd > schedulerStart, "resize listener should use the scheduler");
  assert.match(scheduler, /if \(windowResizeFrame\) return;/);
  assert.match(scheduler, /windowResizeFrame = window\.requestAnimationFrame\(syncWindowResizeLayout\);/);
  assert.doesNotMatch(source, /window\.addEventListener\("resize", \(\) => \{\s*const overlayTarget/);
});

test("continuous paint effects pause while the native window is resizing", () => {
  const source = read("src/renderer/app.js");
  const styles = read("src/renderer/styles.css");

  assert.match(source, /document\.body\.classList\.add\("window-resizing"\)/);
  assert.match(source, /document\.body\.classList\.remove\("window-resizing"\)/);
  assert.match(styles, /body\.window-resizing \.agent-run-status\.is-loading \.agent-run-status-label/);
  assert.match(styles, /body\.window-resizing \.typing-dots i/);
  assert.match(styles, /animation-play-state:\s*paused !important;/);
});

test("unchanged sidebar width does not rewrite the root style", () => {
  const source = read("src/renderer/app.js");
  const start = source.indexOf("function applySidebarWidth");
  const end = source.indexOf("\n}\n", start) + 2;
  const body = source.slice(start, end);

  assert.match(body, /getPropertyValue\("--sidebar-width"\) !== cssWidth/);
  assert.match(body, /setProperty\("--sidebar-width", cssWidth\)/);
});
