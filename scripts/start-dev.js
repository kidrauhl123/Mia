#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const DEFAULT_DEV_PORT = 27862;
const DEFAULT_MULTI_PORT = 27863;
const MAX_DEV_PORT = 27950;

function appDataRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "win32") return String(env.APPDATA || path.join(home, "AppData", "Roaming"));
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  return String(env.XDG_CONFIG_HOME || path.join(home, ".config"));
}

function resolveDevUserDataDir({ multi = false, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const explicit = String(env.MIA_USER_DATA_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  const profile = multi ? "Mia-Dev-2" : "Mia-Dev";
  return path.join(appDataRoot({ platform, env, home }), profile);
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}

function portAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available) => {
      server.removeAllListeners();
      if (server.listening) server.close(() => resolve(available));
      else resolve(available);
    };
    server.once("error", () => finish(false));
    server.listen(port, host, () => finish(true));
  });
}

async function findAvailablePort(startPort, endPort = MAX_DEV_PORT) {
  for (let port = startPort; port <= endPort; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`No available Mia Core development port in ${startPort}-${endPort}.`);
}

async function resolveDevLaunchConfig({ multi = false, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const explicitPort = String(env.MIA_CORE_PORT || "").trim();
  const corePort = explicitPort
    ? validPort(explicitPort)
    : await findAvailablePort(multi ? DEFAULT_MULTI_PORT : DEFAULT_DEV_PORT);
  if (!corePort) throw new Error("MIA_CORE_PORT must be a valid TCP port.");

  const userDataDir = resolveDevUserDataDir({ multi, env, platform, home });
  return {
    multi,
    userDataDir,
    corePort,
    env: {
      ...env,
      MIA_ALLOW_MULTIPLE_INSTANCES: env.MIA_ALLOW_MULTIPLE_INSTANCES || "1",
      MIA_USER_DATA_DIR: userDataDir,
      MIA_CORE_PORT: String(corePort)
    }
  };
}

function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function electronBinary() {
  const resolved = require("electron");
  if (typeof resolved !== "string") throw new Error("Could not resolve Electron binary.");
  return resolved;
}

function electronLaunchEnv(env = process.env) {
  const launchEnv = { ...env };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  return launchEnv;
}

async function main(argv = process.argv.slice(2)) {
  const multi = argv.includes("--multi");
  const config = await resolveDevLaunchConfig({ multi });
  console.log(`[mia-dev] user data: ${config.userDataDir}`);
  console.log(`[mia-dev] Core: http://127.0.0.1:${config.corePort}`);

  const build = childProcess.spawnSync(npmCommand(), ["run", "core:dev"], {
    cwd: root,
    env: config.env,
    stdio: "inherit"
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status || 1);

  const electron = childProcess.spawn(electronBinary(), [root], {
    cwd: root,
    env: electronLaunchEnv(config.env),
    stdio: "inherit"
  });
  electron.once("error", (error) => {
    console.error(`[mia-dev] Failed to start Electron: ${error.message}`);
    process.exitCode = 1;
  });
  electron.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code || 0);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mia-dev] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_DEV_PORT,
  DEFAULT_MULTI_PORT,
  appDataRoot,
  electronLaunchEnv,
  findAvailablePort,
  resolveDevLaunchConfig,
  resolveDevUserDataDir,
  validPort
};
