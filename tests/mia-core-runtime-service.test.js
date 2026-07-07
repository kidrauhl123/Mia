"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createMiaCoreRuntimeService } = require("../src/main/mia-core/runtime-service.js");

test("botWithRuntimeConfig applies normalized Core profile references", () => {
  const service = createMiaCoreRuntimeService({
    normalizeAgentEngine: (value) => value || "hermes",
    enginePermissionStoreTarget: () => "root-mode",
    sendWithChatEngineAdapter: async () => null
  });

  const bot = service.botWithRuntimeConfig(
    { key: "bot-a", engineConfig: { existing: "keep" } },
    {
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto",
      effortLevel: "medium",
      permissionMode: "ask"
    },
    { agentEngine: "hermes" }
  );

  assert.deepEqual(bot.engineConfig, {
    existing: "keep",
    providerConnectionId: "mia",
    modelProfileId: "mia:mia-auto",
    model: "mia-auto",
    effortLevel: "medium",
    permissionMode: "ask"
  });
});

test("cloudBotSnapshotForTurn accepts runtime-selected engine", () => {
  const service = createMiaCoreRuntimeService({
    normalizeAgentEngine: (value) => value === "open-claw" ? "hermes" : (value || "hermes"),
    enginePermissionStoreTarget: () => "root-mode",
    sendWithChatEngineAdapter: async () => null
  });

  const bot = service.cloudBotSnapshotForTurn(
    { key: "bot-a", name: "Bot A" },
    "bot-a",
    { agentEngine: "open-claw" }
  );

  assert.equal(bot.agentEngine, "hermes");
});
