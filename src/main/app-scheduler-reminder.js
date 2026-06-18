"use strict";

const { chatCompletionResponse: defaultChatCompletionResponse } = require("./chat-response.js");
const { normalizeCloudConversationId } = require("./task-conversation.js");
const {
  confirmationForReminder,
  parseRelativeReminderIntent
} = require("./reminder-intent.js");

function lastUserMessage(messages = []) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") return message;
  }
  return null;
}

function resolvedNowMs(nowMs) {
  if (typeof nowMs === "function") return Number(nowMs());
  if (Number.isFinite(Number(nowMs))) return Number(nowMs);
  return Date.now();
}

function reminderToolEvent(error = false) {
  return {
    id: "tool_schedule_create",
    name: "schedule_create",
    preview: "create",
    status: error ? "error" : "completed",
    duration: 0,
    error: Boolean(error)
  };
}

function schedulerFailureContent(error) {
  const message = String(error?.message || error || "").trim();
  return `我没能创建这个提醒。${message ? `原因：${message}。` : ""}请稍后重试。`;
}

function createTaskInput({ intent, botId, conversationId = "", sessionId = "", originMessageId = "" }) {
  const rawConversationId = String(conversationId || "").trim();
  const rawSessionId = String(sessionId || "").trim();
  const source = rawConversationId || rawSessionId;
  return {
    title: intent.title,
    botId: String(botId || ""),
    conversationId: normalizeCloudConversationId(source),
    sessionId: rawSessionId || source,
    originMessageId: String(originMessageId || ""),
    trigger: intent.trigger,
    timezone: intent.timezone,
    prompt: intent.prompt
  };
}

async function createScheduledReminderFromTurn({
  messages = [],
  userPrompt = "",
  botId,
  conversationId = "",
  sessionId = "",
  originMessageId = "",
  createScheduledTask,
  nowMs = Date.now,
  timezone = "Asia/Shanghai"
} = {}) {
  if (typeof createScheduledTask !== "function") return null;
  const lastUser = lastUserMessage(messages);
  const prompt = String(userPrompt || lastUser?.content || lastUser?.text || "").trim();
  const intent = parseRelativeReminderIntent(prompt, { nowMs: resolvedNowMs(nowMs), timezone });
  if (!intent) return null;
  const taskInput = createTaskInput({
    intent,
    botId,
    conversationId,
    sessionId,
    originMessageId: originMessageId || lastUser?.id || ""
  });
  const task = await createScheduledTask(taskInput);
  return { intent, taskInput, task };
}

async function handleReminderChatTurn({
  messages = [],
  bot,
  sessionId = "",
  conversationId = "",
  createScheduledTask,
  chatCompletionResponse = defaultChatCompletionResponse,
  emit = null,
  nowMs = Date.now,
  model = "mia",
  scheduledFire = false,
  background = false
} = {}) {
  if (scheduledFire || background) return null;
  if (typeof createScheduledTask !== "function") return null;
  const botId = String(bot?.key || bot?.id || "").trim();
  if (!botId) return null;
  const lastUser = lastUserMessage(messages);
  const intent = parseRelativeReminderIntent(String(lastUser?.content || lastUser?.text || ""), {
    nowMs: resolvedNowMs(nowMs),
    timezone: "Asia/Shanghai"
  });
  if (!intent) return null;

  emit?.("tool_call_started", {
    id: "tool_schedule_create",
    name: "schedule_create",
    preview: "create"
  });
  let scheduled;
  try {
    scheduled = await createScheduledReminderFromTurn({
      messages,
      botId,
      conversationId,
      sessionId,
      createScheduledTask,
      nowMs,
      timezone: "Asia/Shanghai"
    });
  } catch (error) {
    emit?.("tool_call_completed", reminderToolEvent(true));
    emit?.("complete", { finishReason: "stop", aborted: false });
    return chatCompletionResponse({
      model,
      content: schedulerFailureContent(error),
      mia: {
        transport: "app-scheduler",
        bot_id: botId,
        error: true
      }
    });
  }
  if (!scheduled) return null;
  emit?.("tool_call_completed", reminderToolEvent(false));
  emit?.("complete", { finishReason: "stop", aborted: false });
  const task = scheduled.task && typeof scheduled.task === "object" ? scheduled.task : {};
  return chatCompletionResponse({
    model,
    content: confirmationForReminder(scheduled.intent),
    mia: {
      transport: "app-scheduler",
      bot_id: botId,
      ...(task.id ? { task_id: task.id } : {}),
      ...(task.nextFireAt ? { next_fire_at: task.nextFireAt } : {})
    }
  });
}

module.exports = {
  createScheduledReminderFromTurn,
  handleReminderChatTurn,
  lastUserMessage,
  reminderToolEvent,
  schedulerFailureContent
};
