const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("renderer transport receives cloud agent run events without Main IPC forwarding", () => {
  const eventClient = read("src/shared/mia-core-event-client.js");
  const directTransport = read("src/preload/mia-core-direct-transport.js");
  const main = read("src/main.js");
  assert.match(eventClient, /const type = String\(envelope\?\.name \|\| envelope\?\.type \|\| ""\)\.trim\(\)/);
  assert.match(eventClient, /payload,\s*coreEnvelope/s);
  assert.match(directTransport, /cloudEvents\.emit\(envelope\)/);
  assert.doesNotMatch(main, /cacheLiveConversationMessageEvent/);
  assert.doesNotMatch(main, /broadcastRendererEvent\(IpcChannel\.CloudEvent,\s*envelope\)/);
});

test("renderer transport emits local-events connection state so UI can clear stale typing", () => {
  const source = read("src/preload/mia-core-direct-transport.js");
  assert.match(source, /type:\s*"daemon\.local_events_status"/);
  assert.match(source, /eventConnected = Boolean\(connected\)/);
  assert.match(source, /connected:\s*eventConnected/);
  assert.match(source, /cloudEvents\.emit/);
});

test("Core cloud status events synchronize state without recursively restarting lifecycle", () => {
  const source = read("src/main.js");
  const eventsStart = source.indexOf('if (envelope?.type === "daemon.cloud_events_status")');
  const runtimeStart = source.indexOf('if (envelope?.type === "daemon.cloud_runtime_status")', eventsStart);
  const statusEnd = source.indexOf("    },\n    onStateChange:", runtimeStart);
  assert.ok(eventsStart >= 0 && runtimeStart > eventsStart && statusEnd > runtimeStart);

  const eventsBlock = source.slice(eventsStart, runtimeStart);
  const runtimeBlock = source.slice(runtimeStart, statusEnd);
  for (const block of [eventsBlock, runtimeBlock]) {
    assert.match(block, /cloudEventSocketRuntime\?\.syncStatus\?\.\(daemonCloudEventsStatus\)/);
    assert.doesNotMatch(block, /startCloudRuntimeSockets\(\)/);
  }
});

test("web cloud conversation rendering surfaces cloud agent streams and attachments", () => {
  const source = read("src/web/app.js");
  const html = read("src/web/app/index.html");
  const release = read("scripts/build-cloud-release.js");
  assert.match(source, /cloud_agent_run_started/);
  assert.match(source, /cloud_agent_run_event/);
  assert.match(source, /buildCloudAgentStreamingArticle/);
  assert.match(source, /renderAttachmentChips\(spec\.attachments \|\| msg\.attachments \|\| \[\]\)/);
  assert.match(html, /shared\/conversation-kinds\.js/);
  assert.match(release, /src\/shared\/conversation-kinds\.js/);
});

test("web cloud attachment chips use specific document glyph labels", () => {
  const source = read("src/web/app.js");
  assert.match(source, /return "XLS"/);
  assert.match(source, /return "DOC"/);
  assert.match(source, /return "PPT"/);
  assert.match(source, /return "ZIP"/);
});

test("web cloud attachment chips render non-image files as typed attachment cards", () => {
  const source = read("src/web/app.js");
  const css = read("src/web/styles.css");
  assert.match(source, /function attachmentVisualType\(attachment = \{\}\)/);
  assert.match(source, /class="message-attachment file-card type-\$\{escapeHtml\(attachmentVisualType\(attachment\)\)\}"/);
  assert.match(source, /function renderAttachmentFileIcon\(attachment = \{\}, assetRoot = "assets\/file-type-icons"\)/);
  assert.match(source, /class="message-attachment-icon-image"/);
  assert.match(source, /src="\$\{escapeHtml\(assetRoot\)\}\/\$\{escapeHtml\(attachmentIconName\(attachment\)\)\}\.png"/);
  assert.match(source, /message-attachment-meta/);
  assert.match(css, /\.message-attachment\.file-card\s*\{[\s\S]*background:\s*rgba\(37,\s*42,\s*51,\s*0\.34\)/);
  assert.match(css, /\.message-attachment\.file-card\s*\{[\s\S]*backdrop-filter:\s*blur\(10px\)\s+saturate\(125%\)/);
  assert.doesNotMatch(css, /--message-attachment-accent:\s*#f06a35/);
});

test("desktop cloud conversation rendering surfaces cloud agent streams and attachments", () => {
  const social = read("src/renderer/social/social.js");
  const groups = read("src/renderer/social/social-groups.js");
  assert.match(social, /cloud_agent_run_started/);
  assert.match(social, /cloud_agent_run_event/);
  assert.match(social, /_buildCloudAgentStreamingArticle/);
  assert.match(social, /renderAttachmentChips\(spec\?\.attachments \|\| msg\.attachments \|\| \[\]\)/);
  assert.match(groups, /ctx\.renderAttachmentChips/);
});
