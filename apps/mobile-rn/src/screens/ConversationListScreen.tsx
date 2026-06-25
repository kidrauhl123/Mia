import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Keyboard,
  LayoutAnimation,
  View,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Svg, { Circle, Path } from "react-native-svg";
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
import { BodyStrong, Label, Sub, Title } from "../ui/Text";
import { color, hairlineWidth, radius, space } from "../theme";
import { conversationHomeChrome } from "../logic/conversationHomeChrome";
import { conversationSearchOverlayChrome, conversationSearchPresentation } from "../logic/conversationSearchMode";
import type { Member } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Conversations">;

const desktopSearchBox = conversationSearchOverlayChrome.searchBox;

function SearchGlyph({ size = desktopSearchBox.searchIconSize, tint = color.inkFaint }: { size?: number; tint?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={10.8} cy={10.8} r={6.6} fill="none" stroke={tint} strokeWidth={2} />
      <Path d="M16 16L21 21" fill="none" stroke={tint} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function CloseGlyph({
  size,
  tint = color.inkFaint,
  strokeWidth,
}: {
  size: number;
  tint?: string;
  strokeWidth: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d={strokeWidth === 1.9 ? "M6 6L18 18M18 6L6 18" : "M7 7L17 17M17 7L7 17"}
        fill="none"
        stroke={tint}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export default function ConversationListScreen({ navigation }: Props) {
  const { session, apiBase } = useAuth();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [searchOverlayMounted, setSearchOverlayMounted] = useState(false);
  const [actionItem, setActionItem] = useState<ConversationListItem | null>(null);
  const searchInputRef = useRef<TextInput>(null);
  const searchFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchProgress = useRef(new Animated.Value(0)).current;
  const { data: conversations = [], isLoading, refetch, isRefetching } = useConversations();
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const { data: me } = useMe();
  const { data: settings } = useUserSettings();
  const saveSettings = useSaveUserSettings();
  const selfId = me?.id || session?.user?.id || "";

  const membersByConv = useMemo(() => {
    const out: Record<string, Member[]> = {};
    conversations.forEach((c) => {
      if (Array.isArray(c.members)) out[c.id] = c.members;
    });
    return out;
  }, [conversations]);
  const unreadByConversation = useMemo(
    () => unreadCountsFromConversations(conversations, settings?.readMarks || {}, settings?.unreadOverrides || {}, selfId),
    [conversations, settings?.readMarks, settings?.unreadOverrides, selfId]
  );

  // 自己:优先完整资料(带头像 + 裁剪),回退到会话里的精简 user。
  const self = me
    ? { id: me.id, username: me.username, avatarImage: me.avatarImage, avatarCrop: me.avatarCrop }
    : session?.user
      ? { id: session.user.id, username: session.user.username, avatarImage: session.user.avatarImage }
      : undefined;

  const pinnedIds = settings?.pins || [];
  const mutedIds = settings?.mutedConversations || [];
  const allItems = useMemo(
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
      query: "",
    }),
    [conversations, bots, friends, self, membersByConv, unreadByConversation, pinnedIds, mutedIds, settings?.unreadOverrides]
  );
  const searchItems = useMemo(
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
  const searchOpen = searchActive || Boolean(query.trim());
  const presentation = conversationSearchPresentation({
    active: true,
    query,
    items: searchItems,
    isLoading,
  });
  const normalEmptyText = isLoading ? "加载中…" : "还没有会话";

  const configureSearchLayout = useCallback(() => {
    LayoutAnimation.configureNext({
      duration: conversationSearchOverlayChrome.animation.durationMs,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
  }, []);

  const focusSearchInput = useCallback(() => {
    if (searchFocusTimer.current) clearTimeout(searchFocusTimer.current);
    searchFocusTimer.current = setTimeout(() => {
      searchInputRef.current?.focus();
    }, conversationSearchOverlayChrome.focusDelayMs);
  }, []);

  const openSearch = useCallback(() => {
    configureSearchLayout();
    setSearchOverlayMounted(true);
    setSearchActive(true);
    focusSearchInput();
  }, [configureSearchLayout, focusSearchInput]);

  const cancelSearch = useCallback(() => {
    configureSearchLayout();
    setQuery("");
    setSearchActive(false);
    Keyboard.dismiss();
  }, [configureSearchLayout]);

  useEffect(() => {
    if (!searchOverlayMounted) return;
    Animated.timing(searchProgress, {
      toValue: searchOpen ? 1 : 0,
      duration: conversationSearchOverlayChrome.animation.durationMs,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !searchOpen) setSearchOverlayMounted(false);
    });
    if (searchOpen && conversationSearchOverlayChrome.focusOnOpen) focusSearchInput();
  }, [focusSearchInput, searchOpen, searchOverlayMounted, searchProgress]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!conversationSearchOverlayChrome.backCloses || (!searchOpen && !searchOverlayMounted)) return false;
      cancelSearch();
      return true;
    });
    return () => subscription.remove();
  }, [cancelSearch, searchOpen, searchOverlayMounted]);

  useEffect(() => {
    if (!conversationSearchOverlayChrome.keyboardHideCloses) return undefined;
    const subscription = Keyboard.addListener("keyboardDidHide", () => {
      if (searchOpen && searchOverlayMounted) cancelSearch();
    });
    return () => subscription.remove();
  }, [cancelSearch, searchOpen, searchOverlayMounted]);

  useEffect(() => () => {
    if (searchFocusTimer.current) clearTimeout(searchFocusTimer.current);
  }, []);

  function saveAndClose(patch: Parameters<typeof saveSettings.mutate>[0]) {
    saveSettings.mutate(patch);
    setActionItem(null);
  }

  const renderConversationItem = ({ item }: { item: ConversationListItem }) => (
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
  );

  const searchOverlayAnimatedStyle = {
    opacity: searchProgress,
    transform: [
      { translateY: searchProgress.interpolate({ inputRange: [0, 1], outputRange: [-18, 0] }) },
      { scale: searchProgress.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) },
    ],
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top + 4, space.sm) }]}>
        <View style={styles.headerRow}>
          <Title style={styles.screenTitle}>消息</Title>
        </View>
        <Pressable style={styles.searchBox} onPress={openSearch} accessibilityRole="button" accessibilityLabel="搜索">
          <View style={styles.searchBoxIcon}>
            <SearchGlyph />
          </View>
          <Label numberOfLines={1} style={styles.searchPlaceholder}>{conversationHomeChrome.search.placeholder}</Label>
        </Pressable>
      </View>
      <ConnBanner />
      <FlatList
        data={allItems}
        keyExtractor={(it) => it.id}
        onRefresh={refetch}
        refreshing={isRefetching}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={allItems.length ? styles.listContent : styles.emptyContent}
        ListEmptyComponent={<Sub style={styles.empty}>{normalEmptyText}</Sub>}
        renderItem={renderConversationItem}
      />
      {searchOverlayMounted ? (
        <Animated.View
          pointerEvents={searchOpen ? "auto" : "none"}
          style={[styles.searchOverlay, searchOverlayAnimatedStyle]}
        >
          <View style={[styles.searchOverlayHeader, { paddingTop: Math.max(insets.top + 4, space.sm) }]}>
            <View style={styles.searchRowActive}>
              <View style={styles.searchBoxActive}>
                <View style={styles.searchBoxIcon}>
                  <SearchGlyph />
                </View>
                <TextInput
                  ref={searchInputRef}
                  value={query}
                  onChangeText={setQuery}
                  onFocus={() => setSearchActive(true)}
                  placeholder={conversationHomeChrome.search.placeholder}
                  placeholderTextColor={color.inkFaint}
                  returnKeyType="search"
                  showSoftInputOnFocus
                  style={styles.searchInput}
                />
                {query ? (
                  <Pressable
                    style={styles.clearButton}
                    onPress={() => setQuery("")}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="清除搜索"
                  >
                    <CloseGlyph size={desktopSearchBox.clearIconSize} strokeWidth={2.4} />
                  </Pressable>
                ) : (
                  <View style={styles.clearButtonPlaceholder} />
                )}
              </View>
              <Pressable
                style={styles.searchCloseButton}
                onPress={cancelSearch}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="关闭搜索"
              >
                <CloseGlyph size={desktopSearchBox.closeIconSize} tint={color.inkMuted} strokeWidth={1.9} />
              </Pressable>
            </View>
          </View>
          <FlatList
            data={presentation.items}
            keyExtractor={(it) => it.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={presentation.items.length ? styles.searchListContent : styles.searchEmptyContent}
            ListEmptyComponent={presentation.emptyText ? <Sub style={[styles.empty, styles.searchEmpty]}>{presentation.emptyText}</Sub> : null}
            renderItem={renderConversationItem}
          />
        </Animated.View>
      ) : null}
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
  root: { flex: 1, backgroundColor: conversationHomeChrome.page.backgroundColor },
  header: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    borderBottomWidth: conversationHomeChrome.header.separatorWidth,
    borderBottomColor: color.line,
    gap: space.xs,
    backgroundColor: conversationHomeChrome.page.backgroundColor,
  },
  headerRow: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  screenTitle: {
    fontSize: conversationHomeChrome.title.fontSize,
    lineHeight: conversationHomeChrome.title.lineHeight,
    fontWeight: "600",
  },
  searchRowActive: {
    minHeight: desktopSearchBox.height,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  searchBox: {
    width: "100%",
    height: conversationHomeChrome.search.height,
    borderRadius: conversationHomeChrome.search.radius,
    backgroundColor: color.field,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 8,
    paddingRight: 6,
  },
  searchBoxIcon: {
    width: desktopSearchBox.iconColumnWidth,
    height: conversationHomeChrome.search.height,
    alignItems: "center",
    justifyContent: "center",
  },
  searchPlaceholder: { flex: 1, minWidth: 0, color: color.inkFaint, fontSize: 14, fontWeight: "400" },
  searchBoxActive: {
    flex: 1,
    height: desktopSearchBox.height,
    borderRadius: desktopSearchBox.radius,
    backgroundColor: "rgba(0,0,0,0.047)",
    borderWidth: hairlineWidth,
    borderColor: "rgba(94,92,230,0.20)",
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 8,
    paddingRight: 6,
  },
  searchOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 15,
    backgroundColor: conversationHomeChrome.page.backgroundColor,
  },
  searchOverlayHeader: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    backgroundColor: conversationHomeChrome.page.backgroundColor,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: desktopSearchBox.height,
    color: color.ink,
    fontSize: 14,
    paddingVertical: 0,
  },
  clearButton: {
    width: desktopSearchBox.clearButtonSize,
    height: desktopSearchBox.clearButtonSize,
    alignItems: "center",
    justifyContent: "center",
  },
  clearButtonPlaceholder: {
    width: desktopSearchBox.clearButtonSize,
    height: desktopSearchBox.clearButtonSize,
  },
  searchCloseButton: {
    width: desktopSearchBox.height,
    height: desktopSearchBox.height,
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: { paddingBottom: space.sm },
  emptyContent: { flexGrow: 1, backgroundColor: conversationHomeChrome.page.backgroundColor },
  searchListContent: { paddingBottom: 132, backgroundColor: conversationHomeChrome.page.backgroundColor },
  searchEmptyContent: { flexGrow: 1, backgroundColor: conversationHomeChrome.page.backgroundColor, paddingTop: 44 },
  empty: { textAlign: "center", marginTop: 48 },
  searchEmpty: { marginTop: 24, color: color.inkFaint },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: conversationHomeChrome.row.minHeight,
    paddingVertical: 10,
    backgroundColor: color.bg,
    shadowOpacity: conversationHomeChrome.row.shadowOpacity,
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
