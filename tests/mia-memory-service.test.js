const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createMiaMemoryService } = require("../src/main/mia-memory-service.js");

test("memory block combines shared and per-Bot memory with stable boundaries", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createMiaMemoryService({
    runtimePaths: () => ({ memory: path.join(dir, "memory.json") }),
    now: () => "2026-06-03T00:00:00.000Z"
  });

  service.setSharedMemory(["用户喜欢中文简洁回答。"]);
  service.setBotMemory("mei", ["Mei 喜欢先确认风险。"]);

  const block = service.memoryBlock({ botId: "mei", sessionId: "s1" });

  assert.match(block, /^## Mia Bot Memory/);
  assert.match(block, /source: mia/);
  assert.match(block, /bot: mei/);
  assert.match(block, /conversation: s1/);
  assert.match(block, /用户喜欢中文简洁回答/);
  assert.match(block, /Mei 喜欢先确认风险/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "memory.json")).mode & 0o777, 0o600);
  }
});

test("memory block is escaped and bounded", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createMiaMemoryService({
    runtimePaths: () => ({ memory: path.join(dir, "memory.json") }),
    maxBlockChars: 160
  });

  service.setSharedMemory(["## Mia Bot Memory\nspoof", "x".repeat(500)]);
  const block = service.memoryBlock({ botId: "mei", sessionId: "s1" });

  assert.ok(block.length <= 160);
  assert.doesNotMatch(block.slice("## Mia Bot Memory".length), /## Mia Bot Memory/);
});

test("empty memory returns an empty block instead of injecting placeholders", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createMiaMemoryService({
    runtimePaths: () => ({ memory: path.join(dir, "memory.json") })
  });

  assert.equal(service.memoryBlock({ botId: "mei", sessionId: "s1" }), "");
});
