"use strict";

const PROCESSED_CAP = 500;

function shouldHandleLocalCloudConversationAi({ isDaemon, daemonEnabled, daemonReachable = false }) {
  // Single owner (ADR 2026-06-12 desktop-single-owner-daemon): while the daemon
  // is enabled it is the only executor; the window runs an invocation only as a
  // dead-daemon fallback (reachability probed by the caller). With the daemon
  // disabled the window is the sole owner. Never both.
  if (isDaemon) return Boolean(daemonEnabled);
  if (!daemonEnabled) return true;
  return !daemonReachable;
}

function clientOpIdForDedupKey(dedupKey) {
  const safe = String(dedupKey || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return `op_bot_reply_${safe || "unknown"}`;
}

function errorClientOpIdForDedupKey(dedupKey) {
  return clientOpIdForDedupKey(dedupKey).replace(/^op_bot_reply_/, "op_bot_reply_error_");
}

function responseText(result) {
  const message = result?.choices?.[0]?.message || result?.message || {};
  return String(message.content || result?.content || "").trim();
}

function normalizeToolStatus(status) {
  const value = String(status || "").trim();
  if (value === "complete" || value === "completed") return "completed";
  if (value === "error" || value === "failed") return "error";
  return "running";
}

function toolFromTrace(trace, data = {}) {
  const id = String(data?.id || "");
  const name = String(data?.name || "");
  let tool = id ? trace.toolsById.get(id) : null;
  if (!tool && name) {
    const queue = trace.toolsByName.get(name);
    tool = queue && queue.find((item) => item.status === "running");
  }
  return tool || null;
}

function createTraceCollector() {
  const trace = {
    reasoning: "",
    tools: [],
    toolsById: new Map(),
    toolsByName: new Map()
  };

  function collect(kind, data = {}) {
    switch (kind) {
      case "reasoning_delta":
        trace.reasoning += String(data?.text || "");
        if (trace.reasoning && !trace.reasoning.endsWith("\n")) trace.reasoning += "\n";
        break;
      case "tool_call_started": {
        const tool = {
          id: String(data?.id || `tool_${trace.tools.length}`),
          name: String(data?.name || "工具"),
          preview: String(data?.preview || ""),
          status: "running",
          duration: null,
          error: false
        };
        trace.tools.push(tool);
        trace.toolsById.set(tool.id, tool);
        const queue = trace.toolsByName.get(tool.name) || [];
        queue.push(tool);
        trace.toolsByName.set(tool.name, queue);
        break;
      }
      case "tool_call_delta": {
        const tool = toolFromTrace(trace, data);
        if (tool) tool.preview = String(data?.preview || tool.preview || "");
        break;
      }
      case "tool_call_completed": {
        const tool = toolFromTrace(trace, data);
        if (tool) {
          tool.status = data?.error ? "error" : normalizeToolStatus(data?.status || "completed");
          tool.duration = typeof data?.duration === "number" ? data.duration : null;
          tool.error = Boolean(data?.error);
          if (data?.preview) tool.preview = String(data.preview);
        }
        break;
      }
      default:
        break;
    }
  }

  function payload() {
    const reasoning = String(trace.reasoning || "").trim();
    const tools = trace.tools.map((tool) => ({
      id: String(tool.id || ""),
      name: String(tool.name || ""),
      preview: String(tool.preview || ""),
      status: normalizeToolStatus(tool.status),
      duration: typeof tool.duration === "number" ? tool.duration : null,
      error: Boolean(tool.error)
    })).filter((tool) => tool.name);
    if (!reasoning && !tools.length) return null;
    return {
      ...(reasoning ? { reasoning } : {}),
      ...(tools.length ? { tools } : {})
    };
  }

  return { collect, payload };
}

function runIdForDedupKey(dedupKey) {
  return `local_${clientOpIdForDedupKey(dedupKey).replace(/^op_/, "")}`;
}

function triggerMessageIdForDedupKey(dedupKey) {
  return String(dedupKey || "").split(":")[0] || "";
}

function userFacingFailureMessage(message) {
  const text = String(message || "").trim();
  if (/(quota|exhaust|RESOURCE_EXHAUSTED|429)/i.test(text)) {
    return "我这次没能生成回复：模型配额已耗尽，请稍后重试或切换模型。";
  }
  return "我这次没能生成回复：本地模型运行失败，请稍后重试或切换模型。";
}

// Composer "使用" chips travel with the user's cloud message (skills_json). Pull
// the selected skill ids off the triggering message so the responder can drive
// the agent with them — one source of truth, works across devices.
function activeSkillIdsFromMessage(message) {
  const raw = message && message.skills_json;
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const ids = [];
  const seen = new Set();
  for (const skill of parsed) {
    if (ids.length >= 16) break;
    // Accept only a plain string id or a { id: string } object — never coerce
    // arbitrary objects/numbers (which would stringify to junk skill ids).
    const value = typeof skill === "string" ? skill : (skill && typeof skill.id === "string" ? skill.id : "");
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function createLocalBotResponder({ sendChat, postConversationMessageAsBot, emitCloudEvent = () => {}, log = () => {} }) {
  const processed = new Set();
  const inFlight = new Set();

  function remember(key) {
    processed.add(key);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  async function postFailureMessage({ conversationId, botId, dedupKey, turnId, stage, error }) {
    const message = String(error?.message || error || "unknown error");
    try {
      const result = await postConversationMessageAsBot(conversationId, {
        botId,
        bodyMd: userFacingFailureMessage(message),
        turnId,
        errorJson: { stage, message },
        clientOpId: errorClientOpIdForDedupKey(dedupKey)
      });
      if (result && result.ok === false) throw new Error(result.error || result.message || "post failed");
      return true;
    } catch (postError) {
      log(`[local-bot-responder] failure post failed: ${postError?.message || postError}`);
      return false;
    }
  }

  async function respond({ conversationId, botId, botSnapshot = null, dedupKey, systemPrompt, userPrompt, turnId = null, runtimeConfig = null, activeSkillIds = [] }) {
    if (!conversationId || !botId || !dedupKey) return;
    if (processed.has(dedupKey)) return;
    if (inFlight.has(dedupKey)) return;
    inFlight.add(dedupKey);

    let text = "";
    const runId = runIdForDedupKey(dedupKey);
    const trace = createTraceCollector();
    emitCloudEvent({
      type: "cloud_agent_run_started",
      runId,
      conversationId,
      botId,
      triggerMessageId: triggerMessageIdForDedupKey(dedupKey)
    });
    try {
      const chatArgs = {
        botKey: botId,
        botId,
        sessionId: `conversation:${conversationId}`,
        messages: [
          { role: "system", content: systemPrompt || "" },
          { role: "user", content: userPrompt || "" }
        ],
        group: true,
        utility: true,
        persistAgentSession: true,
        allowSlashCommands: false
      };
      if (botSnapshot && typeof botSnapshot === "object") chatArgs.botSnapshot = botSnapshot;
      if (runtimeConfig && typeof runtimeConfig === "object") chatArgs.runtimeConfig = runtimeConfig;
      // Composer skill chips that rode in on the triggering message: merge them
      // into this turn so the chip actually reaches the engine (sendChat folds
      // them into capabilities.enabledSkills and prepends a "use these" directive).
      if (Array.isArray(activeSkillIds) && activeSkillIds.length) chatArgs.activeSkillIds = activeSkillIds;
      chatArgs.emit = (kind, data = {}) => {
        if (!kind || kind === "session_started") return;
        trace.collect(kind, data);
        emitCloudEvent({
          type: "cloud_agent_run_event",
          runId,
          conversationId,
          botId,
          event: { type: kind, ...(data && typeof data === "object" ? data : {}) }
        });
      };
      const result = await sendChat(chatArgs);
      text = responseText(result);
    } catch (error) {
      log(`[local-bot-responder] engine failed: ${error?.message || error}`);
      emitCloudEvent({
        type: "cloud_agent_run_event",
        runId,
        conversationId,
        botId,
        event: { type: "run.failed", error: String(error?.message || error) }
      });
      const didPostFailure = await postFailureMessage({
        conversationId,
        botId,
        dedupKey,
        turnId,
        stage: "engine",
        error
      });
      if (didPostFailure) remember(dedupKey);
      inFlight.delete(dedupKey);
      return didPostFailure;
    }
    if (!text) {
      emitCloudEvent({
        type: "cloud_agent_run_event",
        runId,
        conversationId,
        botId,
        event: { type: "run.failed", error: "empty response" }
      });
      inFlight.delete(dedupKey);
      return;
    }

    try {
      const tracePayload = trace.payload();
      const result = await postConversationMessageAsBot(conversationId, {
        botId,
        bodyMd: text,
        turnId,
        clientOpId: clientOpIdForDedupKey(dedupKey),
        ...(tracePayload ? { trace: tracePayload } : {})
      });
      if (result && result.ok === false) throw new Error(result.error || result.message || "post failed");
      remember(dedupKey);
      inFlight.delete(dedupKey);
      return true;
    } catch (error) {
      log(`[local-bot-responder] post failed: ${error?.message || error}`);
      emitCloudEvent({
        type: "cloud_agent_run_event",
        runId,
        conversationId,
        botId,
        event: { type: "run.failed", error: String(error?.message || error) }
      });
      inFlight.delete(dedupKey);
      return false;
    }
  }

  return { respond };
}

module.exports = {
  activeSkillIdsFromMessage,
  clientOpIdForDedupKey,
  createLocalBotResponder,
  runIdForDedupKey,
  responseText,
  shouldHandleLocalCloudConversationAi
};
