const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const deviceGroups = require("../src/renderer/conversation-device-groups.js");

test("desktop other-device folder groups conversations by runtime device", () => {
  const specs = [
    {
      name: "Codex",
      deviceGroup: {
        key: "device:office",
        label: "Office PC",
        meta: "离线",
        status: "offline",
        order: 101
      }
    },
    {
      name: "Hermes",
      deviceGroup: {
        key: "device:studio",
        label: "Studio Mac",
        meta: "在线",
        status: "online",
        order: 100
      }
    },
    {
      name: "Claude",
      deviceGroup: {
        key: "device:studio",
        label: "Studio Mac",
        meta: "在线",
        status: "online",
        order: 100
      }
    }
  ];
  const groups = deviceGroups.groupConversationSpecs(specs);

  assert.deepEqual(groups.map((group) => ({
    key: group.key,
    label: group.label,
    meta: group.meta,
    names: group.specs.map((spec) => spec.name)
  })), [
    {
      key: "device:studio",
      label: "Studio Mac",
      meta: "在线",
      names: ["Hermes", "Claude"]
    },
    {
      key: "device:office",
      label: "Office PC",
      meta: "离线",
      names: ["Codex"]
    }
  ]);

  assert.deepEqual(
    deviceGroups.orderedConversationSpecs(specs).map((spec) => spec.name),
    ["Hermes", "Claude", "Codex"]
  );
});

test("merged device groups prefer the connected device status and order", () => {
  const groups = deviceGroups.groupConversationSpecs([
    {
      name: "Old binding",
      deviceGroup: {
        key: "device-name:studio mac",
        label: "Studio Mac",
        meta: "离线",
        status: "offline",
        order: 700
      }
    },
    {
      name: "Current binding",
      deviceGroup: {
        key: "device-name:studio mac",
        label: "Studio Mac",
        meta: "在线",
        status: "online",
        order: 100
      }
    }
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].meta, "在线");
  assert.equal(groups[0].status, "online");
  assert.equal(groups[0].order, 100);
  assert.deepEqual(groups[0].specs.map((spec) => spec.name), ["Old binding", "Current binding"]);
});

test("device headers expose theme-aware Windows and macOS SVG logo hooks", () => {
  assert.match(deviceGroups.devicePlatformIcon("macos"), /platform-macos/);
  assert.match(deviceGroups.devicePlatformIcon("windows"), /platform-windows/);
  assert.equal(deviceGroups.devicePlatformIcon("linux"), "");
});

test("device sections activate only inside the other-device folder", () => {
  assert.equal(deviceGroups.isOtherDeviceFilter("__mia_other_devices__", "__mia_other_devices__"), true);
  assert.equal(deviceGroups.isOtherDeviceFilter("", "__mia_other_devices__"), false);
  assert.equal(deviceGroups.isOtherDeviceFilter("研究", "__mia_other_devices__"), false);
});

test("desktop shell loads and renders independently collapsible device sections", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const moduleSource = fs.readFileSync(
    path.join(root, "src/renderer/conversation-device-groups.js"),
    "utf8"
  );
  const styles = fs.readFileSync(path.join(root, "src/renderer/styles/conversation-device-groups.css"), "utf8");

  assert.match(html, /styles\/conversation-device-groups\.css/);
  assert.match(html, /conversation-device-groups\.js/);
  assert.match(app, /deviceGroup:\s*isBot\s*\?\s*window\.miaBotManager\?\.botDeviceGroup/);
  assert.match(app, /appendGroupedConversationCards/);
  assert.match(app, /deviceGroups\.orderedConversationSpecs\(specs\)/);
  assert.match(app, /syncPersonaListActiveState\(renderedSpecs\)/);
  assert.match(moduleSource, /collapsedGroups\.(?:add|delete)\(group\.key\)/);
  assert.match(moduleSource, /conversation-device-group-items-clip/);
  assert.match(moduleSource, /devicePlatformIcon\(group\.platform\)/);
  assert.match(moduleSource, /items\.inert = nextCollapsed/);
  assert.match(styles, /\.conversation-device-group-header/);
  assert.match(styles, /platform-icons\/macos\.svg/);
  assert.match(styles, /platform-icons\/windows\.svg/);
  assert.match(styles, /\.conversation-device-group\.collapsed \.conversation-device-group-items/);
  assert.match(styles, /grid-template-rows:\s*0fr/);
  assert.match(styles, /grid-template-rows 220ms/);
  assert.match(styles, /\[data-device-status="online"\]|\[data-device-status="offline"\]/);
  assert.match(
    styles,
    /\[data-device-status="offline"\][\s\S]*\[data-device-status="unassigned"\][\s\S]*display:\s*none/
  );
});
