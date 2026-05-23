const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const sharedContact = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "contact.js"), "utf8");
  const responseModeSrc = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "group", "response-mode.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "group-dispatch.js"), "utf8");
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, module: { exports: {} }, console });
  vm.runInContext("globalThis.aimashiContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", ctx);
  vm.runInContext(responseModeSrc, ctx);
  vm.runInContext(src, ctx);
  return window.aimashiGroupDispatch;
}

test("MentionsOnly mode: returns only mentioned fellows owned by me", async () => {
  const mod = load();
  const fakeConductor = { decideDispatch: () => { throw new Error("should not be called"); } };
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "mentions-only" } },
    members: [
      { member_kind: "fellow", member_ref: "codex", owner_id: "user_me" },
      { member_kind: "fellow", member_ref: "claude", owner_id: "user_friend" }
    ],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "user", sender_ref: "user_friend", body_md: "@codex hi", mentions: [{ kind: "fellow", fellowId: "codex" }], turn_id: "t1" },
    conductor: fakeConductor
  });
  assert.deepEqual(Array.from(result.speak), ["codex"]);
});

test("Conductor mode: asks decideDispatch with my fellows only", async () => {
  const mod = load();
  let received = null;
  const conductor = { decideDispatch: (args) => { received = args; return { speak: ["codex"] }; } };
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [
      { member_kind: "fellow", member_ref: "codex", owner_id: "user_me" },
      { member_kind: "fellow", member_ref: "claude", owner_id: "user_friend" }
    ],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "user", sender_ref: "user_friend", body_md: "anyone?", mentions: [], turn_id: "t2" },
    conductor
  });
  assert.deepEqual(Array.from(received.members).map((m) => m.member_ref), ["codex"]);
  assert.deepEqual(Array.from(result.speak), ["codex"]);
});

test("Guard: own user message → no dispatch", async () => {
  const mod = load();
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [{ member_kind: "fellow", member_ref: "codex", owner_id: "user_me" }],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "user", sender_ref: "user_me", body_md: "x", turn_id: "t3" },
    conductor: { decideDispatch: () => ({ speak: ["codex"] }) }
  });
  assert.deepEqual(Array.from(result.speak), []);
  assert.equal(result.skipped, "own-message");
});

test("Guard: fellow sender → no dispatch (no fellow→fellow auto-relay)", async () => {
  const mod = load();
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [{ member_kind: "fellow", member_ref: "codex", owner_id: "user_me" }],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "fellow", sender_ref: "claude", body_md: "x", turn_id: "t4" },
    conductor: { decideDispatch: () => ({ speak: ["codex"] }) }
  });
  assert.deepEqual(Array.from(result.speak), []);
});

test("Guard: turn_id dedup", async () => {
  const mod = load();
  const seen = new Set(["t5"]);
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [{ member_kind: "fellow", member_ref: "codex", owner_id: "user_me" }],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "user", sender_ref: "user_friend", body_md: "x", turn_id: "t5" },
    seenTurnIds: seen,
    conductor: { decideDispatch: () => ({ speak: ["codex"] }) }
  });
  assert.deepEqual(Array.from(result.speak), []);
  assert.equal(result.skipped, "duplicate-turn");
});

test("Guard: I own no fellows in this group → no dispatch", async () => {
  const mod = load();
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [{ member_kind: "fellow", member_ref: "claude", owner_id: "user_friend" }],
    myUserId: "user_me",
    myFellowKeys: [],
    message: { sender_kind: "user", sender_ref: "user_friend", body_md: "x", turn_id: "t6" },
    conductor: { decideDispatch: () => ({ speak: ["claude"] }) }
  });
  assert.deepEqual(Array.from(result.speak), []);
});
