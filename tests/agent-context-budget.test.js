const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildContextBudgetLogLine } = require("../src/main/agent-context-budget.js");

test("context budget log keeps zero-valued prompt component fields visible", () => {
  const line = buildContextBudgetLogLine({
    engine: "hermes",
    botId: "alice",
    sessionId: "s1",
    nativeSessionId: "mia:alice:s1",
    historyMode: "native",
    nativeHistory: true,
    promptChars: 2,
    currentUserChars: 2,
    systemChars: 0,
    personaChars: 0,
    memoryChars: 0,
    skillIndexChars: 0,
    loadedSkillChars: 0,
    visibleHistoryChars: 0,
    includedHistoryChars: 0,
    groupChars: 0
  });

  for (const field of [
    "promptChars=2",
    "systemChars=0",
    "personaChars=0",
    "memoryChars=0",
    "skillIndexChars=0",
    "loadedSkillChars=0",
    "visibleHistoryChars=0",
    "includedHistoryChars=0",
    "groupChars=0"
  ]) {
    assert.match(line, new RegExp(`(?:^| )${field}(?: |$)`));
  }
});
