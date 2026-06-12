import {
  statusBadgeChoices as sharedStatusBadgeChoices,
  statusBadgeForValue as sharedStatusBadgeForValue,
  statusBadgeValue as sharedStatusBadgeValue,
} from "@mia/shared/status-badge-assets";
import type { StatusBadge as ApiStatusBadge } from "../api/types";

export interface StatusBadgeAssetManifestEntry {
  id?: string;
  assetId?: string;
  kind?: string;
  label?: string;
  format?: string;
  url?: string;
  sha256?: string;
  bytes?: number;
}

export type StatusBadgeValue = "" | string;

export interface StatusBadgeChoice {
  value: StatusBadgeValue;
  label: string;
  badge: ApiStatusBadge | null;
}

export const STATUS_BADGE_CHOICES: StatusBadgeChoice[] = sharedStatusBadgeChoices({ includeEmpty: true })
  .map((choice) => ({
    value: choice.value,
    label: choice.label,
    badge: choice.badge as ApiStatusBadge | null,
  }));

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

export function statusBadgeForValue(value: string | null | undefined): StatusBadgeChoice["badge"] {
  return sharedStatusBadgeForValue(value) as ApiStatusBadge | null;
}

export function statusBadgeValue(badge?: unknown): string {
  return sharedStatusBadgeValue(badge);
}
