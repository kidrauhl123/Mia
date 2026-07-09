"use strict";

const fs = require("node:fs");
const path = require("node:path");

function resolveMiaCoreVersion(projectRoot, env = process.env) {
  const override = String(env.MIA_CORE_VERSION || "").trim();
  if (override) return override;

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    const pinned = String(pkg.miaCoreVersion || "").trim();
    if (pinned) return pinned;
  } catch {
    // Fall through to the same non-reproducible escape hatch AION keeps.
  }

  return "latest";
}

module.exports = { resolveMiaCoreVersion };
