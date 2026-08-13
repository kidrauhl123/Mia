#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");
const electronBuilderConfig = path.join(root, "electron-builder.win.js");
const releaseDir = path.join(root, "release");
const productName = packageJson.productName || "Mia";
const version = packageJson.version || "0.0.0";
const fullInstallerName = `${productName}-${version}-Setup.exe`;
const updateInstallerName = `${productName}-${version}-Update.exe`;
const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://npmmirror.com/mirrors/electron-builder-binaries/"
};

function run(command, args, envOverrides = {}) {
  childProcess.execFileSync(command, args, {
    cwd: root,
    env: { ...env, ...envOverrides },
    stdio: "inherit"
  });
}

function cleanRelease() {
  run(process.execPath, [path.join(root, "scripts", "clean-release.js")]);
}

function verifyPackage(managedResourcesMode) {
  run(process.execPath, [
    path.join(root, "scripts", "verify-packaged-mia-core.js"),
    "--app",
    path.join(releaseDir, "win-unpacked"),
    "--arch",
    "x64",
    "--platform",
    "win32",
    "--managed-resources",
    managedResourcesMode
  ]);
}

function artifactPaths(name) {
  return [
    path.join(releaseDir, name),
    path.join(releaseDir, `${name}.blockmap`)
  ];
}

function assertArtifacts(paths, label) {
  const missing = paths.filter((file) => !fs.existsSync(file));
  if (missing.length) {
    throw new Error(`${label} is incomplete: ${missing.join(", ")}`);
  }
}

function buildWindowsRelease() {
  cleanRelease();
  run(process.execPath, [electronBuilderCli, "--config", electronBuilderConfig, "--win", "nsis", "--publish", "never"], {
    MIA_MANAGED_RESOURCES_PREPARE: "1"
  });
  verifyPackage("required");

  const fullArtifacts = artifactPaths(fullInstallerName);
  assertArtifacts(fullArtifacts, "Windows installer");
  const artifactStash = fs.mkdtempSync(path.join(path.dirname(releaseDir), "mia-win-installer-"));

  try {
    for (const file of fullArtifacts) {
      fs.copyFileSync(file, path.join(artifactStash, path.basename(file)));
    }

    cleanRelease();
    run(
      process.execPath,
      [
        electronBuilderCli,
        "--config",
        electronBuilderConfig,
        "--win",
        "nsis",
        "--publish",
        "never",
        `--config.win.artifactName=${productName}-${version}-Update.\${ext}`
      ],
      { MIA_MANAGED_RESOURCES_PREPARE: "1" }
    );
    verifyPackage("required");

    const updateArtifacts = artifactPaths(updateInstallerName);
    assertArtifacts(updateArtifacts, "Windows update installer");
    for (const file of fullArtifacts) {
      fs.copyFileSync(path.join(artifactStash, path.basename(file)), file);
    }
  } finally {
    fs.rmSync(artifactStash, { recursive: true, force: true });
  }

  run(process.execPath, [path.join(root, "scripts", "clean-release.js"), "--tidy"]);
}

if (require.main === module) {
  buildWindowsRelease();
}

module.exports = {
  artifactPaths,
  buildWindowsRelease,
  fullInstallerName,
  updateInstallerName
};
