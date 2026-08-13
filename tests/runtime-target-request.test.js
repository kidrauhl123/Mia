"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { compactRuntimeTargetRequest } = require("../src/shared/runtime-target-request.js");

test("runtime target transport drops oversized renderer state and preserves Core inputs", () => {
  const oversizedDetail = "x".repeat(2_200_000);
  const request = compactRuntimeTargetRequest({
    bot: {
      id: "bot-1",
      runtimeKind: "desktop-local",
      avatarImage: oversizedDetail,
      targetIntent: {
        deviceId: "win-local",
        deviceName: "Windows PC",
        agentEngine: "codex"
      }
    },
    runtime: {
      oversizedDetail,
      cloud: { enabled: false, oversizedDetail },
      localDevice: { id: "win-local", name: "Windows PC", oversizedDetail },
      agentInventory: {
        agents: [
          { id: "hermes", usableInMia: true, readiness: { detail: oversizedDetail } },
          { id: "claude-code", usableInMia: true },
          { id: "codex", installed: true, usableInMia: false, installAction: "install-codex" }
        ]
      },
      agentEngines: {
        hermes: { available: true, oversizedDetail },
        claudeCode: { available: true },
        codex: { available: true }
      }
    },
    engineCapabilities: {
      oversizedDetail,
      engines: { codex: { available: true, models: [{ oversizedDetail }] } }
    },
    preferredAgentEngine: "codex"
  });

  assert.ok(JSON.stringify(request).length < 20_000);
  assert.equal(request.runtime.oversizedDetail, undefined);
  assert.equal(request.runtime.agentInventory.agents[0].readiness, undefined);
  assert.equal(request.bot.avatarImage, undefined);
  assert.deepEqual(
    request.runtime.agentInventory.agents.map((agent) => agent.id),
    ["hermes", "claude-code", "codex"]
  );
  assert.deepEqual(request.runtime.agentInventory.agents[2], {
    id: "codex",
    installed: true,
    usableInMia: false,
    installAction: "install-codex"
  });
  assert.deepEqual(request.engineCapabilities.engines.codex.models, [true]);
  assert.deepEqual(request.bot.targetIntent, {
    runtimeKind: "",
    deviceId: "win-local",
    deviceName: "Windows PC",
    agentEngine: "codex"
  });
});
