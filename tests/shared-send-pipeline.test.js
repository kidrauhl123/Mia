const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  prepareOutgoingMessage,
  parseMentions,
  generateClientTraceId,
  clientOpIdForTraceId,
  MemberKind,
  DEFAULT_MAX_LENGTH
} = require("../src/shared/send-pipeline");

const members = [
  { ref: "bot_codex", name: "Codex", kind: MemberKind.Bot },
  { ref: "bot_claude", name: "Claude", kind: MemberKind.Bot },
  { ref: "user_alice", name: "Alice", kind: MemberKind.User }
];

test("MemberKind exposes bot and user", () => {
  assert.equal(MemberKind.Bot, "bot");
  assert.equal(MemberKind.User, "user");
});

test("throws on empty text with no attachments", () => {
  assert.throws(
    () => prepareOutgoingMessage({ text: "" }, {}),
    (err) => err.code === "EMPTY_MESSAGE"
  );
  assert.throws(
    () => prepareOutgoingMessage({ text: "   \n\t  " }, {}),
    (err) => err.code === "EMPTY_MESSAGE"
  );
  assert.throws(
    () => prepareOutgoingMessage({}, {}),
    (err) => err.code === "EMPTY_MESSAGE"
  );
});

test("allows empty text when attachments present", () => {
  const out = prepareOutgoingMessage(
    { text: "", attachments: [{ id: "a1" }] },
    {}
  );
  assert.equal(out.bodyMd, "");
  assert.deepEqual(out.attachments, [{ id: "a1" }]);
  assert.deepEqual(out.mentions, []);
  assert.match(out.clientTraceId, /^c_\d+_[0-9a-z]{6}$/);
});

test("plain text is trimmed and returns empty mentions", () => {
  const out = prepareOutgoingMessage({ text: "  hello world  " }, { members });
  assert.equal(out.bodyMd, "hello world");
  assert.deepEqual(out.mentions, []);
  assert.deepEqual(out.attachments, []);
});

test("parses @ref mention against member ref (social-groups style)", () => {
  const out = prepareOutgoingMessage({ text: "@bot_codex hello" }, { members });
  assert.deepEqual(out.mentions, [{ kind: MemberKind.Bot, ref: "bot_codex" }]);
});

test("parses @name mention against member name (case-insensitive, group-prompts style)", () => {
  const out = prepareOutgoingMessage({ text: "hi @Codex and @ALICE" }, { members });
  assert.deepEqual(out.mentions, [
    { kind: MemberKind.Bot, ref: "bot_codex" },
    { kind: MemberKind.User, ref: "user_alice" }
  ]);
});

test("respects \\@ escape", () => {
  const out = prepareOutgoingMessage({ text: "literal \\@codex not a mention" }, { members });
  assert.deepEqual(out.mentions, []);
});

test("ignores unknown mentions", () => {
  const out = prepareOutgoingMessage({ text: "@nobody hello @bot_codex" }, { members });
  assert.deepEqual(out.mentions, [{ kind: MemberKind.Bot, ref: "bot_codex" }]);
});

test("dedupes repeated mentions", () => {
  const out = prepareOutgoingMessage({ text: "@codex @codex @Codex hi" }, { members });
  assert.deepEqual(out.mentions, [{ kind: MemberKind.Bot, ref: "bot_codex" }]);
});

test("supports CJK mention names", () => {
  const cjkMembers = [{ ref: "bot_x", name: "助手", kind: MemberKind.Bot }];
  const out = prepareOutgoingMessage({ text: "你好 @助手 在吗" }, { members: cjkMembers });
  assert.deepEqual(out.mentions, [{ kind: MemberKind.Bot, ref: "bot_x" }]);
});

test("throws when over max length", () => {
  const long = "a".repeat(DEFAULT_MAX_LENGTH + 1);
  assert.throws(
    () => prepareOutgoingMessage({ text: long }, {}),
    (err) => err.code === "MESSAGE_TOO_LONG"
  );
});

test("respects custom maxLength in ctx", () => {
  assert.throws(
    () => prepareOutgoingMessage({ text: "hello" }, { maxLength: 3 }),
    (err) => err.code === "MESSAGE_TOO_LONG"
  );
  const out = prepareOutgoingMessage({ text: "hi" }, { maxLength: 3 });
  assert.equal(out.bodyMd, "hi");
});

test("clientTraceId is unique across calls", () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    const out = prepareOutgoingMessage({ text: `msg ${i}` }, {});
    ids.add(out.clientTraceId);
  }
  assert.equal(ids.size, 100);
});

test("clientTraceId has expected shape", () => {
  const id = generateClientTraceId();
  assert.match(id, /^c_\d+_[0-9a-z]{6}$/);
});

test("clientOpId is stable for a prepared message trace", () => {
  const out = prepareOutgoingMessage({ text: "retry me" }, {});
  assert.equal(out.clientOpId, `op_${out.clientTraceId}`);
  assert.equal(clientOpIdForTraceId(out.clientTraceId), out.clientOpId);
});

test("preserves attachments as-is (no validation)", () => {
  const attachments = [
    { id: "a1", path: "/tmp/x", weirdField: 42 },
    { id: "a2" }
  ];
  const out = prepareOutgoingMessage({ text: "see attached", attachments }, {});
  assert.deepEqual(out.attachments, attachments);
  // confirm shallow copy: same elements, different array identity
  assert.notEqual(out.attachments, attachments);
});

test("preserves replyTo when present", () => {
  const out = prepareOutgoingMessage(
    { text: "yes", replyTo: "msg_123" },
    {}
  );
  assert.equal(out.replyTo, "msg_123");
});

test("parseMentions exported directly", () => {
  const out = parseMentions("hi @bot_codex", members);
  assert.deepEqual(out, [{ kind: MemberKind.Bot, ref: "bot_codex" }]);
});

test("parseMentions returns [] when no members", () => {
  assert.deepEqual(parseMentions("@codex hi", []), []);
  assert.deepEqual(parseMentions("@codex hi", null), []);
});

test("parseMentions ignores unsupported member kinds", () => {
  const unsupported = [{ member_ref: "bot_old", member_kind: "fellow" }];
  assert.deepEqual(parseMentions("@bot_old hi", unsupported), []);
});

test("members accept explicit bot/user shapes", () => {
  const explicit = [
    { member_ref: "bot_codex", name: "Codex", member_kind: "bot" },
    { botId: "bot_claude", name: "Claude", kind: "bot" },
    { id: "user_bob", name: "Bob", kind: "user" }
  ];
  const out = prepareOutgoingMessage(
    { text: "@bot_codex @bot_claude @bob" },
    { members: explicit }
  );
  assert.deepEqual(out.mentions, [
    { kind: MemberKind.Bot, ref: "bot_codex" },
    { kind: MemberKind.Bot, ref: "bot_claude" },
    { kind: MemberKind.User, ref: "user_bob" }
  ]);
});

test("members accept raw cloud conversation shapes used by web and mobile", () => {
  const rawMembers = [
    {
      member_kind: "bot",
      member_ref: "bot_mia",
      bot_name: "Mia助手",
      identity: { kind: "bot", id: "bot_mia", displayName: "Mia助手" }
    },
    {
      member_kind: "user",
      member_ref: "user_alice",
      identity: { kind: "user", id: "user_alice", displayName: "小艾" }
    }
  ];
  assert.deepEqual(parseMentions("@Mia助手 @小艾", rawMembers), [
    { kind: MemberKind.Bot, ref: "bot_mia" },
    { kind: MemberKind.User, ref: "user_alice" }
  ]);
});

test("parseMentions does not infer stale key-only or missing-kind members", () => {
  const stale = [
    { key: "codex", name: "Codex" },
    { botId: "bot_claude", name: "Claude" },
    { id: "user_bob", name: "Bob" }
  ];
  assert.deepEqual(parseMentions("@codex @bot_claude @bob", stale), []);
});

test("attaches to globalThis as miaSendPipeline (IIFE double-source)", () => {
  // The module already ran via require above. Verify the global attach worked.
  assert.ok(globalThis.miaSendPipeline);
  assert.equal(typeof globalThis.miaSendPipeline.prepareOutgoingMessage, "function");
});
