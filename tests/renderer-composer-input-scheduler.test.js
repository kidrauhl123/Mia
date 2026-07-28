const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createComposerInputScheduler
} = require("../src/renderer/chat/composer-input-scheduler.js");

test("composer input scheduler performs at most one derived refresh per frame", () => {
  const frames = [];
  let refreshes = 0;
  const scheduler = createComposerInputScheduler({
    refresh: () => { refreshes += 1; },
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {}
  });

  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();

  assert.equal(frames.length, 1);
  assert.equal(refreshes, 0);
  frames[0]();
  assert.equal(refreshes, 1);
  assert.equal(scheduler.isScheduled(), false);
});

test("composer input scheduler flushes pending menu state before control keys", () => {
  const frames = [];
  const cancelled = [];
  let refreshes = 0;
  const scheduler = createComposerInputScheduler({
    refresh: () => { refreshes += 1; },
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: (id) => cancelled.push(id)
  });

  scheduler.schedule();
  scheduler.flush();

  assert.deepEqual(cancelled, [1]);
  assert.equal(refreshes, 1);
  assert.equal(scheduler.isScheduled(), false);
});
