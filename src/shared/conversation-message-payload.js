"use strict";

const COMPACT_TEXT_LIMIT = 4096;
const COMPACT_DETAIL_LIMIT = 320;
const COMPACT_ITEM_LIMIT = 24;

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function limitedText(value, limit = COMPACT_DETAIL_LIMIT) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…`;
}

function canonicalConversationMessage(message = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const {
    translation,
    trace,
    contentBlocks,
    content_blocks,
    ...canonical
  } = message;

  const content = parseJsonObject(canonical.content_json || canonical.content);
  const runtime = content?.runtime && typeof content.runtime === "object" && !Array.isArray(content.runtime)
    ? content.runtime
    : null;
  const tracePayload = parseJsonObject(canonical.trace_json) || parseJsonObject(trace) || parseJsonObject(runtime?.trace);
  const blockPayload = parseJsonArray(canonical.content_blocks_json)
    || parseJsonArray(contentBlocks)
    || parseJsonArray(content_blocks)
    || parseJsonArray(runtime?.contentBlocks)
    || parseJsonArray(runtime?.content_blocks);

  delete canonical.content;
  if (content) {
    const nextContent = { ...content };
    if (runtime) {
      const nextRuntime = { ...runtime };
      delete nextRuntime.trace;
      delete nextRuntime.contentBlocks;
      delete nextRuntime.content_blocks;
      if (Object.keys(nextRuntime).length) nextContent.runtime = nextRuntime;
      else delete nextContent.runtime;
    }
    canonical.content_json = JSON.stringify(nextContent);
  }
  if (tracePayload) canonical.trace_json = JSON.stringify(tracePayload);
  else delete canonical.trace_json;
  if (blockPayload) canonical.content_blocks_json = JSON.stringify(blockPayload);
  else delete canonical.content_blocks_json;
  return canonical;
}

function hydrateConversationMessageAliases(message = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const hydrated = { ...message };
  const trace = parseJsonObject(hydrated.trace_json);
  const blocks = parseJsonArray(hydrated.content_blocks_json);
  if (trace && hydrated.trace == null) hydrated.trace = trace;
  if (blocks && hydrated.contentBlocks == null) hydrated.contentBlocks = blocks;
  return hydrated;
}

function compactTool(tool = {}) {
  const compact = {};
  for (const key of ["id", "toolCallId", "tool_call_id", "name", "title", "status", "duration", "startedAt", "completedAt"]) {
    if (tool[key] != null) compact[key] = typeof tool[key] === "string" ? limitedText(tool[key], 160) : tool[key];
  }
  for (const key of ["body", "input", "output", "result", "error", "summary"]) {
    if (tool[key] == null) continue;
    const value = typeof tool[key] === "string" ? tool[key] : JSON.stringify(tool[key]);
    compact[key] = limitedText(value);
  }
  return compact;
}

function compactTrace(trace) {
  if (!trace) return null;
  const compact = {};
  if (trace.reasoning != null) compact.reasoning = limitedText(trace.reasoning, 1200);
  if (trace.durationSeconds != null) compact.durationSeconds = trace.durationSeconds;
  if (trace.duration != null) compact.duration = trace.duration;
  if (Array.isArray(trace.tools)) compact.tools = trace.tools.slice(-COMPACT_ITEM_LIMIT).map(compactTool);
  return compact;
}

function compactBlock(block = {}) {
  if (!block || typeof block !== "object") return null;
  const type = String(block.type || "");
  if (type === "text") {
    return { ...block, text: limitedText(block.text, COMPACT_TEXT_LIMIT) };
  }
  const compact = {};
  for (const key of ["type", "id", "toolCallId", "tool_call_id", "name", "title", "status", "duration", "language", "path"]) {
    if (block[key] != null) compact[key] = typeof block[key] === "string" ? limitedText(block[key], 160) : block[key];
  }
  for (const key of ["reasoning", "body", "input", "output", "result", "error", "summary", "text", "diff"]) {
    if (block[key] == null) continue;
    const value = typeof block[key] === "string" ? block[key] : JSON.stringify(block[key]);
    compact[key] = limitedText(value, key === "reasoning" ? 1200 : COMPACT_DETAIL_LIMIT);
  }
  return compact;
}

function compactConversationMessage(message = {}) {
  const canonical = canonicalConversationMessage(message);
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) return canonical;
  const compact = { ...canonical };
  const trace = compactTrace(parseJsonObject(canonical.trace_json));
  const blocks = parseJsonArray(canonical.content_blocks_json)
    ?.slice(-COMPACT_ITEM_LIMIT)
    .map(compactBlock)
    .filter(Boolean) || null;
  if (trace) compact.trace_json = JSON.stringify(trace);
  if (blocks) compact.content_blocks_json = JSON.stringify(blocks);
  compact._messagePayload = "compact";
  return compact;
}

function compactConversationMessages(messages) {
  return Array.isArray(messages) ? messages.map(compactConversationMessage) : [];
}

module.exports = {
  canonicalConversationMessage,
  hydrateConversationMessageAliases,
  compactConversationMessage,
  compactConversationMessages,
  parseJsonArray,
  parseJsonObject
};
