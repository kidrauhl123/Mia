const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const INSTALLER = path.join(ROOT, "scripts", "install-officecli-runtime.sh");

function writeExecutable(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

test("OfficeCLI runtime installer uses the China mirror first, verifies the installer, falls back, and is idempotent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-officecli-installer-"));
  try {
    const runtimeHome = path.join(tmp, "runtime-home");
    const installerSource = path.join(tmp, "upstream-install.sh");
    const officeCliSource = path.join(tmp, "officecli-source");
    const curlLog = path.join(tmp, "curl.log");
    const fakeBin = path.join(tmp, "fake-bin");

    writeExecutable(officeCliSource, "#!/usr/bin/env bash\nprintf 'OfficeCLI 1.0.135\\n'\n");
    writeExecutable(installerSource, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "mkdir -p \"$HOME/.local/bin\"",
      "cp \"$FAKE_OFFICECLI_SOURCE\" \"$HOME/.local/bin/officecli\"",
      "chmod +x \"$HOME/.local/bin/officecli\""
    ].join("\n") + "\n");
    writeExecutable(path.join(fakeBin, "curl"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "url=''",
      "out=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in",
      "    -o) out=\"$2\"; shift 2 ;;",
      "    http*) url=\"$1\"; shift ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      "printf '%s\\n' \"$url\" >> \"$FAKE_CURL_LOG\"",
      "case \"$url\" in",
      "  https://mirror.test/*) exit 22 ;;",
      "  https://fallback.test/*) cp \"$FAKE_INSTALLER_SOURCE\" \"$out\" ;;",
      "  *) exit 22 ;;",
      "esac"
    ].join("\n") + "\n");

    const installerSha = crypto.createHash("sha256").update(fs.readFileSync(installerSource)).digest("hex");
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      MIA_CLOUD_AGENT_OFFICECLI_HOME: runtimeHome,
      MIA_OFFICECLI_INSTALLER_MIRROR_URL: "https://mirror.test/install.sh",
      MIA_OFFICECLI_INSTALLER_FALLBACK_URL: "https://fallback.test/install.sh",
      MIA_OFFICECLI_INSTALLER_SHA256: installerSha,
      FAKE_CURL_LOG: curlLog,
      FAKE_INSTALLER_SOURCE: installerSource,
      FAKE_OFFICECLI_SOURCE: officeCliSource
    };

    const first = childProcess.spawnSync("bash", [INSTALLER], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /OfficeCLI runtime ready: OfficeCLI 1\.0\.135/);
    assert.deepEqual(fs.readFileSync(curlLog, "utf8").trim().split("\n"), [
      "https://mirror.test/install.sh",
      "https://fallback.test/install.sh"
    ]);

    const second = childProcess.spawnSync("bash", [INSTALLER], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /OfficeCLI runtime already ready: OfficeCLI 1\.0\.135/);
    assert.equal(fs.readFileSync(curlLog, "utf8").trim().split("\n").length, 2);

    const source = fs.readFileSync(INSTALLER, "utf8");
    assert.match(source, /https:\/\/d\.officecli\.ai\/install\.sh/);
    assert.match(source, /iOfficeAI\/OfficeCLI\/v1\.0\.135\/install\.sh/);
    assert.match(source, /mia-officecli-runtime-install\.lock/);
    assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:ba)?sh/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Cloud release and install scripts ship and activate the shared OfficeCLI runtime", () => {
  const releaseBuilder = fs.readFileSync(path.join(ROOT, "scripts", "build-cloud-release.js"), "utf8");
  const localInstaller = fs.readFileSync(path.join(ROOT, "scripts", "install-cloud-release-local.sh"), "utf8");
  const sshDeploy = fs.readFileSync(path.join(ROOT, "scripts", "deploy-cloud-release.sh"), "utf8");

  assert.match(releaseBuilder, /install-officecli-runtime\.sh/);
  for (const source of [localInstaller, sshDeploy]) {
    assert.match(source, /MIA_CLOUD_AGENT_OFFICECLI_HOME/);
    assert.match(source, /install-officecli-runtime\.sh/);
    assert.match(source, /Environment=MIA_CLOUD_AGENT_OFFICECLI_HOME=/);
  }
});
