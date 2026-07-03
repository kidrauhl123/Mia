const crypto = require("node:crypto");
const { normalizeCloudClaudeCodeModel } = require("./cloud-claude-code-model.js");

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

function claudeMessageText(message) {
  if (!message || typeof message !== "object") return "";
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
  return "bypassPermissions";
}

function randomRunId() {
  return `cc_${crypto.randomBytes(8).toString("hex")}`;
}

function formatSeedMessages(messages = []) {
  const rows = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String(message?.role || "").trim() || "user";
    const content = String(message?.content || "").trim();
    if (!content) continue;
    rows.push(`${role === "assistant" ? "Assistant" : role === "system" ? "System" : "User"}:\n${content}`);
  }
  if (!rows.length) return "";
  return ["Conversation history:", ...rows].join("\n\n");
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
    formatSeedMessages(args.seedMessages),
    attachmentRuntimeHint(args.worker, args.attachments),
    String(args.input || "").trim()
  ].filter(Boolean).join("\n\n");
}

function eventTextDelta(id, text) {
  return { type: "text_delta", id, text };
}

function createSdkEventBridge(onEvent, randomUUID) {
  let activeTextId = null;
  const reasoningId = `reasoning_${randomUUID()}`;
  const blockIndex = new Map();
  let textCounter = 0;
  let sawStreamEvent = false;

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

  function handleAssistant(message = {}) {
    activeTextId = null;
    const text = claudeMessageText(message);
    if (text && !sawStreamEvent) {
      textCounter += 1;
      emit("text_delta", eventTextDelta(`text_${textCounter}`, text));
    }
    const contentBlocks = Array.isArray(message?.message?.content) ? message.message.content : [];
    for (const block of contentBlocks) {
      if (block?.type !== "tool_use") continue;
      const toolId = String(block.id || `tool_${randomUUID()}`);
      const toolName = String(block.name || "tool");
      const preview = block.input ? JSON.stringify(block.input).slice(0, 4000) : "";
      emit("tool_call_started", { id: toolId, name: toolName, preview });
    }
  }

  function handleToolResults(message = {}) {
    const contentBlocks = Array.isArray(message?.message?.content) ? message.message.content : [];
    for (const block of contentBlocks) {
      if (block?.type !== "tool_result") continue;
      const toolId = String(block.tool_use_id || "");
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
    const model = normalizeCloudClaudeCodeModel(args.model, { defaultModel: worker.model });
    const permissionMode = normalizeClaudePermissionMode(args.permissionMode || worker.permissionMode);
    const options = {
      cwd: worker.paths?.workspace || process.cwd(),
      env: worker.env || {},
      abortController,
      tools: { type: "preset", preset: "claude_code" },
      settingSources: [],
      includePartialMessages: true,
      model,
      permissionMode,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: String(args.instructions || "").trim()
      },
      sandbox: worker.sandboxSettings || { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true }
    };
    if (permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;

    const chunks = [];
    const events = [];
    const eventBridge = createSdkEventBridge((event) => {
      events.push(event);
      args.onEvent?.(event);
    }, randomUUID);

    try {
      const { query } = await claudeAgentSdk();
      const stream = query({ prompt, options });
      activeRuns.set(runId, { abortController, worker, stream });
      for await (const message of stream) {
        if (abortController.signal.aborted) break;
        if (message?.type === "assistant") {
          const text = claudeMessageText(message);
          if (text) chunks.push(text);
        } else if (message?.type === "result" && message.subtype && message.subtype !== "success") {
          log(`[cloud-claude-code] result subtype=${message.subtype}`);
        }
        eventBridge.handle(message);
      }
      if (abortController.signal.aborted) {
        return {
          runId,
          content: chunks.join("\n").trim(),
          events: [...events, { type: "message.complete", status: "interrupted" }]
        };
      }
      return {
        runId,
        content: chunks.join("\n").trim(),
        events: [...events, { type: "message.complete", status: "complete" }]
      };
    } finally {
      activeRuns.delete(runId);
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
  normalizeClaudePermissionMode
};
