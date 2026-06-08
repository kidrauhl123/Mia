import type { MessageAttachment } from "../api/types";

export function normalizeAttachment(input: any): MessageAttachment | null {
  if (!input || typeof input !== "object") return null;
  const url = String(input.url || input.path || "").trim();
  const name = String(input.name || input.filename || input.id || "").trim();
  if (!url && !name) return null;
  const mimeType = String(input.mimeType || input.mime || "").trim();
  const type = String(input.type || (mimeType.startsWith("image/") ? "image" : "file") || "file").trim();
  return {
    ...(input.id ? { id: String(input.id) } : {}),
    type,
    name: name || "附件",
    ...(mimeType ? { mimeType } : {}),
    ...(url ? { url } : {}),
    ...(input.path && !url ? { path: String(input.path) } : {}),
    ...(Number.isFinite(Number(input.size)) ? { size: Number(input.size) } : {}),
    ...(input.createdAt ? { createdAt: String(input.createdAt) } : {}),
  };
}

export function normalizeAttachments(input: unknown): MessageAttachment[] {
  if (!Array.isArray(input)) return [];
  return input.map(normalizeAttachment).filter(Boolean) as MessageAttachment[];
}

export function isImageAttachment(att: Pick<MessageAttachment, "type" | "mimeType" | "name">): boolean {
  const type = String(att.type || "").toLowerCase();
  const mime = String(att.mimeType || "").toLowerCase();
  const name = String(att.name || "").toLowerCase();
  return type === "image" || mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif)$/.test(name);
}

export function resolveAttachmentUrl(url: string | undefined, apiBase: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
  if (!raw.startsWith("/")) return raw;
  return `${String(apiBase || "").replace(/\/+$/, "")}${raw}`;
}
