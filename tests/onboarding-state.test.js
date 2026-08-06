const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createOnboardingState } = require("../src/main/onboarding-state.js");

function tempState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-onboarding-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "mia-onboarding.json");
}

test("clean installs remain first-run pending until onboarding completes", (t) => {
  const filePath = tempState(t);
  const first = createOnboardingState({
    filePath,
    legacyInstallDetected: false,
    now: () => "2026-08-06T08:00:00.000Z"
  });
  assert.equal(first.isFirstRunPending(), true);

  const resumed = createOnboardingState({ filePath, legacyInstallDetected: true });
  assert.equal(resumed.isFirstRunPending(), true);
  assert.deepEqual(resumed.complete({ defaultMiaRuntime: "desktop-local" }), {
    status: "complete",
    defaultMiaRuntime: "desktop-local"
  });

  const completed = createOnboardingState({ filePath, legacyInstallDetected: false });
  assert.equal(completed.isFirstRunPending(), false);
  assert.equal(completed.snapshot().defaultMiaRuntime, "desktop-local");
  completed.complete({ defaultMiaRuntime: "" });
  assert.equal(completed.snapshot().defaultMiaRuntime, "desktop-local");
});

test("legacy installs initialize as complete without selecting a new default runtime", (t) => {
  const state = createOnboardingState({
    filePath: tempState(t),
    legacyInstallDetected: true,
    now: () => "2026-08-06T08:00:00.000Z"
  });

  assert.equal(state.isFirstRunPending(), false);
  assert.deepEqual(state.snapshot(), { status: "complete", defaultMiaRuntime: "" });
});
