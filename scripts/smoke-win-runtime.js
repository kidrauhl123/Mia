// Windows runtime smoke: prove the bundled Hermes runtime imports through the
// REAL buildPythonPath() on a native x86_64 Windows host (GitHub Actions).
//
// Why this exists: buildPythonPath() (src/main/runtime-paths.js) joins the
// plugins dir + bundled site-packages into PYTHONPATH. A hardcoded ":" used to
// collapse that into one bogus entry on Windows (delimiter there is ";"), so
// nothing imported and the Hermes gateway never started. A single-path import
// can't catch that — this builds a MULTI-entry PYTHONPATH (a probe module in
// the plugins dir + the bundled site-packages) and asserts BOTH import, which
// only passes when the delimiter is correct.
//
// Runs in release-win.yml after `npm run dist:win`. No-op (exit 0) anywhere the
// win-x64 runtime isn't present, so it's safe to invoke off-Windows.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const runtimeResources = require("../src/runtime-resource-paths.js");
const { createRuntimePaths } = require("../src/main/runtime-paths.js");

function fail(message) {
  console.error(`[smoke-win-runtime] FAIL: ${message}`);
  process.exit(1);
}

const target = runtimeResources.runtimeTargetId();
const runtimeDir = runtimeResources.bundledHermesRuntimeDir({
  resourcesPath: process.resourcesPath,
  appPath: process.cwd(),
  cwd: process.cwd()
});
const python = runtimeResources.bundledPython(runtimeDir, { platform: process.platform });

if (!runtimeDir || !python) {
  console.log(`[smoke-win-runtime] skipped: no bundled runtime for ${target} (dir=${runtimeDir || "none"}).`);
  process.exit(0);
}

// Stub `app` so runtimePaths() lays out under a throwaway userData dir; the
// rest of buildPythonPath() (plugins dir + bundled site-packages resolution) is
// the real production code.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mia-smoke-win-"));
const app = {
  getPath: (key) => (key === "home" ? os.homedir() : userData),
  getAppPath: () => process.cwd()
};
const rp = createRuntimePaths({
  app,
  runtimeResources,
  MIA_GATEWAY_SERVICE_LABEL: "ai.mia.smoke.gateway",
  MIA_DAEMON_SERVICE_LABEL: "ai.mia.smoke.daemon"
});

// Drop a probe module into the plugins dir so PYTHONPATH genuinely needs >1
// entry — the case the ":"-vs-";" bug actually broke.
const pluginsDir = rp.runtimePaths().pluginsDir;
fs.mkdirSync(pluginsDir, { recursive: true });
fs.writeFileSync(path.join(pluginsDir, "mia_smoke_probe.py"), "MARKER = 'mia-win-smoke-ok'\n");

const pythonPath = rp.buildPythonPath();
console.log(`[smoke-win-runtime] target=${target}`);
console.log(`[smoke-win-runtime] python=${python}`);
console.log(`[smoke-win-runtime] PYTHONPATH=${pythonPath}`);

const probe = [
  "import mia_smoke_probe",
  "import hermes_cli, gateway.platforms.api_server, aiohttp",
  "assert mia_smoke_probe.MARKER == 'mia-win-smoke-ok'",
  "print('win runtime import OK', hermes_cli.__version__)"
].join("; ");

const result = spawnSync(python, ["-c", probe], {
  encoding: "utf8",
  env: { ...process.env, PYTHONPATH: pythonPath }
});

process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
fs.rmSync(userData, { recursive: true, force: true });

if (result.error) fail(`could not run bundled python: ${result.error.message}`);
if (result.status !== 0) fail(`bundled python import failed (exit ${result.status}). Likely PYTHONPATH delimiter or runtime contents.`);
console.log("[smoke-win-runtime] OK");
