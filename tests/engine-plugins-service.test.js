const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEnginePluginsService } = require("../src/main/engine-plugins-service.js");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-engine-plugins-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    engine: path.join(dir, "engine"),
    pluginsDir: path.join(dir, "runtime", "plugins")
  };
  const service = createEnginePluginsService({
    runtimePaths: () => runtime
  });
  return { runtime, service };
}

test("pluginFiles exposes the Aimashi gateway wrapper and fellow overlay plugin", (t) => {
  const { service } = setup(t);
  const files = service.pluginFiles();

  assert.deepEqual(Object.keys(files).sort(), ["__init__.py", "__main__.py", "fellow_overlay.py"]);
  assert.match(files["__main__.py"], /_load_aimashi_env/);
  assert.match(files["__main__.py"], /aimashi-model\.json/);
  assert.match(files["fellow_overlay.py"], /X-Aimashi-Fellow/);
  assert.match(files["fellow_overlay.py"], /X-Aimashi-Group-Context/);
  assert.match(files["fellow_overlay.py"], /ephemeral_system_prompt/);
});

test("ensureInstalled writes plugin files under runtime plugins and removes legacy engine copy", (t) => {
  const { runtime, service } = setup(t);
  const legacyDir = path.join(runtime.engine, "aimashi_plugins");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "old.py"), "old");

  const result = service.ensureInstalled();

  assert.equal(result.pluginDir, path.join(runtime.pluginsDir, "aimashi_plugins"));
  assert.equal(fs.existsSync(path.join(result.pluginDir, "__init__.py")), true);
  assert.equal(fs.existsSync(path.join(result.pluginDir, "__main__.py")), true);
  assert.equal(fs.existsSync(path.join(result.pluginDir, "fellow_overlay.py")), true);
  assert.equal(fs.existsSync(legacyDir), false);
});
