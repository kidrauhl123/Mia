export type SenderKind = "user" | "fellow" | "system";

export interface MessageRow {
  id?: string;
  seq?: number;
  conversation_id?: string;
  sender_kind?: SenderKind;
  sender_ref?: string;
  body_md?: string;
  client_trace_id?: string;
  trace_json?: string;
  created_at?: string;
  attachments?: unknown[];
  mentions?: unknown[];
}

export interface Conversation {
  id: string;
  name?: string;
  title?: string;
  type?: string;
  avatar?: string; // 群可能有存储的头像图
  fellow_id?: string;
  fellowKey?: string;
  decorations?: { fellowKey?: string; fellowName?: string; runtimeKind?: string };
  last_message_text?: string;
  last_activity_at?: string;
  updated_at?: string;
  created_at?: string;
  identity?: { avatar?: AvatarDescriptor };
}

export interface Member {
  member_kind?: string;
  member_ref?: string;
  owner_id?: string;
  owner_user_id?: string;
  fellow_name?: string;
  fellow_avatar_image?: string;
  fellow_avatar_crop?: Record<string, unknown> | null;
  identity?: {
    globalId?: string;
    global_id?: string;
    ownerUserId?: string;
    owner_id?: string;
    displayName?: string;
    avatar?: AvatarDescriptor;
  };
}

export interface Fellow {
  id?: string;
  key?: string;
  globalId?: string;
  global_id?: string;
  fellowGlobalId?: string;
  fellow_global_id?: string;
  ownerUserId?: string;
  owner_user_id?: string;
  ownerId?: string;
  owner_id?: string;
  name?: string;
  avatarImage?: string;
  avatarCrop?: Record<string, unknown> | null;
}

export interface Friend {
  id?: string;
  username?: string;
  account?: string;
  avatarImage?: string;
  avatarCrop?: Record<string, unknown> | null;
}

export interface AvatarDescriptor {
  image: string;
  crop: Record<string, unknown> | null;
  color: string;
  text: string;
}

export interface WsEnvelope {
  type?: string;
  seq?: number;
  [k: string]: any;
}

// 渲染用的归一化消息行(气泡 + trace)
export interface ChatMessage {
  messageId: string;
  clientTraceId: string;
  role: "user" | "assistant" | "system";
  bodyMd: string;
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
