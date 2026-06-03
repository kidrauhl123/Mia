const crypto = require("node:crypto");
const {
  appendMiaMemoryBlock,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
} = require("./mia-runtime-context.js");

function firstTextValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstTextValue).filter(Boolean).join("");
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "delta", "output", "message", "final_response"]) {
      const nested = firstTextValue(value[key]);
      if (nested) return nested;
    }
  }
  return "";
}

function claudeMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const direct = firstTextValue(message.text || message.content || message.delta);
  if (direct) return direct;
  const nested = message.message || message.data || {};
  return firstTextValue(nested.content || nested.text || nested.delta);
}

function normalizeClaudePermissionMode(value) {
  const id = String(value || "default").trim();
  if (["default", "acceptEdits", "auto", "bypassPermissions", "plan", "dontAsk"].includes(id)) return id;
  return "default";
}

function statelessPrompt(systemPrompt, userPrompt) {
  return systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
}

function stoppedError() {
  const stopped = new Error("生成已停止");
  stopped.code = "MIA_STOPPED";
  return stopped;
}

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") throw new Error(`${key} dependency is required.`);
  return deps[key];
}

function createClaudeCodeChatAdapter(deps = {}) {
  const shellCommandPath = requireDependency(deps, "shellCommandPath");
  const lastUserPrompt = requireDependency(deps, "lastUserPrompt");
  const expandLeadingSkillCommand = requireDependency(deps, "expandLeadingSkillCommand");
  const buildEnabledSkillsContext = deps.buildEnabledSkillsContext || (() => "");
  const injectGroupContextForSdk = requireDependency(deps, "injectGroupContextForSdk");
  const readFellowPersona = requireDependency(deps, "readFellowPersona");
  const claudeAgentSdk = requireDependency(deps, "claudeAgentSdk");
  const ensureClaudeBridgePlugin = requireDependency(deps, "ensureClaudeBridgePlugin");
  const appendEngineLog = requireDependency(deps, "appendEngineLog");
  const getAgentSessionEntry = requireDependency(deps, "getAgentSessionEntry");
  const setAgentSessionEntry = requireDependency(deps, "setAgentSessionEntry");
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const normalizeEffortLevel = requireDependency(deps, "normalizeEffortLevel");
  const chatCompletionResponse = requireDependency(deps, "chatCompletionResponse");
  const memoryBlock = deps.memoryBlock || (() => "");
  const getSchedulerMcpSpec = requireDependency(deps, "getSchedulerMcpSpec");
  const writeSchedulerMcpContext = requireDependency(deps, "writeSchedulerMcpContext");
  const permissionCoordinator = deps.permissionCoordinator || null;
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const cwd = deps.cwd || (() => process.cwd());

  async function sendChat({ fellow, sessionId, messages, group, signal, abortController, emit, utility = false, scheduledFire = false, persistAgentSession = !utility }) {
    const engine = "claude-code";
    const shouldPersistAgentSession = Boolean(persistAgentSession);
    const commandPath = shellCommandPath("claude");
    if (!commandPath) throw new Error("本机没有检测到 Claude Code CLI。请先安装并确认 `claude --version` 可用。");
    const lastUser = lastUserPrompt(messages);
    // Best-effort: grab id from last user message for scheduler context
    const lastUserMessage = Array.isArray(messages) ? [...messages].reverse().find((m) => m?.role === "user") : null;
    const originMessageId = String(lastUserMessage?.id || "");
    try {
      writeSchedulerMcpContext({ fellowId: fellow.key, sessionId, originMessageId });
    } catch (error) {
      appendEngineLog(`Scheduler MCP context write failed: ${error?.message || error}`);
    }
    const expandedPrompt = sanitizeMiaMemorySpoof(expandLeadingSkillCommand(lastUser, { mode: "native" }) || lastUser);
    const prompt = [buildEnabledSkillsContext(fellow), expandedPrompt]
      .filter(Boolean)
      .join("\n\n");
    const promptWithGroup = group && group.contextBlock
      ? injectGroupContextForSdk(prompt, group.contextBlock)
      : prompt;
    const miaMemory = memoryBlock({ fellowKey: fellow.key, sessionId });
    const persona = appendMiaMemoryBlock(
      withMiaRuntimeContext(readFellowPersona(fellow.key, fellow.name, fellow.bio), { scheduledFire }),
      miaMemory
    ).trim();
    const { query } = await claudeAgentSdk();
    let bridgePluginPath = "";
    let bridgeFingerprint = "";
    try {
      const bridge = ensureClaudeBridgePlugin();
      bridgePluginPath = bridge.path;
      bridgeFingerprint = bridge.fingerprint;
    } catch (error) {
      appendEngineLog(`Claude bridge plugin refresh failed: ${error?.message || error}`);
    }
    const savedEntry = shouldPersistAgentSession ? getAgentSessionEntry(engine, fellow.key, sessionId) : {};
    const externalSessionId = savedEntry.id && savedEntry.fingerprint === bridgeFingerprint
      ? savedEntry.id
      : "";
    const schedulerMcpSpec = (() => {
      try { return getSchedulerMcpSpec(); } catch { return null; }
    })();
    const options = {
      abortController,
      cwd: cwd(),
      pathToClaudeCodeExecutable: commandPath,
      env: processEnvStrings(),
      tools: { type: "preset", preset: "claude_code" },
      settingSources: ["project", "user", "local"],
      permissionMode: normalizeClaudePermissionMode(fellow.engineConfig?.permissionMode || fellow.agentPermissionMode || "default"),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: persona
      },
      includePartialMessages: Boolean(emit),
      ...(bridgePluginPath ? { plugins: [{ type: "local", path: bridgePluginPath }], skills: "all" } : {}),
      ...(schedulerMcpSpec ? { mcpServers: { "mia-scheduler": schedulerMcpSpec } } : {})
    };
    if (externalSessionId) options.resume = externalSessionId;
    if (fellow.engineConfig?.model) options.model = String(fellow.engineConfig.model);
    options.effort = normalizeEffortLevel(fellow.engineConfig?.effortLevel || "medium", "claude-code");
    if (options.permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (permissionCoordinator && options.permissionMode !== "bypassPermissions") {
      options.canUseTool = async (toolName, input = {}, context = {}) => {
        let preview = "";
        try { preview = input ? JSON.stringify(input, null, 2).slice(0, 4000) : ""; } catch { preview = ""; }
        const decision = await permissionCoordinator.requestPermission({
          engine,
          fellowKey: fellow.key,
          sessionId,
          signal: context.signal || signal,
          emit,
          toolName,
          title: context.title || `${fellow.name || "Claude Code"} 想使用 ${context.displayName || toolName}`,
          description: context.description || context.decisionReason || "",
          preview,
          input
        });
        if (decision.decision === "allow") {
          return {
            behavior: "allow",
            updatedInput: input,
            toolUseID: context.toolUseID,
            decisionClassification: decision.scope === "always" ? "user_permanent" : "user_temporary"
          };
        }
        return {
          behavior: "deny",
          message: decision.message || "用户拒绝了工具权限。",
          toolUseID: context.toolUseID,
          decisionClassification: "user_reject"
        };
      };
    }

    const stream = query({ prompt: promptWithGroup, options });
    let capturedSessionId = externalSessionId;
    const chunks = [];
    let activeTextId = null;
    const reasoningId = `reasoning_${randomUUID()}`;
    const blockIndex = new Map();
    for await (const message of stream) {
      if (signal?.aborted) break;
      if (message?.session_id && !capturedSessionId) {
        capturedSessionId = message.session_id;
        if (shouldPersistAgentSession) setAgentSessionEntry(engine, fellow.key, sessionId, capturedSessionId, bridgeFingerprint);
      }

      if (emit && message?.type === "stream_event") {
        const ev = message.event;
        if (!ev) continue;
        if (ev.type === "content_block_start" && ev.content_block) {
          const idx = ev.index;
          const block = ev.content_block;
          if (block.type === "text") {
            if (!activeTextId) activeTextId = `text_${randomUUID()}`;
            blockIndex.set(idx, { kind: "text", id: activeTextId });
          } else if (block.type === "thinking") {
            blockIndex.set(idx, { kind: "thinking", id: reasoningId });
          } else if (block.type === "tool_use") {
            const toolId = String(block.id || `tool_${idx}`);
            const toolName = String(block.name || "tool");
            const preview = block.input ? JSON.stringify(block.input, null, 2) : "";
            blockIndex.set(idx, { kind: "tool_use", id: toolId, name: toolName, input: preview });
            emit("tool_call_started", { id: toolId, name: toolName, preview });
          }
        } else if (ev.type === "content_block_delta" && ev.delta) {
          const meta = blockIndex.get(ev.index);
          if (!meta) continue;
          if (ev.delta.type === "text_delta" && meta.kind === "text") {
            emit("text_delta", { id: meta.id, text: String(ev.delta.text || "") });
          } else if (ev.delta.type === "thinking_delta" && meta.kind === "thinking") {
            emit("reasoning_delta", { id: meta.id, text: String(ev.delta.thinking || "") });
          } else if (ev.delta.type === "input_json_delta" && meta.kind === "tool_use") {
            meta.input = `${meta.input || ""}${String(ev.delta.partial_json || "")}`;
            emit("tool_call_delta", {
              id: meta.id,
              name: meta.name,
              preview: meta.input.slice(0, 4000)
            });
          }
        }
        continue;
      }

      if (message?.type === "assistant") {
        const beta = message.message;
        const contentBlocks = Array.isArray(beta?.content) ? beta.content : [];
        const text = claudeMessageText(message);
        if (text) chunks.push(text);
        if (!emit) continue;
        activeTextId = null;
        if (!options.includePartialMessages && text) {
          emit("text_delta", { id: `text_${randomUUID()}`, text });
        }
        for (const block of contentBlocks) {
          if (block?.type === "tool_use" && !options.includePartialMessages) {
            const toolId = String(block.id || `tool_${randomUUID()}`);
            const toolName = String(block.name || "tool");
            const preview = block.input ? JSON.stringify(block.input).slice(0, 160) : "";
            emit("tool_call_started", { id: toolId, name: toolName, preview });
          }
        }
        continue;
      }

      if (emit && message?.type === "user") {
        const beta = message.message;
        const contentBlocks = Array.isArray(beta?.content) ? beta.content : [];
        for (const block of contentBlocks) {
          if (block?.type === "tool_result") {
            const toolId = String(block.tool_use_id || "");
            const resultPreview = firstTextValue(block.content).slice(0, 4000);
            emit("tool_call_completed", {
              id: toolId,
              name: "",
              preview: resultPreview,
              duration: null,
              error: Boolean(block.is_error)
            });
          }
        }
      }
    }
    if (capturedSessionId && !externalSessionId && shouldPersistAgentSession) {
      setAgentSessionEntry(engine, fellow.key, sessionId, capturedSessionId, bridgeFingerprint);
    }
    if (signal?.aborted) {
      if (emit) emit("complete", { finishReason: "cancelled", aborted: true });
      throw stoppedError();
    }
    if (emit) emit("complete", { finishReason: "stop", aborted: false });
    return chatCompletionResponse({
      id: capturedSessionId || `claude_${randomUUID()}`,
      model: "claude-code",
      content: chunks.join("\n").trim(),
      mia: {
        transport: "claude-agent-sdk",
        engine,
        session_id: capturedSessionId || "",
        fellow_key: fellow.key
      }
    });
  }

  async function sendStateless({ systemPrompt, userPrompt, signal }) {
    const commandPath = shellCommandPath("claude");
    if (!commandPath) throw new Error("本机没有检测到 Claude Code CLI。请先安装并确认 `claude --version` 可用。");
    const { query } = await claudeAgentSdk();
    const fullPrompt = statelessPrompt(systemPrompt, userPrompt);
    const options = {
      cwd: cwd(),
      pathToClaudeCodeExecutable: commandPath,
      env: processEnvStrings(),
      tools: { type: "preset", preset: "claude_code" },
      settingSources: ["project", "user", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" }
    };
    const stream = query({ prompt: fullPrompt, options });
    const chunks = [];
    for await (const message of stream) {
      if (signal?.aborted) break;
      if (message?.type === "assistant") {
        const text = claudeMessageText(message);
        if (text) chunks.push(text);
      }
    }
    if (signal?.aborted) throw stoppedError();
    return { content: chunks.join("\n").trim() };
  }

  return { sendChat, sendStateless };
}

module.exports = {
  claudeMessageText,
  createClaudeCodeChatAdapter,
  normalizeClaudePermissionMode
};
