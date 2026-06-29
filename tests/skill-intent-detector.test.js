const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  XLSX_SKILL_ID,
  hasSpreadsheetDeliverableIntent,
  intentSkillIdsForMessages,
  latestUserText
} = require("../src/shared/skill-intent-detector.js");

test("latestUserText reads the current user turn only", () => {
  assert.equal(latestUserText([
    { role: "user", content: "old" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "new" }
  ]), "new");
});

test("spreadsheet intent detector matches explicit Excel deliverables", () => {
  assert.equal(hasSpreadsheetDeliverableIntent("给我生成一个写着2026年世界杯小组赛战果的Excel"), true);
  assert.equal(hasSpreadsheetDeliverableIntent("export this as a .xlsx workbook"), true);
  assert.equal(hasSpreadsheetDeliverableIntent("整理成 CSV 文件"), true);
  assert.equal(hasSpreadsheetDeliverableIntent("你知道世界杯吗"), false);
});

test("intentSkillIdsForMessages loads xlsx for Excel requests", () => {
  assert.deepEqual(intentSkillIdsForMessages([
    { role: "user", content: "给我生成一个 Excel 文件" }
  ]), [XLSX_SKILL_ID]);
  assert.deepEqual(intentSkillIdsForMessages([
    { role: "user", content: "哪里有啊" }
  ]), []);
});
