#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");

function target() {
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return {
      arch,
      platform: "darwin",
      config: arch === "arm64" ? "electron-builder.mac-arm64.js" : "electron-builder.mac-intel.js",
      args: ["--mac", "dir", `--${arch}`, "--config.mac.identity=null"]
    };
  }
  if (process.platform === "win32") {
    return {
      arch: "x64",
      platform: "win32",
      config: "electron-builder.win.js",
      args: ["--win", "dir", "--x64"]
    };
  }
  throw new Error(`Desktop directory packaging is unsupported on ${process.platform}.`);
}

function run(command, args, env = {}) {
  childProcess.execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit"
  });
}

const selected = target();
run(process.execPath, [
  electronBuilderCli,
  "--config",
  path.join(root, selected.config),
  ...selected.args,
  "--publish",
  "never"
], { MIA_MANAGED_RESOURCES_PREPARE: "0" });
run(process.execPath, [
  path.join(root, "scripts", "verify-packaged-mia-core.js"),
  "--arch",
  selected.arch,
  "--platform",
  selected.platform,
  "--managed-resources",
  "forbidden"
]);
