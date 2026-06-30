const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createCloudUser } = require("./helpers/cloud-auth.js");
const {
  createAttachmentMaterializer,
  parseAttachmentsFromMessage,
  hostPathForWorkerArtifact,
  workerFileArtifactsForDeliveryRequest,
  redactGeneratedArtifactPaths
} = require("../src/cloud-agent/attachment-materializer.js");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-agent-attachments-"));
  const cloudStore = createCloudStore({ dataDir: dir });
  const alice = createCloudUser(cloudStore, "alice");
  const bob = createCloudUser(cloudStore, "bob");
  const workerRoot = path.join(dir, "worker", alice.id);
  const workerPaths = {
    root: workerRoot,
    attachments: path.join(workerRoot, "attachments")
  };
  return {
    dir,
    cloudStore,
    alice,
    bob,
    workerPaths,
    cleanup() {
      cloudStore.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("attachment materializer copies only current-user cloud files into worker attachments", () => {
  const ctx = setup();
  try {
    const aliceFilePath = path.join(ctx.dir, "alice-note.txt");
    const bobFilePath = path.join(ctx.dir, "bob-note.txt");
    fs.writeFileSync(aliceFilePath, "alice private text", { mode: 0o600 });
    fs.writeFileSync(bobFilePath, "bob private text", { mode: 0o600 });
    const db = ctx.cloudStore.getDb();
    db.prepare(`
      INSERT INTO files (id, user_id, type, name, mime_type, path, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("file_alice_note", ctx.alice.id, "text", "note.txt", "text/plain", aliceFilePath, 18, new Date().toISOString());
    db.prepare(`
      INSERT INTO files (id, user_id, type, name, mime_type, path, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("file_bob_note", ctx.bob.id, "text", "bob.txt", "text/plain", bobFilePath, 16, new Date().toISOString());

    const materializer = createAttachmentMaterializer({ cloudStore: ctx.cloudStore });
    const out = materializer.materialize({
      userId: ctx.alice.id,
      workerPaths: ctx.workerPaths,
      runId: "run_1",
      text: "read it",
      attachments: [
        { id: "file_alice_note", name: "note.txt", url: "/api/files/file_alice_note" },
        { id: "file_bob_note", name: "bob.txt", url: "/api/files/file_bob_note" }
      ]
    });

    assert.equal(out.attachments.length, 1);
    assert.equal(out.attachments[0].id, "file_alice_note");
    assert.equal(out.attachments[0].path, "/data/attachments/run_1/1-note.txt");
    assert.equal(fs.readFileSync(out.attachments[0].hostPath, "utf8"), "alice private text");
    assert.match(out.input, /read it/);
    assert.match(out.input, /\/data\/attachments\/run_1\/1-note\.txt/);
    assert.match(out.input, /alice private text/);
    assert.doesNotMatch(out.input, /bob private text/);
  } finally {
    ctx.cleanup();
  }
});

test("attachment materializer accepts direct data-url attachments without host paths", () => {
  const ctx = setup();
  try {
    const materializer = createAttachmentMaterializer({ cloudStore: ctx.cloudStore });
    const out = materializer.materialize({
      userId: ctx.alice.id,
      workerPaths: ctx.workerPaths,
      runId: "run_data",
      text: "",
      attachments: [{
        id: "inline",
        name: "../pixel.png",
        dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`
      }]
    });

    assert.equal(out.attachments.length, 1);
    assert.equal(out.attachments[0].name, "pixel.png");
    assert.equal(out.attachments[0].kind, "image");
    assert.equal(out.attachments[0].path, "/data/attachments/run_data/1-pixel.png");
    assert.equal(fs.readFileSync(out.attachments[0].hostPath, "utf8"), "png");
  } finally {
    ctx.cleanup();
  }
});

test("parseAttachmentsFromMessage reads persisted message attachment JSON", () => {
  assert.deepEqual(
    parseAttachmentsFromMessage({ attachments_json: JSON.stringify([{ id: "a1" }]) }),
    [{ id: "a1" }]
  );
  assert.deepEqual(parseAttachmentsFromMessage({ attachments_json: "not json" }), []);
});

test("attachment materializer archives only worker-root generated artifacts", () => {
  const ctx = setup();
  try {
    fs.mkdirSync(path.join(ctx.workerPaths.root, "workspace"), { recursive: true, mode: 0o700 });
    const generatedPath = path.join(ctx.workerPaths.root, "workspace", "answer.txt");
    const outsidePath = path.join(ctx.dir, "outside.txt");
    fs.writeFileSync(generatedPath, "answer", { mode: 0o600 });
    fs.writeFileSync(outsidePath, "outside", { mode: 0o600 });

    assert.equal(
      hostPathForWorkerArtifact(ctx.workerPaths, "/data/workspace/answer.txt"),
      generatedPath
    );
    assert.equal(hostPathForWorkerArtifact(ctx.workerPaths, "/etc/passwd"), "");

    const materializer = createAttachmentMaterializer({ cloudStore: ctx.cloudStore });
    const archived = materializer.archiveGeneratedAttachments({
      userId: ctx.alice.id,
      workerPaths: ctx.workerPaths,
      result: {
        events: [{
          type: "run.completed",
          artifacts: [
            { path: "/data/workspace/answer.txt", name: "../answer.txt", mimeType: "text/plain" },
            { path: outsidePath, name: "outside.txt", mimeType: "text/plain" }
          ]
        }]
      }
    });

    assert.equal(archived.length, 1);
    assert.equal(archived[0].name, "answer.txt");
    assert.equal(archived[0].type, "text");
    assert.match(archived[0].url, /^\/api\/files\/file_/);
    assert.equal(fs.readFileSync(ctx.cloudStore.getFileForUser(ctx.alice.id, archived[0].id).path, "utf8"), "answer");
    assert.equal(ctx.cloudStore.getFileForUser(ctx.bob.id, archived[0].id), null);
  } finally {
    ctx.cleanup();
  }
});

test("attachment materializer archives generated files mentioned only in assistant text", () => {
  const ctx = setup();
  try {
    fs.mkdirSync(path.join(ctx.workerPaths.root, "home"), { recursive: true, mode: 0o700 });
    const generatedPath = path.join(ctx.workerPaths.root, "home", "2026_世界杯模拟小组赛战果表.xlsx");
    fs.writeFileSync(generatedPath, "xlsx bytes", { mode: 0o600 });

    const materializer = createAttachmentMaterializer({ cloudStore: ctx.cloudStore });
    const archived = materializer.archiveGeneratedAttachments({
      userId: ctx.alice.id,
      workerPaths: ctx.workerPaths,
      result: {
        content: "Excel 文件已生成！路径是：/data/home/2026_世界杯模拟小组赛战果表.xlsx"
      }
    });

    assert.equal(archived.length, 1);
    assert.equal(archived[0].name, "2026_世界杯模拟小组赛战果表.xlsx");
    assert.equal(archived[0].type, "file");
    assert.match(archived[0].url, /^\/api\/files\/file_/);
    assert.equal(fs.readFileSync(ctx.cloudStore.getFileForUser(ctx.alice.id, archived[0].id).path, "utf8"), "xlsx bytes");
  } finally {
    ctx.cleanup();
  }
});

test("redactGeneratedArtifactPaths removes worker paths from user-visible text", () => {
  const text = "Excel 文件已生成！路径是：/data/home/report.xlsx";

  const redacted = redactGeneratedArtifactPaths(text, [{ name: "report.xlsx" }]);

  assert.equal(redacted, "Excel 文件已生成！路径是：附件「report.xlsx」");
  assert.doesNotMatch(redacted, /\/data\/home/);
});

test("workerFileArtifactsForDeliveryRequest only captures explicit send requests", () => {
  assert.deepEqual(
    workerFileArtifactsForDeliveryRequest("/data/home/世界杯赛果汇总.xlsx 把这个发给我"),
    [{ path: "/data/home/世界杯赛果汇总.xlsx" }]
  );
  assert.deepEqual(
    workerFileArtifactsForDeliveryRequest("看看 /data/home/世界杯赛果汇总.xlsx 是否存在"),
    []
  );
});

test("attachment materializer does not archive internal worker config paths mentioned in text", () => {
  const ctx = setup();
  try {
    fs.mkdirSync(path.join(ctx.workerPaths.root, "hermes-home"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ctx.workerPaths.root, "hermes-home", "config.yaml"), "secret: no", { mode: 0o600 });

    const materializer = createAttachmentMaterializer({ cloudStore: ctx.cloudStore });
    const archived = materializer.archiveGeneratedAttachments({
      userId: ctx.alice.id,
      workerPaths: ctx.workerPaths,
      result: {
        content: "内部配置在 /data/hermes-home/config.yaml"
      }
    });

    assert.deepEqual(archived, []);
    assert.equal(
      redactGeneratedArtifactPaths("内部配置在 /data/hermes-home/config.yaml", archived),
      "内部配置在 内部文件"
    );
  } finally {
    ctx.cleanup();
  }
});
