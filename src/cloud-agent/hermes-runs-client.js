const fs = require("node:fs");
const path = require("node:path");

const MAX_NATIVE_IMAGE_BYTES = 20 * 1024 * 1024;

function cleanBaseUrl(value) {
  const base = String(value || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("Hermes baseUrl required");
  return base;
}

function botKey(bot) {
  const key = String(bot?.id || bot?.key || "").trim();
  if (!key) throw new Error("bot id required");
  return key;
}

function botDisplayName(bot, fallback) {
  return String(bot?.displayName || bot?.display_name || bot?.name || fallback || "").trim();
}

function botInstructions(bot) {
  return String(bot?.personaText || bot?.persona_text || "").trim();
}

function parseErrorMessage(text) {
  try {
    return JSON.parse(text).error?.message || text;
  } catch {
    return text;
  }
}

function parseSseBlock(block) {
  const eventName = block
    .split(/\n/)
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const dataLines = block
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (!dataLines.length) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data);
    if (eventName && parsed && typeof parsed === "object" && !parsed.type && !parsed.event) {
      return { type: eventName, ...parsed };
    }
    return parsed;
  } catch {
    return { type: eventName || "raw", data };
  }
}

function imageMimeForAttachment(attachment = {}) {
  const explicit = String(attachment.mimeType || attachment.mime || "").trim().toLowerCase();
  if (explicit.startsWith("image/")) return explicit;
  const ext = path.extname(String(attachment.name || attachment.path || attachment.hostPath || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "";
}

function imageDataUrlForAttachment(attachment = {}, fsImpl = fs) {
  const existing = String(attachment.dataUrl || "").trim();
  if (/^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(existing) && Buffer.byteLength(existing, "utf8") <= MAX_NATIVE_IMAGE_BYTES * 2) {
    return existing;
  }
  const mimeType = imageMimeForAttachment(attachment);
  if (!mimeType) return "";
  const hostPath = String(attachment.hostPath || "").trim();
  if (!hostPath) return "";
  try {
    const stat = fsImpl.statSync(hostPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_NATIVE_IMAGE_BYTES) return "";
    const encoded = fsImpl.readFileSync(hostPath).toString("base64");
    return `data:${mimeType};base64,${encoded}`;
  } catch {
    return "";
  }
}

function inputForHermesRuns(input, attachments = [], fsImpl = fs) {
  const text = String(input || "");
  const incoming = Array.isArray(attachments) ? attachments : [];
  const imageParts = [];
  const pathHints = [];
  for (const attachment of incoming) {
    const dataUrl = imageDataUrlForAttachment(attachment, fsImpl);
    if (!dataUrl) continue;
    imageParts.push({ type: "image_url", image_url: { url: dataUrl } });
    const hintPath = String(attachment.path || attachment.name || attachment.id || "").trim();
    if (hintPath) pathHints.push(`[Image attached at: ${hintPath}]`);
  }
  if (!imageParts.length) return text;
  const textPart = [text.trim() || "What do you see in this image?", pathHints.join("\n")]
    .filter(Boolean)
    .join("\n\n");
  return [{
    role: "user",
    content: [
      { type: "text", text: textPart },
      ...imageParts
    ]
  }];
}

function eventType(event = {}) {
  return String(event.type || event.event || "");
}

function eventErrorMessage(event = {}) {
  const error = event.error || event.data?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") return String(error.message || error.error || JSON.stringify(error));
  if (typeof event.message === "string") return event.message;
  return "";
}

function createHermesRunsClient(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const fsImpl = deps.fs || fs;

  async function createRun({ baseUrl, apiKey, body, headers, signal }) {
    const response = await fetchImpl(`${cleanBaseUrl(baseUrl)}/v1/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...headers
      },
      body: JSON.stringify(body),
      signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(parseErrorMessage(text) || `Hermes run failed: ${response.status}`);
    const run = JSON.parse(text);
    const runId = run.run_id || run.id;
    if (!runId) throw new Error("Hermes did not return a run id.");
    return runId;
  }

  // Consume the run's SSE stream INCREMENTALLY so events surface as they arrive.
  // This matters for the approval handshake: when a tool needs approval the run
  // pauses at "waiting_for_approval" and the stream stays open, so reading the
  // body to completion first (the old behavior) would hang and never deliver the
  // approval.request event. onEvent fires live; the caller POSTs the approval on
  // a separate path, which unblocks the server and resumes the stream.
  async function readEvents({ baseUrl, apiKey, runId, signal, onEvent }) {
    const response = await fetchImpl(`${cleanBaseUrl(baseUrl)}/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      signal
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(parseErrorMessage(text) || `Hermes events failed: ${response.status}`);
    }

    const events = [];
    let content = "";
    let failure = "";
    const handleEvent = (event) => {
      if (!event) return;
      events.push(event);
      if (typeof onEvent === "function") onEvent(event);
      const type = eventType(event);
      if (type === "run.failed" || type === "message.failed" || event.status === "failed") {
        failure = eventErrorMessage(event) || "Hermes run failed.";
      }
      const delta = event.delta || event.content_delta || event.text_delta || "";
      if (typeof delta === "string") content += delta;
      if (typeof event.content === "string" && (type === "message.completed" || type === "run.completed")) {
        content = event.content;
      }
    };

    const body = response.body;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\n\n+/);
        buffer = parts.pop() ?? "";
        for (const block of parts) handleEvent(parseSseBlock(block));
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleEvent(parseSseBlock(buffer));
    } else {
      // Fallback for fetch mocks / responses without a streamable body.
      const text = await response.text();
      for (const block of String(text || "").split(/\n\n+/)) handleEvent(parseSseBlock(block));
    }
    return { events, content, error: failure };
  }

  // Resolve a pending run approval. choice ∈ once | session | always | deny;
  // pass all:true to clear every pending approval on the run at once.
  async function submitApproval({ baseUrl, apiKey, runId, choice, all = false, signal }) {
    const response = await fetchImpl(`${cleanBaseUrl(baseUrl)}/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({ choice, ...(all ? { all: true } : {}) }),
      signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(parseErrorMessage(text) || `Hermes approval failed: ${response.status}`);
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true };
    }
  }

  async function runChat(args = {}) {
    const key = botKey(args.bot);
    const displayName = botDisplayName(args.bot, key);
    const instructions = String(args.instructions || "").trim()
      || (args.metadataRole === "group-conductor" ? "" : botInstructions(args.bot));
    const userId = String(args.userId || "").trim();
    const conversationId = String(args.conversationId || "").trim();
    if (!userId) throw new Error("userId required");
    if (!conversationId) throw new Error("conversationId required");
    const sessionId = String(args.sessionId || "").trim() || `cloud:${userId}:${key}:${conversationId}`;
    const attachments = Array.isArray(args.attachments) ? args.attachments : [];
    const body = {
      model: args.model || "mia-default",
      input: inputForHermesRuns(args.input || "", attachments, fsImpl),
      session_id: sessionId,
      conversation_history: Array.isArray(args.conversationHistory) ? args.conversationHistory : [],
      attachments: attachments
        .map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          kind: attachment.kind,
          path: attachment.path
        })),
      metadata: {
        bot_id: key,
        persona_key: key,
        account_id: userId,
        route_profile: "cloud-hermes",
        display_name: displayName,
        role: args.metadataRole || "chat",
        effort_level: args.effortLevel || "medium",
        permission_mode: args.permissionMode || "ask",
        conversation_id: conversationId,
        attachments: attachments
          .map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            path: attachment.path
          }))
      }
    };
    if (instructions) body.instructions = instructions;
    const headers = {
      "X-Mia-Bot": key,
      "X-Alkaka-Bot": key,
      "X-Hermes-Session-Key": sessionId
    };
    const runId = await createRun({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      body,
      headers,
      signal: args.signal
    });
    if (typeof args.onRunCreated === "function") args.onRunCreated(runId);
    const stream = await readEvents({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      runId,
      signal: args.signal,
      onEvent: args.onEvent
    });
    if (stream.error) throw new Error(stream.error);
    return { runId, content: stream.content || "", events: stream.events };
  }

  return { runChat, submitApproval };
}

module.exports = { createHermesRunsClient };
