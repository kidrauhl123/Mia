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
  ["gold-fire", "金色火焰"],
  ["rainbow-fire", "七彩火焰"]
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

test("crown badge is selectable and bundled as a compressed Lottie file", () => {
  const choices = statusBadgeChoices({ includeEmpty: true });
  const crown = choices.find((item) => item.value === "crown");
  const definition = statusBadgeAssetDefinitions().find((item) => item.id === "crown");

  assert.ok(crown, "crown should be a selectable badge");
  assert.equal(crown.label, "皇冠");
  assert.deepEqual(statusBadgeForValue("crown"), {
    kind: "lottie",
    assetId: "crown",
    label: "皇冠",
    loop: "always"
  });
  assert.ok(definition, "crown should have a bundled asset definition");
  assert.equal(definition.format, "tgs");
  assert.equal(definition.relativePath, "assets/status-badges/crown.tgs");

  const filePath = path.join(root, "src", "renderer", definition.relativePath);
  const raw = fs.readFileSync(filePath);
  assert.ok(raw.length > 0 && raw.length < 100_000, "crown should stay compressed");
  const lottie = JSON.parse(zlib.gunzipSync(raw).toString("utf8"));
  assert.equal(lottie.w, 512);
  assert.equal(lottie.h, 512);
  assert.ok(Number(lottie.op) > 0, "crown should have animation frames");
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

test("rainbow flame uses a single diagonal color-filter style gradient", () => {
  const filePath = path.join(root, "src", "renderer", "assets", "status-badges", "rainbow-fire.tgs");
  const lottie = JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString("utf8"));
  const gradientFills = [];
  const solidFills = [];
  const strokes = [];

  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.ty === "gf") gradientFills.push(node);
    if (node.ty === "fl") solidFills.push(node);
    if (node.ty === "st") strokes.push(node);
    for (const value of Object.values(node)) visit(value);
  }

  visit(lottie);

  assert.ok(gradientFills.length > 0);
  for (const fill of gradientFills) {
    assert.equal(fill.g.p, 14);
    assert.deepEqual(fill.s.k, [-155, -270]);
    assert.deepEqual(fill.e.k, [145, 185]);
    assert.deepEqual(fill.g.k.k, [
      0, 0.898, 0.8078, 0.3059,
      0.3, 0.898, 0.8078, 0.3059,
      0.38, 0.8667, 0.6667, 0.2588,
      0.45, 0.8353, 0.5294, 0.2706,
      0.52, 0.8275, 0.3569, 0.3216,
      0.59, 0.8431, 0.2824, 0.4627,
      0.64, 0.7922, 0.2549, 0.5725,
      0.68, 0.6549, 0.2745, 0.6745,
      0.72, 0.4392, 0.3373, 0.7333,
      0.76, 0.251, 0.4549, 0.7608,
      0.81, 0.2667, 0.5333, 0.5765,
      0.87, 0.4078, 0.6745, 0.3608,
      0.92, 0.6784, 0.7686, 0.3098,
      1, 0.8196, 0.7843, 0.3059
    ]);
  }

  assert.ok(strokes.length > 0);
  for (const stroke of strokes) {
    assert.deepEqual(stroke.c.k, [1, 1, 1, 1]);
    assert.equal(stroke.o.k, 14);
  }

  assert.ok(solidFills.length > 0);
  for (const fill of solidFills) {
    assert.deepEqual(fill.c.k, [1, 1, 1, 1]);
    assert.equal(fill.o.k, 18);
  }
});
