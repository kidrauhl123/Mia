const path = require("node:path");

const CODEX_MANAGED_PROTOCOLS = Object.freeze(["cli", "codex-cli", "codex-app-server"]);

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

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") throw new Error(`${key} dependency is required.`);
  return deps[key];
}

function envWithExecutableDirFirst(env = {}, executablePath = "") {
  const dir = path.dirname(String(executablePath || ""));
  if (!dir || dir === ".") return env || {};
  const currentPath = String(env?.PATH || env?.Path || "");
  const delimiter = process.platform === "win32" && !currentPath.includes(";") && !/^[A-Za-z]:[\\/]/.test(currentPath)
    ? ":"
    : process.platform === "win32" ? ";" : path.delimiter;
  const parts = currentPath.split(delimiter).filter(Boolean).filter((item) => item !== dir);
  return {
    ...(env || {}),
    PATH: [dir, ...parts].join(delimiter)
  };
}

function createCodexStatelessAdapter(deps = {}) {
  const shellCommandPath = requireDependency(deps, "shellCommandPath");
  const runCodexAppServerTurn = requireDependency(deps, "runCodexAppServerTurn");
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const normalizeEffortLevel = requireDependency(deps, "normalizeEffortLevel");
  const ensureCodexHome = requireDependency(deps, "ensureCodexHome");
  const cwd = deps.cwd || (() => process.cwd());
  const appendEngineLog = deps.appendEngineLog || (() => {});
  const resolveAgentRuntime = deps.resolveAgentRuntime || (() => null);
  const agentRuntimeEnv = deps.agentRuntimeEnv || null;

  function resolveCodexRuntimeCommand() {
    const runtime = resolveAgentRuntime("codex", { protocols: CODEX_MANAGED_PROTOCOLS });
    const commandPath = runtime?.path || shellCommandPath("codex");
    return { runtime, commandPath };
  }

  function envForCodexRuntime(baseEnv, runtime, commandPath) {
    if (runtime?.path && typeof agentRuntimeEnv === "function") {
      return agentRuntimeEnv("codex", baseEnv, { protocols: CODEX_MANAGED_PROTOCOLS });
    }
    return envWithExecutableDirFirst(baseEnv, commandPath);
  }

  async function sendStateless({ systemPrompt, userPrompt, signal }) {
    const { runtime: codexRuntime, commandPath } = resolveCodexRuntimeCommand();
    if (!commandPath) throw new Error("本机没有检测到 Codex CLI。请先安装并确认 `codex --version` 可用。");
    let codexHomePath = "";
    try {
      codexHomePath = ensureCodexHome();
    } catch (error) {
      throw new Error(`Mia Codex home setup failed: ${error?.message || error}`);
    }
    if (!codexHomePath) throw new Error("Mia Codex home setup failed: missing CODEX_HOME.");
    const turn = await runCodexAppServerTurn({
      codexPath: commandPath,
      env: envForCodexRuntime({ ...processEnvStrings(), CODEX_HOME: codexHomePath }, codexRuntime, commandPath),
      prompt: statelessPrompt(systemPrompt, userPrompt),
      options: {
        workingDirectory: cwd(),
        skipGitRepoCheck: true,
        modelReasoningEffort: normalizeEffortLevel("medium", "codex"),
        ...mapCodexPermissionMode("default"),
        approvalPolicy: "never"
      },
      signal,
      emit: null,
      permissionCoordinator: null,
      botKey: "stateless",
      sessionId: "",
      mcpServers: {},
      appendLog: appendEngineLog
    });
    if (signal?.aborted) throw stoppedError();
    return { content: String(turn?.finalResponse || "").trim() };
  }

  return { sendStateless };
}

module.exports = {
  createCodexStatelessAdapter,
  mapCodexPermissionMode
};
