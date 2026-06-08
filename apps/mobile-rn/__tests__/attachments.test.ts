import {
  dataUrlForPickedAsset,
  isImageAttachment,
  normalizeAttachment,
  normalizeAttachments,
  pickedAssetAttachment,
  resolveAttachmentUrl,
} from "../src/logic/attachments";

test("normalizes Cloud file attachment shape", () => {
  expect(normalizeAttachment({
    id: "file_1",
    type: "image",
    name: "shot.png",
    mimeType: "image/png",
    url: "/api/files/file_1",
    size: 123,
  })).toEqual({
    id: "file_1",
    type: "image",
    name: "shot.png",
    mimeType: "image/png",
    url: "/api/files/file_1",
    size: 123,
  });
});

test("normalizes legacy mime and drops unusable entries", () => {
  expect(normalizeAttachment({ name: "report.pdf", mime: "application/pdf", url: "https://cdn.test/r.pdf" })).toMatchObject({
    type: "file",
    name: "report.pdf",
    mimeType: "application/pdf",
    url: "https://cdn.test/r.pdf",
  });
  expect(normalizeAttachment({ name: "" })).toBeNull();
  expect(normalizeAttachments([{ name: "x.txt", url: "/api/files/a" }, null])).toHaveLength(1);
});

test("detects images by type, mime, or filename", () => {
  expect(isImageAttachment({ type: "image", name: "a.bin" })).toBe(true);
  expect(isImageAttachment({ mimeType: "image/jpeg", name: "a.bin" })).toBe(true);
  expect(isImageAttachment({ name: "photo.webp" })).toBe(true);
  expect(isImageAttachment({ name: "notes.txt" })).toBe(false);
});

test("resolves relative Cloud URLs against apiBase", () => {
  expect(resolveAttachmentUrl("/api/files/file_1", "https://aiweb.buytb01.com")).toBe("https://aiweb.buytb01.com/api/files/file_1");
  expect(resolveAttachmentUrl("https://cdn.test/a.png", "https://aiweb.buytb01.com")).toBe("https://cdn.test/a.png");
  expect(resolveAttachmentUrl("", "https://aiweb.buytb01.com")).toBe("");
});

test("normalizes local data-url attachments for optimistic display and upload", () => {
  const dataUrl = dataUrlForPickedAsset({ mimeType: "image/png" }, "BASE64");
  const attachment = normalizeAttachment({ name: "shot.png", mimeType: "image/png", dataUrl });
  expect(attachment).toMatchObject({ type: "image", name: "shot.png", url: dataUrl, dataUrl });
  expect(resolveAttachmentUrl(dataUrl, "https://aiweb.buytb01.com")).toBe(dataUrl);
});

test("pickedAssetAttachment builds a server-compatible attachment", () => {
  const attachment = pickedAssetAttachment({ name: "report.pdf", mimeType: "application/pdf", size: 12 }, "BASE64");
  expect(attachment).toMatchObject({
    type: "file",
    name: "report.pdf",
    mimeType: "application/pdf",
    dataUrl: "data:application/pdf;base64,BASE64",
    size: 12,
  });
});
