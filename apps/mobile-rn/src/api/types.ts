export type SenderKind = "user" | "bot" | "system";

export interface MessageRow {
  id?: string;
  seq?: number;
  conversation_id?: string;
  sender_kind?: SenderKind;
  sender_ref?: string;
  body_md?: string;
  client_trace_id?: string;
  turn_id?: string;
  trace_json?: string;
  created_at?: string;
  attachments?: MessageAttachment[];
  mentions?: unknown[];
  statusBadge?: StatusBadge | null;
  status_badge?: StatusBadge | null;
}

export interface Conversation {
  id: string;
  publicId?: string;
  public_id?: string;
  name?: string;
  title?: string;
  type?: "dm" | "group" | "bot" | string;
  avatar?: string; // 群可能有存储的头像图
  bot_id?: string;
  botId?: string;
  decorations?: { botId?: string; botName?: string; runtimeKind?: string };
  last_message_text?: string;
  last_activity_at?: string;
  updated_at?: string;
  created_at?: string;
  identity?: { avatar?: AvatarDescriptor; statusBadge?: StatusBadge | null };
}

export interface Member {
  member_kind?: "user" | "bot" | string;
  member_ref?: string;
  owner_id?: string;
  owner_user_id?: string;
  bot_name?: string;
  bot_avatar_image?: string;
  bot_avatar_crop?: Record<string, unknown> | null;
  identity?: Identity;
}

export interface Bot {
  id?: string;
  key?: string;
  botId?: string;
  bot_id?: string;
  globalId?: string;
  global_id?: string;
  ownerUserId?: string;
  owner_user_id?: string;
  ownerId?: string;
  owner_id?: string;
  displayName?: string;
  display_name?: string;
  name?: string;
  bio?: string;
  description?: string;
  personaText?: string;
  persona_text?: string;
  color?: string;
  avatarImage?: string;
  avatar_image?: string;
  avatarCrop?: Record<string, unknown> | null;
  avatar_crop?: Record<string, unknown> | null;
  statusBadge?: StatusBadge | null;
  status_badge?: StatusBadge | null;
  runtimeKind?: string;
  runtime_kind?: string;
  capabilities?: Record<string, unknown>;
}

export interface Friend {
  id?: string;
  username?: string;
  account?: string;
  avatarImage?: string;
  avatarCrop?: Record<string, unknown> | null;
}

export interface UserSettings {
  version?: number;
  pins?: string[];
  readMarks?: Record<string, number>;
  appearance?: Record<string, unknown>;
}

export interface FriendRequest {
  id: string;
  from_user?: string;
  to_user?: string;
  senderId?: string;
  recipientId?: string;
  sender?: Friend;
  recipient?: Friend;
  other?: Friend;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BridgeDevice {
  id?: string;
  deviceId?: string;
  deviceName?: string;
  name?: string;
  platform?: string;
  engine?: string;
  capabilities?: Record<string, unknown>;
  status?: string;
  connectedAt?: string;
  lastSeenAt?: string;
  connected?: boolean;
}

export interface BridgeRun {
  id?: string;
  runId?: string;
  conversationId?: string;
  status?: string;
  text?: string;
  command?: string;
  resultText?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface BotRuntimeBinding {
  userId?: string;
  botId?: string;
  runtimeKind?: string;
  enabled?: boolean;
  config?: BotRuntimeConfig;
}

export interface RuntimeModelEntry {
  id: string;
  value: string;
  model: string;
  label: string;
  provider?: string;
  providerLabel?: string;
}

export interface PlatformModelRow {
  id?: string;
  value?: string;
  model?: string;
  modelName?: string;
  label?: string;
  name?: string;
  upstreamModel?: string;
  provider?: string;
  providerLabel?: string;
}

export interface BotRuntimeConfig {
  model?: string;
  effortLevel?: string;
  permissionMode?: string;
  modelEntries?: RuntimeModelEntry[];
}

export interface SkillSummary {
  id: string;
  name?: string;
  title?: string;
  category?: string;
  description?: string;
  ownerLabel?: string;
  installs?: number;
  version?: {
    version?: string;
    checksum?: string;
    entryPath?: string;
  } | null;
}

export interface SkillCategory {
  id?: string;
  name?: string;
  count?: number;
}

export interface MessageAttachment {
  id?: string;
  type?: string;
  name?: string;
  mimeType?: string;
  url?: string;
  path?: string;
  dataUrl?: string;
  size?: number;
  createdAt?: string;
}

export interface AvatarDescriptor {
  image: string;
  crop: Record<string, unknown> | null;
  color: string;
  text: string;
}

export type StatusBadge =
  | { kind: "emoji"; emoji: string; label?: string }
  | { kind: "lottie"; assetId: string; label?: string; loop?: "limited" | "always" | string }
  | { kind: "gift"; assetId: string; label?: string; collectibleId?: string };

export interface Identity {
  kind?: "user" | "bot" | string;
  id?: string;
  globalId?: string;
  global_id?: string;
  ownerUserId?: string;
  owner_id?: string;
  displayName?: string;
  avatar?: AvatarDescriptor;
  statusBadge?: StatusBadge | null;
}

export interface WsEnvelope {
  type?: string;
  seq?: number;
  [k: string]: any;
}

// 渲染用的归一化消息行(气泡 + trace)
export interface ChatMessage {
  messageId: string;
  seq?: number;
  clientTraceId: string;
  role: "user" | "assistant" | "system";
  senderKind?: SenderKind | string;
  senderRef?: string;
  authorName?: string;
  authorIdentity?: Identity | null;
  statusBadge?: StatusBadge | null;
  bodyMd: string;
  attachments?: MessageAttachment[];
  trace?: { reasoning?: any; tools?: any } | null;
  isOwn: boolean;
  isPending: boolean;
  failed?: boolean;
  createdAt: string;
}

export const PermissionDecision = {
  AllowOnce: "allow_once",
  AllowAlways: "allow_always",
  Deny: "deny",
} as const;
export type PermissionDecisionT = (typeof PermissionDecision)[keyof typeof PermissionDecision];

export function decisionToHermesChoice(d: PermissionDecisionT): "once" | "always" | "deny" {
  if (d === PermissionDecision.AllowAlways) return "always";
  if (d === PermissionDecision.AllowOnce) return "once";
  return "deny";
}
