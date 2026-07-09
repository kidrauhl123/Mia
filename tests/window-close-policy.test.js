const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  WINDOW_CLOSE_ACTIONS,
  WINDOW_CLOSE_CHOICES,
  dialogResultToWindowCloseChoice,
  decideWindowClose,
  normalizeWindowCloseBehavior,
  windowClosePromptOptions
} = require("../src/main/window-close-policy.js");

test("default ask behavior prompts when Core is running", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "ask",
    coreRunning: true,
    isExplicitQuit: false
  }), {
    action: WINDOW_CLOSE_ACTIONS.PROMPT,
    preferenceToWrite: null,
    reason: "ask"
  });
});

test("close policy keeps the window visible when Core is not running", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "ask",
    coreRunning: false,
    isExplicitQuit: false
  }), {
    action: WINDOW_CLOSE_ACTIONS.KEEP_OPEN,
    preferenceToWrite: null,
    reason: "core-not-running"
  });
});

test("remembered close-to-tray hides only when Core is running", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "close-to-tray",
    coreRunning: true,
    isExplicitQuit: false
  }), {
    action: WINDOW_CLOSE_ACTIONS.HIDE_TO_TRAY,
    preferenceToWrite: null,
    reason: "remembered-close-to-tray"
  });
});

test("close-to-tray keeps visible when Core is not running", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "close-to-tray",
    coreRunning: false,
    isExplicitQuit: false
  }), {
    action: WINDOW_CLOSE_ACTIONS.KEEP_OPEN,
    preferenceToWrite: null,
    reason: "core-not-running"
  });
});

test("remembered quit routes to full quit even when Core is already stopped", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "quit",
    coreRunning: false,
    isExplicitQuit: false
  }), {
    action: WINDOW_CLOSE_ACTIONS.FULL_QUIT,
    preferenceToWrite: null,
    reason: "remembered-quit"
  });
});

test("explicit app quit is not intercepted by close policy", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "close-to-tray",
    coreRunning: true,
    isExplicitQuit: true
  }), {
    action: WINDOW_CLOSE_ACTIONS.ALLOW_CLOSE,
    preferenceToWrite: null,
    reason: "explicit-quit"
  });
});

test("unremembered dialog choice does not write preference", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "ask",
    coreRunning: true,
    isExplicitQuit: false,
    dialogChoice: { choice: WINDOW_CLOSE_CHOICES.CLOSE_TO_TRAY, remember: false }
  }), {
    action: WINDOW_CLOSE_ACTIONS.HIDE_TO_TRAY,
    preferenceToWrite: null,
    reason: "dialog-close-to-tray"
  });
});

test("remembered dialog choice writes preference", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "ask",
    coreRunning: true,
    isExplicitQuit: false,
    dialogChoice: { choice: WINDOW_CLOSE_CHOICES.QUIT, remember: true }
  }), {
    action: WINDOW_CLOSE_ACTIONS.FULL_QUIT,
    preferenceToWrite: WINDOW_CLOSE_CHOICES.QUIT,
    reason: "dialog-quit"
  });
});

test("remembered close-to-tray dialog choice is rejected when Core is not running", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "ask",
    coreRunning: false,
    isExplicitQuit: false,
    dialogChoice: { choice: WINDOW_CLOSE_CHOICES.CLOSE_TO_TRAY, remember: true }
  }), {
    action: WINDOW_CLOSE_ACTIONS.KEEP_OPEN,
    preferenceToWrite: null,
    reason: "core-not-running"
  });
});

test("dialog result maps first button and cancel to close-to-tray", () => {
  assert.deepEqual(dialogResultToWindowCloseChoice({ response: 0, checkboxChecked: true }), {
    choice: WINDOW_CLOSE_CHOICES.CLOSE_TO_TRAY,
    remember: true
  });
  assert.deepEqual(dialogResultToWindowCloseChoice({ response: -1, checkboxChecked: false }), {
    choice: WINDOW_CLOSE_CHOICES.CLOSE_TO_TRAY,
    remember: false
  });
});

test("dialog result maps second button to quit", () => {
  assert.deepEqual(dialogResultToWindowCloseChoice({ response: 1, checkboxChecked: true }), {
    choice: WINDOW_CLOSE_CHOICES.QUIT,
    remember: true
  });
});

test("prompt copy and button order match product decision", () => {
  assert.deepEqual(windowClosePromptOptions(), {
    type: "question",
    title: "Keep Mia running in the background?",
    message: "Keep Mia running in the background?",
    detail: "After closing the window, Mia will stay in the menu bar/system tray and Mia Core will keep running for background tasks and local services. You can reopen Mia from the menu bar/system tray, or choose \"Quit Mia\" there to fully stop it.",
    buttons: ["Close to Tray", "Quit Mia"],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: "Remember my choice",
    checkboxChecked: false,
    noLink: true
  });
});

test("normalizes unknown stored close behavior to ask", () => {
  assert.equal(normalizeWindowCloseBehavior("quit"), "quit");
  assert.equal(normalizeWindowCloseBehavior("close-to-tray"), "close-to-tray");
  assert.equal(normalizeWindowCloseBehavior("background"), "ask");
});
