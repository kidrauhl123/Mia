const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-store-"));
  return {
    dataDir,
    dbPath: path.join(dataDir, "cloud.sqlite"),
    uploadDir: path.join(dataDir, "uploads")
  };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("sqlite store registers, logs in, authenticates, and logs out a user", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  try {
    const registered = store.registerUser({ username: "Alice", password: "secret1" });
    assert.equal(registered.user.username, "alice");
    assert.ok(registered.token);
        // Phase 4: workspace removed from auth response.

    const loggedIn = store.loginUser({ username: "ALICE", password: "secret1" });
    assert.ok(loggedIn.token);
    const auth = store.authenticateToken(loggedIn.token);
    assert.equal(auth.user.username, "alice");

    store.logoutSession(loggedIn.token);
    assert.equal(store.authenticateToken(loggedIn.token), null);
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});




test("sqlite store enforces file ownership", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  try {
    const alice = store.registerUser({ username: "alice", password: "secret1" }).user;
    const bob = store.registerUser({ username: "bob", password: "secret1" }).user;
    const saved = store.saveImageDataUrl(alice.id, {
      name: "dog.png",
      dataUrl: `data:image/png;base64,${Buffer.from("png-data").toString("base64")}`
    });
    assert.equal(saved.type, "image");
    assert.equal(saved.url, `/api/files/${saved.id}`);
    assert.ok(fs.existsSync(saved.path));

    assert.equal(store.getFileForUser(alice.id, saved.id).id, saved.id);
    assert.equal(store.getFileForUser(bob.id, saved.id), null);

    const localPath = path.join(paths.dataDir, "report.txt");
    fs.writeFileSync(localPath, "generated report", { mode: 0o600 });
    const generated = store.saveLocalFileForUser(alice.id, {
      path: localPath,
      name: "../report.txt",
      mimeType: "text/plain",
      type: "text"
    });
    assert.equal(generated.type, "text");
    assert.equal(generated.name, "report.txt");
    assert.equal(fs.readFileSync(generated.path, "utf8"), "generated report");
    assert.equal(store.getFileForUser(bob.id, generated.id), null);

    assert.throws(
      () => store.saveImageDataUrl(alice.id, {
        name: "script.svg",
        dataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64")}`
      }),
      /Unsupported image type/
    );
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("sqlite store records bridge devices and run lifecycle", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  try {
    const user = store.registerUser({ username: "bridge", password: "secret1" }).user;
    const device = store.upsertBridgeDevice(user.id, {
      id: "bridge_local",
      deviceName: "Mac Studio",
      engine: "codex",
      capabilities: { streaming: false, attachments: true }
    });
    assert.equal(device.deviceName, "Mac Studio");
    assert.deepEqual(store.listBridgeDevices(user.id).map((item) => item.id), ["bridge_local"]);

    const run = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "你好",
      attachments: [{ id: "req_1", type: "image", url: "/api/files/file_request" }]
    });
    assert.equal(run.status, "pending");
    assert.deepEqual(run.requestAttachments.map((item) => item.id), ["req_1"]);

    const running = store.startBridgeRun(user.id, run.id);
    assert.equal(running.status, "running");
    assert.deepEqual(running.requestAttachments.map((item) => item.id), ["req_1"]);

    const completed = store.completeBridgeRun(user.id, run.id, {
      text: "完成",
      attachments: [{ id: "att_1", type: "image", url: "/api/files/file_1" }]
    });
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.resultText, "完成");
    assert.deepEqual(completed.requestAttachments.map((item) => item.id), ["req_1"]);
    assert.deepEqual(completed.attachments.map((item) => item.id), ["att_1"]);
    assert.equal(store.listBridgeRuns(user.id)[0].id, run.id);
    assert.equal(store.cancelBridgeRun(user.id, run.id).status, "succeeded");
    assert.equal(store.failBridgeRun(user.id, run.id, "late failure").status, "succeeded");
    assert.equal(store.timeoutBridgeRun(user.id, run.id, "late timeout").status, "succeeded");

    const timeoutRun = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "超时"
    });
    const timedOut = store.timeoutBridgeRun(user.id, timeoutRun.id, "本机 Agent 响应超时。");
    assert.equal(timedOut.status, "timed_out");
    assert.match(timedOut.error, /超时/);

    const cancelRun = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "取消"
    });
    const cancelled = store.cancelBridgeRun(user.id, cancelRun.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(store.completeBridgeRun(user.id, cancelRun.id, { text: "late success" }).status, "cancelled");
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("sqlite store clears volatile bridge state after reopening", () => {
  const paths = tempStore();
  let userId = "";
  let runningRunId = "";
  let pendingRunId = "";
  let store = createCloudStore({
    ...paths,
    now: () => "2026-05-21T00:00:00.000Z"
  });
  try {
    const user = store.registerUser({ username: "restart", password: "secret1" }).user;
    userId = user.id;
    const device = store.upsertBridgeDevice(user.id, {
      id: "bridge_restart",
      deviceName: "Mac",
      engine: "codex"
    });
    assert.equal(store.listBridgeDevices(user.id).length, 1);

    const runningRun = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "running"
    });
    runningRunId = runningRun.id;
    store.startBridgeRun(user.id, runningRun.id);
    pendingRunId = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_mia",
      text: "pending"
    }).id;
  } finally {
    store.close();
  }

  store = createCloudStore({
    ...paths,
    now: () => "2026-05-21T00:01:00.000Z"
  });
  try {
    assert.deepEqual(store.listBridgeDevices(userId), []);
    const running = store.getBridgeRun(userId, runningRunId);
    const pending = store.getBridgeRun(userId, pendingRunId);
    assert.equal(running.status, "failed");
    assert.equal(pending.status, "failed");
    assert.match(running.error, /已重启/);
    assert.equal(running.completedAt, "2026-05-21T00:01:00.000Z");
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("sqlite store rate limits repeated failed logins per account and ip", () => {
  const paths = tempStore();
  const store = createCloudStore({
    ...paths,
    loginRateLimit: { maxFailures: 2, windowMs: 60_000 }
  });
  try {
    store.registerUser({ username: "limited", password: "secret1" });
    assert.throws(
      () => store.loginUser({ username: "limited", password: "wrong", ip: "10.0.0.1" }),
      /用户名或密码不正确/
    );
    assert.throws(
      () => store.loginUser({ username: "limited", password: "wrong", ip: "10.0.0.1" }),
      /用户名或密码不正确/
    );
    assert.throws(
      () => store.loginUser({ username: "limited", password: "secret1", ip: "10.0.0.1" }),
      /登录尝试过多/
    );

    const loggedIn = store.loginUser({ username: "limited", password: "secret1", ip: "10.0.0.2" });
    assert.ok(loggedIn.token);
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("schema v2 creates social tables and indexes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-schema-test-"));
  const store = createCloudStore({ dataDir: tmpDir });
  try {
    const db = store.getDb();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
    for (const t of ["friendships", "friend_requests", "conversations", "conversation_members", "messages"]) {
      assert.ok(tables.includes(t), `missing table: ${t}`);
    }
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`).all().map((r) => r.name);
    for (const i of ["idx_friend_requests_to", "idx_friend_requests_code", "idx_conversation_members_user", "idx_messages_conversation_seq"]) {
      assert.ok(idx.includes(i), `missing index: ${i}`);
    }
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
    assert.ok(version >= 2, `schema_migrations max version should be >= 2, got ${version}`);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
