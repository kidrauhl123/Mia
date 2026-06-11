import type { MessageAttachment } from "../api/types";

export const MAX_COMPOSER_ATTACHMENTS = 20;

export function normalizeAttachment(input: any): MessageAttachment | null {
  if (!input || typeof input !== "object") return null;
  const dataUrl = String(input.dataUrl || "").trim();
  const url = String(input.url || input.path || dataUrl || "").trim();
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
    ...(dataUrl ? { dataUrl } : {}),
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

export function dataUrlForPickedAsset(asset: { mimeType?: string | null }, base64: string): string {
  const mimeType = String(asset.mimeType || "application/octet-stream").trim() || "application/octet-stream";
  return `data:${mimeType};base64,${base64}`;
}

export function pickedAssetAttachment(
  asset: { name?: string | null; mimeType?: string | null; size?: number | null },
  base64: string
): MessageAttachment {
  const mimeType = String(asset.mimeType || "").trim();
  return {
    id: `local:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    type: mimeType.startsWith("image/") ? "image" : "file",
    name: String(asset.name || "附件"),
    ...(mimeType ? { mimeType } : {}),
    dataUrl: dataUrlForPickedAsset(asset, base64),
    ...(Number.isFinite(Number(asset.size)) ? { size: Number(asset.size) } : {}),
  };
}
