"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function trimTrailingSlash(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function randomToken() {
  return `mia_claude_${crypto.randomBytes(24).toString("base64url")}`;
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
    type: "error",
    error: {
      type: "mia_proxy_error",
      message: String(message || "Mia Claude proxy request failed.")
    }
  });
}

function bearerTokenFromRequest(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-api-key"] || req.headers["anthropic-api-key"] || "").trim();
}

function readRequestBody(req, limitBytes = 8 * 1024 * 1024) {
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

function normalizeToolParameters(schema) {
  const value = schema && typeof schema === "object" ? schema : {};
  return Object.keys(value).length ? value : { type: "object", properties: {} };
}

function canonicalToolInputJson(value) {
  return JSON.stringify(normalizeJsonValue(value));
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

function anthropicToOpenAiChatBody(body = {}, session = {}) {
  const messages = [];
  addSystemMessages(messages, body.system);
  messages.push(...convertAnthropicMessages(body.messages));
  const out = {
    model: session.model || body.model,
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

function convertOpenAiMessageToAnthropic(payload = {}, requestBody = {}, session = {}) {
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
    model: requestBody.model || session.model || payload.model || "",
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: usageFromOpenAi(payload.usage || {})
  };
}

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function doneFrame() {
  return "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
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

function appendToolCallDelta(toolCalls, deltaCall) {
  const index = Number.isInteger(deltaCall.index) ? deltaCall.index : toolCalls.length;
  const current = toolCalls.get(index) || { index, id: "", name: "", arguments: "" };
  if (deltaCall.id) current.id = String(deltaCall.id);
  if (deltaCall.function?.name) current.name = String(deltaCall.function.name);
  if (deltaCall.function?.arguments) current.arguments += String(deltaCall.function.arguments);
  toolCalls.set(index, current);
}

async function pipeOpenAiStreamAsAnthropic(upstream, res, requestBody = {}, session = {}) {
  res.writeHead(upstream.status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive"
  });
  if (!upstream.ok) {
    const text = await upstream.text();
    res.write(sseFrame("error", {
      type: "error",
      error: { type: "upstream_error", message: text || `Upstream request failed (${upstream.status}).` }
    }));
    res.end();
    return;
  }
  if (!upstream.body?.getReader) {
    res.write(sseFrame("error", {
      type: "error",
      error: { type: "stream_error", message: "Upstream stream is not readable." }
    }));
    res.end();
    return;
  }

  const messageId = `msg_${crypto.randomBytes(12).toString("base64url")}`;
  res.write(sseFrame("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: requestBody.model || session.model || "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  }));

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textBlockStarted = false;
  let textBlockStopped = false;
  let outputTokens = 0;
  let finishReason = "end_turn";
  const toolCalls = new Map();

  function ensureTextBlock() {
    if (textBlockStarted) return;
    textBlockStarted = true;
    res.write(sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    }));
  }

  function stopTextBlock() {
    if (!textBlockStarted || textBlockStopped) return;
    textBlockStopped = true;
    res.write(sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }));
  }

  async function consumeFrameData(data) {
    if (!data || data === "[DONE]") return;
    const parsed = parseJsonBuffer(Buffer.from(data));
    if (!parsed) return;
    if (parsed.usage) outputTokens = usageFromOpenAi(parsed.usage).output_tokens;
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] || {} : {};
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      ensureTextBlock();
      res.write(sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta.content }
      }));
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) appendToolCallDelta(toolCalls, call);
    if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";
    for (const part of parts) {
      for (const data of parseSseDataLines(part)) await consumeFrameData(data);
    }
  }
  buffer += decoder.decode();
  for (const data of parseSseDataLines(buffer)) await consumeFrameData(data);
  stopTextBlock();

  let index = textBlockStarted ? 1 : 0;
  for (const call of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
    res.write(sseFrame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: call.id || `toolu_${crypto.randomBytes(8).toString("base64url")}`,
        name: call.name || "tool",
        input: {}
      }
    }));
    res.write(sseFrame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: canonicalToolInputJson(call.arguments) }
    }));
    res.write(sseFrame("content_block_stop", { type: "content_block_stop", index }));
    index += 1;
  }

  res.write(sseFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: finishReason, stop_sequence: null },
    usage: { output_tokens: outputTokens }
  }));
  res.write(doneFrame());
  res.end();
}

function roughTokenCount(body = {}) {
  const text = [
    contentText(body.system),
    ...(Array.isArray(body.messages) ? body.messages.map((message) => contentText(message?.content)) : [])
  ].filter(Boolean).join("\n");
  return Math.max(1, Math.ceil(text.length / 4));
}

function createClaudeCodeMiaProxy(options = {}) {
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

  async function forwardMessages(req, res, session) {
    const raw = await readRequestBody(req);
    const body = parseJsonBuffer(raw);
    if (!body) {
      writeError(res, 400, "Invalid JSON.");
      return;
    }
    const upstreamBody = anthropicToOpenAiChatBody(body, session);
    const upstream = await fetchImpl(`${session.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(upstreamBody)
    });
    if (body.stream === true) {
      await pipeOpenAiStreamAsAnthropic(upstream, res, body, session);
      return;
    }
    const payload = Buffer.from(await upstream.arrayBuffer());
    const parsed = parseJsonBuffer(payload);
    if (!upstream.ok) {
      const message = parsed?.error?.message || parsed?.message || `Upstream request failed (${upstream.status}).`;
      writeError(res, upstream.status, message);
      return;
    }
    writeJson(res, 200, convertOpenAiMessageToAnthropic(parsed || {}, body, session));
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
        writeError(res, 401, "Mia Claude proxy token is missing or expired.");
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, {
          object: "list",
          data: [{ id: session.model, object: "model", owned_by: "mia" }]
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        const raw = await readRequestBody(req);
        const body = parseJsonBuffer(raw) || {};
        writeJson(res, 200, { input_tokens: roughTokenCount(body) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await forwardMessages(req, res, session);
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
        appendLog(`[ClaudeCodeMiaProxy] listening on ${host}:${port}`);
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
      throw new Error("Mia Claude proxy requires baseUrl, apiKey, and model.");
    }
    const endpoint = await start();
    const token = randomToken();
    sessions.set(token, {
      baseUrl,
      apiKey,
      model,
      expiresAt: now() + ttlMs
    });
    return {
      baseUrl: `http://${endpoint.host}:${endpoint.port}`,
      authToken: token,
      model,
      release: () => sessions.delete(token)
    };
  }

  return {
    createSession,
    start,
    stop,
    status: () => ({ running: Boolean(server?.listening), host, port, sessions: sessions.size }),
    _convertAnthropicMessages: convertAnthropicMessages,
    _anthropicToOpenAiChatBody: anthropicToOpenAiChatBody,
    _convertOpenAiMessageToAnthropic: convertOpenAiMessageToAnthropic
  };
}

module.exports = {
  anthropicToOpenAiChatBody,
  convertOpenAiMessageToAnthropic,
  createClaudeCodeMiaProxy
};
