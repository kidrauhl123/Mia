const pkg = require("./package.json");

const build = pkg.build || {};

module.exports = {
  ...build,
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
