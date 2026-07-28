"use strict";

const DEFAULT_OLD_SPACE_MB = 512;
const DEFAULT_SEMI_SPACE_MB = 16;
const MIN_OLD_SPACE_MB = 128;
const MAX_OLD_SPACE_MB = 2048;
const MIN_SEMI_SPACE_MB = 2;
const MAX_SEMI_SPACE_MB = 32;

function boundedInteger(value, { fallback, min, max }) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function resolveWindowsMemoryBudget({
  env = process.env,
  platform = process.platform
} = {}) {
  if (platform !== "win32" || env.MIA_DISABLE_MEMORY_BUDGET === "1") {
    return {
      enabled: false,
      jsFlags: "",
      oldSpaceMb: 0,
      semiSpaceMb: 0
    };
  }

  const oldSpaceMb = boundedInteger(env.MIA_MEMORY_OLD_SPACE_MB, {
    fallback: DEFAULT_OLD_SPACE_MB,
    min: MIN_OLD_SPACE_MB,
    max: MAX_OLD_SPACE_MB
  });
  const semiSpaceMb = boundedInteger(env.MIA_MEMORY_SEMI_SPACE_MB, {
    fallback: DEFAULT_SEMI_SPACE_MB,
    min: MIN_SEMI_SPACE_MB,
    max: MAX_SEMI_SPACE_MB
  });

  return {
    enabled: true,
    // Keep a bounded heap without forcing V8's size-first compilation policy.
    // Electron is an interactive UI: --optimize-for-size trades typing and
    // rendering throughput for a small memory saving and is the wrong default.
    jsFlags: `--max-old-space-size=${oldSpaceMb} --max-semi-space-size=${semiSpaceMb}`,
    oldSpaceMb,
    semiSpaceMb
  };
}

function hasJsFlags(argv = []) {
  return argv.some((arg) => String(arg || "").startsWith("--js-flags="));
}

function bootstrapWindowsMemoryBudget({
  argv = process.argv,
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  spawn
} = {}) {
  const policy = resolveWindowsMemoryBudget({ env, platform });
  if (!policy.enabled) return { policy, relaunched: false };

  env.MIA_MEMORY_BUDGET = "1";
  const shouldRelaunch = env.MIA_MEMORY_BUDGET_RELAUNCHED !== "1" && !hasJsFlags(argv);
  if (!shouldRelaunch) return { policy, relaunched: false };
  if (typeof spawn !== "function") throw new Error("spawn dependency is required.");

  const forwardedArgs = argv
    .slice(1)
    .filter((arg) => !String(arg || "").startsWith("--js-flags="));
  const child = spawn(
    execPath,
    [`--js-flags=${policy.jsFlags}`, ...forwardedArgs],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...env,
        MIA_MEMORY_BUDGET_RELAUNCHED: "1",
        MIA_MEMORY_BUDGET: "1"
      }
    }
  );
  child.unref();
  return { policy, relaunched: true };
}

function installWindowsMemoryBudgetForChildProcesses({
  app,
  argv = process.argv,
  policy = resolveWindowsMemoryBudget()
} = {}) {
  if (!policy.enabled || hasJsFlags(argv)) return false;
  if (!app?.commandLine || typeof app.commandLine.appendSwitch !== "function") {
    throw new Error("Electron app.commandLine dependency is required.");
  }
  app.commandLine.appendSwitch("js-flags", policy.jsFlags);
  return true;
}

module.exports = {
  DEFAULT_OLD_SPACE_MB,
  DEFAULT_SEMI_SPACE_MB,
  bootstrapWindowsMemoryBudget,
  hasJsFlags,
  installWindowsMemoryBudgetForChildProcesses,
  resolveWindowsMemoryBudget
};
