const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Windows NSIS upgrades use same-volume staging and release Mia Core before replacing the app directory", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const includePath = path.join(root, packageJson.build.nsis.include);
  const source = fs.readFileSync(includePath, "utf8");

  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  assert.doesNotMatch(source, /\nVar(?: \/GLOBAL)? PowerShellPath\n/);
  assert.match(source, /!macro customUnInit/);
  assert.match(source, /!macro customInit[\s\S]{0,400}?!insertmacro prepareLegacyUninstallerTemp/);
  const customInit = source.match(/!macro customInit[\s\S]*?!macroend/)?.[0];
  assert.ok(customInit, "customInit must be defined");
  assert.doesNotMatch(customInit, /\$PowerShellPath/);
  assert.match(source, /\$\{GetOptions\} \$R0 "--updated" \$R1/);
  assert.match(source, /StrCpy \$R9 "\$INSTDIR\.__mia_update_tmp"/);
  assert.match(source, /Kernel32::SetEnvironmentVariable\(t "TEMP", t "\$R9"\)/);
  assert.match(source, /Kernel32::SetEnvironmentVariable\(t "TMP", t "\$R9"\)/);
  const legacyTempHook = source.match(/!macro prepareLegacyUninstallerTemp[\s\S]*?!macroend/)?.[0];
  assert.ok(legacyTempHook, "incoming installer must prepare the old uninstaller's temp directory");
  assert.match(legacyTempHook, /!ifndef BUILD_UNINSTALLER/);
  assert.match(legacyTempHook, /\$\{FileExists\} "\$INSTDIR\\Uninstall \$\{PRODUCT_NAME\}\.exe"/);
  assert.match(legacyTempHook, /Kernel32::SetEnvironmentVariable\(t "TEMP", t "\$R9"\)/);
  assert.match(legacyTempHook, /Kernel32::SetEnvironmentVariable\(t "TMP", t "\$R9"\)/);
  assert.match(source, /!macro customCheckAppRunning/);
  assert.match(source, /-Command "& \{ param\(\[string\]\$\$root\)/);
  assert.match(source, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(source, /ExecutablePath.*StartsWith/);
  assert.match(source, /taskkill \/T \/F \/IM "mia-core\.exe"/);
  assert.match(source, /Sleep 800/);
  assert.match(source, /!macro persistManagedResources removeSource/);
  assert.match(source, /StrCpy \$R5 "\$SYSDIR\\WindowsPowerShell\\v1\.0\\powershell\.exe"/);
  assert.match(source, /nsExec::ExecToLog `"\$R5" -NoProfile/);
  assert.match(source, /persist-managed-resources\.ps1/);
  assert.match(source, /ReadEnvStr \$R8 "MIA_HOME"/);
  assert.match(source, /\$APPDATA\\\$\{PRODUCT_NAME\}\\runtime\\engine-home/);
  assert.doesNotMatch(source, /!macro customInstall/);
});

test("Windows runtime persistence copies versioned ACP resources and removes only the bundled source", {
  skip: process.platform !== "win32"
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-managed-resource-persist-"));
  const source = path.join(tempDir, "installed", "managed-resources");
  const destination = path.join(tempDir, "profile", "managed-resources");
  const runtimeRoot = path.join(source, "acp", "codex-acp", "1.1.4", "win32-x64");
  const entrypoint = path.join(runtimeRoot, "bin", "agent.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "module.exports = {};\n");
  fs.writeFileSync(path.join(runtimeRoot, "manifest.json"), JSON.stringify({
    entrypoint: "bin/agent.js",
    protocol: "codex-app-server",
    version: "1.1.4"
  }));

  try {
    childProcess.execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "build", "persist-managed-resources.ps1"),
      "-Source",
      source,
      "-Destination",
      destination,
      "-RemoveSourceOnSuccess"
    ], { stdio: "pipe" });

    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(path.join(
      destination,
      "acp",
      "codex-acp",
      "1.1.4",
      "win32-x64",
      "bin",
      "agent.js"
    )), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
