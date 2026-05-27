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
const { createMiaCloudServer } = require("../scripts/serve-cloud.js");

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
  const dir = tempDir("mia-default-fellow-");
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

test("ensureDefaultCloudFellow creates fellow, binding, conversation, and members idempotently", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "alice", password: "123456" });
    const out1 = ensureDefaultCloudFellow(ctx, account.user.id);
    const out2 = ensureDefaultCloudFellow(ctx, account.user.id);

    assert.equal(out1.fellow.id, "mia");
    assert.equal(out1.fellow.bio, "Mia Fellow");
    assert.doesNotMatch(out1.fellow.personaText, /云端 Agent|本地运行/);
    assert.equal(out1.conversation.id, `fellow:${account.user.id}:mia`);
    assert.equal(out1.conversation.type, "fellow");
    assert.equal(out2.conversation.id, out1.conversation.id);

    const binding = ctx.runtimeBindingsStore.getEnabledBinding(account.user.id, "mia", "cloud-hermes");
    assert.equal(binding.runtimeKind, "cloud-hermes");

    const conversations = ctx.socialStore.listConversationsForUser(account.user.id)
      .filter((conversation) => conversation.id === out1.conversation.id);
    assert.equal(conversations.length, 1);

    const members = ctx.socialStore.listConversationMembers(out1.conversation.id);
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
      id: "mia",
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

test("ensureDefaultCloudFellow backfills missing cloud runtimeKind on legacy default conversations", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "dave", password: "123456" });
    const conversationId = `fellow:${account.user.id}:mia`;
    ctx.socialStore.createConversation({
      id: conversationId,
      type: "fellow",
      name: "Legacy Mia",
      decorations: { fellowKey: "mia", sessionId: "mia", pinnedGoal: "keep me" }
    });

    const out = ensureDefaultCloudFellow(ctx, account.user.id);

    assert.equal(out.conversation.decorations.runtimeKind, "cloud-hermes");
    assert.equal(out.conversation.decorations.pinnedGoal, "keep me");
  } finally {
    ctx.cleanup();
  }
});

test("ensureDefaultCloudFellow does not override an explicit desktop-local runtimeKind", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "erin", password: "123456" });
    const conversationId = `fellow:${account.user.id}:mia`;
    ctx.socialStore.createConversation({
      id: conversationId,
      type: "fellow",
      name: "Local Mia",
      decorations: { fellowKey: "mia", sessionId: "mia", runtimeKind: "desktop-local" }
    });

    const out = ensureDefaultCloudFellow(ctx, account.user.id);

    assert.equal(out.conversation.decorations.runtimeKind, "desktop-local");
  } finally {
    ctx.cleanup();
  }
});

test("registration makes default cloud fellow conversation visible through /api/conversations", async () => {
  const dataDir = tempDir("mia-default-fellow-http-");
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = await jsonFetch(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "bob", password: "123456" }
    });
    const listed = await jsonFetch(baseUrl, "/api/conversations", {
      headers: { authorization: `Bearer ${account.token}` }
    });
    const conversationId = `fellow:${account.user.id}:mia`;
    assert.ok(listed.conversations.some((conversation) => conversation.id === conversationId && conversation.type === "fellow"));
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
