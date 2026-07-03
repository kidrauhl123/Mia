// Shared bot-execution core: the single implementation of `sendChat`/`stopChat`
// (and their single-flight abort state) that both the Electron main process and
// the standalone Mia Core node process drive. Pure node — no electron import.
// All host-specific collaborators are injected; services that the host
// reassigns at runtime (or constructs after this factory) are injected as
// accessor functions so the late binding still resolves.

const crypto = require("node:crypto");

const { intentSkillIdsForMessages } = require("../shared/skill-intent-detector.js");
const {
  createSkillLoadRequestGate,
  extractLoadSkillRequests,
  stripLoadSkillRequests
} = require("../shared/skill-load-protocol.js");
const { createAgentSessionKey, getAcpEngineSpec } = require("./agent-session/index.js");

const MAX_SKILL_LOAD_ROUNDS = 3;
const MAX_MEMORY_EXTRACTION_MESSAGES = 12;
const MAX_MEMORY_EXTRACTION_MESSAGE_CHARS = 4000;

function responseWithMessageContent(response, content) {
  const text = String(content || "").trim();
  if (!response || typeof response !== "object") return { text, finishReason: "stop" };
  if (Array.isArray(response.choices) && response.choices[0]?.message) {
    const choices = response.choices.slice();
    choices[0] = {
      ...choices[0],
      message: {
        ...choices[0].message,
        content: text
      }
    };
    return { ...response, choices };
  }
  if (Object.prototype.hasOwnProperty.call(response, "text")) return { ...response, text };
  return { ...response, text };
}

function fallbackForUnresolvedSkillLoad(ids = []) {
  const label = ids.length ? ids.join("、") : "对应 Skill";
  return `我没能加载到 ${label} 的完整指南。请确认这个 Skill 已安装或已添加到这个 Bot 的能力列表。`;
}

function textContent(value = "") {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || part.content || "";
        return "";
      })
      .join("\n")
      .trim();
  }
  if (value && typeof value === "object") return String(value.text || value.content || "").trim();
  return "";
}

function memoryExtractionRole(role = "") {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "assistant" || normalized === "model") return "assistant";
  if (normalized === "user" || normalized === "human") return "user";
  return "";
}

function boundedMemoryExtractionMessages(messages = [], assistantText = "") {
  const rows = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = memoryExtractionRole(message?.role);
    if (!role) continue;
    const content = textContent(message?.content || message?.text || "");
    if (!content) continue;
    rows.push({
      role,
      content: content.slice(0, MAX_MEMORY_EXTRACTION_MESSAGE_CHARS),
      id: String(message?.id || message?.messageId || "").trim()
    });
  }
  const finalAssistantText = textContent(assistantText);
  if (finalAssistantText) {
    rows.push({
      role: "assistant",
      content: finalAssistantText.slice(0, MAX_MEMORY_EXTRACTION_MESSAGE_CHARS),
      id: ""
    });
  }
  return rows.slice(-MAX_MEMORY_EXTRACTION_MESSAGES);
}

function scheduleMemoryExtraction({
  miaMemoryService,
  isMemoryEnabled,
  onMemoryExtracted,
  appendCloudLog,
  bot,
  sessionId,
  messages,
  assistantText,
  agentEngine,
  group = false,
  utility = false,
  background = false,
  scheduledFire = false
} = {}) {
  const text = textContent(assistantText);
  if (!text || utility || background || scheduledFire) return false;
  if (String(sessionId || "").startsWith("title:")) return false;
  if (!miaMemoryService || typeof miaMemoryService.extractMemoriesFromMessages !== "function") return false;
  try {
    if (typeof isMemoryEnabled === "function" && isMemoryEnabled() === false) return false;
  } catch {
    return false;
  }

  const extractionMessages = boundedMemoryExtractionMessages(messages, text);
  if (extractionMessages.length < 2) return false;
  const sourceMessageIds = extractionMessages.map((message) => message.id).filter(Boolean);
  const input = {
    botId: String(bot?.key || bot?.id || "mia").trim() || "mia",
    sessionId: String(sessionId || "default").trim() || "default",
    scope: group ? "session" : "bot",
    messages: extractionMessages.map(({ role, content }) => ({ role, content })),
    originEngine: String(agentEngine || bot?.agentEngine || bot?.agent_engine || "").trim(),
    sourceMessageIds,
    metadata: {
      source: "bot_execution_core",
      group: Boolean(group)
    }
  };

  Promise.resolve().then(async () => {
    const result = await miaMemoryService.extractMemoriesFromMessages(input);
    if (typeof onMemoryExtracted === "function" && Array.isArray(result?.memories)) {
      for (const memoryResult of result.memories) {
        onMemoryExtracted(memoryResult, { ...input, eventSource: "agent_extract" });
      }
    }
    if (result?.status === "ok" && Array.isArray(result.memories) && result.memories.length) {
      appendCloudLog?.(`[Mia memory] extracted ${result.memories.length} memories for bot=${input.botId} session=${input.sessionId}`);
    }
  }).catch((error) => {
    appendCloudLog?.(`[Mia memory] extraction failed: ${String(error?.message || error)}`);
  });
  return true;
}

function lastUserMessage(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index] && rows[index].role === "user") return rows[index];
  }
  return null;
}

function currentTurnId(message = null) {
  const id = String(message?.id || message?.messageId || "").trim();
  return id || `turn_${crypto.randomUUID()}`;
}

function currentTurnInput(messages = []) {
  const message = lastUserMessage(messages);
  const input = {
    turnId: currentTurnId(message),
    text: textContent(message?.content || message?.text || "")
  };
  if (Array.isArray(message?.attachments) && message.attachments.length) {
    input.attachments = message.attachments.slice();
  }
  if (Array.isArray(message?.fileReferences) && message.fileReferences.length) {
    input.fileReferences = message.fileReferences.slice();
  }
  return input;
}

function resolveAgentSessionWorkspacePath(source) {
  const value = typeof source === "function" ? source() : source;
  return String(value || "").trim();
}

function managedConversationId(value = "") {
  return String(value || "").trim();
}

function managedDescriptorKey(descriptor = {}) {
  return createAgentSessionKey(descriptor);
}

function createBotExecutionCore({
  createChatEventEmitter,
  cloudBotSnapshotForTurn,
  loadBotManifest,
  requireBot,
  normalizeTurnRuntimeConfig,
  botWithRuntimeConfig,
  normalizeAgentEngine,
  resolveChatEngineAdapter,
  botPetService,
  responseMessageContent,
  schedulerSkillIdsForTurn,
  skillsLoader,
  nativeTurnHelpers,
  sendWithChatEngineAdapter,
  createActiveChatEngineAdapters,
  agentSessionManager = null,
  agentSessionWorkspacePath = "",
  // Late-bound: constructed after this factory and takes `sendChat` as a dep.
  localBotResponder,
  isDaemonProcess,
  daemonTasksClient,
  settingsStore,
  appendCloudLog,
  miaMemoryService = null,
  isMemoryEnabled = null,
  onMemoryExtracted = null,
  prepareAgentSessionRuntime = null
}) {
  // Single-flight interactive chat controller — factory state, not a module
  // global. Group/utility/background turns keep their own controllers.
  let activeChatAbortController = null;
  const activeManagedSessionsByKey = new Map();
  const activeManagedSessionKeysByConversationId = new Map();

  const getLocalBotResponder = typeof localBotResponder === "function"
    ? localBotResponder
    : () => localBotResponder;
  const getDaemonTasksClient = typeof daemonTasksClient === "function"
    ? daemonTasksClient
    : () => daemonTasksClient;
  const isDaemon = typeof isDaemonProcess === "function"
    ? isDaemonProcess
    : () => isDaemonProcess;

  function rememberManagedDescriptor(descriptor) {
    const key = managedDescriptorKey(descriptor);
    activeManagedSessionsByKey.set(key, descriptor);
    const conversationId = descriptor.conversationId;
    const keys = activeManagedSessionKeysByConversationId.get(conversationId) || [];
    activeManagedSessionKeysByConversationId.set(
      conversationId,
      [...keys.filter((entry) => entry !== key), key]
    );
    return key;
  }

  function forgetManagedDescriptor(descriptor) {
    const key = managedDescriptorKey(descriptor);
    activeManagedSessionsByKey.delete(key);
    const conversationId = descriptor.conversationId;
    const keys = (activeManagedSessionKeysByConversationId.get(conversationId) || []).filter((entry) => entry !== key);
    if (keys.length) {
      activeManagedSessionKeysByConversationId.set(conversationId, keys);
    } else {
      activeManagedSessionKeysByConversationId.delete(conversationId);
    }
    return key;
  }

  function resolveManagedDescriptor(payload = {}) {
    const conversationId = managedConversationId(payload.conversationId || payload.sessionId);
    const engineId = String(payload.engineId || "").trim();
    const workspacePath = String(payload.workspacePath || "").trim();
    if (conversationId && engineId && workspacePath) {
      return activeManagedSessionsByKey.get(managedDescriptorKey({
        conversationId,
        engineId,
        workspacePath
      })) || null;
    }
    if (conversationId) {
      const keys = activeManagedSessionKeysByConversationId.get(conversationId) || [];
      const key = keys.at(-1) || "";
      return key ? activeManagedSessionsByKey.get(key) || null : null;
    }
    if (activeManagedSessionsByKey.size === 1) {
      return activeManagedSessionsByKey.values().next().value || null;
    }
    return null;
  }

  async function sendChat({ botKey, botId, botSnapshot = null, sessionId, messages, group, webContents, emit: externalEmit = null, utility = false, persistAgentSession = undefined, background = false, scheduledFire = false, allowSlashCommands = true, runtimeConfig = null, activeSkillIds = [], signal: externalSignal = null, abortController: externalAbortController = null }) {
    utility = Boolean(utility);
    const shouldPersistAgentSession = persistAgentSession == null
      ? !utility
      : Boolean(persistAgentSession);
    let abortController = externalAbortController && typeof externalAbortController.abort === "function"
      ? externalAbortController
      : null;
    let signal = externalSignal || abortController?.signal || null;
    // chat:event drives background/remote trace capture (see runRemoteChatRequest's
    // tracedEventSink). Interactive cloud-conversation chats publish their own
    // cloud:event stream via local-bot-responder — those
    // callers either pass externalEmit or set utility/group/background to skip
    // this emitter.
    const { emit } = typeof externalEmit === "function"
      ? { emit: externalEmit }
      : !utility
      ? createChatEventEmitter({ webContents, sessionId })
      : { emit: null };
    try {
      const key = botKey || botId;
      const snapshotBot = cloudBotSnapshotForTurn(botSnapshot, key, runtimeConfig);
      let bot = snapshotBot;
      if (!bot) {
        const manifest = loadBotManifest();
        ({ bot } = requireBot(manifest, key, "还没有可用的 bot，请先在引导里创建一个再发起对话。"));
      }
      const turnRuntimeConfig = normalizeTurnRuntimeConfig(runtimeConfig);
      const runtimeAgentEngine = String(runtimeConfig?.agentEngine || runtimeConfig?.agent_engine || "").trim();
      let botForTurn = botWithRuntimeConfig(bot, turnRuntimeConfig, { agentEngine: runtimeAgentEngine });
      if (runtimeAgentEngine) {
        botForTurn = {
          ...botForTurn,
          agentEngine: normalizeAgentEngine(runtimeAgentEngine, botForTurn.agentEngine || botForTurn.agent_engine || "hermes")
        };
      }
      const chatEngine = resolveChatEngineAdapter(botForTurn);
      const adapterEngineId = chatEngine.id;
      const agentSessionSpec = getAcpEngineSpec(adapterEngineId)
        || getAcpEngineSpec(botForTurn.agentEngine || botForTurn.agent_engine || "");
      const managedAgentSessionTurn = Boolean(
        agentSessionSpec
        && !group
        && !utility
        && !background
        && !scheduledFire
        && !String(sessionId || "").startsWith("title:")
      );
      const sessionStartedEngineId = managedAgentSessionTurn ? agentSessionSpec.engineId : adapterEngineId;
      const rawCurrentTurn = currentTurnInput(messages);
      const shouldNotifyPet = !utility && !String(sessionId || "").startsWith("title:");
      const completeWithPetMessage = (response) => {
        if (shouldNotifyPet) botPetService.notifyMessage(botForTurn.key, responseMessageContent(response));
        return response;
      };
      const completeSuccessfulTurn = (response) => {
        scheduleMemoryExtraction({
          miaMemoryService,
          isMemoryEnabled,
          onMemoryExtracted,
          appendCloudLog,
          bot: botForTurn,
          sessionId,
          messages,
          assistantText: responseMessageContent(response),
          agentEngine: adapterEngineId,
          group,
          utility,
          background,
          scheduledFire
        });
        return completeWithPetMessage(response);
      };
      if (emit) {
        emit("session_started", { botKey: botForTurn.key, engine: sessionStartedEngineId });
      }
      if (managedAgentSessionTurn) {
        if (!agentSessionManager || typeof agentSessionManager.sendUserInput !== "function") {
          throw new Error(`AgentSession manager is required for interactive ${agentSessionSpec.engineId} turns.`);
        }
        const workspacePath = resolveAgentSessionWorkspacePath(agentSessionWorkspacePath);
        if (!workspacePath) {
          throw new Error(`AgentSession workspace path is required for interactive ${agentSessionSpec.engineId} turns.`);
        }
        const descriptor = {
          conversationId: managedConversationId(sessionId),
          engineId: agentSessionSpec.engineId,
          workspacePath
        };
        const runtime = typeof prepareAgentSessionRuntime === "function"
          ? await prepareAgentSessionRuntime({
            engineId: agentSessionSpec.engineId,
            conversationId: descriptor.conversationId,
            botId: botForTurn.key || botForTurn.id || key,
            botSnapshot: botForTurn,
            runtimeConfig: turnRuntimeConfig,
            workspacePath
          })
          : null;
        if (runtime?.runtimeKey) descriptor.runtimeKey = String(runtime.runtimeKey || "").trim();
        if (runtime?.env && typeof runtime.env === "object" && !Array.isArray(runtime.env)) {
          descriptor.env = { ...runtime.env };
        }
        if (runtime?.mcpFingerprint) descriptor.mcpFingerprint = String(runtime.mcpFingerprint || "").trim();
        if (Array.isArray(runtime?.mcpServers)) descriptor.mcpServers = runtime.mcpServers.slice();
        if (typeof runtime?.refreshMcpContext === "function") descriptor.refreshMcpContext = runtime.refreshMcpContext;
        if (typeof runtime?.initialPromptPrefix === "string") descriptor.initialPromptPrefix = runtime.initialPromptPrefix;
        const accepted = await agentSessionManager.sendUserInput({
          ...descriptor,
          ...rawCurrentTurn
        });
        rememberManagedDescriptor(descriptor);
        return accepted;
      }
      // Composer "使用" chips are turn-local: make them resolvable for this turn,
      // then materialize full skill bodies only for those explicit selections.
      const intentSkillIds = intentSkillIdsForMessages(messages);
      const turnEnabledSkillIds = [
        ...schedulerSkillIdsForTurn({ activeSkillIds, background, scheduledFire }),
        ...intentSkillIds
      ];
      if (turnEnabledSkillIds.length) {
        const caps = botForTurn.capabilities || {};
        botForTurn = {
          ...botForTurn,
          capabilities: {
            ...caps,
            enabledSkills: [...new Set([...(caps.enabledSkills || []), ...turnEnabledSkillIds.map((id) => String(id))])]
          }
        };
        const directive = skillsLoader.buildActiveSkillsDirective(activeSkillIds);
        if (directive && Array.isArray(messages)) {
          const next = messages.slice();
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i] && next[i].role === "user") {
              next[i] = { ...next[i], content: `${directive}\n\n${next[i].content || ""}` };
              break;
            }
          }
          messages = next;
        }
      }
      if (!abortController && (group || utility || background)) {
        // Group dispatches run in parallel; each gets its own controller.
        // Utility calls also skip the 1v1 "single active chat" semantics.
        // Background runs (scheduled tasks) must not share the interactive
        // single-flight controller — otherwise any foreground/web chat (or an
        // overlapping task) aborts the task mid-generation ("生成已停止").
        abortController = new AbortController();
      } else if (!abortController) {
        if (activeChatAbortController) {
          activeChatAbortController.abort();
        }
        abortController = new AbortController();
        activeChatAbortController = abortController;
      }
      signal = externalSignal || abortController.signal;
      let requestedSkillIds = [];
      const resolveSkillMaterialization = () => (typeof skillsLoader?.resolveSkillMaterialization === "function"
        ? skillsLoader.resolveSkillMaterialization({
            bot: botForTurn,
            activeSkillIds,
            intentSkillIds,
            requestedSkillIds,
            mode: "index"
          })
        : null);
      let skillMaterialization = resolveSkillMaterialization();
      const slashText = allowSlashCommands && typeof nativeTurnHelpers?.slashCommandText === "function"
        ? nativeTurnHelpers.slashCommandText(messages)
        : "";
      for (let round = 0; round <= MAX_SKILL_LOAD_ROUNDS; round += 1) {
        const eventGate = createSkillLoadRequestGate(emit);
        const response = await sendWithChatEngineAdapter(createActiveChatEngineAdapters(), {
          chatEngine,
          bot: botForTurn,
          sessionId,
          messages,
          group,
          signal,
          abortController,
          emit: eventGate.emit,
          utility,
          scheduledFire,
          persistAgentSession: shouldPersistAgentSession,
          slashText,
          runtimeConfig: turnRuntimeConfig,
          skillMaterialization
        });
        const content = responseMessageContent(response);
        const loadRequests = extractLoadSkillRequests(content);
        if (!loadRequests.length) {
          eventGate.replay();
          return completeSuccessfulTurn(response);
        }

        const known = new Set(requestedSkillIds);
        const nextRequests = loadRequests.filter((id) => !known.has(id));
        if (nextRequests.length && round < MAX_SKILL_LOAD_ROUNDS) {
          const previousLoadedCount = Array.isArray(skillMaterialization?.loadedSkillIds)
            ? skillMaterialization.loadedSkillIds.length
            : 0;
          requestedSkillIds = [...requestedSkillIds, ...nextRequests];
          const nextMaterialization = resolveSkillMaterialization();
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
        const stripped = stripLoadSkillRequests(content);
        return completeSuccessfulTurn(responseWithMessageContent(
          response,
          stripped || fallbackForUnresolvedSkillLoad(loadRequests)
        ));
      }
      throw new Error("Skill loading did not converge.");
    } catch (error) {
      if (signal?.aborted) {
        if (emit) emit("complete", { finishReason: "cancelled", aborted: true });
        const stopped = new Error("生成已停止");
        stopped.code = "MIA_STOPPED";
        throw stopped;
      }
      if (emit) emit("error", { message: String(error?.message || error) });
      throw error;
    } finally {
      if (activeChatAbortController === abortController) activeChatAbortController = null;
    }
  }

  async function stopChat(payload = {}) {
    let stopped = false;
    const managedDescriptor = resolveManagedDescriptor(payload);
    if (managedDescriptor && agentSessionManager && typeof agentSessionManager.cancelActive === "function") {
      const cancelled = await agentSessionManager.cancelActive(managedDescriptor);
      forgetManagedDescriptor(managedDescriptor);
      if (cancelled) {
        stopped = true;
      }
    }
    if (activeChatAbortController) {
      activeChatAbortController.abort();
      activeChatAbortController = null;
      stopped = true;
    }
    const localBotResponder = getLocalBotResponder();
    const localStop = localBotResponder?.stopActiveConversationRun?.(payload) || { stopped: false };
    const result = {
      stopped: stopped || Boolean(localStop.stopped),
      ...(localStop.conversationId ? { conversationId: localStop.conversationId } : {}),
      ...(localStop.runId ? { runId: localStop.runId } : {}),
      ...(localStop.status ? { status: localStop.status } : {})
    };
    const daemonTasksClient = getDaemonTasksClient();
    if (!isDaemon() && daemonTasksClient?.call) {
      try {
        const daemonStop = await daemonTasksClient?.call?.("/api/chat/stop", {
          method: "POST",
          body: JSON.stringify(payload || {})
        });
        return {
          stopped: result.stopped || Boolean(daemonStop?.stopped),
          ...(daemonStop?.conversationId || result.conversationId ? { conversationId: daemonStop?.conversationId || result.conversationId } : {}),
          ...(daemonStop?.runId || result.runId ? { runId: daemonStop?.runId || result.runId } : {}),
          ...(daemonStop?.status || result.status ? { status: daemonStop?.status || result.status } : {})
        };
      } catch (error) {
        appendCloudLog(`[daemon] chat stop delegation failed: ${error?.message || error}`);
      }
    }
    return result;
  }

  return {
    sendChat,
    stopChat,
    getActiveChatAbortController: () => activeChatAbortController
  };
}

module.exports = {
  boundedMemoryExtractionMessages,
  createBotExecutionCore,
  scheduleMemoryExtraction
};
