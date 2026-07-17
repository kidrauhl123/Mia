const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const permissionMenu = require("../src/renderer/hermes/permission-menu.js");

test("Hermes permission menu provides the three official approval modes", () => {
  assert.deepEqual(permissionMenu.copyFor({ value: "manual" }), {
    label: "手动",
    description: "危险操作每次都询问"
  });
  assert.deepEqual(permissionMenu.copyFor({ value: "smart" }), {
    label: "智能",
    description: "低风险自动通过，高风险操作询问"
  });
  assert.deepEqual(permissionMenu.copyFor({ value: "off" }), {
    label: "关闭",
    description: "不再询问，直接执行"
  });
});

test("Hermes-only composer menu keeps session YOLO out of persisted bot controls", () => {
  const app = fs.readFileSync(path.join(projectRoot, "src/renderer/app.js"), "utf8");
  const moduleSource = fs.readFileSync(
    path.join(projectRoot, "src/renderer/hermes/permission-menu.js"),
    "utf8"
  );
  const html = fs.readFileSync(path.join(projectRoot, "src/renderer/index.html"), "utf8");

  assert.match(app, /engine\.toLowerCase\(\) === "hermes"/);
  assert.match(app, /entry\?\.category === "session_permission"/);
  assert.match(app, /controlId: control\.id,[\s\S]*value: enabled \? "on" : "off"/);
  assert.doesNotMatch(moduleSource, /saveBotRuntimeControl/);
  assert.match(moduleSource, /select\.dataset\.hermesPermissionMenu = "true"/);
  assert.match(moduleSource, /delete select\.dataset\.hermesPermissionMenu/);
  assert.match(moduleSource, /YOLO（仅本会话）/);
  assert.match(moduleSource, /允许完全访问，危险操作不再询问/);
  assert.doesNotMatch(moduleSource, /当前会话 YOLO|只对当前 Hermes 会话生效/);
  assert.match(app, /YOLO（仅本会话）/);
  assert.match(html, /\.\/hermes\/permission-menu\.js/);
  assert.match(html, /\.\/styles\/hermes-permission-menu\.css/);
});
