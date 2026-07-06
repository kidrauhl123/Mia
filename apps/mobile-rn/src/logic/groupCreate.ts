export const MAX_GROUP_MEMBERS = 5;

export type GroupMemberKind = "friend" | "bot";

export interface GroupMemberDraft {
  kind: GroupMemberKind;
  id: string;
  name: string;
  runtimeKind?: string;
}

export interface GroupCreatePayload {
  name: string;
  memberFriendUserIds: string[];
  memberBots: Array<{ botId: string; runtimeKind: string }>;
}

export function groupMemberKey(member: Pick<GroupMemberDraft, "kind" | "id">): string {
  return `${member.kind}:${member.id}`;
}

export function toggleGroupMemberKey(
  selectedKeys: string[],
  member: Pick<GroupMemberDraft, "kind" | "id">,
  maxMembers = MAX_GROUP_MEMBERS
): string[] {
  const key = groupMemberKey(member);
  if (selectedKeys.includes(key)) return selectedKeys.filter((item) => item !== key);
  if (selectedKeys.length >= maxMembers) return selectedKeys;
  return [...selectedKeys, key];
}

export function groupNameFromMembers(input: string, members: GroupMemberDraft[]): string {
  const trimmed = input.trim();
  if (trimmed) return trimmed;
  const names = members.map((member) => member.name.trim()).filter(Boolean);
  return names.length ? names.join(" · ") : "未命名群聊";
}

export function groupCreatePayload(inputName: string, members: GroupMemberDraft[]): GroupCreatePayload {
  return {
    name: groupNameFromMembers(inputName, members),
    memberFriendUserIds: members.filter((member) => member.kind === "friend").map((member) => member.id),
    memberBots: members
      .filter((member) => member.kind === "bot")
      .map((member) => ({ botId: member.id, runtimeKind: member.runtimeKind || "cloud-claude-code" })),
  };
}
