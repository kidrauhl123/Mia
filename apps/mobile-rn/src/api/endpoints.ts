export type FriendRequestDirection = "incoming" | "outgoing";

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === "") return;
    q.set(key, String(value));
  });
  const text = q.toString();
  return text ? `${path}?${text}` : path;
}

export function settingsPath(): string {
  return "/api/me/settings";
}

export function profilePath(): string {
  return "/api/me/profile";
}

export function bridgeDevicesPath(): string {
  return "/api/bridge/devices";
}

export function bridgeRunsPath(): string {
  return "/api/bridge/runs";
}

export function friendRequestsPath(direction: FriendRequestDirection): string {
  return withQuery("/api/social/friend-requests", { direction });
}

export function friendRequestCreatePath(): string {
  return "/api/social/friend-requests";
}

export function friendRequestRespondPath(requestId: string): string {
  return `/api/social/friend-requests/${encodeURIComponent(requestId)}/respond`;
}

export function friendRequestCancelPath(requestId: string): string {
  return `/api/social/friend-requests/${encodeURIComponent(requestId)}`;
}

export function friendPath(friendId: string): string {
  return `/api/social/friends/${encodeURIComponent(friendId)}`;
}

export function conversationsPath(options: { includeMembers?: boolean } = {}): string {
  return withQuery("/api/conversations", { include: options.includeMembers ? "members" : undefined });
}

export function botDetailPath(botId: string): string {
  return `/api/me/bots/${encodeURIComponent(botId)}`;
}

export function botRuntimePath(botId: string, kind = "cloud-hermes"): string {
  return withQuery(`/api/me/bots/${encodeURIComponent(botId)}/runtime`, { kind });
}

export function botRuntimeSavePath(botId: string): string {
  return `/api/me/bots/${encodeURIComponent(botId)}/runtime`;
}

export function botConversationPath(sessionId: string): string {
  return `/api/me/bot-conversations/${encodeURIComponent(sessionId)}`;
}

export function modelCatalogPath(): string {
  return "/api/me/model-catalog";
}

export function skillsPath(filters: { q?: string; category?: string; limit?: number } = {}): string {
  return withQuery("/api/skills", filters);
}

export function skillDetailPath(skillId: string): string {
  return `/api/skills/${encodeURIComponent(skillId)}`;
}
