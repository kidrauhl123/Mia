const crypto = require("node:crypto");

function chatCompletionResponse({ id, model, content, finishReason = "stop", aimashi = {} }) {
  return {
    id: id || `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || ""
        },
        finish_reason: finishReason
      }
    ],
    aimashi
  };
}

function responseMessageContent(response) {
  return String(response?.choices?.[0]?.message?.content || "").trim();
}

module.exports = {
  chatCompletionResponse,
  responseMessageContent
};
