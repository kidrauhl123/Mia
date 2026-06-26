import type { QueryClient } from "@tanstack/react-query";
import type { Bot, Conversation, Friend, UserSettings } from "../api/types";
import {
  loadCachedConversations,
  loadCachedValue,
  sqliteCacheKeys,
} from "../storage/sqliteCache";

const PERSISTED_CACHE_UPDATED_AT = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function validRecordArray<T>(value: T | undefined): value is T {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

function validConversationArray<T>(value: T | undefined): value is T {
  return Array.isArray(value) && value.every((item) => hasId(item));
}

function seedPersistedQuery<T>(
  qc: QueryClient,
  queryKey: readonly unknown[],
  value: T | undefined,
  accept: (value: T) => boolean = (next) => next !== undefined
) {
  if (value === undefined || !accept(value) || qc.getQueryData(queryKey) !== undefined) return;
  qc.setQueryData(queryKey, value, { updatedAt: PERSISTED_CACHE_UPDATED_AT });
}

export async function hydrateStartupCache(qc: QueryClient, scope: string | undefined): Promise<void> {
  if (!scope) return;
  const [conversations, bots, friends, me, settings] = await Promise.all([
    loadCachedConversations(scope),
    loadCachedValue<Bot[]>(scope, sqliteCacheKeys.bots),
    loadCachedValue<Friend[]>(scope, sqliteCacheKeys.friends),
    loadCachedValue<any>(scope, sqliteCacheKeys.me),
    loadCachedValue<UserSettings>(scope, sqliteCacheKeys.settings),
  ]);
  seedPersistedQuery<Conversation[]>(qc, ["conversations"], conversations, (next) => validConversationArray(next) && next.length > 0);
  seedPersistedQuery(qc, ["bots"], bots, validRecordArray);
  seedPersistedQuery(qc, ["friends"], friends, validRecordArray);
  seedPersistedQuery(qc, ["me-full"], me, isRecord);
  seedPersistedQuery(qc, ["settings"], settings, isRecord);
}
