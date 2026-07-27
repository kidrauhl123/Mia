const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_OLD_SPACE_MB,
  DEFAULT_SEMI_SPACE_MB,
  bootstrapWindowsMemoryBudget,
  installWindowsMemoryBudgetForChildProcesses,
  resolveWindowsMemoryBudget
} = require("../src/main/windows-memory-policy.js");

test("Windows memory policy keeps a bounded heap with production-safe headroom", () => {
  const policy = resolveWindowsMemoryBudget({
    env: {},
    platform: "win32"
  });

  assert.equal(policy.enabled, true);
  assert.equal(policy.oldSpaceMb, DEFAULT_OLD_SPACE_MB);
  assert.equal(policy.semiSpaceMb, DEFAULT_SEMI_SPACE_MB);
  assert.equal(
    policy.jsFlags,
    `--max-old-space-size=${DEFAULT_OLD_SPACE_MB} `
      + `--max-semi-space-size=${DEFAULT_SEMI_SPACE_MB} --optimize-for-size`
  );
  assert.ok(policy.oldSpaceMb >= 512, "renderer heap must not return to the crash-prone 64 MB cap");
});

test("Windows memory policy is disabled off Windows or through the compatibility escape hatch", () => {
  assert.equal(resolveWindowsMemoryBudget({ env: {}, platform: "darwin" }).enabled, false);
  assert.equal(resolveWindowsMemoryBudget({
    env: { MIA_DISABLE_MEMORY_BUDGET: "1" },
    platform: "win32"
  }).enabled, false);
});

test("Windows memory policy accepts bounded deployment overrides", () => {
  const minimum = resolveWindowsMemoryBudget({
    env: {
      MIA_MEMORY_OLD_SPACE_MB: "64",
      MIA_MEMORY_SEMI_SPACE_MB: "1"
    },
    platform: "win32"
  });
  const maximum = resolveWindowsMemoryBudget({
    env: {
      MIA_MEMORY_OLD_SPACE_MB: "99999",
      MIA_MEMORY_SEMI_SPACE_MB: "99999"
    },
    platform: "win32"
  });

  assert.equal(minimum.oldSpaceMb, 128);
  assert.equal(minimum.semiSpaceMb, 2);
  assert.equal(maximum.oldSpaceMb, 2048);
  assert.equal(maximum.semiSpaceMb, 32);
});

test("Windows memory bootstrap relaunches once and preserves application arguments", () => {
  const calls = [];
  let unrefCalls = 0;
  const env = { EXISTING_SETTING: "kept" };
  const result = bootstrapWindowsMemoryBudget({
    argv: ["Mia.exe", "--profile=test"],
    env,
    execPath: "Mia.exe",
    platform: "win32",
    spawn: (...args) => {
      calls.push(args);
      return { unref: () => { unrefCalls += 1; } };
    }
  });

  assert.equal(result.relaunched, true);
  assert.equal(env.MIA_MEMORY_BUDGET, "1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [
    `--js-flags=${result.policy.jsFlags}`,
    "--profile=test"
  ]);
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[0][2].stdio, "ignore");
  assert.equal(calls[0][2].env.EXISTING_SETTING, "kept");
  assert.equal(calls[0][2].env.MIA_MEMORY_BUDGET_RELAUNCHED, "1");
  assert.equal(unrefCalls, 1);
});

test("Windows memory bootstrap does not loop or replace explicit js flags", () => {
  let spawnCalls = 0;
  const spawn = () => {
    spawnCalls += 1;
    return { unref() {} };
  };

  assert.equal(bootstrapWindowsMemoryBudget({
    argv: ["Mia.exe", "--js-flags=--trace-gc"],
    env: {},
    platform: "win32",
    spawn
  }).relaunched, false);
  assert.equal(bootstrapWindowsMemoryBudget({
    argv: ["Mia.exe"],
    env: { MIA_MEMORY_BUDGET_RELAUNCHED: "1" },
    platform: "win32",
    spawn
  }).relaunched, false);
  assert.equal(spawnCalls, 0);
});

test("child renderer processes inherit the same policy when the main argv is uncapped", () => {
  const switches = [];
  const app = {
    commandLine: {
      appendSwitch: (...args) => switches.push(args)
    }
  };
  const policy = resolveWindowsMemoryBudget({ env: {}, platform: "win32" });

  assert.equal(installWindowsMemoryBudgetForChildProcesses({
    app,
    argv: ["Mia.exe"],
    policy
  }), true);
  assert.deepEqual(switches, [["js-flags", policy.jsFlags]]);
  assert.equal(installWindowsMemoryBudgetForChildProcesses({
    app,
    argv: ["Mia.exe", `--js-flags=${policy.jsFlags}`],
    policy
  }), false);
  assert.equal(switches.length, 1);
});
