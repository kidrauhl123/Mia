const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDesktopDownloadSyncCommand,
  syncDesktopWebDownloads,
} = require("../scripts/publish-desktop-web-downloads.js");

test("desktop website sync publishes versioned installers and latest aliases atomically", () => {
  const command = buildDesktopDownloadSyncCommand({
    remoteDir: "/var/www/mia-updates/",
    webDownloadsDir: "/var/www/mia-web/downloads/",
    temporarySuffix: "test",
    artifacts: [{
      fileName: "Mia-0.1.52-Setup.exe",
      aliases: ["mia-windows-latest.exe", "mia-windows-x64-latest.exe"],
    }],
  });

  assert.match(command, /mkdir -p '\/var\/www\/mia-web\/downloads'/);
  assert.match(command, /'\/var\/www\/mia-updates\/Mia-0\.1\.52-Setup\.exe'/);
  assert.match(command, /'\/var\/www\/mia-web\/downloads\/Mia-0\.1\.52-Setup\.exe\.test-0'/);
  assert.match(command, /'\/var\/www\/mia-web\/downloads\/mia-windows-latest\.exe\.test-1'/);
  assert.match(command, /mv -f/);
});

test("desktop website sync rejects paths masquerading as artifact names", () => {
  assert.throws(
    () => buildDesktopDownloadSyncCommand({
      remoteDir: "/var/www/mia-updates",
      artifacts: [{ fileName: "../Mia.exe", aliases: [] }],
    }),
    /plain file name/
  );
});

test("desktop website sync invokes SSH with the generated remote command", () => {
  const calls = [];
  syncDesktopWebDownloads({
    remote: "mia-jms-deploy",
    remoteDir: "/updates",
    webDownloadsDir: "/downloads",
    artifacts: [{ fileName: "Mia.exe", aliases: ["mia-windows-latest.exe"] }],
    cwd: "/tmp/mia",
    execFile(command, args, options) {
      calls.push({ command, args, options });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.equal(calls[0].args[0], "mia-jms-deploy");
  assert.match(calls[0].args[1], /'\/updates\/Mia\.exe'/);
  assert.equal(calls[0].options.cwd, "/tmp/mia");
});
