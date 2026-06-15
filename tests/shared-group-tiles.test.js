// Verify the shared group-tiles resolver consumes the server-enriched
// bot_avatar_* fields on member rows when the viewer doesn't own the bot.
// Without this, web's group sidebar tiles fall back to blank single-letter
// bubbles for any bot added by another user.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveGroupMemberTiles } = require("../src/shared/group-tiles");
const { memberAccentColor } = require("../src/shared/member-color");

test("group tile prefers the owned bot avatar over the member-row enrichment", () => {
  const members = [
    {
      member_kind: "bot",
      member_ref: "kongling",
      bot_avatar_image: "stale-server-copy.png",
      bot_avatar_crop: { x: 99, y: 99 }
    }
  ];
  const tiles = resolveGroupMemberTiles(members, {
    bots: [{ id: "kongling", name: "空铃", avatarImage: "fresh-local.png", avatarCrop: { x: 50, y: 50 } }]
  });
  assert.deepEqual(tiles, [{
    image: "fresh-local.png",
    crop: { x: 50, y: 50 },
    color: memberAccentColor("kongling"),
    text: "空铃"
  }]);
});

test("group tile falls back to enriched member-row fields for cross-owner bots", () => {
  // Viewer doesn't own this bot — ctx.bots is empty.
  const members = [
    {
      member_kind: "bot",
      member_ref: "alice-bot",
      bot_name: "Alice",
      bot_avatar_image: "alice-friend-avatar.png",
      bot_avatar_crop: { x: 30, y: 70, zoom: 1.2 }
    }
  ];
  const tiles = resolveGroupMemberTiles(members, { bots: [] });
  assert.deepEqual(tiles, [{
    image: "alice-friend-avatar.png",
    crop: { x: 30, y: 70, zoom: 1.2 },
    color: memberAccentColor("alice-bot"),
    text: "Al"
  }]);
});

test("compact owned bot does not hide the enriched member-row avatar", () => {
  const members = [
    {
      member_kind: "bot",
      member_ref: "craft",
      identity: {
        displayName: "匠妹",
        avatar: { image: "data:video/mp4;base64,real", crop: { start: 0, duration: 3 } }
      },
      bot_avatar_image: "server-copy.png"
    }
  ];
  const tiles = resolveGroupMemberTiles(members, {
    bots: [{ id: "craft", name: "匠妹" }]
  });
  assert.deepEqual(tiles, [{
    image: "data:video/mp4;base64,real",
    crop: { start: 0, duration: 3 },
    color: memberAccentColor("craft"),
    text: "匠妹"
  }]);
});

test("group tile hashes owned bot fallback by owner-scoped bot identity", () => {
  const members = [{ member_kind: "bot", member_ref: "mia", owner_id: "user_me" }];
  const tiles = resolveGroupMemberTiles(members, {
    bots: [{ id: "mia", name: "Mia", ownerUserId: "user_me" }]
  });
  assert.equal(tiles[0].image, "");
  assert.equal(tiles[0].crop, null);
  assert.equal(tiles[0].color, memberAccentColor("user_me:mia"));
  assert.equal(tiles[0].text, "Mi");
});

test("group tile preserves an owned bot's explicit avatar color", () => {
  const members = [{ member_kind: "bot", member_ref: "ha", owner_id: "user_me" }];
  const tiles = resolveGroupMemberTiles(members, {
    bots: [{ id: "ha", name: "哈哈哈", ownerUserId: "user_me", avatarImage: "", color: "#aa88dd" }]
  });
  assert.equal(tiles[0].image, "");
  assert.equal(tiles[0].crop, null);
  assert.equal(tiles[0].color, "#aa88dd");
  assert.equal(tiles[0].text, "哈哈");
});

test("group tile hashes cross-owner bot fallback by owner-scoped bot identity", () => {
  const members = [{
    member_kind: "bot",
    member_ref: "mia",
    owner_id: "user_friend",
    bot_name: "Mia"
  }];
  const tiles = resolveGroupMemberTiles(members, { bots: [] });
  assert.equal(tiles[0].image, "");
  assert.equal(tiles[0].crop, null);
  assert.equal(tiles[0].color, memberAccentColor("user_friend:mia"));
  assert.equal(tiles[0].text, "Mi");
});

test("compact self profile does not hide the enriched member-row avatar", () => {
  const members = [
    {
      member_kind: "user",
      member_ref: "user_me",
      identity: {
        displayName: "755439",
        avatar: { image: "data:image/gif;base64,self", crop: { x: 50, y: 50, zoom: 1 } }
      }
    }
  ];
  const tiles = resolveGroupMemberTiles(members, {
    self: { id: "user_me", username: "755439" }
  });
  assert.deepEqual(tiles, [{
    image: "data:image/gif;base64,self",
    crop: { x: 50, y: 50, zoom: 1 },
    color: memberAccentColor("user_me"),
    text: "75"
  }]);
});

test("group tile preserves self explicit avatar color", () => {
  const members = [{ member_kind: "user", member_ref: "user_me" }];
  const tiles = resolveGroupMemberTiles(members, {
    self: { id: "user_me", username: "755439", avatarImage: "", avatarColor: "#aa88dd" }
  });
  assert.equal(tiles[0].image, "");
  assert.equal(tiles[0].crop, null);
  assert.equal(tiles[0].color, "#aa88dd");
  assert.equal(tiles[0].text, "75");
});

test("group tile falls back to shared text avatar when neither ctx.bots nor member row carries an image", () => {
  const members = [{ member_kind: "bot", member_ref: "unknown-bot" }];
  const tiles = resolveGroupMemberTiles(members, { bots: [] });
  assert.equal(tiles[0].image, "");
  assert.equal(tiles[0].crop, null);
  assert.equal(tiles[0].color, memberAccentColor("unknown-bot"));
  assert.equal(tiles[0].text, "un");
});

test("owned bot with an empty avatar stays text fallback instead of using stale member-row media", () => {
  // Same id always yields the same color, and a local owned empty avatar is an
  // explicit state rather than a signal to reuse older member-row media.
  const members = [
    {
      member_kind: "bot",
      member_ref: "shy-bot",
      bot_avatar_image: "server-fallback.png"
    }
  ];
  const tiles = resolveGroupMemberTiles(members, {
    bots: [{ id: "shy-bot", name: "羞羞", avatarImage: "" }]
  });
  assert.equal(tiles[0].image, "");
  assert.equal(tiles[0].crop, null);
  assert.equal(tiles[0].color, memberAccentColor("shy-bot"));
  assert.equal(tiles[0].text, "羞羞");
});
