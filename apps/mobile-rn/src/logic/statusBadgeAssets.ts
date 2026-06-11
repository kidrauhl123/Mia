export interface StatusBadgeAssetManifestEntry {
  id?: string;
  assetId?: string;
  kind?: string;
  url?: string;
  sha256?: string;
  bytes?: number;
}

export function safeStatusBadgeAssetId(value: string | null | undefined): string {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
}

export function statusBadgeAssetsPath(): string {
  return "/api/status-badge-assets";
}

export function statusBadgeAssetPath(assetId: string | null | undefined): string {
  const id = safeStatusBadgeAssetId(assetId);
  return id ? `/api/status-badge-assets/${encodeURIComponent(id)}.json` : "";
}

export function resolveStatusBadgeAssetUrl(assetId: string | null | undefined, apiBase: string): string {
  const path = statusBadgeAssetPath(assetId);
  if (!path) return "";
  return `${String(apiBase || "").replace(/\/+$/, "")}${path}`;
}

export function normalizedStatusBadgeAssetId(entry: StatusBadgeAssetManifestEntry): string {
  return safeStatusBadgeAssetId(entry.assetId || entry.id || "");
}

export function statusBadgeCacheFileName(entry: StatusBadgeAssetManifestEntry): string {
  const id = normalizedStatusBadgeAssetId(entry);
  if (!id) return "";
  const hash = String(entry.sha256 || "").trim();
  return hash ? `${id}-${hash.slice(0, 16)}.json` : `${id}.json`;
}
