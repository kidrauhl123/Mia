import type { Bot, BotRuntimeConfig } from "../api/types";

export interface BotDraft {
  name: string;
  personaText?: string;
}

export function slugFromBotName(name: string): string {
  return String(name || "bot")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "bot";
}

export function botKey(bot: Bot): string {
  return String(bot.key || bot.id || bot.botId || bot.bot_id || "").trim();
}

export function cloudBotKeyFromName(name: string, existingKeys: string[] = []): string {
  const used = new Set(existingKeys.map((key) => String(key || "").trim()).filter(Boolean));
  const base = slugFromBotName(name);
  let key = base;
  let index = 2;
  while (used.has(key)) {
    key = `${base}_${index}`;
    index += 1;
  }
  return key;
}

export function botIdentityBody(draft: BotDraft) {
  const name = draft.name.trim();
  const personaText = String(draft.personaText || "").trim();
  return {
    name,
    color: "#2563eb",
    avatarImage: "",
    avatarCrop: null,
    bio: personaText,
    personaText,
    capabilities: { legacyCapabilities: ["chat", "files", "terminal", "code"] },
  };
}

export function botRuntimeDefaultConfig(defaultModel = "mia-default"): BotRuntimeConfig {
  return {
    model: defaultModel || "mia-default",
    effortLevel: "medium",
    permissionMode: "ask",
  };
}
