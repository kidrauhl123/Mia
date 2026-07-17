export interface NormalizedCloudMessageFields {
  attachments: unknown[];
  mentions: unknown[];
  skills: unknown[];
  contentBlocks: unknown[];
  trace: Record<string, unknown> | null;
}

export function parseJson(value: unknown, fallback: unknown): unknown;
export function normalizeCloudMessageFields(row: Record<string, unknown> | null | undefined): NormalizedCloudMessageFields;
