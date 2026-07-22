const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Windows NSIS upgrades release Mia Core before replacing the app directory", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const includePath = path.join(root, packageJson.build.nsis.include);
  const source = fs.readFileSync(includePath, "utf8");

  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  assert.match(source, /!macro customCheckAppRunning/);
  assert.match(source, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(source, /ExecutablePath.*StartsWith/);
  assert.match(source, /taskkill \/T \/F \/IM "mia-core\.exe"/);
  assert.match(source, /Sleep 800/);
});
