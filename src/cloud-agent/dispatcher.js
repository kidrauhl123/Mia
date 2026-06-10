const { parseAttachmentsFromMessage } = require("./attachment-materializer.js");
const { createGroupOrchestrator } = require("./group-orchestrator.js");
const { MemberKind } = require("../shared/conversation-kinds.js");
const { CloudEvent } = require("../shared/cloud-events.js");
const { decisionToHermesChoice } = require("../shared/agent-permissions.js");

const BOT_MEMBER_KIND = "bot";
const BOT_SENDER_KIND = "bot";

function botForMember(member, bots) {
  const ref = member?.member_ref;
  return (Array.isArray(bots) ? bots : [])
    .find((item) => item?.id === ref || item?.key === ref) || null;
}

function botDisplayName(bot) {
  return bot?.displayName || bot?.display_name || bot?.name || "";
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

  function invocationSender(message, fallbackUserId) {
    const senderRef = String(message?.sender_ref || fallbackUserId || "").trim();
    return getUserPublic(senderRef) || (senderRef ? { id: senderRef } : null);
  }

  function broadcastDesktopInvocation({ ownerId, botId, runtimeConfig, conversationId, message, members, recentMessages }) {
    broadcastPersistedEvent(ownerId, {
      type: CloudEvent.ConversationBotInvocationRequested,
      conversationId,
      botId,
      runtimeKind: "desktop-local",
      runtimeConfig: runtimeConfig || {},
      targetDeviceId: String(runtimeConfig?.deviceId || runtimeConfig?.targetDeviceId || ""),
      invokedBy: invocationSender(message, ownerId),
      triggeringMessage: message,
      recentMessages,
      members
    });
  }

  async function runHermesInline({ ownerId, botId, bot: validatedBot = null, runtimeConfig, conversationId, message, members, bots }) {
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
        model: runtimeConfig.model || "mia-default",
        effortLevel: runtimeConfig.effortLevel || "medium",
        permissionMode: runtimeConfig.permissionMode || "ask",
        input: inputWithGroupContext(materialized.input || message.body_md || "", rosterMembers, rosterBots, bot),
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
      return null;
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

  async function dispatchBot({ ownerId, botId, conversationId, message, members, bots, recentMessages }) {
    const bot = botsStore.getBot(botId);
    if (!bot || String(bot.ownerUserId || "") !== String(ownerId || "")) {
      log(`[cloud-agent] refusing bot dispatch for unowned bot ${botId}`);
      return null;
    }
    const activeBinding = typeof runtimeBindingsStore.getActiveBinding === "function"
      ? runtimeBindingsStore.getActiveBinding(ownerId, botId)
      : null;
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
        message,
        members,
        bots
      });
    }
    const desktopBinding = activeBinding?.runtimeKind === "desktop-local"
      ? activeBinding
      : runtimeBindingsStore.getEnabledBinding(ownerId, botId, "desktop-local");
    broadcastDesktopInvocation({
      ownerId,
      botId,
      runtimeConfig: desktopBinding?.config || {},
      conversationId,
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
      for (const member of chosen) {
        const reply = await dispatchBot({
          ownerId: member.owner_id,
          botId: member.member_ref,
          conversationId,
          message,
          members: decision.members || [],
          bots: decision.bots || [],
          recentMessages: decision.recentMessages || []
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
      message,
      members: socialStore.listConversationMembers(conversationId),
      recentMessages: []
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
