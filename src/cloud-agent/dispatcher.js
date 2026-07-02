const fs = require("node:fs");
const path = require("node:path");
const {
  parseAttachmentsFromMessage,
  redactGeneratedArtifactPaths,
  redactGeneratedArtifactPathsInValue,
  workerFileArtifactsForDeliveryRequest
} = require("./attachment-materializer.js");
const { createGroupOrchestrator } = require("./group-orchestrator.js");
const { MemberKind } = require("../shared/conversation-kinds.js");
const { CloudEvent } = require("../shared/cloud-events.js");
const { createAssistantContentBlockCollector } = require("../shared/assistant-content-blocks.js");
const { decisionToHermesChoice } = require("../shared/agent-permissions.js");
const {
  buildSkillMaterializationContext,
  materializeSkillsForTurn
} = require("../shared/skill-materializer.js");
const {
  extractLoadSkillRequests,
  stripLoadSkillRequests
} = require("../shared/skill-load-protocol.js");
const { miaRuntimeSystemPrompt } = require("../main/mia-runtime-context.js");
const { normalizeCloudHermesModel } = require("./cloud-hermes-model.js");

const BOT_MEMBER_KIND = "bot";
const BOT_SENDER_KIND = "bot";
const DESKTOP_INVOCATION_HISTORY_LIMIT = 200;
const ENGINE_IDENTITY_NAMES = ["Claude Code", "Codex", "OpenClaw", "Hermes"];
const MAX_SKILL_LOAD_ROUNDS = 3;

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

function messageInputText(message = {}) {
  return String(message.task_prompt || message.taskPrompt || message.body_md || "").trim();
}

function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedIdentityName(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function stripCopiedEngineIdentity(persona = "", bot = {}) {
  let text = String(persona || "").trim();
  if (!text) return "";
  const botName = normalizedIdentityName(botDisplayName(bot) || bot?.id || bot?.key || "");
  for (const engineName of ENGINE_IDENTITY_NAMES) {
    if (normalizedIdentityName(engineName) === botName) continue;
    const escaped = escapeRegExp(engineName).replace(/\s+/g, "\\s+");
    text = text
      .replace(new RegExp(`^\\s*(?:你是|你叫|你的名字是)\\s*${escaped}\\s*[。.!！]?\\s*`, "i"), "")
      .replace(new RegExp(`^\\s*(?:You are|Your name is)\\s+${escaped}\\s*[。.!！]?\\s*`, "i"), "");
  }
  return text.trim();
}

function cloudBotIdentityInstructions(bot = {}) {
  const name = String(botDisplayName(bot) || bot?.id || bot?.key || "Bot").trim();
  const id = String(bot?.id || bot?.key || "").trim();
  return [
    `你是 ${name}，Mia Cloud 里的 Bot。`,
    id && id !== name ? `你的 Bot ID 是 ${id}。` : "",
    `当用户询问你的名字、身份或“你是谁”时，请回答你是 ${name}。`,
    "不要自称 Claude Code、Codex、OpenClaw 或其它底层运行引擎名称，除非用户明确询问底层运行引擎，或该名称就是你的 Bot 名。"
  ].filter(Boolean).join("\n");
}

function cloudRuntimeInstructions(bot, message = {}) {
  const persona = stripCopiedEngineIdentity(bot?.personaText || bot?.persona_text || "", bot);
  return [
    miaRuntimeSystemPrompt({ scheduledFire: isScheduledFireMessage(message) }),
    persona,
    cloudBotIdentityInstructions(bot)
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

function skillRecordsFromCatalog(skillsCatalog = []) {
  return (Array.isArray(skillsCatalog) ? skillsCatalog : []).map((skill) => ({
    id: String(skill?.id || "").trim(),
    name: String(skill?.name || skill?.name_zh || skill?.id || "").trim(),
    description: String(skill?.description || "").trim(),
    body: String(skill?.body || "").trim()
  }));
}

function skillCatalogLookup(records = []) {
  const map = new Map();
  for (const skill of Array.isArray(records) ? records : []) {
    if (!skill?.id && !skill?.name) continue;
    const id = String(skill.id || skill.name || "").trim();
    const name = String(skill.name || id).trim();
    for (const key of [id, name, id && `mia:${id}`, id && id.split(":").pop()]) {
      const alias = String(key || "").trim();
      if (alias && !map.has(alias)) map.set(alias, skill);
    }
  }
  return map;
}

function cloudSkillMaterialization({ bot = {}, message = {}, skillsCatalog = [], requestedSkillIds = [] } = {}) {
  const records = skillRecordsFromCatalog(skillsCatalog);
  const lookup = skillCatalogLookup(records);
  const activeSkillIds = selectedSkillIdsFromMessage(message);
  const enabledSkillIds = Array.isArray(bot?.capabilities?.enabledSkills)
    ? bot.capabilities.enabledSkills.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const availableSkills = [];
  const seen = new Set();
  for (const id of [...enabledSkillIds, ...activeSkillIds, ...(Array.isArray(requestedSkillIds) ? requestedSkillIds : [])]) {
    const skill = lookup.get(String(id || "").trim());
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    availableSkills.push(skill);
  }
  return materializeSkillsForTurn({
    availableSkills,
    activeSkillIds,
    intentSkillIds: [],
    requestedSkillIds,
    mode: enabledSkillIds.length ? "index" : "none"
  });
}

function selectedSkillContext(message, skillsCatalog = []) {
  const activeSkillIds = selectedSkillIdsFromMessage(message);
  if (!activeSkillIds.length) return "";
  return buildSkillMaterializationContext(cloudSkillMaterialization({
    message,
    skillsCatalog
  }));
}

function unresolvedSkillLoadText(ids = []) {
  const label = ids.length ? ids.join("、") : "对应 Skill";
  return `我没能加载到 ${label} 的完整指南。请确认这个 Skill 已安装或已添加到这个 Bot 的能力列表。`;
}

function fileDeliveryReplyText(attachments = []) {
  const names = (Array.isArray(attachments) ? attachments : [])
    .map((item) => String(item?.name || "").trim())
    .filter(Boolean);
  if (!names.length) return "已附上文件。";
  return `已附上文件${names.map((name) => `「${name}」`).join("、")}。`;
}

function shouldReplaceWithFileDeliveryReply(text = "") {
  const content = String(text || "").trim();
  if (!content) return true;
  return /(?:没法|无法|不能|不支持|没有办法).{0,24}(?:发|发送|上传|直接|聊天|附件)|需要.{0,24}(?:S3|API|接收方式)|(?:can't|cannot|can not|unable to).{0,24}(?:send|attach|upload)/iu.test(content);
}

function requireDep(deps, key) {
  if (!deps || !deps[key]) throw new Error(`${key} dependency is required`);
  return deps[key];
}

function runStatus(run = null) {
  return String(run?.status || "").trim().toLowerCase();
}

function runIsCancelled(run = null) {
  return runStatus(run) === "cancelled";
}

function runIsCancelling(run = null) {
  return runStatus(run) === "cancelling";
}

function runIsActive(run = null) {
  const status = runStatus(run);
  return status === "queued" || status === "running" || status === "cancelling";
}

function eventStatus(event = {}) {
  return String(event?.status || event?.payload?.status || event?.data?.status || "").trim().toLowerCase();
}

function runResultIsInterrupted(result = {}) {
  return Array.isArray(result?.events)
    && result.events.some((event) => String(event?.type || "") === "message.complete" && eventStatus(event) === "interrupted");
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
  const hermesImClient = requireDep(deps, "hermesImClient");
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
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const pending = new Set();
  const groupOrchestrator = createGroupOrchestrator({
    socialStore,
    messagesStore,
    botsStore,
    workerManager,
    hermesImClient,
    ...(loadPrompts ? { loadPrompts } : {}),
    getUserPublic,
    log
  });

  function recentMessagesForDesktopInvocation(conversationId) {
    return messagesStore.listMessagesSince(conversationId, 0, DESKTOP_INVOCATION_HISTORY_LIMIT);
  }

  function conversationSeedMessages(conversationId, message = {}) {
    const triggerSeq = Number(message?.seq || 0);
    const triggerId = String(message?.id || "").trim();
    return messagesStore.listMessagesSince(conversationId, 0, DESKTOP_INVOCATION_HISTORY_LIMIT)
      .filter((row) => {
        const rowSeq = Number(row?.seq || 0);
        if (triggerSeq > 0) return rowSeq > 0 && rowSeq < triggerSeq;
        if (triggerId) return String(row?.id || "").trim() !== triggerId;
        return true;
      })
      .map((row) => {
        const content = String(row?.body_md || "").trim();
        if (!content) return null;
        return {
          role: messageRole(row),
          content
        };
      })
      .filter(Boolean);
  }

  function newerUserMessageExists(conversationId, message = {}) {
    const triggerSeq = Number(message?.seq || 0);
    if (!(triggerSeq > 0)) return false;
    return messagesStore.listMessagesSince(conversationId, triggerSeq, 20)
      .some((row) => row?.sender_kind === "user" && !isScheduledFireMessage(row));
  }

  function broadcastRunLifecycle(run, type) {
    if (!run || !type) return;
    broadcastTransientEvent(run.userId, {
      type: "cloud_agent_run_event",
      runId: run.id,
      conversationId: run.conversationId,
      botId: run.botId,
      event: { type }
    });
  }

  async function cancelActiveRunsForTarget({ ownerId, botId, conversationId }) {
    if (typeof cloudAgentRunsStore.listActiveForTarget !== "function") return;
    const activeRuns = cloudAgentRunsStore.listActiveForTarget({ userId: ownerId, botId, conversationId });
    for (const activeRun of activeRuns) {
      const current = cloudAgentRunsStore.getRun(activeRun.id);
      if (!runIsActive(current)) continue;
      const cancelling = cloudAgentRunsStore.markCancelling(activeRun.id);
      broadcastRunLifecycle(cancelling, "run.cancelling");
      const hermesRunId = String(cancelling?.hermesRunId || "").trim();
      if (hermesRunId.startsWith("gw:") && typeof hermesImClient.interruptSession === "function") {
        try {
          const worker = await workerManager.ensureWorker(cancelling.userId);
          await hermesImClient.interruptSession({
            gatewayWsUrl: worker.gatewayWsUrl,
            apiKey: worker.apiKey,
            sessionId: hermesRunId.slice(3)
          });
        } catch (error) {
          log(`[cloud-agent] failed to interrupt superseded run ${activeRun.id}: ${error?.message || error}`);
        }
      }
      const cancelled = cloudAgentRunsStore.markCancelled(activeRun.id);
      broadcastRunLifecycle(cancelled, "run.cancelled");
    }
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

  function createSkillLoadEventGate(onEvent) {
    const buffered = [];
    let textPrefix = "";
    let passthrough = false;
    let discarded = false;
    const markerPrefix = "[LOAD_SKILL:";

    function replay() {
      if (discarded) return;
      for (const event of buffered.splice(0)) onEvent(event);
      passthrough = true;
    }

    return {
      collect(event) {
        if (discarded) return;
        if (passthrough) {
          onEvent(event);
          return;
        }
        buffered.push(event);
        const text = eventText(event);
        if (!text) return;
        textPrefix += text;
        const probe = textPrefix.trimStart().toUpperCase();
        if (!probe) return;
        if (markerPrefix.startsWith(probe)) return;
        if (probe.startsWith(markerPrefix)) return;
        replay();
      },
      replay,
      discard() {
        discarded = true;
        buffered.length = 0;
      }
    };
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

  function appendRuntimeConfigErrorReply({ ownerId, bot, conversationId, message, errorType = "desktop_runtime_unavailable" }) {
    const reply = messagesStore.appendMessage({
      conversationId,
      senderKind: BOT_SENDER_KIND,
      senderRef: bot.id,
      senderOwnerId: ownerId,
      bodyMd: message,
      attachments: null,
      trace: null,
      status: "complete",
      errorJson: { type: errorType, message }
    });
    for (const member of socialStore.listConversationMembers(conversationId)) {
      if (member.member_kind === MemberKind.User) {
        broadcastPersistedEvent(member.member_ref, { type: "conversation.message_appended", conversationId, message: reply });
      }
    }
    return reply;
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
    const contentBlocks = createAssistantContentBlockCollector();
    await cancelActiveRunsForTarget({ ownerId, botId, conversationId });
    const run = cloudAgentRunsStore.createRun({
      userId: ownerId,
      botId,
      conversationId,
      triggerMessageId: message.id
    });
    function markRunCancelledIfNeeded() {
      const current = cloudAgentRunsStore.getRun(run.id);
      if (runIsCancelled(current)) return current;
      const cancelled = cloudAgentRunsStore.markCancelled(run.id);
      broadcastTransientEvent(ownerId, {
        type: "cloud_agent_run_event",
        runId: run.id,
        conversationId,
        botId,
        event: { type: "run.cancelled" }
      });
      return cancelled;
    }
    try {
      const worker = await workerManager.ensureWorker(ownerId);
      if (!String(worker?.gatewayWsUrl || "").trim()) {
        return appendRuntimeConfigErrorReply({
          ownerId,
          bot,
          conversationId,
          message: "云端 Hermes gateway 未启动，请检查 worker 配置。",
          errorType: "cloud_hermes_gateway_unavailable"
        });
      }
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
      const inputText = messageInputText(message);
      const materialized = attachmentMaterializer
        ? attachmentMaterializer.materialize({
          userId: ownerId,
          workerPaths: worker.paths || {},
          runId: run.id,
          text: inputText,
          attachments: parseAttachmentsFromMessage(message)
        })
        : { attachments: [], input: inputText };
      const conversationInput = inputWithConversationContext(materialized.input || inputText, {
        conversationType,
        members: rosterMembers,
        bots: rosterBots,
        bot
      });
      let requestedSkillIds = [];
      let skillMaterialization = cloudSkillMaterialization({ bot, message, skillsCatalog, requestedSkillIds });
      let result = null;
      let finalRunEvents = [];
      for (let round = 0; round <= MAX_SKILL_LOAD_ROUNDS; round += 1) {
        const roundRunEvents = [];
        const eventGate = createSkillLoadEventGate((event) => {
          trace.collect(event);
          contentBlocks.collect(event);
          broadcastTransientEvent(ownerId, {
            type: "cloud_agent_run_event",
            runId: run.id,
            conversationId,
            botId,
            event: redactGeneratedArtifactPathsInValue(event, [])
          });
        });
        result = await hermesImClient.runChat({
          gatewayWsUrl: worker.gatewayWsUrl,
          apiKey: worker.apiKey,
          userId: ownerId,
          bot,
          conversationId,
          seedMessages: conversationSeedMessages(conversationId, message),
          instructions: cloudRuntimeInstructions(bot, message),
          model: normalizeCloudHermesModel(runtimeConfig.model, { defaultModel: worker.model }),
          workerModel: worker.model || "mia-auto",
          modelProvider: worker.modelProvider || "mia",
          effortLevel: runtimeConfig.effortLevel || "medium",
          permissionMode: runtimeConfig.permissionMode || "ask",
          input: [
            buildSkillMaterializationContext(skillMaterialization),
            conversationInput
          ].filter(Boolean).join("\n\n"),
          attachments: materialized.attachments || [],
          onRunCreated(runtimeSessionId) {
            const gatewayRunId = runtimeSessionId ? `gw:${runtimeSessionId}` : "";
            const currentRun = cloudAgentRunsStore.getRun(run.id);
            if (runIsCancelled(currentRun) || runIsCancelling(currentRun)) return;
            cloudAgentRunsStore.markRunning(run.id, gatewayRunId);
            broadcastTransientEvent(ownerId, {
              type: "cloud_agent_run_started",
              runId: run.id,
              hermesRunId: runtimeSessionId,
              conversationId,
              botId,
              triggerMessageId: message.id
            });
          },
          onEvent(event) {
            roundRunEvents.push(event);
            eventGate.collect(event);
          }
        });
        const loadRequests = extractLoadSkillRequests(result?.content || "");
        if (!loadRequests.length) {
          finalRunEvents = roundRunEvents;
          eventGate.replay();
          break;
        }
        const known = new Set(requestedSkillIds);
        const nextRequests = loadRequests.filter((id) => !known.has(id));
        if (nextRequests.length && round < MAX_SKILL_LOAD_ROUNDS) {
          const previousLoadedCount = Array.isArray(skillMaterialization?.loadedSkillIds)
            ? skillMaterialization.loadedSkillIds.length
            : 0;
          requestedSkillIds = [...requestedSkillIds, ...nextRequests];
          const nextMaterialization = cloudSkillMaterialization({ bot, message, skillsCatalog, requestedSkillIds });
          const nextLoadedCount = Array.isArray(nextMaterialization?.loadedSkillIds)
            ? nextMaterialization.loadedSkillIds.length
            : 0;
          if (nextLoadedCount > previousLoadedCount) {
            eventGate.discard();
            skillMaterialization = nextMaterialization;
            continue;
          }
        }
        eventGate.discard();
        finalRunEvents = roundRunEvents;
        result = {
          ...(result || {}),
          content: stripLoadSkillRequests(result?.content || "") || unresolvedSkillLoadText(loadRequests)
        };
        break;
      }
      const currentRun = cloudAgentRunsStore.getRun(run.id);
      if (result.runId && !String(currentRun?.hermesRunId || "").trim()) {
        cloudAgentRunsStore.markRunning(run.id, `gw:${result.runId}`);
      }
      const runAfterHermes = cloudAgentRunsStore.getRun(run.id);
      if (runIsCancelled(runAfterHermes) || runIsCancelling(runAfterHermes) || runResultIsInterrupted(result)) {
        if (!runIsCancelled(runAfterHermes)) markRunCancelledIfNeeded();
        return null;
      }
      if (newerUserMessageExists(conversationId, message)) {
        markRunCancelledIfNeeded();
        return null;
      }
      const resultForArtifacts = {
        ...(result || {}),
        files: [
          ...(Array.isArray(result?.files) ? result.files : []),
          ...workerFileArtifactsForDeliveryRequest(inputText)
        ],
        events: [
          ...(Array.isArray(result?.events) ? result.events : []),
          ...finalRunEvents
        ]
      };
      const replyAttachments = attachmentMaterializer?.archiveGeneratedAttachments
        ? attachmentMaterializer.archiveGeneratedAttachments({
          userId: ownerId,
          workerPaths: worker.paths || {},
          result: resultForArtifacts
        })
        : [];
      const replyContent = redactGeneratedArtifactPaths(result.content || "", replyAttachments);
      const replyContentBlocks = redactGeneratedArtifactPathsInValue(
        contentBlocks.payload(replyContent),
        replyAttachments
      );
      const replyTrace = redactGeneratedArtifactPathsInValue(trace.payload(), replyAttachments);
      const hasRequestedFileDelivery = workerFileArtifactsForDeliveryRequest(inputText).length > 0;
      const finalReplyContent = hasRequestedFileDelivery && replyAttachments.length && shouldReplaceWithFileDeliveryReply(replyContent)
        ? fileDeliveryReplyText(replyAttachments)
        : replyContent;
      const reply = messagesStore.appendMessage({
        conversationId,
        senderKind: BOT_SENDER_KIND,
        senderRef: bot.id,
        senderOwnerId: ownerId,
        bodyMd: finalReplyContent,
        attachments: replyAttachments.length ? replyAttachments : null,
        trace: replyTrace,
        contentBlocks: finalReplyContent === replyContent ? replyContentBlocks : null,
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
      const currentRun = cloudAgentRunsStore.getRun(run.id);
      if (runIsCancelled(currentRun) || runIsCancelling(currentRun)) {
        if (!runIsCancelled(currentRun)) markRunCancelledIfNeeded();
        return null;
      }
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
    if (!hermesRunId.startsWith("gw:")) {
      return { ok: false, error: "run is not a Hermes gateway session" };
    }
    if (typeof hermesImClient.submitApproval !== "function") {
      return { ok: false, error: "hermes client does not support approvals" };
    }
    const choice = decisionToHermesChoice(decision);
    const worker = await workerManager.ensureWorker(run.userId);
    await hermesImClient.submitApproval({
      gatewayWsUrl: worker.gatewayWsUrl,
      apiKey: worker.apiKey,
      sessionId: hermesRunId.slice(3),
      choice
    });
    return { ok: true, choice };
  }

  async function stopRun({ userId, runId, conversationId }) {
    const run = cloudAgentRunsStore.getRun(String(runId || ""));
    if (!run) return { ok: false, error: "run not found" };
    if (String(run.userId) !== String(userId || "")) {
      return { ok: false, error: "only the run owner can stop this run" };
    }
    if (conversationId && String(run.conversationId) !== String(conversationId)) {
      return { ok: false, error: "run does not belong to this conversation" };
    }
    const hermesRunId = String(run.hermesRunId || "").trim();
    if (!hermesRunId) return { ok: false, error: "run has no hermes run id yet" };
    if (!hermesRunId.startsWith("gw:")) {
      return { ok: false, error: "run is not a Hermes gateway session" };
    }
    if (typeof hermesImClient.interruptSession !== "function") {
      return { ok: false, error: "hermes client does not support interruption" };
    }
    if (runIsCancelled(run)) return { ok: true, status: "cancelled" };

    cloudAgentRunsStore.markCancelling(run.id);
    broadcastTransientEvent(run.userId, {
      type: "cloud_agent_run_event",
      runId: run.id,
      conversationId: run.conversationId,
      botId: run.botId,
      event: { type: "run.cancelling" }
    });

    try {
      const worker = await workerManager.ensureWorker(run.userId);
      await hermesImClient.interruptSession({
        gatewayWsUrl: worker.gatewayWsUrl,
        apiKey: worker.apiKey,
        sessionId: hermesRunId.slice(3)
      });
    } catch (error) {
      cloudAgentRunsStore.markRunning(run.id, hermesRunId);
      throw error;
    }

    cloudAgentRunsStore.markCancelled(run.id);
    broadcastTransientEvent(run.userId, {
      type: "cloud_agent_run_event",
      runId: run.id,
      conversationId: run.conversationId,
      botId: run.botId,
      event: { type: "run.cancelled" }
    });
    return { ok: true, status: "cancelled" };
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
    const scheduledFire = isScheduledFireMessage(message);
    if (message.sender_kind && message.sender_kind !== "user" && !scheduledFire) return null;

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

  return { handleUserMessage, invokeBot, respondApproval, stopRun, idle };
}

module.exports = { createCloudAgentDispatcher };
