const crypto = require("node:crypto");

function cleanRunSessionId(value, botKey) {
  const raw = String(value || "").trim();
  const fallback = `${botKey || "mia"}:default`;
  return (raw || fallback)
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 120) || fallback;
}

function firstTextValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(firstTextValue).filter(Boolean).join("");
  }
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "delta", "output", "message", "final_response"]) {
      const nested = firstTextValue(value[key]);
      if (nested) return nested;
    }
  }
  return "";
}

function normalizeHermesError(message) {
  const text = String(message || "").trim();
  if (text.includes("No inference provider configured") || text.includes("no API key was found")) {
    return "Mia Hermes 已启动，但模型还不能调用。请在右侧 Model 选择 preset，填 API key，保存后再发送。";
  }
  return text;
}

function eventText(eventName, payload) {
  if (!payload || typeof payload !== "object") return "";
  if (eventName === "message.delta") return firstTextValue(payload.delta);
  for (const key of ["output", "final_response", "text", "content", "message"]) {
    const value = firstTextValue(payload[key]);
    if (value) return value;
  }
  return "";
}

function parseSseFrame(frame) {
  const dataLines = [];
  let eventName = "";
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join("\n");
  let data = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // Some SSE producers send plain text data.
  }
  return {
    event: eventName || (data && typeof data === "object" ? data.event : "") || "message",
    data
  };
}

function createHermesRunService(deps = {}) {
  const normalizeAttachments = deps.normalizeAttachments || (() => []);
  const attachmentContext = deps.attachmentContext || (() => "");
  const baseUrl = deps.baseUrl;
  const apiKey = deps.apiKey;
  const fetchImpl = deps.fetchImpl || fetch;
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());

  if (typeof normalizeAttachments !== "function") throw new Error("normalizeAttachments dependency is required.");
  if (typeof attachmentContext !== "function") throw new Error("attachmentContext dependency is required.");

  function normalizeRunMessages(messages) {
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

  function buildRunPayload({ bot, sessionId, messages, model = "", effortLevel = "", permissionMode = "" }) {
    const normalized = normalizeRunMessages(messages);
    const instructions = normalized
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n")
      .trim();
    const dialogue = normalized.filter((message) => message.role !== "system");
    const lastUserIndex = dialogue.map((message) => message.role).lastIndexOf("user");
    if (lastUserIndex < 0) {
      throw new Error("No user message found.");
    }
    const lastUser = dialogue[lastUserIndex];
    const attachmentText = attachmentContext(lastUser.attachments);
    const input = [lastUser.content, attachmentText ? `附件上下文：\n${attachmentText}` : ""].filter(Boolean).join("\n\n");
    const conversationHistory = dialogue
      .slice(0, lastUserIndex)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        content: [
          message.content,
          message.role === "user" && message.attachments.length ? attachmentContext(message.attachments) : ""
        ].filter(Boolean).join("\n\n")
      }))
      .filter((message) => message.content);
    const accountId = bot.account_id || bot.key;
    const routeProfile = bot.route_profile || accountId;
    const selectedModel = String(model || "").trim() || "hermes-agent";
    const selectedEffort = String(effortLevel || "").trim();
    const selectedPermission = String(permissionMode || "").trim();
    const body = {
      model: selectedModel,
      input,
      session_id: cleanRunSessionId(sessionId, bot.key),
      account_id: accountId,
      metadata: {
        bot_id: bot.key,
        persona_key: bot.key,
        account_id: accountId,
        route_profile: routeProfile,
        display_name: bot.name
      }
    };
    if (selectedEffort) body.metadata.effort_level = selectedEffort;
    if (selectedPermission) body.metadata.permission_mode = selectedPermission;
    if (instructions) body.instructions = instructions;
    if (conversationHistory.length) body.conversation_history = conversationHistory;
    return body;
  }

  function slashCommandText(messages) {
    const normalized = normalizeRunMessages(messages);
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

  async function readRunEventStream({ runId, signal, emit }) {
    if (typeof baseUrl !== "function") throw new Error("baseUrl dependency is required.");
    if (typeof apiKey !== "function") throw new Error("apiKey dependency is required.");
    const response = await fetchImpl(`${baseUrl()}/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey()}`
      },
      signal
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `${response.status} ${response.statusText}`);
    }
    if (!response.body?.getReader) {
      throw new Error("Hermes run event stream is not readable in this runtime.");
    }

    const reader = response.body.getReader();
    const cancelReader = () => {
      try {
        reader.cancel();
      } catch {
        // Ignore cancellation failures.
      }
    };
    signal?.addEventListener("abort", cancelReader, { once: true });
    const decoder = new TextDecoder();
    const events = [];
    let buffer = "";
    let content = "";
    let finalContent = "";
    let finishReason = "stop";

    let textBlockId = null;
    const consumeFrame = (frame) => {
      const parsed = parseSseFrame(frame);
      if (!parsed) return false;
      const payload = parsed.data && typeof parsed.data === "object" ? parsed.data : { data: parsed.data };
      const name = parsed.event || payload.event || "message";
      if (events.length < 500) {
        events.push({
          event: name,
          run_id: payload.run_id || runId,
          timestamp: payload.timestamp || null,
          data: payload
        });
      }
      if (name === "message.delta") {
        const chunk = eventText(name, payload);
        content += chunk;
        if (emit && chunk) {
          if (!textBlockId) textBlockId = `text_${randomUUID()}`;
          emit("text_delta", { id: textBlockId, text: chunk });
        }
        return false;
      }
      if (name === "message.complete") {
        const text = eventText(name, payload);
        if (text) finalContent = text;
        return false;
      }
      if (name === "reasoning.available") {
        if (emit) {
          const text = String(payload.text || "");
          emit("reasoning_delta", { id: `reasoning_${runId}`, text });
        }
        return false;
      }
      if (name === "tool.started") {
        if (emit) {
          const toolId = `tool_${payload.tool || "unknown"}_${payload.timestamp || Date.now()}`;
          emit("tool_call_started", {
            id: toolId,
            name: String(payload.tool || ""),
            preview: String(payload.preview || "")
          });
        }
        return false;
      }
      if (name === "tool.completed") {
        if (emit) {
          emit("tool_call_completed", {
            name: String(payload.tool || ""),
            duration: typeof payload.duration === "number" ? payload.duration : null,
            error: Boolean(payload.error),
            matchByName: true
          });
        }
        return false;
      }
      if (name === "run.completed") {
        finalContent = eventText(name, payload) || finalContent || content;
        finishReason = "stop";
        return true;
      }
      if (name === "run.cancelled") {
        finishReason = "cancelled";
        return true;
      }
      if (name === "run.failed") {
        const error = firstTextValue(payload.error) || firstTextValue(payload.message) || "Hermes run failed.";
        throw new Error(normalizeHermesError(error));
      }
      return false;
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let splitIndex = buffer.indexOf("\n\n");
        while (splitIndex >= 0) {
          const frame = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          if (consumeFrame(frame)) {
            try {
              await reader.cancel();
            } catch {
              // The stream may already be closed by Hermes.
            }
            return { content: finalContent || content, finishReason, events };
          }
          splitIndex = buffer.indexOf("\n\n");
        }
      }
      const tail = buffer.trim();
      if (tail) consumeFrame(tail);
    } finally {
      signal?.removeEventListener("abort", cancelReader);
      try {
        reader.releaseLock();
      } catch {
        // Ignore release failures on already-closed streams.
      }
    }
    return { content: finalContent || content, finishReason, events };
  }

  function lastUserPrompt(messages) {
    const normalized = normalizeRunMessages(messages);
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
    buildRunPayload,
    cleanRunSessionId,
    lastUserPrompt,
    normalizeError: normalizeHermesError,
    normalizeRunMessages,
    parseSseFrame,
    readRunEventStream,
    slashCommandText
  };
}

module.exports = {
  cleanRunSessionId,
  createHermesRunService,
  firstTextValue,
  normalizeHermesError,
  parseSseFrame
};
