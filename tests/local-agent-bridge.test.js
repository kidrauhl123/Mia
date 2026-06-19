const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  bridgeCapabilities,
  bridgeProtocols,
  bridgeUrl,
  buildCodexPrompt,
  imageAttachment,
  materializeAttachments,
  mapPermissionMode,
  recentGeneratedImagePaths,
  resolveBridgeToken
} = require("../scripts/local-agent-bridge.js");

test("local bridge websocket URL omits auth token and advertises capabilities", () => {
  const url = new URL(bridgeUrl({
    cloudUrl: "https://cloud.example",
    deviceName: "Mac",
    engine: "codex",
    capabilities: { streaming: true, cancellation: true, appVersion: "0.1.0" }
  }));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/api/bridge");
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(url.searchParams.get("deviceName"), "Mac");
  assert.equal(url.searchParams.get("engine"), "codex");
  assert.deepEqual(JSON.parse(url.searchParams.get("capabilities")), {
    streaming: true,
    cancellation: true,
    appVersion: "0.1.0"
  });
});

test("local bridge sends cloud token via websocket subprotocol", () => {
  assert.deepEqual(bridgeProtocols("secret-token"), ["mia-token.secret-token"]);
});

test("local bridge token resolution uses the explicit token", async () => {
  const token = await resolveBridgeToken({
    MIA_CLOUD_TOKEN: "explicit-token"
  });

  assert.equal(token, "explicit-token");
});

test("local bridge reports missing bearer token clearly", async () => {
  await assert.rejects(
    () => resolveBridgeToken({
      MIA_CLOUD_URL: "https://cloud.example"
    }),
    /MIA_CLOUD_TOKEN is required/
  );
});

test("local bridge default capabilities include product metadata", () => {
  const capabilities = bridgeCapabilities();
  assert.equal(capabilities.chat, true);
  assert.equal(capabilities.attachments, true);
  assert.equal(capabilities.generatedImages, true);
  assert.equal(capabilities.cancellation, true);
  assert.equal(capabilities.streaming, true);
  assert.ok(capabilities.appVersion);
  assert.ok(capabilities.hostname);
});

test("local bridge permission mapping never waits for hidden CLI approval UI", () => {
  assert.deepEqual(mapPermissionMode("readOnly"), {
    sandboxMode: "read-only",
    approvalPolicy: "never"
  });
  assert.deepEqual(mapPermissionMode("acceptEdits"), {
    sandboxMode: "workspace-write",
    approvalPolicy: "never"
  });
  assert.deepEqual(mapPermissionMode("bypass"), {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  });
});

test("local bridge Codex permission is local process config, not cloud runtime config", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "local-agent-bridge.js"), "utf8");
  assert.match(source, /mapPermissionMode\(process\.env\.MIA_CODEX_PERMISSION \|\| "default"\)/);
  assert.doesNotMatch(source, /runtimeConfig\.permissionMode \|\| runtimeConfig\.permission_mode/);
});

test("local bridge includes attachment paths and text previews in Codex prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bridge-prompt-"));
  try {
    const filePath = path.join(dir, "note.txt");
    fs.writeFileSync(filePath, "hello attachment", "utf8");
    const prompt = buildCodexPrompt("看附件", [{
      name: "note.txt",
      path: filePath,
      mimeType: "text/plain",
      size: 16,
      kind: "text"
    }]);
    assert.match(prompt, /看附件/);
    assert.match(prompt, /本地路径/);
    assert.match(prompt, /note\.txt/);
    assert.match(prompt, /hello attachment/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local bridge materializes data-url attachments to local files", async () => {
  const materialized = await materializeAttachments([{
    name: "pixel.png",
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`
  }], "run_test_attachment");
  try {
    assert.equal(materialized.attachments.length, 1);
    assert.equal(materialized.attachments[0].name, "pixel.png");
    assert.equal(materialized.attachments[0].kind, "image");
    assert.equal(fs.readFileSync(materialized.attachments[0].path, "utf8"), "png");
  } finally {
    fs.rmSync(materialized.dir, { recursive: true, force: true });
  }
});

test("local bridge surfaces recent Codex generated images as uploadable attachments", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bridge-generated-"));
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = codexHome;
    const imageDir = path.join(codexHome, "generated_images", "thread_generated");
    fs.mkdirSync(imageDir, { recursive: true });
    const before = Date.now();
    const imagePath = path.join(imageDir, "ig_dog.webp");
    const ignoredPath = path.join(imageDir, "active.svg");
    fs.writeFileSync(imagePath, "webp");
    fs.writeFileSync(ignoredPath, "<svg></svg>");

    const paths = recentGeneratedImagePaths("thread_generated", before);
    assert.deepEqual(paths, [imagePath]);

    const attachment = imageAttachment(imagePath);
    assert.equal(attachment.type, "image");
    assert.equal(attachment.name, "ig_dog.webp");
    assert.equal(attachment.mimeType, "image/webp");
    assert.equal(attachment.dataUrl, `data:image/webp;base64,${Buffer.from("webp").toString("base64")}`);
    assert.equal(Object.hasOwn(attachment, "path"), false);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
