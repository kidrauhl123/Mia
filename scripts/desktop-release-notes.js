const fs = require("node:fs");
const path = require("node:path");

function desktopReleaseNotesPath(root, version) {
  return path.join(root, "docs", "releases", `${version}.md`);
}

function readDesktopReleaseNotes(root, version) {
  const file = desktopReleaseNotesPath(root, version);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing docs/releases/${version}.md. Write release notes before publishing a desktop update.`);
  }
  const notes = fs.readFileSync(file, "utf8").trim();
  if (!notes) {
    throw new Error(`docs/releases/${version}.md is empty. Write release notes before publishing a desktop update.`);
  }
  return { file, notes };
}

function attachDesktopReleaseNotes(feed, root, version) {
  const { file, notes } = readDesktopReleaseNotes(root, version);
  return {
    feed: {
      ...feed,
      releaseNotes: notes,
    },
    file,
  };
}

module.exports = {
  attachDesktopReleaseNotes,
  desktopReleaseNotesPath,
  readDesktopReleaseNotes,
};
