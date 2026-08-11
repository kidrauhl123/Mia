const pkg = require("./package.json");

const build = pkg.build || {};
const extraResources = (build.extraResources || []).map((resource) => (
  resource?.to === "bundled-mia-core"
    ? { ...resource, filter: ["darwin-x64/**/*"] }
    : resource
));

module.exports = {
  ...build,
  extraResources,
  mac: {
    ...(build.mac || {}),
    target: ["dir", "zip"],
    identity: "XiaoChuan Technology Co., Ltd. (S4NWU843M5)",
    hardenedRuntime: true
  },
  dmg: {
    ...(build.dmg || {}),
    artifactName: "${productName}-${version}-Intel.${ext}"
  }
};
