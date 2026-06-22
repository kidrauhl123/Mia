"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_HISTORY_RESPONSES = 128;

function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function randomToken() {
  return `mia_codex_${crypto.randomBytes(24).toString("base64url")}`;
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(Buffer.from(buffer || "").toString("utf8"));
  } catch {
    return null;
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function writeError(res, status, message) {
  writeJson(res, status, {
    error: {
      type: "mia_codex_proxy_error",
      message: String(message || "Mia Codex proxy request failed.")
    }
  });
}

function readRequestBody(req, limitBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function bearerTokenFromRequest(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-api-key"] || req.headers["openai-api-key"] || "").trim();
}

function normalizeJsonObject(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return fallback;
}

function canonicalJsonString(value) {
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

function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const type = String(block.type || "");
  if (type === "input_text" || type === "output_text" || type === "text" || type === "summary_text") {
    return String(block.text || "");
  }
  if (type === "refusal") return String(block.refusal || "");
  if (type === "input_image" || type === "image" || type === "image_url") return "[Image attachment]";
  if (block.text != null) return String(block.text);
  if (block.content != null) return contentText(block.content);
  return "";
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join("\n");
  return blockText(content);
}

function normalizeToolParameters(schema) {
  const value = normalizeJsonObject(schema, {});
  return Object.keys(value).length ? value : { type: "object", properties: {} };
}

function safeToolName(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
}

function flattenNamespaceToolName(namespace, name) {
  return safeToolName(`${namespace}_${name}`);
}

function createToolContext() {
  return {
    chatTools: [],
    specsByChatName: new Map(),
    namespaceNames: new Map()
  };
}

function addChatTool(context, chatName, spec, chatTool) {
  const name = safeToolName(chatName);
  if (!name || context.specsByChatName.has(name)) return;
  context.specsByChatName.set(name, { ...spec, chatName: name });
  if (spec.namespace && spec.name) {
    context.namespaceNames.set(`${spec.namespace}:${spec.name}`, name);
  }
  context.chatTools.push(chatTool);
}

function responsesToolName(tool = {}) {
  return String(tool.name || tool.function?.name || "").trim();
}

function functionToolToChatTool(tool = {}, chatName) {
  return {
    type: "function",
    function: {
      name: safeToolName(chatName),
      description: String(tool.description || tool.function?.description || ""),
      parameters: normalizeToolParameters(tool.parameters || tool.input_schema || tool.inputSchema || tool.function?.parameters)
    }
  };
}

function customToolToChatTool(tool = {}, chatName) {
  return {
    type: "function",
    function: {
      name: safeToolName(chatName),
      description: String(tool.description || "Custom Codex tool."),
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Input to pass to the custom Codex tool." }
        },
        required: ["input"]
      }
    }
  };
}

function addResponseTool(context, tool, namespace = "") {
  if (typeof tool === "string") {
    const name = safeToolName(tool);
    addChatTool(context, name, { kind: "custom", name }, customToolToChatTool({ name }, name));
    return;
  }
  if (!tool || typeof tool !== "object") return;
  const type = String(tool.type || "function");
  if (type === "namespace") {
    const ns = String(tool.name || "").trim();
    const children = Array.isArray(tool.tools) ? tool.tools : Array.isArray(tool.children) ? tool.children : [];
    for (const child of children) addResponseTool(context, child, ns);
    return;
  }
  if (type === "tool_search") {
    addChatTool(context, "tool_search", { kind: "tool_search", name: "tool_search" }, {
      type: "function",
      function: {
        name: "tool_search",
        description: "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" }
          },
          required: ["query"]
        }
      }
    });
    return;
  }
  const originalName = responsesToolName(tool);
  if (!originalName) return;
  const chatName = namespace ? flattenNamespaceToolName(namespace, originalName) : safeToolName(originalName);
  if (type === "custom") {
    addChatTool(context, chatName, { kind: "custom", name: originalName, namespace: namespace || "" }, customToolToChatTool(tool, chatName));
    return;
  }
  addChatTool(context, chatName, { kind: namespace ? "namespace" : "function", name: originalName, namespace: namespace || "" }, functionToolToChatTool(tool, chatName));
}

function buildToolContext(body = {}) {
  const context = createToolContext();
  for (const tool of Array.isArray(body.tools) ? body.tools : []) addResponseTool(context, tool);
  return context;
}

function chatNameForResponseFunction(name, namespace, context) {
  if (namespace) {
    return context.namespaceNames.get(`${namespace}:${name}`) || flattenNamespaceToolName(namespace, name);
  }
  return safeToolName(name);
}

function responsesToolChoiceToChat(choice, context) {
  if (choice == null || choice === "auto") return "auto";
  if (choice === "none") return "none";
  if (choice === "required" || choice === "any") return "required";
  if (typeof choice === "object") {
    const name = String(choice.name || choice.function?.name || "").trim();
    const namespace = String(choice.namespace || "").trim();
    if (name) {
      return {
        type: "function",
        function: { name: chatNameForResponseFunction(name, namespace, context) }
      };
    }
  }
  return undefined;
}

function responsesRoleToChatRole(role) {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  if (role === "tool") return "tool";
  return "user";
}

function responseItemCallId(item = {}) {
  return String(item.call_id || item.callId || item.id || "").trim();
}

function isToolCallType(type) {
  return type === "function_call" || type === "custom_tool_call" || type === "tool_search_call";
}

function isToolOutputType(type) {
  return type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output";
}

function responsesFunctionCallToChatToolCall(item = {}, index = 0, context = createToolContext()) {
  const callId = responseItemCallId(item) || `call_${index}`;
  const name = chatNameForResponseFunction(
    String(item.name || "tool"),
    String(item.namespace || ""),
    context
  );
  return {
    id: callId,
    type: "function",
    function: {
      name,
      arguments: canonicalJsonString(item.arguments ?? item.input ?? {})
    }
  };
}

function responsesMessageItemToChatMessage(item = {}) {
  const role = responsesRoleToChatRole(String(item.role || "user"));
  return {
    role,
    content: contentText(item.content)
  };
}

function flushPendingToolCalls(messages, pendingToolCalls) {
  if (!pendingToolCalls.length) return;
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: pendingToolCalls.splice(0, pendingToolCalls.length)
  });
}

function appendResponsesItemAsChatMessage(item, messages, pendingToolCalls, context) {
  if (!item || typeof item !== "object") return;
  const type = String(item.type || "");
  if (isToolCallType(type)) {
    pendingToolCalls.push(responsesFunctionCallToChatToolCall(item, pendingToolCalls.length, context));
    return;
  }
  if (isToolOutputType(type)) {
    flushPendingToolCalls(messages, pendingToolCalls);
    messages.push({
      role: "tool",
      tool_call_id: responseItemCallId(item),
      content: canonicalJsonString(item.output ?? item.result ?? item.content ?? "")
    });
    return;
  }
  if (type === "reasoning") return;
  flushPendingToolCalls(messages, pendingToolCalls);
  if (item.role != null || item.content != null) messages.push(responsesMessageItemToChatMessage(item));
}

function appendResponsesInputAsChatMessages(input, messages, context) {
  const pendingToolCalls = [];
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) appendResponsesItemAsChatMessage(item, messages, pendingToolCalls, context);
  } else if (input && typeof input === "object") {
    appendResponsesItemAsChatMessage(input, messages, pendingToolCalls, context);
  }
  flushPendingToolCalls(messages, pendingToolCalls);
}

function collapseSystemMessagesToHead(messages) {
  const system = [];
  const rest = [];
  for (const message of messages) {
    if (message.role === "system" && typeof message.content === "string" && message.content.trim()) {
      system.push(message.content);
    } else {
      rest.push(message);
    }
  }
  return system.length ? [{ role: "system", content: system.join("\n\n") }, ...rest] : rest;
}

function recordResponseHistory(session, response = {}) {
  if (!(session.responseCalls instanceof Map)) session.responseCalls = new Map();
  if (!Array.isArray(session.responseOrder)) session.responseOrder = [];
  if (!(session.callIndex instanceof Map)) session.callIndex = new Map();
  const responseId = String(response.id || "").trim();
  if (!responseId) return;
  const calls = new Map();
  for (const item of Array.isArray(response.output) ? response.output : []) {
    const type = String(item?.type || "");
    if (!isToolCallType(type)) continue;
    const callId = responseItemCallId(item);
    if (!callId) continue;
    calls.set(callId, cloneJson(item));
    const indexed = session.callIndex.get(callId) || [];
    indexed.push({ responseId, item: cloneJson(item) });
    session.callIndex.set(callId, indexed.slice(-4));
  }
  if (!calls.size) return;
  session.responseCalls.set(responseId, calls);
  session.responseOrder.push(responseId);
  while (session.responseOrder.length > MAX_HISTORY_RESPONSES) {
    const evicted = session.responseOrder.shift();
    if (evicted) session.responseCalls.delete(evicted);
  }
}

function lookupCachedToolCall(session, previousResponseId, callId) {
  const responseCalls = session.responseCalls instanceof Map ? session.responseCalls : new Map();
  const callIndex = session.callIndex instanceof Map ? session.callIndex : new Map();
  const byResponse = previousResponseId ? responseCalls.get(previousResponseId) : null;
  if (byResponse?.has(callId)) return cloneJson(byResponse.get(callId));
  const indexed = callIndex.get(callId) || [];
  if (indexed.length === 1) return cloneJson(indexed[0].item);
  return null;
}

function enrichRequestWithHistory(body = {}, session = {}) {
  const input = body.input;
  if (!Array.isArray(input) && !(input && typeof input === "object")) return 0;
  const items = Array.isArray(input) ? input : [input];
  const existingCallIds = new Set();
  for (const item of items) {
    const type = String(item?.type || "");
    if (isToolCallType(type)) {
      const callId = responseItemCallId(item);
      if (callId) existingCallIds.add(callId);
    }
  }
  const previousResponseId = String(body.previous_response_id || "").trim();
  const restored = [];
  const restoredIds = new Set();
  for (const item of items) {
    const type = String(item?.type || "");
    if (isToolOutputType(type)) {
      const callId = responseItemCallId(item);
      if (callId && !existingCallIds.has(callId) && !restoredIds.has(callId)) {
        const cached = lookupCachedToolCall(session, previousResponseId, callId);
        if (cached) {
          restored.push(cached);
          restoredIds.add(callId);
        }
      }
    }
    restored.push(item);
  }
  if (restoredIds.size) body.input = Array.isArray(input) || restored.length !== 1 ? restored : restored[0];
  return restoredIds.size;
}

function responsesToChatCompletions(body = {}, session = {}) {
  const request = cloneJson(body) || {};
  enrichRequestWithHistory(request, session);
  const context = buildToolContext(request);
  const messages = [];
  const instructions = contentText(request.instructions);
  if (instructions.trim()) messages.push({ role: "system", content: instructions });
  appendResponsesInputAsChatMessages(request.input, messages, context);
  const out = {
    model: session.model || request.model,
    messages: collapseSystemMessagesToHead(messages),
    stream: request.stream === true
  };
  if (request.max_output_tokens != null) out.max_tokens = request.max_output_tokens;
  if (request.max_tokens != null) out.max_tokens = request.max_tokens;
  for (const key of ["temperature", "top_p", "presence_penalty", "frequency_penalty", "stop", "response_format", "seed", "user"]) {
    if (request[key] !== undefined) out[key] = request[key];
  }
  if (context.chatTools.length) {
    out.tools = context.chatTools;
    const toolChoice = responsesToolChoiceToChat(request.tool_choice, context);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
  }
  if (out.stream) out.stream_options = { ...(request.stream_options || {}), include_usage: true };
  return { body: out, toolContext: context };
}

function responseIdFromChatId(id) {
  const value = String(id || "").trim();
  if (value.startsWith("resp_")) return value;
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe ? `resp_${safe}` : randomId("resp");
}

function responseStatusFromFinishReason(reason) {
  if (reason === "length") return "incomplete";
  if (reason === "content_filter") return "failed";
  return "completed";
}

function chatUsageToResponsesUsage(usage = {}) {
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens ?? input + output) || input + output
  };
}

function responseToolCallItemFromChat(toolCall = {}, index = 0) {
  const callId = String(toolCall.id || `call_${index}`);
  const fn = toolCall.function || {};
  const name = safeToolName(fn.name || toolCall.name || "tool");
  const argumentsText = canonicalJsonString(fn.arguments ?? toolCall.arguments ?? {});
  return {
    id: `fc_${callId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    arguments: argumentsText
  };
}

function chatMessageToResponseOutputItems(message = {}, responseId = "") {
  const output = [];
  const text = contentText(message.content);
  if (text) {
    output.push({
      id: `${responseId}_msg`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (let index = 0; index < calls.length; index += 1) {
    output.push(responseToolCallItemFromChat(calls[index], index));
  }
  if (!calls.length && message.function_call) {
    output.push(responseToolCallItemFromChat({ id: "call_0", function: message.function_call }, 0));
  }
  return output;
}

function chatResponseToResponses(payload = {}, _requestBody = {}, session = {}) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] || {} : {};
  const message = choice.message || {};
  const responseId = responseIdFromChatId(payload.id);
  const finishReason = choice.finish_reason || null;
  const response = {
    id: responseId,
    object: "response",
    created_at: Number(payload.created || Math.floor(Date.now() / 1000)),
    status: responseStatusFromFinishReason(finishReason),
    model: payload.model || session.model || "",
    output: chatMessageToResponseOutputItems(message, responseId),
    usage: chatUsageToResponsesUsage(payload.usage || {})
  };
  if (finishReason === "length") response.incomplete_details = { reason: "max_output_tokens" };
  recordResponseHistory(session, response);
  return response;
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

function writeSse(res, event, data) {
  res.write(sseFrame(event, data));
}

function createStreamState({ session, requestBody }) {
  const state = {
    responseStarted: false,
    completed: false,
    responseId: randomId("resp"),
    model: session.model || requestBody.model || "",
    createdAt: Math.floor(Date.now() / 1000),
    nextOutputIndex: 0,
    text: { added: false, done: false, outputIndex: 0, itemId: "", text: "" },
    tools: new Map(),
    outputItems: [],
    usage: chatUsageToResponsesUsage({}),
    finishReason: null
  };

  function nextOutputIndex() {
    const index = state.nextOutputIndex;
    state.nextOutputIndex += 1;
    return index;
  }

  function baseResponse(status, output = []) {
    return {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      status,
      model: state.model,
      output,
      usage: state.usage
    };
  }

  function ensureResponseStarted(res) {
    if (state.responseStarted) return;
    state.responseStarted = true;
    writeSse(res, "response.created", { type: "response.created", response: baseResponse("in_progress", []) });
    writeSse(res, "response.in_progress", { type: "response.in_progress", response: baseResponse("in_progress", []) });
  }

  function pushTextDelta(res, delta) {
    if (!delta) return;
    ensureResponseStarted(res);
    if (!state.text.added) {
      const outputIndex = nextOutputIndex();
      state.text = { added: true, done: false, outputIndex, itemId: `${state.responseId}_msg`, text: "" };
      writeSse(res, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { id: state.text.itemId, type: "message", status: "in_progress", role: "assistant", content: [] }
      });
      writeSse(res, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: state.text.itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });
    }
    state.text.text += delta;
    writeSse(res, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: state.text.itemId,
      output_index: state.text.outputIndex,
      content_index: 0,
      delta
    });
  }

  function toolStateFor(index) {
    if (!state.tools.has(index)) {
      state.tools.set(index, {
        added: false,
        done: false,
        outputIndex: 0,
        itemId: "",
        callId: "",
        name: "",
        arguments: ""
      });
    }
    return state.tools.get(index);
  }

  function pushToolDelta(res, toolCall) {
    ensureResponseStarted(res);
    const index = Number.isInteger(toolCall.index) ? toolCall.index : 0;
    const current = toolStateFor(index);
    if (toolCall.id) current.callId = String(toolCall.id);
    if (toolCall.function?.name) current.name = safeToolName(toolCall.function.name);
    const argsDelta = String(toolCall.function?.arguments || "");
    if (argsDelta) current.arguments += argsDelta;
    if (!current.added && (current.callId || current.name)) {
      current.added = true;
      if (!current.callId) current.callId = `call_${index}`;
      if (!current.name) current.name = "tool";
      current.outputIndex = nextOutputIndex();
      current.itemId = `fc_${current.callId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      writeSse(res, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: current.outputIndex,
        item: {
          id: current.itemId,
          type: "function_call",
          status: "in_progress",
          call_id: current.callId,
          name: current.name,
          arguments: ""
        }
      });
    }
    if (argsDelta && current.added) {
      writeSse(res, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: current.itemId,
        output_index: current.outputIndex,
        delta: argsDelta
      });
    }
  }

  function handleChunk(res, chunk = {}) {
    if (chunk.id) state.responseId = responseIdFromChatId(chunk.id);
    if (chunk.model) state.model = String(chunk.model);
    if (chunk.created) state.createdAt = Number(chunk.created) || state.createdAt;
    if (chunk.usage) state.usage = chatUsageToResponsesUsage(chunk.usage);
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] || {} : {};
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) pushTextDelta(res, delta.content);
    for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) pushToolDelta(res, toolCall);
    if (choice.finish_reason) state.finishReason = choice.finish_reason;
  }

  function finalizeText(res) {
    if (!state.text.added || state.text.done) return;
    const item = {
      id: state.text.itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: state.text.text, annotations: [] }]
    };
    state.outputItems.push({ index: state.text.outputIndex, item });
    state.text.done = true;
    writeSse(res, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: state.text.itemId,
      output_index: state.text.outputIndex,
      content_index: 0,
      text: state.text.text
    });
    writeSse(res, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: state.text.itemId,
      output_index: state.text.outputIndex,
      content_index: 0,
      part: item.content[0]
    });
    writeSse(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.text.outputIndex,
      item
    });
  }

  function finalizeTools(res) {
    for (const [index, current] of [...state.tools.entries()].sort((a, b) => a[0] - b[0])) {
      if (current.done) continue;
      if (!current.added) {
        current.added = true;
        current.callId = current.callId || `call_${index}`;
        current.name = current.name || "tool";
        current.outputIndex = nextOutputIndex();
        current.itemId = `fc_${current.callId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        writeSse(res, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: current.outputIndex,
          item: {
            id: current.itemId,
            type: "function_call",
            status: "in_progress",
            call_id: current.callId,
            name: current.name,
            arguments: ""
          }
        });
      }
      const argumentsText = canonicalJsonString(current.arguments);
      const item = {
        id: current.itemId,
        type: "function_call",
        status: "completed",
        call_id: current.callId,
        name: current.name,
        arguments: argumentsText
      };
      state.outputItems.push({ index: current.outputIndex, item });
      current.done = true;
      writeSse(res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: current.itemId,
        output_index: current.outputIndex,
        arguments: argumentsText
      });
      writeSse(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: current.outputIndex,
        item
      });
    }
  }

  function finalize(res) {
    if (state.completed) return;
    ensureResponseStarted(res);
    finalizeText(res);
    finalizeTools(res);
    const output = state.outputItems.sort((a, b) => a.index - b.index).map((entry) => entry.item);
    const status = responseStatusFromFinishReason(state.finishReason);
    const response = baseResponse(output.length || state.finishReason ? status : "failed", output);
    if (state.finishReason === "length") response.incomplete_details = { reason: "max_output_tokens" };
    if (!output.length && !state.finishReason) response.error = { message: "Upstream stream ended before producing output.", code: "stream_truncated" };
    writeSse(res, "response.completed", { type: "response.completed", response });
    recordResponseHistory(session, response);
    state.completed = true;
  }

  return { handleChunk, finalize };
}

async function pipeChatStreamAsResponses(upstream, res, requestBody = {}, session = {}) {
  res.writeHead(upstream.ok ? 200 : upstream.status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive"
  });
  if (!upstream.ok) {
    const text = await upstream.text();
    const responseId = randomId("resp");
    writeSse(res, "response.failed", {
      type: "response.failed",
      response: {
        id: responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "failed",
        model: session.model || requestBody.model || "",
        output: [],
        error: { message: text || `Upstream request failed (${upstream.status}).` },
        usage: chatUsageToResponsesUsage({})
      }
    });
    res.end();
    return;
  }
  if (!upstream.body?.getReader) {
    writeSse(res, "response.failed", {
      type: "response.failed",
      response: {
        id: randomId("resp"),
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "failed",
        model: session.model || requestBody.model || "",
        output: [],
        error: { message: "Upstream stream is not readable." },
        usage: chatUsageToResponsesUsage({})
      }
    });
    res.end();
    return;
  }
  const state = createStreamState({ session, requestBody });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";
    for (const part of parts) {
      for (const data of parseSseDataLines(part)) {
        if (!data || data === "[DONE]") continue;
        const parsed = parseJsonBuffer(Buffer.from(data));
        if (parsed) state.handleChunk(res, parsed);
      }
    }
  }
  buffer += decoder.decode();
  for (const data of parseSseDataLines(buffer)) {
    if (!data || data === "[DONE]") continue;
    const parsed = parseJsonBuffer(Buffer.from(data));
    if (parsed) state.handleChunk(res, parsed);
  }
  state.finalize(res);
  res.end();
}

function isResponsesPath(pathname) {
  return pathname === "/responses"
    || pathname === "/v1/responses"
    || pathname === "/responses/compact"
    || pathname === "/v1/responses/compact";
}

function isChatCompletionsPath(pathname) {
  return pathname === "/chat/completions" || pathname === "/v1/chat/completions";
}

function createCodexMiaProxy(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const host = options.host || DEFAULT_BIND_HOST;
  const ttlMs = Number(options.sessionTtlMs || DEFAULT_SESSION_TTL_MS);
  const now = options.now || (() => Date.now());
  const appendLog = options.appendLog || (() => {});
  const sessions = new Map();
  let server = null;
  let startPromise = null;
  let port = 0;

  function cleanupSessions() {
    const cutoff = now();
    for (const [token, session] of sessions.entries()) {
      if (session.expiresAt <= cutoff) sessions.delete(token);
    }
  }

  function sessionFromRequest(req) {
    cleanupSessions();
    const token = bearerTokenFromRequest(req);
    const session = token ? sessions.get(token) : null;
    if (!session) return null;
    session.expiresAt = now() + ttlMs;
    return session;
  }

  async function forwardResponses(req, res, session) {
    const raw = await readRequestBody(req);
    const body = parseJsonBuffer(raw);
    if (!body) {
      writeError(res, 400, "Invalid JSON.");
      return;
    }
    const converted = responsesToChatCompletions(body, session);
    const upstream = await fetchImpl(`${session.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(converted.body)
    });
    if (converted.body.stream === true) {
      await pipeChatStreamAsResponses(upstream, res, body, session);
      return;
    }
    const payload = Buffer.from(await upstream.arrayBuffer());
    const parsed = parseJsonBuffer(payload);
    if (!upstream.ok) {
      const message = parsed?.error?.message || parsed?.message || payload.toString("utf8") || `Upstream request failed (${upstream.status}).`;
      writeError(res, upstream.status, message);
      return;
    }
    writeJson(res, 200, chatResponseToResponses(parsed || {}, body, session, converted.toolContext));
  }

  async function forwardChatCompletions(req, res, session) {
    const raw = await readRequestBody(req);
    const body = parseJsonBuffer(raw);
    if (!body) {
      writeError(res, 400, "Invalid JSON.");
      return;
    }
    const upstreamBody = { ...body, model: session.model || body.model };
    const upstream = await fetchImpl(`${session.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(upstreamBody)
    });
    const payload = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(payload);
  }

  async function handleRequest(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
        writeJson(res, 200, { ok: true });
        return;
      }
      const session = sessionFromRequest(req);
      if (!session) {
        writeError(res, 401, "Mia Codex proxy token is missing or expired.");
        return;
      }
      if (req.method === "GET" && (url.pathname === "/models" || url.pathname === "/v1/models")) {
        writeJson(res, 200, {
          object: "list",
          data: [{ id: session.model, object: "model", owned_by: "mia" }]
        });
        return;
      }
      if (req.method === "POST" && isResponsesPath(url.pathname)) {
        await forwardResponses(req, res, session);
        return;
      }
      if (req.method === "POST" && isChatCompletionsPath(url.pathname)) {
        await forwardChatCompletions(req, res, session);
        return;
      }
      writeError(res, 404, "Not found.");
    } catch (error) {
      writeError(res, 500, error?.message || error);
    }
  }

  async function start() {
    if (server?.listening && port) return { host, port };
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      const nextServer = http.createServer((req, res) => {
        handleRequest(req, res).catch((error) => writeError(res, 500, error?.message || error));
      });
      nextServer.on("error", reject);
      nextServer.listen(0, host, () => {
        server = nextServer;
        port = Number(nextServer.address()?.port || 0);
        appendLog(`[CodexMiaProxy] listening on ${host}:${port}`);
        resolve({ host, port });
      });
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  async function stop() {
    sessions.clear();
    if (!server) return;
    const active = server;
    server = null;
    port = 0;
    await new Promise((resolve) => active.close(resolve));
  }

  async function createSession(managedModel = {}) {
    const baseUrl = trimTrailingSlash(managedModel.baseUrl || managedModel.base_url);
    const apiKey = String(managedModel.apiKey || managedModel.api_key || "").trim();
    const model = String(managedModel.model || "").trim();
    if (!baseUrl || !apiKey || !model) {
      throw new Error("Mia Codex proxy requires baseUrl, apiKey, and model.");
    }
    const endpoint = await start();
    const token = randomToken();
    sessions.set(token, {
      baseUrl,
      apiKey,
      model,
      responseCalls: new Map(),
      responseOrder: [],
      callIndex: new Map(),
      expiresAt: now() + ttlMs
    });
    return {
      baseUrl: `http://${endpoint.host}:${endpoint.port}/v1`,
      apiKey: token,
      model,
      release: () => sessions.delete(token)
    };
  }

  return {
    createSession,
    start,
    stop,
    status: () => ({ running: Boolean(server?.listening), host, port, sessions: sessions.size }),
    _responsesToChatCompletions: responsesToChatCompletions,
    _chatResponseToResponses: chatResponseToResponses,
    _enrichRequestWithHistory: enrichRequestWithHistory
  };
}

module.exports = {
  chatResponseToResponses,
  createCodexMiaProxy,
  responsesToChatCompletions
};
