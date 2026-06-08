import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { AvatarDescriptor, Bot, Friend } from "../api/types";
import { useCreateGroupConversation } from "../state/queries";
import Avatar from "./Avatar";
import {
  groupCreatePayload,
  groupMemberKey,
  MAX_GROUP_MEMBERS,
  toggleGroupMemberKey,
  type GroupMemberDraft,
} from "../logic/groupCreate";
import { resolveAvatar } from "../logic/conversationList";
import Button from "../ui/Button";
import Input from "../ui/Input";
import { BodyStrong, Label, Sub, Title } from "../ui/Text";
import { color, radius, space } from "../theme";

interface GroupMemberRow extends GroupMemberDraft {
  key: string;
  subtitle: string;
  avatar: AvatarDescriptor;
}

function botId(bot: Bot, index: number): string {
  return String(bot.id || bot.botId || bot.bot_id || bot.key || index);
}

function botName(bot: Bot, id: string): string {
  return bot.displayName || bot.display_name || bot.name || id;
}

function memberRows(friends: Friend[], bots: Bot[]): GroupMemberRow[] {
  return [
    ...friends.map((friend, index) => {
      const id = String(friend.id || friend.username || friend.account || index);
      const name = friend.username || friend.account || id;
      return {
        key: `friend:${id}`,
        kind: "friend" as const,
        id,
        name,
        subtitle: "好友",
        avatar: resolveAvatar(id, name, friend.avatarImage || "", friend.avatarCrop || null),
      };
    }),
    ...bots.map((bot, index) => {
      const id = botId(bot, index);
      const name = botName(bot, id);
      const runtimeKind = bot.runtimeKind || bot.runtime_kind || "cloud-hermes";
      return {
        key: `bot:${id}`,
        kind: "bot" as const,
        id,
        name,
        runtimeKind,
        subtitle: runtimeKind === "desktop-local" ? "本机智能体" : "云端智能体",
        avatar: resolveAvatar(id, name, bot.avatarImage || bot.avatar_image || "", bot.avatarCrop || bot.avatar_crop || null),
      };
    }),
  ];
}

export default function CreateGroupPanel({ friends, bots }: { friends: Friend[]; bots: Bot[] }) {
  const [groupName, setGroupName] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const createGroup = useCreateGroupConversation();
  const members = useMemo(() => memberRows(friends, bots), [friends, bots]);
  const selectedMembers = members.filter((member) => selectedKeys.includes(groupMemberKey(member)));
  const atLimit = selectedKeys.length >= MAX_GROUP_MEMBERS;

  function toggle(member: GroupMemberRow) {
    setStatus("");
    setSelectedKeys((old) => toggleGroupMemberKey(old, member));
  }

  async function create() {
    if (!selectedMembers.length) {
      setStatus("至少选择 1 位联系人");
      return;
    }
    setStatus("");
    try {
      await createGroup.mutateAsync(groupCreatePayload(groupName, selectedMembers));
      setGroupName("");
      setSelectedKeys([]);
      setStatus("群聊已创建");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "创建失败");
    }
  }

  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Title>新建群聊</Title>
          <Sub>选择好友和智能体</Sub>
        </View>
        <Label>{selectedKeys.length}/{MAX_GROUP_MEMBERS}</Label>
      </View>
      <Input value={groupName} onChangeText={setGroupName} placeholder="群名" style={styles.nameInput} />
      <View style={styles.members}>
        {members.length ? (
          members.map((member) => {
            const selected = selectedKeys.includes(member.key);
            const disabled = atLimit && !selected;
            return (
              <Pressable
                key={member.key}
                disabled={disabled || createGroup.isPending}
                onPress={() => toggle(member)}
                style={({ pressed }) => [
                  styles.memberRow,
                  selected && styles.memberSelected,
                  disabled && styles.memberDisabled,
                  pressed && styles.memberPressed,
                ]}
              >
                <Avatar title={member.name} avatar={member.avatar} size={34} />
                <View style={styles.memberText}>
                  <BodyStrong numberOfLines={1}>{member.name}</BodyStrong>
                  <Sub numberOfLines={1}>{member.subtitle}</Sub>
                </View>
                <View style={[styles.check, selected && styles.checkSelected]}>
                  {selected ? <Label style={styles.checkText}>✓</Label> : null}
                </View>
              </Pressable>
            );
          })
        ) : (
          <Sub style={styles.empty}>还没有联系人</Sub>
        )}
      </View>
      <Button label="创建群聊" onPress={create} busy={createGroup.isPending} disabled={!selectedMembers.length} />
      {status ? <Sub style={styles.status}>{status}</Sub> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.md,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  nameInput: {},
  members: { gap: space.sm },
  memberRow: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    backgroundColor: color.surface,
  },
  memberSelected: { borderColor: color.accent, backgroundColor: color.accentSoft },
  memberDisabled: { opacity: 0.45 },
  memberPressed: { opacity: 0.86 },
  memberText: { flex: 1, minWidth: 0, gap: 1 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: color.lineStrong,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surface,
  },
  checkSelected: { borderColor: color.accent, backgroundColor: color.accent },
  checkText: { color: color.accentText, fontSize: 12, fontWeight: "800" },
  empty: { textAlign: "center", paddingVertical: space.sm },
  status: { color: color.inkMuted },
});
