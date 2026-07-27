const SOFTWARE_GPU_SWITCHES = Object.freeze([
  Object.freeze(["disable-gpu-compositing"]),
  Object.freeze(["use-gl", "angle"]),
  Object.freeze(["use-angle", "swiftshader-webgl"])
]);

function softwareGpuRequested(env = {}) {
  const mode = String(env.MIA_GPU_MODE || "").trim().toLowerCase();
  return mode === "software" || env.MIA_DISABLE_HARDWARE_GPU === "1";
}

function applyWindowsGpuPolicy({
  app,
  env = process.env,
  platform = process.platform
} = {}) {
  // Chromium already handles driver blocklists and automatic fallback. Keep
  // hardware compositing as the Windows default so moving and resizing a live
  // app surface does not fall back to CPU rasterization.
  if (platform !== "win32" || !softwareGpuRequested(env)) {
    return { mode: "automatic", switches: [] };
  }

  if (typeof app?.commandLine?.appendSwitch !== "function") {
    throw new TypeError("Electron app.commandLine.appendSwitch is required");
  }

  for (const [name, value] of SOFTWARE_GPU_SWITCHES) {
    if (value === undefined) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }

  return {
    mode: "software",
    switches: SOFTWARE_GPU_SWITCHES.map(([name, value]) => ({ name, value }))
  };
}

module.exports = {
  SOFTWARE_GPU_SWITCHES,
  applyWindowsGpuPolicy,
  softwareGpuRequested
};
