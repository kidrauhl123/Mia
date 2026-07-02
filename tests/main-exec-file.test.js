const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} should exist`);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "(") parenDepth += 1;
    if (ch === ")") {
      parenDepth -= 1;
      continue;
    }
    if (ch === "{" && parenDepth === 0) {
      bodyStart = index;
      break;
    }
  }
  assert.notEqual(bodyStart, -1, `${functionName} body should exist`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${functionName}`);
}

function loadExecFileAsPromise(overrides = {}) {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const sandbox = {
    execFile: overrides.execFile || (() => { throw new Error("execFile stub required"); }),
    processEnvStrings: overrides.processEnvStrings || (() => ({})),
    process: { platform: process.platform },
    Promise,
    String,
    Number
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunctionSource(mainSource, "execFileAsPromise")}; this.execFileAsPromise = execFileAsPromise;`,
    sandbox,
    { filename: "src/main.js" }
  );
  return sandbox.execFileAsPromise;
}

test("execFileAsPromise preserves spawnCode details for launch failures", async () => {
  const execFileAsPromise = loadExecFileAsPromise({
    execFile: (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      callback(error, "", "");
    }
  });

  const result = await execFileAsPromise("codex", ["mcp", "list"]);

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.spawnCode, "ENOENT");
  assert.equal(result.signal, "");
  assert.match(result.stderr, /spawn ENOENT/);
  assert.match(result.stderr, /spawnCode=ENOENT/);
});

test("execFileAsPromise preserves signal details for signalled failures", async () => {
  const execFileAsPromise = loadExecFileAsPromise({
    execFile: (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("terminated"), { code: null, signal: "SIGTERM" });
      callback(error, "", "");
    }
  });

  const result = await execFileAsPromise("claude", ["mcp", "list"]);

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.spawnCode, "");
  assert.equal(result.signal, "SIGTERM");
  assert.match(result.stderr, /terminated/);
  assert.match(result.stderr, /signal=SIGTERM/);
});
