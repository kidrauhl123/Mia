const { test } = require("node:test");
const assert = require("node:assert/strict");

const packageAvatar = require("../packages/shared/avatar.js");
const legacyAvatar = require("../src/shared/avatar-resolve.js");
const packageContact = require("../packages/shared/contact.js");
const legacyContact = require("../src/shared/contact.js");
const packageGroupTiles = require("../packages/shared/group-tiles.js");
const legacyGroupTiles = require("../src/shared/group-tiles.js");
const packageSendPipeline = require("../packages/shared/send-pipeline.js");
const legacySendPipeline = require("../src/shared/send-pipeline.js");
const packageSessionHistory = require("../packages/shared/session-history.js");
const legacySessionHistory = require("../src/shared/session-history.js");
const packageCloudClient = require("../packages/shared/cloud-client.js");
const legacyCloudClient = require("../src/shared/cloud-client.js");
const packageFellowIdentity = require("../packages/shared/fellow-identity.js");
const legacyFellowIdentity = require("../src/shared/fellow-identity.js");

test("packages/shared avatar matches the legacy shared avatar resolver", () => {
  const input = {
    id: "fellow_42",
    displayName: "空铃",
    avatarImage: "./assets/avatars/12.png",
    avatarCrop: { x: 10, y: 20, zoom: 2 }
  };
  assert.deepEqual(
    packageAvatar.resolveAvatarForContact(input),
    legacyAvatar.resolveAvatarForContact(input)
  );
  assert.equal(
    packageAvatar.normalizeAvatarImage("app:///assets/avatar-thumbs-pet/09.png"),
    legacyAvatar.normalizeAvatarImage("app:///assets/avatar-thumbs-pet/09.png")
  );
});

test("packages/shared contact keeps the existing contact interface", () => {
  assert.equal(packageContact.ContactKind.Fellow, legacyContact.ContactKind.Fellow);
  const ctx = {
    fellows: [{ key: "mia", id: "mia", name: "Mia", avatarImage: "", avatarCrop: null }]
  };
  assert.deepEqual(
    packageContact.resolveContact({ kind: "fellow", ref: "mia" }, ctx),
    legacyContact.resolveContact({ kind: "fellow", ref: "mia" }, ctx)
  );
});

test("packages/shared group tiles keep the existing tile resolver", () => {
  const members = [
    {
      member_kind: "fellow",
      member_ref: "fellow_remote",
      identity: { displayName: "远程", avatar: { image: "data:image/png;base64,AAAA", crop: { x: 50, y: 50, zoom: 1 } } }
    }
  ];
  assert.deepEqual(
    packageGroupTiles.resolveGroupMemberTiles(members, { fellows: [] }),
    legacyGroupTiles.resolveGroupMemberTiles(members, { fellows: [] })
  );
});

test("packages/shared send pipeline keeps the existing outgoing message interface", () => {
  const members = [{ member_kind: "fellow", member_ref: "mia" }];
  assert.deepEqual(
    packageSendPipeline.parseMentions("hi @mia", members),
    legacySendPipeline.parseMentions("hi @mia", members)
  );
});

test("packages/shared session history keeps the existing session interface", () => {
  const conversations = [
    { id: "fellow:u:mia:s1", type: "fellow", decorations: { fellowKey: "mia" }, last_activity_at: "2026-06-01T10:00:00Z" },
    { id: "fellow:u:mia:s2", type: "fellow", decorations: { fellowKey: "mia" }, last_activity_at: "2026-06-01T12:00:00Z" }
  ];
  assert.deepEqual(
    packageSessionHistory.sidebarConversations(conversations).map((conversation) => conversation.id),
    legacySessionHistory.sidebarConversations(conversations).map((conversation) => conversation.id)
  );
});

test("packages/shared cloud client keeps the existing REST and event helpers", () => {
  assert.equal(packageCloudClient.eventsUrlFor("https://c.test", 7), legacyCloudClient.eventsUrlFor("https://c.test", 7));
  assert.equal(packageCloudClient.backoffMs(10), legacyCloudClient.backoffMs(10));
  const events = packageCloudClient.createEventsClient({
    apiBase: "https://c.test",
    getToken: () => ""
  });
  assert.equal(typeof events.connect, "function");
  assert.equal(typeof events.disconnect, "function");
  assert.equal(typeof events.stop, "function");
});

test("packages/shared fellow identity normalizes legacy and object capabilities", () => {
  assert.deepEqual(
    packageFellowIdentity.normalizeFellowCapabilities(["chat", "tools", "chat"]),
    legacyFellowIdentity.normalizeFellowCapabilities(["chat", "tools", "chat"])
  );
  assert.deepEqual(packageFellowIdentity.normalizeFellowCapabilities({ chat: true, image: false }).legacyCapabilities, ["chat"]);
});

test("packages/shared fellow identity gives local fellow aliases a shareable global id", () => {
  assert.equal(packageFellowIdentity.fellowGlobalId("user_a", "mia"), "fellow:user_a:mia");
  assert.deepEqual(packageFellowIdentity.parseFellowGlobalId("fellow:user_b:codex"), {
    ownerUserId: "user_b",
    id: "codex",
    globalId: "fellow:user_b:codex"
  });
  assert.equal(packageFellowIdentity.parseFellowGlobalId("mia"), null);

  const normalized = packageFellowIdentity.normalizeFellowIdentity({
    globalId: "fellow:user_c:mia",
    name: "Mia"
  });
  assert.equal(normalized.id, "mia");
  assert.equal(normalized.ownerUserId, "user_c");
  assert.equal(normalized.globalId, "fellow:user_c:mia");
});

test("packages/shared fellow identity normalizes cloud and local identity shapes", () => {
  assert.deepEqual(
    packageFellowIdentity.normalizeFellowIdentity({
      id: "codex",
      owner_user_id: "u1",
      display_name: "Codex Fellow",
      color: "#0F766E",
      avatar_image: " data:image/png;base64,fake ",
      avatar_crop_json: "{\"x\":10,\"y\":20,\"zoom\":1.5}",
      bio: "Coding helper",
      capabilities: ["chat", "tools", "chat"],
      persona_text: "You are Codex.",
      created_at: "2026-06-01T10:00:00.000Z",
      updated_at: "2026-06-01T11:00:00.000Z"
    }),
    {
      id: "codex",
      key: "codex",
      ownerUserId: "u1",
      globalId: "fellow:u1:codex",
      name: "Codex Fellow",
      displayName: "Codex Fellow",
      color: "#0f766e",
      avatarImage: "data:image/png;base64,fake",
      avatarCrop: { x: 10, y: 20, zoom: 1.5 },
      bio: "Coding helper",
      capabilities: packageFellowIdentity.normalizeFellowCapabilities(["chat", "tools"]),
      personaText: "You are Codex.",
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T11:00:00.000Z"
    }
  );

  assert.deepEqual(
    packageFellowIdentity.normalizeFellowIdentity({
      key: "mia",
      account_id: "mia",
      name: "Mia",
      color: "not-a-color",
      avatarCrop: { x: 50, y: 50, zoom: 1 },
      description: "Local fellow"
    }),
    {
      id: "mia",
      key: "mia",
      ownerUserId: "",
      globalId: "",
      name: "Mia",
      displayName: "Mia",
      color: "",
      avatarImage: "",
      avatarCrop: { x: 50, y: 50, zoom: 1 },
      bio: "Local fellow",
      capabilities: packageFellowIdentity.normalizeFellowCapabilities({}),
      personaText: "",
      createdAt: "",
      updatedAt: ""
    }
  );
});

test("fellow directory keeps a user color but leaves it empty when unset (resolver hashes the id)", () => {
  const { normalizeOwnedFellow } = require("../src/renderer/fellow/fellow-directory.js");

  // A real user-set color is preserved (and lowercased).
  assert.equal(
    normalizeOwnedFellow({ id: "codex", name: "Codex", color: "#0F766E" }, { sourceKind: "cloud" }).color,
    "#0f766e"
  );
  // No / invalid color → empty. Baking memberAccentColor(key) here made the
  // sidebar honor a key-only hash that disagreed with the global-id hash used
  // elsewhere; leaving it empty lets resolveAvatarForContact hash the canonical id.
  assert.equal(
    normalizeOwnedFellow({ id: "codex", name: "Codex", color: "invalid" }, { sourceKind: "cloud" }).color,
    ""
  );
});
