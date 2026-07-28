const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  estimateValueBytes,
  pruneMap,
  touchMapValue,
  trimRecentItems
} = require("../src/renderer/resource-cache.js");

test("bounded map eviction keeps active resources and least-recently touched order", () => {
  const cache = new Map([
    ["old", { bytes: 4 }],
    ["active", { bytes: 4 }],
    ["recent", { bytes: 4 }]
  ]);

  touchMapValue(cache, "old");
  const evicted = pruneMap(cache, {
    maxEntries: 2,
    protectedKeys: ["active"]
  });

  assert.deepEqual(evicted.map(([key]) => key), ["recent"]);
  assert.deepEqual([...cache.keys()], ["active", "old"]);
});

test("message trimming keeps recent history plus transient local messages", () => {
  const messages = [
    { id: "pending", _localPending: true },
    { id: "old-1" },
    { id: "old-2" },
    { id: "new-1" },
    { id: "new-2" }
  ];

  const trimmed = trimRecentItems(messages, {
    maxEntries: 3,
    isProtected: (message) => message._localPending
  });

  assert.deepEqual(trimmed.map((message) => message.id), ["pending", "new-1", "new-2"]);
});

test("data URL weight estimation reflects decoded payload size", () => {
  const bytes = estimateValueBytes({ thumbnailDataUrl: `data:image/png;base64,${"A".repeat(400)}` });
  assert.ok(bytes >= 300);
  assert.ok(bytes < 500);
});
