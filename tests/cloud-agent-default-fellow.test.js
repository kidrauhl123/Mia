const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { createFellowsStore } = require("../src/cloud/fellows-store.js");
const { createRuntimeBindingsStore } = require("../src/cloud-agent/runtime-bindings-store.js");
const { ensureDefaultCloudFellow } = require("../src/cloud-agent/default-fellow.js");
const { createAimashiCloudServer } = require("../scripts/serve-cloud.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function jsonFetch(baseUrl, requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function freshStores() {
  const dir = tempDir("aimashi-default-fellow-");
  const cloudStore = createCloudStore({ dataDir: dir });
  const db = cloudStore.getDb();
  const socialStore = createSocialStore(db);
  const fellowsStore = createFellowsStore(db);
  socialStore._attachFellowsStore(fellowsStore);
  const runtimeBindingsStore = createRuntimeBindingsStore(db);
  return {
    dir,
    db,
    cloudStore,
    socialStore,
    fellowsStore,
    runtimeBindingsStore,
    cleanup() {
      cloudStore.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("ensureDefaultCloudFellow creates fellow, binding, room, and members idempotently", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "alice", password: "123456" });
    const out1 = ensureDefaultCloudFellow(ctx, account.user.id);
    const out2 = ensureDefaultCloudFellow(ctx, account.user.id);

    assert.equal(out1.fellow.id, "aimashi");
    assert.equal(out1.room.id, `fellow:${account.user.id}:aimashi`);
    assert.equal(out1.room.type, "fellow");
    assert.equal(out2.room.id, out1.room.id);

    const binding = ctx.runtimeBindingsStore.getEnabledBinding(account.user.id, "aimashi", "cloud-hermes");
    assert.equal(binding.runtimeKind, "cloud-hermes");

    const rooms = ctx.socialStore.listRoomsForUser(account.user.id)
      .filter((room) => room.id === out1.room.id);
    assert.equal(rooms.length, 1);

    const members = ctx.socialStore.listRoomMembers(out1.room.id);
    assert.deepEqual(members.map((m) => m.member_kind).sort(), ["fellow", "user"]);
    assert.equal(members.find((m) => m.member_kind === "fellow").owner_id, account.user.id);
  } finally {
    ctx.cleanup();
  }
});

test("ensureDefaultCloudFellow preserves an existing default fellow identity", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "carol", password: "123456" });
    ctx.fellowsStore.upsertFellow(account.user.id, {
      id: "aimashi",
      name: "My Cloud Pal",
      color: "#111111",
      bio: "custom bio",
      capabilities: ["chat"],
      personaText: "custom persona"
    });

    const out = ensureDefaultCloudFellow(ctx, account.user.id);

    assert.equal(out.fellow.name, "My Cloud Pal");
    assert.equal(out.fellow.bio, "custom bio");
    assert.deepEqual(out.fellow.capabilities, ["chat"]);
    assert.equal(out.fellow.personaText, "custom persona");
  } finally {
    ctx.cleanup();
  }
});

test("ensureDefaultCloudFellow backfills missing cloud runtimeKind on legacy default rooms", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "dave", password: "123456" });
    const roomId = `fellow:${account.user.id}:aimashi`;
    ctx.socialStore.createRoom({
      id: roomId,
      type: "fellow",
      name: "Legacy Aimashi",
      decorations: { fellowKey: "aimashi", sessionId: "aimashi", pinnedGoal: "keep me" }
    });

    const out = ensureDefaultCloudFellow(ctx, account.user.id);

    assert.equal(out.room.decorations.runtimeKind, "cloud-hermes");
    assert.equal(out.room.decorations.pinnedGoal, "keep me");
  } finally {
    ctx.cleanup();
  }
});

test("ensureDefaultCloudFellow does not override an explicit desktop-local runtimeKind", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "erin", password: "123456" });
    const roomId = `fellow:${account.user.id}:aimashi`;
    ctx.socialStore.createRoom({
      id: roomId,
      type: "fellow",
      name: "Local Aimashi",
      decorations: { fellowKey: "aimashi", sessionId: "aimashi", runtimeKind: "desktop-local" }
    });

    const out = ensureDefaultCloudFellow(ctx, account.user.id);

    assert.equal(out.room.decorations.runtimeKind, "desktop-local");
  } finally {
    ctx.cleanup();
  }
});

test("registration makes default cloud fellow room visible through /api/rooms", async () => {
  const dataDir = tempDir("aimashi-default-fellow-http-");
  const server = createAimashiCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "bob", password: "123456" }
    });
    const listed = await jsonFetch(baseUrl, "/api/rooms", {
      headers: { authorization: `Bearer ${account.token}` }
    });
    const roomId = `fellow:${account.user.id}:aimashi`;
    assert.ok(listed.rooms.some((room) => room.id === roomId && room.type === "fellow"));
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
