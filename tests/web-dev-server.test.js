const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { freePort } = require("./helpers/free-port");

async function startWebServer() {
  const port = await freePort();
  const proc = spawn(process.execPath, ["scripts/serve-web.js"], {
    env: {
      ...process.env,
      MIA_WEB_HOST: "127.0.0.1",
      MIA_WEB_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1500);
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.stdout.on("data", (chunk) => {
      if (/listening/i.test(String(chunk))) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on("data", (chunk) => {
      if (/EADDRINUSE|Error/i.test(String(chunk))) {
        clearTimeout(timer);
        reject(new Error(String(chunk)));
      }
    });
  });
  return { proc, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopWebServer(proc) {
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGTERM");
    await new Promise((resolve) => proc.once("exit", resolve));
  }
}

test("web dev server serves shared source modules used by the /app shell", async () => {
  const { proc, baseUrl } = await startWebServer();
  try {
    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /assets\/mia\.css/);

    const app = await fetch(`${baseUrl}/app/`);
    assert.equal(app.status, 200);
    assert.match(await app.text(), /\.\.\/shared\/engine-contracts\.js/);

    const engine = await fetch(`${baseUrl}/shared/engine-contracts.js`);
    assert.equal(engine.status, 200);
    assert.match(engine.headers.get("content-type") || "", /javascript/);
    assert.match(await engine.text(), /miaEngineContracts/);

    for (const fileName of ["avatar-resolve.js", "avatar-media.js", "member-color.js"]) {
      const avatarModule = await fetch(`${baseUrl}/shared/${fileName}`);
      assert.equal(avatarModule.status, 200);
      assert.match(avatarModule.headers.get("content-type") || "", /javascript/);
      const source = await avatarModule.text();
      assert.match(source, /miaAvatarResolve/);
      assert.match(source, /miaAvatarMedia/);
      assert.match(source, /miaMemberColor/);
      assert.doesNotMatch(source, /\.\.\/\.\.\/src\/shared\/(avatar-resolve|avatar-media|member-color)\.js/);
    }

    const sessionHistory = await fetch(`${baseUrl}/shared/session-history.js`);
    assert.equal(sessionHistory.status, 200);
    assert.match(sessionHistory.headers.get("content-type") || "", /javascript/);
    const sessionHistorySource = await sessionHistory.text();
    assert.match(sessionHistorySource, /miaSessionHistory/);
    assert.match(sessionHistorySource, /createBotSessionPayload/);

    const contact = await fetch(`${baseUrl}/shared/contact.js`);
    assert.equal(contact.status, 200);
    assert.match(contact.headers.get("content-type") || "", /javascript/);
    const contactSource = await contact.text();
    assert.match(contactSource, /miaContact/);
    assert.doesNotMatch(contactSource, /\.\.\/\.\.\/src\/shared\/contact\.js/);

    const groupTiles = await fetch(`${baseUrl}/shared/group-tiles.js`);
    assert.equal(groupTiles.status, 200);
    assert.match(groupTiles.headers.get("content-type") || "", /javascript/);
    const groupTilesSource = await groupTiles.text();
    assert.match(groupTilesSource, /miaGroupTiles/);
    assert.doesNotMatch(groupTilesSource, /\.\.\/\.\.\/src\/shared\/group-tiles\.js/);

    for (const [fileName, globalName] of [
      ["send-pipeline.js", "miaSendPipeline"],
      ["cloud-client.js", "miaCloudClient"],
      ["unread.js", "miaUnread"]
    ]) {
      const response = await fetch(`${baseUrl}/shared/${fileName}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") || "", /javascript/);
      const source = await response.text();
      assert.match(source, new RegExp(globalName));
      assert.doesNotMatch(source, new RegExp(`\\.\\.\\/\\.\\.\\/src\\/shared\\/${fileName.replace(".", "\\.")}`));
    }

    const cloudConversationSource = await fetch(`${baseUrl}/message-sources/cloud-conversation-source.js`);
    assert.equal(cloudConversationSource.status, 200);
    assert.match(cloudConversationSource.headers.get("content-type") || "", /javascript/);
    assert.match(await cloudConversationSource.text(), /miaCloudConversationSource/);

    const traversal = await fetch(`${baseUrl}/%2e%2e/package.json`);
    assert.doesNotMatch(await traversal.text(), /"mia"/);
  } finally {
    await stopWebServer(proc);
  }
});
