const fs = require("node:fs");
const path = require("node:path");
const { parseAttachmentsFromMessage } = require("./attachment-materializer.js");
const { createGroupOrchestrator } = require("./group-orchestrator.js");
const { MemberKind } = require("../shared/conversation-kinds.js");
const { CloudEvent } = require("../shared/cloud-events.js");
const { decisionToHermesChoice } = require("../shared/agent-permissions.js");
const { miaRuntimeSystemPrompt } = require("../main/mia-runtime-context.js");
const { confirmationForReminder } = require("../main/reminder-intent.js");
const {
  createScheduledReminderFromTurn,
  reminderToolEvent,
  schedulerFailureContent
} = require("../main/app-scheduler-reminder.js");

const BOT_MEMBER_KIND = "bot";
const BOT_SENDER_KIND = "bot";
const DESKTOP_INVOCATION_HISTORY_LIMIT = 200;

function botForMember(member, bots) {
  const ref = member?.member_ref;
  return (Array.isArray(bots) ? bots : [])
    .find((item) => item?.id === ref || item?.key === ref) || null;
}

function botDisplayName(bot) {
  return bot?.displayName || bot?.display_name || bot?.name || "";
}

function runtimeDeviceId(config = {}) {
  return String(config.deviceId || config.device_id || config.targetDeviceId || config.target_device_id || "").trim();
}

function runtimeDeviceName(device = {}, fallback = "") {
  return String(device.deviceName || device.device_name || device.name || fallback || "目标设备").trim();
}

function findRuntimeDevice(devices = [], deviceId = "") {
  const wanted = String(deviceId || "").trim();
  if (!wanted) return null;
  return (Array.isArray(devices) ? devices : []).find((device) => (
    String(device?.id || "") === wanted
      || String(device?.deviceId || "") === wanted
      || (Array.isArray(device?.aliases) && device.aliases.map((id) => String(id || "")).includes(wanted))
  )) || null;
}

function memberDisplayName(member, bots) {
  if (member?.member_kind === BOT_MEMBER_KIND) {
    const bot = botForMember(member, bots);
    return botDisplayName(bot) || member.bot_name || member.member_ref || "Bot";
  }
  const user = member?.user && typeof member.user === "object" ? member.user : null;
  return member?.username || member?.displayName || member?.display_name || user?.username || user?.displayName || member?.member_ref || "用户";
}

function groupRoster(members, bots) {
  return (Array.isArray(members) ? members : [])
    .map((member) => {
      const kind = member?.member_kind === BOT_MEMBER_KIND ? "bot" : "user";
      return `- ${memberDisplayName(member, bots)} (${kind}:${member?.member_ref || ""})`;
    })
    .join("\n");
}

function inputWithGroupContext(input, members, bots, bot) {
  const roster = groupRoster(members, bots);
  if (!roster) return input;
  const name = String(botDisplayName(bot) || bot?.id || bot?.key || "Bot").trim();
  return [
    `你是 ${name}，正在一个群聊里发言。`,
    `群成员：\n${roster}`,
    `用户消息：\n${input || ""}`
  ].join("\n\n");
}

function inputWithPrivateContext(input, bot) {
  const name = String(botDisplayName(bot) || bot?.id || bot?.key || "Bot").trim();
  return [
    `你是 ${name}，正在和用户私聊。`,
    `用户消息：\n${input || ""}`
  ].join("\n\n");
}

function inputWithConversationContext(input, { conversationType, members, bots, bot } = {}) {
  return conversationType === "group"
    ? inputWithGroupContext(input, members, bots, bot)
    : inputWithPrivateContext(input, bot);
}

function isScheduledFireMessage(message = {}) {
  return String(message.turn_id || message.turnId || "").startsWith("task:");
}

function cloudRuntimeInstructions(bot, message = {}) {
  return [
    miaRuntimeSystemPrompt({ scheduledFire: isScheduledFireMessage(message) }),
    String(bot?.personaText || bot?.persona_text || "").trim()
  ].filter(Boolean).join("\n\n");
}

function writeSchedulerContext(worker = {}, context = {}) {
  const hermesHome = String(worker?.paths?.hermesHome || "").trim();
  if (!hermesHome) return false;
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(
    path.join(hermesHome, "mia-scheduler-context.json"),
    JSON.stringify({
      botId: String(context.botId || ""),
      conversationId: String(context.conversationId || ""),
      sessionId: String(context.sessionId || ""),
      originMessageId: String(context.originMessageId || "")
    }, null, 2) + "\n",
    { mode: 0o600 }
  );
  return true;
}

function selectedSkillIdsFromMessage(message) {
  let parsed = null;
  try {
    parsed = JSON.parse(message?.skills_json || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = [];
  const seen = new Set();
  for (const skill of parsed) {
    if (ids.length >= 8) break;
    const raw = typeof skill === "string" ? skill : (skill && typeof skill.id === "string" ? skill.id : "");
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function skillLookupKeys(id) {
  const raw = String(id || "").trim();
  if (!raw) return [];
  const keys = [raw];
  const colon = raw.includes(":") ? raw.split(":").pop() : "";
  if (colon) keys.push(colon);
  const slash = raw.includes("/") ? raw.split("/").filter(Boolean).pop() : "";
  if (slash) keys.push(slash);
  return [...new Set(keys.map((key) => String(key || "").trim()).filter(Boolean))];
}

function selectedSkillContext(message, skillsCatalog = []) {
  const ids = selectedSkillIdsFromMessage(message);
  if (!ids.length) return "";
  const byKey = new Map();
  for (const skill of Array.isArray(skillsCatalog) ? skillsCatalog : []) {
    const id = String(skill?.id || "").trim();
    const name = String(skill?.name || "").trim();
    if (id) {
      byKey.set(id, skill);
      byKey.set(`mia:${id}`, skill);
    }
    if (name) byKey.set(name, skill);
  }

  const blocks = [];
  const names = [];
  const seen = new Set();
  for (const id of ids) {
    const found = skillLookupKeys(id).map((key) => byKey.get(key)).find(Boolean);
    if (!found) continue;
    const key = String(found.id || id);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = String(found.name || found.name_zh || id).trim() || id;
    const body = String(found.body || "").trim();
    if (!body) continue;
    names.push(name);
    blocks.push(`=== Skill: ${name} ===\n${body}\n=== End Skill ===`);
  }
  if (!blocks.length) return "";
  const list = names.map((name) => `「${name}」`).join("、");
  return [
    "当前用户为这条消息明确选择了以下 Skill。请优先严格按这些 Skill 的指南完成本次任务：",
    "",
    blocks.join("\n\n"),
    "",
    `用户明确选择了 Skill：${list}。不要改用其它未被选择的 Skill。`
  ].join("\n");
}

function requireDep(deps, key) {
  if (!deps || !deps[key]) throw new Error(`${key} dependency is required`);
  return deps[key];
}

function messageRole(row) {
  if (row.sender_kind === BOT_SENDER_KIND) return "assistant";
  if (row.sender_kind === "system") return "system";
  return "user";
}

function createCloudAgentDispatcher(deps = {}) {
  const socialStore = requireDep(deps, "socialStore");
  const messagesStore = requireDep(deps, "messagesStore");
  const botsStore = requireDep(deps, "botsStore");
  const runtimeBindingsStore = requireDep(deps, "runtimeBindingsStore");
  const cloudAgentRunsStore = requireDep(deps, "cloudAgentRunsStore");
  const workerManager = requireDep(deps, "workerManager");
  const hermesRunsClient = requireDep(deps, "hermesRunsClient");
  const attachmentMaterializer = deps.attachmentMaterializer || null;
  const broadcastPersistedEvent = typeof deps.broadcastPersistedEvent === "function"
    ? deps.broadcastPersistedEvent
    : () => {};
  const broadcastTransientEvent = typeof deps.broadcastTransientEvent === "function"
    ? deps.broadcastTransientEvent
    : () => {};
  const loadPrompts = typeof deps.loadPrompts === "function" ? deps.loadPrompts : undefined;
  const getUserPublic = typeof deps.getUserPublic === "function" ? deps.getUserPublic : () => null;
  const skillsCatalog = Array.isArray(deps.skillsCatalog) ? deps.skillsCatalog : [];
  const listBridgeDevices = typeof deps.listBridgeDevices === "function" ? deps.listBridgeDevices : null;
  const createScheduledTask = typeof deps.createScheduledTask === "function" ? deps.createScheduledTask : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const pending = new Set();
  const groupOrchestrator = createGroupOrchestrator({
    socialStore,
    messagesStore,
    botsStore,
    workerManager,
    hermesRunsClient,
    ...(loadPrompts ? { loadPrompts } : {}),
    getUserPublic,
    log
  });

  function conversationHistory(conversationId) {
    return messagesStore.listMessagesSince(conversationId, 0, 200).map((row) => ({
      role: messageRole(row),
      content: row.body_md || ""
    }));
  }

  function recentMessagesForDesktopInvocation(conversationId) {
    return messagesStore.listMessagesSince(conversationId, 0, DESKTOP_INVOCATION_HISTORY_LIMIT);
  }

  function eventType(event = {}) {
    return String(event.type || event.event || "");
  }

  function eventText(event = {}) {
    for (const key of ["reasoning", "delta", "content_delta", "text_delta", "text", "content", "final_response"]) {
      if (typeof event[key] === "string") return event[key];
    }
    const data = event.data && typeof event.data === "object" ? event.data : null;
    return data ? eventText(data) : "";
  }

  function createTraceCollector() {
    const trace = { reasoning: "", tools: [] };

    function collect(event = {}) {
      const name = eventType(event);
      if (name === "reasoning.available" || name === "reasoning_delta") {
        trace.reasoning += eventText(event);
        if (trace.reasoning && !trace.reasoning.endsWith("\n")) trace.reasoning += "\n";
        return;
      }
      if (name === "tool.started" || name === "tool_call_started") {
        trace.tools.push({
          id: String(event.id || `tool_${trace.tools.length}`),
          name: String(event.tool || event.name || event.data?.tool || "工具"),
          preview: String(event.preview || event.input || ""),
          status: "running",
          duration: null,
          error: false
        });
        return;
      }
      if (name === "tool.delta" || name === "tool_call_delta") {
        const id = String(event.id || "");
        const toolName = String(event.tool || event.name || event.data?.tool || "");
        const tool = [...trace.tools].reverse().find((item) => (id && item.id === id) || (!id && (!toolName || item.name === toolName) && item.status === "running"));
        if (tool) tool.preview = String(event.preview || event.delta || tool.preview || "");
        return;
      }
      if (name === "tool.completed" || name === "tool_call_completed") {
        const id = String(event.id || "");
        const toolName = String(event.tool || event.name || event.data?.tool || "");
        const tool = [...trace.tools].reverse().find((item) => (id && item.id === id) || (!id && (!toolName || item.name === toolName) && item.status === "running"));
        if (tool) {
          tool.status = event.error || event.data?.error ? "error" : "completed";
          tool.duration = typeof event.duration === "number" ? event.duration : null;
          tool.error = Boolean(event.error || event.data?.error);
          if (event.preview) tool.preview = String(event.preview);
        }
      }
    }

    function payload() {
      const reasoning = String(trace.reasoning || "").trim();
      const tools = trace.tools.filter((tool) => tool.name);
      if (!reasoning && !tools.length) return null;
      return {
        ...(reasoning ? { reasoning } : {}),
        ...(tools.length ? { tools } : {})
      };
    }

    return { collect, payload };
  }

  function userFacingRunError(error) {
    const message = String(error?.message || error || "").trim();
    if (/模型余额不足|HTTP 402|Error code:\s*402|insufficient.*balance|quota/i.test(message)) {
      return "模型余额不足，请先充值。";
    }
    if (/api key|no API key|authentication|unauthorized/i.test(message)) {
      return "模型服务鉴权失败，请联系管理员检查 API Key。";
    }
    return message || "模型调用失败。";
  }

  function appendRunErrorReply({ ownerId, bot, conversationId, error }) {
    const reply = messagesStore.appendMessage({
      conversationId,
      senderKind: BOT_SENDER_KIND,
      senderRef: bot.id,
      senderOwnerId: ownerId,
      bodyMd: `模型调用失败：${userFacingRunError(error)}`,
      attachments: null,
      trace: null,
      status: "complete"
    });
    for (const member of socialStore.listConversationMembers(conversationId)) {
      if (member.member_kind === MemberKind.User) {
        broadcastPersistedEvent(member.member_ref, { type: "conversation.message_appended", conversationId, message: reply });
      }
    }
    return reply;
  }

  function appendRuntimeConfigErrorReply({ ownerId, bot, conversationId, message }) {
    const reply = messagesStore.appendMessage({
      conversationId,
      senderKind: BOT_SENDER_KIND,
      senderRef: bot.id,
      senderOwnerId: ownerId,
      bodyMd: message,
      attachments: null,
      trace: null,
      status: "complete",
      errorJson: { type: "desktop_runtime_unavailable", message }
    });
    for (const member of socialStore.listConversationMembers(conversationId)) {
      if (member.member_kind === MemberKind.User) {
        broadcastPersistedEvent(member.member_ref, { type: "conversation.message_appended", conversationId, message: reply });
      }
    }
    return reply;
  }

  function appendReminderReply({ ownerId, bot, conversationId, content, toolError = false, errorJson = null }) {
    const reply = messagesStore.appendMessage({
      conversationId,
      senderKind: BOT_SENDER_KIND,
      senderRef: bot.id,
      senderOwnerId: ownerId,
      bodyMd: content,
      attachments: null,
      trace: { tools: [reminderToolEvent(toolError)] },
      status: "complete",
      ...(errorJson ? { errorJson } : {})
    });
    for (const member of socialStore.listConversationMembers(conversationId)) {
      if (member.member_kind === MemberKind.User) {
        broadcastPersistedEvent(member.member_ref, { type: "conversation.message_appended", conversationId, message: reply });
      }
    }
    return reply;
  }

  async function handleExplicitCloudReminder({ ownerId, botId, bot, conversationId, message }) {
    if (!createScheduledTask || isScheduledFireMessage(message)) return null;
    try {
      const scheduled = await createScheduledReminderFromTurn({
        userPrompt: message.body_md || "",
        botId,
        conversationId,
        sessionId: `conversation:${conversationId}`,
        originMessageId: message.id,
        createScheduledTask: (input) => createScheduledTask(ownerId, input),
        nowMs,
        timezone: "Asia/Shanghai"
      });
      if (!scheduled) return null;
      return appendReminderReply({
        ownerId,
        bot,
        conversationId,
        content: confirmationForReminder(scheduled.intent)
      });
    } catch (error) {
      log(`[cloud-agent] scheduler create failed: ${error?.message || error}`);
      return appendReminderReply({
        ownerId,
        bot,
        conversationId,
        content: schedulerFailureContent(error),
        toolError: true,
        errorJson: { stage: "scheduler", message: String(error?.message || error || "unknown error") }
      });
    }
  }

  function invocationSender(message, fallbackUserId) {
    const senderRef = String(message?.sender_ref || fallbackUserId || "").trim();
    return getUserPublic(senderRef) || (senderRef ? { id: senderRef } : null);
  }

  function broadcastDesktopInvocation({ ownerId, botId, runtimeConfig, conversationId, conversationType, message, members, recentMessages }) {
    broadcastPersistedEvent(ownerId, {
      type: CloudEvent.ConversationBotInvocationRequested,
      conversationId,
      conversationType,
      botId,
      runtimeKind: "desktop-local",
      runtimeConfig: runtimeConfig || {},
      targetDeviceId: runtimeDeviceId(runtimeConfig || {}),
      invokedBy: invocationSender(message, ownerId),
      triggeringMessage: message,
      recentMessages,
      members
    });
  }

  async function validateDesktopRuntimeBinding({ ownerId, botId, binding }) {
    if (!binding) {
      return {
        ok: false,
        message: "这个 Bot 还没有配置运行位置，请在 Bot 详情里选择本机或 Mia Cloud。"
      };
    }
    const runtimeConfig = binding.config && typeof binding.config === "object" ? binding.config : {};
    const targetDeviceId = runtimeDeviceId(runtimeConfig);
    if (!targetDeviceId) {
      return {
        ok: false,
        message: "这个 Bot 没有明确的运行设备，请在 Bot 详情里重新选择本机或 Mia Cloud。"
      };
    }
    if (!listBridgeDevices) return { ok: true, runtimeConfig, targetDeviceId };
    let devices = [];
    try {
      devices = await Promise.resolve(listBridgeDevices(ownerId, { includeOffline: true, botId }));
    } catch (error) {
      log(`[cloud-agent] failed to list bridge devices: ${error?.message || error}`);
      devices = [];
    }
    const targetDevice = findRuntimeDevice(devices, targetDeviceId);
    if (!targetDevice) {
      return {
        ok: false,
        message: "这个 Bot 的运行设备已失效，请在 Bot 详情里重新选择本机或 Mia Cloud。"
      };
    }
    const status = String(targetDevice.status || "").trim().toLowerCase();
    if (status && status !== "online" && status !== "local") {
      return {
        ok: false,
        message: `${runtimeDeviceName(targetDevice)} 当前离线，打开该设备上的 Mia 后再试。`
      };
    }
    return { ok: true, runtimeConfig, targetDeviceId, targetDevice };
  }

  async function runHermesInline({ ownerId, botId, bot: validatedBot = null, runtimeConfig, conversationId, conversationType = "", message, members, bots }) {
    const bot = validatedBot || botsStore.getBot(botId);
    if (!bot || String(bot.ownerUserId || "") !== String(ownerId || "")) {
      log(`[cloud-agent] refusing bot run for unowned bot ${botId}`);
      return null;
    }
    const rosterMembers = Array.isArray(members) ? members : socialStore.listConversationMembers(conversationId);
    const rosterBots = Array.isArray(bots) ? bots : botsStore.listBots(ownerId);
    const trace = createTraceCollector();
    const run = cloudAgentRunsStore.createRun({
      userId: ownerId,
      botId,
      conversationId,
      triggerMessageId: message.id
    });
    try {
      const worker = await workerManager.ensureWorker(ownerId);
      try {
        writeSchedulerContext(worker, {
          botId,
          conversationId,
          sessionId: `conversation:${conversationId}`,
          originMessageId: message.id
        });
      } catch (error) {
        log(`[cloud-agent] failed to write scheduler context: ${error?.message || error}`);
      }
      const materialized = attachmentMaterializer
        ? attachmentMaterializer.materialize({
          userId: ownerId,
          workerPaths: worker.paths || {},
          runId: run.id,
          text: message.body_md || "",
          attachments: parseAttachmentsFromMessage(message)
        })
        : { attachments: [], input: message.body_md || "" };
      const result = await hermesRunsClient.runChat({
        baseUrl: worker.baseUrl,
        apiKey: worker.apiKey,
        userId: ownerId,
        bot,
        conversationId,
        instructions: cloudRuntimeInstructions(bot, message),
        model: runtimeConfig.model || "mia-default",
        effortLevel: runtimeConfig.effortLevel || "medium",
        permissionMode: runtimeConfig.permissionMode || "ask",
        input: [
          selectedSkillContext(message, skillsCatalog),
          inputWithConversationContext(materialized.input || message.body_md || "", {
            conversationType,
            members: rosterMembers,
            bots: rosterBots,
            bot
          })
        ].filter(Boolean).join("\n\n"),
        attachments: materialized.attachments || [],
        conversationHistory: conversationHistory(conversationId),
        onRunCreated(hermesRunId) {
          cloudAgentRunsStore.markRunning(run.id, hermesRunId || "");
          broadcastTransientEvent(ownerId, {
            type: "cloud_agent_run_started",
            runId: run.id,
            hermesRunId,
            conversationId,
            botId,
            triggerMessageId: message.id
          });
        },
        onEvent(event) {
          trace.collect(event);
          broadcastTransientEvent(ownerId, {
            type: "cloud_agent_run_event",
            runId: run.id,
            conversationId,
            botId,
            event
          });
        }
      });
      const replyAttachments = attachmentMaterializer?.archiveGeneratedAttachments
        ? attachmentMaterializer.archiveGeneratedAttachments({
          userId: ownerId,
          workerPaths: worker.paths || {},
          result
        })
        : [];
      if (result.runId) cloudAgentRunsStore.markRunning(run.id, result.runId);
      const reply = messagesStore.appendMessage({
        conversationId,
        senderKind: BOT_SENDER_KIND,
        senderRef: bot.id,
        senderOwnerId: ownerId,
        bodyMd: result.content || "",
        attachments: replyAttachments.length ? replyAttachments : null,
        trace: trace.payload(),
        status: "complete"
      });
      cloudAgentRunsStore.markComplete(run.id);
      for (const member of socialStore.listConversationMembers(conversationId)) {
        if (member.member_kind === MemberKind.User) {
          broadcastPersistedEvent(member.member_ref, { type: "conversation.message_appended", conversationId, message: reply });
        }
      }
      return reply;
    } catch (error) {
      cloudAgentRunsStore.markError(run.id, error);
      return appendRunErrorReply({ ownerId, bot, conversationId, error });
    }
  }

  // Resolve a pending Hermes tool approval for an in-flight run. The approval.request
  // event was broadcast to the run owner's web client (via onEvent → cloud_agent_run_event);
  // this routes the owner's decision back to that run's Hermes worker. Only the run owner
  // may answer — even when another group member triggered the run (spec §13).
  async function respondApproval({ userId, runId, conversationId, decision }) {
    const run = cloudAgentRunsStore.getRun(String(runId || ""));
    if (!run) return { ok: false, error: "run not found" };
    if (String(run.userId) !== String(userId || "")) {
      return { ok: false, error: "only the run owner can respond to this approval" };
    }
    if (conversationId && String(run.conversationId) !== String(conversationId)) {
      return { ok: false, error: "run does not belong to this conversation" };
    }
    const hermesRunId = String(run.hermesRunId || "").trim();
    if (!hermesRunId) return { ok: false, error: "run has no hermes run id yet" };
    if (typeof hermesRunsClient.submitApproval !== "function") {
      return { ok: false, error: "hermes client does not support approvals" };
    }
    const choice = decisionToHermesChoice(decision);
    const worker = await workerManager.ensureWorker(run.userId);
    await hermesRunsClient.submitApproval({
      baseUrl: worker.baseUrl,
      apiKey: worker.apiKey,
      runId: hermesRunId,
      choice
    });
    return { ok: true, choice };
  }

  function runtimeOverrideBinding(binding = null) {
    if (!binding || typeof binding !== "object") return null;
    const runtimeKind = String(binding.runtimeKind || binding.runtime_kind || "").trim();
    if (!runtimeKind) return null;
    return {
      runtimeKind,
      enabled: binding.enabled !== false,
      config: binding.config && typeof binding.config === "object" ? binding.config : {}
    };
  }

  async function dispatchBot({ ownerId, botId, conversationId, conversationType = "", message, members, bots, recentMessages, runtimeBinding }) {
    const bot = botsStore.getBot(botId);
    if (!bot || String(bot.ownerUserId || "") !== String(ownerId || "")) {
      log(`[cloud-agent] refusing bot dispatch for unowned bot ${botId}`);
      return null;
    }
    const overrideBinding = runtimeOverrideBinding(runtimeBinding);
    const activeBinding = overrideBinding || (typeof runtimeBindingsStore.getActiveBinding === "function"
      ? runtimeBindingsStore.getActiveBinding(ownerId, botId)
      : null);
    const cloudBinding = activeBinding?.runtimeKind === "cloud-hermes"
      ? activeBinding
      : (!activeBinding ? runtimeBindingsStore.getEnabledBinding(ownerId, botId, "cloud-hermes") : null);
    if (cloudBinding) {
      const reminderReply = await handleExplicitCloudReminder({ ownerId, botId, bot, conversationId, message });
      if (reminderReply) return reminderReply;
      return runHermesInline({
        ownerId,
        botId,
        bot,
        runtimeConfig: cloudBinding.config || {},
        conversationId,
        conversationType,
        message,
        members,
        bots
      });
    }
    const desktopBinding = activeBinding?.runtimeKind === "desktop-local"
      ? activeBinding
      : runtimeBindingsStore.getEnabledBinding(ownerId, botId, "desktop-local");
    const desktopRuntime = await validateDesktopRuntimeBinding({ ownerId, botId, binding: desktopBinding });
    if (!desktopRuntime.ok) {
      return appendRuntimeConfigErrorReply({
        ownerId,
        bot,
        conversationId,
        message: desktopRuntime.message
      });
    }
    broadcastDesktopInvocation({
      ownerId,
      botId,
      runtimeConfig: desktopRuntime.runtimeConfig || {},
      conversationId,
      conversationType,
      message,
      members,
      recentMessages
    });
    return null;
  }

  async function runInvocation(args = {}) {
    const userId = String(args.userId || "").trim();
    const conversationId = String(args.conversationId || "").trim();
    const requestedBotId = String(args.botId || "").trim();
    const runtimeBinding = runtimeOverrideBinding(args.runtimeBinding);
    const message = args.message || {};
    if (!userId || !conversationId || !message.id) return null;
    if (message.sender_kind && message.sender_kind !== "user") return null;

    const conversation = socialStore.getConversation(conversationId);
    if (!conversation) return null;

    if (conversation.type === "group") {
      const decision = await groupOrchestrator.chooseTargets({
        userId,
        conversationId,
        conversation,
        message,
        requestedBotId
      });
      const chosen = decision?.chosen || [];
      if (!chosen.length) return null;
      const replies = [];
      const invocationRecentMessages = recentMessagesForDesktopInvocation(conversationId);
      for (const member of chosen) {
        const reply = await dispatchBot({
          ownerId: member.owner_id,
          botId: member.member_ref,
          conversationId,
          conversationType: conversation.type,
          message,
          members: decision.members || [],
          bots: decision.bots || [],
          recentMessages: invocationRecentMessages.length ? invocationRecentMessages : (decision.recentMessages || []),
          runtimeBinding: requestedBotId && member.member_ref === requestedBotId ? runtimeBinding : null
        });
        if (reply) replies.push(reply);
      }
      return replies[0] || null;
    }

    // Bot DM: one bot, bound to the sender.
    const botMembers = socialStore.listConversationMembers(conversationId)
      .filter((member) => member.member_kind === BOT_MEMBER_KIND && member.owner_id === userId);
    const botMember = requestedBotId
      ? botMembers.find((member) => member.member_ref === requestedBotId)
      : botMembers[0];
    if (!botMember) return null;
    return dispatchBot({
      ownerId: botMember.owner_id,
      botId: botMember.member_ref,
      conversationId,
      conversationType: conversation.type,
      message,
      members: socialStore.listConversationMembers(conversationId),
      recentMessages: recentMessagesForDesktopInvocation(conversationId),
      runtimeBinding
    });
  }

  function handleUserMessage(args = {}) {
    const promise = runInvocation(args);
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  function invokeBot(args = {}) {
    const promise = runInvocation(args);
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  async function idle() {
    while (pending.size) {
      await Promise.allSettled([...pending]);
    }
  }

  return { handleUserMessage, invokeBot, respondApproval, idle };
}

module.exports = { createCloudAgentDispatcher };
