"use strict";

const { buildRendererReact } = require("./build-renderer-react.js");
const prepareMiaCoreRs = require("./prepare-mia-core-rs.js");

async function prepareDesktopPackage(context) {
  await buildRendererReact({ minify: true, quiet: false });
  return prepareMiaCoreRs(context);
}

module.exports = prepareDesktopPackage;
