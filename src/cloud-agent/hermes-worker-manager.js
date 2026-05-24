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

function assertSafeUserId(userId) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("userId required");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("unsafe userId for cloud agent path");
  return id;
}

function createHermesWorkerManager(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.env.AIMASHI_CLOUD_AGENT_ROOT || "/opt/aimashi-cloud/agent-users");
  const mode = options.mode || process.env.AIMASHI_CLOUD_AGENT_MODE || "disabled";
  const staticBaseUrl = options.staticBaseUrl || process.env.AIMASHI_CLOUD_HERMES_BASE_URL || "";
  const apiKey = options.apiKey || process.env.AIMASHI_CLOUD_HERMES_API_KEY || "aimashi-cloud";
  const image = options.image || process.env.AIMASHI_CLOUD_HERMES_IMAGE || "";
  const dockerBin = options.dockerBin || process.env.AIMASHI_DOCKER_BIN || "docker";
  const execFile = options.execFile || promisify(execFileCb);
  const containerPort = Number(options.containerPort || process.env.AIMASHI_CLOUD_HERMES_CONTAINER_PORT || 8765);

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
    return { ...CONTAINER_ENV };
  }

  function ensureUserDirs(userId) {
    const paths = pathsForUser(userId);
    for (const dir of [paths.root, paths.hermesHome, paths.home, paths.workspace, paths.attachments, paths.logs]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
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
      throw new Error("Cloud Hermes worker is not configured. Set AIMASHI_CLOUD_AGENT_MODE=static and AIMASHI_CLOUD_HERMES_BASE_URL, or configure a container worker.");
    }
    throw new Error(`Unsupported cloud Hermes worker mode: ${mode}`);
  }

  function containerName(userId) {
    return `aimashi-hermes-${assertSafeUserId(userId)}`;
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

  async function ensureDockerWorker(paths) {
    if (!image) throw new Error("AIMASHI_CLOUD_HERMES_IMAGE is required for docker cloud Hermes workers.");
    const name = containerName(paths.userId);
    const running = await dockerRunning(name);
    if (!running) {
      const env = envForUser(paths.userId);
      await docker([
        "run",
        "-d",
        "--rm",
        "--name", name,
        "--network=bridge",
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
        image
      ]);
    }
    const port = await dockerPort(name);
    return {
      userId: paths.userId,
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey,
      paths,
      env: envForUser(paths.userId),
      containerName: name
    };
  }

  return { pathsForUser, envForUser, ensureUserDirs, ensureWorker, containerName };
}

module.exports = { createHermesWorkerManager };
