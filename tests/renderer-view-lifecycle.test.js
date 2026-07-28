const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createViewLifecycle } = require("../src/renderer/view-lifecycle.js");

function createDocument() {
  const listeners = new Map();
  return {
    hidden: false,
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
    emit(name) { listeners.get(name)?.(); },
    listeners
  };
}

test("view lifecycle publishes view and document visibility transitions", () => {
  const document = createDocument();
  const lifecycle = createViewLifecycle({ document, initialView: "chat" });
  const states = [];
  lifecycle.subscribe((state) => states.push(state), { immediate: false });

  lifecycle.setActiveView("settings");
  document.hidden = true;
  document.emit("visibilitychange");

  assert.deepEqual(states.map((state) => [state.reason, state.activeView, state.documentVisible]), [
    ["view", "settings", true],
    ["visibility", "settings", false]
  ]);
  assert.equal(lifecycle.isActive("settings"), false);

  lifecycle.destroy();
  assert.equal(document.listeners.size, 0);
});

test("view lifecycle ignores redundant transitions", () => {
  const document = createDocument();
  const lifecycle = createViewLifecycle({ document, initialView: "chat" });
  let notifications = 0;
  lifecycle.subscribe(() => { notifications += 1; }, { immediate: false });

  lifecycle.setActiveView("chat");
  document.emit("visibilitychange");

  assert.equal(notifications, 0);
});
