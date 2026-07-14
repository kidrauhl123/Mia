const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("Rust Core background process policy hides Windows console windows", () => {
  const policy = read("crates/mia-core-common/src/process.rs");

  assert.match(policy, /CREATE_NO_WINDOW/);
  assert.match(policy, /creation_flags\(CREATE_NO_WINDOW\)/);
});

test("Rust Core startup parent check runs tasklist through the background process policy", () => {
  const source = read("crates/mia-core-app/src/main.rs");

  assert.match(
    source,
    /Command::new\("tasklist"\)[\s\S]*configure_background_command\(&mut command\)[\s\S]*\.output\(\)/
  );
});

test("Rust Core subprocess launch sites use the shared background process policy", () => {
  const files = [
    "crates/mia-core-app/src/router/agent_command.rs",
    "crates/mia-core-app/src/router/engine.rs",
    "crates/mia-core-mcp/src/connection_test.rs",
    "crates/mia-core-mcp/src/lib.rs",
    "crates/mia-core-runtime/src/agent_engines.rs",
    "crates/mia-core-runtime/src/lib.rs",
    "crates/mia-core-runtime/src/native_acp.rs",
  ];

  for (const file of files) {
    assert.match(read(file), /configure_background_command\(/, file);
  }
});
