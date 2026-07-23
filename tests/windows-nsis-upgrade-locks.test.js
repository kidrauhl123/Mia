const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Windows NSIS upgrades use same-volume staging and release Mia Core before replacing the app directory", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const includePath = path.join(root, packageJson.build.nsis.include);
  const source = fs.readFileSync(includePath, "utf8");

  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  assert.match(source, /!macro customUnInit/);
  assert.doesNotMatch(source, /!macro customInit/);
  assert.match(source, /\$\{GetOptions\} \$R0 "--updated" \$R1/);
  assert.match(source, /StrCpy \$R9 "\$INSTDIR\.__mia_update_tmp"/);
  assert.match(source, /Kernel32::SetEnvironmentVariable\(t "TEMP", t "\$R9"\)/);
  assert.match(source, /Kernel32::SetEnvironmentVariable\(t "TMP", t "\$R9"\)/);
  assert.match(source, /!macro customCheckAppRunning/);
  assert.match(source, /-Command "& \{ param\(\[string\]\$\$root\)/);
  assert.match(source, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(source, /ExecutablePath.*StartsWith/);
  assert.match(source, /taskkill \/T \/F \/IM "mia-core\.exe"/);
  assert.match(source, /Sleep 800/);
});
