// Shared bot-execution core: the single implementation of `sendChat`/`stopChat`
// (and their single-flight abort state) that both the Electron main process and
// the standalone Mia Core node process drive. Pure node — no electron import.
// All host-specific collaborators are injected; services that the host
// reassigns at runtime (or constructs after this factory) are injected as
// accessor functions so the late binding still resolves.

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
  hermesRunService,
  sendWithChatEngineAdapter,
  createActiveChatEngineAdapters,
  // Late-bound: constructed after this factory and takes `sendChat` as a dep.
  localBotResponder,
  isDaemonProcess,
  daemonTasksClient,
  settingsStore,
  appendCloudLog
}) {
  // Single-flight interactive chat controller — factory state, not a module
  // global. Group/utility/background turns keep their own controllers.
  let activeChatAbortController = null;

  const getLocalBotResponder = typeof localBotResponder === "function"
    ? localBotResponder
    : () => localBotResponder;
  const getDaemonTasksClient = typeof daemonTasksClient === "function"
    ? daemonTasksClient
    : () => daemonTasksClient;
  const isDaemon = typeof isDaemonProcess === "function"
    ? isDaemonProcess
    : () => isDaemonProcess;

  async function sendChat({ botKey, botId, botSnapshot = null, sessionId, messages, group, webContents, emit: externalEmit = null, utility = false, persistAgentSession = undefined, background = false, scheduledFire = false, allowSlashCommands = true, runtimeConfig = null, activeSkillIds = [], signal: externalSignal = null, abortController: externalAbortController = null }) {
    utility = Boolean(utility);
    const shouldPersistAgentSession = persistAgentSession == null
      ? !utility
      : Boolean(persistAgentSession);
    let abortController = externalAbortController && typeof externalAbortController.abort === "function"
      ? externalAbortController
      : null;
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
    const signal = externalSignal || abortController.signal;
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
      const agentEngine = chatEngine.id;
      const shouldNotifyPet = !utility && !String(sessionId || "").startsWith("title:");
      const completeWithPetMessage = (response) => {
        if (shouldNotifyPet) botPetService.notifyMessage(botForTurn.key, responseMessageContent(response));
        return response;
      };
      if (emit) {
        emit("session_started", { botKey: botForTurn.key, engine: agentEngine });
      }
      // Scheduler is always an available structured capability on foreground
      // turns. Composer "使用" chips still get an explicit directive so the agent
      // prioritizes them for this turn.
      const turnEnabledSkillIds = schedulerSkillIdsForTurn({ activeSkillIds, background, scheduledFire });
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
      const slashText = allowSlashCommands ? hermesRunService.slashCommandText(messages) : "";
      const response = await sendWithChatEngineAdapter(createActiveChatEngineAdapters(), {
        chatEngine,
        bot: botForTurn,
        sessionId,
        messages,
        group,
        signal,
        abortController,
        emit,
        utility,
        scheduledFire,
        persistAgentSession: shouldPersistAgentSession,
        slashText,
        runtimeConfig: turnRuntimeConfig
      });
      return completeWithPetMessage(response);
    } catch (error) {
      if (signal.aborted) {
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

module.exports = { createBotExecutionCore };
