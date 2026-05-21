const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-cloud-store-"));
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
    assert.equal(registered.workspace.activeConversationId, "conv_aimashi");

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

test("sqlite store persists workspace revisions across reopen", () => {
  const paths = tempStore();
  let store = createCloudStore(paths);
  try {
    const registered = store.registerUser({ username: "bob", password: "secret1" });
    const first = store.getWorkspace(registered.user.id);
    const next = store.putWorkspace(registered.user.id, {
      ...first,
      activeConversationId: "conv_custom",
      conversations: [{ id: "conv_custom", title: "自定义", messages: [] }]
    });
    assert.equal(next.revision, first.revision + 1);
    store.close();

    store = createCloudStore(paths);
    const reopened = store.getWorkspace(registered.user.id);
    assert.equal(reopened.activeConversationId, "conv_custom");
    assert.equal(reopened.revision, next.revision);
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("sqlite store keeps contacts skills and workbench scoped per account", () => {
  const paths = tempStore();
  let store = createCloudStore(paths);
  try {
    const alice = store.registerUser({ username: "alice", password: "secret1" }).user;
    const bob = store.registerUser({ username: "bob", password: "secret1" }).user;
    const aliceWorkspace = store.getWorkspace(alice.id);
    store.putWorkspace(alice.id, {
      ...aliceWorkspace,
      contacts: [{ id: "contact_alice", title: "Alice Fellow" }],
      skills: [{ id: "skill_alice", title: "Alice Skill" }],
      workbench: [{ id: "task_alice", title: "Alice Task" }]
    });

    const bobWorkspace = store.getWorkspace(bob.id);
    assert.equal(bobWorkspace.contacts.some((item) => item.id === "contact_alice"), false);
    assert.equal(bobWorkspace.skills.some((item) => item.id === "skill_alice"), false);
    assert.equal(bobWorkspace.workbench.some((item) => item.id === "task_alice"), false);
    store.close();

    store = createCloudStore(paths);
    const reopenedAlice = store.getWorkspace(alice.id);
    assert.deepEqual(reopenedAlice.contacts, [{ id: "contact_alice", title: "Alice Fellow" }]);
    assert.deepEqual(reopenedAlice.skills, [{ id: "skill_alice", title: "Alice Skill" }]);
    assert.deepEqual(reopenedAlice.workbench, [{ id: "task_alice", title: "Alice Task" }]);
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});

test("sqlite store appends to an explicit new conversation id", () => {
  const paths = tempStore();
  const store = createCloudStore(paths);
  try {
    const user = store.registerUser({ username: "newconv", password: "secret1" }).user;
    const appended = store.appendMessage(user.id, {
      conversationId: "desktop_new_session",
      message: {
        id: "msg_new",
        role: "user",
        text: "桌面端新会话",
        createdAt: "2026-05-20T00:00:00.000Z",
        attachments: []
      }
    });
    const conversation = appended.workspace.conversations.find((item) => item.id === "desktop_new_session");
    assert.equal(conversation.title, "桌面端新会话");
    assert.equal(conversation.messages.at(-1).id, "msg_new");
    assert.equal(appended.workspace.activeConversationId, "desktop_new_session");
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
      conversationId: "conv_aimashi",
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
      conversationId: "conv_aimashi",
      text: "超时"
    });
    const timedOut = store.timeoutBridgeRun(user.id, timeoutRun.id, "本机 Agent 响应超时。");
    assert.equal(timedOut.status, "timed_out");
    assert.match(timedOut.error, /超时/);

    const cancelRun = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_aimashi",
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
      conversationId: "conv_aimashi",
      text: "running"
    });
    runningRunId = runningRun.id;
    store.startBridgeRun(user.id, runningRun.id);
    pendingRunId = store.createBridgeRun(user.id, {
      deviceId: device.id,
      conversationId: "conv_aimashi",
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

test("sqlite store imports existing legacy cloud json on first open", () => {
  const paths = tempStore();
  const legacyJsonPath = path.join(paths.dataDir, "cloud.json");
  fs.writeFileSync(legacyJsonPath, JSON.stringify({
    users: {
      legacy: {
        id: "user_legacy",
        username: "legacy",
        email: "",
        createdAt: "2026-05-20T00:00:00.000Z",
        passwordSalt: "salt",
        passwordHash: "hash"
      }
    },
    sessions: {
      session_hash: {
        userId: "user_legacy",
        createdAt: "2026-05-20T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    },
    workspaces: {
      user_legacy: {
        revision: 7,
        activeConversationId: "conv_legacy",
        conversations: [{ id: "conv_legacy", title: "旧会话", messages: [] }]
      }
    },
    files: {
      file_legacy: {
        id: "file_legacy",
        userId: "user_legacy",
        name: "old.png",
        mimeType: "image/png",
        path: path.join(paths.uploadDir, "user_legacy", "file_legacy.png"),
        createdAt: "2026-05-20T00:00:00.000Z"
      }
    }
  }), "utf8");

  const store = createCloudStore(paths);
  try {
    assert.equal(store.getWorkspace("user_legacy").activeConversationId, "conv_legacy");
    const auth = store.authenticateToken("not-the-token");
    assert.equal(auth, null);
    assert.equal(store.getFileForUser("user_legacy", "file_legacy").name, "old.png");
  } finally {
    store.close();
    cleanup(paths.dataDir);
  }
});
