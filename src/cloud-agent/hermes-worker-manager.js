const fs = require("node:fs");
const path = require("node:path");
const { execFile: execFileCb } = require("node:child_process");
const { promisify } = require("node:util");
const { createUserModelProxyToken } = require("../cloud/model-proxy-auth.js");
const { normalizeCloudHermesModel } = require("./cloud-hermes-model.js");

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

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function gatewayWsUrlForBaseUrl(baseUrl, apiKey, wsPath = "/api/ws") {
  const cleanedBaseUrl = cleanBaseUrl(baseUrl);
  if (!cleanedBaseUrl) return "";
  const url = new URL(cleanedBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = wsPath;
  url.search = "";
  if (apiKey) url.searchParams.set("token", apiKey);
  return url.toString();
}

function renderHermesGatewayShim() {
  return `from typing import Optional
from fastapi import FastAPI, Header, WebSocket, WebSocketException, status
from tui_gateway.ws import handle_ws as gateway_handle_ws
import os

app = FastAPI()


def _expected_token():
    return (os.environ.get("MIA_HERMES_GATEWAY_TOKEN") or os.environ.get("API_SERVER_KEY") or "").strip()


def _extract_token(websocket: WebSocket, authorization: Optional[str] = None):
    token = (websocket.query_params.get("token") or "").strip()
    if token:
        return token
    bearer = (authorization or "").strip()
    if bearer.lower().startswith("bearer "):
        return bearer[7:].strip()
    return ""


def _ensure_authorized(token: str):
    expected = _expected_token()
    if expected and token != expected:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)


@app.get("/health")
async def health():
    return {"ok": True, "transport": "tui_gateway"}


@app.websocket("/api/ws")
async def handle_ws(websocket: WebSocket, authorization: Optional[str] = Header(default=None, alias="Authorization")):
    _ensure_authorized(_extract_token(websocket, authorization))
    await gateway_handle_ws(websocket)
`;
}

function createHermesWorkerManager(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.env.MIA_CLOUD_AGENT_ROOT || "/var/lib/mia-cloud-agent-users");
  const mode = options.mode || process.env.MIA_CLOUD_AGENT_MODE || "disabled";
  const staticBaseUrl = options.staticBaseUrl || process.env.MIA_CLOUD_HERMES_BASE_URL || "";
  const apiKey = options.apiKey || process.env.MIA_CLOUD_HERMES_API_KEY || "mia-cloud";
  const gatewayWsUrl = String(options.gatewayWsUrl || process.env.MIA_CLOUD_HERMES_GATEWAY_WS_URL || "").trim();
  const image = options.image || process.env.MIA_CLOUD_HERMES_IMAGE || "";
  const dockerNetwork = String(options.dockerNetwork || process.env.MIA_CLOUD_AGENT_DOCKER_NETWORK || "bridge").trim() || "bridge";
  const dockerBin = options.dockerBin || process.env.MIA_DOCKER_BIN || "docker";
  const execFile = options.execFile || promisify(execFileCb);
  const containerPort = Number(options.containerPort || process.env.MIA_CLOUD_HERMES_CONTAINER_PORT || 8765);
  const internalModelProxyKey = String(options.internalModelProxyKey || process.env.MIA_CLOUD_INTERNAL_MODEL_PROXY_KEY || "").trim();
  const publicUrl = cleanBaseUrl(options.publicUrl || process.env.MIA_CLOUD_PUBLIC_URL || "");
  const internalModelBaseUrl = cleanBaseUrl(
    options.internalModelBaseUrl
      || process.env.MIA_INTERNAL_MODEL_BASE_URL
      || (internalModelProxyKey && publicUrl
        ? `${publicUrl}/api/internal/model-proxy/v1`
        : "")
  );
  const internalTasksUrl = internalModelProxyKey && publicUrl ? `${publicUrl}/api/internal/tasks` : "";
  const modelProvider = String(options.modelProvider || process.env.MIA_CLOUD_AGENT_MODEL_PROVIDER || "mia").trim();
  const model = normalizeCloudHermesModel(
    options.model ?? process.env.MIA_CLOUD_AGENT_MODEL ?? "mia-auto",
    { defaultModel: "mia-auto" }
  );
  const modelBaseUrl = String(options.modelBaseUrl || internalModelBaseUrl || process.env.MIA_CLOUD_AGENT_MODEL_BASE_URL || "http://litellm:4000/v1").trim();
  const usesInternalModelProxy = Boolean(internalModelProxyKey && /\/api\/internal\/model-proxy\/v1\/?$/.test(cleanBaseUrl(modelBaseUrl)));
  const modelApiMode = String(options.modelApiMode || process.env.MIA_CLOUD_AGENT_MODEL_API_MODE || "chat_completions").trim();
  const modelApiKey = String(options.modelApiKey || process.env[MODEL_API_KEY_ENV] || process.env.MIA_LITELLM_API_KEY || "").trim();
  const modelProviderName = String(options.modelProviderName || process.env.MIA_CLOUD_AGENT_MODEL_PROVIDER_NAME || "Mia").trim();
  const fetchImpl = options.fetch || fetch;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const healthTimeoutMs = Number(options.healthTimeoutMs ?? process.env.MIA_CLOUD_HERMES_START_TIMEOUT_MS ?? 45000);
  // Approval mode for the worker's command guard. "ask" surfaces dangerous
  // commands as approval.request events over the gateway stream consumed by
  // the dispatcher and shown as a web permission banner. Overridable so ops can
  // fall back to "yolo" without a code change if a run path misbehaves.
  const approvalsMode = String(options.approvalsMode || process.env.MIA_CLOUD_HERMES_APPROVALS_MODE || "ask").trim() || "ask";

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
    const safeUserId = assertSafeUserId(userId);
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
    const userModelApiKey = usesInternalModelProxy
      ? createUserModelProxyToken(internalModelProxyKey, safeUserId)
      : modelApiKey;
    if (userModelApiKey) env[MODEL_API_KEY_ENV] = userModelApiKey;
    return env;
  }

  function renderWebSearchMcpServerConfig() {
    return [
      "  mia-web-search:",
      "    command: \"python\"",
      "    args:",
      "      - \"-m\"",
      "      - \"mia_plugins.web_search_mcp\""
    ];
  }

  function renderSchedulerMcpServerConfig(userId) {
    const token = createUserModelProxyToken(internalModelProxyKey, userId);
    if (!internalTasksUrl || !token) return [];
    return [
      "  mia-scheduler:",
      "    command: \"python\"",
      "    args:",
      "      - \"-m\"",
      "      - \"mia_plugins.scheduler_mcp\"",
      "    env:",
      `      MIA_CLOUD_TASKS_URL: ${JSON.stringify(internalTasksUrl)}`,
      `      MIA_CLOUD_TASKS_TOKEN: ${JSON.stringify(token)}`,
      "      MIA_SCHEDULER_CONTEXT_FILE: \"/data/hermes-home/mia-scheduler-context.json\""
    ];
  }

  function renderMcpConfig(userId) {
    const servers = [
      ...renderWebSearchMcpServerConfig(),
      ...renderSchedulerMcpServerConfig(userId)
    ];
    return servers.length ? ["mcp_servers:", ...servers, ""] : [];
  }

  function renderHermesConfig(userId = "") {
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
      `  mode: ${JSON.stringify(approvalsMode)}`,
      "  timeout: 60",
      "",
      "agent:",
      "  reasoning_effort: \"medium\"",
      "  disabled_toolsets:",
      "    - cronjob",
      "",
      ...renderMcpConfig(userId),
      "mia:",
      "  runtime_schema: 1",
      ""
    ];
    return `${lines.join("\n")}`;
  }

  function writeHermesConfig(paths) {
    atomicWriteFile(path.join(paths.hermesHome, "config.yaml"), renderHermesConfig(paths.userId), 0o600);
  }

  function writeGatewayShim(paths) {
    atomicWriteFile(path.join(paths.hermesHome, "mia-hermes-gateway-server.py"), renderHermesGatewayShim(), 0o600);
  }

  function ensureUserDirs(userId) {
    const paths = pathsForUser(userId);
    for (const dir of [paths.root, paths.hermesHome, paths.home, paths.workspace, paths.attachments, paths.logs]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeHermesConfig(paths);
    writeGatewayShim(paths);
    return paths;
  }

  async function ensureWorker(userId) {
    const paths = ensureUserDirs(userId);
    if (mode === "static" && staticBaseUrl) {
      const baseUrl = staticBaseUrl.replace(/\/+$/, "");
      return {
        userId: paths.userId,
        baseUrl,
        gatewayWsUrl: gatewayWsUrl || gatewayWsUrlForBaseUrl(baseUrl, apiKey),
        apiKey,
        model,
        modelProvider,
        modelApiMode,
        paths,
        env: envForUser(userId)
      };
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

  async function dockerInspectState(name) {
    try {
      const out = await docker(["inspect", "-f", "{{.State.Running}}\t{{.State.Status}}", name]);
      const [running, status] = String(out.stdout || "").trim().split(/\s+/, 2);
      return {
        exists: true,
        running: running === "true",
        status: status || ""
      };
    } catch {
      return { exists: false, running: false, status: "" };
    }
  }

  function isDockerNameConflict(error) {
    const text = [
      error?.message,
      error?.stderr,
      error?.stdout
    ].filter(Boolean).join("\n");
    return /container name/i.test(text) && /already in use/i.test(text);
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
    const state = await dockerInspectState(name);
    if (state.exists && !state.running) {
      await docker(["rm", "-f", name]);
    }
    if (!state.running) {
      try {
        await startDockerContainer(paths, name);
      } catch (error) {
        if (!isDockerNameConflict(error)) throw error;
        const conflictState = await dockerInspectState(name);
        if (!conflictState.exists) {
          await startDockerContainer(paths, name);
        } else if (!conflictState.running) {
          await docker(["rm", "-f", name]);
          await startDockerContainer(paths, name);
        }
      }
    }
    const port = await dockerPort(name);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);
    return {
      userId: paths.userId,
      baseUrl,
      gatewayWsUrl: gatewayWsUrl || gatewayWsUrlForBaseUrl(baseUrl, apiKey),
      apiKey,
      model,
      modelProvider,
      modelApiMode,
      paths,
      env: envForUser(paths.userId),
      containerName: name
    };
  }

  async function startDockerContainer(paths, name) {
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
      image,
      "python",
      "/data/hermes-home/mia-hermes-gateway-server.py"
    ]);
  }

  return { pathsForUser, envForUser, ensureUserDirs, ensureWorker, containerName };
}

module.exports = { createHermesWorkerManager };
