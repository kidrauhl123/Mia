const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("desktop forwards cloud agent run events over the existing CloudEvent IPC", () => {
  const source = read("src/main/cloud/cloud-events-client.js");
  assert.match(source, /CloudEvent\.CloudAgentRunStarted/);
  assert.match(source, /CloudEvent\.CloudAgentRunEvent/);
  assert.match(source, /emitToRenderer\(\{\s*type:\s*message\.type,\s*payload:\s*message\s*\}\)/s);
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

test("desktop cloud conversation rendering surfaces cloud agent streams and attachments", () => {
  const social = read("src/renderer/social/social.js");
  const groups = read("src/renderer/social/social-groups.js");
  assert.match(social, /cloud_agent_run_started/);
  assert.match(social, /cloud_agent_run_event/);
  assert.match(social, /_buildCloudAgentStreamingArticle/);
  assert.match(social, /renderAttachmentChips\(spec\?\.attachments \|\| msg\.attachments \|\| \[\]\)/);
  assert.match(groups, /ctx\.renderAttachmentChips/);
});
