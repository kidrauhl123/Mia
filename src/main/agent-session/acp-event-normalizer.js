function stringifyPreview(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textFromAcpContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content)) {
    return content.map((part) => textFromAcpContent(part)).filter(Boolean).join("");
  }
  return "";
}

function isCodexMiaAutoMetadataWarning(text = "") {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  return /^Warning: Model metadata for `?mia-auto`? not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.$/.test(normalized);
}

function stripCodexMiaAutoMetadataWarning(text = "") {
  return String(text || "").replace(
    /^\s*Warning: Model metadata for `?mia-auto`? not found\.\s+Defaulting to fallback metadata; this can degrade performance and cause issues\.\s*/i,
    ""
  );
}

function normalizeAcpSessionUpdate(options = {}) {
  const update = options.update || {};
  const toolTitles = options.toolTitles instanceof Map ? options.toolTitles : new Map();
  const turnId = typeof options.turnId === "string" && options.turnId.trim() ? options.turnId.trim() : undefined;
  const events = [];

  if (update.sessionUpdate === "agent_message_chunk") {
    const text = stripCodexMiaAutoMetadataWarning(textFromAcpContent(update.content));
    if (!text) return events;
    if (isCodexMiaAutoMetadataWarning(text)) return events;
    events.push({
      kind: "assistant-delta",
      payload: {
        ...(turnId ? { turnId } : {}),
        ...(typeof update.messageId === "string" && update.messageId.trim()
          ? { messageId: update.messageId.trim() }
          : {}),
        text
      }
    });
    return events;
  }

  if (update.sessionUpdate === "tool_call") {
    const toolCallId = typeof update.toolCallId === "string" && update.toolCallId.trim()
      ? update.toolCallId.trim()
      : "";
    const title = typeof update.title === "string" && update.title.trim()
      ? update.title.trim()
      : (typeof update.kind === "string" && update.kind.trim() ? update.kind.trim() : "Tool");
    if (toolCallId) toolTitles.set(toolCallId, title);
    events.push({
      kind: "tool-call-started",
      payload: {
        ...(turnId ? { turnId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        title,
        preview: stringifyPreview(update.rawInput)
      }
    });
    return events;
  }

  if (update.sessionUpdate === "tool_call_update") {
    const toolCallId = typeof update.toolCallId === "string" && update.toolCallId.trim()
      ? update.toolCallId.trim()
      : "";
    const title = toolTitles.get(toolCallId)
      || (typeof update.title === "string" && update.title.trim() ? update.title.trim() : "Tool");
    const status = typeof update.status === "string" && update.status.trim()
      ? update.status.trim()
      : "";
    events.push({
      kind: status === "completed" || status === "failed" ? "tool-call-completed" : "tool-call-delta",
      payload: {
        ...(turnId ? { turnId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        title,
        ...(status ? { status } : {}),
        preview: stringifyPreview(update.rawOutput || update.content)
      }
    });
    return events;
  }

  return events;
}

module.exports = Object.freeze({
  normalizeAcpSessionUpdate,
  stringifyPreview,
  textFromAcpContent
});
