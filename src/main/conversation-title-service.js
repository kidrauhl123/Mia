"use strict";

const crypto = require("node:crypto");

function cleanConversationTitle(value) {
  return String(value || "")
    .trim()
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』。.!！?？:：]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 32);
}

function fallbackConversationTitle(messages = []) {
  const firstUser = messages.find((message) => message.role === "user" && String(message.content || "").trim());
  return cleanConversationTitle(firstUser?.content || "新对话") || "新对话";
}

function createConversationTitleService({
  randomUUID = () => crypto.randomUUID(),
  sendChat
} = {}) {
  if (typeof sendChat !== "function") throw new Error("sendChat dependency is required.");

  async function generateTitle({ botId, personaKey, conversationId, sessionId, messages } = {}) {
    const clipped = (Array.isArray(messages) ? messages : [])
      .filter((message) => ["user", "assistant"].includes(message.role) && String(message.content || "").trim())
      .slice(0, 4);
    if (!clipped.length) return { title: "新对话" };
    const transcript = clipped.map((message) => `${message.role}: ${message.content}`).join("\n").slice(0, 1600);
    const titleRunId = conversationId || sessionId || randomUUID();
    try {
      const response = await sendChat({
        botId: botId || personaKey,
        sessionId: `title:${titleRunId}`,
        messages: [{
          role: "user",
          content: [
            "请给下面这段对话生成一个简短标题。",
            "要求：不超过12个中文字；只输出标题；不要解释；不要引号；不要句号。",
            "",
            "对话：",
            transcript
          ].join("\n")
        }],
        utility: true,
        persistAgentSession: false,
        allowSlashCommands: false
      });
      const content = response.choices?.[0]?.message?.content || "";
      return { title: cleanConversationTitle(content) || fallbackConversationTitle(clipped) };
    } catch {
      return { title: fallbackConversationTitle(clipped) };
    }
  }

  return { generateTitle };
}

module.exports = {
  cleanConversationTitle,
  fallbackConversationTitle,
  createConversationTitleService
};
