const path = require("node:path");

function runtimeTargetId(input = {}) {
  const platform = input.platform || process.platform;
  const arch = input.arch || process.arch;
  return `${platform}-${arch}`;
}

function bundledHermesRuntimeDir(input = {}) {
  const home = String(input.home || "").trim();
  return home ? path.join(home, "engine-backups", "hermes", runtimeTargetId(input)) : "";
}

function bundledPython(root, input = {}) {
  if (!root) return "";
  const platform = input.platform || process.platform;
  const candidate = platform === "win32"
    ? path.join(root, "python", "python.exe")
    : path.join(root, "python", "bin", "python3");
  return candidate;
}

function bundledSitePackages(root) {
  if (!root) return "";
  return path.join(root, "site-packages");
}

module.exports = {
  bundledHermesRuntimeDir,
  bundledPython,
  bundledSitePackages,
  runtimeTargetId
};
