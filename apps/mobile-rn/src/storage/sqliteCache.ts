import type { SQLiteDatabase } from "expo-sqlite";
import type { Bot, ChatMessage, Conversation, Friend, UserSettings } from "../api/types";

type SQLiteModule = typeof import("expo-sqlite");

type JsonRow = {
  json: string;
};

const DATABASE_NAME = "mia-mobile-cache.db";
const MAX_CACHED_CONVERSATIONS = 500;
const MAX_CACHED_MESSAGES = 240;

let sqliteModulePromise: Promise<SQLiteModule | null> | null = null;
let databasePromise: Promise<SQLiteDatabase | null> | null = null;
let warned = false;

function warnOnce(err: unknown) {
  if (warned) return;
  warned = true;
  console.warn("[mia] SQLite cache disabled", err instanceof Error ? err.message : String(err));
}

async function sqliteModule(): Promise<SQLiteModule | null> {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import("expo-sqlite").catch((err) => {
      warnOnce(err);
      return null;
    });
  }
  return sqliteModulePromise;
}

async function cacheDb(): Promise<SQLiteDatabase | null> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const SQLite = await sqliteModule();
      if (!SQLite) return null;
      const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA temp_store = MEMORY;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS conversations (
          scope TEXT NOT NULL,
          id TEXT NOT NULL,
          sort_time INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT '',
          json TEXT NOT NULL,
          PRIMARY KEY(scope, id)
        );
        CREATE INDEX IF NOT EXISTS conversations_scope_sort_idx
          ON conversations(scope, sort_time DESC);

        CREATE TABLE IF NOT EXISTS messages (
          scope TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0,
          sort_time INTEGER NOT NULL DEFAULT 0,
          json TEXT NOT NULL,
          PRIMARY KEY(scope, conversation_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS messages_scope_conv_sort_idx
          ON messages(scope, conversation_id, sort_time DESC, seq DESC);

        CREATE TABLE IF NOT EXISTS kv_cache (
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT 0,
          json TEXT NOT NULL,
          PRIMARY KEY(scope, key)
        );
      `);
      return db;
    })().catch((err) => {
      databasePromise = null;
      warnOnce(err);
      return null;
    });
  }
  return databasePromise;
}

function cacheScope(scope: string | undefined): string {
  return String(scope || "").trim();
}

function jsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function timeMs(value: unknown): number {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function conversationSortTime(conversation: Conversation): number {
  return timeMs(
    conversation.lastActivityAt ||
      conversation.last_activity_at ||
      conversation.lastMessageCreatedAt ||
      conversation.last_message_created_at ||
      conversation.updatedAt ||
      conversation.updated_at ||
      conversation.createdAt ||
      conversation.created_at
  );
}

function conversationUpdatedAt(conversation: Conversation): string {
  return String(
    conversation.updatedAt ||
      conversation.updated_at ||
      conversation.lastActivityAt ||
      conversation.last_activity_at ||
      conversation.lastMessageCreatedAt ||
      conversation.last_message_created_at ||
      ""
  );
}

function messageSortTime(message: ChatMessage): number {
  return timeMs(message.createdAt);
}

function messageSeq(message: ChatMessage): number {
  const seq = Number(message.seq) || 0;
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

function isCacheableMessage(message: ChatMessage): boolean {
  return Boolean(
    message?.messageId &&
      !message.isPending &&
      !message.failed &&
      !String(message.messageId).startsWith("pending:")
  );
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice().sort((a, b) => {
    const seqDelta = messageSeq(a) - messageSeq(b);
    if (seqDelta) return seqDelta;
    const timeDelta = messageSortTime(a) - messageSortTime(b);
    if (timeDelta) return timeDelta;
    return String(a.messageId).localeCompare(String(b.messageId));
  });
}

async function cacheRead<T>(fallback: T, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (err) {
    warnOnce(err);
    return fallback;
  }
}

async function cacheWrite(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (err) {
    warnOnce(err);
  }
}

export async function loadCachedConversations(scope: string | undefined): Promise<Conversation[]> {
  return cacheRead([], async () => {
    const owner = cacheScope(scope);
    if (!owner) return [];
    const db = await cacheDb();
    if (!db) return [];
    const rows = await db.getAllAsync<JsonRow>(
      "SELECT json FROM conversations WHERE scope = ? ORDER BY sort_time DESC LIMIT ?",
      [owner, MAX_CACHED_CONVERSATIONS]
    );
    return rows.map((row) => jsonParse<Conversation>(row.json)).filter(Boolean) as Conversation[];
  });
}

export async function replaceCachedConversations(scope: string | undefined, conversations: Conversation[]): Promise<void> {
  return cacheWrite(async () => {
    const owner = cacheScope(scope);
    if (!owner) return;
    const db = await cacheDb();
    if (!db) return;
    const next = (Array.isArray(conversations) ? conversations : []).slice(0, MAX_CACHED_CONVERSATIONS);
    await db.withTransactionAsync(async () => {
      await db.runAsync("DELETE FROM conversations WHERE scope = ?", [owner]);
      for (const conversation of next) {
        if (!conversation?.id) continue;
        await db.runAsync(
          "REPLACE INTO conversations(scope, id, sort_time, updated_at, json) VALUES(?, ?, ?, ?, ?)",
          [owner, conversation.id, conversationSortTime(conversation), conversationUpdatedAt(conversation), JSON.stringify(conversation)]
        );
      }
    });
  });
}

export async function upsertCachedConversation(scope: string | undefined, conversation: Conversation | undefined): Promise<void> {
  return cacheWrite(async () => {
    const owner = cacheScope(scope);
    if (!owner || !conversation?.id) return;
    const db = await cacheDb();
    if (!db) return;
    await db.runAsync(
      "REPLACE INTO conversations(scope, id, sort_time, updated_at, json) VALUES(?, ?, ?, ?, ?)",
      [owner, conversation.id, conversationSortTime(conversation), conversationUpdatedAt(conversation), JSON.stringify(conversation)]
    );
  });
}

export async function deleteCachedConversation(scope: string | undefined, conversationId: string | undefined): Promise<void> {
  return cacheWrite(async () => {
    const owner = cacheScope(scope);
    if (!owner || !conversationId) return;
    const db = await cacheDb();
    if (!db) return;
    await db.withTransactionAsync(async () => {
      await db.runAsync("DELETE FROM conversations WHERE scope = ? AND id = ?", [owner, conversationId]);
      await db.runAsync("DELETE FROM messages WHERE scope = ? AND conversation_id = ?", [owner, conversationId]);
    });
  });
}

export async function loadCachedMessages(scope: string | undefined, conversationId: string | undefined): Promise<ChatMessage[]> {
  return cacheRead([], async () => {
    const owner = cacheScope(scope);
    if (!owner || !conversationId) return [];
    const db = await cacheDb();
    if (!db) return [];
    const rows = await db.getAllAsync<JsonRow>(
      "SELECT json FROM messages WHERE scope = ? AND conversation_id = ? ORDER BY sort_time DESC, seq DESC LIMIT ?",
      [owner, conversationId, MAX_CACHED_MESSAGES]
    );
    const messages = rows.map((row) => jsonParse<ChatMessage>(row.json)).filter(Boolean) as ChatMessage[];
    return sortMessages(messages);
  });
}

export async function replaceCachedMessages(scope: string | undefined, conversationId: string | undefined, messages: ChatMessage[]): Promise<void> {
  return cacheWrite(async () => {
    const owner = cacheScope(scope);
    if (!owner || !conversationId) return;
    const db = await cacheDb();
    if (!db) return;
    const cacheable = sortMessages((Array.isArray(messages) ? messages : []).filter(isCacheableMessage)).slice(-MAX_CACHED_MESSAGES);
    await db.withTransactionAsync(async () => {
      await db.runAsync("DELETE FROM messages WHERE scope = ? AND conversation_id = ?", [owner, conversationId]);
      for (const message of cacheable) {
        await db.runAsync(
          "REPLACE INTO messages(scope, conversation_id, message_id, seq, sort_time, json) VALUES(?, ?, ?, ?, ?, ?)",
          [owner, conversationId, message.messageId, messageSeq(message), messageSortTime(message), JSON.stringify(message)]
        );
      }
    });
  });
}

export async function upsertCachedMessage(scope: string | undefined, conversationId: string | undefined, message: ChatMessage): Promise<void> {
  return cacheWrite(async () => {
    const owner = cacheScope(scope);
    if (!owner || !conversationId || !isCacheableMessage(message)) return;
    const db = await cacheDb();
    if (!db) return;
    await db.runAsync(
      "REPLACE INTO messages(scope, conversation_id, message_id, seq, sort_time, json) VALUES(?, ?, ?, ?, ?, ?)",
      [owner, conversationId, message.messageId, messageSeq(message), messageSortTime(message), JSON.stringify(message)]
    );
  });
}

export async function deleteCachedMessage(scope: string | undefined, conversationId: string | undefined, messageId: string | undefined): Promise<void> {
  return cacheWrite(async () => {
    const owner = cacheScope(scope);
    if (!owner || !conversationId || !messageId) return;
    const db = await cacheDb();
    if (!db) return;
    await db.runAsync("DELETE FROM messages WHERE scope = ? AND conversation_id = ? AND message_id = ?", [owner, conversationId, messageId]);
  });
}

export async function loadCachedValue<T>(scope: string | undefined, key: string): Promise<T | undefined> {
  return cacheRead<T | undefined>(undefined, async () => {
    const owner = cacheScope(scope);
    if (!owner || !key) return undefined;
    const db = await cacheDb();
    if (!db) return undefined;
    const rows = await db.getAllAsync<JsonRow>("SELECT json FROM kv_cache WHERE scope = ? AND key = ? LIMIT 1", [owner, key]);
    if (!rows[0]) return undefined;
    return jsonParse<T>(rows[0].json) ?? undefined;
  });
}

export async function saveCachedValue<T>(scope: string | undefined, key: string, value: T): Promise<void> {
  return cacheWrite(async () => {
    const owner = cacheScope(scope);
    if (!owner || !key) return;
    const db = await cacheDb();
    if (!db) return;
    await db.runAsync(
      "REPLACE INTO kv_cache(scope, key, updated_at, json) VALUES(?, ?, ?, ?)",
      [owner, key, Date.now(), JSON.stringify(value)]
    );
  });
}

export const sqliteCacheKeys = {
  bots: "bots",
  friends: "friends",
  lastEventSeq: "last-event-seq",
  me: "me-full",
  settings: "settings",
} as const;

export type CachedBotList = Bot[];
export type CachedFriendList = Friend[];
export type CachedUserSettings = UserSettings;
