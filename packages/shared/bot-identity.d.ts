import type { StatusBadge } from "./identity";

export interface BotCapabilities {
  inheritEngineDefaults: boolean;
  enabledPlugins: string[];
  disabledPlugins: string[];
  enabledSkills: string[];
  disabledSkills: string[];
  enabledConnectors: string[];
  legacyCapabilities: string[];
}

export const DEFAULT_BOT_ID: string;
export const DEFAULT_BOT_CAPABILITIES: BotCapabilities;

export interface BotIdentity {
  kind: "bot";
  id: string;
  ownerUserId: string;
  name: string;
  displayName: string;
  color: string;
  avatarImage: string;
  avatarCrop: Record<string, unknown> | null;
  statusBadge: StatusBadge | null;
  bio: string;
  capabilities: BotCapabilities;
  personaText: string;
  createdAt: string;
  updatedAt: string;
}

export function firstNonEmpty(...values: unknown[]): string;
export function normalizeBotId(input?: unknown): string;
export function botConversationId(sessionId?: unknown): string;
export function normalizeBotColor(input?: unknown): string;
export function normalizeBotAvatarCrop(input?: unknown): Record<string, unknown> | null;
export function normalizeCapabilityIds(input?: unknown): string[];
export function normalizeBotCapabilities(input?: unknown): BotCapabilities;
export function defaultCloudBotCapabilities(): BotCapabilities;
export function normalizeBotIdentity(input?: unknown, options?: Record<string, unknown>): BotIdentity | null;
