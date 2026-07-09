const WINDOW_CLOSE_BEHAVIORS = new Set(["ask", "close-to-tray", "quit"]);

const WINDOW_CLOSE_ACTIONS = Object.freeze({
  PROMPT: "prompt",
  HIDE_TO_TRAY: "hide-to-tray",
  FULL_QUIT: "full-quit",
  KEEP_OPEN: "keep-open",
  ALLOW_CLOSE: "allow-close"
});

const WINDOW_CLOSE_CHOICES = Object.freeze({
  CLOSE_TO_TRAY: "close-to-tray",
  QUIT: "quit"
});

function normalizeWindowCloseBehavior(value) {
  const behavior = String(value || "").trim();
  return WINDOW_CLOSE_BEHAVIORS.has(behavior) ? behavior : "ask";
}

function windowClosePromptOptions() {
  return {
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
  };
}

function dialogResultToWindowCloseChoice(result = {}) {
  return {
    choice: Number(result.response) === 1
      ? WINDOW_CLOSE_CHOICES.QUIT
      : WINDOW_CLOSE_CHOICES.CLOSE_TO_TRAY,
    remember: result.checkboxChecked === true
  };
}

function decision(action, preferenceToWrite, reason) {
  return { action, preferenceToWrite, reason };
}

function normalizeDialogChoice(choice) {
  return choice === WINDOW_CLOSE_CHOICES.QUIT
    ? WINDOW_CLOSE_CHOICES.QUIT
    : WINDOW_CLOSE_CHOICES.CLOSE_TO_TRAY;
}

function decideWindowClose(input = {}) {
  if (input.isExplicitQuit === true) {
    return decision(WINDOW_CLOSE_ACTIONS.ALLOW_CLOSE, null, "explicit-quit");
  }

  const dialogChoice = input.dialogChoice && typeof input.dialogChoice === "object"
    ? input.dialogChoice
    : null;
  if (dialogChoice) {
    const choice = normalizeDialogChoice(dialogChoice.choice);
    const remember = dialogChoice.remember === true;
    if (choice === WINDOW_CLOSE_CHOICES.QUIT) {
      return decision(
        WINDOW_CLOSE_ACTIONS.FULL_QUIT,
        remember ? WINDOW_CLOSE_CHOICES.QUIT : null,
        "dialog-quit"
      );
    }
    if (input.coreRunning !== true) {
      return decision(WINDOW_CLOSE_ACTIONS.KEEP_OPEN, null, "core-not-running");
    }
    return decision(
      WINDOW_CLOSE_ACTIONS.HIDE_TO_TRAY,
      remember ? WINDOW_CLOSE_CHOICES.CLOSE_TO_TRAY : null,
      "dialog-close-to-tray"
    );
  }

  const storedBehavior = normalizeWindowCloseBehavior(input.storedBehavior);
  if (storedBehavior === "quit") {
    return decision(WINDOW_CLOSE_ACTIONS.FULL_QUIT, null, "remembered-quit");
  }
  if (input.coreRunning !== true) {
    return decision(WINDOW_CLOSE_ACTIONS.KEEP_OPEN, null, "core-not-running");
  }
  if (storedBehavior === "close-to-tray") {
    return decision(WINDOW_CLOSE_ACTIONS.HIDE_TO_TRAY, null, "remembered-close-to-tray");
  }
  return decision(WINDOW_CLOSE_ACTIONS.PROMPT, null, "ask");
}

module.exports = {
  WINDOW_CLOSE_ACTIONS,
  WINDOW_CLOSE_CHOICES,
  normalizeWindowCloseBehavior,
  windowClosePromptOptions,
  dialogResultToWindowCloseChoice,
  decideWindowClose
};
