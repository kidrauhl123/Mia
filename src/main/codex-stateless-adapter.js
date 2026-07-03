const path = require("node:path");
const os = require("node:os");
const {
  DEFAULT_CODEX_MIA_MODEL_CATALOG,
  codexMiaSessionConfigOverrides,
  writeCodexMiaModelCatalog
} = require("./codex-mia-runtime-config.js");

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

function runtimeConfigForContext(context = {}) {
  return {
    ...(context.bot?.engineConfig || context.bot?.engine_config || {}),
    ...(context.runtimeConfig && typeof context.runtimeConfig === "object" ? context.runtimeConfig : {})
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
  const resolveManagedModelRuntime = typeof deps.resolveManagedModelRuntime === "function"
    ? deps.resolveManagedModelRuntime
    : () => null;
  const codexMiaProxy = deps.codexMiaProxy || null;
  const codexModelCatalogPath = String(deps.codexModelCatalogPath || "").trim()
    || path.join(os.tmpdir(), DEFAULT_CODEX_MIA_MODEL_CATALOG);

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

  async function miaRuntimeForContext(context = {}) {
    const runtimeConfig = runtimeConfigForContext(context);
    const managedRuntime = resolveManagedModelRuntime(runtimeConfig, { engine: "codex" });
    if (!managedRuntime) return null;
    if (!codexMiaProxy || typeof codexMiaProxy.createSession !== "function") {
      throw new Error("Codex Mia proxy is not available.");
    }
    const session = await codexMiaProxy.createSession(managedRuntime);
    const baseUrl = String(session?.baseUrl || "").trim();
    const apiKey = String(session?.apiKey || "").trim();
    const model = String(session?.model || "").trim();
    if (!baseUrl || !apiKey || !model) {
      throw new Error("Codex Mia proxy did not return a usable session.");
    }
    const modelCatalogJson = writeCodexMiaModelCatalog(codexModelCatalogPath, model);
    return {
      apiKey,
      model,
      configOverrides: codexMiaSessionConfigOverrides(session, { modelCatalogJson })
    };
  }

  async function sendStateless(context = {}) {
    const { systemPrompt, userPrompt, signal } = context;
    const { runtime: codexRuntime, commandPath } = resolveCodexRuntimeCommand();
    if (!commandPath) throw new Error("本机没有检测到 Codex CLI。请先安装并确认 `codex --version` 可用。");
    let codexHomePath = "";
    try {
      codexHomePath = ensureCodexHome();
    } catch (error) {
      throw new Error(`Mia Codex home setup failed: ${error?.message || error}`);
    }
    if (!codexHomePath) throw new Error("Mia Codex home setup failed: missing CODEX_HOME.");
    const miaRuntime = await miaRuntimeForContext(context);
    const turn = await runCodexAppServerTurn({
      codexPath: commandPath,
      env: envForCodexRuntime({ ...processEnvStrings(), CODEX_HOME: codexHomePath }, codexRuntime, commandPath),
      baseUrl: "",
      apiKey: miaRuntime?.apiKey || "",
      prompt: statelessPrompt(systemPrompt, userPrompt),
      options: {
        workingDirectory: cwd(),
        skipGitRepoCheck: true,
        ...(miaRuntime?.model ? { model: miaRuntime.model } : {}),
        ...(miaRuntime?.configOverrides ? { configOverrides: miaRuntime.configOverrides } : {}),
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
