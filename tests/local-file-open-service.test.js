const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createLocalFileOpenService,
  normalizeLocalFileTarget
} = require("../src/main/local-file-open-service.js");

test("normalizeLocalFileTarget accepts encoded absolute paths and file URLs", () => {
  assert.equal(
    normalizeLocalFileTarget("/Users/jung/Library/Application%20Support/Mia/runtime/engine-home/workspace/mia-diff-demo.txt"),
    "/Users/jung/Library/Application Support/Mia/runtime/engine-home/workspace/mia-diff-demo.txt"
  );
  assert.equal(
    normalizeLocalFileTarget("file:///Users/jung/Library/Application%20Support/Mia/demo.txt"),
    "/Users/jung/Library/Application Support/Mia/demo.txt"
  );
});

test("normalizeLocalFileTarget rejects non-local targets", () => {
  assert.equal(normalizeLocalFileTarget("https://example.com/demo.txt"), "");
  assert.equal(normalizeLocalFileTarget("relative/demo.txt"), "");
  assert.equal(normalizeLocalFileTarget(""), "");
});

test("openLocalFile delegates the normalized path to Electron shell.openPath", async () => {
  const calls = [];
  const service = createLocalFileOpenService({
    shellOpenPath: async (target) => {
      calls.push(target);
      return "";
    }
  });

  const result = await service.openLocalFile("/Users/jung/Library/Application%20Support/Mia/demo.txt");

  assert.deepEqual(calls, ["/Users/jung/Library/Application Support/Mia/demo.txt"]);
  assert.deepEqual(result, {
    ok: true,
    path: "/Users/jung/Library/Application Support/Mia/demo.txt",
    error: ""
  });
});

test("openLocalFile reports invalid local file targets without calling shell", async () => {
  const calls = [];
  const service = createLocalFileOpenService({
    shellOpenPath: async (target) => {
      calls.push(target);
      return "";
    }
  });

  const result = await service.openLocalFile("https://example.com/demo.txt");

  assert.deepEqual(calls, []);
  assert.deepEqual(result, {
    ok: false,
    path: "",
    error: "invalid-path"
  });
});

test("revealLocalFile delegates the normalized path to Electron shell.showItemInFolder", async () => {
  const calls = [];
  const service = createLocalFileOpenService({
    shellOpenPath: async () => "",
    shellShowItemInFolder: (target) => {
      calls.push(target);
    }
  });

  const result = await service.revealLocalFile("/Users/jung/Library/Application%20Support/Mia/demo.txt");

  assert.deepEqual(calls, ["/Users/jung/Library/Application Support/Mia/demo.txt"]);
  assert.deepEqual(result, {
    ok: true,
    path: "/Users/jung/Library/Application Support/Mia/demo.txt",
    error: ""
  });
});
