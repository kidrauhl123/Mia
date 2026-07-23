"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const DEFAULT_WEB_DOWNLOADS_DIR = "/var/www/mia-web/downloads";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function safeFileName(value, label) {
  const name = String(value || "").trim();
  if (!name || name !== path.posix.basename(name) || name.includes("\\")) {
    throw new Error(`${label} must be a plain file name.`);
  }
  return name;
}

function normalizeRemoteDirectory(value, fallback) {
  const directory = String(value || fallback || "").trim().replace(/\/+$/, "");
  if (!directory) throw new Error("A remote directory is required.");
  return directory;
}

function remotePath(directory, fileName) {
  return `${directory}/${fileName}`;
}

function buildDesktopDownloadSyncCommand({
  remoteDir,
  webDownloadsDir = DEFAULT_WEB_DOWNLOADS_DIR,
  artifacts,
  temporarySuffix = `mia-publish-${process.pid}`,
} = {}) {
  const sourceDir = normalizeRemoteDirectory(remoteDir);
  const destinationDir = normalizeRemoteDirectory(webDownloadsDir, DEFAULT_WEB_DOWNLOADS_DIR);
  if (!Array.isArray(artifacts) || !artifacts.length) {
    throw new Error("At least one desktop download artifact is required.");
  }

  const commands = ["set -eu", `mkdir -p ${shellQuote(destinationDir)}`];
  let copyIndex = 0;
  for (const artifact of artifacts) {
    const fileName = safeFileName(artifact?.fileName, "Artifact fileName");
    const aliases = [...new Set((artifact?.aliases || []).map((alias) => safeFileName(alias, "Artifact alias")))];
    const source = remotePath(sourceDir, fileName);
    for (const targetName of [fileName, ...aliases]) {
      const destination = remotePath(destinationDir, targetName);
      if (source === destination) continue;
      const temporary = `${destination}.${temporarySuffix}-${copyIndex++}`;
      commands.push(`cp -f ${shellQuote(source)} ${shellQuote(temporary)}`);
      commands.push(`mv -f ${shellQuote(temporary)} ${shellQuote(destination)}`);
    }
  }
  return commands.join("\n");
}

function syncDesktopWebDownloads({
  remote,
  remoteDir,
  webDownloadsDir = process.env.MIA_WEB_DOWNLOAD_REMOTE_DIR || DEFAULT_WEB_DOWNLOADS_DIR,
  artifacts,
  cwd,
  execFile = execFileSync,
} = {}) {
  const target = String(remote || "").trim();
  if (!target) throw new Error("Set MIA_UPDATE_REMOTE or MIA_DEPLOY_REMOTE before syncing website downloads.");
  const command = buildDesktopDownloadSyncCommand({ remoteDir, webDownloadsDir, artifacts });
  execFile("ssh", [target, command], { cwd, stdio: "inherit" });
}

module.exports = {
  DEFAULT_WEB_DOWNLOADS_DIR,
  buildDesktopDownloadSyncCommand,
  syncDesktopWebDownloads,
};
