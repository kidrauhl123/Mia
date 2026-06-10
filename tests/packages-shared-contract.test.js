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
const packageBotIdentity = require("../packages/shared/bot-identity.js");
const legacyBotIdentity = require("../src/shared/bot-identity.js");

test("packages/shared avatar matches the legacy shared avatar resolver", () => {
  const input = {
    id: "bot_42",
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

test("packages/shared contact keeps the bot contact interface", () => {
  assert.equal(packageContact.IdentityKind.Bot, legacyContact.IdentityKind.Bot);
  const ctx = {
    bots: [{ id: "bot_mia", displayName: "Mia", avatarImage: "", avatarCrop: null }]
  };
  assert.deepEqual(
    packageContact.resolveContact({ kind: "bot", ref: "bot_mia" }, ctx),
    legacyContact.resolveContact({ kind: "bot", ref: "bot_mia" }, ctx)
  );
});

test("packages/shared group tiles keep the existing tile resolver", () => {
  const members = [
    {
      member_kind: "bot",
      member_ref: "bot_remote",
      identity: { displayName: "远程", avatar: { image: "data:image/png;base64,AAAA", crop: { x: 50, y: 50, zoom: 1 } } }
    }
  ];
  assert.deepEqual(
    packageGroupTiles.resolveGroupMemberTiles(members, { bots: [] }),
    legacyGroupTiles.resolveGroupMemberTiles(members, { bots: [] })
  );
});

test("packages/shared send pipeline keeps the existing outgoing message interface", () => {
  const members = [{ member_kind: "bot", member_ref: "bot_mia" }];
  assert.deepEqual(
    packageSendPipeline.parseMentions("hi @bot_mia", members),
    legacySendPipeline.parseMentions("hi @bot_mia", members)
  );
});

test("packages/shared session history keeps the existing session interface", () => {
  const conversations = [
    { id: "botc_s1", type: "bot", decorations: { botId: "bot_mia" }, last_activity_at: "2026-06-01T10:00:00Z" },
    { id: "botc_s2", type: "bot", decorations: { botId: "bot_mia" }, last_activity_at: "2026-06-01T12:00:00Z" }
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

test("packages/shared bot identity normalizes legacy and object capabilities", () => {
  assert.deepEqual(
    packageBotIdentity.normalizeBotCapabilities(["chat", "tools", "chat"]),
    legacyBotIdentity.normalizeBotCapabilities(["chat", "tools", "chat"])
  );
  assert.deepEqual(packageBotIdentity.normalizeBotCapabilities({ chat: true, image: false }).legacyCapabilities, ["chat"]);
});

test("packages/shared bot identity applies official preset skill defaults to unconfigured bots", () => {
  const presets = [{
    key: "paper-buddy",
    name: "论文搭子",
    capabilities: { enabledSkills: ["mia-official:paper-research"] }
  }];
  const caps = packageBotIdentity.botCapabilitiesWithPresetDefaults({
    key: "old-local-paper",
    name: "论文搭子",
    capabilities: { inheritEngineDefaults: true, enabledSkills: [], disabledSkills: [] }
  }, presets);

  assert.equal(caps.inheritEngineDefaults, false);
  assert.deepEqual(caps.enabledSkills, ["mia-official:paper-research"]);
  assert.deepEqual(
    packageBotIdentity.botCapabilitiesWithPresetDefaults({
      key: "old-local-paper",
      name: "论文搭子",
      capabilities: { inheritEngineDefaults: false, enabledSkills: [], disabledSkills: [] }
    }, presets).enabledSkills,
    []
  );
});

test("packages/shared bot identity owns bot session ids and rejects prefixed ids", () => {
  assert.equal(packageBotIdentity.botConversationId("sess_1"), "botc_sess_1");
  assert.equal(packageBotIdentity.botConversationId("botc_sess_1"), "botc_sess_1");
  assert.equal(packageBotIdentity.normalizeBotIdentity({ id: "bot:bot_mia", name: "Mia" }), null);
  assert.equal(packageBotIdentity.normalizeBotIdentity({ id: "fellow:user_c:mia", name: "Mia" }), null);
});

test("packages/shared bot identity normalizes cloud and local identity shapes", () => {
  assert.deepEqual(
    packageBotIdentity.normalizeBotIdentity({
      id: "bot_codex",
      owner_user_id: "u1",
      display_name: "Codex Bot",
      color: "#0F766E",
      avatar_image: " data:image/png;base64,fake ",
      avatar_crop_json: "{\"x\":10,\"y\":20,\"zoom\":1.5}",
      status_badge_json: "{\"kind\":\"emoji\",\"emoji\":\"⭐\"}",
      bio: "Coding helper",
      capabilities: ["chat", "tools", "chat"],
      persona_text: "You are Codex.",
      created_at: "2026-06-01T10:00:00.000Z",
      updated_at: "2026-06-01T11:00:00.000Z"
    }),
    {
      kind: "bot",
      id: "bot_codex",
      ownerUserId: "u1",
      name: "Codex Bot",
      displayName: "Codex Bot",
      color: "#0f766e",
      avatarImage: "data:image/png;base64,fake",
      avatarCrop: { x: 10, y: 20, zoom: 1.5 },
      statusBadge: { kind: "emoji", emoji: "⭐" },
      bio: "Coding helper",
      capabilities: packageBotIdentity.normalizeBotCapabilities(["chat", "tools"]),
      personaText: "You are Codex.",
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T11:00:00.000Z"
    }
  );

  assert.deepEqual(
    packageBotIdentity.normalizeBotIdentity({
      botId: "bot_mia",
      name: "Mia",
      color: "not-a-color",
      avatarCrop: { x: 50, y: 50, zoom: 1 },
      description: "Local bot"
    }),
    {
      kind: "bot",
      id: "bot_mia",
      ownerUserId: "",
      name: "Mia",
      displayName: "Mia",
      color: "",
      avatarImage: "",
      avatarCrop: { x: 50, y: 50, zoom: 1 },
      statusBadge: null,
      bio: "Local bot",
      capabilities: packageBotIdentity.normalizeBotCapabilities({}),
      personaText: "",
      createdAt: "",
      updatedAt: ""
    }
  );
});

test("bot identity keeps a user color but leaves it empty when unset", () => {
  assert.equal(
    packageBotIdentity.normalizeBotIdentity({ id: "bot_codex", name: "Codex", color: "#0F766E" }).color,
    "#0f766e"
  );
  assert.equal(
    packageBotIdentity.normalizeBotIdentity({ id: "bot_codex", name: "Codex", color: "invalid" }).color,
    ""
  );
});
