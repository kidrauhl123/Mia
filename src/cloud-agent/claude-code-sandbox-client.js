const crypto = require("node:crypto");
const { normalizeCloudClaudeCodeModel } = require("./cloud-claude-code-model.js");
const { mergeAssistantText } = require("../shared/assistant-content-blocks.js");

let claudeAgentSdkModule = null;

async function defaultClaudeAgentSdk() {
  if (!claudeAgentSdkModule) claudeAgentSdkModule = await import("@anthropic-ai/claude-agent-sdk");
  return claudeAgentSdkModule;
}

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

function assistantContentBlocks(message = {}) {
  const direct = Array.isArray(message?.content) ? message.content : null;
  const nested = Array.isArray(message?.message?.content) ? message.message.content : null;
  return direct || nested || [];
}

function assistantTextBlockText(block = {}) {
  if (!block || typeof block !== "object") return "";
  if (block.type && block.type !== "text") return "";
  return firstTextValue(block.text || block.content);
}

function assistantContentBlocksText(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .map(assistantTextBlockText)
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function claudeMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const blocksText = assistantContentBlocksText(assistantContentBlocks(message));
  if (blocksText) return blocksText;
  const direct = firstTextValue(message.text || message.content || message.delta);
  if (direct) return direct;
  const nested = message.message || message.data || {};
  return firstTextValue(nested.content || nested.text || nested.delta);
}

function normalizeClaudePermissionMode(value) {
  const id = String(value || "bypassPermissions").trim();
  if ([":danger-full-access", "danger-full-access", "yolo", "off", "never"].includes(id)) return "bypassPermissions";
  if (["default", "acceptEdits", "auto", "bypassPermissions", "plan", "dontAsk"].includes(id)) return id;
  if (id === "ask") return "default";
  if (["deny", "read", "readOnly", "read-only"].includes(id)) return "plan";
  return "default";
}

function randomRunId() {
  return `cc_${crypto.randomBytes(8).toString("hex")}`;
}

function cleanSessionId(value = "") {
  return String(value || "").trim();
}

function resumeSessionId(args = {}) {
  return cleanSessionId(args.nativeSessionId || args.resumeSessionId || args.sdkSessionId);
}

function sdkSessionIdFromMessage(message = {}) {
  if (!message || typeof message !== "object") return "";
  return cleanSessionId(
    message.session_id
      || message.sessionId
      || message.session?.id
      || message.message?.session_id
      || message.message?.sessionId
      || message.data?.session_id
      || message.data?.sessionId
  );
}

function isStaleSessionError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || error || "").toLowerCase();
  return code === "enosession"
    || /session[\s_-]+not[\s_-]+found/.test(message)
    || /not[\s_-]+found.*session/.test(message)
    || /no[\s_-]+session/.test(message);
}

function attachmentRuntimeHint(worker = {}, attachments = []) {
  const paths = worker.paths || {};
  const root = String(paths.root || "").trim();
  const visible = Array.isArray(attachments) ? attachments.filter((item) => item?.path) : [];
  if (!root && !visible.length) return "";
  return [
    "Mia cloud sandbox filesystem mapping:",
    root ? `- When the prompt mentions /data/..., use the matching real path under ${root}/... in this process.` : "",
    "- When you create downloadable files, write them under the workspace or home directory and mention the final path as /data/workspace/... or /data/home/... so Mia can attach it.",
    ...visible.map((attachment) => `- Attachment ${attachment.name || "attachment"}: ${attachment.path}${attachment.hostPath ? ` maps to ${attachment.hostPath}` : ""}`)
  ].filter(Boolean).join("\n");
}

function buildPrompt(args = {}) {
  return [
    String(args.input || "").trim()
  ].filter(Boolean).join("\n\n");
}

function buildSystemPromptAppend(args = {}) {
  return [
    String(args.instructions || "").trim(),
    attachmentRuntimeHint(args.worker, args.attachments)
  ].filter(Boolean).join("\n\n");
}

function objectFromMcpSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function mcpServersFromRuntimeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const nested = value.mcpServers || value.mcp_servers;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return {};
}

function normalizeMcpServerSpec(spec = {}) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const command = String(spec.command || "").trim();
  const url = String(spec.url || "").trim();
  if (command) {
    const trusted = spec.trusted === true || spec.miaTrusted === true || String(spec.source || "") === "mia-cloud";
    if (!trusted) return null;
    return {
      ...(spec.type ? { type: String(spec.type) } : { type: "stdio" }),
      command,
      ...(Array.isArray(spec.args) ? { args: spec.args.map((arg) => String(arg || "")) } : {}),
      ...(spec.env && typeof spec.env === "object" && !Array.isArray(spec.env) ? { env: { ...spec.env } } : {})
    };
  }
  if (!url) return null;
  return {
    ...(spec.type ? { type: String(spec.type) } : {}),
    url,
    ...(spec.headers && typeof spec.headers === "object" && !Array.isArray(spec.headers) ? { headers: { ...spec.headers } } : {}),
    ...(spec.bearer_token_env_var ? { bearer_token_env_var: String(spec.bearer_token_env_var) } : {}),
    ...(spec.bearerTokenEnvVar ? { bearer_token_env_var: String(spec.bearerTokenEnvVar) } : {})
  };
}

function isDesktopOnlyReservedMcp(name = "", spec = {}) {
  const id = String(name || "").trim();
  if (id === "mia-scheduler") return true;
  if (id !== "mia-app") return false;
  const env = spec && typeof spec.env === "object" && !Array.isArray(spec.env) ? spec.env : {};
  return Boolean(env.MIA_CORE_URL || env.MIA_CORE_TOKEN || env.MIA_SCHEDULER_CONTEXT_FILE);
}

function normalizeCloudMcpServers(...sources) {
  const servers = {};
  for (const source of sources) {
    const object = objectFromMcpSource(source);
    for (const [name, rawSpec] of Object.entries(object)) {
      const serverName = String(name || "").trim();
      if (!serverName) continue;
      const spec = normalizeMcpServerSpec(rawSpec);
      if (!spec || isDesktopOnlyReservedMcp(serverName, spec)) continue;
      servers[serverName] = spec;
    }
  }
  return Object.keys(servers).length ? servers : null;
}

function eventTextDelta(id, text) {
  return { type: "text_delta", id, text };
}

function sameTrimmedText(left, right) {
  return String(left || "").trim() === String(right || "").trim();
}

function createSdkEventBridge(onEvent, randomUUID) {
  let activeTextId = null;
  const reasoningId = `reasoning_${randomUUID()}`;
  const blockIndex = new Map();
  let textCounter = 0;
  let sawStreamEvent = false;
  let fallbackTextId = "";
  let fallbackAssistantText = "";
  let fallbackAssistantSnapshot = "";
  const fallbackBlockText = new Map();
  const fallbackStartedToolIds = new Set();
  const fallbackCompletedToolIds = new Set();
  let fallbackAssistantBlockScope = 0;
  let fallbackAssistantBlockSnapshot = "";

  function emit(type, payload = {}) {
    if (typeof onEvent === "function") onEvent({ type, ...payload });
  }

  function handleStreamEvent(ev = {}) {
    sawStreamEvent = true;
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
        const preview = block.input ? JSON.stringify(block.input, null, 2).slice(0, 4000) : "";
        blockIndex.set(idx, { kind: "tool_use", id: toolId, name: toolName, input: preview });
        emit("tool_call_started", { id: toolId, name: toolName, preview });
      }
      return;
    }
    if (ev.type !== "content_block_delta" || !ev.delta) return;
    const meta = blockIndex.get(ev.index);
    if (!meta) return;
    if (ev.delta.type === "text_delta" && meta.kind === "text") {
      emit("text_delta", { id: meta.id, text: String(ev.delta.text || "") });
    } else if (ev.delta.type === "thinking_delta" && meta.kind === "thinking") {
      emit("reasoning_delta", { id: meta.id, text: String(ev.delta.thinking || "") });
    } else if (ev.delta.type === "input_json_delta" && meta.kind === "tool_use") {
      meta.input = `${meta.input || ""}${String(ev.delta.partial_json || "")}`;
      emit("tool_call_delta", { id: meta.id, name: meta.name, preview: meta.input.slice(0, 4000) });
    }
  }

  function fallbackContentBlockScope(blocks = []) {
    const snapshot = assistantContentBlocksText(blocks);
    if (fallbackAssistantBlockSnapshot && snapshot) {
      const merged = mergeAssistantText(fallbackAssistantBlockSnapshot, snapshot);
      if (merged.kind === "append") fallbackAssistantBlockScope += 1;
    }
    if (snapshot) fallbackAssistantBlockSnapshot = snapshot;
    return fallbackAssistantBlockScope;
  }

  function fallbackBlockId(prefix, block = {}, index = 0, scope = fallbackAssistantBlockScope) {
    return String(block.id || `${prefix}_${scope}_${index}`).trim();
  }

  function emitFallbackTextBlock(block = {}, index = 0, scope = fallbackAssistantBlockScope) {
    const text = assistantTextBlockText(block);
    if (!text) return false;
    const id = fallbackBlockId("text", block, index, scope);
    const previous = fallbackBlockText.get(id) || "";
    const merged = mergeAssistantText(previous, text);
    if (merged.kind === "noop" || !merged.delta) return true;
    fallbackBlockText.set(id, merged.text);
    emit("text_delta", eventTextDelta(id, merged.delta));
    return true;
  }

  function emitFallbackThinkingBlock(block = {}, index = 0, scope = fallbackAssistantBlockScope) {
    const text = firstTextValue(block.thinking || block.text || block.content);
    if (!text) return false;
    const id = fallbackBlockId("thinking", block, index, scope);
    const previous = fallbackBlockText.get(id) || "";
    const merged = mergeAssistantText(previous, text);
    if (merged.kind === "noop" || !merged.delta) return true;
    fallbackBlockText.set(id, merged.text);
    emit("reasoning_delta", { id, text: merged.delta });
    return true;
  }

  function emitFallbackToolUseBlock(block = {}, index = 0, scope = fallbackAssistantBlockScope) {
    const id = fallbackBlockId("tool", block, index, scope);
    if (fallbackStartedToolIds.has(id)) return true;
    fallbackStartedToolIds.add(id);
    const name = String(block.name || "tool");
    const preview = block.input ? JSON.stringify(block.input, null, 2).slice(0, 4000) : "";
    emit("tool_call_started", { id, name, preview });
    return true;
  }

  function emitAssistantContentBlocks(message = {}) {
    if (sawStreamEvent) return false;
    const blocks = assistantContentBlocks(message);
    if (!blocks.length) return false;
    const scope = fallbackContentBlockScope(blocks);
    let emitted = false;
    blocks.forEach((block, index) => {
      if (!block || typeof block !== "object") return;
      if (block.type === "text" || (!block.type && assistantTextBlockText(block))) {
        emitted = emitFallbackTextBlock(block, index, scope) || emitted;
      } else if (block.type === "thinking") {
        emitted = emitFallbackThinkingBlock(block, index, scope) || emitted;
      } else if (block.type === "tool_use") {
        emitted = emitFallbackToolUseBlock(block, index, scope) || emitted;
      }
    });
    return emitted;
  }

  function handleAssistant(message = {}) {
    activeTextId = null;
    if (emitAssistantContentBlocks(message)) return;
    const text = claudeMessageText(message);
    if (text && !sawStreamEvent) {
      if (!sameTrimmedText(fallbackAssistantSnapshot, text)) {
        const merged = mergeAssistantText(fallbackAssistantText, text);
        if (merged.kind === "start" || merged.kind === "append") {
          textCounter += 1;
          fallbackTextId = `text_${textCounter}`;
          emit("text_delta", eventTextDelta(fallbackTextId, merged.delta));
          fallbackAssistantText = merged.text;
        } else if (merged.kind === "extend" && merged.delta) {
          if (!fallbackTextId) {
            textCounter += 1;
            fallbackTextId = `text_${textCounter}`;
          }
          emit("text_delta", eventTextDelta(fallbackTextId, merged.delta));
          fallbackAssistantText = merged.text;
        }
        fallbackAssistantSnapshot = text;
      }
    }
  }

  function handleToolResults(message = {}) {
    const contentBlocks = assistantContentBlocks(message);
    for (const block of contentBlocks) {
      if (block?.type !== "tool_result") continue;
      const toolId = String(block.tool_use_id || "");
      if (toolId && fallbackCompletedToolIds.has(toolId)) continue;
      if (toolId) fallbackCompletedToolIds.add(toolId);
      const preview = firstTextValue(block.content).slice(0, 4000);
      emit("tool_call_completed", {
        id: toolId,
        name: "",
        preview,
        duration: null,
        error: Boolean(block.is_error)
      });
    }
  }

  return {
    handle(message = {}) {
      if (message?.type === "stream_event") {
        handleStreamEvent(message.event || {});
      } else if (message?.type === "assistant") {
        handleAssistant(message);
      } else if (message?.type === "user") {
        handleToolResults(message);
      }
    }
  };
}

function createCloudClaudeCodeClient(deps = {}) {
  const claudeAgentSdk = deps.claudeAgentSdk || defaultClaudeAgentSdk;
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const activeRuns = new Map();

  async function runChat(args = {}) {
    const worker = args.worker || {};
    if (!worker.hasApiKey && !worker.env?.ANTHROPIC_API_KEY && !worker.env?.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("DeepSeek API Key is not configured. Set MIA_DEEPSEEK_API_KEY or MIA_CLOUD_CLAUDE_CODE_API_KEY.");
    }
    const runId = randomRunId();
    const abortController = new AbortController();
    activeRuns.set(runId, { abortController, worker });
    if (typeof args.onRunCreated === "function") args.onRunCreated(runId);
    const prompt = buildPrompt({ ...args, worker });
    const systemPromptAppend = buildSystemPromptAppend({ ...args, worker });
    const model = normalizeCloudClaudeCodeModel(args.model, { defaultModel: worker.model });
    const permissionMode = normalizeClaudePermissionMode(args.permissionMode || worker.permissionMode);
    const mcpServers = normalizeCloudMcpServers(
      worker.mcpServers,
      worker.mcp_servers,
      mcpServersFromRuntimeConfig(args.runtimeConfig),
      args.mcpServers,
      args.mcp_servers
    );
    const options = {
      cwd: String(args.cwd || worker.paths?.workspace || process.cwd()),
      env: worker.env || {},
      abortController,
      tools: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      includePartialMessages: true,
      model,
      permissionMode,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: systemPromptAppend
      },
      sandbox: worker.sandboxSettings || { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true }
    };
    if (Array.isArray(args.additionalDirectories) && args.additionalDirectories.length) {
      options.additionalDirectories = args.additionalDirectories.map((dir) => String(dir || "")).filter(Boolean);
    }
    if (Array.isArray(args.skills) && args.skills.length) {
      options.skills = args.skills.map((name) => String(name || "")).filter(Boolean);
    }
    if (permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (mcpServers) {
      options.mcpServers = mcpServers;
      options.strictMcpConfig = true;
    }
    const resume = resumeSessionId(args);
    if (resume) options.resume = resume;

    let assistantText = "";
    let lastAssistantSnapshot = "";
    let sdkSessionId = "";
    const events = [];
    const activeRunKeys = new Set([runId]);
    const eventBridge = createSdkEventBridge((event) => {
      events.push(event);
      args.onEvent?.(event);
    }, randomUUID);
    const reportedSessionIds = new Set();

    function trackActiveRun(key, stream = null) {
      const id = cleanSessionId(key);
      if (!id) return;
      activeRunKeys.add(id);
      activeRuns.set(id, { abortController, worker, stream });
    }

    function noteSdkSessionId(message, stream = null) {
      const id = sdkSessionIdFromMessage(message);
      if (!id) return;
      sdkSessionId = id;
      trackActiveRun(id, stream);
      if (!reportedSessionIds.has(id)) {
        reportedSessionIds.add(id);
        args.onSessionId?.(id);
      }
    }

    async function executeQuery(query, attemptOptions) {
      const stream = query({ prompt, options: attemptOptions });
      trackActiveRun(runId, stream);
      for await (const message of stream) {
        if (abortController.signal.aborted) break;
        noteSdkSessionId(message, stream);
        if (message?.type === "assistant") {
          const text = claudeMessageText(message);
          if (text && !sameTrimmedText(lastAssistantSnapshot, text)) {
            assistantText = mergeAssistantText(assistantText, text).text;
            lastAssistantSnapshot = text;
          }
        } else if (message?.type === "result" && message.subtype && message.subtype !== "success") {
          log(`[cloud-claude-code] result subtype=${message.subtype}`);
        }
        eventBridge.handle(message);
      }
    }

    try {
      const { query } = await claudeAgentSdk();
      try {
        await executeQuery(query, options);
      } catch (error) {
        if (!options.resume || !isStaleSessionError(error) || assistantText || events.length) throw error;
        args.onSessionReset?.({ staleSessionId: options.resume, error });
        const freshOptions = { ...options };
        delete freshOptions.resume;
        delete freshOptions.continue;
        await executeQuery(query, freshOptions);
      }
      if (abortController.signal.aborted) {
        return {
          runId,
          sessionId: sdkSessionId,
          nativeSessionId: sdkSessionId,
          content: assistantText.trim(),
          events: [...events, { type: "message.complete", status: "interrupted" }]
        };
      }
      return {
        runId,
        sessionId: sdkSessionId,
        nativeSessionId: sdkSessionId,
        content: assistantText.trim(),
        events: [...events, { type: "message.complete", status: "complete" }]
      };
    } finally {
      for (const key of activeRunKeys) activeRuns.delete(key);
    }
  }

  async function interruptSession(args = {}) {
    const sessionId = String(args.sessionId || args.runId || "").trim();
    const active = activeRuns.get(sessionId);
    if (!active) return { status: "not_found" };
    active.abortController.abort();
    if (typeof active.stream?.interrupt === "function") {
      try {
        await active.stream.interrupt();
      } catch {
        // The abort controller already owns cancellation; ignore late SDK errors.
      }
    }
    if (typeof active.stream?.close === "function") active.stream.close();
    return { status: "interrupted" };
  }

  async function submitApproval() {
    return { ok: false, error: "cloud Claude Code runs use sandboxed bypass permissions and do not support interactive approvals yet" };
  }

  return {
    kind: "claude-code",
    runtimeKind: "cloud-claude-code",
    runtimeRunPrefix: "cc",
    requiresGateway: false,
    runChat,
    interruptSession,
    submitApproval
  };
}

module.exports = {
  buildPrompt,
  claudeMessageText,
  createCloudClaudeCodeClient,
  normalizeCloudMcpServers,
  normalizeClaudePermissionMode
};
