const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  cloudConversationFromDesktopSession,
  cloudConversationIdForSession,
  cloudMessageFromDesktopMessage,
  desktopSessionFromCloudConversation
} = require("../src/cloud/desktop-sync.js");

test("desktop sync maps local sessions to stable cloud conversations", () => {
  const session = {
    id: "local-session-1",
    title: "本地会话",
    updatedAt: "2026-05-20T00:00:00.000Z"
  };
  assert.equal(cloudConversationIdForSession(session), "desktop:local-session-1");
  assert.deepEqual(cloudConversationFromDesktopSession(session, { avatarImage: "avatar.png", key: "aimashi" }), {
    id: "desktop:local-session-1",
    title: "本地会话",
    meta: "Aimashi Desktop · 已同步",
    avatar: "avatar.png",
    updatedAt: "2026-05-20T00:00:00.000Z",
    unread: 0,
    messages: [],
    personaKey: "aimashi"
  });
});

test("desktop sync forwards createdAt to cloud so dedup matches", () => {
  const message = cloudMessageFromDesktopMessage({
    role: "user",
    content: "hi",
    createdAt: "2026-05-20T10:00:00.000Z"
  });
  assert.equal(message.createdAt, "2026-05-20T10:00:00.000Z");
});

test("desktop sync preserves command results through cloud messages", () => {
  const commandResult = {
    type: "session-list",
    command: "/resume",
    engine: "claude-code",
    sourceDeviceId: "aimashi-device-a",
    rows: [{
      id: "11111111-2222-4333-8444-555555555555",
      title: "History title",
      preview: "first prompt",
      project: "/repo",
      updatedAt: 2000
    }]
  };
  const cloudMessage = cloudMessageFromDesktopMessage({
    role: "assistant",
    content: "choose",
    createdAt: "2026-05-20T10:00:00.000Z",
    commandResult
  });
  assert.deepEqual(cloudMessage.commandResult, commandResult);

  const session = desktopSessionFromCloudConversation({
    id: "desktop:local-session-1",
    messages: [cloudMessage]
  }, "aimashi");
  assert.deepEqual(session.messages[0].commandResult, commandResult);
});

test("desktop sync routes cloud conversations back to their source persona", () => {
  // Conversation carries an explicit personaKey from the upload encoder.
  const session = desktopSessionFromCloudConversation({
    id: "desktop:black-cat-session",
    title: "Black Cat",
    personaKey: "black-cat",
    updatedAt: "2026-05-20T00:00:00.000Z"
  }, "aimashi");
  assert.equal(session.personaKey, "black-cat");
});

test("desktop sync preserves image data urls for cloud upload", () => {
  const message = cloudMessageFromDesktopMessage({
    role: "assistant",
    content: "图片已生成",
    attachments: [{
      id: "a1",
      name: "dog.png",
      mime: "image/png",
      kind: "image",
      dataUrl: "data:image/png;base64,cG5n"
    }]
  });
  assert.equal(message.role, "assistant");
  assert.equal(message.text, "图片已生成");
  assert.equal(message.attachments[0].type, "image");
  assert.equal(message.attachments[0].dataUrl, "data:image/png;base64,cG5n");
});

test("desktop sync uploads full local image files instead of thumbnails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-desktop-sync-"));
  try {
    const imagePath = path.join(dir, "dog.png");
    fs.writeFileSync(imagePath, Buffer.from("full-image"));
    const message = cloudMessageFromDesktopMessage({
      role: "user",
      content: "看图",
      attachments: [{
        id: "a2",
        name: "dog.png",
        mime: "image/png",
        kind: "image",
        path: imagePath,
        thumbnailDataUrl: "data:image/png;base64,dGh1bWI="
      }]
    });
    assert.equal(message.attachments[0].dataUrl, `data:image/png;base64,${Buffer.from("full-image").toString("base64")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop sync does not upload thumbnails as full cloud files", () => {
  const message = cloudMessageFromDesktopMessage({
    role: "user",
    content: "只有缩略图",
    attachments: [{
      id: "a3",
      name: "thumb-only.png",
      mime: "image/png",
      kind: "image",
      thumbnailDataUrl: "data:image/png;base64,dGh1bWI="
    }]
  });
  assert.equal(message.attachments[0].dataUrl, "");
});

test("desktop sync does not upload full data urls over the cloud image limit", () => {
  const tooLarge = Buffer.alloc(18 * 1024 * 1024 + 1, 1);
  const message = cloudMessageFromDesktopMessage({
    role: "user",
    content: "超大图片",
    attachments: [{
      id: "a4",
      name: "large.png",
      mime: "image/png",
      kind: "image",
      dataUrl: `data:image/png;base64,${tooLarge.toString("base64")}`
    }]
  });
  assert.equal(message.attachments[0].dataUrl, "");
});

test("desktop sync does not upload active svg image data urls", () => {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`).toString("base64");
  const message = cloudMessageFromDesktopMessage({
    role: "assistant",
    content: "生成了 svg",
    attachments: [{
      id: "a5",
      name: "unsafe.svg",
      mime: "image/svg+xml",
      kind: "image",
      dataUrl: `data:image/svg+xml;base64,${svg}`
    }]
  });
  assert.equal(message.attachments[0].dataUrl, "");
});

test("desktop sync maps cloud conversations into local sessions", () => {
  const session = desktopSessionFromCloudConversation({
    id: "conv_aimashi",
    title: "Web 会话",
    updatedAt: "2026-05-20T00:00:00.000Z",
    messages: [{
      role: "assistant",
      text: "云端回复",
      createdAt: "2026-05-20T00:00:00.000Z",
      attachments: [{ id: "file_1", type: "image", name: "dog.png", mimeType: "image/png", url: "/api/files/file_1" }]
    }]
  }, "aimashi");

  assert.equal(session.id, "cloud:conv_aimashi");
  assert.equal(session.personaKey, "aimashi");
  assert.equal(session.messages[0].content, "云端回复");
  assert.equal(session.messages[0].attachments[0].url, "/api/files/file_1");
});

test("desktop sync maps desktop-prefixed cloud conversations back to the local session id", () => {
  const session = desktopSessionFromCloudConversation({ id: "desktop:local-1", title: "Local" }, "aimashi");
  assert.equal(session.id, "local-1");
});
