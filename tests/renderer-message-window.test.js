const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_MESSAGE_WINDOW_SIZE,
  resolveMessageWindow,
  moveMessageWindow
} = require("../src/renderer/chat/message-window.js");

function messages(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m_${index + 1}`,
    seq: index + 1
  }));
}

test("message window bounds the default tail to a fixed number of messages", () => {
  const window = resolveMessageWindow(messages(400));

  assert.equal(window.size, DEFAULT_MESSAGE_WINDOW_SIZE);
  assert.equal(window.messages.length, DEFAULT_MESSAGE_WINDOW_SIZE);
  assert.equal(window.messages[0].id, "m_241");
  assert.equal(window.messages.at(-1).id, "m_400");
  assert.equal(window.hasOlder, true);
  assert.equal(window.hasNewer, false);
});

test("message window centers a search target without rendering the full history", () => {
  const window = resolveMessageWindow(messages(500), null, {
    size: 100,
    focusId: "m_250"
  });

  assert.equal(window.messages.length, 100);
  assert.equal(window.messages.some((message) => message.id === "m_250"), true);
  assert.equal(window.hasOlder, true);
  assert.equal(window.hasNewer, true);
  assert.equal(window.mode, "history");
});

test("history window keeps its anchor when new tail messages arrive", () => {
  const initialMessages = messages(300);
  const history = resolveMessageWindow(initialMessages, null, {
    size: 50,
    focusId: "m_120"
  });
  const updated = resolveMessageWindow(messages(320), history.state, { size: 50 });

  assert.equal(updated.messages[0].id, history.messages[0].id);
  assert.equal(updated.messages.at(-1).id, history.messages.at(-1).id);
  assert.equal(updated.newerCount, history.newerCount + 20);
});

test("message window pages older and returns to the latest tail", () => {
  const rows = messages(260);
  const tail = resolveMessageWindow(rows, null, { size: 80 });
  const older = moveMessageWindow(rows, tail.state, "older", { size: 80 });
  const latest = moveMessageWindow(rows, older.state, "latest", { size: 80 });

  assert.equal(older.messages[0].id, "m_101");
  assert.equal(older.messages.at(-1).id, "m_180");
  assert.equal(older.hasNewer, true);
  assert.equal(latest.messages[0].id, "m_181");
  assert.equal(latest.messages.at(-1).id, "m_260");
  assert.equal(latest.mode, "tail");
});
