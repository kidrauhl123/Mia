#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");
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
  run(process.execPath, [electronBuilderCli, "--win", "nsis", "--publish", "never"]);
  verifyPackage("required");

  const fullArtifacts = artifactPaths(fullInstallerName);
  assertArtifacts(fullArtifacts, "Full Windows installer");
  const artifactStash = fs.mkdtempSync(path.join(os.tmpdir(), "mia-win-full-installer-"));
  const bundleRoot = path.join(root, "resources", "bundled-mia-core");
  const bundleTarget = path.join(bundleRoot, "win32-x64");
  // Keep the full bundle outside resources/bundled-mia-core while building the
  // update artifact. A sibling inside bundleRoot would be picked up by the
  // extraResources glob and silently make the "lightweight" package huge.
  const bundleStash = path.join(root, `.mia-win-full-bundle-${process.pid}`);

  try {
    for (const file of fullArtifacts) {
      fs.copyFileSync(file, path.join(artifactStash, path.basename(file)));
    }

    if (!fs.existsSync(bundleTarget)) {
      throw new Error(`Full Windows build did not prepare ${bundleTarget}`);
    }
    if (fs.existsSync(bundleStash)) {
      throw new Error(`Refusing to overwrite stale bundle staging directory: ${bundleStash}`);
    }
    fs.renameSync(bundleTarget, bundleStash);

    cleanRelease();
    run(
      process.execPath,
      [
        electronBuilderCli,
        "--win",
        "nsis",
        "--publish",
        "never",
        `--config.win.artifactName=${productName}-${version}-Update.\${ext}`
      ],
      { MIA_MANAGED_RESOURCES_PREPARE: "0" }
    );
    verifyPackage("forbidden");

    const updateArtifacts = artifactPaths(updateInstallerName);
    assertArtifacts(updateArtifacts, "Lightweight Windows update installer");
    for (const file of fullArtifacts) {
      fs.copyFileSync(path.join(artifactStash, path.basename(file)), file);
    }
  } finally {
    if (fs.existsSync(bundleStash)) {
      fs.rmSync(bundleTarget, { recursive: true, force: true });
      fs.renameSync(bundleStash, bundleTarget);
    }
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
