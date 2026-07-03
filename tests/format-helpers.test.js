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

test("attachmentVisualType groups common files into stable card variants", () => {
  const format = loadFormatHelpers();

  assert.equal(format.attachmentVisualType({ name: "业务信息调查表.docx", kind: "file" }), "doc");
  assert.equal(format.attachmentVisualType({ name: "赛果.xlsx", kind: "file" }), "xls");
  assert.equal(format.attachmentVisualType({ name: "方案.pptx", kind: "file" }), "ppt");
  assert.equal(format.attachmentVisualType({ name: "资料.pdf", kind: "file" }), "pdf");
  assert.equal(format.attachmentVisualType({ name: "压缩包.zip", kind: "file" }), "zip");
  assert.equal(format.attachmentVisualType({ name: "records.json", kind: "file" }), "json");
  assert.equal(format.attachmentVisualType({ name: "README.md", kind: "file" }), "md");
  assert.equal(format.attachmentVisualType({ name: "agent.ts", kind: "file" }), "code");
  assert.equal(format.attachmentVisualType({ name: "notes.txt", kind: "file" }), "txt");
});

test("attachmentIconName maps common formats onto iconpacks asset names", () => {
  const format = loadFormatHelpers();

  assert.equal(format.attachmentIconName({ name: "业务信息调查表.docx", kind: "file" }), "doc");
  assert.equal(format.attachmentIconName({ name: "赛果.xlsx", kind: "file" }), "xls");
  assert.equal(format.attachmentIconName({ name: "明细.csv", kind: "file" }), "xls");
  assert.equal(format.attachmentIconName({ name: "方案.pptx", kind: "file" }), "ppt");
  assert.equal(format.attachmentIconName({ name: "资料.pdf", kind: "file" }), "pdf");
  assert.equal(format.attachmentIconName({ name: "压缩包.zip", kind: "file" }), "zip");
  assert.equal(format.attachmentIconName({ name: "records.json", kind: "file" }), "json");
  assert.equal(format.attachmentIconName({ name: "agent.ts", kind: "file" }), "code");
  assert.equal(format.attachmentIconName({ name: "notes.txt", kind: "file" }), "txt");
  assert.equal(format.attachmentIconName({ name: "unknown.bin", kind: "file" }), "file");
});
