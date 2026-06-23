#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  resolveManagedAgentRuntime,
  runtimeKey
} = require("../src/main/agent-runtime/managed-agent-runtime.js");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function listValue(name) {
  return argValue(name)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const root = path.resolve(argValue("root", path.join(__dirname, "..", "resources", "managed-resources")));
const platform = argValue("platform", process.platform);
const arch = argValue("arch", process.arch);
const requiredEngines = listValue("require");
const key = runtimeKey(platform, arch);

const failures = [];
for (const engine of requiredEngines) {
  const runtime = resolveManagedAgentRuntime({
    engine,
    platform,
    arch,
    resourceRoots: [root]
  });
  if (runtime?.source === "managed") {
    console.log(`ok ${engine}: ${runtime.path}`);
    continue;
  }
  const diagnostics = Array.isArray(runtime?.diagnostics) ? runtime.diagnostics : [];
  const details = diagnostics
    .map((item) => item.invalid ? `${item.invalid}: ${item.reason}` : item.missing ? `missing ${item.missing}` : "")
    .filter(Boolean);
  failures.push(`${engine} has no managed runtime for ${key}${details.length ? `\n  ${details.join("\n  ")}` : ""}`);
}

if (!fs.existsSync(root)) failures.push(`managed resource root does not exist: ${root}`);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(requiredEngines.length
  ? `managed runtime verification passed for ${key}`
  : `managed runtime root is present for ${key}: ${root}`);
