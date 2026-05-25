const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { createChatAttachments } = require("../src/main/chat-attachments.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-chat-attachments-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { initialize: 0 };
  const attachments = createChatAttachments({
    initializeRuntime: () => { calls.initialize += 1; },
    runtimePaths: () => ({ attachmentsDir: path.join(dir, "attachments") }),
    getCloudSettings: () => ({ enabled: true, token: "token_1", url: "https://cloud.example" }),
    normalizeCloudUrl: (url) => String(url || "").replace(/\/+$/, ""),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/plain" },
      arrayBuffer: async () => Buffer.from("cloud file")
    }),
    timeoutSignal: () => undefined,
    randomUUID: () => "uuid_12345678",
    now: () => 1770000000000,
    ...overrides
  });
  return { attachments, calls, dir };
}

test("normalizeAttachment sanitizes names, file URLs, and image data URLs", (t) => {
  const { attachments, dir } = setup(t);
  const filePath = path.join(dir, "note.txt");
  fs.writeFileSync(filePath, "hello", "utf8");

  const normalized = attachments.normalizeAttachment({
    name: "../bad<>name.png",
    path: pathToFileURL(filePath).toString(),
    type: "image/png",
    dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
    thumbnail: `data:image/png;base64,${Buffer.from("thumb").toString("base64")}`
  });

  assert.equal(normalized.name, "bad_name.png");
  assert.equal(normalized.path, filePath);
  assert.equal(normalized.size, 5);
  assert.equal(normalized.kind, "image");
  assert.match(normalized.dataUrl, /^data:image\/png;base64,/);
  assert.match(normalized.thumbnailDataUrl, /^data:image\/png;base64,/);
});

test("saveChatAttachment writes bounded data URLs into the runtime attachment dir", (t) => {
  const { attachments, calls, dir } = setup(t);

  const saved = attachments.saveChatAttachment({
    name: "pixel.png",
    dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`
  });

  assert.equal(calls.initialize, 1);
  assert.equal(saved.name, "pixel.png");
  assert.equal(saved.mime, "image/png");
  assert.equal(saved.size, 3);
  assert.equal(fs.readFileSync(saved.path, "utf8"), "png");
  assert.equal(path.dirname(saved.path), path.join(dir, "attachments"));
});

test("readLocalFileAttachment and safeFetchFileAttachment handle local files and errors", async (t) => {
  const { attachments } = setup(t);
  const filePath = path.join(os.tmpdir(), `mia-local-${process.pid}.txt`);
  fs.writeFileSync(filePath, "local text", "utf8");
  try {
    const local = attachments.readLocalFileAttachment({ path: filePath });
    assert.equal(local.name, path.basename(filePath));
    assert.equal(local.mime, "text/plain");
    assert.match(local.dataUrl, /^data:text\/plain;base64,/);
    assert.deepEqual(await attachments.safeFetchFileAttachment({ path: "/no/such/file" }), {
      error: true,
      message: "File not found.",
      path: "/no/such/file"
    });
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("fetchCloudFileAttachment uses account settings without leaking token into URL", async (t) => {
  let request = null;
  const { attachments } = setup(t, {
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/plain" },
        arrayBuffer: async () => Buffer.from("cloud file")
      };
    }
  });

  const file = await attachments.fetchCloudFileAttachment({ url: "/api/files/file_123", name: "note.txt" });

  assert.equal(request.url, "https://cloud.example/api/files/file_123");
  assert.equal(request.options.headers.Authorization, "Bearer token_1");
  assert.equal(file.name, "note.txt");
  assert.equal(file.size, 10);
  assert.equal(file.dataUrl, `data:text/plain;base64,${Buffer.from("cloud file").toString("base64")}`);
});
