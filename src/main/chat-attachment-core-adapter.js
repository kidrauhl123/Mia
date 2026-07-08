"use strict";

function isCloudFilePath(value = "") {
  return /^\/api\/files\/[a-zA-Z0-9_-]+$/.test(String(value || "").trim());
}

function attachmentError(error, input = {}) {
  return {
    error: true,
    message: String(error?.message || error),
    path: String(input.path || input.filePath || input.url || "")
  };
}

function createChatAttachmentCoreAdapter({
  coreRequest,
  cloudAttachments = {}
} = {}) {
  if (typeof coreRequest !== "function") {
    throw new Error("coreRequest dependency is required.");
  }

  async function saveAttachment(input = {}) {
    const saved = await coreRequest({
      method: "POST",
      route: "/api/attachments/save",
      body: input || {}
    });
    if (typeof cloudAttachments.rememberCloudDownload === "function") {
      cloudAttachments.rememberCloudDownload(input || {}, saved || {});
    }
    return saved;
  }

  async function fetchFileAttachment(input = {}) {
    try {
      const cloudPath = String(input.url || input.path || "").trim();
      if (isCloudFilePath(cloudPath)) {
        if (typeof cloudAttachments.fetchCloudFileAttachment !== "function") {
          throw new Error("Cloud attachment fetch is unavailable.");
        }
        return await cloudAttachments.fetchCloudFileAttachment(input);
      }
      return await coreRequest({
        method: "POST",
        route: "/api/attachments/file",
        body: input || {}
      });
    } catch (error) {
      return attachmentError(error, input);
    }
  }

  return {
    saveAttachment,
    fetchFileAttachment
  };
}

module.exports = {
  createChatAttachmentCoreAdapter,
  isCloudFilePath
};
