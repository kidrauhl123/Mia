const crypto = require("node:crypto");

function mapCodexPermissionMode(value) {
  const id = String(value || "default").trim();
  if (id === "acceptEdits") return { sandboxMode: "workspace-write", approvalPolicy: "on-request" };
  if (id === "bypassPermissions") return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
  if (id === "readOnly") return { sandboxMode: "read-only", approvalPolicy: "on-request" };
  return { sandboxMode: "workspace-write", approvalPolicy: "untrusted" };
}

function statelessPrompt(systemPrompt, userPrompt) {
  return systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
}

function stoppedError() {
  const stopped = new Error("生成已停止");
  stopped.code = "AIMASHI_STOPPED";
  return stopped;
}

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") throw new Error(`${key} dependency is required.`);
  return deps[key];
}

function createCodexChatAdapter(deps = {}) {
  const shellCommandPath = requireDependency(deps, "shellCommandPath");
  const lastUserPrompt = requireDependency(deps, "lastUserPrompt");
  const expandLeadingSkillCommand = requireDependency(deps, "expandLeadingSkillCommand");
  const injectGroupContextForSdk = requireDependency(deps, "injectGroupContextForSdk");
  const readFellowPersona = requireDependency(deps, "readFellowPersona");
  const codexSdk = requireDependency(deps, "codexSdk");
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const normalizeEffortLevel = requireDependency(deps, "normalizeEffortLevel");
  const getAgentSessionId = requireDependency(deps, "getAgentSessionId");
  const setAgentSessionId = requireDependency(deps, "setAgentSessionId");
  const chatCompletionResponse = requireDependency(deps, "chatCompletionResponse");
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const cwd = deps.cwd || (() => process.cwd());

  async function sendChat({ fellow, sessionId, messages, group, signal, utility = false }) {
    const engine = "codex";
    const commandPath = shellCommandPath("codex");
    if (!commandPath) throw new Error("本机没有检测到 Codex CLI。请先安装并确认 `codex --version` 可用。");
    const externalSessionId = utility ? "" : getAgentSessionId(engine, fellow.key, sessionId);
    const lastUser = lastUserPrompt(messages);
    const userText = expandLeadingSkillCommand(lastUser, { mode: "inline" }) || lastUser;
    const persona = !externalSessionId
      ? readFellowPersona(fellow.key, fellow.name, fellow.bio).trim()
      : "";
    const prompt = persona
      ? [
          "以下是 Aimashi 给当前 Fellow 的人设，请在本次对话中遵守：",
          "",
          persona,
          "",
          "用户消息：",
          userText
        ].join("\n")
      : userText;
    const promptWithGroup = group && group.contextBlock
      ? injectGroupContextForSdk(prompt, group.contextBlock)
      : prompt;
    const { Codex } = await codexSdk();
    const codex = new Codex({
      codexPathOverride: commandPath,
      env: processEnvStrings()
    });
    const permission = mapCodexPermissionMode(fellow.engineConfig?.permissionMode || fellow.agentPermissionMode || "default");
    const threadOptions = {
      workingDirectory: cwd(),
      skipGitRepoCheck: true,
      modelReasoningEffort: normalizeEffortLevel(fellow.engineConfig?.effortLevel || "medium", "codex"),
      ...permission
    };
    if (fellow.engineConfig?.model) threadOptions.model = String(fellow.engineConfig.model);
    const thread = externalSessionId
      ? codex.resumeThread(externalSessionId, threadOptions)
      : codex.startThread(threadOptions);
    const turn = await thread.run(promptWithGroup, { signal });
    const capturedSessionId = externalSessionId || thread.id || "";
    if (capturedSessionId && !externalSessionId && !utility) {
      setAgentSessionId(engine, fellow.key, sessionId, capturedSessionId);
    }
    if (signal?.aborted) throw stoppedError();
    return chatCompletionResponse({
      id: capturedSessionId || `codex_${randomUUID()}`,
      model: "codex-cli",
      content: String(turn?.finalResponse || "").trim(),
      aimashi: {
        transport: "codex-sdk",
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
      ...mapCodexPermissionMode("default")
    });
    const turn = await thread.run(statelessPrompt(systemPrompt, userPrompt), { signal });
    if (signal?.aborted) throw stoppedError();
    return { content: String(turn?.finalResponse || "").trim() };
  }

  return { sendChat, sendStateless };
}

module.exports = {
  createCodexChatAdapter,
  mapCodexPermissionMode
};
