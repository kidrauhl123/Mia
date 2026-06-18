const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  fileEditPayloadFromUnifiedDiff,
  fileEditPayloadsFromAcpContent,
  fileEditPayloadsFromToolPayload,
  unifiedDiffFromTextPair
} = require("../src/main/agent-file-edit-events.js");

test("unifiedDiffFromTextPair renders ACP old/new text as a file diff", () => {
  const diff = unifiedDiffFromTextPair({
    path: "src/app.js",
    oldText: "old\nsame",
    newText: "new\nsame"
  });

  assert.equal(diff, [
    "diff --git a/src/app.js b/src/app.js",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " same"
  ].join("\n"));
});

test("unifiedDiffFromTextPair keeps nearby context and omits distant unchanged lines", () => {
  const diff = unifiedDiffFromTextPair({
    path: "src/app.js",
    oldText: [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7"
    ].join("\n"),
    newText: [
      "line 1",
      "line 2",
      "line 3",
      "changed 4",
      "line 5",
      "line 6",
      "line 7"
    ].join("\n")
  });

  assert.equal(diff, [
    "diff --git a/src/app.js b/src/app.js",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1,7 +1,7 @@",
    " line 1",
    " line 2",
    " line 3",
    "-line 4",
    "+changed 4",
    " line 5",
    " line 6",
    " line 7"
  ].join("\n"));

  const longer = unifiedDiffFromTextPair({
    path: "src/app.js",
    oldText: Array.from({ length: 12 }, (_, idx) => `line ${idx + 1}`).join("\n"),
    newText: Array.from({ length: 12 }, (_, idx) => idx === 6 ? "changed 7" : `line ${idx + 1}`).join("\n")
  });
  assert.doesNotMatch(longer, / line 1\n/);
  assert.match(longer, / line 4\n/);
  assert.match(longer, / line 10$/);
});

test("fileEditPayloadFromUnifiedDiff extracts path stats and title", () => {
  assert.deepEqual(fileEditPayloadFromUnifiedDiff([
    "diff --git a/src/app.js b/src/app.js",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new"
  ].join("\n"), { id: "edit_1", status: "completed" }), {
    id: "edit_1",
    path: "src/app.js",
    action: "update",
    title: "Edited src/app.js (+1 -1)",
    diff: [
      "diff --git a/src/app.js b/src/app.js",
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new"
    ].join("\n"),
    additions: 1,
    deletions: 1,
    status: "completed",
    error: false
  });
});

test("fileEditPayloadsFromAcpContent maps AION ACP diff content items", () => {
  assert.deepEqual(fileEditPayloadsFromAcpContent([
    { type: "text", text: "done" },
    { type: "diff", path: "src/app.js", old_text: "old", new_text: "new" }
  ], { idPrefix: "tool_1", status: "completed" }), [{
    id: "tool_1_diff_0",
    path: "src/app.js",
    action: "update",
    title: "Edited src/app.js (+1 -1)",
    diff: [
      "diff --git a/src/app.js b/src/app.js",
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new"
    ].join("\n"),
    additions: 1,
    deletions: 1,
    status: "completed",
    error: false
  }]);
});

test("fileEditPayloadsFromToolPayload reads result_display file diffs", () => {
  assert.deepEqual(fileEditPayloadsFromToolPayload({
    result_display: {
      file_diff: {
        path: "src/app.js",
        diff: "@@\n-old\n+new"
      }
    }
  }, { idPrefix: "tool_1", status: "completed" }), [{
    id: "tool_1_diff_0",
    path: "src/app.js",
    action: "update",
    title: "Edited src/app.js (+1 -1)",
    diff: "@@\n-old\n+new",
    additions: 1,
    deletions: 1,
    status: "completed",
    error: false
  }]);
});
