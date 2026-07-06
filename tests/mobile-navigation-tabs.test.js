const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("messages home screen does not wrap ConversationListScreen in tab-bar visibility effect", () => {
  const source = fs.readFileSync(path.join(root, "apps/mobile-rn/src/navigation/Tabs.tsx"), "utf8");

  assert.doesNotMatch(source, /const ConversationListWithTabBar = withTabBarVisibility\(ConversationListScreen,\s*true\);/);
  assert.match(source, /name="Conversations"[\s\S]*component=\{ConversationListScreen\}/);
});
