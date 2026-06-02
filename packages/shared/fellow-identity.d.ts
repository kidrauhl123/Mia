export interface FellowCapabilities {
  inheritEngineDefaults: boolean;
  enabledPlugins: string[];
  disabledPlugins: string[];
  enabledSkills: string[];
  disabledSkills: string[];
  enabledConnectors: string[];
  legacyCapabilities: string[];
}

export const DEFAULT_FELLOW_ID: string;
export const DEFAULT_FELLOW_CAPABILITIES: FellowCapabilities;

export interface FellowIdentity {
  id: string;
  key: string;
  ownerUserId: string;
  globalId: string;
  name: string;
  displayName: string;
  color: string;
  avatarImage: string;
  avatarCrop: Record<string, unknown> | null;
  bio: string;
  capabilities: FellowCapabilities;
  personaText: string;
  createdAt: string;
  updatedAt: string;
}

export function firstNonEmpty(...values: unknown[]): string;
export function normalizeFellowId(input?: unknown): string;
export function fellowGlobalId(ownerUserId?: unknown, fellowId?: unknown): string;
export function parseFellowGlobalId(input?: unknown): { ownerUserId: string; id: string; globalId: string } | null;
export function normalizeFellowColor(input?: unknown): string;
export function normalizeFellowAvatarCrop(input?: unknown): Record<string, unknown> | null;
export function normalizeCapabilityIds(input?: unknown): string[];
export function normalizeFellowCapabilities(input?: unknown): FellowCapabilities;
export function defaultCloudFellowCapabilities(): FellowCapabilities;
export function normalizeFellowIdentity(input?: unknown, options?: Record<string, unknown>): FellowIdentity | null;
