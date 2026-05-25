const crypto = require("node:crypto");

function chatCompletionResponse({ id, model, content, attachments = [], commandResult = null, finishReason = "stop", mia = {} }) {
  const message = {
    role: "assistant",
    content: content || ""
  };
  if (Array.isArray(attachments) && attachments.length) message.attachments = attachments;
  if (commandResult && typeof commandResult === "object") message.commandResult = commandResult;
  return {
    id: id || `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason
      }
    ],
    mia: commandResult && typeof commandResult === "object" ? { ...mia, commandResult } : mia
  };
}

function responseMessageContent(response) {
  return String(response?.choices?.[0]?.message?.content || "").trim();
}

module.exports = {
  chatCompletionResponse,
  responseMessageContent
};
