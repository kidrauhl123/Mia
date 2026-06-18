const fs = require("node:fs");
const path = require("node:path");
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");

const PERMISSION = "android.permission.REQUEST_INSTALL_PACKAGES";
const PROVIDER_NAME = "androidx.core.content.FileProvider";
const PATHS_RESOURCE = "@xml/mia_update_file_paths";
const FILE_PROVIDER_PATHS = "android.support.FILE_PROVIDER_PATHS";

function ensureUsesPermission(manifest, permissionName) {
  const permissions = manifest.manifest["uses-permission"] || [];
  if (!permissions.some((item) => item.$["android:name"] === permissionName)) {
    permissions.push({ $: { "android:name": permissionName } });
  }
  manifest.manifest["uses-permission"] = permissions;
}

function ensureProvider(androidManifest) {
  const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  const authority = "${applicationId}.mia_update_file_provider";
  const providers = mainApplication.provider || [];
  const existing = providers.find(
    (provider) =>
      provider.$["android:authorities"] === authority ||
      (provider.$["android:name"] === PROVIDER_NAME &&
        String(provider.$["android:authorities"] || "").endsWith(".mia_update_file_provider"))
  );
  const provider = existing || {
    $: {
      "android:name": PROVIDER_NAME,
      "android:exported": "false",
      "android:grantUriPermissions": "true",
    },
    "meta-data": [],
  };
  provider.$["android:authorities"] = authority;

  provider["meta-data"] = provider["meta-data"] || [];
  if (!provider["meta-data"].some((meta) => meta.$["android:name"] === FILE_PROVIDER_PATHS)) {
    provider["meta-data"].push({
      $: {
        "android:name": FILE_PROVIDER_PATHS,
        "android:resource": PATHS_RESOURCE,
      },
    });
  }

  if (!existing) providers.push(provider);
  mainApplication.provider = providers;
}

function writeFilePathsXml(projectRoot) {
  const xmlDir = path.join(projectRoot, "android", "app", "src", "main", "res", "xml");
  fs.mkdirSync(xmlDir, { recursive: true });
  fs.writeFileSync(
    path.join(xmlDir, "mia_update_file_paths.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <cache-path name="mia_updates" path="mia-updates/" />
</paths>
`
  );
}

function withMiaAndroidUpdater(config) {
  config = withAndroidManifest(config, (modConfig) => {
    ensureUsesPermission(modConfig.modResults, PERMISSION);
    ensureProvider(modConfig.modResults);
    return modConfig;
  });

  config = withDangerousMod(config, [
    "android",
    (modConfig) => {
      writeFilePathsXml(modConfig.modRequest.projectRoot);
      return modConfig;
    },
  ]);

  return config;
}

module.exports = withMiaAndroidUpdater;
