const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeMessageSkills } = require("../scripts/serve-cloud.js");

test("sanitizeMessageSkills keeps colon-form skill ids (mia:trip-planner)", () => {
  // Regression: skill ids are "<libraryId>:<id>". An earlier pattern rejected
  // the colon, so every chip got dropped server-side (stored skills_json=null).
  assert.deepEqual(
    sanitizeMessageSkills([{ id: "mia:trip-planner", name: "行程" }, { id: "mia:weekly-report", name: "周报" }]),
    [{ id: "mia:trip-planner", name: "行程" }, { id: "mia:weekly-report", name: "周报" }]
  );
});

test("sanitizeMessageSkills caps, dedupes, rejects bad ids, and defaults name to id", () => {
  assert.equal(sanitizeMessageSkills(null), null);
  assert.equal(sanitizeMessageSkills([]), null);
  assert.equal(sanitizeMessageSkills([{ id: "bad id with spaces" }]), null);
  assert.deepEqual(sanitizeMessageSkills([{ id: "mia:x" }]), [{ id: "mia:x", name: "mia:x" }]);
  assert.deepEqual(
    sanitizeMessageSkills([{ id: "mia:x", name: "X" }, { id: "mia:x", name: "dupe" }]),
    [{ id: "mia:x", name: "X" }]
  );
  assert.equal(sanitizeMessageSkills(Array.from({ length: 30 }, (_, i) => ({ id: `mia:s${i}` }))).length, 16);
});
