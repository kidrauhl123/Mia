const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  IdentityKind,
  normalizeIdentity,
  normalizeStatusBadge,
  identityKey
} = require("../src/shared/identity.js");

test("normalizeIdentity returns a clean user identity", () => {
  const identity = normalizeIdentity({
    kind: "user",
    id: "u_1",
    displayName: "Alice",
    ownerUserId: "should_drop",
    avatar: { image: "data:a", crop: null, color: "#111111", text: "A" },
    statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" }
  });

  assert.equal(identity.kind, IdentityKind.User);
  assert.equal(identity.id, "u_1");
  assert.equal(identity.displayName, "Alice");
  assert.equal(identity.ownerUserId, undefined);
  assert.deepEqual(identity.statusBadge, { kind: "emoji", emoji: "⭐", label: "Premium" });
  assert.equal(identityKey(identity), "user:u_1");
});

test("normalizeIdentity returns a global bot identity with owner metadata", () => {
  const identity = normalizeIdentity({
    kind: "bot",
    id: "bot_abcd",
    ownerUserId: "u_owner",
    displayName: "Mia",
    avatar: { image: "", crop: null, color: "#5e5ce6", text: "Mi" },
    statusBadge: { kind: "lottie", assetId: "sparkle", loop: "limited" }
  });

  assert.equal(identity.kind, IdentityKind.Bot);
  assert.equal(identity.id, "bot_abcd");
  assert.equal(identity.ownerUserId, "u_owner");
  assert.equal(identity.displayName, "Mia");
  assert.deepEqual(identity.statusBadge, { kind: "lottie", assetId: "sparkle", loop: "limited" });
  assert.equal(identityKey(identity), "bot:bot_abcd");
});

test("normalizeIdentity rejects prefixed and legacy fellow ids", () => {
  assert.equal(normalizeIdentity({ kind: "bot", id: "bot:bot_abcd", displayName: "Mia" }), null);
  assert.equal(normalizeIdentity({ kind: "bot", id: "fellow:u:mia", displayName: "Mia" }), null);
  assert.equal(normalizeIdentity({ kind: "user", id: "user:u_1", displayName: "Alice" }), null);
});

test("normalizeStatusBadge keeps supported badges and drops invalid badges", () => {
  assert.deepEqual(normalizeStatusBadge({ kind: "gift", assetId: "rose", collectibleId: "nft_1" }), {
    kind: "gift",
    assetId: "rose",
    collectibleId: "nft_1"
  });
  assert.equal(normalizeStatusBadge({ kind: "emoji", emoji: "" }), null);
  assert.equal(normalizeStatusBadge({ kind: "lottie", assetId: "" }), null);
  assert.equal(normalizeStatusBadge({ kind: "unknown", assetId: "x" }), null);
});
