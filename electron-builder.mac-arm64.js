const pkg = require("./package.json");

const build = pkg.build || {};
const extraResources = (build.extraResources || []).map((resource) => (
  resource?.to === "bundled-mia-core"
    ? { ...resource, filter: ["darwin-arm64/**/*"] }
    : resource
));

module.exports = {
  ...build,
  extraResources,
  mac: {
    ...(build.mac || {}),
    target: ["dir", "zip"]
  },
  dmg: {
    ...(build.dmg || {}),
    artifactName: "${productName}-${version}-Apple-Silicon.${ext}"
  }
};
