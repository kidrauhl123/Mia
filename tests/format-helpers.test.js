const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadFormatHelpers() {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "helpers", "format-helpers.js"), "utf8");
  const window = {};
  vm.runInNewContext(source, { window, globalThis: window });
  return window.miaFormat;
}

test("attachmentGlyph uses specific labels for common document formats", () => {
  const format = loadFormatHelpers();

  assert.equal(format.attachmentGlyph({ name: "业务信息调查表.docx", kind: "file" }), "DOC");
  assert.equal(format.attachmentGlyph({ name: "赛果.xlsx", kind: "file" }), "XLS");
  assert.equal(format.attachmentGlyph({ name: "方案.pptx", kind: "file" }), "PPT");
  assert.equal(format.attachmentGlyph({ name: "资料.zip", kind: "file" }), "ZIP");
  assert.equal(format.attachmentGlyph({ name: "records.json", kind: "file" }), "JSON");
});
