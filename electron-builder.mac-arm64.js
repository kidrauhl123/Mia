const pkg = require("./package.json");
const afterPack = require("./build/afterpack-mia-core-helper.js");

const build = pkg.build || {};

module.exports = {
  ...build,
  afterPack,
  mac: {
    ...(build.mac || {}),
    target: ["dir", "zip"]
  },
  dmg: {
    ...(build.dmg || {}),
    artifactName: "${productName}-${version}-Apple-Silicon.${ext}"
  }
};
