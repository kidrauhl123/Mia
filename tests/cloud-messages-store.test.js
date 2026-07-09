const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { createMessagesStore } = require("../src/cloud/messages-store.js");
const { createCloudUser } = require("./helpers/cloud-auth.js");

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-msg-test-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  const db = cloudStore.getDb();
  const social = createSocialStore(db);
  const messages = createMessagesStore(db);
  const alice = createCloudUser(cloudStore, "alice");
  const bob = createCloudUser(cloudStore, "bob");
  social.createConversation({ id: "r-msg", name: null, avatar: null, hostMember: null, decorations: null, contextCard: null });
  social.addConversationMember({ conversationId: "r-msg", memberKind: "user", memberRef: alice.id, ownerId: null });
  social.addConversationMember({ conversationId: "r-msg", memberKind: "user", memberRef: bob.id, ownerId: null });
  return { cloudStore, social, messages, alice, bob, tmpDir };
}

function teardown(ctx) {
  ctx.cloudStore.close();
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

test("appendMessage assigns ascending per-conversation seq starting at 1", () => {
  const ctx = setup();
  try {
    const m1 = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "hi" });
    const m2 = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.bob.id, bodyMd: "yo" });
    const m3 = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "k" });
    assert.equal(m1.seq, 1);
    assert.equal(m2.seq, 2);
    assert.equal(m3.seq, 3);
    assert.notEqual(m1.id, m2.id);
  } finally { teardown(ctx); }
});

test("appendMessage seq is per-conversation not global", () => {
  const ctx = setup();
  try {
    ctx.social.createConversation({ id: "r-other", name: null, avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addConversationMember({ conversationId: "r-other", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "1" });
    const otherFirst = ctx.messages.appendMessage({ conversationId: "r-other", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "1" });
    assert.equal(otherFirst.seq, 1);
  } finally { teardown(ctx); }
});

test("listMessagesSince returns only seq > sinceSeq, ascending", () => {
  const ctx = setup();
  try {
    for (let i = 1; i <= 5; i++) {
      ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "m" + i });
    }
    const after2 = ctx.messages.listMessagesSince("r-msg", 2);
    assert.equal(after2.length, 3);
    assert.deepEqual(after2.map((m) => m.seq), [3, 4, 5]);
    assert.equal(after2[0].body_md, "m3");
    const after5 = ctx.messages.listMessagesSince("r-msg", 5);
    assert.equal(after5.length, 0);
    const all = ctx.messages.listMessagesSince("r-msg", 0);
    assert.equal(all.length, 5);
  } finally { teardown(ctx); }
});

test("listMessagesSince respects limit", () => {
  const ctx = setup();
  try {
    for (let i = 1; i <= 10; i++) {
      ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "m" + i });
    }
    const page = ctx.messages.listMessagesSince("r-msg", 0, 3);
    assert.equal(page.length, 3);
    assert.deepEqual(page.map((m) => m.seq), [1, 2, 3]);
  } finally { teardown(ctx); }
});

test("appendMessage persists attachments + mentions + turn_id", () => {
  const ctx = setup();
  try {
    const m = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "user",
      senderRef: ctx.alice.id,
      bodyMd: "@bob look",
      attachments: [{ kind: "image", path: "/x.png" }],
      mentions: [{ kind: "user", userId: ctx.bob.id }],
      turnId: "t-1",
    });
    assert.equal(m.turn_id, "t-1");
    const parsed = JSON.parse(m.attachments_json);
    assert.equal(parsed[0].kind, "image");
    const ments = JSON.parse(m.mentions_json);
    assert.equal(ments[0].userId, ctx.bob.id);
  } finally { teardown(ctx); }
});

test("appendMessage returns the existing bot reply for the same trigger", () => {
  const ctx = setup();
  try {
    const first = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "bot",
      senderRef: "bot_codex",
      senderOwnerId: ctx.alice.id,
      bodyMd: "first reply",
      triggerMessageId: "m_user_1",
      turnId: "t-1"
    });
    const duplicate = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "bot",
      senderRef: "bot_codex",
      senderOwnerId: ctx.alice.id,
      bodyMd: "late failure",
      triggerMessageId: "m_user_1",
      turnId: "t-1",
      errorJson: { stage: "engine", message: "failed after success" }
    });

    assert.equal(first.trigger_message_id, "m_user_1");
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.body_md, "first reply");
    assert.equal(duplicate._alreadyExisted, true);
    const rows = ctx.messages.listMessagesSince("r-msg", 0)
      .filter((message) => message.sender_kind === "bot" && message.sender_ref === "bot_codex");
    assert.equal(rows.length, 1);
  } finally { teardown(ctx); }
});

test("deleteMessage removes the row and returns it; missing id returns null", () => {
  const ctx = setup();
  try {
    const m1 = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "keep" });
    const m2 = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "drop" });
    const deleted = ctx.messages.deleteMessage(m2.id);
    assert.equal(deleted.id, m2.id);
    assert.equal(deleted.conversation_id, "r-msg");
    assert.equal(ctx.messages.getMessage(m2.id), null);
    // Surviving message is untouched; remaining list is just m1.
    assert.equal(ctx.messages.getMessage(m1.id).body_md, "keep");
    assert.deepEqual(ctx.messages.listMessagesSince("r-msg", 0).map((m) => m.id), [m1.id]);
    // Deleting an unknown id is a no-op returning null.
    assert.equal(ctx.messages.deleteMessage("m_nope"), null);
  } finally { teardown(ctx); }
});

test("hideMessageForUser hides a message for one viewer only; row survives", () => {
  const ctx = setup();
  try {
    const m1 = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "keep" });
    const m2 = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "bob hides this" });
    // Bob hides Alice's message from his own view; returns the row so the
    // caller can 404 on a missing id.
    const hidden = ctx.messages.hideMessageForUser("r-msg", m2.id, ctx.bob.id);
    assert.equal(hidden.id, m2.id);
    // Bob's view drops m2; Alice's view is untouched (local-delete semantics).
    assert.deepEqual(ctx.messages.listMessagesSince("r-msg", 0, 100, ctx.bob.id).map((m) => m.id), [m1.id]);
    assert.deepEqual(ctx.messages.listMessagesSince("r-msg", 0, 100, ctx.alice.id).map((m) => m.id), [m1.id, m2.id]);
    // No viewer → unfiltered (backward compatible with fellow-invocation context).
    assert.equal(ctx.messages.listMessagesSince("r-msg", 0).length, 2);
    // The row is NOT hard-deleted — hiding is per-user only.
    assert.equal(ctx.messages.getMessage(m2.id).body_md, "bob hides this");
  } finally { teardown(ctx); }
});

test("hideMessageForUser is idempotent; missing id returns null", () => {
  const ctx = setup();
  try {
    const m = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "x" });
    ctx.messages.hideMessageForUser("r-msg", m.id, ctx.bob.id);
    ctx.messages.hideMessageForUser("r-msg", m.id, ctx.bob.id);
    assert.equal(ctx.messages.listMessagesSince("r-msg", 0, 100, ctx.bob.id).length, 0);
    assert.equal(ctx.messages.hideMessageForUser("r-msg", "m_nope", ctx.bob.id), null);
  } finally { teardown(ctx); }
});

test("searchMessagesForUser searches only visible messages in joined conversations", () => {
  const ctx = setup();
  try {
    ctx.social.createConversation({ id: "r-alice-only", name: "Alice", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addConversationMember({ conversationId: "r-alice-only", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    const visible = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "user",
      senderRef: ctx.alice.id,
      bodyMd: "needle visible message"
    });
    const hidden = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "user",
      senderRef: ctx.alice.id,
      bodyMd: "needle hidden from bob"
    });
    ctx.messages.appendMessage({
      conversationId: "r-alice-only",
      senderKind: "user",
      senderRef: ctx.alice.id,
      bodyMd: "needle private alice"
    });
    ctx.messages.hideMessageForUser("r-msg", hidden.id, ctx.bob.id);

    const bobHits = ctx.messages.searchMessagesForUser(ctx.bob.id, "needle", 20);
    assert.deepEqual(bobHits.map((m) => m.id), [visible.id]);

    const aliceHits = ctx.messages.searchMessagesForUser(ctx.alice.id, "needle", 20);
    assert.equal(aliceHits.length, 3);
    assert.equal(aliceHits.some((m) => m.id === hidden.id), true);
  } finally { teardown(ctx); }
});

test("updateMessageStatus transitions streaming -> complete", () => {
  const ctx = setup();
  try {
    const m = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "fellow", senderRef: "codex", senderOwnerId: ctx.alice.id, bodyMd: "...", status: "streaming" });
    ctx.messages.updateMessageStatus(m.id, "complete");
    const fetched = ctx.messages.getMessage(m.id);
    assert.equal(fetched.status, "complete");
  } finally { teardown(ctx); }
});

test("appendMessage round-trips selected skill chips on the message", () => {
  const ctx = setup();
  try {
    const withSkills = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "user",
      senderRef: ctx.alice.id,
      bodyMd: "plan my trip",
      skills: [{ id: "trip-planner", name: "行程规划" }]
    });
    assert.equal(withSkills.skills_json, JSON.stringify([{ id: "trip-planner", name: "行程规划" }]));

    const noSkills = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "hi" });
    assert.equal(noSkills.skills_json, null);

    const emptySkills = ctx.messages.appendMessage({ conversationId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "hi", skills: [] });
    assert.equal(emptySkills.skills_json, null);
  } finally { teardown(ctx); }
});

test("appendMessage round-trips assistant trace data", () => {
  const ctx = setup();
  try {
    const message = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "fellow",
      senderRef: "codex",
      senderOwnerId: ctx.alice.id,
      bodyMd: "done",
      trace: {
        reasoning: "检查输入",
        tools: [{ id: "tool_1", name: "shell", preview: "ls", status: "completed", duration: 1.2 }]
      }
    });

    assert.deepEqual(JSON.parse(message.trace_json), {
      reasoning: "检查输入",
      tools: [{ id: "tool_1", name: "shell", preview: "ls", status: "completed", duration: 1.2, error: false }]
    });
  } finally { teardown(ctx); }
});

test("appendMessage round-trips ordered assistant content blocks", () => {
  const ctx = setup();
  try {
    const message = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "bot",
      senderRef: "codex",
      senderOwnerId: ctx.alice.id,
      bodyMd: "我先看目录。\n\n结论是已确认。",
      contentBlocks: [
        { type: "thinking", id: "think_1", text: "检查上下文", status: "completed", duration: 0.8 },
        { type: "text", id: "text_1", text: "我先看目录。" },
        { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" },
        { type: "text", id: "text_2", text: "结论是已确认。" }
      ]
    });

    assert.deepEqual(JSON.parse(message.content_blocks_json), [
      { type: "thinking", id: "think_1", status: "completed", duration: 0.8, text: "检查上下文" },
      { type: "text", id: "text_1", text: "我先看目录。" },
      {
        type: "tool",
        id: "tool_1",
        name: "shell",
        preview: "pwd",
        status: "completed",
        duration: null,
        error: false
      },
      { type: "text", id: "text_2", text: "结论是已确认。" }
    ]);

    const listed = ctx.messages.listMessagesSince("r-msg", 0);
    assert.equal(listed[0].content_blocks_json, message.content_blocks_json);

    const invalid = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "bot",
      senderRef: "codex",
      bodyMd: "plain",
      contentBlocks: [{ type: "text", text: " " }, { type: "tool" }]
    });
    assert.equal(invalid.content_blocks_json, null);
  } finally { teardown(ctx); }
});

test("appendMessage appends final body text to existing process content blocks", () => {
  const ctx = setup();
  try {
    const message = ctx.messages.appendMessage({
      conversationId: "r-msg",
      senderKind: "bot",
      senderRef: "codex",
      senderOwnerId: ctx.alice.id,
      bodyMd: "最终结论。",
      contentBlocks: [
        { type: "text", id: "text_1", text: "我先检查。" },
        { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" }
      ]
    });

    assert.deepEqual(JSON.parse(message.content_blocks_json), [
      { type: "text", id: "text_1", text: "我先检查。" },
      { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: null, error: false },
      { type: "text", id: "text_final_2", text: "最终结论。" }
    ]);
  } finally { teardown(ctx); }
});
