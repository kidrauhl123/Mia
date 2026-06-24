const pkg = require("./package.json");
const afterPack = require("./build/afterpack-mia-core-helper.js");

const build = pkg.build || {};

module.exports = {
  ...build,
  afterPack,
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
