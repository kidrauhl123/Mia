#!/usr/bin/env node

const childProcess = require("node:child_process");

const DEFAULT_REMOTE = "root@aiweb.buytb01.com";

const AUTH_TRACE_PATTERNS = [
  /Authenticating to/i,
  /identity file/i,
  /Authentications that can continue/i,
  /Next authentication method/i,
  /Offering public key/i,
  /Server accepts key/i,
  /Trying private key/i,
  /No more authentication methods/i,
  /Permission denied/i
];

function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  let remote = process.env.MIA_DEPLOY_REMOTE || DEFAULT_REMOTE;
  let timeoutSeconds = Number(process.env.MIA_DEPLOY_SSH_DIAGNOSE_TIMEOUT || 10);
  while (args.length) {
    const arg = args.shift();
    if (arg === "--timeout") {
      timeoutSeconds = Number(args.shift() || timeoutSeconds);
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, remote, timeoutSeconds };
    } else if (!arg.startsWith("-")) {
      remote = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Timeout must be a positive number of seconds.");
  }
  return { help: false, remote, timeoutSeconds };
}

function runCommand(command, args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 127, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code: timedOut ? 124 : code, stdout, stderr, timedOut });
    });
  });
}

function filterSshAuthTrace(output) {
  return String(output || "")
    .split(/\r?\n/)
    .filter((line) => AUTH_TRACE_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n");
}

function summarizeSshAgent(output, ok) {
  const text = String(output || "").trim();
  if (!text) return ok ? "ssh-agent identities: none reported" : "ssh-agent identities: unavailable";
  if (/has no identities|no identities/i.test(text)) return "ssh-agent identities: none loaded";
  const count = text.split(/\r?\n/).filter((line) => line.trim()).length;
  return `ssh-agent identities: ${count} loaded\n${text}`;
}

async function diagnoseDeploySsh({
  remote = DEFAULT_REMOTE,
  timeoutSeconds = 10,
  runCommandImpl = runCommand
} = {}) {
  const agent = await runCommandImpl("ssh-add", ["-l"], { timeoutMs: 3000 });
  const ssh = await runCommandImpl("ssh", [
    "-vvv",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.ceil(timeoutSeconds)}`,
    remote,
    "true"
  ], { timeoutMs: (timeoutSeconds + 5) * 1000 });
  const trace = filterSshAuthTrace(`${ssh.stdout}\n${ssh.stderr}`);
  return {
    remote,
    ok: ssh.ok,
    code: ssh.code,
    agentSummary: summarizeSshAgent(`${agent.stdout}\n${agent.stderr}`, agent.ok),
    trace,
    timedOut: ssh.timedOut
  };
}

function renderDiagnosis(result) {
  return [
    "Mia Cloud SSH deploy diagnosis",
    "",
    `Remote: ${result.remote}`,
    result.agentSummary,
    "",
    "Filtered SSH authentication trace:",
    result.trace || "(no authentication trace captured)",
    "",
    result.ok
      ? "SSH BatchMode preflight passed."
      : "SSH BatchMode preflight failed. If an Mia deploy key was offered but not accepted, fix VPS authorized_keys or sshd policy."
  ].join("\n");
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log("Usage: node scripts/diagnose-deploy-ssh.js [remote] [--timeout seconds]");
    return;
  }
  const result = await diagnoseDeploySsh(options);
  console.log(renderDiagnosis(result));
  if (!result.ok) process.exitCode = result.code || 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  diagnoseDeploySsh,
  filterSshAuthTrace,
  parseArgs,
  renderDiagnosis,
  summarizeSshAgent
};
