const fs = require("node:fs");
const path = require("node:path");
const { execFile: execFileCb } = require("node:child_process");
const { promisify } = require("node:util");

const CONTAINER_ENV = Object.freeze({
  HERMES_HOME: "/data/hermes-home",
  HOME: "/data/home",
  TERMINAL_CWD: "/data/workspace",
  HERMES_WRITE_SAFE_ROOT: "/data/workspace"
});

const MODEL_API_KEY_ENV = "MIA_CLOUD_AGENT_MODEL_API_KEY";

function atomicWriteFile(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, { mode });
  fs.renameSync(tmpPath, filePath);
}

function assertSafeUserId(userId) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("userId required");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("unsafe userId for cloud agent path");
  return id;
}

function createHermesWorkerManager(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.env.MIA_CLOUD_AGENT_ROOT || "/var/lib/mia-cloud-agent-users");
  const mode = options.mode || process.env.MIA_CLOUD_AGENT_MODE || "disabled";
  const staticBaseUrl = options.staticBaseUrl || process.env.MIA_CLOUD_HERMES_BASE_URL || "";
  const apiKey = options.apiKey || process.env.MIA_CLOUD_HERMES_API_KEY || "mia-cloud";
  const image = options.image || process.env.MIA_CLOUD_HERMES_IMAGE || "";
  const dockerNetwork = String(options.dockerNetwork || process.env.MIA_CLOUD_AGENT_DOCKER_NETWORK || "bridge").trim() || "bridge";
  const dockerBin = options.dockerBin || process.env.MIA_DOCKER_BIN || "docker";
  const execFile = options.execFile || promisify(execFileCb);
  const containerPort = Number(options.containerPort || process.env.MIA_CLOUD_HERMES_CONTAINER_PORT || 8765);
  const modelProvider = String(options.modelProvider || process.env.MIA_CLOUD_AGENT_MODEL_PROVIDER || "mia-litellm").trim();
  const model = String(options.model || process.env.MIA_CLOUD_AGENT_MODEL || "mia-default").trim();
  const modelBaseUrl = String(options.modelBaseUrl || process.env.MIA_CLOUD_AGENT_MODEL_BASE_URL || "http://litellm:4000/v1").trim();
  const modelApiMode = String(options.modelApiMode || process.env.MIA_CLOUD_AGENT_MODEL_API_MODE || "chat_completions").trim();
  const modelApiKey = String(options.modelApiKey || process.env[MODEL_API_KEY_ENV] || process.env.MIA_LITELLM_API_KEY || "").trim();
  const modelProviderName = String(options.modelProviderName || process.env.MIA_CLOUD_AGENT_MODEL_PROVIDER_NAME || "Mia LiteLLM").trim();
  const fetchImpl = options.fetch || fetch;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const healthTimeoutMs = Number(options.healthTimeoutMs ?? process.env.MIA_CLOUD_HERMES_START_TIMEOUT_MS ?? 45000);

  function pathsForUser(userId) {
    const id = assertSafeUserId(userId);
    const root = path.join(rootDir, id);
    return {
      userId: id,
      root,
      hermesHome: path.join(root, "hermes-home"),
      home: path.join(root, "home"),
      workspace: path.join(root, "workspace"),
      attachments: path.join(root, "attachments"),
      logs: path.join(root, "logs")
    };
  }

  function envForUser(userId) {
    assertSafeUserId(userId);
    const env = {
      ...CONTAINER_ENV,
      HERMES_ACCEPT_HOOKS: "1",
      GATEWAY_ALLOW_ALL_USERS: "true",
      PYTHONUNBUFFERED: "1",
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "0.0.0.0",
      API_SERVER_PORT: String(containerPort),
      API_SERVER_KEY: apiKey
    };
    if (modelApiKey) env[MODEL_API_KEY_ENV] = modelApiKey;
    return env;
  }

  function renderHermesConfig() {
    const lines = [
      "model:",
      `  provider: ${JSON.stringify(modelProvider)}`,
      `  default: ${JSON.stringify(model)}`,
      `  base_url: ${JSON.stringify(modelBaseUrl)}`,
      `  api_mode: ${JSON.stringify(modelApiMode)}`,
      "",
      "providers:",
      `  ${JSON.stringify(modelProvider)}:`,
      `    name: ${JSON.stringify(modelProviderName || modelProvider)}`,
      `    base_url: ${JSON.stringify(modelBaseUrl)}`,
      `    key_env: ${JSON.stringify(MODEL_API_KEY_ENV)}`,
      `    default_model: ${JSON.stringify(model)}`,
      `    api_mode: ${JSON.stringify(modelApiMode)}`,
      "",
      "platforms:",
      "  api_server:",
      "    enabled: true",
      "    host: 0.0.0.0",
      `    port: ${containerPort}`,
      `    key: ${apiKey}`,
      "  feishu:",
      "    enabled: false",
      "  telegram:",
      "    enabled: false",
      "  discord:",
      "    enabled: false",
      "",
      "approvals:",
      "  mode: \"yolo\"",
      "  timeout: 60",
      "",
      "agent:",
      "  reasoning_effort: \"medium\"",
      "",
      "mia:",
      "  runtime_schema: 1",
      ""
    ];
    return `${lines.join("\n")}`;
  }

  function writeHermesConfig(paths) {
    atomicWriteFile(path.join(paths.hermesHome, "config.yaml"), renderHermesConfig(), 0o600);
  }

  function ensureUserDirs(userId) {
    const paths = pathsForUser(userId);
    for (const dir of [paths.root, paths.hermesHome, paths.home, paths.workspace, paths.attachments, paths.logs]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeHermesConfig(paths);
    return paths;
  }

  async function ensureWorker(userId) {
    const paths = ensureUserDirs(userId);
    if (mode === "static" && staticBaseUrl) {
      return { userId: paths.userId, baseUrl: staticBaseUrl.replace(/\/+$/, ""), apiKey, paths, env: envForUser(userId) };
    }
    if (mode === "docker") {
      return ensureDockerWorker(paths);
    }
    if (mode === "disabled") {
      throw new Error("Cloud Hermes worker is not configured. Set MIA_CLOUD_AGENT_MODE=static and MIA_CLOUD_HERMES_BASE_URL, or configure a container worker.");
    }
    throw new Error(`Unsupported cloud Hermes worker mode: ${mode}`);
  }

  function containerName(userId) {
    return `mia-hermes-${assertSafeUserId(userId)}`;
  }

  async function docker(args) {
    return execFile(dockerBin, args, { windowsHide: true });
  }

  async function dockerRunning(name) {
    try {
      const out = await docker(["inspect", "-f", "{{.State.Running}}", name]);
      return String(out.stdout || "").trim() === "true";
    } catch {
      return false;
    }
  }

  async function dockerPort(name) {
    const out = await docker(["port", name, `${containerPort}/tcp`]);
    const line = String(out.stdout || "").trim().split(/\n/).find(Boolean) || "";
    const match = line.match(/127\.0\.0\.1:(\d+)$/) || line.match(/0\.0\.0\.0:(\d+)$/);
    if (!match) throw new Error(`Could not resolve Docker host port for ${name}.`);
    return Number(match[1]);
  }

  async function waitForHealth(baseUrl) {
    if (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs <= 0) return;
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < healthTimeoutMs) {
      try {
        const response = await fetchImpl(`${baseUrl}/health`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
        });
        if (response.ok) return;
        lastError = new Error(`health returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    throw new Error(`Timed out waiting for cloud Hermes worker at ${baseUrl}: ${lastError?.message || "not ready"}`);
  }

  async function ensureDockerWorker(paths) {
    if (!image) throw new Error("MIA_CLOUD_HERMES_IMAGE is required for docker cloud Hermes workers.");
    const name = containerName(paths.userId);
    const running = await dockerRunning(name);
    if (!running) {
      const env = envForUser(paths.userId);
      await docker([
        "run",
        "-d",
        "--rm",
        "--name", name,
        "--network", dockerNetwork,
        "--read-only",
        "--cpus=1",
        "--memory=1024m",
        "--pids-limit=256",
        "--security-opt", "no-new-privileges",
        "-p", `127.0.0.1::${containerPort}`,
        "--mount", `type=bind,src=${paths.root},dst=/data`,
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        "--env", `HERMES_HOME=${env.HERMES_HOME}`,
        "--env", `HOME=${env.HOME}`,
        "--env", `TERMINAL_CWD=${env.TERMINAL_CWD}`,
        "--env", `HERMES_WRITE_SAFE_ROOT=${env.HERMES_WRITE_SAFE_ROOT}`,
        "--env", `HERMES_ACCEPT_HOOKS=${env.HERMES_ACCEPT_HOOKS}`,
        "--env", `GATEWAY_ALLOW_ALL_USERS=${env.GATEWAY_ALLOW_ALL_USERS}`,
        "--env", `PYTHONUNBUFFERED=${env.PYTHONUNBUFFERED}`,
        "--env", `API_SERVER_ENABLED=${env.API_SERVER_ENABLED}`,
        "--env", `API_SERVER_HOST=${env.API_SERVER_HOST}`,
        "--env", `API_SERVER_PORT=${env.API_SERVER_PORT}`,
        "--env", `API_SERVER_KEY=${env.API_SERVER_KEY}`,
        ...(env[MODEL_API_KEY_ENV] ? ["--env", `${MODEL_API_KEY_ENV}=${env[MODEL_API_KEY_ENV]}`] : []),
        image
      ]);
    }
    const port = await dockerPort(name);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);
    return {
      userId: paths.userId,
      baseUrl,
      apiKey,
      paths,
      env: envForUser(paths.userId),
      containerName: name
    };
  }

  return { pathsForUser, envForUser, ensureUserDirs, ensureWorker, containerName };
}

module.exports = { createHermesWorkerManager };
