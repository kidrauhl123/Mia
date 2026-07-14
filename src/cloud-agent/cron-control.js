"use strict";

const crypto = require("node:crypto");

const MAX_CRON_CONTINUATIONS = 4;

function clean(value = "") {
  return String(value || "").trim();
}

function taggedBlocks(text, open, close) {
  const source = String(text || "");
  const blocks = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(open, cursor);
    if (start < 0) break;
    const bodyStart = start + open.length;
    const closeStart = source.indexOf(close, bodyStart);
    if (closeStart < 0) break;
    const end = closeStart + close.length;
    blocks.push({ start, end, body: source.slice(bodyStart, closeStart).trim() });
    cursor = end;
  }
  return blocks;
}

function updateBlocks(text) {
  const source = String(text || "");
  const blocks = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("[CRON_UPDATE:", cursor);
    if (start < 0) break;
    const headerEnd = source.indexOf("]", start);
    if (headerEnd < 0) break;
    const closeStart = source.indexOf("[/CRON_UPDATE]", headerEnd + 1);
    if (closeStart < 0) break;
    const end = closeStart + "[/CRON_UPDATE]".length;
    const jobId = clean(source.slice(start + "[CRON_UPDATE:".length, headerEnd));
    if (jobId) {
      blocks.push({
        start,
        end,
        jobId,
        body: source.slice(headerEnd + 1, closeStart).trim()
      });
    }
    cursor = end;
  }
  return blocks;
}

function inlineCommands(text, prefix) {
  const source = String(text || "");
  const commands = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(prefix, cursor);
    if (start < 0) break;
    const endBracket = source.indexOf("]", start + prefix.length);
    if (endBracket < 0) break;
    const value = clean(source.slice(start + prefix.length, endBracket));
    if (value) commands.push({ start, end: endBracket + 1, value });
    cursor = endBracket + 1;
  }
  return commands;
}

function parseFields(body) {
  const fields = { name: "", schedule: "", scheduleDescription: "", message: "" };
  const messageLines = [];
  let inMessage = false;
  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (inMessage) {
      messageLines.push(line);
    } else if (line.startsWith("name:")) {
      fields.name = clean(line.slice("name:".length));
    } else if (line.startsWith("schedule_description:")) {
      fields.scheduleDescription = clean(line.slice("schedule_description:".length));
    } else if (line.startsWith("schedule:")) {
      fields.schedule = clean(line.slice("schedule:".length));
    } else if (line.startsWith("message:")) {
      inMessage = true;
      messageLines.push(clean(line.slice("message:".length)));
    }
  }
  while (messageLines.length && !messageLines.at(-1)) messageLines.pop();
  fields.message = messageLines.join("\n");
  return Object.values(fields).every(Boolean) ? fields : null;
}

function detectCronCommands(text) {
  const source = String(text || "");
  const commands = [];
  for (const block of taggedBlocks(source, "[CRON_CREATE]", "[/CRON_CREATE]")) {
    const fields = parseFields(block.body);
    if (fields) commands.push({ type: "create", ...fields });
  }
  for (const block of updateBlocks(source)) {
    const fields = parseFields(block.body);
    if (fields) commands.push({ type: "update", jobId: block.jobId, ...fields });
  }
  if (source.includes("[CRON_LIST]")) commands.push({ type: "list" });
  for (const command of inlineCommands(source, "[CRON_DELETE:")) {
    commands.push({ type: "delete", jobId: command.value });
  }
  return commands;
}

function stripCronCommands(text) {
  const source = String(text || "");
  const ranges = [
    ...taggedBlocks(source, "[CRON_CREATE]", "[/CRON_CREATE]").map(({ start, end }) => ({ start, end })),
    ...updateBlocks(source).map(({ start, end }) => ({ start, end })),
    ...inlineCommands(source, "[CRON_DELETE:").map(({ start, end }) => ({ start, end }))
  ];
  let cursor = 0;
  while (true) {
    const start = source.indexOf("[CRON_LIST]", cursor);
    if (start < 0) break;
    ranges.push({ start, end: start + "[CRON_LIST]".length });
    cursor = start + "[CRON_LIST]".length;
  }
  ranges.sort((a, b) => a.start - b.start);
  let output = "";
  cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor || range.end > source.length) continue;
    output += source.slice(cursor, range.start);
    cursor = range.end;
  }
  return (output + source.slice(cursor)).trim();
}

function scopedTasks(taskApi, userId, botId, conversationId) {
  const tasks = typeof taskApi?.list === "function" ? taskApi.list(userId) : [];
  return (Array.isArray(tasks) ? tasks : []).filter((task) => (
    clean(task?.botId || task?.bot_id) === clean(botId)
      && clean(task?.conversationId || task?.conversation_id) === clean(conversationId)
  ));
}

function taskSchedule(task = {}) {
  const trigger = task.trigger && typeof task.trigger === "object" ? task.trigger : {};
  return trigger.type === "cron" ? clean(trigger.cron) : clean(trigger.at);
}

function taskListResponse(tasks) {
  if (!tasks.length) {
    return "[System: No scheduled tasks. The user's scheduling request is not complete. Output CRON_CREATE now and do not confirm success before creation succeeds.]";
  }
  return [
    "[System: Scheduled tasks for this conversation:",
    ...tasks.map((task) => `- id: ${task.id}; name: ${task.title || "未命名任务"}; schedule: ${taskSchedule(task)}; status: ${task.status || "active"}; message: ${task.prompt || ""}`),
    "]"
  ].join("\n");
}

function outcomeFor(command, response, successful) {
  const names = {
    create: "创建 Mia 定时任务",
    update: "更新 Mia 定时任务",
    list: "读取 Mia 定时任务",
    delete: "删除 Mia 定时任务"
  };
  const id = `mia_cron_${crypto.randomUUID().replace(/-/g, "")}`;
  const name = names[command.type] || "处理 Mia 定时任务";
  const preview = successful
    ? (command.type === "list" ? "已读取当前会话的定时任务列表" : response.replace(/^\[System:\s*|\]$/g, ""))
    : `处理失败：${response.replace(/^\[System:\s*|\]$/g, "")}`;
  return [
    { type: "tool.started", id, name, status: "running" },
    { type: "tool.completed", id, name, status: successful ? "completed" : "failed", error: !successful, preview }
  ];
}

async function executeCommand(command, context) {
  const { taskApi, userId, botId, conversationId, originMessageId } = context;
  const tasks = scopedTasks(taskApi, userId, botId, conversationId);
  try {
    if (command.type === "list") return { response: taskListResponse(tasks), successful: true };
    if (command.type === "create") {
      if (typeof taskApi?.create !== "function") throw new Error("cloud task create is unavailable");
      const created = await taskApi.create(userId, {
        title: command.name,
        botId,
        conversationId,
        sessionId: conversationId,
        originMessageId: clean(originMessageId),
        schedule: command.schedule,
        timezone: "Asia/Shanghai",
        fireMode: "agent",
        prompt: command.message
      });
      return { response: `[System: Created cron job '${command.name}' (id: ${created.id})]`, successful: true };
    }
    const task = tasks.find((item) => clean(item.id) === clean(command.jobId));
    if (!task) {
      return { response: `[System: Scheduled task ${command.jobId} not found in this conversation]`, successful: false };
    }
    if (command.type === "update") {
      if (typeof taskApi?.update !== "function") throw new Error("cloud task update is unavailable");
      await taskApi.update(userId, command.jobId, {
        title: command.name,
        schedule: command.schedule,
        timezone: task.timezone || "Asia/Shanghai",
        fireMode: "agent",
        prompt: command.message,
        status: "active"
      });
      return { response: `[System: Updated cron job '${command.name}' (id: ${command.jobId})]`, successful: true };
    }
    if (command.type === "delete") {
      if (typeof taskApi?.delete !== "function") throw new Error("cloud task delete is unavailable");
      await taskApi.delete(userId, command.jobId);
      return { response: `[System: Deleted cron job ${command.jobId}]`, successful: true };
    }
  } catch (error) {
    return { response: `[System: Failed to ${command.type} cron job: ${error?.message || error}]`, successful: false };
  }
  return { response: `[System: Unsupported cron command ${command.type}]`, successful: false };
}

async function processCloudCronTurn(args = {}) {
  const commands = detectCronCommands(args.assistantText);
  const count = Math.max(0, Number(args.continuationCount) || 0);
  if (!commands.length) {
    return { visibleText: String(args.assistantText || ""), continuation: null, nextCount: count, traceEvents: [] };
  }
  const visibleText = stripCronCommands(args.assistantText);
  if (count >= MAX_CRON_CONTINUATIONS) {
    return { visibleText, continuation: null, nextCount: count, traceEvents: [] };
  }
  const responses = [];
  const traceEvents = [];
  for (const command of commands) {
    const outcome = await executeCommand(command, args);
    responses.push(outcome.response);
    traceEvents.push(...outcomeFor(command, outcome.response, outcome.successful));
  }
  return {
    visibleText,
    continuation: responses.length ? responses.join("\n") : null,
    nextCount: count + 1,
    traceEvents
  };
}

module.exports = {
  MAX_CRON_CONTINUATIONS,
  detectCronCommands,
  processCloudCronTurn,
  stripCronCommands
};
