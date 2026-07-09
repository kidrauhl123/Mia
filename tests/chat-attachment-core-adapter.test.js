const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createChatAttachmentCoreAdapter, isCloudFilePath } = require("../src/main/chat-attachment-core-adapter.js");

test("chat attachment Core adapter saves data URLs through Rust Core and records cloud cache metadata", async () => {
  const calls = [];
  const remembers = [];
  const adapter = createChatAttachmentCoreAdapter({
    coreRequest: async (request) => {
      calls.push(request);
      return { id: "att_1", name: "pixel.png", path: "/core/attachments/pixel.png" };
    },
    cloudAttachments: {
      rememberCloudDownload: (input, saved) => remembers.push({ input, saved })
    }
  });

  const input = { name: "pixel.png", dataUrl: "data:image/png;base64,cG5n", url: "/api/files/file_1" };
  const saved = await adapter.saveAttachment(input);

  assert.deepEqual(saved, { id: "att_1", name: "pixel.png", path: "/core/attachments/pixel.png" });
  assert.deepEqual(calls, [{
    method: "POST",
    route: "/api/attachments/save",
    body: input
  }]);
  assert.deepEqual(remembers, [{ input, saved }]);
});

test("chat attachment Core adapter fetches local files through Rust Core and preserves error envelopes", async () => {
  const calls = [];
  const adapter = createChatAttachmentCoreAdapter({
    coreRequest: async (request) => {
      calls.push(request);
      if (request.body.path === "/missing.txt") throw new Error("File not found.");
      return { id: "att_2", name: "note.txt", path: "/tmp/note.txt", dataUrl: "data:text/plain;base64,aGk=" };
    }
  });

  assert.deepEqual(await adapter.fetchFileAttachment({ path: "/tmp/note.txt" }), {
    id: "att_2",
    name: "note.txt",
    path: "/tmp/note.txt",
    dataUrl: "data:text/plain;base64,aGk="
  });
  assert.deepEqual(calls[0], {
    method: "POST",
    route: "/api/attachments/file",
    body: { path: "/tmp/note.txt" }
  });
  assert.deepEqual(await adapter.fetchFileAttachment({ path: "/missing.txt" }), {
    error: true,
    message: "File not found.",
    path: "/missing.txt"
  });
});

test("chat attachment Core adapter keeps cloud file downloads behind cloud attachment helper", async () => {
  const calls = [];
  const adapter = createChatAttachmentCoreAdapter({
    coreRequest: async (request) => {
      calls.push(request);
      return {};
    },
    cloudAttachments: {
      fetchCloudFileAttachment: async (input) => ({ id: input.id, url: input.url, dataUrl: "data:text/plain;base64,aGk=" })
    }
  });

  assert.equal(isCloudFilePath("/api/files/file_1"), true);
  assert.equal(isCloudFilePath("/api/files/../../secret"), false);
  assert.deepEqual(await adapter.fetchFileAttachment({ id: "cloud_1", url: "/api/files/file_1" }), {
    id: "cloud_1",
    url: "/api/files/file_1",
    dataUrl: "data:text/plain;base64,aGk="
  });
  assert.deepEqual(calls, []);
});
