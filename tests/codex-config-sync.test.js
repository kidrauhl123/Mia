const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  codexConfigValuesForPermission,
  renderConfigWithTopLevelValues,
  syncCodexConfigForPermission
} = require("../src/main/codex-config-sync.js");

test("codexConfigValuesForPermission derives official full access config values", () => {
  assert.deepEqual(codexConfigValuesForPermission({
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  }), {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  });
});

test("renderConfigWithTopLevelValues replaces top-level permission keys and preserves sections", () => {
  const rendered = renderConfigWithTopLevelValues([
    "model = \"gpt-5\"",
    "approval_policy = \"on-request\"",
    "sandbox_mode = \"workspace-write\"",
    "",
    "[projects.\"/repo\"]",
    "trust_level = \"trusted\"",
    "",
    "[mcp_servers.other]",
    "command = \"keep\"",
    ""
  ].join("\n"), {
    approvalPolicy: "never",
    sandboxMode: "danger-full-access"
  });

  assert.match(rendered, /approval_policy = "never"/);
  assert.match(rendered, /sandbox_mode = "danger-full-access"/);
  assert.match(rendered, /\[projects\."\/repo"\]\ntrust_level = "trusted"/);
  assert.match(rendered, /\[mcp_servers\.other\]\ncommand = "keep"/);
});

test("renderConfigWithTopLevelValues inserts permission keys before first table", () => {
  const rendered = renderConfigWithTopLevelValues([
    "[mcp_servers.other]",
    "command = \"keep\"",
    ""
  ].join("\n"), {
    approvalPolicy: "never",
    sandboxMode: "danger-full-access"
  });

  assert.match(rendered, /^approval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n\[mcp_servers\.other\]/);
});

test("syncCodexConfigForPermission writes user config path without touching other sections", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-codex-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, [
    "model = \"gpt-5\"",
    "",
    "[mcp_servers.mia-scheduler]",
    "command = \"node\"",
    ""
  ].join("\n"));

  const result = syncCodexConfigForPermission({
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  }, {
    homeDir: () => dir
  });

  assert.equal(result.ok, true);
  const rendered = fs.readFileSync(configPath, "utf8");
  assert.match(rendered, /approval_policy = "never"/);
  assert.match(rendered, /sandbox_mode = "danger-full-access"/);
  assert.match(rendered, /\[mcp_servers\.mia-scheduler\]\ncommand = "node"/);
});
