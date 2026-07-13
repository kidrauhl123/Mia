const crypto = require("node:crypto");

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(Buffer.from(buffer || "").toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeJsonValue(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return String(block.text || "");
  if (block.type === "thinking") return String(block.thinking || "");
  if (block.type === "tool_result") {
    const content = Array.isArray(block.content)
      ? block.content.map(blockText).filter(Boolean).join("\n")
      : String(block.content || "");
    return content ? `Tool result (${block.tool_use_id || "tool"}):\n${content}` : "";
  }
  if (block.type === "image") return "[Image attachment]";
  return String(block.text || block.content || "");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join("\n");
  return blockText(content);
}

function normalizeToolParameters(schema) {
  const value = schema && typeof schema === "object" ? schema : {};
  return Object.keys(value).length ? value : { type: "object", properties: {} };
}

function convertAnthropicTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      const name = String(tool.name || "").trim();
      if (!name) return null;
      return {
        type: "function",
        function: {
          name,
          description: String(tool.description || ""),
          parameters: normalizeToolParameters(tool.input_schema || tool.inputSchema || tool.parameters)
        }
      };
    })
    .filter(Boolean);
  return converted.length ? converted : undefined;
}

function convertAnthropicToolChoice(choice) {
  if (!choice || choice === "auto") return "auto";
  if (choice === "none") return "none";
  if (choice === "any") return "required";
  if (typeof choice === "object" && choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: String(choice.name) } };
  }
  return undefined;
}

function anthropicThinkingEnabled(body = {}) {
  const thinking = body?.thinking;
  if (!thinking || typeof thinking !== "object") return false;
  const type = String(thinking.type || "").trim().toLowerCase();
  if (type === "disabled") return false;
  return type === "enabled" || Number(thinking.budget_tokens || thinking.budgetTokens || 0) > 0;
}

function addSystemMessages(messages, system) {
  if (!system) return;
  if (typeof system === "string") {
    if (system.trim()) messages.push({ role: "system", content: system });
    return;
  }
  if (Array.isArray(system)) {
    const text = system.map(blockText).filter(Boolean).join("\n");
    if (text.trim()) messages.push({ role: "system", content: text });
  }
}

function convertAnthropicMessages(messages = []) {
  const result = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;
    if (role === "assistant" && Array.isArray(content)) {
      const textParts = [];
      const toolCalls = [];
      for (const block of content) {
        if (block?.type === "tool_use") {
          const id = String(block.id || `tool_${toolCalls.length}`);
          toolCalls.push({
            id,
            type: "function",
            function: {
              name: String(block.name || "tool"),
              arguments: JSON.stringify(normalizeJsonValue(block.input))
            }
          });
        } else {
          const text = blockText(block);
          if (text) textParts.push(text);
        }
      }
      result.push({
        role: "assistant",
        content: textParts.join("\n") || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      });
      continue;
    }

    if (role === "user" && Array.isArray(content)) {
      const textParts = [];
      for (const block of content) {
        if (block?.type === "tool_result") {
          if (textParts.length) {
            result.push({ role: "user", content: textParts.join("\n") });
            textParts.length = 0;
          }
          result.push({
            role: "tool",
            tool_call_id: String(block.tool_use_id || ""),
            content: contentText(block.content)
          });
          continue;
        }
        const text = blockText(block);
        if (text) textParts.push(text);
      }
      if (textParts.length) result.push({ role: "user", content: textParts.join("\n") });
      continue;
    }

    result.push({ role, content: contentText(content) });
  }
  return result;
}

function anthropicToOpenAiChatBody(body = {}, model = "") {
  const messages = [];
  addSystemMessages(messages, body.system);
  messages.push(...convertAnthropicMessages(body.messages));
  const out = {
    model: model || body.model,
    messages,
    stream: body.stream === true
  };
  for (const [source, target] of [
    ["max_tokens", "max_tokens"],
    ["temperature", "temperature"],
    ["top_p", "top_p"],
    ["stop_sequences", "stop"]
  ]) {
    if (body[source] !== undefined) out[target] = body[source];
  }
  const tools = convertAnthropicTools(body.tools);
  if (tools) out.tools = tools;
  const toolChoice = convertAnthropicToolChoice(body.tool_choice);
  if (toolChoice !== undefined) {
    out.tool_choice = anthropicThinkingEnabled(body) && toolChoice !== "none"
      ? "auto"
      : toolChoice;
  }
  if (body.stream === true) {
    out.stream_options = { ...(body.stream_options || {}), include_usage: true };
  }
  return out;
}

function mapFinishReason(reason) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "content_filter") return "stop";
  return "end_turn";
}

function usageFromOpenAi(usage = {}) {
  return {
    input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0) || 0,
    output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0) || 0
  };
}

function anthropicMessageId(source = "") {
  const id = String(source || "").trim();
  return id.startsWith("msg_") ? id : `msg_${crypto.randomBytes(12).toString("base64url")}`;
}

function convertOpenAiMessageToAnthropic(payload = {}, requestBody = {}, model = "") {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] || {} : {};
  const message = choice.message || {};
  const content = [];
  const text = typeof message.content === "string" ? message.content : contentText(message.content);
  if (text) content.push({ type: "text", text });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!call) continue;
    content.push({
      type: "tool_use",
      id: String(call.id || `toolu_${crypto.randomBytes(8).toString("base64url")}`),
      name: String(call.function?.name || call.name || "tool"),
      input: normalizeJsonValue(call.function?.arguments || call.arguments)
    });
  }
  return {
    id: anthropicMessageId(payload.id),
    type: "message",
    role: "assistant",
    model: requestBody.model || model || payload.model || "",
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: usageFromOpenAi(payload.usage || {})
  };
}

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseSseDataLines(text) {
  const frames = [];
  for (const frame of String(text || "").split(/\r?\n\r?\n/)) {
    const dataLines = frame
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length) frames.push(dataLines.join("\n"));
  }
  return frames;
}

function canonicalToolInputJson(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendToolCallDelta(toolCalls, deltaCall) {
  const index = Number.isInteger(deltaCall.index) ? deltaCall.index : toolCalls.length;
  const current = toolCalls.get(index) || { index, id: "", name: "", arguments: "" };
  if (deltaCall.id) current.id = String(deltaCall.id);
  if (deltaCall.function?.name) current.name = String(deltaCall.function.name);
  if (deltaCall.function?.arguments) current.arguments += String(deltaCall.function.arguments);
  toolCalls.set(index, current);
}

function openAiStreamPayloadToAnthropicSse(buffer, requestBody = {}, model = "") {
  const messageId = `msg_${crypto.randomBytes(12).toString("base64url")}`;
  let output = sseFrame("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: requestBody.model || model || "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  let textBlockStarted = false;
  let textBlockStopped = false;
  let outputTokens = 0;
  let finishReason = "end_turn";
  const toolCalls = new Map();

  function ensureTextBlock() {
    if (textBlockStarted) return;
    textBlockStarted = true;
    output += sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    });
  }

  function stopTextBlock() {
    if (!textBlockStarted || textBlockStopped) return;
    textBlockStopped = true;
    output += sseFrame("content_block_stop", { type: "content_block_stop", index: 0 });
  }

  function consumeFrameData(data) {
    if (!data || data === "[DONE]") return;
    const parsed = parseJsonBuffer(Buffer.from(data));
    if (!parsed) return;
    if (parsed.usage) outputTokens = usageFromOpenAi(parsed.usage).output_tokens;
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] || {} : {};
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      ensureTextBlock();
      output += sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta.content }
      });
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) appendToolCallDelta(toolCalls, call);
    if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
  }

  for (const data of parseSseDataLines(Buffer.from(buffer || "").toString("utf8"))) consumeFrameData(data);
  stopTextBlock();

  let index = textBlockStarted ? 1 : 0;
  for (const call of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
    output += sseFrame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: call.id || `toolu_${crypto.randomBytes(8).toString("base64url")}`,
        name: call.name || "tool",
        input: {}
      }
    });
    output += sseFrame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: canonicalToolInputJson(call.arguments) }
    });
    output += sseFrame("content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }

  output += sseFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: finishReason, stop_sequence: null },
    usage: { output_tokens: outputTokens }
  });
  output += "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
  return output;
}

function roughTokenCount(body = {}) {
  const text = [
    contentText(body.system),
    ...(Array.isArray(body.messages) ? body.messages.map((message) => contentText(message?.content)) : [])
  ].filter(Boolean).join("\n");
  return Math.max(1, Math.ceil(text.length / 4));
}

module.exports = {
  anthropicToOpenAiChatBody,
  convertOpenAiMessageToAnthropic,
  openAiStreamPayloadToAnthropicSse,
  roughTokenCount
};
