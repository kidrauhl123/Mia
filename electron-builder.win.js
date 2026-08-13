const pkg = require("./package.json");

const build = pkg.build || {};
const extraResources = (build.extraResources || []).map((resource) => (
  resource?.to === "bundled-mia-core"
    ? { ...resource, filter: ["win32-x64/**/*"] }
    : resource
));

module.exports = {
  ...build,
  extraResources
};
