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
    assert.match(await index.text(), /landing\.css/);

    const app = await fetch(`${baseUrl}/app/`);
    assert.equal(app.status, 200);
    assert.match(await app.text(), /\.\.\/shared\/engine-contracts\.js/);

    const engine = await fetch(`${baseUrl}/shared/engine-contracts.js`);
    assert.equal(engine.status, 200);
    assert.match(engine.headers.get("content-type") || "", /javascript/);
    assert.match(await engine.text(), /miaEngineContracts/);

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
