const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  appendMiaMemoryBlock,
  miaRuntimeSystemPrompt,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
} = require("./mia-runtime-context.js");

function mapCodexPermissionMode(value) {
  const id = String(value || "default").trim();
  if (id === "acceptEdits") return { sandboxMode: "workspace-write", approvalPolicy: "on-request" };
  if (id === "bypassPermissions" || id === "yolo" || id === "off" || id === "never") {
    return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
  }
  if (id === "readOnly") return { sandboxMode: "read-only", approvalPolicy: "never" };
  return { sandboxMode: "workspace-write", approvalPolicy: "untrusted" };
}

function statelessPrompt(systemPrompt, userPrompt) {
  return systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
}

function stoppedError() {
  const stopped = new Error("生成已停止");
  stopped.code = "MIA_STOPPED";
  return stopped;
}

function runOptions(signal) {
  return signal ? { signal } : {};
}

function generatedImagesRoot(env = {}) {
  const codexHome = String(env.CODEX_HOME || "").trim();
  if (codexHome) return path.join(codexHome, "generated_images");
  const home = String(env.HOME || "").trim() || os.homedir();
  return path.join(home, ".codex", "generated_images");
}

function recentGeneratedImagePaths(sessionId, { env = {}, startedAtMs = 0, max = 8 } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return [];
  const dir = path.join(generatedImagesRoot(env), id);
  if (!fs.existsSync(dir)) return [];
  const since = Number(startedAtMs) - 5000;
  return fs.readdirSync(dir)
    .filter((name) => /\.(?:png|jpe?g|webp)$/i.test(name))
    .map((name) => {
      const filePath = path.join(dir, name);
      try {
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item) => item && item.mtimeMs >= since)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(-max)
    .map((item) => item.filePath);
}

function contentWithGeneratedImages(content, imagePaths = []) {
  const text = String(content || "").trim();
  const paths = imagePaths.filter(Boolean);
  if (!paths.length) return text;
  return text;
}

function mimeForImagePath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function generatedImageAttachments(imagePaths = []) {
  return imagePaths.map((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) return null;
      const mime = mimeForImagePath(filePath);
      const dataUrl = `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
      return {
        id: `generated:${crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16)}`,
        name: path.basename(filePath),
        path: filePath,
        mime,
        size: stat.size,
        kind: "image",
        thumbnailDataUrl: dataUrl,
        dataUrl
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") throw new Error(`${key} dependency is required.`);
  return deps[key];
}

function emitCodexItemEvent(emit, event, textByItem) {
  if (typeof emit !== "function" || !event?.item) return;
  const item = event.item;
  if (item.type === "agent_message") {
    const id = String(item.id || "agent_message");
    const text = String(item.text || "");
    const previous = textByItem.get(id) || "";
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    textByItem.set(id, text);
    if (delta) emit("text_delta", { id, text: delta });
    return;
  }
  if (item.type === "reasoning" && event.type !== "item.completed") {
    const id = String(item.id || "reasoning");
    const text = String(item.text || "");
    const previous = textByItem.get(id) || "";
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    textByItem.set(id, text);
    if (delta) emit("reasoning_delta", { id, text: delta });
    return;
  }
  if (item.type === "command_execution") {
    const payload = {
      id: String(item.id || "command"),
      name: "shell",
      preview: String(item.command || ""),
      status: item.status || "",
      duration: null,
      error: item.status === "failed"
    };
    if (event.type === "item.started") emit("tool_call_started", payload);
    if (event.type === "item.completed") emit("tool_call_completed", payload);
  }
}

async function runCodexTurn(thread, prompt, { signal = null, emit = null } = {}) {
  if (typeof emit !== "function" || typeof thread.runStreamed !== "function") {
    return thread.run(prompt, runOptions(signal));
  }
  const { events } = await thread.runStreamed(prompt, runOptions(signal));
  const items = [];
  const textByItem = new Map();
  let finalResponse = "";
  let usage = null;
  for await (const event of events) {
    if (event.type === "thread.started") {
      emit("session_started", { sessionId: event.thread_id });
    } else if (event.type === "turn.started") {
      emit("status", { text: "本机 Codex 已开始运行。" });
    } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      emitCodexItemEvent(emit, event, textByItem);
      if (event.type === "item.completed") {
        if (event.item?.type === "agent_message") finalResponse = String(event.item.text || "");
        items.push(event.item);
      }
    } else if (event.type === "turn.completed") {
      usage = event.usage || null;
      emit("complete", { finishReason: "stop" });
    } else if (event.type === "turn.failed") {
      throw new Error(event.error?.message || "Codex turn failed.");
    } else if (event.type === "error") {
      throw new Error(event.message || "Codex stream failed.");
    }
  }
  return { items, finalResponse, usage };
}

function createCodexChatAdapter(deps = {}) {
  const shellCommandPath = requireDependency(deps, "shellCommandPath");
  const lastUserPrompt = requireDependency(deps, "lastUserPrompt");
  const expandLeadingSkillCommand = requireDependency(deps, "expandLeadingSkillCommand");
  const buildEnabledSkillsContext = deps.buildEnabledSkillsContext || (() => "");
  const injectGroupContextForSdk = requireDependency(deps, "injectGroupContextForSdk");
  const readFellowPersona = requireDependency(deps, "readFellowPersona");
  const codexSdk = requireDependency(deps, "codexSdk");
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const normalizeEffortLevel = requireDependency(deps, "normalizeEffortLevel");
  const getAgentSessionId = requireDependency(deps, "getAgentSessionId");
  const setAgentSessionId = requireDependency(deps, "setAgentSessionId");
  const chatCompletionResponse = requireDependency(deps, "chatCompletionResponse");
  const memoryBlock = deps.memoryBlock || (() => "");
  const ensureCodexHome = requireDependency(deps, "ensureCodexHome");
  const writeSchedulerMcpContext = requireDependency(deps, "writeSchedulerMcpContext");
  const getMiaAppMcpSpec = deps.getMiaAppMcpSpec || (() => null);
  const getSchedulerMcpSpec = deps.getSchedulerMcpSpec || (() => null);
  const runCodexAppServerTurn = deps.runCodexAppServerTurn || null;
  const permissionCoordinator = deps.permissionCoordinator || null;
  const appendEngineLog = deps.appendEngineLog || (() => {});
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const cwd = deps.cwd || (() => process.cwd());

  async function sendChat({ fellow, sessionId, messages, group, signal, emit = null, utility = false, scheduledFire = false, persistAgentSession = !utility }) {
    const engine = "codex";
    const shouldPersistAgentSession = Boolean(persistAgentSession);
    const commandPath = shellCommandPath("codex");
    if (!commandPath) throw new Error("本机没有检测到 Codex CLI。请先安装并确认 `codex --version` 可用。");
    const externalSessionId = shouldPersistAgentSession ? getAgentSessionId(engine, fellow.key, sessionId) : "";
    const lastUser = lastUserPrompt(messages);
    // Best-effort: grab id from last user message for scheduler context
    const lastUserMessage = Array.isArray(messages) ? [...messages].reverse().find((m) => m?.role === "user") : null;
    const originMessageId = String(lastUserMessage?.id || "");
    try {
      writeSchedulerMcpContext({ fellowId: fellow.key, sessionId, originMessageId });
    } catch {
      // Non-fatal; scheduler MCP context missing means tool works without context defaults
    }
    const miaMemory = memoryBlock({ fellowKey: fellow.key, sessionId });
    const runtimeContext = externalSessionId && (!utility || group) ? miaRuntimeSystemPrompt({ scheduledFire }) : "";
    const runtimeInstructions = !externalSessionId ? runtimeContext : appendMiaMemoryBlock(runtimeContext, miaMemory);
    const expandedPrompt = sanitizeMiaMemorySpoof(expandLeadingSkillCommand(lastUser, { mode: "inline" }) || lastUser);
    const userText = [runtimeInstructions, buildEnabledSkillsContext(fellow), expandedPrompt]
      .filter(Boolean)
      .join("\n\n");
    const persona = !externalSessionId
      ? appendMiaMemoryBlock(
          withMiaRuntimeContext(readFellowPersona(fellow.key, fellow.name, fellow.bio), { scheduledFire }),
          miaMemory
        ).trim()
      : "";
    const prompt = (() => {
      if (!persona) return userText;
      const sections = [];
      sections.push([
        "以下是 Mia 给当前 Fellow 的人设，请在本次对话中遵守：",
        "",
        persona
      ].join("\n"));
      sections.push(["用户消息：", userText].join("\n"));
      return sections.join("\n\n");
    })();
    const promptWithGroup = group && group.contextBlock
      ? injectGroupContextForSdk(prompt, group.contextBlock)
      : prompt;
    const baseEnv = processEnvStrings();
    let codexHomePath = "";
    try {
      codexHomePath = ensureCodexHome();
    } catch (error) {
      throw new Error(`Mia Codex profile setup failed: ${error?.message || error}`);
    }
    if (!codexHomePath) throw new Error("Mia Codex profile setup failed: missing CODEX_HOME.");
    const env = { ...baseEnv, CODEX_HOME: codexHomePath };
    const permission = mapCodexPermissionMode(fellow.engineConfig?.permissionMode || fellow.agentPermissionMode || "default");
    const effectivePermission = typeof emit === "function"
      ? permission
      : { ...permission, approvalPolicy: "never" };
    const schedulerMcpSpec = (() => {
      try { return getSchedulerMcpSpec(); } catch { return null; }
    })();
    const miaAppMcpSpec = (() => {
      try { return getMiaAppMcpSpec({ fellowId: fellow.key, sessionId, originMessageId }); } catch { return null; }
    })();
    const mcpServers = {
      ...(miaAppMcpSpec ? { "mia-app": miaAppMcpSpec } : {}),
      ...(schedulerMcpSpec ? { "mia-scheduler": schedulerMcpSpec } : {})
    };
    const threadOptions = {
      workingDirectory: cwd(),
      skipGitRepoCheck: true,
      modelReasoningEffort: normalizeEffortLevel(fellow.engineConfig?.effortLevel || "medium", "codex"),
      ...effectivePermission
    };
    if (fellow.engineConfig?.model) threadOptions.model = String(fellow.engineConfig.model);
    const startedAtMs = Date.now();
    let turn;
    let capturedSessionId = externalSessionId;
    let transport = "codex-sdk";
    if (typeof emit === "function" && typeof runCodexAppServerTurn === "function") {
      transport = "codex-app-server";
      turn = await runCodexAppServerTurn({
        codexPath: commandPath,
        env,
        threadId: externalSessionId,
        prompt: promptWithGroup,
        options: threadOptions,
        signal,
        emit,
        permissionCoordinator,
        fellowKey: fellow.key,
        sessionId,
        mcpServers,
        appendLog: appendEngineLog
      });
      capturedSessionId = externalSessionId || turn?.threadId || "";
    } else {
      const { Codex } = await codexSdk();
      const codex = new Codex({
        codexPathOverride: commandPath,
        env
      });
      const thread = externalSessionId
        ? codex.resumeThread(externalSessionId, threadOptions)
        : codex.startThread(threadOptions);
      turn = await runCodexTurn(thread, promptWithGroup, { signal, emit });
      capturedSessionId = externalSessionId || thread.id || "";
    }
    const imagePaths = recentGeneratedImagePaths(capturedSessionId, { env, startedAtMs });
    if (capturedSessionId && !externalSessionId && shouldPersistAgentSession) {
      setAgentSessionId(engine, fellow.key, sessionId, capturedSessionId);
    }
    if (signal?.aborted) throw stoppedError();
    return chatCompletionResponse({
      id: capturedSessionId || `codex_${randomUUID()}`,
      model: "codex-cli",
      content: contentWithGeneratedImages(turn?.finalResponse, imagePaths),
      attachments: generatedImageAttachments(imagePaths),
      mia: {
        transport,
        engine,
        session_id: capturedSessionId || "",
        fellow_key: fellow.key
      }
    });
  }

  async function sendStateless({ systemPrompt, userPrompt, signal }) {
    const commandPath = shellCommandPath("codex");
    if (!commandPath) throw new Error("本机没有检测到 Codex CLI。请先安装并确认 `codex --version` 可用。");
    const { Codex } = await codexSdk();
    const codex = new Codex({
      codexPathOverride: commandPath,
      env: processEnvStrings()
    });
    const thread = codex.startThread({
      workingDirectory: cwd(),
      skipGitRepoCheck: true,
      modelReasoningEffort: normalizeEffortLevel("medium", "codex"),
      ...mapCodexPermissionMode("default"),
      approvalPolicy: "never"
    });
    const turn = await thread.run(statelessPrompt(systemPrompt, userPrompt), runOptions(signal));
    if (signal?.aborted) throw stoppedError();
    return { content: String(turn?.finalResponse || "").trim() };
  }

  return { sendChat, sendStateless };
}

module.exports = {
  createCodexChatAdapter,
  mapCodexPermissionMode
};
