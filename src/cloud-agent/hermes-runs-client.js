function cleanBaseUrl(value) {
  const base = String(value || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("Hermes baseUrl required");
  return base;
}

function fellowKey(fellow) {
  const key = String(fellow?.id || fellow?.key || "").trim();
  if (!key) throw new Error("fellow id required");
  return key;
}

function parseErrorMessage(text) {
  try {
    return JSON.parse(text).error?.message || text;
  } catch {
    return text;
  }
}

function parseSseEvents(text, onEvent = null) {
  const events = [];
  let content = "";
  for (const block of String(text || "").split(/\n\n+/)) {
    const dataLines = block
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const data = dataLines.join("\n");
    if (data === "[DONE]") continue;
    let event = null;
    try {
      event = JSON.parse(data);
    } catch {
      event = { type: "raw", data };
    }
    events.push(event);
    if (typeof onEvent === "function") onEvent(event);
    const delta = event.delta || event.content_delta || event.text_delta || "";
    if (typeof delta === "string") content += delta;
    if (typeof event.content === "string" && (event.type === "message.completed" || event.type === "run.completed")) {
      content = event.content;
    }
  }
  return { events, content };
}

function createHermesRunsClient(deps = {}) {
  const fetchImpl = deps.fetch || fetch;

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

  async function readEvents({ baseUrl, runId, signal, onEvent }) {
    const response = await fetchImpl(`${cleanBaseUrl(baseUrl)}/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(parseErrorMessage(text) || `Hermes events failed: ${response.status}`);
    return parseSseEvents(text, onEvent);
  }

  async function runChat(args = {}) {
    const key = fellowKey(args.fellow);
    const userId = String(args.userId || "").trim();
    const roomId = String(args.roomId || "").trim();
    if (!userId) throw new Error("userId required");
    if (!roomId) throw new Error("roomId required");
    const sessionId = `cloud:${userId}:${key}:${roomId}`;
    const body = {
      model: args.model || "hermes-agent",
      input: String(args.input || ""),
      session_id: sessionId,
      conversation_history: Array.isArray(args.conversationHistory) ? args.conversationHistory : [],
      attachments: Array.isArray(args.attachments)
        ? args.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          kind: attachment.kind,
          path: attachment.path
        }))
        : [],
      metadata: {
        fellow_key: key,
        persona_key: key,
        account_id: userId,
        route_profile: "cloud-hermes",
        room_id: roomId,
        attachments: Array.isArray(args.attachments)
          ? args.attachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            path: attachment.path
          }))
          : []
      }
    };
    const headers = {
      "X-Aimashi-Fellow": key,
      "X-Alkaka-Fellow": key,
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
      runId,
      signal: args.signal,
      onEvent: args.onEvent
    });
    return { runId, content: stream.content || "", events: stream.events };
  }

  return { runChat };
}

module.exports = { createHermesRunsClient };
