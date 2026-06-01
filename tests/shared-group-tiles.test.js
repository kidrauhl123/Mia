// Verify the shared group-tiles resolver consumes the server-enriched
// fellow_avatar_* fields on member rows when the viewer doesn't own the
// fellow. Without this, web's group sidebar tiles fall back to blank
// single-letter bubbles for any fellow added by another user.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveGroupMemberTiles } = require("../src/shared/group-tiles");
const { memberAccentColor } = require("../src/shared/member-color");

test("group tile prefers the owned fellow's avatar over the member-row enrichment", () => {
  const members = [
    {
      member_kind: "fellow",
      member_ref: "kongling",
      fellow_avatar_image: "stale-server-copy.png",
      fellow_avatar_crop: { x: 99, y: 99 }
    }
  ];
  const tiles = resolveGroupMemberTiles(members, {
    fellows: [{ id: "kongling", name: "空铃", avatarImage: "fresh-local.png", avatarCrop: { x: 50, y: 50 } }]
  });
  assert.deepEqual(tiles, [{
    image: "fresh-local.png",
    crop: { x: 50, y: 50 },
    color: memberAccentColor("kongling"),
    text: "空铃"
  }]);
});

test("group tile falls back to enriched member-row fields for cross-owner fellows", () => {
  // Viewer doesn't own this fellow — ctx.fellows is empty.
  const members = [
    {
      member_kind: "fellow",
      member_ref: "alice-fellow",
      fellow_name: "Alice",
      fellow_avatar_image: "alice-friend-avatar.png",
      fellow_avatar_crop: { x: 30, y: 70, zoom: 1.2 }
    }
  ];
  const tiles = resolveGroupMemberTiles(members, { fellows: [] });
  assert.deepEqual(tiles, [{
    image: "alice-friend-avatar.png",
    crop: { x: 30, y: 70, zoom: 1.2 },
    color: memberAccentColor("alice-fellow"),
    text: "Al"
  }]);
});

test("group tile falls back to shared text avatar when neither ctx.fellows nor member row carries an image", () => {
  const members = [{ member_kind: "fellow", member_ref: "unknown-fellow" }];
  const tiles = resolveGroupMemberTiles(members, { fellows: [] });
  assert.equal(tiles[0].image, "");
  assert.equal(tiles[0].crop, null);
  assert.equal(tiles[0].color, memberAccentColor("unknown-fellow"));
  assert.equal(tiles[0].text, "un");
});

test("owned fellow with an empty avatar stays text fallback instead of using stale member-row media", () => {
  // Same id always yields the same color, and a local owned empty avatar is an
  // explicit state rather than a signal to reuse older member-row media.
  const members = [
    {
      member_kind: "fellow",
      member_ref: "shy-fellow",
      fellow_avatar_image: "server-fallback.png"
    }
  ];
  const tiles = resolveGroupMemberTiles(members, {
    fellows: [{ id: "shy-fellow", name: "羞羞", avatarImage: "" }]
  });
  assert.equal(tiles[0].image, "");
  assert.equal(tiles[0].crop, null);
  assert.equal(tiles[0].color, memberAccentColor("shy-fellow"));
  assert.equal(tiles[0].text, "羞羞");
});
