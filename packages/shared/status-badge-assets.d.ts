export interface StatusBadgeAsset {
  id: string;
  kind: "emoji" | "lottie" | "gift";
  emoji?: string;
  assetId?: string;
  label?: string;
  format?: string;
  relativePath?: string;
  loop?: string;
  bundled?: boolean;
  collectibleId?: string;
}

export interface StatusBadge {
  kind: "emoji" | "lottie" | "gift";
  emoji?: string;
  assetId?: string;
  asset_id?: string;
  label?: string;
  loop?: string;
  collectibleId?: string;
  collectible_id?: string;
}

export interface StatusBadgeChoice {
  id: string;
  value: string;
  label: string;
  kind: string;
  emoji: string;
  assetId: string;
  badge: StatusBadge | null;
}

export interface StatusBadgeAssetDefinition {
  id: string;
  assetId: string;
  label: string;
  kind: "lottie";
  format: string;
  relativePath: string;
}

export function safeStatusBadgeAssetId(value: unknown): string;
export function normalizeStatusBadge(input: unknown): StatusBadge | null;
export function statusBadgeCatalog(): StatusBadgeAsset[];
export function statusBadgeChoices(options?: { includeEmpty?: boolean }): StatusBadgeChoice[];
export function statusBadgeForValue(value: unknown): StatusBadge | null;
export function statusBadgeValue(badge: unknown): string;
export function findStatusBadgeAsset(value: unknown): StatusBadgeAsset | null;
export function statusBadgeAssetDefinitions(): StatusBadgeAssetDefinition[];
export function statusBadgeAssetUrl(assetId: unknown, options?: { baseUrl?: string; preferLocal?: boolean; localPrefix?: string; apiPath?: string }): string;
export function statusBadgeAssetFormat(assetId: unknown, options?: { preferLocal?: boolean }): string;
