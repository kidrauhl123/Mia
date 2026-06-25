const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${functionName}`);
}

test("search result focus enters chat view before rendering the target conversation", () => {
  const appSource = fs.readFileSync(path.join(root, "src", "renderer", "app.js"), "utf8");
  const fn = extractFunctionSource(appSource, "openConversationSearchResult");
  const activeViewIndex = fn.indexOf('state.activeView = "chat"');
  const showContentIndex = fn.indexOf("showNarrowContent()");
  const focusIndex = fn.indexOf("focusConversationMessage");

  assert.ok(activeViewIndex >= 0, "search result clicks must switch into chat view");
  assert.ok(showContentIndex > activeViewIndex, "chat view must be active before narrow content sync");
  assert.ok(focusIndex > activeViewIndex, "chat view must be active before message focus starts");
});
