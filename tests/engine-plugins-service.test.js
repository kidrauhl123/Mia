const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEnginePluginsService } = require("../src/main/engine-plugins-service.js");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-plugins-"));
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

test("pluginFiles exposes the Mia gateway wrapper and bot overlay plugin", (t) => {
  const { service } = setup(t);
  const files = service.pluginFiles();

  assert.deepEqual(Object.keys(files).sort(), ["__init__.py", "__main__.py", "bot_overlay.py", "web_search_mcp.py"]);
  assert.doesNotMatch(files["__main__.py"], /_load_mia_env|mia-model\.json|apiKeyEnv|apiKey/);
  assert.match(files["__main__.py"], /runpy\.run_module\('hermes_cli\.main'/);
  assert.match(files["bot_overlay.py"], /X-Mia-Bot/);
  assert.match(files["bot_overlay.py"], /X-Mia-Group-Context/);
  assert.match(files["bot_overlay.py"], /ephemeral_system_prompt/);
  assert.match(files["web_search_mcp.py"], /web_search/);
  assert.match(files["web_search_mcp.py"], /web_fetch/);
  assert.match(files["web_search_mcp.py"], /duckduckgo/);
});

test("ensureInstalled writes plugin files under runtime plugins and removes legacy engine copy", (t) => {
  const { runtime, service } = setup(t);
  const legacyDir = path.join(runtime.engine, "mia_plugins");
  const pluginDir = path.join(runtime.pluginsDir, "mia_plugins");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "old.py"), "old");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "scheduler_mcp.py"), "stale");

  const result = service.ensureInstalled();

  assert.equal(result.pluginDir, path.join(runtime.pluginsDir, "mia_plugins"));
  assert.equal(fs.existsSync(path.join(result.pluginDir, "__init__.py")), true);
  assert.equal(fs.existsSync(path.join(result.pluginDir, "__main__.py")), true);
  assert.equal(fs.existsSync(path.join(result.pluginDir, "bot_overlay.py")), true);
  assert.equal(fs.existsSync(path.join(result.pluginDir, "scheduler_mcp.py")), false);
  assert.equal(fs.existsSync(path.join(result.pluginDir, "web_search_mcp.py")), true);
  assert.equal(fs.existsSync(legacyDir), false);
});
