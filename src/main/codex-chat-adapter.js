const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  appendMiaMemoryBlock,
  miaRuntimeSystemPrompt,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
} = require("./mia-runtime-context.js");
const {
  createWorkspaceDiffTracker,
  fileEditPayloadFromUnifiedDiff
} = require("./agent-file-edit-events.js");

function mapCodexPermissionMode(value) {
  const id = String(value || "default").trim();
  if (id === ":read-only") {
    return { permissionProfile: ":read-only", sandboxMode: "read-only", approvalPolicy: "never" };
  }
  if (id === ":workspace") {
    return { permissionProfile: ":workspace", sandboxMode: "workspace-write", approvalPolicy: "never" };
  }
  if (id === ":danger-full-access") {
    return { permissionProfile: ":danger-full-access", sandboxMode: "danger-full-access", approvalPolicy: "never" };
  }
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

function envWithExecutableDirFirst(env = {}, executablePath = "") {
  const dir = path.dirname(String(executablePath || ""));
  if (!dir || dir === ".") return env || {};
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  const currentPath = String(env?.PATH || env?.Path || "");
  const parts = currentPath.split(delimiter).filter(Boolean).filter((item) => item !== dir);
  return {
    ...(env || {}),
    PATH: [dir, ...parts].join(delimiter)
  };
}

const MAX_FILE_DIFF_PREVIEW = 20000;

function safeWorkspaceRelativePath(filePath, workingDirectory = "") {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  const root = String(workingDirectory || "").trim();
  const rel = path.isAbsolute(raw) && root ? path.relative(root, raw) : raw;
  const normalized = rel.split(path.sep).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.isAbsolute(normalized)) return "";
  return normalized;
}

function diffStats(diff = "") {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function readGitDiffForPath(filePath, workingDirectory = "") {
  const rel = safeWorkspaceRelativePath(filePath, workingDirectory);
  if (!rel || !workingDirectory) return "";
  try {
    return execFileSync("git", ["diff", "--no-ext-diff", "--unified=80", "--", rel], {
      cwd: workingDirectory,
      encoding: "utf8",
      maxBuffer: 512 * 1024,
      timeout: 3000
    });
  } catch (error) {
    return String(error?.stdout || "");
  }
}

function syntheticAddedFileDiff(filePath, workingDirectory = "") {
  const rel = safeWorkspaceRelativePath(filePath, workingDirectory);
  if (!rel || !workingDirectory) return "";
  const abs = path.join(workingDirectory, rel);
  let content = "";
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 256 * 1024) return "";
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    "diff --git a/dev/null b/" + rel,
    "--- /dev/null",
    "+++ b/" + rel,
    "@@",
    body
  ].join("\n");
}

function defaultDescribeFileChange(change = {}, options = {}) {
  const workingDirectory = options.workingDirectory || "";
  const rel = safeWorkspaceRelativePath(change.path, workingDirectory) || String(change.path || "").trim() || "file";
  const kind = String(change.kind || "update");
  const verb = kind === "add" ? "Added" : kind === "delete" ? "Deleted" : "Edited";
  let diff = readGitDiffForPath(rel, workingDirectory);
  if (!diff && kind === "add") diff = syntheticAddedFileDiff(rel, workingDirectory);
  const stats = diffStats(diff);
  const statText = stats.additions || stats.deletions ? ` (+${stats.additions} -${stats.deletions})` : "";
  const preview = diff.length > MAX_FILE_DIFF_PREVIEW
    ? `${diff.slice(0, MAX_FILE_DIFF_PREVIEW)}\n… diff truncated …`
    : diff;
  return {
    name: `${verb} ${rel}${statText}`,
    preview,
    additions: stats.additions,
    deletions: stats.deletions
  };
}

function emitCodexFileChangeEvents(emit, event, options = {}) {
  if (typeof emit !== "function" || event?.type !== "item.completed") return;
  const item = event.item;
  if (!item || item.type !== "file_change") return;
  const changes = Array.isArray(item.changes) ? item.changes : [];
  for (let idx = 0; idx < changes.length; idx += 1) {
    const change = changes[idx] || {};
    const id = `${String(item.id || "file_change")}_${idx}`;
    const describe = typeof options.describeFileChange === "function"
      ? options.describeFileChange
      : defaultDescribeFileChange;
    const description = describe(change, {
      workingDirectory: options.workingDirectory || ""
    }) || {};
    const error = item.status === "failed";
    const filePath = safeWorkspaceRelativePath(change.path, options.workingDirectory || "")
      || String(change.path || "").trim();
    const payload = fileEditPayloadFromUnifiedDiff(description.diff || description.preview || "", {
      id,
      path: filePath,
      action: change.kind,
      title: description.title || description.name,
      additions: description.additions,
      deletions: description.deletions,
      status: error ? "failed" : "completed",
      error
    });
    if (payload) emit("file_edit", payload);
  }
}

function emitWorkspaceFileEdits(emit, tracker, item = {}) {
  if (typeof emit !== "function" || !tracker || typeof tracker.collect !== "function") return;
  const error = item.status === "failed";
  for (const payload of tracker.collect({
    idPrefix: String(item.id || "command"),
    status: error ? "failed" : "completed",
    error
  })) {
    emit("file_edit", payload);
  }
}

function emitCodexItemEvent(emit, event, textByItem, options = {}) {
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
    if (event.type === "item.completed") {
      emit("tool_call_completed", payload);
      emitWorkspaceFileEdits(emit, options.workspaceDiffTracker, item);
    }
    return;
  }
  emitCodexFileChangeEvents(emit, event, options);
}

async function runCodexTurn(thread, prompt, { signal = null, emit = null, workingDirectory = "", describeFileChange = null } = {}) {
  if (typeof emit !== "function" || typeof thread.runStreamed !== "function") {
    return thread.run(prompt, runOptions(signal));
  }
  const { events } = await thread.runStreamed(prompt, runOptions(signal));
  const items = [];
  const textByItem = new Map();
  const workspaceDiffTracker = createWorkspaceDiffTracker(workingDirectory);
  let finalResponse = "";
  let usage = null;
  for await (const event of events) {
    if (event.type === "thread.started") {
      emit("session_started", { sessionId: event.thread_id });
    } else if (event.type === "turn.started") {
      emit("status", { text: "本机 Codex 已开始运行。" });
    } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      emitCodexItemEvent(emit, event, textByItem, { workingDirectory, describeFileChange, workspaceDiffTracker });
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
  const readBotPersona = requireDependency(deps, "readBotPersona");
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
  const resolveManagedModelRuntime = deps.resolveManagedModelRuntime || (() => null);
  const permissionCoordinator = deps.permissionCoordinator || null;
  const appendEngineLog = deps.appendEngineLog || (() => {});
  const enginePermissionMode = deps.enginePermissionMode || (() => "default");
  const describeFileChange = deps.describeFileChange || null;
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const cwd = deps.cwd || (() => process.cwd());

  async function sendChat({ bot, sessionId, messages, group, signal, emit = null, utility = false, scheduledFire = false, persistAgentSession = !utility }) {
    const engine = "codex";
    const shouldPersistAgentSession = Boolean(persistAgentSession);
    const commandPath = shellCommandPath("codex");
    if (!commandPath) throw new Error("本机没有检测到 Codex CLI。请先安装并确认 `codex --version` 可用。");
    const externalSessionId = shouldPersistAgentSession ? getAgentSessionId(engine, bot.key, sessionId) : "";
    const lastUser = lastUserPrompt(messages);
    // Best-effort: grab id from last user message for scheduler context
    const lastUserMessage = Array.isArray(messages) ? [...messages].reverse().find((m) => m?.role === "user") : null;
    const originMessageId = String(lastUserMessage?.id || "");
    try {
      writeSchedulerMcpContext({ botId: bot.key, sessionId, originMessageId });
    } catch {
      // Non-fatal; scheduler MCP context missing means tool works without context defaults
    }
    const miaMemory = memoryBlock({ botId: bot.key, sessionId });
    const runtimeContext = externalSessionId && (!utility || group) ? miaRuntimeSystemPrompt({ scheduledFire }) : "";
    const runtimeInstructions = !externalSessionId ? runtimeContext : appendMiaMemoryBlock(runtimeContext, miaMemory);
    const expandedPrompt = sanitizeMiaMemorySpoof(expandLeadingSkillCommand(lastUser, { mode: "inline" }) || lastUser);
    const userText = [runtimeInstructions, buildEnabledSkillsContext(bot), expandedPrompt]
      .filter(Boolean)
      .join("\n\n");
    const persona = !externalSessionId
      ? appendMiaMemoryBlock(
          withMiaRuntimeContext(readBotPersona(bot.key, bot.name, bot.bio), { scheduledFire }),
          miaMemory
        ).trim()
      : "";
    const prompt = (() => {
      if (!persona) return userText;
      const sections = [];
      sections.push([
        "以下是 Mia 给当前 Bot 的人设，请在本次对话中遵守：",
        "",
        persona
      ].join("\n"));
      sections.push(["用户消息：", userText].join("\n"));
      return sections.join("\n\n");
    })();
    const promptWithGroup = group && group.contextBlock
      ? injectGroupContextForSdk(prompt, group.contextBlock)
      : prompt;
    const codexPrompt = promptWithGroup;
    const baseEnv = processEnvStrings();
    let codexHomePath = "";
    try {
      codexHomePath = ensureCodexHome();
    } catch (error) {
      throw new Error(`Mia Codex home setup failed: ${error?.message || error}`);
    }
    if (!codexHomePath) throw new Error("Mia Codex home setup failed: missing CODEX_HOME.");
    const env = envWithExecutableDirFirst({ ...baseEnv, CODEX_HOME: codexHomePath }, commandPath);
    const managedModel = resolveManagedModelRuntime(bot.engineConfig || {}, { engine: "codex", bot });
    const permission = mapCodexPermissionMode(enginePermissionMode("codex") || "default");
    const effectivePermission = typeof emit === "function"
      ? permission
      : { ...permission, approvalPolicy: "never" };
    const schedulerMcpSpec = (() => {
      try { return getSchedulerMcpSpec(); } catch { return null; }
    })();
    const miaAppMcpSpec = (() => {
      try { return getMiaAppMcpSpec({ botId: bot.key, sessionId, originMessageId }); } catch { return null; }
    })();
    const mcpServers = {
      ...(miaAppMcpSpec ? { "mia-app": miaAppMcpSpec } : {}),
      ...(schedulerMcpSpec ? { "mia-scheduler": schedulerMcpSpec } : {})
    };
    const threadOptions = {
      workingDirectory: cwd(),
      skipGitRepoCheck: true,
      modelReasoningEffort: normalizeEffortLevel(bot.engineConfig?.effortLevel || "medium", "codex"),
      ...effectivePermission
    };
    if (managedModel?.model || bot.engineConfig?.model) threadOptions.model = String(managedModel?.model || bot.engineConfig.model);
    const startedAtMs = Date.now();
    let turn;
    let capturedSessionId = externalSessionId;
    let transport = "codex-sdk";
    if (typeof emit === "function" && typeof runCodexAppServerTurn === "function") {
      transport = "codex-app-server";
      turn = await runCodexAppServerTurn({
        codexPath: commandPath,
        env,
        baseUrl: managedModel?.baseUrl || "",
        apiKey: managedModel?.apiKey || "",
        threadId: externalSessionId,
        prompt: codexPrompt,
        options: threadOptions,
        signal,
        emit,
        permissionCoordinator,
        botKey: bot.key,
        sessionId,
        mcpServers,
        appendLog: appendEngineLog
      });
      capturedSessionId = externalSessionId || turn?.threadId || "";
    } else {
      const { Codex } = await codexSdk();
      const codex = new Codex({
        codexPathOverride: commandPath,
        env,
        ...(managedModel?.baseUrl ? { baseUrl: managedModel.baseUrl } : {}),
        ...(managedModel?.apiKey ? { apiKey: managedModel.apiKey } : {})
      });
      const thread = externalSessionId
        ? codex.resumeThread(externalSessionId, threadOptions)
        : codex.startThread(threadOptions);
      turn = await runCodexTurn(thread, codexPrompt, {
        signal,
        emit,
        workingDirectory: cwd(),
        describeFileChange
      });
      capturedSessionId = externalSessionId || thread.id || "";
    }
    const imagePaths = recentGeneratedImagePaths(capturedSessionId, { env, startedAtMs });
    if (capturedSessionId && !externalSessionId && shouldPersistAgentSession) {
      setAgentSessionId(engine, bot.key, sessionId, capturedSessionId);
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
        bot_id: bot.key
      }
    });
  }

  async function sendStateless({ systemPrompt, userPrompt, signal }) {
    const commandPath = shellCommandPath("codex");
    if (!commandPath) throw new Error("本机没有检测到 Codex CLI。请先安装并确认 `codex --version` 可用。");
    let codexHomePath = "";
    try {
      codexHomePath = ensureCodexHome();
    } catch (error) {
      throw new Error(`Mia Codex home setup failed: ${error?.message || error}`);
    }
    if (!codexHomePath) throw new Error("Mia Codex home setup failed: missing CODEX_HOME.");
    const { Codex } = await codexSdk();
    const codex = new Codex({
      codexPathOverride: commandPath,
      env: envWithExecutableDirFirst({ ...processEnvStrings(), CODEX_HOME: codexHomePath }, commandPath)
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
