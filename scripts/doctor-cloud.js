#!/usr/bin/env node

const childProcess = require("node:child_process");
const dns = require("node:dns/promises");

const requiredFeatures = [
  "sqlite-store",
  "authenticated-files",
  "events-websocket",
  "bridge-websocket-subprotocol-token",
  "bridge-run-lifecycle",
  "bridge-run-cancel",
  "bridge-run-progress",
  "desktop-sync"
];
const DEFAULT_OFFICECLI_HOME = "/opt/mia-agent-runtime/officecli";

function usage() {
  return [
    "Usage: node scripts/doctor-cloud.js [cloud-url]",
    "",
    "Examples:",
    "  node scripts/doctor-cloud.js https://mia.gifgif.cn",
    "  MIA_DOCTOR_REMOTE=root@mia.gifgif.cn node scripts/doctor-cloud.js https://mia.gifgif.cn",
    "",
    "Environment:",
    "  MIA_CLOUD_URL=<url>          Cloud URL when no positional URL is passed.",
    "  MIA_DOCTOR_REMOTE=<ssh>      Optional SSH target for server prerequisite checks.",
    "  MIA_DOCTOR_EXPECT_RELEASE_COMMIT=<sha>  Require /api/health.release.gitCommit to match.",
    "  MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT=<iso>  Require /api/health.release.builtAt to match.",
    "  MIA_DOCTOR_OFFICECLI_BIN=<path>  Verify a host OfficeCLI binary and report its real version.",
    "  MIA_DEPLOY_SUDO=\"sudo -n\"    Optional privilege command for nginx -t.",
    "  MIA_DEPLOY_SERVICE_USER=mia-cloud  Service user expected by deployment scripts.",
    "  MIA_DOCTOR_TIMEOUT_MS=10000  Per network/SSH check timeout."
  ].join("\n");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error(usage());
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Cloud URL must be http or https.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const positional = argv.filter((arg) => !String(arg).startsWith("-"));
  if (argv.includes("-h") || argv.includes("--help")) return { help: true };
  return {
    baseUrl: normalizeBaseUrl(positional[0] || env.MIA_CLOUD_URL || "https://mia.gifgif.cn"),
    remote: String(env.MIA_DOCTOR_REMOTE || "").trim(),
    sudo: String(env.MIA_DEPLOY_SUDO || "").trim(),
    serviceUser: String(env.MIA_DEPLOY_SERVICE_USER || "mia-cloud").trim() || "mia-cloud",
    expectedReleaseCommit: String(env.MIA_DOCTOR_EXPECT_RELEASE_COMMIT || "").trim(),
    expectedReleaseBuiltAt: String(env.MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT || "").trim(),
    officeCliBin: String(env.MIA_DOCTOR_OFFICECLI_BIN || "").trim(),
    officeCliHome: String(env.MIA_CLOUD_AGENT_OFFICECLI_HOME || DEFAULT_OFFICECLI_HOME).trim() || DEFAULT_OFFICECLI_HOME,
    timeoutMs: Number(env.MIA_DOCTOR_TIMEOUT_MS || 10000)
  };
}

function result(name, ok, detail = "") {
  return { name, ok: Boolean(ok), detail: String(detail || "") };
}

function evaluateHealth({
  health = {},
  responseHeaders = new Headers(),
  baseUrl,
  expectedReleaseCommit = "",
  expectedReleaseBuiltAt = ""
}) {
  const checks = [];
  const features = Array.isArray(health.features) ? health.features : [];
  const missing = requiredFeatures.filter((feature) => !features.includes(feature));
  checks.push(result(
    "health features",
    missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `features=${features.length}`
  ));
  checks.push(result(
    "release provenance",
    Boolean(health.release?.gitCommit && health.release?.builtAt),
    health.release?.gitCommit ? `${health.release.gitCommit} ${health.release.builtAt || ""}`.trim() : "missing /api/health.release"
  ));
  const expectedCommit = String(expectedReleaseCommit || "").trim();
  const expectedBuiltAt = String(expectedReleaseBuiltAt || "").trim();
  if (expectedCommit || expectedBuiltAt) {
    const mismatches = [];
    if (expectedCommit && health.release?.gitCommit !== expectedCommit) {
      mismatches.push(`commit expected ${expectedCommit}, got ${health.release?.gitCommit || "missing"}`);
    }
    if (expectedBuiltAt && health.release?.builtAt !== expectedBuiltAt) {
      mismatches.push(`builtAt expected ${expectedBuiltAt}, got ${health.release?.builtAt || "missing"}`);
    }
    checks.push(result(
      "expected release",
      mismatches.length === 0,
      mismatches.length ? mismatches.join("; ") : `${expectedCommit || health.release?.gitCommit || ""} ${expectedBuiltAt || health.release?.builtAt || ""}`.trim()
    ));
  }
  checks.push(result(
    "same-origin CORS",
    responseHeaders.get("access-control-allow-origin") === baseUrl,
    responseHeaders.get("access-control-allow-origin") || "missing Access-Control-Allow-Origin"
  ));
  checks.push(result(
    "security headers",
    (responseHeaders.get("x-content-type-options") || "").toLowerCase() === "nosniff"
      && (responseHeaders.get("referrer-policy") || "").toLowerCase() === "strict-origin-when-cross-origin"
      && /camera=\(\), microphone=\(\), geolocation=\(\)/.test(responseHeaders.get("permissions-policy") || ""),
    "X-Content-Type-Options, Referrer-Policy, Permissions-Policy"
  ));
  if (new URL(baseUrl).protocol === "https:") {
    checks.push(result(
      "https hsts",
      /max-age=31536000/.test(responseHeaders.get("strict-transport-security") || ""),
      responseHeaders.get("strict-transport-security") || "missing Strict-Transport-Security"
    ));
  }
  return checks;
}

function runCommand(command, args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal || "",
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim()
      });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildRemoteProbeCommand({ sudo = "", serviceUser = "mia-cloud", officeCliHome = DEFAULT_OFFICECLI_HOME } = {}) {
  const sudoPrefix = sudo ? `${sudo} ` : "";
  const quotedServiceUser = shellQuote(serviceUser || "mia-cloud");
  const quotedOfficeCli = shellQuote(`${String(officeCliHome || DEFAULT_OFFICECLI_HOME).replace(/\/+$/, "")}/.local/bin/officecli`);
  return [
    "set -euo pipefail",
    "node -e 'require(\"node:sqlite\"); const major = Number(process.versions.node.split(\".\")[0]); if (major < 25) { console.error(\"Node.js 25+ is required, found \" + process.version); process.exit(1); }'",
    "command -v npm >/dev/null",
    "command -v rsync >/dev/null",
    "command -v systemctl >/dev/null",
    "command -v tar >/dev/null",
    "command -v id >/dev/null",
    "command -v chown >/dev/null",
    `(id -u ${quotedServiceUser} >/dev/null 2>&1 || command -v useradd >/dev/null || test -x /usr/sbin/useradd)`,
    "(command -v sha256sum >/dev/null || command -v shasum >/dev/null)",
    "command -v nginx >/dev/null",
    `test -x ${quotedOfficeCli}`,
    `${quotedOfficeCli} --version`,
    `${sudoPrefix}nginx -t`
  ].join(" && ");
}

async function checkOfficeCliRuntime(binary, { timeoutMs = 10000 } = {}) {
  const file = String(binary || "").trim();
  if (!file) return result("OfficeCLI runtime", false, "binary path not configured");
  const probe = await runCommand(file, ["--version"], { timeoutMs });
  return result(
    "OfficeCLI runtime",
    probe.ok && Boolean(probe.stdout),
    probe.stdout || probe.stderr || `exit ${probe.code}`
  );
}

async function checkPublic(baseUrl, {
  timeoutMs = 10000,
  expectedReleaseCommit = "",
  expectedReleaseBuiltAt = ""
} = {}) {
  const url = new URL(baseUrl);
  const addresses = await dns.lookup(url.hostname, { all: true }).catch((error) => {
    throw new Error(`DNS lookup failed for ${url.hostname}: ${error.message}`);
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: baseUrl },
      signal: controller.signal
    });
    const health = await response.json().catch(() => ({}));
    const checks = [
      result("dns", addresses.length > 0, addresses.map((address) => address.address).join(", ")),
      result("health http", response.ok, `HTTP ${response.status}`),
      ...evaluateHealth({
        health,
        responseHeaders: response.headers,
        baseUrl,
        expectedReleaseCommit,
        expectedReleaseBuiltAt
      })
    ];
    return checks;
  } finally {
    clearTimeout(timer);
  }
}

async function checkRemote(remote, { sudo = "", serviceUser = "mia-cloud", officeCliHome = DEFAULT_OFFICECLI_HOME, timeoutMs = 10000 } = {}) {
  if (!remote) return [];
  const access = await runCommand("ssh", [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
    remote,
    "true"
  ], { timeoutMs });
  if (!access.ok) {
    return [result("ssh access", false, access.stderr || access.stdout || `exit ${access.code}`)];
  }
  const probe = await runCommand("ssh", [
    remote,
    buildRemoteProbeCommand({ sudo, serviceUser, officeCliHome })
  ], { timeoutMs });
  return [
    result("ssh access", true, remote),
    result("remote prerequisites", probe.ok, probe.stderr || probe.stdout || `Node 25/node:sqlite, npm, rsync, systemctl, tar, checksum tool, id/chown, service user '${serviceUser}' or useradd, nginx -t`)
  ];
}

function printChecks(checks) {
  for (const check of checks) {
    const status = check.ok ? "OK" : "FAIL";
    console.log(`${status} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  const checks = [
    ...(await checkPublic(options.baseUrl, {
      timeoutMs: options.timeoutMs,
      expectedReleaseCommit: options.expectedReleaseCommit,
      expectedReleaseBuiltAt: options.expectedReleaseBuiltAt
    })),
    ...(options.officeCliBin ? [await checkOfficeCliRuntime(options.officeCliBin, { timeoutMs: options.timeoutMs })] : []),
    ...(await checkRemote(options.remote, {
      sudo: options.sudo,
      serviceUser: options.serviceUser,
      officeCliHome: options.officeCliHome,
      timeoutMs: options.timeoutMs
    }))
  ];
  printChecks(checks);
  if (checks.some((check) => !check.ok)) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Mia Cloud doctor failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildRemoteProbeCommand,
  checkOfficeCliRuntime,
  evaluateHealth,
  normalizeBaseUrl,
  parseArgs
};
