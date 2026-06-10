const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function loadWizard(state) {
  const sandbox = {
    window: {},
    console,
    document: {
      querySelector() { return null; }
    }
  };
  const source = fs.readFileSync(path.join(root, "src/renderer/onboarding/onboarding-wizard.js"), "utf8");
  vm.runInNewContext(source, sandbox, { filename: "src/renderer/onboarding/onboarding-wizard.js" });
  sandbox.window.miaOnboardingWizard.initOnboardingWizard({ state });
  return sandbox.window.miaOnboardingWizard;
}

test("signed-out returning users do not reopen the first-run onboarding wizard", () => {
  const wizard = loadWizard({
    runtime: { cloud: { enabled: false } },
    onboardingStep: "done",
    setupGuideDismissed: true,
    agentSetupSkipped: false
  });

  assert.equal(wizard.isActive(), false);
});

test("signed-out first-run users still see the onboarding login wizard", () => {
  const wizard = loadWizard({
    runtime: { cloud: { enabled: false } },
    onboardingStep: "",
    setupGuideDismissed: false,
    agentSetupSkipped: false
  });

  assert.equal(wizard.isActive(), true);
  assert.equal(wizard.currentStep(), "login");
});
