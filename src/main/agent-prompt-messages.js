"use strict";

function promptMessagesForNativeSession(messages, persistAgentSession) {
  const rows = Array.isArray(messages) ? messages : [];
  const lastUserIndex = rows.map((message) => message?.role).lastIndexOf("user");
  if (lastUserIndex < 0) return rows;
  return [
    ...rows.slice(0, lastUserIndex).filter((message) => message?.role === "system"),
    rows[lastUserIndex]
  ];
}

module.exports = {
  promptMessagesForNativeSession
};
