const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { createBotsStore } = require("../src/cloud/bots-store.js");
const { createRuntimeBindingsStore } = require("../src/cloud-agent/runtime-bindings-store.js");
const { DEFAULT_CLOUD_BOT_ID, ensureDefaultCloudBot } = require("../src/cloud-agent/default-bot.js");
const { normalizeBotCapabilities } = require("../src/shared/bot-identity.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshStores() {
  const dir = tempDir("mia-default-bot-");
  const cloudStore = createCloudStore({ dataDir: dir });
  const db = cloudStore.getDb();
  const socialStore = createSocialStore(db);
  const botsStore = createBotsStore(db);
  socialStore._attachBotsStore(botsStore);
  const runtimeBindingsStore = createRuntimeBindingsStore(db);
  return {
    dir,
    db,
    cloudStore,
    socialStore,
    botsStore,
    runtimeBindingsStore,
    cleanup() {
      cloudStore.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("ensureDefaultCloudBot creates bot, binding, conversation, and members idempotently", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "alice", password: "123456" });
    const out1 = ensureDefaultCloudBot(ctx, account.user.id);
    const out2 = ensureDefaultCloudBot(ctx, account.user.id);

    assert.equal(DEFAULT_CLOUD_BOT_ID, "bot_mia");
    assert.equal(out1.bot.id, "bot_mia");
    assert.equal(out1.bot.ownerUserId, account.user.id);
    assert.equal(out1.bot.displayName, "Mia");
    assert.equal(out1.bot.bio, "Mia Bot");
    assert.equal(out1.bot.personaText, "You are Mia.");
    assert.match(out1.conversation.id, /^botc_/);
    assert.equal(out1.conversation.type, "bot");
    assert.deepEqual(out1.conversation.decorations, { botId: "bot_mia", runtimeKind: "cloud-hermes" });
    assert.equal(out2.conversation.id, out1.conversation.id);
    assert.equal(out2.conversation.updatedAt, out1.conversation.updatedAt);

    const binding = ctx.runtimeBindingsStore.getEnabledBinding(account.user.id, "bot_mia", "cloud-hermes");
    assert.equal(binding.runtimeKind, "cloud-hermes");

    const conversations = ctx.socialStore.listConversationsForUser(account.user.id)
      .filter((conversation) => conversation.id === out1.conversation.id);
    assert.equal(conversations.length, 1);

    const members = ctx.socialStore.listConversationMembers(out1.conversation.id);
    assert.deepEqual(members.map((m) => m.member_kind).sort(), ["bot", "user"]);
    assert.equal(members.find((m) => m.member_kind === "bot").owner_id, account.user.id);
  } finally {
    ctx.cleanup();
  }
});

test("ensureDefaultCloudBot preserves an existing default bot identity", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "carol", password: "123456" });
    ctx.botsStore.upsertBot(account.user.id, {
      id: "bot_mia",
      displayName: "My Cloud Pal",
      color: "#111111",
      bio: "custom bio",
      capabilities: ["chat"],
      personaText: "custom persona"
    });

    const out = ensureDefaultCloudBot(ctx, account.user.id);

    assert.equal(out.bot.displayName, "My Cloud Pal");
    assert.equal(out.bot.bio, "custom bio");
    assert.deepEqual(out.bot.capabilities, normalizeBotCapabilities(["chat"]));
    assert.equal(out.bot.personaText, "custom persona");
  } finally {
    ctx.cleanup();
  }
});

test("ensureDefaultCloudBot backfills missing cloud runtimeKind on default bot conversations", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "dave", password: "123456" });
    const conversationId = `botc_${account.user.id}_bot_mia`;
    ctx.socialStore.createConversation({
      id: conversationId,
      type: "bot",
      name: "Legacy Mia",
      decorations: { botId: "bot_mia", pinnedGoal: "keep me" }
    });

    const out = ensureDefaultCloudBot(ctx, account.user.id);

    assert.equal(out.conversation.decorations.runtimeKind, "cloud-hermes");
    assert.equal(out.conversation.decorations.pinnedGoal, "keep me");
  } finally {
    ctx.cleanup();
  }
});

test("ensureDefaultCloudBot does not override an explicit desktop-local runtimeKind", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "erin", password: "123456" });
    const conversationId = `botc_${account.user.id}_bot_mia`;
    ctx.socialStore.createConversation({
      id: conversationId,
      type: "bot",
      name: "Local Mia",
      decorations: { botId: "bot_mia", runtimeKind: "desktop-local" }
    });

    const out = ensureDefaultCloudBot(ctx, account.user.id);

    assert.equal(out.conversation.decorations.runtimeKind, "desktop-local");
  } finally {
    ctx.cleanup();
  }
});

test("default cloud bot conversation is visible through conversation listing", () => {
  const ctx = freshStores();
  try {
    const account = ctx.cloudStore.registerUser({ username: "bob", password: "123456" });
    const out = ensureDefaultCloudBot(ctx, account.user.id);
    const listed = ctx.socialStore.listConversationsForUser(account.user.id);
    assert.ok(listed.some((conversation) => conversation.id === out.conversation.id && conversation.type === "bot"));
  } finally {
    ctx.cleanup();
  }
});
