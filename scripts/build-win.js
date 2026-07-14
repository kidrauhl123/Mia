#!/usr/bin/env node

const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");
const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://npmmirror.com/mirrors/electron-builder-binaries/"
};

function run(command, args) {
  childProcess.execFileSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit"
  });
}

run(process.execPath, [path.join(root, "scripts", "clean-release.js")]);
run(process.execPath, [electronBuilderCli, "--win", "nsis", "--publish", "never"]);
run(process.execPath, [
  path.join(root, "scripts", "verify-packaged-mia-core.js"),
  "--app",
  path.join(root, "release", "win-unpacked"),
  "--arch",
  "x64",
  "--platform",
  "win32"
]);
run(process.execPath, [path.join(root, "scripts", "clean-release.js"), "--tidy"]);
