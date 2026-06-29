"use strict";

const XLSX_SKILL_ID = "mia-official:xlsx";

function cleanText(value = "") {
  return String(value || "").trim();
}

function latestUserText(messages = []) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    return cleanText(message.content || message.text || "");
  }
  return "";
}

function hasSpreadsheetDeliverableIntent(text = "") {
  const value = cleanText(text);
  if (!value) return false;
  return /(?:\.xlsx|\.xlsm|\.xls|\.csv|\.tsv)\b/i.test(value)
    || /\b(?:xlsx|xlsm|excel|spreadsheet|workbook|csv|tsv)\b/i.test(value)
    || /(?:生成|创建|做|制作|导出|整理|写|给我|保存).{0,24}(?:Excel|表格|工作簿|电子表格|xlsx|csv|tsv)/i.test(value)
    || /(?:Excel|表格|工作簿|电子表格|xlsx|csv|tsv).{0,24}(?:文件|表|清单|报表|数据|结果)/i.test(value);
}

function intentSkillIdsForMessages(messages = []) {
  const ids = [];
  const text = latestUserText(messages);
  if (hasSpreadsheetDeliverableIntent(text)) ids.push(XLSX_SKILL_ID);
  return ids;
}

module.exports = {
  XLSX_SKILL_ID,
  hasSpreadsheetDeliverableIntent,
  intentSkillIdsForMessages,
  latestUserText
};
