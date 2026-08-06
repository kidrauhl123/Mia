const fs = require("node:fs");
const path = require("node:path");

const ONBOARDING_PENDING = "pending";
const ONBOARDING_COMPLETE = "complete";

function readState(fsImpl, filePath) {
  try {
    if (!fsImpl.existsSync(filePath)) return null;
    const value = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    if (![ONBOARDING_PENDING, ONBOARDING_COMPLETE].includes(value?.status)) return null;
    return value;
  } catch {
    return null;
  }
}

function normalizeDefaultMiaRuntime(value) {
  return String(value || "").trim() === "desktop-local" ? "desktop-local" : "";
}

function createOnboardingState(options = {}) {
  const {
    filePath,
    legacyInstallDetected = false,
    fsImpl = fs,
    now = () => new Date().toISOString()
  } = options;
  if (!filePath) throw new Error("onboarding state path is required");

  function write(value) {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    return value;
  }

  let state = readState(fsImpl, filePath);
  if (!state) {
    state = write({
      status: legacyInstallDetected ? ONBOARDING_COMPLETE : ONBOARDING_PENDING,
      defaultMiaRuntime: "",
      initializedAt: now()
    });
  }

  return {
    isFirstRunPending() {
      return state.status === ONBOARDING_PENDING;
    },
    snapshot() {
      return {
        status: state.status,
        defaultMiaRuntime: normalizeDefaultMiaRuntime(state.defaultMiaRuntime)
      };
    },
    complete(input = {}) {
      const defaultMiaRuntime = state.status === ONBOARDING_PENDING
        ? normalizeDefaultMiaRuntime(input.defaultMiaRuntime)
        : normalizeDefaultMiaRuntime(state.defaultMiaRuntime);
      state = write({
        ...state,
        status: ONBOARDING_COMPLETE,
        defaultMiaRuntime,
        completedAt: now()
      });
      return this.snapshot();
    }
  };
}

module.exports = {
  createOnboardingState,
  ONBOARDING_PENDING,
  ONBOARDING_COMPLETE
};
