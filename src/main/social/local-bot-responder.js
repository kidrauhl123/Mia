"use strict";

const { CloudEvent } = require("../../shared/cloud-events.js");
const {
  confirmationForReminder,
  parseRelativeReminderIntent
} = require("../reminder-intent.js");

const PROCESSED_CAP = 500;
const HISTORY_MESSAGE_LIMIT = 80;
const HISTORY_MESSAGE_CHAR_LIMIT = 4000;
const HISTORY_TOTAL_CHAR_LIMIT = 24000;

function shouldHandleLocalCloudConversationAi({ isDaemon, daemonEnabled }) {
  // Single owner (ADR 2026-06-12 desktop-single-owner-daemon): only the daemon
  // executes bot turns. The foreground window never falls back to running
  // runtime work because that splits cursor/run/session ownership.
  return Boolean(isDaemon && daemonEnabled);
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

function postedMessageFromResult(result) {
  const direct = result?.message;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const nested = result?.data?.message;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return null;
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

function sanitizeFailureDetail(message) {
  let text = String(message || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[redacted]")
    .replace(/\b((?:api[_-]?key|auth(?:orization)?|auth[_-]?token|token|password|secret)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1[redacted]");
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

function userFacingFailureMessage(message) {
  const detail = sanitizeFailureDetail(message);
  const text = detail || String(message || "").trim();
  let summary = "本地模型运行失败";
  let advice = "请稍后重试或切换模型。";
  if (/(quota|exhaust|RESOURCE_EXHAUSTED|429|credit balance|insufficient credits?|insufficient quota|usage limit|billing|too many requests|rate limit)/i.test(text)) {
    summary = "模型配额已耗尽";
  } else if (/(unauthorized|authentication|auth|login|required to sign in|not logged in|invalid api key|api key invalid|401|403|credential|permission denied)/i.test(text)) {
    summary = "本地引擎认证失败";
    advice = "请检查登录状态、API Key 或切换模型。";
  } else if (/(model.*not found|unknown model|invalid model|model .* unavailable|not available for|unsupported model)/i.test(text)) {
    summary = "当前模型不可用";
  } else if (/(invalid config|config|settings|profile|not configured|missing .*config)/i.test(text)) {
    summary = "本地引擎配置有问题";
    advice = "请检查本地引擎配置或切换模型。";
  } else if (/(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|timed out|network|gateway|connection refused|connect .* failed)/i.test(text)) {
    summary = "本地引擎连接失败";
  }
  const reason = detail ? `原因：${detail}。` : "";
  return `我这次没能生成回复：${summary}。${reason}${advice}`;
}

function normalizedHistoryRole(role) {
  const value = String(role || "").trim();
  if (value === "assistant" || value === "system") return value;
  return "user";
}

function truncateHistoryContent(content) {
  const text = String(content || "").trim();
  if (text.length <= HISTORY_MESSAGE_CHAR_LIMIT) return text;
  return `${text.slice(0, Math.max(0, HISTORY_MESSAGE_CHAR_LIMIT - 1)).trimEnd()}…`;
}

function normalizeHistoryMessages(historyMessages) {
  const rows = (Array.isArray(historyMessages) ? historyMessages : [])
    .map((message) => ({
      role: normalizedHistoryRole(message?.role),
      content: truncateHistoryContent(message?.content)
    }))
    .filter((message) => message.content)
    .slice(-HISTORY_MESSAGE_LIMIT);
  const selected = [];
  let total = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const message = rows[index];
    const nextTotal = total + message.content.length;
    if (selected.length && nextTotal > HISTORY_TOTAL_CHAR_LIMIT) break;
    selected.push(message);
    total = nextTotal;
  }
  return selected.reverse();
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

function normalizeMessageSeq(message) {
  const value = Number(message?.seq);
  return Number.isFinite(value) ? value : 0;
}

function hasBotReplyAfterTrigger(messages, { botId, triggerSeq, triggerMessageId, turnId }) {
  const rows = Array.isArray(messages) ? messages : [];
  const targetBot = String(botId || "");
  const targetTurn = String(turnId || "");
  const triggerId = String(triggerMessageId || "");
  const afterSeq = Number(triggerSeq) || 0;
  for (const message of rows) {
    if (!message || String(message.sender_kind || "") !== "bot") continue;
    if (targetBot && String(message.sender_ref || "") !== targetBot) continue;
    if (afterSeq && normalizeMessageSeq(message) <= afterSeq) continue;
    if (targetTurn && String(message.turn_id || "") === targetTurn) return true;
    const body = String(message.body_md || "").trim();
    const createdAt = String(message.created_at || "").trim();
    if (!targetTurn && (body || createdAt)) return true;
    if (triggerId && String(message.trigger_message_id || "") === triggerId) return true;
  }
  return false;
}

function createLocalBotResponder({ sendChat, postConversationMessageAsBot, listConversationMessages = null, createScheduledTask = null, nowMs = () => Date.now(), emitCloudEvent = () => {}, log = () => {} }) {
  const processed = new Set();
  const inFlight = new Set();

  function remember(key) {
    processed.add(key);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  function emitPostedMessage(conversationId, result) {
    const message = postedMessageFromResult(result);
    if (!conversationId || !message?.id) return;
    emitCloudEvent({
      type: CloudEvent.ConversationMessageAppended,
      conversationId,
      message
    });
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
      emitPostedMessage(conversationId, result);
      return true;
    } catch (postError) {
      log(`[local-bot-responder] failure post failed: ${postError?.message || postError}`);
      return false;
    }
  }

  async function postSchedulerFailureMessage({ conversationId, botId, dedupKey, turnId, error }) {
    const detail = sanitizeFailureDetail(error?.message || error);
    try {
      const result = await postConversationMessageAsBot(conversationId, {
        botId,
        bodyMd: `我没能创建这个提醒。${detail ? `原因：${detail}。` : ""}请稍后重试。`,
        turnId,
        errorJson: { stage: "scheduler", message: detail || String(error?.message || error || "unknown error") },
        clientOpId: errorClientOpIdForDedupKey(dedupKey)
      });
      if (result && result.ok === false) throw new Error(result.error || result.message || "post failed");
      emitPostedMessage(conversationId, result);
      return true;
    } catch (postError) {
      log(`[local-bot-responder] scheduler failure post failed: ${postError?.message || postError}`);
      return false;
    }
  }

  function isGroupConversation(conversationId, conversationType = "") {
    const type = String(conversationType || "").trim();
    if (type) return type === "group";
    const id = String(conversationId || "").trim();
    return id.startsWith("g_") || id.startsWith("g-");
  }

  async function replyAlreadyExists({ conversationId, botId, triggerSeq, triggerMessageId, turnId }) {
    if (typeof listConversationMessages !== "function") return false;
    const sinceSeq = Math.max(0, (Number(triggerSeq) || 0) - 1);
    try {
      const result = await listConversationMessages(conversationId, sinceSeq, 50);
      const messages = Array.isArray(result?.messages) ? result.messages : (Array.isArray(result) ? result : []);
      return hasBotReplyAfterTrigger(messages, { botId, triggerSeq, triggerMessageId, turnId });
    } catch (error) {
      log(`[local-bot-responder] reply existence check failed: ${error?.message || error}`);
      return false;
    }
  }

  async function handleExplicitReminder({ conversationId, botId, dedupKey, triggerMessageId, userPrompt, turnId }) {
    if (typeof createScheduledTask !== "function") return null;
    const intent = parseRelativeReminderIntent(userPrompt, { nowMs: nowMs(), timezone: "Asia/Shanghai" });
    if (!intent) return null;
    try {
      await createScheduledTask({
        title: intent.title,
        botId,
        conversationId,
        sessionId: `conversation:${conversationId}`,
        originMessageId: triggerMessageId,
        trigger: intent.trigger,
        timezone: intent.timezone,
        prompt: intent.prompt
      });
      const result = await postConversationMessageAsBot(conversationId, {
        botId,
        bodyMd: confirmationForReminder(intent),
        turnId,
        clientOpId: clientOpIdForDedupKey(dedupKey),
        trace: {
          tools: [{
            id: "tool_schedule_create",
            name: "schedule_create",
            preview: "create",
            status: "completed",
            duration: 0,
            error: false
          }]
        }
      });
      if (result && result.ok === false) throw new Error(result.error || result.message || "post failed");
      emitPostedMessage(conversationId, result);
      remember(dedupKey);
      return true;
    } catch (error) {
      log(`[local-bot-responder] scheduler create failed: ${error?.message || error}`);
      const didPostFailure = await postSchedulerFailureMessage({ conversationId, botId, dedupKey, turnId, error });
      if (didPostFailure) remember(dedupKey);
      return didPostFailure;
    }
  }

  async function respond({ conversationId, conversationType = "", botId, botSnapshot = null, dedupKey, triggerMessageId = "", triggerSeq = 0, systemPrompt, historyMessages = [], userPrompt, turnId = null, runtimeConfig = null, activeSkillIds = [] }) {
    if (!conversationId || !botId || !dedupKey) return;
    if (processed.has(dedupKey)) return;
    if (inFlight.has(dedupKey)) return;
    inFlight.add(dedupKey);

    const resolvedTriggerMessageId = triggerMessageId || triggerMessageIdForDedupKey(dedupKey);
    if (await replyAlreadyExists({ conversationId, botId, triggerSeq, triggerMessageId: resolvedTriggerMessageId, turnId })) {
      remember(dedupKey);
      inFlight.delete(dedupKey);
      return false;
    }

    const handledReminder = await handleExplicitReminder({
      conversationId,
      botId,
      dedupKey,
      triggerMessageId: resolvedTriggerMessageId,
      userPrompt,
      turnId
    });
    if (handledReminder !== null) {
      inFlight.delete(dedupKey);
      return handledReminder;
    }

    let text = "";
    const runId = runIdForDedupKey(dedupKey);
    const trace = createTraceCollector();
    emitCloudEvent({
      type: "cloud_agent_run_started",
      runId,
      conversationId,
      botId,
      triggerMessageId: resolvedTriggerMessageId
    });
    try {
      const chatArgs = {
        botKey: botId,
        botId,
        sessionId: `conversation:${conversationId}`,
        messages: [
          { role: "system", content: systemPrompt || "" },
          ...normalizeHistoryMessages(historyMessages),
          { role: "user", content: userPrompt || "" }
        ],
        group: isGroupConversation(conversationId, conversationType),
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
      // The engine ran but produced no text (e.g. a tool permission was denied
      // or the turn ended on tool calls only). Post a visible bubble instead of
      // returning silently, so the bot never looks like a dead no-op.
      const didPostEmpty = await postFailureMessage({
        conversationId,
        botId,
        dedupKey,
        turnId,
        stage: "empty",
        error: new Error("本地模型这次没有产生任何文本回复（可能是工具权限被拒，或本轮只调用了工具）")
      });
      if (didPostEmpty) remember(dedupKey);
      inFlight.delete(dedupKey);
      return didPostEmpty;
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
      emitPostedMessage(conversationId, result);
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
  postedMessageFromResult,
  runIdForDedupKey,
  responseText,
  shouldHandleLocalCloudConversationAi
};
