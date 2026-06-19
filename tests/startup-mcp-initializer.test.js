const test = require("node:test");
const assert = require("node:assert/strict");
const { createStartupMcpInitializer } = require("../src/main/mcp-startup-initializer.js");

test("startup MCP initializer keeps startup bounded when MCP initialization never resolves", async () => {
  const logs = [];
  const initializer = createStartupMcpInitializer({
    initializeMcp: () => new Promise(() => {}),
    timeoutMs: 20,
    appendEngineLog: (line) => logs.push(line)
  });

  const startedAt = Date.now();
  const result = await initializer.start();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /20ms/);
  assert.ok(elapsedMs < 250);
  assert.deepEqual(logs, [
    "MCP bridge initialization timed out after 20ms; continuing app startup."
  ]);
});
