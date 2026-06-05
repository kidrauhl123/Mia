const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  IdentityKind,
  normalizeIdentity,
  normalizeStatusBadge,
  identityKey
} = require("../src/shared/identity.js");
const packageIdentity = require("../packages/shared/identity.js");
const packageIdentityByPath = require("../packages/shared/identity");
const sharedPackage = require("../packages/shared");
const workspaceIdentity = require("@mia/shared/identity");
const workspaceShared = require("@mia/shared");
const { normalizeBotIdentity } = require("../packages/shared/bot-identity.js");

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

test("package-facing identity exports resolve", () => {
  assert.equal(packageIdentity.IdentityKind.Bot, "bot");
  assert.equal(packageIdentityByPath.IdentityKind.Bot, "bot");
  assert.equal(sharedPackage.identity.identityKey({ kind: "bot", id: "bot_x", displayName: "X" }), "bot:bot_x");
  assert.equal(workspaceIdentity.IdentityKind.Bot, "bot");
  assert.equal(workspaceShared.identity.identityKey({ kind: "bot", id: "bot_x", displayName: "X" }), "bot:bot_x");
});

test("packages shared identity attaches miaIdentity in a browser VM", () => {
  const filename = path.join(__dirname, "../packages/shared/identity.js");
  const code = fs.readFileSync(filename, "utf8");
  const context = { window: {} };

  vm.runInNewContext(code, context, { filename });

  assert.equal(context.window.miaIdentity.IdentityKind.Bot, "bot");
  assert.equal(context.window.miaIdentity.identityKey({ kind: "bot", id: "bot_x", displayName: "X" }), "bot:bot_x");
});

test("normalizeIdentity falls back to trimmed non-empty aliases", () => {
  const identity = normalizeIdentity({
    kind: "bot",
    id: "bot_x",
    displayName: "   ",
    name: "Fallback",
    ownerUserId: "   ",
    owner_id: "owner_1",
    statusBadge: {
      kind: "gift",
      assetId: "   ",
      asset_id: "rose",
      collectibleId: "   ",
      collectible_id: "nft_1"
    }
  });

  assert.equal(identity.displayName, "Fallback");
  assert.equal(identity.ownerUserId, "owner_1");
  assert.deepEqual(identity.statusBadge, { kind: "gift", assetId: "rose", collectibleId: "nft_1" });
});

test("normalizeIdentity derives statusBadge from stored JSON fields", () => {
  const identity = normalizeIdentity({
    kind: "user",
    id: "u_profile",
    displayName: "Profile",
    status_badge_json: JSON.stringify({ kind: "emoji", emoji: "✅" })
  });

  assert.deepEqual(identity.statusBadge, { kind: "emoji", emoji: "✅" });
});

test("normalizeIdentity honors explicit null statusBadge over stored JSON fields", () => {
  const identity = normalizeIdentity({
    kind: "user",
    id: "u_profile",
    displayName: "Profile",
    statusBadge: null,
    status_badge_json: JSON.stringify({ kind: "emoji", emoji: "✅" })
  });

  assert.equal(Object.prototype.hasOwnProperty.call(identity, "statusBadge"), false);
});

test("normalizeBotIdentity honors explicit null statusBadge over snake_case badges", () => {
  const identity = normalizeBotIdentity({
    id: "bot_profile",
    displayName: "Profile Bot",
    statusBadge: null,
    status_badge: { kind: "gift", asset_id: "rose", collectible_id: "nft_rose_1" }
  });

  assert.equal(identity.statusBadge, null);
});
