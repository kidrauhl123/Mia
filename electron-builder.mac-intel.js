const pkg = require("./package.json");

const build = pkg.build || {};

module.exports = {
  ...build,
  mac: {
    ...(build.mac || {}),
    target: ["dir", "zip"]
  },
  dmg: {
    ...(build.dmg || {}),
    artifactName: "${productName}-${version}-Intel.${ext}"
  }
};
