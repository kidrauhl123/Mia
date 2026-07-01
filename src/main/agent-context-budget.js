"use strict";

function cleanText(value = "") {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    for (const key of ["text", "content", "body", "message", "input"]) {
      const text = cleanText(value[key]);
      if (text) return text;
    }
  }
  return String(value || "");
}

function textCharCount(value = "") {
  return cleanText(value).length;
}

function messageText(message = {}) {
  if (!message || typeof message !== "object") return "";
  return cleanText(message.content != null ? message.content : message.text);
}

function messageTextChars(message = {}) {
  return messageText(message).length;
}

function messagesTextChars(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((sum, message) => sum + messageTextChars(message), 0);
}

function messageAttachmentStats(message = {}) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  let bytes = 0;
  for (const attachment of attachments) {
    const size = Number(
      attachment?.bytes
      || attachment?.byteLength
      || attachment?.size
      || attachment?.fileSize
      || 0
    );
    if (Number.isFinite(size) && size > 0) bytes += size;
  }
  return { count: attachments.length, bytes };
}

function messagesAttachmentStats(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((stats, message) => {
      const item = messageAttachmentStats(message);
      stats.count += item.count;
      stats.bytes += item.bytes;
      return stats;
    }, { count: 0, bytes: 0 });
}

function safeFieldValue(value = "") {
  return String(value == null ? "" : value)
    .replace(/\s+/g, "_")
    .replace(/[^\w:./@-]/g, "_")
    .slice(0, 160);
}

function numeric(value = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function buildContextBudgetLogLine(input = {}) {
  const attachmentCount = numeric(input.attachmentCount);
  const attachmentBytes = numeric(input.attachmentBytes);
  const systemChars = numeric(input.systemChars);
  const personaChars = numeric(input.personaChars);
  const memoryChars = numeric(input.memoryChars);
  const skillIndexChars = numeric(input.skillIndexChars);
  const loadedSkillChars = numeric(input.loadedSkillChars);
  const currentUserChars = numeric(input.currentUserChars);
  const visibleHistoryChars = numeric(input.visibleHistoryChars);
  const includedHistoryChars = numeric(input.includedHistoryChars);
  const groupChars = numeric(input.groupChars);
  const promptChars = numeric(input.promptChars)
    || systemChars + personaChars + currentUserChars + includedHistoryChars + groupChars;
  const fields = [
    ["engine", input.engine],
    ["bot", input.botId],
    ["session", input.sessionId],
    ["nativeSession", input.nativeSessionId],
    ["transport", input.transport],
    ["historyMode", input.historyMode],
    ["nativeHistory", input.nativeHistory ? "1" : "0"],
    ["promptChars", promptChars],
    ["currentUserChars", currentUserChars],
    ["systemChars", systemChars],
    ["personaChars", personaChars],
    ["memoryChars", memoryChars],
    ["skillIndexChars", skillIndexChars],
    ["loadedSkillChars", loadedSkillChars],
    ["visibleHistoryChars", visibleHistoryChars],
    ["includedHistoryChars", includedHistoryChars],
    ["groupChars", groupChars],
    ["attachmentCount", attachmentCount],
    ["attachmentBytes", attachmentBytes]
  ];
  const rendered = fields
    .filter(([, value]) => value !== "" && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${typeof value === "number" ? value : safeFieldValue(value)}`);
  return `[Mia context budget] ${rendered.join(" ")}`;
}

module.exports = {
  buildContextBudgetLogLine,
  messageTextChars,
  messagesAttachmentStats,
  messagesTextChars,
  textCharCount
};
