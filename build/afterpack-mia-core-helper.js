"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HELPER_APP_NAME = "Mia Core";
const HELPER_BUNDLE_ID = "ai.mia.core";

function buildHelperInfoPlist({ appName }) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>CFBundleExecutable</key>`,
    `  <string>${appName}</string>`,
    `  <key>CFBundleIdentifier</key>`,
    `  <string>${HELPER_BUNDLE_ID}</string>`,
    `  <key>CFBundleName</key>`,
    `  <string>${appName}</string>`,
    `  <key>CFBundlePackageType</key>`,
    `  <string>APPL</string>`,
    `  <key>LSUIElement</key>`,
    `  <true/>`,
    `  <key>LSBackgroundOnly</key>`,
    `  <true/>`,
    `</dict>`,
    `</plist>`,
    ``
  ].join("\n");
}

function helperLayout(appOutDir, productFilename) {
  const appBundle = appOutDir.endsWith(".app") ? appOutDir : path.join(appOutDir, `${productFilename}.app`);
  const helperAppDir = path.join(appBundle, "Contents", "Resources", `${HELPER_APP_NAME}.app`);
  const helperMacOSDir = path.join(helperAppDir, "Contents", "MacOS");
  return {
    appBundle,
    helperAppDir,
    helperMacOSDir,
    helperExecPath: path.join(helperMacOSDir, HELPER_APP_NAME),
    helperInfoPlistPath: path.join(helperAppDir, "Contents", "Info.plist"),
    sourceExecPath: path.join(appBundle, "Contents", "MacOS", productFilename)
  };
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const productFilename = context.packager.appInfo.productFilename;
  const layout = helperLayout(context.appOutDir, productFilename);
  fs.mkdirSync(layout.helperMacOSDir, { recursive: true });
  fs.copyFileSync(layout.sourceExecPath, layout.helperExecPath);
  fs.chmodSync(layout.helperExecPath, 0o755);
  fs.writeFileSync(layout.helperInfoPlistPath, buildHelperInfoPlist({ appName: HELPER_APP_NAME }));
}

module.exports = afterPack;
module.exports.afterPack = afterPack;
module.exports.buildHelperInfoPlist = buildHelperInfoPlist;
module.exports.helperLayout = helperLayout;
module.exports.HELPER_APP_NAME = HELPER_APP_NAME;
module.exports.HELPER_BUNDLE_ID = HELPER_BUNDLE_ID;
