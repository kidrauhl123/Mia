const { test } = require("node:test");
const assert = require("node:assert/strict");

const { syncHermesImAttachments } = require("../src/cloud-agent/hermes-im-attachments.js");

function createFakeGateway() {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      if (method === "image.attach") return { image_id: "img_1" };
      if (method === "pdf.attach") return { document_id: "pdf_1" };
      if (method === "file.attach") return {
        file_id: "file_1",
        ref_text: `[Attached file: ${params.name}]`
      };
      throw new Error(`unexpected method ${method}`);
    }
  };
}

test("syncHermesImAttachments routes image pdf and file attachments to Hermes RPCs", async () => {
  const gateway = createFakeGateway();

  const result = await syncHermesImAttachments({
    gateway,
    sessionId: "sess_1",
    attachments: [
      { path: "/tmp/shot.png", mimeType: "image/png", name: "shot.png" },
      { path: "/tmp/spec.pdf", mimeType: "application/pdf", name: "spec.pdf" },
      { path: "/tmp/note.txt", mimeType: "text/plain", name: "note.txt" }
    ]
  });

  assert.deepEqual(gateway.calls, [
    { method: "image.attach", params: { session_id: "sess_1", path: "/tmp/shot.png" } },
    { method: "pdf.attach", params: { session_id: "sess_1", path: "/tmp/spec.pdf" } },
    { method: "file.attach", params: { session_id: "sess_1", path: "/tmp/note.txt", name: "note.txt" } }
  ]);
  assert.equal(result.attached.length, 3);
  assert.equal(result.promptPrefix, "[Attached file: note.txt]");
});

test("syncHermesImAttachments collects promptPrefix from multiple file attachments only", async () => {
  const gateway = createFakeGateway();

  const result = await syncHermesImAttachments({
    gateway,
    sessionId: "sess_2",
    attachments: [
      { path: "/tmp/a.txt", mimeType: "text/plain", name: "a.txt" },
      { path: "/tmp/b.bin", mimeType: "application/octet-stream", name: "b.bin" },
      { path: "/tmp/pic.jpg", mimeType: "image/jpeg", name: "pic.jpg" }
    ]
  });

  assert.equal(result.promptPrefix, [
    "[Attached file: a.txt]",
    "[Attached file: b.bin]"
  ].join("\n\n"));
});
