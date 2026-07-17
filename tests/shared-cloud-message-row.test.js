const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeCloudMessageFields,
  parseJson,
} = require("../packages/shared/cloud-message-row.js");

test("normalizes the real *_json fields returned by the cloud message API", () => {
  const fields = normalizeCloudMessageFields({
    attachments_json: JSON.stringify([{ id: "f1", name: "shot.png" }]),
    mentions_json: JSON.stringify([{ kind: "bot", ref: "bot_mia" }]),
    skills_json: JSON.stringify([{ id: "search" }]),
    content_blocks_json: JSON.stringify([{ type: "text", text: "done" }]),
    trace_json: JSON.stringify({ reasoning: "checked" }),
  });

  assert.deepEqual(fields.attachments, [{ id: "f1", name: "shot.png" }]);
  assert.deepEqual(fields.mentions, [{ kind: "bot", ref: "bot_mia" }]);
  assert.deepEqual(fields.skills, [{ id: "search" }]);
  assert.deepEqual(fields.contentBlocks, [{ type: "text", text: "done" }]);
  assert.deepEqual(fields.trace, { reasoning: "checked" });
});

test("direct decoded fields win and malformed JSON safely falls back", () => {
  const fields = normalizeCloudMessageFields({
    attachments: [{ id: "direct" }],
    attachments_json: "not-json",
    mentions_json: "{bad",
    trace_json: "[]",
  });
  assert.deepEqual(fields.attachments, [{ id: "direct" }]);
  assert.deepEqual(fields.mentions, []);
  assert.equal(fields.trace, null);
  assert.deepEqual(parseJson("[1,2]", []), [1, 2]);
});

test("an empty compatibility alias does not shadow populated server JSON", () => {
  const fields = normalizeCloudMessageFields({
    attachments: [],
    attachments_json: JSON.stringify([{ id: "real" }]),
    contentBlocks: [],
    content_blocks_json: JSON.stringify([{ type: "text", text: "real" }]),
  });
  assert.deepEqual(fields.attachments, [{ id: "real" }]);
  assert.deepEqual(fields.contentBlocks, [{ type: "text", text: "real" }]);
});
