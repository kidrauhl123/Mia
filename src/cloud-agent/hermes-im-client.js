"use strict";

const { createHermesGatewayClient } = require("./hermes-gateway-client.js");
const { normalizeGatewayEvent } = require("./hermes-gateway-events.js");
const { normalizeCloudHermesModel } = require("./cloud-hermes-model.js");
const { syncHermesImAttachments } = require("./hermes-im-attachments.js");

function requiredText(label, value) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} required`);
  return text;
}

function botId(bot) {
  return requiredText("bot id", bot?.id || bot?.key);
}

function sessionTitle(args = {}) {
  return String(
    args.bot?.displayName
    || args.bot?.display_name
    || args.bot?.name
    || args.conversationId
    || args.sessionId
    || "Mia"
  ).trim();
}

function normalizeSeedMessages(seedMessages = []) {
  if (!Array.isArray(seedMessages)) return [];
  return seedMessages
    .map((message) => {
      const role = String(message?.role || "").trim();
      const content = String(message?.content || message?.text || "").trim();
      if (!role || !content) return null;
      return { role, content };
    })
    .filter(Boolean);
}

function promptText(promptPrefix, input) {
  const parts = [String(promptPrefix || "").trim(), String(input || "").trim()].filter(Boolean);
  return parts.join("\n\n");
}

function eventMessage(event = {}) {
  if (typeof event.message === "string" && event.message.trim()) return event.message.trim();
  if (typeof event.error === "string" && event.error.trim()) return event.error.trim();
  if (event.error && typeof event.error === "object") {
    const nested = String(event.error.message || event.error.error || "").trim();
    if (nested) return nested;
  }
  return "Hermes gateway error";
}

function createAbortPromise(signal) {
  if (!signal) return { promise: null, cleanup() {} };
  if (signal.aborted) {
    return {
      promise: Promise.reject(signal.reason || new Error("The operation was aborted")),
      cleanup() {}
    };
  }
  let onAbort = null;
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new Error("The operation was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup() {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || new Error("The operation was aborted");
}

async function waitWithAbort(promise, signal) {
  const abort = createAbortPromise(signal);
  try {
    return await Promise.race([promise, abort.promise].filter(Boolean));
  } finally {
    abort.cleanup();
  }
}

function createControlledPromise() {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  promise.catch(() => {});
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    }
  };
}

function createHermesImClient(deps = {}) {
  const gatewayClientFactory = deps.gatewayClientFactory || createHermesGatewayClient;
  const sessionsStore = deps.sessionsStore;
  const normalizeModel = deps.normalizeModel || normalizeCloudHermesModel;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : Date.now;

  async function ensureSession({ gateway, args, botKey }) {
    if (args.transient) {
      return gateway.request("session.create", {
        title: sessionTitle(args),
        source: "mia-cloud",
        cwd: "/data/workspace",
        model: normalizeModel(args.model, { defaultModel: args.workerModel || "mia-auto" }),
        provider: args.modelProvider || "mia",
        reasoning_effort: args.effortLevel || "medium",
        messages: normalizeSeedMessages(args.seedMessages || [])
      });
    }
    if (!sessionsStore) throw new Error("sessionsStore required");

    const existing = sessionsStore.getSession(args.userId, botKey, args.conversationId);
    if (existing?.storedSessionId) {
      try {
        const resumed = await gateway.request("session.resume", { session_id: existing.storedSessionId });
        const runtimeSessionId = String(resumed?.session_id || existing.storedSessionId).trim();
        const storedSessionId = String(resumed?.stored_session_id || existing.storedSessionId).trim();
        sessionsStore.upsertSession({
          userId: args.userId,
          botId: botKey,
          conversationId: args.conversationId,
          runtimeSessionId,
          storedSessionId
        });
        return { session_id: runtimeSessionId, stored_session_id: storedSessionId };
      } catch (error) {
        sessionsStore.clearRuntimeSession(args.userId, botKey, args.conversationId);
      }
    }

    const created = await gateway.request("session.create", {
      title: sessionTitle(args),
      source: "mia-cloud",
      cwd: "/data/workspace",
      model: normalizeModel(args.model, { defaultModel: args.workerModel || "mia-auto" }),
      provider: args.modelProvider || "mia",
      reasoning_effort: args.effortLevel || "medium",
      messages: normalizeSeedMessages(args.seedMessages || [])
    });
    const runtimeSessionId = String(created?.session_id || "").trim();
    const storedSessionId = String(created?.stored_session_id || runtimeSessionId).trim();
    sessionsStore.upsertSession({
      userId: args.userId,
      botId: botKey,
      conversationId: args.conversationId,
      runtimeSessionId,
      storedSessionId
    });
    return { session_id: runtimeSessionId, stored_session_id: storedSessionId };
  }

  async function runChat(args = {}) {
    throwIfAborted(args.signal);
    const gateway = gatewayClientFactory({ apiKey: args.apiKey, nowMs });
    const botKey = botId(args.bot);
    requiredText("gatewayWsUrl", args.gatewayWsUrl);
    requiredText("userId", args.userId);
    requiredText("conversationId", args.conversationId);

    const events = [];
    let content = "";
    let resolved = false;
    const completion = createControlledPromise();
    const abort = createAbortPromise(args.signal);

    gateway.on("*", (rawEvent) => {
      const event = normalizeGatewayEvent(rawEvent);
      events.push(event);
      if (typeof args.onEvent === "function") args.onEvent(event);
      if (event.type === "message.delta" && typeof event.text === "string") content += event.text;
      if (event.type === "message.complete") {
        if (typeof event.content === "string") content = event.content;
        resolved = true;
        completion.resolve();
        return;
      }
      if (event.type === "error") {
        resolved = true;
        completion.reject(new Error(eventMessage(event)));
      }
    });

    try {
      await gateway.connect(args.gatewayWsUrl);
      const session = await ensureSession({ gateway, args, botKey });
      const runtimeSessionId = requiredText("session_id", session?.session_id);
      if (typeof args.onRunCreated === "function") args.onRunCreated(runtimeSessionId);

      const attachmentResult = await syncHermesImAttachments({
        gateway,
        sessionId: runtimeSessionId,
        attachments: args.attachments
      });

      const promptSubmit = gateway.request("prompt.submit", {
        session_id: runtimeSessionId,
        prompt: promptText(attachmentResult.promptPrefix, args.input),
        instructions: String(args.instructions || "").trim(),
        permission_mode: String(args.permissionMode || "").trim() || undefined
      });
      promptSubmit.catch(() => {});

      await Promise.race([promptSubmit, completion.promise, abort.promise].filter(Boolean));
      if (completion.settled) {
        await completion.promise;
      } else {
        await Promise.race([completion.promise, abort.promise].filter(Boolean));
      }
      if (!resolved) throw new Error("Hermes session ended without message.complete");
      return { runId: runtimeSessionId, content, events };
    } finally {
      abort.cleanup();
      gateway.close();
    }
  }

  async function submitApproval(args = {}) {
    throwIfAborted(args.signal);
    const gateway = gatewayClientFactory({ apiKey: args.apiKey, nowMs });
    try {
      await gateway.connect(requiredText("gatewayWsUrl", args.gatewayWsUrl));
      return await waitWithAbort(gateway.request("approval.respond", {
        session_id: requiredText("sessionId", args.sessionId),
        choice: requiredText("choice", args.choice),
        all: Boolean(args.all)
      }), args.signal);
    } finally {
      gateway.close();
    }
  }

  return { runChat, submitApproval };
}

module.exports = {
  createHermesImClient
};
