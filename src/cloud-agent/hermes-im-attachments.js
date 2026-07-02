"use strict";

function attachmentKind(attachment = {}) {
  const explicitKind = String(attachment.kind || "").trim().toLowerCase();
  if (explicitKind === "image" || explicitKind === "pdf") return explicitKind;

  const mimeType = String(attachment.mimeType || attachment.mime || "").trim().toLowerCase();
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  return "file";
}

async function syncHermesImAttachments({ gateway, sessionId, attachments }) {
  const session_id = String(sessionId || "").trim();
  const input = Array.isArray(attachments) ? attachments : [];
  const attached = [];
  const promptLines = [];

  for (const attachment of input) {
    const path = String(attachment?.path || "").trim();
    if (!path) continue;

    const kind = attachmentKind(attachment);
    if (kind === "image") {
      attached.push(await gateway.request("image.attach", { session_id, path }));
      continue;
    }
    if (kind === "pdf") {
      attached.push(await gateway.request("pdf.attach", { session_id, path }));
      continue;
    }

    const name = String(attachment?.name || "").trim() || path.split("/").pop() || "attachment";
    const result = await gateway.request("file.attach", { session_id, path, name });
    attached.push(result);
    const refText = String(result?.ref_text || "").trim();
    if (refText) promptLines.push(refText);
  }

  return {
    attached,
    promptPrefix: promptLines.join("\n\n")
  };
}

module.exports = {
  syncHermesImAttachments
};
