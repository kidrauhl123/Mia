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
const { miaRuntimeSystemPrompt } = require("../main/mia-runtime-context.js");
const { normalizeCloudClaudeCodeModel } = require("./cloud-claude-code-model.js");
const { assembleCloudRuntimeTurn } = require("./runtime-assembly.js");
const { MAX_CRON_CONTINUATIONS, processCloudCronTurn } = require("./cron-control.js");

const BOT_MEMBER_KIND = "bot";
const BOT_SENDER_KIND = "bot";
const ENGINE_IDENTITY_NAMES = ["Claude Code", "Codex", "Hermes"];
const CLOUD_CLAUDE_CODE_RUNTIME_KIND = "cloud-claude-code";

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

function botIdentityInstructions(bot = {}) {
  const name = String(botDisplayName(bot) || bot?.id || bot?.key || "Bot").trim();
  const id = String(bot?.id || bot?.key || "").trim();
  return [
    `你是 ${name}，Mia 里的 Bot。`,
    id && id !== name ? `你的 Bot ID 是 ${id}。` : "",
    `当用户询问你的名字、身份或“你是谁”时，请回答你是 ${name}。`
  ].filter(Boolean).join("\n");
}

function cloudRuntimeInstructions(bot, message = {}) {
  const persona = stripCopiedEngineIdentity(bot?.personaText || bot?.persona_text || "", bot);
  return [
    miaRuntimeSystemPrompt({ scheduledFire: isScheduledFireMessage(message) }),
    persona,
    botIdentityInstructions(bot)
  ].filter(Boolean).join("\n\n");
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

function isCloudRuntimeKind(value = "") {
  const runtimeKind = String(value || "").trim();
  return runtimeKind === CLOUD_CLAUDE_CODE_RUNTIME_KIND;
}

function runtimeRunPrefixForClient(agentClient = {}) {
  const explicit = String(agentClient.runtimeRunPrefix || "").trim().replace(/:$/, "");
  if (explicit) return explicit;
  return agentClient.requiresGateway === false ? "cc" : "gw";
}

function formatRuntimeRunId(sessionId = "", agentClient = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return "";
  if (/^[A-Za-z0-9_-]+:/.test(id)) return id;
  return `${runtimeRunPrefixForClient(agentClient)}:${id}`;
}

function runtimeSessionId(runtimeRunId = "") {
  const id = String(runtimeRunId || "").trim();
  const match = id.match(/^[A-Za-z0-9_-]+:(.+)$/);
  return match ? match[1] : id;
}

function hasRuntimeRunPrefix(runtimeRunId = "") {
  return /^[A-Za-z0-9_-]+:.+/.test(String(runtimeRunId || "").trim());
}

function normalizeCloudRuntimeModel(value, { runtimeKind = "", worker = {}, agentClient = {} } = {}) {
  const defaultModel = worker.model || worker.workerModel || "mia-auto";
  return normalizeCloudClaudeCodeModel(value, { defaultModel });
}

function createCloudAgentDispatcher(deps = {}) {
  const socialStore = requireDep(deps, "socialStore");
  const messagesStore = requireDep(deps, "messagesStore");
  const botsStore = requireDep(deps, "botsStore");
  const runtimeBindingsStore = requireDep(deps, "runtimeBindingsStore");
  const cloudAgentRunsStore = requireDep(deps, "cloudAgentRunsStore");
  const workerManager = requireDep(deps, "workerManager");
  const agentClient = deps.agentClient || deps.cloudAgentClient;
  if (!agentClient) throw new Error("agentClient dependency is required");
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
  const memoryStore = deps.memoryStore || null;
  const memoryDocumentStore = deps.memoryDocumentStore || null;
  const createCloudSessionToken = typeof deps.createCloudSessionToken === "function" ? deps.createCloudSessionToken : null;
  const cloudBaseUrl = deps.cloudBaseUrl || "";
  const listBridgeDevices = typeof deps.listBridgeDevices === "function" ? deps.listBridgeDevices : null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const loadNativeSessionId = typeof deps.loadNativeSessionId === "function" ? deps.loadNativeSessionId : () => "";
  const saveNativeSessionId = typeof deps.saveNativeSessionId === "function" ? deps.saveNativeSessionId : () => {};
  const deleteNativeSessionId = typeof deps.deleteNativeSessionId === "function" ? deps.deleteNativeSessionId : () => {};
  const scheduledTasks = {
    list: typeof deps.listScheduledTasks === "function" ? deps.listScheduledTasks : () => [],
    create: typeof deps.createScheduledTask === "function" ? deps.createScheduledTask : null,
    update: typeof deps.updateScheduledTask === "function" ? deps.updateScheduledTask : null,
    delete: typeof deps.deleteScheduledTask === "function" ? deps.deleteScheduledTask : null
  };
  const pending = new Set();
  const groupOrchestrator = createGroupOrchestrator({
    socialStore,
    messagesStore,
    botsStore,
    workerManager,
    agentClient,
    ...(loadPrompts ? { loadPrompts } : {}),
    getUserPublic,
    log
  });

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

  function nativeSessionDescriptor({ runtimeKind = CLOUD_CLAUDE_CODE_RUNTIME_KIND, botId = "", conversationId = "", worker = {} } = {}) {
    return {
      engineId: runtimeKind || CLOUD_CLAUDE_CODE_RUNTIME_KIND,
      botId,
      conversationId,
      workspacePath: String(worker?.paths?.workspace || "").trim()
    };
  }

  async function cancelActiveRunsForTarget({ ownerId, botId, conversationId }) {
    if (typeof cloudAgentRunsStore.listActiveForTarget !== "function") return;
    const activeRuns = cloudAgentRunsStore.listActiveForTarget({ userId: ownerId, botId, conversationId });
    for (const activeRun of activeRuns) {
      const current = cloudAgentRunsStore.getRun(activeRun.id);
      if (!runIsActive(current)) continue;
      const cancelling = cloudAgentRunsStore.markCancelling(activeRun.id);
      broadcastRunLifecycle(cancelling, "run.cancelling");
      const runtimeRunId = String(cancelling?.hermesRunId || "").trim();
      if (runtimeRunId && typeof agentClient.interruptSession === "function") {
        try {
          const worker = await workerManager.ensureWorker(cancelling.userId);
          await agentClient.interruptSession({
            gatewayWsUrl: worker.gatewayWsUrl,
            apiKey: worker.apiKey,
            worker,
            sessionId: runtimeSessionId(runtimeRunId),
            runId: cancelling.id
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

  function createInternalControlEventGate(onEvent) {
    const buffered = [];
    let discarded = false;

    function replay() {
      if (discarded) return;
      for (const event of buffered.splice(0)) onEvent(event);
    }

    return {
      collect(event) {
        if (discarded) return;
        buffered.push(event);
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

  function appendRunErrorReply({ ownerId, bot, conversationId, triggerMessageId = "", error }) {
    const reply = messagesStore.appendMessage({
      conversationId,
      senderKind: BOT_SENDER_KIND,
      senderRef: bot.id,
      senderOwnerId: ownerId,
      bodyMd: `模型调用失败：${userFacingRunError(error)}`,
      attachments: null,
      trace: null,
      triggerMessageId,
      status: "complete"
    });
    if (!reply._alreadyExisted) {
      for (const member of socialStore.listConversationMembers(conversationId)) {
        if (member.member_kind === MemberKind.User) {
          broadcastPersistedEvent(member.member_ref, { type: "conversation.message_appended", conversationId, message: reply });
        }
      }
    }
    return reply;
  }

  function appendRuntimeConfigErrorReply({ ownerId, bot, conversationId, triggerMessageId = "", message, errorType = "desktop_runtime_unavailable" }) {
    const reply = messagesStore.appendMessage({
      conversationId,
      senderKind: BOT_SENDER_KIND,
      senderRef: bot.id,
      senderOwnerId: ownerId,
      bodyMd: message,
      attachments: null,
      trace: null,
      triggerMessageId,
      status: "complete",
      errorJson: { type: errorType, message }
    });
    if (!reply._alreadyExisted) {
      for (const member of socialStore.listConversationMembers(conversationId)) {
        if (member.member_kind === MemberKind.User) {
          broadcastPersistedEvent(member.member_ref, { type: "conversation.message_appended", conversationId, message: reply });
        }
      }
    }
    return reply;
  }

  function invocationSender(message, fallbackUserId) {
    const senderRef = String(message?.sender_ref || fallbackUserId || "").trim();
    return getUserPublic(senderRef) || (senderRef ? { id: senderRef } : null);
  }

  function broadcastDesktopInvocation({ ownerId, botId, runtimeConfig, conversationId, conversationType, message, members }) {
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
      recentMessages: [],
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

  async function runCloudInline({ ownerId, botId, bot: validatedBot = null, runtimeKind = CLOUD_CLAUDE_CODE_RUNTIME_KIND, runtimeConfig, conversationId, conversationType = "", message, members, bots }) {
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
      if (agentClient.requiresGateway !== false && !String(worker?.gatewayWsUrl || "").trim()) {
        return appendRuntimeConfigErrorReply({
          ownerId,
          bot,
          conversationId,
          triggerMessageId: message.id,
          message: "云端 Agent gateway 未启动，请检查 worker 配置。",
          errorType: "cloud_agent_gateway_unavailable"
        });
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
      const nativeDescriptor = nativeSessionDescriptor({ runtimeKind, botId, conversationId, worker });
      let activeNativeSessionId = await loadNativeSessionId(nativeDescriptor);
      const conversation = socialStore.getConversation(conversationId);
      const memoryMode = String(conversation?.decorations?.memoryMode || "").trim().toLowerCase() === "native"
        ? "native"
        : "mia";
      const runtimeAssembly = assembleCloudRuntimeTurn({
        ownerId,
        botId,
        bot,
        conversationId,
        memoryMode,
        message,
        worker,
        runtimeConfig,
        skillsCatalog,
        memoryStore,
        memoryDocumentStore,
        includeMemorySnapshot: !activeNativeSessionId,
        createCloudSessionToken,
        cloudBaseUrl
      });
      let result = null;
      let finalRunEvents = [];
      let cronContinuationCount = 0;
      let turnInput = [runtimeAssembly.promptPrefix, conversationInput].filter(Boolean).join("\n\n");
      for (let round = 0; round <= MAX_CRON_CONTINUATIONS; round += 1) {
        const roundRunEvents = [];
        const eventGate = createInternalControlEventGate((event) => {
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
        result = await agentClient.runChat({
          gatewayWsUrl: worker.gatewayWsUrl,
          apiKey: worker.apiKey,
          worker,
          userId: ownerId,
          bot,
          conversationId,
          runtimeConfig: runtimeAssembly.runtimeConfig,
          mcpServers: runtimeAssembly.mcpServers,
          cwd: runtimeAssembly.runtimeCwd,
          additionalDirectories: runtimeAssembly.additionalDirectories,
          skills: runtimeAssembly.nativeSkillNames,
          transient: true,
          instructions: runtimeAssembly.instructions,
          nativeSessionId: activeNativeSessionId,
          model: normalizeCloudRuntimeModel(runtimeConfig.model, { runtimeKind, worker, agentClient }),
          workerModel: worker.workerModel || worker.platformModel || worker.model || "mia-auto",
          modelProvider: worker.modelProvider || "mia",
          effortLevel: runtimeConfig.effortLevel || "medium",
          permissionMode: runtimeConfig.permissionMode || worker.permissionMode || "ask",
          input: turnInput,
          attachments: materialized.attachments || [],
          onRunCreated(runtimeSessionId) {
            const runtimeRunId = formatRuntimeRunId(runtimeSessionId, agentClient);
            const currentRun = cloudAgentRunsStore.getRun(run.id);
            if (runIsCancelled(currentRun) || runIsCancelling(currentRun)) return;
            cloudAgentRunsStore.markRunning(run.id, runtimeRunId);
            broadcastTransientEvent(ownerId, {
              type: "cloud_agent_run_started",
              runId: run.id,
              hermesRunId: runtimeSessionId,
              runtimeRunId,
              conversationId,
              botId,
              triggerMessageId: message.id
            });
          },
          onSessionId(sessionId) {
            const id = String(sessionId || "").trim();
            if (!id) return;
            saveNativeSessionId(nativeDescriptor, id);
            const runtimeRunId = formatRuntimeRunId(id, agentClient);
            const currentRun = cloudAgentRunsStore.getRun(run.id);
            if (runIsCancelled(currentRun) || runIsCancelling(currentRun)) return;
            cloudAgentRunsStore.markRunning(run.id, runtimeRunId);
          },
          onSessionReset(info = {}) {
            const staleSessionId = String(info.staleSessionId || "").trim();
            if (!staleSessionId) return;
            deleteNativeSessionId(nativeDescriptor);
          },
          onEvent(event) {
            roundRunEvents.push(event);
            eventGate.collect(event);
          }
        });
        const roundSessionId = String(result?.sessionId || result?.nativeSessionId || result?.runId || "").trim();
        if (roundSessionId) activeNativeSessionId = roundSessionId;
        const cronTurn = await processCloudCronTurn({
          assistantText: result?.content || "",
          continuationCount: cronContinuationCount,
          userId: ownerId,
          botId,
          conversationId,
          originMessageId: message.id,
          taskApi: scheduledTasks
        });
        for (const event of cronTurn.traceEvents) {
          trace.collect(event);
          contentBlocks.collect(event);
          broadcastTransientEvent(ownerId, {
            type: "cloud_agent_run_event",
            runId: run.id,
            conversationId,
            botId,
            event
          });
        }
        result = { ...(result || {}), content: cronTurn.visibleText };
        cronContinuationCount = cronTurn.nextCount;
        if (cronTurn.continuation) {
          eventGate.discard();
          turnInput = cronTurn.continuation;
          continue;
        }
        finalRunEvents = roundRunEvents;
        eventGate.replay();
        break;
      }
      const currentRun = cloudAgentRunsStore.getRun(run.id);
      const resultRuntimeId = result.sessionId || result.nativeSessionId || result.runId;
      if (resultRuntimeId && !String(currentRun?.hermesRunId || "").trim()) {
        cloudAgentRunsStore.markRunning(run.id, formatRuntimeRunId(resultRuntimeId, agentClient));
      }
      const runAfterAgent = cloudAgentRunsStore.getRun(run.id);
      if (runIsCancelled(runAfterAgent) || runIsCancelling(runAfterAgent) || runResultIsInterrupted(result)) {
        if (!runIsCancelled(runAfterAgent)) markRunCancelledIfNeeded();
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
        triggerMessageId: message.id,
        status: "complete"
      });
      cloudAgentRunsStore.markComplete(run.id);
      if (!reply._alreadyExisted) {
        for (const member of socialStore.listConversationMembers(conversationId)) {
          if (member.member_kind === MemberKind.User) {
            broadcastPersistedEvent(member.member_ref, { type: "conversation.message_appended", conversationId, message: reply });
          }
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
      return appendRunErrorReply({ ownerId, bot, conversationId, triggerMessageId: message.id, error });
    }
  }

  // Resolve a pending cloud agent tool approval for an in-flight run. The approval.request
  // event was broadcast to the run owner's web client (via onEvent → cloud_agent_run_event);
  // this routes the owner's decision back to that run's cloud worker. Only the run owner
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
    const runtimeRunId = String(run.hermesRunId || "").trim();
    if (!runtimeRunId) return { ok: false, error: "run has no runtime run id yet" };
    if (!hasRuntimeRunPrefix(runtimeRunId)) {
      return {
        ok: false,
        error: agentClient.requiresGateway === false
          ? "run is not a cloud agent runtime session"
          : "run is not a cloud agent gateway session"
      };
    }
    if (typeof agentClient.submitApproval !== "function") {
      return { ok: false, error: "cloud agent client does not support approvals" };
    }
    const choice = decisionToHermesChoice(decision);
    const worker = await workerManager.ensureWorker(run.userId);
    const result = await agentClient.submitApproval({
      gatewayWsUrl: worker.gatewayWsUrl,
      apiKey: worker.apiKey,
      worker,
      sessionId: runtimeSessionId(runtimeRunId),
      choice,
      decision
    });
    if (result && result.ok === false) return result;
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
    const runtimeRunId = String(run.hermesRunId || "").trim();
    if (!runtimeRunId) return { ok: false, error: "run has no runtime run id yet" };
    if (!hasRuntimeRunPrefix(runtimeRunId)) {
      return {
        ok: false,
        error: agentClient.requiresGateway === false
          ? "run is not a cloud agent runtime session"
          : "run is not a cloud agent gateway session"
      };
    }
    if (typeof agentClient.interruptSession !== "function") {
      return { ok: false, error: "cloud agent client does not support interruption" };
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
      await agentClient.interruptSession({
        gatewayWsUrl: worker.gatewayWsUrl,
        apiKey: worker.apiKey,
        worker,
        sessionId: runtimeSessionId(runtimeRunId),
        runId: run.id
      });
    } catch (error) {
      cloudAgentRunsStore.markRunning(run.id, runtimeRunId);
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

  async function dispatchBot({ ownerId, botId, conversationId, conversationType = "", message, members, bots, runtimeBinding }) {
    const bot = botsStore.getBot(botId);
    if (!bot || String(bot.ownerUserId || "") !== String(ownerId || "")) {
      log(`[cloud-agent] refusing bot dispatch for unowned bot ${botId}`);
      return null;
    }
    const overrideBinding = runtimeOverrideBinding(runtimeBinding);
    const activeBinding = overrideBinding || (typeof runtimeBindingsStore.getActiveBinding === "function"
      ? runtimeBindingsStore.getActiveBinding(ownerId, botId)
      : null);
    const cloudBinding = isCloudRuntimeKind(activeBinding?.runtimeKind)
      ? activeBinding
      : (!activeBinding
        ? runtimeBindingsStore.getEnabledBinding(ownerId, botId, CLOUD_CLAUDE_CODE_RUNTIME_KIND)
        : null);
    if (cloudBinding) {
      return runCloudInline({
        ownerId,
        botId,
        bot,
        runtimeKind: cloudBinding.runtimeKind,
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
        triggerMessageId: message.id,
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
      members
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
      for (const member of chosen) {
        const reply = await dispatchBot({
          ownerId: member.owner_id,
          botId: member.member_ref,
          conversationId,
          conversationType: conversation.type,
          message,
          members: decision.members || [],
          bots: decision.bots || [],
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
