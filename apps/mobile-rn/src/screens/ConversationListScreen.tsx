import { useMemo, useState } from "react";
import { View, FlatList, Modal, Pressable, StyleSheet, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useBots, useConversations, useFriends, useMe, useSaveUserSettings, useUserSettings } from "../state/queries";
import { useAuth } from "../state/auth";
import { buildConversationListItems, unreadCountsFromConversations, type ConversationListItem } from "../logic/conversationList";
import {
  markConversationReadPatch,
  markConversationUnreadPatch,
  toggleMutedConversation,
  togglePinnedConversation,
} from "../logic/settings";
import ConversationAvatar from "../components/ConversationAvatar";
import ConnBanner from "../components/ConnBanner";
import StatusBadge from "../components/StatusBadge";
import { Body, BodyStrong, Label, Sub } from "../ui/Text";
import { color, hairlineWidth, radius, space } from "../theme";
import type { Member } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Conversations">;

export default function ConversationListScreen({ navigation }: Props) {
  const { session, apiBase } = useAuth();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [actionItem, setActionItem] = useState<ConversationListItem | null>(null);
  const { data: conversations = [], isLoading, refetch, isRefetching } = useConversations();
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const { data: me } = useMe();
  const { data: settings } = useUserSettings();
  const saveSettings = useSaveUserSettings();

  const membersByConv = useMemo(() => {
    const out: Record<string, Member[]> = {};
    conversations.forEach((c) => {
      if (Array.isArray(c.members)) out[c.id] = c.members;
    });
    return out;
  }, [conversations]);
  const unreadByConversation = useMemo(
    () => unreadCountsFromConversations(conversations, settings?.readMarks || {}, settings?.unreadOverrides || {}),
    [conversations, settings?.readMarks, settings?.unreadOverrides]
  );

  // 自己:优先完整资料(带头像 + 裁剪),回退到会话里的精简 user。
  const self = me
    ? { id: me.id, username: me.username, avatarImage: me.avatarImage, avatarCrop: me.avatarCrop }
    : session?.user
      ? { id: session.user.id, username: session.user.username, avatarImage: session.user.avatarImage }
      : undefined;

  const pinnedIds = settings?.pins || [];
  const mutedIds = settings?.mutedConversations || [];
  const items = useMemo(
    () => buildConversationListItems({
      conversations,
      bots,
      friends,
      self,
      membersByConv,
      unreadByConversation,
      pinnedIds,
      mutedIds,
      unreadOverrides: settings?.unreadOverrides || {},
      query,
    }),
    [conversations, bots, friends, self, membersByConv, unreadByConversation, pinnedIds, mutedIds, settings?.unreadOverrides, query]
  );
  const visibleUnread = useMemo(
    () => items.reduce((sum, item) => item.muted ? sum : sum + item.unread, 0),
    [items]
  );
  const emptyText = query.trim()
    ? "没有匹配的会话"
    : isLoading
      ? "加载中…"
      : "还没有会话";

  function saveAndClose(patch: Parameters<typeof saveSettings.mutate>[0]) {
    saveSettings.mutate(patch);
    setActionItem(null);
  }

  return (
    <View style={styles.root}>
      <ConnBanner />
      <View style={styles.header}>
        <View style={styles.searchBox}>
          <Label style={styles.searchIcon}>搜索</Label>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索会话"
            placeholderTextColor={color.inkFaint}
            returnKeyType="search"
            style={styles.searchInput}
          />
          {query ? (
            <Pressable style={styles.clearButton} onPress={() => setQuery("")}>
              <Label style={styles.clearText}>清除</Label>
            </Pressable>
          ) : null}
        </View>
        {visibleUnread ? <Sub style={styles.unreadSummary}>{visibleUnread} 条未读</Sub> : null}
      </View>
      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        onRefresh={refetch}
        refreshing={isRefetching}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={items.length ? styles.listContent : styles.emptyContent}
        ListEmptyComponent={<Sub style={styles.empty}>{emptyText}</Sub>}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onLongPress={() => setActionItem(item)}
            onPress={() => navigation.navigate("Chat", { conversationId: item.id, title: item.title })}
          >
            <ConversationAvatar tiles={item.tiles} size={48} />
            <View style={styles.textCol}>
              <View style={styles.titleRow}>
                <View style={styles.titleWithBadge}>
                  <BodyStrong numberOfLines={1} style={styles.title}>{item.title}</BodyStrong>
                  <StatusBadge badge={item.statusBadge} apiBase={apiBase} size={20} />
                </View>
                {item.timeText ? <Sub numberOfLines={1} style={[styles.time, item.unread > 0 && !item.muted && styles.timeUnread]}>{item.timeText}</Sub> : null}
              </View>
              <View style={styles.subtitleRow}>
                <Sub numberOfLines={1} style={[styles.sub, item.unread > 0 && !item.muted && styles.subUnread]}>{item.subtitle}</Sub>
                <View style={styles.markers}>
                  {item.pinned ? <Label style={styles.marker}>置顶</Label> : null}
                  {item.muted ? <Label style={styles.marker}>免打扰</Label> : null}
                </View>
              </View>
            </View>
            {item.unread ? (
              <View style={[styles.badge, item.muted && styles.badgeMuted]}>
                <Sub style={styles.badgeText}>{item.unread}</Sub>
              </View>
            ) : null}
          </Pressable>
        )}
      />
      <Modal
        visible={Boolean(actionItem)}
        transparent
        animationType="fade"
        onRequestClose={() => setActionItem(null)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setActionItem(null)}>
          <Pressable style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.md) }]} onPress={(event) => event.stopPropagation()}>
            {actionItem ? (
              <>
                <View style={styles.sheetHead}>
                  <ConversationAvatar tiles={actionItem.tiles} size={40} />
                  <View style={styles.sheetTitleCol}>
                    <BodyStrong numberOfLines={1}>{actionItem.title}</BodyStrong>
                    <Sub numberOfLines={1}>{actionItem.subtitle}</Sub>
                  </View>
                </View>
                <ActionRow
                  title={actionItem.pinned ? "取消置顶" : "置顶"}
                  detail={actionItem.pinned ? "回到按时间排序的位置" : "固定在列表顶部"}
                  onPress={() => saveAndClose({ pins: togglePinnedConversation(settings, actionItem.id) })}
                />
                <ActionRow
                  title={actionItem.muted ? "关闭免打扰" : "免打扰"}
                  detail={actionItem.muted ? "重新计入底部未读总数" : "保留会话未读，但不计入总未读"}
                  onPress={() => saveAndClose({ mutedConversations: toggleMutedConversation(settings, actionItem.id) })}
                />
                <ActionRow
                  title={actionItem.unread ? "标为已读" : "标为未读"}
                  detail={actionItem.unread ? "同步当前会话已读位置" : "在主列表保留一个未读提示"}
                  onPress={() => saveAndClose(actionItem.unread
                    ? markConversationReadPatch(settings, actionItem.raw)
                    : markConversationUnreadPatch(settings, actionItem.id))}
                />
                <Pressable style={styles.cancelAction} onPress={() => setActionItem(null)}>
                  <BodyStrong style={styles.cancelText}>取消</BodyStrong>
                </Pressable>
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function ActionRow({ title, detail, onPress }: { title: string; detail: string; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]} onPress={onPress}>
      <BodyStrong>{title}</BodyStrong>
      <Sub>{detail}</Sub>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
    gap: 6,
  },
  searchBox: {
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceMuted,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.sm,
    gap: space.sm,
  },
  searchIcon: { color: color.inkFaint },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: 38,
    color: color.ink,
    fontSize: 15,
    paddingVertical: 0,
  },
  clearButton: { paddingHorizontal: 4, paddingVertical: 4 },
  clearText: { color: color.accent },
  unreadSummary: { color: color.inkFaint, paddingLeft: 2 },
  listContent: { paddingBottom: space.sm },
  emptyContent: { flexGrow: 1 },
  empty: { textAlign: "center", marginTop: 48 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 74,
    paddingVertical: 10,
    backgroundColor: color.bg,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  pressed: { backgroundColor: color.surfaceMuted },
  textCol: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  titleWithBadge: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 0 },
  title: { flex: 1, minWidth: 0 },
  time: { color: color.inkFaint, fontSize: 12 },
  timeUnread: { color: color.accent, fontWeight: "700" },
  subtitleRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 20 },
  sub: { flex: 1, minWidth: 0, marginTop: 1 },
  subUnread: { color: color.ink },
  markers: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 118 },
  marker: { color: color.inkFaint, fontSize: 11 },
  badge: { backgroundColor: color.accent, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeMuted: { backgroundColor: color.lineStrong },
  badgeText: { color: color.accentText, fontSize: 12, fontWeight: "600" },
  sheetBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.22)",
  },
  sheet: {
    backgroundColor: color.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  sheetTitleCol: { flex: 1, minWidth: 0, gap: 2 },
  actionRow: {
    minHeight: 58,
    justifyContent: "center",
    gap: 2,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  cancelAction: {
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: color.surfaceMuted,
    marginTop: 2,
  },
  cancelText: { color: color.accent },
});
