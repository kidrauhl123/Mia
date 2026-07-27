const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  applyWindowsGpuPolicy,
  softwareGpuRequested
} = require("../src/main/windows-gpu-policy.js");

function fakeApp() {
  const switches = [];
  return {
    switches,
    app: {
      commandLine: {
        appendSwitch(name, value) {
          switches.push({ name, value });
        }
      }
    }
  };
}

test("Windows uses Chromium automatic GPU selection by default", () => {
  const { app, switches } = fakeApp();

  const result = applyWindowsGpuPolicy({
    app,
    env: {},
    platform: "win32"
  });

  assert.deepEqual(result, { mode: "automatic", switches: [] });
  assert.deepEqual(switches, []);
});

test("Windows software GPU mode is an explicit compatibility fallback", () => {
  const { app, switches } = fakeApp();

  const result = applyWindowsGpuPolicy({
    app,
    env: { MIA_GPU_MODE: "software" },
    platform: "win32"
  });

  assert.equal(result.mode, "software");
  assert.deepEqual(switches, [
    { name: "disable-gpu-compositing", value: undefined },
    { name: "use-gl", value: "angle" },
    { name: "use-angle", value: "swiftshader-webgl" }
  ]);
});

test("legacy-style disable flag also opts into software GPU mode", () => {
  assert.equal(softwareGpuRequested({ MIA_DISABLE_HARDWARE_GPU: "1" }), true);
  assert.equal(softwareGpuRequested({ MIA_DISABLE_HARDWARE_GPU: "0" }), false);
});

test("non-Windows platforms never receive Windows GPU switches", () => {
  const { app, switches } = fakeApp();

  const result = applyWindowsGpuPolicy({
    app,
    env: { MIA_GPU_MODE: "software" },
    platform: "darwin"
  });

  assert.deepEqual(result, { mode: "automatic", switches: [] });
  assert.deepEqual(switches, []);
});

test("main startup wires the centralized Windows GPU policy", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");

  assert.match(mainSource, /require\("\.\/main\/windows-gpu-policy\.js"\)/);
  assert.match(mainSource, /applyWindowsGpuPolicy\(\{\s*app,\s*env: process\.env,\s*platform: process\.platform\s*\}\)/);
  assert.doesNotMatch(mainSource, /app\.commandLine\.appendSwitch\("disable-gpu-compositing"\)/);
});
