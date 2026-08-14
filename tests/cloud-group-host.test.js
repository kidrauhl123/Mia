const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { ensureGroupHost } = require("../src/cloud/group-host.js");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-group-host-"));
  const cloudStore = createCloudStore({ dataDir: dir });
  const socialStore = createSocialStore(cloudStore.getDb());
  return {
    cloudStore,
    socialStore,
    cleanup() {
      cloudStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("ensureGroupHost persists the first Bot for a legacy group", () => {
  const ctx = setup();
  try {
    ctx.socialStore.createConversation({ id: "g_legacy", type: "group", name: "Legacy" });
    ctx.socialStore.addConversationMember({ conversationId: "g_legacy", memberKind: "user", memberRef: "user_1" });
    ctx.socialStore.addConversationMember({ conversationId: "g_legacy", memberKind: "bot", memberRef: "bot_first", ownerId: "user_1" });
    ctx.socialStore.addConversationMember({ conversationId: "g_legacy", memberKind: "bot", memberRef: "bot_second", ownerId: "user_1" });

    const result = ensureGroupHost(ctx.socialStore, "g_legacy");

    assert.equal(result.member.member_ref, "bot_first");
    assert.deepEqual(ctx.socialStore.getConversation("g_legacy").decorations.hostMember, {
      kind: "bot",
      botId: "bot_first"
    });
  } finally {
    ctx.cleanup();
  }
});

test("ensureGroupHost preserves a valid host and repairs one that leaves", () => {
  const ctx = setup();
  try {
    ctx.socialStore.createConversation({
      id: "g_hosted",
      type: "group",
      name: "Hosted",
      decorations: { pinned: true, hostMember: { kind: "bot", botId: "bot_second" } }
    });
    ctx.socialStore.addConversationMember({ conversationId: "g_hosted", memberKind: "bot", memberRef: "bot_first", ownerId: "user_1" });
    ctx.socialStore.addConversationMember({ conversationId: "g_hosted", memberKind: "bot", memberRef: "bot_second", ownerId: "user_1" });

    assert.equal(ensureGroupHost(ctx.socialStore, "g_hosted").member.member_ref, "bot_second");
    ctx.socialStore.removeConversationMember("g_hosted", "bot", "bot_second");
    assert.equal(ensureGroupHost(ctx.socialStore, "g_hosted").member.member_ref, "bot_first");
    assert.deepEqual(ctx.socialStore.getConversation("g_hosted").decorations, {
      pinned: true,
      hostMember: { kind: "bot", botId: "bot_first" }
    });
  } finally {
    ctx.cleanup();
  }
});

test("ensureGroupHost clears a legacy host after the last Bot leaves", () => {
  const ctx = setup();
  try {
    ctx.socialStore.createConversation({
      id: "g_empty",
      type: "group",
      name: "Empty",
      hostMember: { kind: "bot", botId: "bot_old" }
    });
    ctx.socialStore.addConversationMember({ conversationId: "g_empty", memberKind: "bot", memberRef: "bot_old", ownerId: "user_1" });
    ctx.socialStore.removeConversationMember("g_empty", "bot", "bot_old");

    assert.equal(ensureGroupHost(ctx.socialStore, "g_empty").member, null);
    assert.equal(ctx.socialStore.getConversation("g_empty").decorations.hostMember, null);
    assert.equal(ensureGroupHost(ctx.socialStore, "g_empty").member, null);
  } finally {
    ctx.cleanup();
  }
});
