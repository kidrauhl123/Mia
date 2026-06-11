import type { UserSettings } from "../api/types";

export interface UserSettingsPatch {
  pins?: string[];
  readMarks?: Record<string, number>;
  appearance?: Record<string, unknown>;
}

export function mergeUserSettings(base: UserSettings | undefined, patch: UserSettingsPatch) {
  const current = base || {};
  return {
    pins: patch.pins !== undefined ? [...new Set(patch.pins)] : current.pins || [],
    readMarks: patch.readMarks !== undefined ? { ...(current.readMarks || {}), ...patch.readMarks } : current.readMarks || {},
    appearance: patch.appearance !== undefined ? { ...(current.appearance || {}), ...patch.appearance } : current.appearance || {},
    expectedVersion: current.version || 0,
  };
}

export function togglePinnedConversation(settings: UserSettings | undefined, conversationId: string): string[] {
  const current = Array.isArray(settings?.pins) ? settings.pins : [];
  if (current.includes(conversationId)) return current.filter((id) => id !== conversationId);
  return [...current, conversationId];
}

export function lastSeenSeq(messages: Array<{ seq?: number }>): number {
  return messages.reduce((max, message) => {
    const seq = Number(message.seq);
    return Number.isFinite(seq) && seq > max ? seq : max;
  }, 0);
}
