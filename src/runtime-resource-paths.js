const fs = require("node:fs");
const path = require("node:path");

function runtimeTargetId(input = {}) {
  const platform = input.platform || process.platform;
  const arch = input.arch || process.arch;
  if (platform === "darwin") return arch === "x64" ? "mac-x64" : "mac-arm64";
  if (platform === "win32") return "win-x64";
  if (platform === "linux") return "linux-x64";
  return `${platform}-${arch}`;
}

function bundledHermesRuntimeDir(input = {}) {
  const existsSync = input.existsSync || fs.existsSync;
  const target = runtimeTargetId(input);
  const candidates = [
    input.resourcesPath ? path.join(input.resourcesPath, "hermes-runtime") : "",
    input.appPath ? path.join(input.appPath, "vendor", "hermes-runtime", target) : "",
    input.cwd ? path.join(input.cwd, "vendor", "hermes-runtime", target) : ""
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function bundledPython(root, input = {}) {
  if (!root) return "";
  const candidate = input.platform === "win32"
    ? path.join(root, "python", "python.exe")
    : path.join(root, "python", "bin", "python3");
  const existsSync = input.existsSync || fs.existsSync;
  return existsSync(candidate) ? candidate : "";
}

function bundledSitePackages(root, input = {}) {
  if (!root) return "";
  const candidate = path.join(root, "site-packages");
  const existsSync = input.existsSync || fs.existsSync;
  return existsSync(candidate) ? candidate : "";
}

module.exports = {
  runtimeTargetId,
  bundledHermesRuntimeDir,
  bundledPython,
  bundledSitePackages
};
