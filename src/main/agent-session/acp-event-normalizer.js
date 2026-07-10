const {
  fileEditPayloadsFromAcpContent,
  fileEditPayloadsFromToolPayload
} = require("../agent-file-edit-events.js");

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

function isCodexModelMetadataWarning(text = "") {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  return /^Warning: Model metadata for `?[^`\s][^`]*`? not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.$/.test(normalized);
}

function stripCodexModelMetadataWarning(text = "") {
  return String(text || "").replace(
    /^\s*Warning: Model metadata for `?[^`\s][^`]*`? not found\.\s+Defaulting to fallback metadata; this can degrade performance and cause issues\.\s*/i,
    ""
  );
}

function fileEditPayloadsFromToolUpdate(update = {}, options = {}) {
  const status = typeof options.status === "string" && options.status.trim()
    ? options.status.trim()
    : "completed";
  const error = status === "failed" || status === "error";
  const baseOptions = {
    idPrefix: options.toolCallId || "tool",
    status: error ? "failed" : "completed",
    error
  };
  const sources = [];
  if (update.rawOutput != null) sources.push(update.rawOutput);
  if (update.content != null) sources.push(update.content);
  const payloads = [];
  const seen = new Set();
  for (const source of sources) {
    const next = source && typeof source === "object" && !Array.isArray(source)
      ? fileEditPayloadsFromToolPayload(source, baseOptions)
      : fileEditPayloadsFromAcpContent(source, baseOptions);
    for (const payload of next) {
      const key = `${payload.id}\0${payload.path}\0${payload.diff}`;
      if (seen.has(key)) continue;
      seen.add(key);
      payloads.push(payload);
    }
  }
  return payloads;
}

function normalizeAcpSessionUpdate(options = {}) {
  const update = options.update || {};
  const toolTitles = options.toolTitles instanceof Map ? options.toolTitles : new Map();
  const turnId = typeof options.turnId === "string" && options.turnId.trim() ? options.turnId.trim() : undefined;
  const events = [];

  if (update.sessionUpdate === "agent_message_chunk") {
    const text = stripCodexModelMetadataWarning(textFromAcpContent(update.content));
    if (!text) return events;
    if (isCodexModelMetadataWarning(text)) return events;
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
    const completed = status === "completed" || status === "failed";
    events.push({
      kind: completed ? "tool-call-completed" : "tool-call-delta",
      payload: {
        ...(turnId ? { turnId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        title,
        ...(status ? { status } : {}),
        preview: stringifyPreview(update.rawOutput || update.content)
      }
    });
    if (completed) {
      for (const payload of fileEditPayloadsFromToolUpdate(update, { toolCallId, status })) {
        events.push({
          kind: "file-edit",
          payload: {
            ...(turnId ? { turnId } : {}),
            ...(toolCallId ? { toolCallId } : {}),
            ...payload
          }
        });
      }
    }
    return events;
  }

  return events;
}

module.exports = Object.freeze({
  normalizeAcpSessionUpdate,
  fileEditPayloadsFromToolUpdate,
  stringifyPreview,
  textFromAcpContent
});
