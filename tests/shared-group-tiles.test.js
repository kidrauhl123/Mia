// Verify the shared group-tiles resolver consumes the server-enriched
// fellow_avatar_* fields on member rows when the viewer doesn't own the
// fellow. Without this, web's group sidebar tiles fall back to blank
// single-letter bubbles for any fellow added by another user.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveGroupMemberTiles } = require("../src/shared/group-tiles");
const { avatarAssetForKey, avatarDefaultCropForSrc } = require("../src/shared/avatar-resolve");
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
    fellows: [{ id: "kongling", avatarImage: "fresh-local.png", avatarCrop: { x: 50, y: 50 } }]
  });
  assert.deepEqual(tiles, [{
    image: "fresh-local.png",
    crop: { x: 50, y: 50 },
    color: memberAccentColor("kongling")
  }]);
});

test("group tile falls back to enriched member-row fields for cross-owner fellows", () => {
  // Viewer doesn't own this fellow — ctx.fellows is empty.
  const members = [
    {
      member_kind: "fellow",
      member_ref: "alice-fellow",
      fellow_avatar_image: "alice-friend-avatar.png",
      fellow_avatar_crop: { x: 30, y: 70, zoom: 1.2 }
    }
  ];
  const tiles = resolveGroupMemberTiles(members, { fellows: [] });
  assert.deepEqual(tiles, [{
    image: "alice-friend-avatar.png",
    crop: { x: 30, y: 70, zoom: 1.2 },
    color: memberAccentColor("alice-fellow")
  }]);
});

test("group tile falls back to shared stable avatar when neither ctx.fellows nor member row carries an image", () => {
  const members = [{ member_kind: "fellow", member_ref: "unknown-fellow" }];
  const tiles = resolveGroupMemberTiles(members, { fellows: [] });
  const expectedImage = avatarAssetForKey("unknown-fellow");
  assert.equal(tiles[0].image, expectedImage);
  assert.deepEqual(tiles[0].crop, avatarDefaultCropForSrc(expectedImage));
  assert.equal(tiles[0].color, memberAccentColor("unknown-fellow"));
});

test("group tile color is identity-derived, not pulled from a per-fellow field", () => {
  // Same id always yields the same color whether or not the local registry
  // or the member-row enrichment supplies any data.
  const members = [
    {
      member_kind: "fellow",
      member_ref: "shy-fellow",
      fellow_avatar_image: "server-fallback.png"
    }
  ];
  const tiles = resolveGroupMemberTiles(members, {
    fellows: [{ id: "shy-fellow", avatarImage: "" }]
  });
  assert.equal(tiles[0].image, "server-fallback.png");
  assert.equal(tiles[0].color, memberAccentColor("shy-fellow"));
});
