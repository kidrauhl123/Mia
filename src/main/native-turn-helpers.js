function cleanSessionId(value, fallbackKey) {
  const raw = String(value || "").trim();
  const fallback = `${fallbackKey || "mia"}:default`;
  return (raw || fallback)
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 120) || fallback;
}

function createNativeTurnHelpers(deps = {}) {
  const normalizeAttachments = deps.normalizeAttachments || (() => []);
  const attachmentContext = deps.attachmentContext || (() => "");

  if (typeof normalizeAttachments !== "function") {
    throw new Error("normalizeAttachments dependency is required.");
  }
  if (typeof attachmentContext !== "function") {
    throw new Error("attachmentContext dependency is required.");
  }

  function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
      .filter((message) => message && ["system", "user", "assistant"].includes(message.role))
      .map((message) => ({
        role: message.role,
        content: String(message.content || "").trim(),
        attachments: normalizeAttachments(message.attachments)
      }))
      .filter((message) => message.content || message.attachments.length);
  }

  function slashCommandText(messages) {
    const normalized = normalizeMessages(messages);
    const dialogue = normalized.filter((message) => message.role !== "system");
    const lastUserIndex = dialogue.map((message) => message.role).lastIndexOf("user");
    if (lastUserIndex < 0) return "";
    const input = dialogue[lastUserIndex].content.trim();
    return /^\/[A-Za-z0-9_:/.-]+(?:\s|$)/.test(input) ? input : "";
  }

  function roleLabel(role) {
    if (role === "assistant") return "助手";
    if (role === "system") return "系统";
    return "用户";
  }

  function messagePromptContent(message) {
    const attachmentText = message.role === "user" ? attachmentContext(message.attachments) : "";
    return [
      message.content,
      attachmentText ? `附件上下文：\n${attachmentText}` : ""
    ].filter(Boolean).join("\n\n").trim();
  }

  function transcriptLine(message) {
    const content = messagePromptContent(message);
    if (!content) return "";
    return `${roleLabel(message.role)}：${content}`;
  }

  function lastUserPrompt(messages) {
    const normalized = normalizeMessages(messages);
    const lastUserIndex = normalized.map((message) => message.role).lastIndexOf("user");
    if (lastUserIndex < 0) throw new Error("No user message found.");
    const last = normalized[lastUserIndex];
    const currentUserPrompt = messagePromptContent(last);
    if (!currentUserPrompt) throw new Error("No user message found.");
    const context = normalized
      .slice(0, lastUserIndex)
      .map(transcriptLine)
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (!context) return currentUserPrompt;
    return [
      "会话前文（按时间顺序）：",
      context,
      "",
      "当前用户消息：",
      currentUserPrompt
    ].join("\n");
  }

  return {
    cleanSessionId,
    lastUserPrompt,
    slashCommandText
  };
}

module.exports = {
  cleanSessionId,
  createNativeTurnHelpers
};
