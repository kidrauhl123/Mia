import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Keyboard,
  LayoutAnimation,
  Text,
  View,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Svg, { Circle, Path } from "react-native-svg";
import { useBots, useConversations, useFriends, useMe, useSaveUserSettings, useUserSettings } from "../state/queries";
import { useAuth } from "../state/auth";
import { buildConversationListItems, type ConversationListItem } from "../logic/conversationList";
import {
  markConversationReadPatch,
  markConversationUnreadPatch,
  toggleMutedConversation,
  togglePinnedConversation,
} from "../logic/settings";
import {
  clearUnreadCount,
  reconcileUnreadCountsWithReadMarks,
  unreadCountsQueryKey,
  type UnreadCounts,
} from "../logic/unreadState";
import ConversationAvatar from "../components/ConversationAvatar";
import StatusBadge from "../components/StatusBadge";
import { Body, BodyStrong, Label, Sub, Title } from "../ui/Text";
import { color, hairlineWidth, radius, space } from "../theme";
import { withAndroidTextFace } from "../ui/androidTextFace";
import { useTypography } from "../ui/TypographyProvider";
import { conversationHomeChrome } from "../logic/conversationHomeChrome";
import { conversationSearchOverlayChrome, conversationSearchPresentation } from "../logic/conversationSearchMode";
import type { Member } from "../api/types";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "Conversations">;

const desktopSearchBox = conversationSearchOverlayChrome.searchBox;
const TAG_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#7c3aed", "#0891b2", "#ea580c", "#c026d3", "#64748b"];

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

function PinGlyph({ tint = color.inkFaint }: { tint?: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 48 48">
      <Path
        d="M10.6963 17.5042C13.3347 14.8657 16.4701 14.9387 19.8781 16.8076L32.62 9.74509L31.8989 4.78683L43.2126 16.1005L38.2656 15.3907L31.1918 28.1214C32.9752 31.7589 33.1337 34.6647 30.4953 37.3032C30.4953 37.3032 26.235 33.0429 22.7171 29.525L6.44305 41.5564L18.4382 25.2461C14.9202 21.7281 10.6963 17.5042 10.6963 17.5042Z"
        fill={tint}
        fillOpacity={0.12}
        stroke={tint}
        strokeWidth={4}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function MutedGlyph({ tint = color.inkFaint }: { tint?: string }) {
  return (
    <Svg width={13} height={13} viewBox="0 0 24 24">
      <Path d="M16 9a5 5 0 0 1 .95 2.32M19.36 6.64A9 9 0 0 1 21 12" stroke={tint} strokeWidth={2} strokeLinecap="round" fill="none" />
      <Path d="M2 2l20 20M8.6 5.6 6 8H3v8h3l5 4v-8.6" stroke={tint} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d="M14 4.8V7l-2.2-2.2L14 4.8Z" fill={tint} />
    </Svg>
  );
}

function alphaColor(hex: string, alpha: number): string {
  const fallback = TAG_COLORS[7];
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function TagChip({ tag, index }: { tag: ConversationListItem["tags"][number]; index: number }) {
  const typography = useTypography();
  const tagColor = /^#[0-9a-f]{6}$/i.test(tag.color) ? tag.color : TAG_COLORS[index % TAG_COLORS.length];
  return (
    <View style={[styles.tagChip, { height: typography.type.listTag.lineHeight, backgroundColor: alphaColor(tagColor, 0.14) }]}>
      <Text allowFontScaling={false} numberOfLines={1} style={withAndroidTextFace([styles.tagText, typography.type.listTag, { color: tagColor }], tag.name)}>{tag.name}</Text>
    </View>
  );
}

export default function ConversationListScreen({ navigation }: Props) {
  const typography = useTypography();
  const { session, apiBase } = useAuth();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [searchOverlayMounted, setSearchOverlayMounted] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [actionItem, setActionItem] = useState<ConversationListItem | null>(null);
  const searchInputRef = useRef<TextInput>(null);
  const searchFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchProgress = useRef(new Animated.Value(0)).current;
  const { data: conversations = [], isLoading, refetch } = useConversations();
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const { data: me } = useMe();
  const { data: settings } = useUserSettings();
  const { data: rawUnreadCounts = {} } = useQuery<UnreadCounts>({
    queryKey: unreadCountsQueryKey,
    queryFn: () => ({}),
    staleTime: Infinity,
    gcTime: Infinity,
  });
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
    () => reconcileUnreadCountsWithReadMarks(rawUnreadCounts, settings?.readMarks || {}, conversations),
    [conversations, rawUnreadCounts, settings?.readMarks]
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
      tags: settings?.tags,
      query: "",
    }),
    [conversations, bots, friends, self, membersByConv, unreadByConversation, pinnedIds, mutedIds, settings?.unreadOverrides, settings?.tags]
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
      tags: settings?.tags,
      query,
    }),
    [conversations, bots, friends, self, membersByConv, unreadByConversation, pinnedIds, mutedIds, settings?.unreadOverrides, settings?.tags, query]
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

  function markActionItemRead(item: ConversationListItem) {
    qc.setQueryData<UnreadCounts>(unreadCountsQueryKey, (old) => clearUnreadCount(old, item.id));
    saveAndClose(markConversationReadPatch(settings, item.raw));
  }

  const refreshConversations = useCallback(() => {
    setManualRefreshing(true);
    refetch().finally(() => setManualRefreshing(false));
  }, [refetch]);

  const renderConversationItem = ({ item }: { item: ConversationListItem }) => {
    const hasTags = item.tags.length > 0;
    const hasSide = item.pinned || item.unread > 0;
    const listTitleLineHeight = typography.type.listTitle.lineHeight;
    const listSubtitleLineHeight = typography.type.listSubtitle.lineHeight;
    const listTagLineHeight = typography.type.listTag.lineHeight;
    const personaMainHeight = hasTags
      ? listTitleLineHeight + listSubtitleLineHeight + listTagLineHeight + 2
      : listTitleLineHeight + listSubtitleLineHeight + 4;
    return (
      <Pressable
        style={({ pressed }) => [styles.row, hasTags && styles.rowWithTags, item.pinned && styles.rowPinned, pressed && styles.pressed]}
        onLongPress={() => setActionItem(item)}
        onPress={() => navigation.navigate("Chat", { conversationId: item.id, title: item.title })}
      >
        <ConversationAvatar tiles={item.tiles} size={52} />
        <View style={[styles.personaMain, hasTags && styles.personaMainWithTags, { height: personaMainHeight }]}>
          <View style={[styles.personaNameRow, { height: listTitleLineHeight }]}>
            <View style={styles.titleWithBadge}>
              <BodyStrong allowFontScaling={false} numberOfLines={1} style={[styles.title, typography.type.listTitle]}>{item.title}</BodyStrong>
              <StatusBadge badge={item.statusBadge} apiBase={apiBase} size={20} />
            </View>
            {item.muted ? <View style={styles.mutedIcon}><MutedGlyph /></View> : null}
            {item.timeText ? (
              <Sub
                allowFontScaling={false}
                numberOfLines={1}
                style={[styles.time, typography.type.listTime, item.unread > 0 && !item.muted && styles.timeUnread]}
              >
                {item.timeText}
              </Sub>
            ) : null}
          </View>
          <View style={[styles.personaPreviewRow, { height: listSubtitleLineHeight }]}>
            <Sub
              allowFontScaling={false}
              numberOfLines={1}
              style={[styles.sub, typography.type.listSubtitle, { maxHeight: listSubtitleLineHeight }, item.unread > 0 && !item.muted && styles.subUnread]}
            >
              {item.subtitle}
            </Sub>
            {hasSide ? (
              <View style={styles.personaSide}>
                {item.pinned ? <View style={styles.pinIcon}><PinGlyph /></View> : null}
                {item.unread ? (
                  <View style={[styles.badge, item.muted && styles.badgeMuted]}>
                    <Text allowFontScaling={false} style={withAndroidTextFace([styles.badgeText, typography.type.badge], item.unread)}>{item.unread}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
          {hasTags ? (
            <View style={[styles.tagRow, { height: listTagLineHeight }]}>
              {item.tags.map((tag, index) => <TagChip key={tag.id} tag={tag} index={index} />)}
            </View>
          ) : null}
        </View>
      </Pressable>
    );
  };

  const searchOverlayAnimatedStyle = {
    opacity: searchProgress,
    transform: [
      { translateY: searchProgress.interpolate({ inputRange: [0, 1], outputRange: [-18, 0] }) },
      { scale: searchProgress.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) },
    ],
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerRow}>
          <Title allowFontScaling={false} style={[styles.screenTitle, typography.type.title]}>消息</Title>
        </View>
        <Pressable style={styles.searchBox} onPress={openSearch} accessibilityRole="button" accessibilityLabel="搜索">
          <View style={styles.searchPlaceholderGroup}>
            <View style={styles.searchBoxIcon}>
              <SearchGlyph />
            </View>
            <Label allowFontScaling={false} numberOfLines={1} style={[styles.searchPlaceholder, typography.type.search]}>
              {conversationHomeChrome.search.placeholder}
            </Label>
          </View>
        </Pressable>
      </View>
      <FlatList
        data={allItems}
        keyExtractor={(it) => it.id}
        onRefresh={refreshConversations}
        refreshing={manualRefreshing}
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
          <View style={[styles.searchOverlayHeader, { paddingTop: insets.top + 10 }]}>
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
                  style={[styles.searchInput, typography.type.search]}
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
                    <BodyStrong numberOfLines={1} style={typography.type.listTitle}>{actionItem.title}</BodyStrong>
                    <Sub numberOfLines={1} style={typography.type.listSubtitle}>{actionItem.subtitle}</Sub>
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
                  onPress={() => actionItem.unread
                    ? markActionItemRead(actionItem)
                    : saveAndClose(markConversationUnreadPatch(settings, actionItem.id))}
                />
                <Pressable style={styles.cancelAction} onPress={() => setActionItem(null)}>
                  <Body style={styles.cancelText}>取消</Body>
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
  const typography = useTypography();
  return (
    <Pressable style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]} onPress={onPress}>
      <Body style={typography.type.settingTitle}>{title}</Body>
      <Label style={typography.type.settingDetail}>{detail}</Label>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: conversationHomeChrome.page.backgroundColor },
  header: {
    minHeight: 84,
    paddingHorizontal: 10,
    paddingBottom: 8,
    borderBottomWidth: conversationHomeChrome.header.separatorWidth,
    borderBottomColor: color.line,
    gap: 8,
    backgroundColor: conversationHomeChrome.page.backgroundColor,
  },
  headerRow: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 4,
  },
  screenTitle: {},
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
    backgroundColor: "#FFFFFF",
    borderWidth: hairlineWidth,
    borderColor: "rgba(15,23,42,0.08)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    shadowColor: "#0F172A",
    shadowOpacity: 0.04,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  searchPlaceholderGroup: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    minWidth: 0,
  },
  searchBoxIcon: {
    width: 15,
    height: conversationHomeChrome.search.height,
    alignItems: "center",
    justifyContent: "center",
  },
  searchPlaceholder: { color: "#9AA0A6", textAlign: "center" },
  searchBoxActive: {
    flex: 1,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    borderWidth: hairlineWidth,
    borderColor: "rgba(15,23,42,0.08)",
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    paddingRight: 6,
    shadowColor: "#0F172A",
    shadowOpacity: 0.04,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
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
    minHeight: 84,
    paddingHorizontal: 10,
    paddingBottom: 8,
    backgroundColor: conversationHomeChrome.page.backgroundColor,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: 32,
    color: color.ink,
    paddingVertical: 0,
    paddingLeft: 13,
    textAlign: "left",
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
  listContent: { paddingVertical: 6 },
  emptyContent: { flexGrow: 1, backgroundColor: conversationHomeChrome.page.backgroundColor },
  searchListContent: { paddingTop: 6, paddingBottom: 132, backgroundColor: conversationHomeChrome.page.backgroundColor },
  searchEmptyContent: { flexGrow: 1, backgroundColor: conversationHomeChrome.page.backgroundColor, paddingTop: 44 },
  empty: { textAlign: "center", marginTop: 48 },
  searchEmpty: { marginTop: 24, color: color.inkFaint },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    minHeight: conversationHomeChrome.row.minHeight,
    marginHorizontal: 0,
    paddingLeft: 14,
    paddingRight: 14,
    paddingVertical: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    shadowOpacity: conversationHomeChrome.row.shadowOpacity,
  },
  rowWithTags: {
    minHeight: conversationHomeChrome.row.minHeightWithTags,
  },
  rowPinned: { backgroundColor: color.field },
  pressed: { backgroundColor: color.surfaceMuted },
  textCol: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  personaMain: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
    gap: 4,
  },
  personaMainWithTags: {
    gap: 1,
  },
  personaNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  titleWithBadge: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 0 },
  title: { flex: 1, minWidth: 0, color: color.ink },
  mutedIcon: { width: 13, height: 13, alignItems: "center", justifyContent: "center" },
  time: { flexShrink: 0, maxWidth: 64, color: color.inkFaint },
  timeUnread: { color: color.accent, fontWeight: "500" },
  subtitleRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 20 },
  personaPreviewRow: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sub: {
    flex: 1,
    minWidth: 0,
    color: color.inkMuted,
  },
  subUnread: { color: color.ink },
  markers: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 118 },
  marker: { color: color.inkFaint },
  personaSide: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
    minWidth: 18,
    maxWidth: 54,
    minHeight: 18,
    marginBottom: 0,
  },
  pinIcon: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
  badge: { backgroundColor: color.accent, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  badgeMuted: { backgroundColor: "#B3B8C2" },
  badgeText: { color: "#FFFFFF", fontVariant: ["tabular-nums"] },
  tagRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    overflow: "hidden",
  },
  tagChip: {
    maxWidth: 78,
    paddingHorizontal: 5,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  tagText: {
    maxWidth: 68,
  },
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
