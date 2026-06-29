const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  statusBadgeChoices,
  statusBadgeForValue,
  statusBadgeAssetDefinitions
} = require("../packages/shared/status-badge-assets.js");

const root = path.join(__dirname, "..");

const FIRE_BADGES = [
  ["blue-fire", "蓝色火焰"],
  ["green-fire", "绿色火焰"],
  ["pink-fire", "粉色火焰"],
  ["ice-blue-fire", "冰蓝火焰"],
  ["cyan-fire", "青色火焰"],
  ["purple-fire", "紫色火焰"],
  ["red-orange-fire", "红橙火焰"],
  ["gold-fire", "金色火焰"]
];

test("status badge choices hide rainbow and include every flame color", () => {
  const choices = statusBadgeChoices({ includeEmpty: true });
  const values = choices.map((choice) => choice.value);

  assert.equal(values.includes("rainbow"), false);
  assert.equal(statusBadgeForValue("rainbow"), null);

  for (const [id, label] of FIRE_BADGES) {
    const choice = choices.find((item) => item.value === id);
    assert.ok(choice, `${id} should be a selectable badge`);
    assert.equal(choice.label, label);
    assert.deepEqual(statusBadgeForValue(id), {
      kind: "lottie",
      assetId: id,
      label,
      loop: "always"
    });
  }
});

test("flame badge assets are bundled compressed Lottie files", () => {
  const definitions = statusBadgeAssetDefinitions();

  for (const [id, label] of FIRE_BADGES) {
    const definition = definitions.find((item) => item.id === id);
    assert.ok(definition, `${id} should have a bundled asset definition`);
    assert.equal(definition.label, label);
    assert.equal(definition.format, "tgs");
    assert.equal(definition.relativePath, `assets/status-badges/${id}.tgs`);

    const filePath = path.join(root, "src", "renderer", definition.relativePath);
    const raw = fs.readFileSync(filePath);
    assert.ok(raw.length > 0 && raw.length < 100_000, `${id} should stay compressed`);
    const lottie = JSON.parse(zlib.gunzipSync(raw).toString("utf8"));
    assert.equal(lottie.w, 512);
    assert.equal(lottie.h, 512);
    assert.ok(Number(lottie.op) > 0, `${id} should have animation frames`);
  }
});
