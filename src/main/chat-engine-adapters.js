const crypto = require("node:crypto");
const { adapterForEngine } = require("./chat-engine-registry.js");

function defaultCommandId() {
  return `cmd_${crypto.randomUUID()}`;
}

function normalizeLocalCommandResult(result) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      content: String(result.content || ""),
      commandResult: result.commandResult || null
    };
  }
  return { content: String(result || ""), commandResult: null };
}

function commandResponse({ commandId, chatCompletionResponse, engine, model, result, content, botKey }) {
  const normalized = normalizeLocalCommandResult(result ?? content);
  return chatCompletionResponse({
    id: commandId(),
    model,
    content: normalized.content,
    commandResult: normalized.commandResult,
    mia: { transport: "local-command", engine, bot_id: botKey }
  });
}

function createChatEngineAdapters(deps = {}) {
  const commandId = typeof deps.commandId === "function" ? deps.commandId : defaultCommandId;
  const chatCompletionResponse = deps.chatCompletionResponse;
  if (typeof chatCompletionResponse !== "function") {
    throw new Error("chatCompletionResponse dependency is required.");
  }

  return {
    "claude-code": {
      id: "claude-code",
      async send(context) {
        const engine = "claude-code";
        const adapter = adapterForEngine(engine);
        if (context.slashText) {
          const localResult = deps.runExternalSlashCommand({
            text: context.slashText,
            bot: context.bot,
            engine,
            sessionId: context.sessionId
          });
          if (localResult != null) {
            return commandResponse({
              commandId,
              chatCompletionResponse,
              engine,
              model: adapter.responseModel,
              result: localResult,
              botKey: context.bot.key
            });
          }
        }
        return deps.sendClaudeCodeChat(context);
      }
    },
    codex: {
      id: "codex",
      async send(context) {
        const engine = "codex";
        const adapter = adapterForEngine(engine);
        if (context.slashText) {
          const localResult = deps.runExternalSlashCommand({
            text: context.slashText,
            bot: context.bot,
            engine,
            sessionId: context.sessionId
          });
          if (localResult != null) {
            return commandResponse({
              commandId,
              chatCompletionResponse,
              engine,
              model: adapter.responseModel,
              result: localResult,
              botKey: context.bot.key
            });
          }
        }
        return deps.sendCodexChat(context);
      }
    },
    openclaw: {
      id: "openclaw",
      async send(context) {
        const engine = "openclaw";
        const adapter = adapterForEngine(engine);
        if (context.slashText) {
          const localResult = deps.runExternalSlashCommand({
            text: context.slashText,
            bot: context.bot,
            engine,
            sessionId: context.sessionId
          });
          if (localResult != null) {
            return commandResponse({
              commandId,
              chatCompletionResponse,
              engine,
              model: adapter.responseModel,
              result: localResult,
              botKey: context.bot.key
            });
          }
        }
        if (typeof deps.sendOpenClawChat === "function") return deps.sendOpenClawChat(context);
        throw new Error("OpenClaw 已保存为运行目标，但当前版本还没有接入 OpenClaw 聊天适配器。");
      }
    },
    hermes: {
      id: "hermes",
      async send(context) {
        await deps.ensureHermesReady();
        if (context.slashText) {
          const content = deps.runHermesSlashCommand({
            text: context.slashText,
            bot: context.bot,
            sessionId: context.sessionId
          });
          return deps.hermesSlashCommandResponse({
            id: commandId(),
            content: content || "(command completed)"
          });
        }
        return deps.sendHermesChat(context);
      }
    }
  };
}

async function sendWithChatEngineAdapter(adapters, context) {
  const adapter = adapters[context.chatEngine?.id] || adapters.hermes;
  if (!adapter || typeof adapter.send !== "function") {
    throw new Error(`No chat engine adapter for ${context.chatEngine?.id || "hermes"}.`);
  }
  return adapter.send(context);
}

function createStatelessChatEngineAdapters(deps = {}) {
  return {
    "claude-code": {
      id: "claude-code",
      send(context) {
        return deps.sendClaudeCodeStateless(context);
      }
    },
    codex: {
      id: "codex",
      send(context) {
        return deps.sendCodexStateless(context);
      }
    },
    openclaw: {
      id: "openclaw",
      async send(context) {
        if (typeof deps.sendOpenClawStateless === "function") return deps.sendOpenClawStateless(context);
        throw new Error("OpenClaw 已保存为运行目标，但当前版本还没有接入 OpenClaw 聊天适配器。");
      }
    },
    hermes: {
      id: "hermes",
      async send(context) {
        await deps.ensureHermesReady();
        return deps.sendHermesStateless(context);
      }
    }
  };
}

async function sendWithStatelessChatEngineAdapter(adapters, context) {
  const adapter = adapters[context.chatEngine?.id] || adapters.hermes;
  if (!adapter || typeof adapter.send !== "function") {
    throw new Error(`No stateless chat engine adapter for ${context.chatEngine?.id || "hermes"}.`);
  }
  return adapter.send(context);
}

module.exports = {
  createChatEngineAdapters,
  createStatelessChatEngineAdapters,
  sendWithStatelessChatEngineAdapter,
  sendWithChatEngineAdapter
};
